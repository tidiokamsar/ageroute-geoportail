"""Pre-controle et extraction d'un ZIP contenant un Shapefile.

Ordre voulu : (1) lecture de l'enregistrement de fin (EOCD) SEUL pour borner le nombre
d'entrees AVANT que la bibliotheque ne lise le repertoire central ; (2) controle de chaque
entree a partir du repertoire central (noms, types, tailles declarees, taux, recouvrement) ;
(3) seulement ensuite, extraction d'une liste blanche d'extensions vers un repertoire
temporaire, avec compteurs sur les octets REELLEMENT decompresses.
"""
import os
import re
import stat
import struct
import zipfile

from erreurs import ErreurGeoconv, nettoyer

EXT_SHAPEFILE = {"shp", "shx", "dbf", "prj", "cpg"}
EXT_OBLIGATOIRES = ("shp", "shx", "dbf")
EXT_ARCHIVES = {"zip", "gz", "tgz", "tar", "7z", "rar", "bz2", "xz", "zst", "kmz", "jar", "cab", "lz", "lzma", "z"}
MAGIES_ARCHIVES = (b"PK\x03\x04", b"PK\x05\x06", b"\x1f\x8b", b"7z\xbc\xaf", b"Rar!", b"BZh", b"\xfd7zXZ")
_CTRL = re.compile(r"[\x00-\x1f\x7f]")
CHUNK = 64 * 1024
CD_MAX_OCTETS = 16 * 1024 * 1024


def _eocd(f, taille):
    """Retourne (nb_entrees, taille_repertoire_central) lus dans l'EOCD (et ZIP64 le cas echeant)."""
    lecture = min(taille, 65557)
    f.seek(taille - lecture)
    fin = f.read(lecture)
    pos = fin.rfind(b"PK\x05\x06")
    if pos < 0 or len(fin) - pos < 22:
        raise ErreurGeoconv("ARCHIVE_INVALIDE", "enregistrement de fin d'archive introuvable")
    _sig, disque, disque_cd, n_disque, n_total, cd_taille, cd_off, _lc = struct.unpack("<IHHHHIIH", fin[pos:pos + 22])
    if disque != 0 or disque_cd != 0 or n_disque != n_total:
        raise ErreurGeoconv("ARCHIVE_INVALIDE", "archive multi-volumes non supportee")
    if n_total == 0xFFFF or cd_taille == 0xFFFFFFFF or cd_off == 0xFFFFFFFF:
        loc = fin.rfind(b"PK\x06\x07", 0, pos)
        if loc < 0 or pos - loc < 20:
            raise ErreurGeoconv("ARCHIVE_INVALIDE", "localisateur ZIP64 introuvable")
        _s, _d, off64, _t = struct.unpack("<IIQI", fin[loc:loc + 20])
        f.seek(off64)
        rec = f.read(56)
        if len(rec) < 56 or rec[:4] != b"PK\x06\x06":
            raise ErreurGeoconv("ARCHIVE_INVALIDE", "enregistrement ZIP64 invalide")
        (_s, _taille, _va, _vn, _d1, _d2, _n1, n_total, cd_taille, _o) = struct.unpack("<IQHHIIQQQQ", rec)
    return n_total, cd_taille


def _nom_dangereux(nom):
    if _CTRL.search(nom):
        return "caracteres de controle ou NUL dans le nom"
    if "\\" in nom:
        return "separateur anti-slash dans le nom"
    if nom.startswith("/") or re.match(r"^[A-Za-z]:", nom):
        return "chemin absolu"
    if len(nom.encode("utf-8", "replace")) > 400:
        return "nom trop long"
    if any(p == ".." for p in nom.split("/")):
        return "remontee de repertoire (..)"
    return None


def _stem_sur(stem):
    if not stem or len(stem) > 100 or stem[0] in "-." or stem != stem.strip():
        return False
    return not re.search(r'[\x00-\x1f\x7f/\\:*?"<>|]', stem)


