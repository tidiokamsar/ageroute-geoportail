"""Pre-filtre DXF : ne laisse passer vers GDAL que les entites SUPPORTEES, et inventorie le reste.

POURQUOI. Le pilote DXF de GDAL expose tout dans une seule couche `entities` : le type d'entite
d'origine ne se lit pas dans sa sortie (`SubClasses` n'existe que si le fichier porte des marqueurs 100),
un ARC, un CERCLE et un bloc INSERE ressortent comme des LINESTRING, un TEXTE comme un POINT, un HATCH
comme un POLYGON. Pour tenir « entites supportees : LINE, LWPOLYLINE, POLYLINE, 3DPOLYLINE ; blocs,
hachures et textes ignores ET COMPTES », le tri se fait AVANT GDAL, sur le fichier source, par une
analyse en flux de ses paires (code de groupe, valeur).

Ce module (bibliotheque standard seule) :
  - lit un DXF ASCII sous bornes strictes (ligne de 64 Kio au plus, entite de 400 000 groupes au plus,
    1 000 calques au plus, controle du delai et de l'arret a intervalles reguliers) ;
  - ne conserve que LINE, LWPOLYLINE, POLYLINE (2D) et POLYLINE 3D (comptee `3DPOLYLINE`) avec leurs
    VERTEX et SEQEND, hors espace papier ;
  - compte tout le reste par nom d'entite (INSERT, TEXT, MTEXT, HATCH, CIRCLE, ARC, POINT, SPLINE...), les
    maillages POLYLINE sous `POLYLINE_MAILLAGE`, l'espace papier sous `ESPACE_PAPIER`, les definitions de
    blocs et leur contenu a part ;
  - reecrit un DXF MINIMAL (en-tete reduit a $ACADVER, $DWGCODEPAGE, $INSUNITS valides, puis ENTITIES avec
    des groupes en liste blanche). Les sections BLOCKS, TABLES, OBJECTS, CLASSES... ne sont PAS reecrites :
    la surface « bombe de blocs » disparait avant GDAL. Les octets sont recopies tels quels (aucun
    decodage) : GDAL fait lui-meme le changement d'encodage depuis $DWGCODEPAGE et $ACADVER ;
  - inventorie les calques (nom, entites lues, entites ignorees).

Le DXF binaire n'est pas lu (code DXF_BINAIRE_NON_PRIS_EN_CHARGE, leve par l'appelant).
"""
import codecs
import os
import re

from erreurs import ErreurGeoconv, nettoyer

ENTITES_SUPPORTEES = ("LINE", "LWPOLYLINE", "POLYLINE", "3DPOLYLINE")
LIGNE_MAX = 64 * 1024
GROUPES_ENTITE_MAX = 400_000
CALQUES_MAX = 1000
TYPES_IGNORES_MAX = 200
NOM_CALQUE_OCTETS_MAX = 512
CONTROLE_TOUS_LES = 50_000  # paires

_RE_CODE = re.compile(rb"^-?[0-9]{1,5}$")
_RE_ENTIER = re.compile(rb"^[-+]?[0-9]{1,12}$")
_RE_REEL = re.compile(rb"^[-+]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][-+]?[0-9]{1,4})?$")
_RE_MOT = re.compile(rb"^[A-Za-z0-9_.-]{1,40}$")
_RE_HANDLE = re.compile(rb"^[0-9A-Fa-f]{1,16}$")
_RE_TYPE = re.compile(rb"^[A-Za-z0-9_]{1,32}$")

# Groupes recopies, par type d'entite (liste blanche) ; le calque (8) est reecrit a part.
_LIGNE = {5: "handle", 10: "reel", 20: "reel", 30: "reel", 11: "reel", 21: "reel", 31: "reel"}
_LWPOLY = {5: "handle", 70: "entier", 90: "entier", 10: "reel", 20: "reel", 42: "reel"}
_POLY = {5: "handle", 70: "entier"}
_VERTEX = {10: "reel", 20: "reel", 30: "reel", 42: "reel", 70: "entier"}


def _faux(message):
    return ErreurGeoconv("FICHIER_INVALIDE", "DXF illisible : " + message)