def precontroler(chemin, taille, limites):
    """Controle complet SANS rien decompresser (hors 8 octets de magie par entree).
    Retourne (ZipFile ouvert, fichier ouvert, entrees retenues, avertissements, stats)."""
    avert = []
    f = open(chemin, "rb")
    try:
        n, cd_taille = _eocd(f, taille)
        if n > limites.entrees_archive_max:
            raise ErreurGeoconv("ARCHIVE_TROP_D_ENTREES",
                                f"{n} entrees declarees, maximum {limites.entrees_archive_max}", entrees=n)
        if cd_taille > CD_MAX_OCTETS or cd_taille > n * 70000 + 22:
            raise ErreurGeoconv("ARCHIVE_INVALIDE", "repertoire central de taille aberrante")
        try:
            zf = zipfile.ZipFile(f)
        except zipfile.BadZipFile as e:
            raise ErreurGeoconv("ARCHIVE_INVALIDE", nettoyer(f"archive illisible : {e}"))
        infos = zf.infolist()
        if len(infos) != n:
            raise ErreurGeoconv("ARCHIVE_INVALIDE", "nombre d'entrees incoherent entre l'EOCD et le repertoire central")
        total = 0
        vus = set()
        retenus = {}
        ignores = []
        for zi in infos:
            nom = zi.orig_filename
            raison = _nom_dangereux(nom)
            if raison:
                raise ErreurGeoconv("ARCHIVE_CHEMIN_DANGEREUX", f"entree refusee : {raison}", entree=nettoyer(nom, 80))
            if nom in vus:
                raise ErreurGeoconv("ARCHIVE_NOMS_AMBIGUS", "deux entrees portent le meme nom", entree=nettoyer(nom, 80))
            vus.add(nom)
            mode = (zi.external_attr >> 16) & 0xFFFF
            fmt = stat.S_IFMT(mode)
            if fmt == stat.S_IFLNK:
                raise ErreurGeoconv("ARCHIVE_LIEN_SYMBOLIQUE", "lien symbolique dans l'archive", entree=nettoyer(nom, 80))
            if fmt not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise ErreurGeoconv("ARCHIVE_ENTREE_SPECIALE", "entree speciale (peripherique, tube...) dans l'archive",
                                    entree=nettoyer(nom, 80))
            if zi.flag_bits & 0x1 or zi.flag_bits & 0x40:
                raise ErreurGeoconv("ARCHIVE_CHIFFREE", "archive chiffree non supportee")
            if zi.is_dir():
                continue
            if zi.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise ErreurGeoconv("ARCHIVE_METHODE_NON_SUPPORTEE", f"methode de compression {zi.compress_type} non supportee")
            base = nom.rsplit("/", 1)[-1]
            ext = base.rsplit(".", 1)[-1].lower() if "." in base else ""
            if ext in EXT_ARCHIVES:
                raise ErreurGeoconv("ARCHIVE_IMBRIQUEE", "archive imbriquee refusee", entree=nettoyer(nom, 80))
            total += zi.file_size
            if total > limites.taille_decompressee_octets:
                raise ErreurGeoconv("ARCHIVE_TROP_GROSSE",
                                    f"taille decompressee declaree superieure a {limites.taille_decompressee_octets} octets")
            if zi.file_size > 1024 * 1024:
                if zi.compress_size == 0 or zi.file_size / zi.compress_size > limites.taux_compression_max:
                    raise ErreurGeoconv("ARCHIVE_TAUX_COMPRESSION",
                                        f"taux de compression superieur a {limites.taux_compression_max}:1",
                                        entree=nettoyer(nom, 80))
            if ext in EXT_SHAPEFILE:
                stem = base.rsplit(".", 1)[0]
                cle = (stem.lower(), ext)
                if cle in retenus:
                    raise ErreurGeoconv("ARCHIVE_NOMS_AMBIGUS",
                                        "deux entrees de repertoires differents portent le meme nom", entree=nettoyer(nom, 80))
                retenus[cle] = (zi, stem)
            else:
                ignores.append(nettoyer(base, 60))
        # Recouvrement des donnees (ZIP bombs a entrees partageant leurs octets).
        tri = sorted((z for z in infos if not z.is_dir()), key=lambda z: z.header_offset)
        for a, b in zip(tri, tri[1:]):
            if b.header_offset < a.header_offset + 30 + len(a.orig_filename.encode("utf-8", "replace")) + a.compress_size:
                raise ErreurGeoconv("ARCHIVE_CHEVAUCHEMENT", "entrees dont les donnees se chevauchent")
        # Magie de chaque entree non dossier : une archive deguisee est refusee.
        for zi in infos:
            if zi.is_dir() or zi.file_size == 0:
                continue
            try:
                with zf.open(zi) as e:
                    debut = e.read(8)
            except (zipfile.BadZipFile, NotImplementedError, RuntimeError, EOFError, OSError, ValueError) as ex:
                raise ErreurGeoconv("ARCHIVE_INVALIDE", nettoyer(f"entree illisible : {ex}"))
            if debut.startswith(MAGIES_ARCHIVES):
                raise ErreurGeoconv("ARCHIVE_IMBRIQUEE", "archive imbriquee (detectee par le contenu)",
                                    entree=nettoyer(zi.orig_filename, 80))
        if ignores:
            avert.append({"code": "ENTREES_ARCHIVE_IGNOREES", "nb": len(ignores),
                          "message": f"{len(ignores)} entree(s) hors Shapefile ignoree(s), non extraite(s)"})
        return zf, f, retenus, avert, {"entrees": n, "taille_declaree_octets": total}
    except BaseException:
        f.close()
        raise