def _paires(f, controle):
    """Genere (code:int, valeur:bytes sans fin de ligne). Leve FICHIER_INVALIDE si la structure est cassee."""
    n = 0
    while True:
        a = f.readline(LIGNE_MAX + 1)
        if not a:
            return
        if len(a) > LIGNE_MAX and not a.endswith(b"\n"):
            raise _faux("ligne de plus de 64 Kio")
        b = f.readline(LIGNE_MAX + 1)
        if not b:
            raise _faux("nombre impair de lignes (valeur manquante apres le dernier code de groupe)")
        if len(b) > LIGNE_MAX and not b.endswith(b"\n"):
            raise _faux("ligne de plus de 64 Kio")
        code = a.strip()
        if not _RE_CODE.match(code):
            raise _faux("code de groupe non numerique")
        n += 1
        if n % CONTROLE_TOUS_LES == 0:
            controle()
        yield int(code), b.rstrip(b"\r\n")


def _calque_propre(brut):
    """Octets du nom de calque : bornes, caracteres de controle neutralises (ce qui est ecrit pour GDAL et compte ici)."""
    brut = brut[:NOM_CALQUE_OCTETS_MAX]
    return bytes(0x20 if c == 9 else (0x3F if c < 0x20 or c == 0x7F else c) for c in brut) or b"0"


def _decodeur(version, page):
    """Codec Python pour decoder les noms de calques comme GDAL les recode (approximation documentee)."""
    if version and re.match(rb"^AC10(2[1-9]|[3-9][0-9])$", version):
        return "utf-8"
    if page:
        p = page.decode("ascii", "ignore").upper()
        m = re.match(r"^ANSI_(\d{3,4})$", p)
        nom = ("cp" + m.group(1)) if m else p.replace("_", "-").lower()
        try:
            codecs.lookup(nom)
            return nom
        except LookupError:
            pass
    return "latin-1"


class _Bilan:
    def __init__(self):
        self.lues = {}
        self.ignorees = {}
        self.calques = {}  # nom brut propre -> [lues, ignorees]
        self.blocs_definitions = 0
        self.entites_dans_blocs = 0

    def calque(self, brut):
        c = self.calques.get(brut)
        if c is None:
            if len(self.calques) >= CALQUES_MAX:
                raise ErreurGeoconv("DXF_TROP_DE_CALQUES", f"plus de {CALQUES_MAX} calques dans le DXF")
            c = self.calques[brut] = [0, 0]
        return c

    def lue(self, type_, calque):
        self.lues[type_] = self.lues.get(type_, 0) + 1
        self.calque(calque)[0] += 1

    def ignoree(self, type_, calque):
        if type_ not in self.ignorees and len(self.ignorees) >= TYPES_IGNORES_MAX:
            type_ = "AUTRES"
        self.ignorees[type_] = self.ignorees.get(type_, 0) + 1
        self.calque(calque)[1] += 1


class _Entite:
    __slots__ = ("type", "calque", "papier", "groupes", "n", "flags", "sommets", "composite")

    def __init__(self, type_):
        self.type = type_
        self.calque = b"0"
        self.papier = False
        self.groupes = []   # octets deja formates (code + valeur)
        self.n = 0
        self.flags = 0      # POLYLINE : groupe 70 de l'en-tete
        self.sommets = []   # POLYLINE : octets de chaque VERTEX
        self.composite = type_ == b"POLYLINE"


def _g(code, valeur):
    return b"%3d\n" % code + valeur + b"\n"


def _valeur_ok(regle, valeur):
    v = valeur.strip()
    if regle == "reel":
        return v if _RE_REEL.match(v) else None
    if regle == "entier":
        return v if _RE_ENTIER.match(v) else None
    if regle == "handle":
        return v if _RE_HANDLE.match(v) else b""  # handle invalide : simplement omis
    return None