def extraire(zf, retenus, dossier, limites):
    """Extrait la liste blanche vers `dossier` ; retourne (couches, avertissements, octets extraits)."""
    avert = []
    groupes = {}
    for (stem_min, ext), (zi, stem) in sorted(retenus.items()):
        groupes.setdefault(stem_min, {"stem": stem, "exts": {}})["exts"][ext] = zi
    couches = []
    cumul = 0
    for i, (stem_min, g) in enumerate(sorted(groupes.items()), start=1):
        if "shp" not in g["exts"]:
            avert.append({"code": "FICHIERS_ORPHELINS", "nb": len(g["exts"]),
                          "message": "fichiers Shapefile sans .shp, ignores"})
            continue
        manque = [e for e in EXT_OBLIGATOIRES if e not in g["exts"]]
        if manque:
            raise ErreurGeoconv("SHAPEFILE_INCOMPLET",
                                "fichier(s) obligatoire(s) absent(s) : " + ", ".join("." + m for m in manque),
                                couche=nettoyer(g["stem"], 80), manquants=manque)
        stem = g["stem"]
        if not _stem_sur(stem):
            stem_interne = f"couche_{i}"
            avert.append({"code": "NOM_FICHIER_RENOMME", "nb": 1,
                          "message": "nom de fichier non sur renomme en " + stem_interne})
        else:
            stem_interne = stem
        chemins = {}
        for ext, zi in g["exts"].items():
            dest = os.path.join(dossier, f"{stem_interne}.{ext}")
            fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            ecrit = 0
            with os.fdopen(fd, "wb") as out, zf.open(zi) as src:
                while True:
                    bloc = src.read(CHUNK)
                    if not bloc:
                        break
                    ecrit += len(bloc)
                    cumul += len(bloc)
                    if ecrit > zi.file_size or cumul > limites.taille_decompressee_octets:
                        raise ErreurGeoconv("ARCHIVE_TROP_GROSSE",
                                            "octets decompresses superieurs a la taille declaree ou au plafond")
                    out.write(bloc)
            if ecrit != zi.file_size:
                raise ErreurGeoconv("ARCHIVE_INVALIDE", "taille decompressee differente de la taille declaree")
            chemins[ext] = dest
        with open(chemins["shp"], "rb") as fs:
            if fs.read(4) != b"\x00\x00\x27\x0a":
                raise ErreurGeoconv("SHAPEFILE_INVALIDE", "en-tete .shp invalide", couche=nettoyer(stem, 80))
        couches.append({"stem": stem, "interne": stem_interne, "chemins": chemins, "prj": "prj" in chemins})
    if not couches:
        raise ErreurGeoconv("ARCHIVE_SANS_DONNEES", "aucun Shapefile (.shp) dans l'archive")
    return couches, avert, cumul