def filtrer(chemin_entree, chemin_sortie, controle):
    """Ecrit chemin_sortie (DXF minimal) et retourne l'inventaire `dxf`. `controle()` est appele regulierement
    (delai total, arret du worker) et peut lever."""
    bilan = _Bilan()
    entetes = {}
    corps = chemin_sortie + ".corps"
    section = None
    attend_nom = False
    var = None
    entite = None
    section_vue = False
    eof_vu = False
    nom_bloc_attendu = False

    def recopier(e, code, valeur, table):
        regle = table.get(code)
        if regle is None:
            return
        v = _valeur_ok(regle, valeur)
        if v is None:
            raise _faux(f"valeur illisible pour le groupe {code} d'une entite {nettoyer(e.type.decode('ascii', 'replace'), 20)}")
        if v == b"":
            return
        e.n += 1
        if e.n > GROUPES_ENTITE_MAX:
            raise _faux(f"entite de plus de {GROUPES_ENTITE_MAX} groupes")
        e.groupes.append(_g(code, v))

    def ecrire_entite(out, e):
        """Cloture une entite de la section ENTITIES : comptage puis ecriture si elle est retenue."""
        type_ = e.type.decode("ascii", "replace")
        if not _RE_TYPE.match(e.type):
            type_ = "AUTRES"
        if e.papier:
            bilan.ignoree("ESPACE_PAPIER", e.calque)
            return
        if e.type in (b"LINE", b"LWPOLYLINE"):
            bilan.lue(type_, e.calque)
            out.write(_g(0, e.type) + _g(8, e.calque) + b"".join(e.groupes))
            return
        if e.type == b"POLYLINE":
            if e.flags & (16 | 64):
                bilan.ignoree("POLYLINE_MAILLAGE", e.calque)
                return
            bilan.lue("3DPOLYLINE" if e.flags & 8 else "POLYLINE", e.calque)
            out.write(_g(0, b"POLYLINE") + _g(8, e.calque) + b"".join(e.groupes) + _g(66, b"1"))
            for s in e.sommets:
                out.write(_g(0, b"VERTEX") + _g(8, e.calque) + s)
            out.write(_g(0, b"SEQEND") + _g(8, e.calque))
            return
        bilan.ignoree(type_, e.calque)

    with open(chemin_entree, "rb") as f, open(corps, "wb") as out:
        sommet = None  # VERTEX en cours (octets) pour une POLYLINE composite
        groupes_sommet = 0

        def cloturer_vertex():
            nonlocal sommet
            if sommet is not None and entite is not None:
                entite.sommets.append(b"".join(sommet))
            sommet = None

        for code, valeur in _paires(f, controle):
            if code == 999:
                continue
            if code == 0:
                type_ = valeur.strip()
                # --- fin de l'entite precedente (sauf POLYLINE composite : elle attend ses VERTEX et SEQEND)
                if entite is not None and entite.composite and section == b"ENTITIES":
                    if type_ == b"VERTEX":
                        cloturer_vertex()
                        sommet = []
                        groupes_sommet = 0
                        continue
                    if type_ == b"SEQEND":
                        cloturer_vertex()
                        ecrire_entite(out, entite)
                        entite = None
                        continue
                    cloturer_vertex()
                    ecrire_entite(out, entite)  # POLYLINE sans SEQEND : on la cloture ici
                    entite = None
                elif entite is not None and section == b"ENTITIES":
                    ecrire_entite(out, entite)
                    entite = None
                if type_ == b"SECTION":
                    attend_nom = True
                    section = None
                    section_vue = True
                    var = None
                    continue
                if type_ == b"ENDSEC":
                    section = None
                    continue
                if type_ == b"EOF":
                    eof_vu = True
                    break
                if section == b"ENTITIES":
                    entite = _Entite(type_)
                elif section == b"BLOCKS":
                    if type_ == b"BLOCK":
                        bilan.blocs_definitions += 1
                        nom_bloc_attendu = True
                    elif type_ != b"ENDBLK":
                        bilan.entites_dans_blocs += 1
                        nom_bloc_attendu = False
                continue

            if attend_nom:
                if code == 2:
                    section = valeur.strip().upper()
                    attend_nom = False
                continue
            if section == b"BLOCKS":
                # Les blocs systeme (*Model_Space, *Paper_Space) existent dans tout DXF : ce ne sont pas des blocs de l'utilisateur.
                if nom_bloc_attendu and code == 2:
                    nom_bloc_attendu = False
                    if re.match(rb"^\*(model|paper)_space", valeur.strip(), re.I):
                        bilan.blocs_definitions -= 1
                continue
            if section == b"HEADER":
                if code == 9:
                    var = valeur.strip()
                elif var is not None:
                    if var in (b"$ACADVER", b"$DWGCODEPAGE", b"$INSUNITS") and var not in entetes:
                        v = valeur.strip()
                        if (var == b"$INSUNITS" and _RE_ENTIER.match(v)) or (var != b"$INSUNITS" and _RE_MOT.match(v)):
                            entetes[var] = v
                    var = None
                continue
            if section != b"ENTITIES" or entite is None:
                continue
            if sommet is not None:  # groupes d'un VERTEX
                regle = _VERTEX.get(code)
                if regle is not None:
                    v = _valeur_ok(regle, valeur)
                    if v is None:
                        raise _faux(f"valeur illisible pour le groupe {code} d'un VERTEX")
                    groupes_sommet += 1
                    entite.n += 1
                    if entite.n > GROUPES_ENTITE_MAX:
                        raise _faux(f"entite de plus de {GROUPES_ENTITE_MAX} groupes")
                    sommet.append(_g(code, v))
                continue
            if code == 8:
                entite.calque = _calque_propre(valeur)
            elif code == 67:
                entite.papier = valeur.strip() == b"1"
            elif entite.type == b"LINE":
                recopier(entite, code, valeur, _LIGNE)
            elif entite.type == b"LWPOLYLINE":
                recopier(entite, code, valeur, _LWPOLY)
            elif entite.type == b"POLYLINE":
                if code == 70:
                    v = _valeur_ok("entier", valeur)
                    if v is None:
                        raise _faux("drapeaux de POLYLINE illisibles")
                    entite.flags = int(v)
                    entite.groupes.append(_g(70, v))
                else:
                    recopier(entite, code, valeur, {5: "handle"})
        if entite is not None and section == b"ENTITIES":
            cloturer_vertex()
            ecrire_entite(out, entite)
        elif sommet is not None:
            cloturer_vertex()
    if not section_vue:
        raise _faux("aucune section DXF")
    if not eof_vu:
        raise _faux("fichier tronque (marqueur EOF absent)")

    version = entetes.get(b"$ACADVER")
    page = entetes.get(b"$DWGCODEPAGE")
    # Fichier final : en-tete minimal, section ENTITIES (le corps), fin.
    with open(chemin_sortie, "wb") as final:
        final.write(_g(0, b"SECTION") + _g(2, b"HEADER"))
        for nom in (b"$ACADVER", b"$DWGCODEPAGE", b"$INSUNITS"):
            if nom in entetes:
                final.write(_g(9, nom) + _g(70 if nom == b"$INSUNITS" else (1 if nom == b"$ACADVER" else 3), entetes[nom]))
        final.write(_g(0, b"ENDSEC") + _g(0, b"SECTION") + _g(2, b"ENTITIES"))
        with open(corps, "rb") as c:
            while True:
                bloc = c.read(1024 * 1024)
                if not bloc:
                    break
                final.write(bloc)
        final.write(_g(0, b"ENDSEC") + _g(0, b"EOF"))
    os.unlink(corps)

    codec = _decodeur(version, page)
    fusion = {}
    for brut, (lues, ign) in bilan.calques.items():
        nom = nettoyer(brut.decode(codec, "replace"), 255)
        c = fusion.setdefault(nom, [0, 0])
        c[0] += lues
        c[1] += ign
    calques = [{"nom": n, "lues": v[0], "ignorees": v[1]} for n, v in sorted(fusion.items())]
    total_lues = sum(bilan.lues.values())
    total_ignorees = sum(bilan.ignorees.values())
    return {
        "version": nettoyer(version.decode("ascii", "replace"), 40) if version else None,
        "codepage": nettoyer(page.decode("ascii", "replace"), 40) if page else None,
        "entitesSupportees": list(ENTITES_SUPPORTEES),
        "lues": dict(sorted(bilan.lues.items())),
        "ignorees": dict(sorted(bilan.ignorees.items())),
        "blocs": {"definitions": bilan.blocs_definitions, "entitesDansBlocs": bilan.entites_dans_blocs},
        "calques": calques,
        "nbEntitesTotal": total_lues + total_ignorees,
    }


def avertissements(dxf):
    """Avertissements typés (code, message, nb) pour le contrat, d'apres l'inventaire."""
    res = []
    ign = dxf["ignorees"]
    total = sum(ign.values())
    if total:
        principaux = sorted(ign.items(), key=lambda kv: (-kv[1], kv[0]))[:5]
        res.append(("DXF_ENTITES_IGNOREES",
                    "entites DXF non prises en charge, ignorees et comptees : " + ", ".join(f"{k} {v}" for k, v in principaux), total))
    nb_blocs = ign.get("INSERT", 0) + dxf["blocs"]["definitions"]
    if nb_blocs:
        res.append(("DXF_BLOCS_IGNORES",
                    "blocs DXF ignores : insertions (INSERT) et definitions de blocs ne sont pas lues", nb_blocs))
    return res
