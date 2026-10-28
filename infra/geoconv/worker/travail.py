"""Traitement d'UN job : pre-controle, extraction, inventaire, conversion, ecriture des sorties.

Le worker n'a ni base de donnees, ni reseau : il lit entree/<jobId>/ (lecture seule), travaille
dans un repertoire temporaire du conteneur (nettoye quoi qu'il arrive) et n'ecrit que dans
sortie/<jobId>/. statut.json est ecrit EN DERNIER : c'est le signal d'achevement.
"""
import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
import time
import unicodedata

import analyse
import archive
import detection
from config import VERSION_CONTRAT, VERSION_WORKER
from erreurs import ErreurGeoconv, Interruption, nettoyer
from gdalio import classer_signal

RE_JOB = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$")
CLES_DEMANDE = {"version", "fichier", "couches", "epsg_source", "autoriser_surcharge_crs", "limites"}
EXT_DECLAREES = {"gpkg": "GPKG", "zip": "ZIP", "dxf": "DXF"}
PILOTE_DE_FORMAT = {"GPKG": "GPKG", "DXF": "DXF", "ZIP": "ESRI Shapefile"}


# ------------------------------------------------------------------ utilitaires fichiers
def ecrire_json(chemin, objet):
    tmp = chemin + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(objet, f, ensure_ascii=False, indent=2, allow_nan=False, default=str)
        f.write("\n")
    os.chmod(tmp, 0o644)
    os.replace(tmp, chemin)


def lire_fichier_regulier(chemin, maxi):
    """Ouvre sans suivre de lien, refuse tout ce qui n'est pas un fichier regulier."""
    try:
        fd = os.open(chemin, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError as e:
        raise ErreurGeoconv("ENTREE_ABSENTE", f"fichier d'entree inaccessible ({e.strerror})")
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode):
        os.close(fd)
        raise ErreurGeoconv("ENTREE_ABSENTE", "l'entree n'est pas un fichier regulier (lien, tube ou peripherique refuse)")
    if st.st_size > maxi:
        os.close(fd)
        raise ErreurGeoconv("FICHIER_TROP_GROS", f"fichier de {st.st_size} octets, maximum {maxi}")
    return fd, st.st_size


def copier_borne(fd, destination, maxi):
    h = hashlib.sha256()
    total = 0
    with os.fdopen(fd, "rb") as src, open(destination, "xb") as out:
        while True:
            bloc = src.read(1024 * 1024)
            if not bloc:
                break
            total += len(bloc)
            if total > maxi:
                raise ErreurGeoconv("FICHIER_TROP_GROS", f"fichier plus grand que {maxi} octets")
            h.update(bloc)
            out.write(bloc)
    return total, h.hexdigest()


def slug(nom, deja):
    s = unicodedata.normalize("NFKD", nom).encode("ascii", "ignore").decode("ascii").lower()
    s = re.sub(r"[^a-z0-9_-]+", "_", s).strip("_-")[:60] or "couche"
    base, i = s, 2
    while s in deja:
        s = f"{base}-{i}"
        i += 1
    deja.add(s)
    return s


# ------------------------------------------------------------------ demande
def lire_demande(dossier_job, cfg):
    fd, _ = lire_fichier_regulier(os.path.join(dossier_job, "demande.json"), 64 * 1024)
    with os.fdopen(fd, "rb") as f:
        brut = f.read(64 * 1024 + 1)
    try:
        d = json.loads(brut)
    except ValueError:
        raise ErreurGeoconv("DEMANDE_INVALIDE", "demande.json n'est pas du JSON valide")
    if not isinstance(d, dict):
        raise ErreurGeoconv("DEMANDE_INVALIDE", "demande.json doit etre un objet")
    inconnues = set(d) - CLES_DEMANDE
    if inconnues:
        raise ErreurGeoconv("DEMANDE_INVALIDE", "cle(s) inconnue(s) : " + nettoyer(", ".join(sorted(map(str, inconnues))), 100))
    if d.get("version", VERSION_CONTRAT) != VERSION_CONTRAT:
        raise ErreurGeoconv("DEMANDE_INVALIDE", f"version de contrat non supportee (attendue : {VERSION_CONTRAT})")
    fichier = d.get("fichier")
    if fichier is not None and (not isinstance(fichier, str) or not re.fullmatch(r"fichier\.[A-Za-z0-9]{1,8}", fichier)):
        raise ErreurGeoconv("DEMANDE_INVALIDE", "fichier : nom attendu de la forme fichier.<ext>")
    couches = d.get("couches")
    if couches is not None:
        if (not isinstance(couches, list) or not couches or len(couches) > 200
                or not all(isinstance(c, str) and 0 < len(c) <= 256 for c in couches)):
            raise ErreurGeoconv("DEMANDE_INVALIDE", "couches : liste non vide de noms (256 caracteres au plus)")
    epsg = d.get("epsg_source")
    if epsg is not None and (isinstance(epsg, bool) or not isinstance(epsg, int) or not (1 <= epsg <= 999999)):
        raise ErreurGeoconv("DEMANDE_INVALIDE", "epsg_source : entier entre 1 et 999999 attendu")
    surcharge = d.get("autoriser_surcharge_crs", False)
    if not isinstance(surcharge, bool):
        raise ErreurGeoconv("DEMANDE_INVALIDE", "autoriser_surcharge_crs : booleen attendu")
    limites = d.get("limites") or {}
    if not isinstance(limites, dict):
        raise ErreurGeoconv("DEMANDE_INVALIDE", "limites : objet attendu")
    try:
        lim = cfg.limites.abaisser(limites)
    except ValueError as e:
        raise ErreurGeoconv("DEMANDE_INVALIDE", nettoyer(str(e)))
    return {"fichier": fichier, "couches": couches, "epsg_source": epsg, "surcharge": surcharge, "limites": lim}


def trouver_fichier(dossier_job, nom):
    if nom:
        return os.path.join(dossier_job, nom), nom
    cands = sorted(n for n in os.listdir(dossier_job) if re.fullmatch(r"fichier\.[A-Za-z0-9]{1,8}", n))
    if len(cands) != 1:
        raise ErreurGeoconv("ENTREE_ABSENTE", "exactement un fichier fichier.<ext> est attendu dans le dossier du job")
    return os.path.join(dossier_job, cands[0]), cands[0]


# ------------------------------------------------------------------ job
class Job:
    def __init__(self, cfg, gdal, job_id):
        self.cfg = cfg
        self.gdal = gdal
        self.id = job_id
        self.entree = os.path.join(cfg.spool, "entree", job_id)
        self.sortie = os.path.join(cfg.spool, "sortie", job_id)
        self.debut = time.monotonic()
        self.debut_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.avert = []
        self.mesures = []
        self.lim = cfg.limites
        self.inventaire = None
        self.resultat_couches = []
        self.source = None
        self.format_detecte = None

    # -- statut ------------------------------------------------------------------------
    def statut(self, etat, code=None, message=None, etape=None, **extra):
        s = {"jobId": self.id, "statut": etat, "etape": etape, "code": code, "message": nettoyer(message, 500),
             "debut": self.debut_iso,
             "fin": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) if etat != "en_cours" else None,
             "versionWorker": VERSION_WORKER, "versionContrat": VERSION_CONTRAT}
        s.update(extra)
        ecrire_json(os.path.join(self.sortie, "statut.json"), s)

    def reste_s(self):
        r = self.lim.delai_s - (time.monotonic() - self.debut)
        if r <= 0:
            raise ErreurGeoconv("DELAI_DEPASSE", f"delai total de {self.lim.delai_s} s depasse")
        return r

    def duree_ms(self):
        return int((time.monotonic() - self.debut) * 1000)

    def avertir(self, code, message, nb=None, **extra):
        a = {"code": code, "message": nettoyer(message, 400)}
        if nb is not None:
            a["nb"] = nb
        a.update(extra)
        self.avert.append(a)
        return a

    # -- point d'entree ----------------------------------------------------------------
    def executer(self):
        os.mkdir(self.sortie, 0o755)  # reclame le job (atomique) ; leve FileExistsError s'il est deja pris
        os.makedirs(self.cfg.tmp, mode=0o700, exist_ok=True)
        tmp = tempfile.mkdtemp(prefix=self.id[:20] + "-", dir=self.cfg.tmp)
        self.gdal.tmp = tmp
        code_final = None
        try:
            self.statut("en_cours", etape="demarrage")
            try:
                self._pipeline(tmp)
                self._ecrire_resultat("termine")
                self.statut("termine", etape="termine", nbCouches=len(self.resultat_couches))
            except ErreurGeoconv as e:
                code_final = e.code
                self._echec(e.code, e.message, e.details)
            except Interruption:
                code_final = "INTERROMPU"
                self._echec("INTERROMPU", "traitement interrompu par l'arret du worker", {})
            except MemoryError:
                code_final = "MEMOIRE_EPUISEE"
                self._echec("MEMOIRE_EPUISEE", "memoire du worker epuisee", {})
            except Exception as e:  # defaut inattendu : jamais de trace brute vers le backend
                code_final = "ERREUR_INTERNE"
                print(f"[geoconv] erreur interne job={self.id} {type(e).__name__}: {nettoyer(e)}", flush=True)
                self._echec("ERREUR_INTERNE", "erreur interne du worker (voir le journal du conteneur)", {})
        finally:
            shutil.rmtree(tmp, ignore_errors=True)  # nettoyage garanti
        return code_final

    def _echec(self, code, message, details):
        shutil.rmtree(os.path.join(self.sortie, "couches"), ignore_errors=True)  # jamais de sortie partielle
        self.resultat_couches = []
        self._ecrire_resultat("echec", code=code, message=message, details=details)
        self.statut("echec", code=code, message=message, etape="echec")

    def _ecrire_resultat(self, etat, code=None, message=None, details=None):
        res = {
            "versionContrat": VERSION_CONTRAT, "jobId": self.id, "statut": etat,
            "code": code, "message": nettoyer(message, 500), "details": dict(details or {}),
            "source": self.source, "format": self.format_detecte,
            "couches": self.resultat_couches, "avertissements": self.avert,
            "limitesAppliquees": vars(self.lim).copy(),
            "mesures": {"dureeMs": self.duree_ms(), "etapes": self.mesures},
            "gdal": {"version": self.gdal.version, "proj": self.gdal.proj, "pilotesActifs": self.gdal.pilotes_actifs},
        }
        ecrire_json(os.path.join(self.sortie, "resultat.json"), res)
        if self.inventaire is not None:
            ecrire_json(os.path.join(self.sortie, "inventaire.json"), self._inventaire_final())

    def _inventaire_final(self):
        inv = dict(self.inventaire)
        inv["couches"] = [{k: v for k, v in c.items() if not k.startswith("_")} for c in self.inventaire["couches"]]
        inv["avertissements"] = self.avert
        inv["dureeMs"] = self.duree_ms()
        inv["gdal"] = {"version": self.gdal.version, "proj": self.gdal.proj}
        return inv

    def mesure(self, nom, ex):
        self.mesures.append({"etape": nom, "dureeMs": ex.duree_ms, "picMemoireKo": ex.pic_memoire_ko})

    # -- pipeline ----------------------------------------------------------------------
    def _pipeline(self, tmp):
        d = lire_demande(self.entree, self.cfg)
        self.lim = d["limites"]
        chemin_entree, nom_fichier = trouver_fichier(self.entree, d["fichier"])
        ext_decl = nom_fichier.rsplit(".", 1)[-1].lower()

        self.statut("en_cours", etape="copie")
        fd, taille = lire_fichier_regulier(chemin_entree, self.lim.taille_entree_octets)
        local = os.path.join(tmp, "entree.bin")
        taille, sha = copier_borne(fd, local, self.lim.taille_entree_octets)
        self.source = {"nom": nettoyer(nom_fichier, 64), "octets": taille, "sha256": sha}

        self.statut("en_cours", etape="detection")
        famille = detection.detecter(local, taille)
        self.format_detecte = {"famille": famille, "pilote": PILOTE_DE_FORMAT[famille], "detection": "contenu",
                               "extensionDeclaree": ext_decl,
                               "extensionCoherente": EXT_DECLAREES.get(ext_decl) == famille or ext_decl not in EXT_DECLAREES}
        if not self.format_detecte["extensionCoherente"]:
            self.avertir("EXTENSION_INCOHERENTE",
                         f"l'extension .{ext_decl} ne correspond pas au contenu ({famille}) : le contenu fait foi")

        archive_info = None
        sources = []  # [{chemin, pilote, jeu, prj, options}]
        unites_fichier = None
        if famille == "ZIP":
            self.statut("en_cours", etape="precontrole-archive")
            zf, f, retenus, av, stats = archive.precontroler(local, taille, self.lim)
            try:
                self.avert.extend(av)
                dossier = os.path.join(tmp, "extrait")
                os.mkdir(dossier, 0o700)
                self.statut("en_cours", etape="extraction")
                couches_shp, av2, octets = archive.extraire(zf, retenus, dossier, self.lim)
            finally:
                zf.close()
                f.close()
            self.avert.extend(av2)
            archive_info = {"entrees": stats["entrees"], "tailleDeclareeOctets": stats["taille_declaree_octets"],
                            "tailleExtraiteOctets": octets, "shapefiles": len(couches_shp)}
            for c in couches_shp:
                sources.append({"chemin": c["chemins"]["shp"], "pilote": "ESRI Shapefile", "jeu": c["stem"],
                                "prj": c["prj"], "options": []})
        elif famille == "GPKG":
            p = os.path.join(tmp, "entree.gpkg")
            os.rename(local, p)
            sources.append({"chemin": p, "pilote": "GPKG", "jeu": None, "prj": None, "options": []})
        else:
            p = os.path.join(tmp, "entree.dxf")
            os.rename(local, p)
            unites_fichier = detection.unites_dxf(p)
            sources.append({"chemin": p, "pilote": "DXF", "jeu": None, "prj": None, "options": []})

        # ---- inventaire
        self.statut("en_cours", etape="inventaire")
        couches = []
        for src in sources:
            self.reste_s()
            info, ex = self.gdal.ogrinfo_json(src["chemin"], src["pilote"], min(self.reste_s(), 60), src["options"])
            self.mesure("ogrinfo", ex)
            pilote_reel = info.get("driverShortName")
            if pilote_reel != src["pilote"]:
                raise ErreurGeoconv("PILOTE_INATTENDU", f"pilote ouvert {nettoyer(pilote_reel, 40)} different de {src['pilote']}")
            for lj in info.get("layers") or []:
                couches.append(self._decrire_couche(lj, src, unites_fichier))
        if len(couches) > self.lim.couches_max:
            raise ErreurGeoconv("TROP_DE_COUCHES", f"{len(couches)} couches, maximum {self.lim.couches_max}")
        self.inventaire = {
            "versionContrat": VERSION_CONTRAT, "jobId": self.id, "source": self.source, "format": self.format_detecte,
            "archive": archive_info,
            "unites": ({"origine": "$INSUNITS (en-tete DXF)", **unites_fichier} if unites_fichier else None),
            "couches": couches,
        }
        if not couches:
            raise ErreurGeoconv("AUCUNE_COUCHE", "aucune couche vectorielle dans le fichier")
        if unites_fichier is None and famille == "DXF":
            self.avertir("UNITES_ABSENTES", "unites du DXF non lisibles ($INSUNITS absent ou DXF binaire)")

        # ---- selection
        choisies = self._selectionner(couches, d["couches"])
        self.statut("en_cours", etape="conversion", nbCouchesCibles=len(choisies))

        # ---- conversion
        os.mkdir(os.path.join(self.sortie, "couches"), 0o755)
        deja = set()
        octets_sortie = 0
        total_objets = 0
        for c in choisies:
            self.reste_s()
            octets, nb = self._convertir_couche(c, d, deja, self.lim.sortie_octets_max - octets_sortie)
            octets_sortie += octets
            total_objets += nb
            if total_objets > self.lim.objets_max:
                raise ErreurGeoconv("TROP_D_OBJETS", f"plus de {self.lim.objets_max} objets au total")
        if total_objets == 0:
            raise ErreurGeoconv("AUCUN_OBJET", "aucun objet dans les couches converties")

    # -- decrire une couche -----------------------------------------------------------
    def _decrire_couche(self, lj, src, unites_fichier):
        nom = lj.get("name")
        champs_geo = lj.get("geometryFields") or []
        crs = analyse.lire_crs(lj)
        brut_champs = lj.get("fields") or []
        if len(brut_champs) > self.lim.champs_max:
            raise ErreurGeoconv("CHAMPS_TROP_NOMBREUX", f"plus de {self.lim.champs_max} champs dans une couche")
        champs = [{"nom": nettoyer(c.get("name"), 128), "type": nettoyer(c.get("type"), 40),
                   **({"largeur": c["width"]} if c.get("width") else {}),
                   **({"precision": c["precision"]} if c.get("precision") else {})}
                  for c in brut_champs]
        unites = None
        if crs and crs.get("unite"):
            unites = {"origine": "crs", **crs["unite"]}
        elif unites_fichier:
            unites = {"origine": "$INSUNITS (en-tete DXF, ne vaut pas CRS)", "nom": unites_fichier["nom"], "code": unites_fichier["code"]}
        ext = champs_geo[0].get("extent") if champs_geo else None
        return {
            "nom": nettoyer(nom, 256), "_nom_brut": nom, "jeu": nettoyer(src["jeu"], 128) if src["jeu"] else None,
            "_src": src, "geometrie": bool(champs_geo),
            "nbObjets": lj.get("featureCount"),
            "typeGeometrieDeclare": nettoyer(champs_geo[0].get("type"), 40) if champs_geo else None,
            "champs": champs, "emprise": ext if isinstance(ext, list) and len(ext) == 4 else None,
            "crs": crs, "unites": unites, "prjPresent": src["prj"],
        }

    def _selectionner(self, couches, demandees):
        par_nom = {}
        for c in couches:
            par_nom.setdefault(c["_nom_brut"], []).append(c)
        if demandees:
            choisies = []
            for nom in demandees:
                trouve = par_nom.get(nom)
                if not trouve:
                    raise ErreurGeoconv("COUCHE_INTROUVABLE", "couche demandee absente : " + nettoyer(nom, 80))
                if len(trouve) > 1:
                    raise ErreurGeoconv("COUCHE_AMBIGUE", "plusieurs couches portent ce nom : " + nettoyer(nom, 80))
                choisies.append(trouve[0])
        else:
            choisies = []
            for c in couches:
                if not c["geometrie"]:
                    self.avertir("COUCHE_SANS_GEOMETRIE_IGNOREE", "couche sans geometrie ignoree : " + nettoyer(c["nom"], 80))
                else:
                    choisies.append(c)
        if not choisies:
            raise ErreurGeoconv("AUCUNE_COUCHE", "aucune couche geometrique a convertir")
        # Le nom de couche est une DONNEE ; on refuse seulement ce qu'un analyseur d'options pourrait
        # prendre pour une option (tiret initial) ou ce qui contient des caracteres de controle.
        retenues = []
        for c in choisies:
            n = c["_nom_brut"]
            if not n or n.startswith("-") or any(ord(ch) < 32 or ord(ch) == 127 for ch in n):
                self.avertir("COUCHE_NOM_REFUSE", "couche ignoree : nom non sur (tiret initial ou caractere de controle)")
                c["ignoree"] = "nom refuse"
                continue
            retenues.append(c)
        if not retenues:
            raise ErreurGeoconv("AUCUNE_COUCHE", "aucune couche convertible (noms refuses)")
        return retenues

    # -- convertir une couche ----------------------------------------------------------
    def _convertir_couche(self, c, d, deja, octets_restants):
        src = c["_src"]
        crs = c["crs"]
        epsg_demande = d["epsg_source"]
        avert_couche = []

        def av(code, message, **x):
            a = self.avertir(code, message + " [" + nettoyer(c["nom"], 60) + "]", **x)
            avert_couche.append(a)

        reproj = False
        epsg_src = None
        origine_crs = None
        if crs:
            origine_crs = "fichier"
            if epsg_demande is not None:
                if crs.get("epsg") != epsg_demande:
                    if not d["surcharge"]:
                        raise ErreurGeoconv("CRS_CONFLIT",
                                            "le CRS du fichier differe de epsg_source ; autoriser_surcharge_crs est requis pour l'ecraser",
                                            epsgFichier=crs.get("epsg"), epsgDemande=epsg_demande)
                    av("CRS_SURCHARGE", f"CRS du fichier ecrase par EPSG:{epsg_demande} sur demande explicite")
                    origine_crs, epsg_src = "demande", epsg_demande
                else:
                    epsg_src = epsg_demande
                reproj = epsg_src != 4326
            else:
                epsg_src = crs.get("epsg")
                reproj = epsg_src != 4326  # un CRS sans code EPSG est transforme avec sa definition propre
        elif epsg_demande is not None:
            origine_crs, epsg_src = "demande", epsg_demande
            reproj = epsg_src != 4326
            av("CRS_FOURNI_PAR_LA_DEMANDE", f"fichier sans CRS : EPSG:{epsg_demande} fourni explicitement par la demande")
        else:
            av("CRS_ABSENT", "aucun CRS dans le fichier et aucun EPSG fourni : coordonnees brutes, crs=null, aucune reprojection")
        if epsg_src is not None and origine_crs == "demande":
            if self.gdal.epsg_connu(epsg_src) is None:
                raise ErreurGeoconv("CRS_NON_RECONNU", f"EPSG:{epsg_src} inconnu de PROJ")
        if crs and origine_crs == "fichier" and crs.get("epsg") is None and reproj:
            av("CRS_SANS_CODE_EPSG", "CRS du fichier sans code EPSG : transformation faite avec sa definition (WKT)")
        if not c["geometrie"]:
            av("COUCHE_SANS_GEOMETRIE", "couche sans geometrie : table d'attributs")

        nom_fichier = slug(c["_nom_brut"], deja) + ".geojson"
        dest = os.path.join(self.sortie, "couches", nom_fichier)
        self.statut("en_cours", etape="conversion", couche=nom_fichier)
        fsize = max(1024, min(octets_restants, self.lim.sortie_octets_max))
        ex = self.gdal.convertir(src["chemin"], src["pilote"], c["_nom_brut"], dest,
                                 limite_objets=self.lim.objets_max, fsize=fsize, delai_s=min(self.reste_s(), 90),
                                 epsg_source=epsg_src if origine_crs == "demande" else None, vers_wgs84=reproj)
        self.mesure("ogr2ogr:" + nom_fichier, ex)
        taille_sortie = os.path.getsize(dest) if os.path.exists(dest) else 0
        if taille_sortie >= fsize or ex.signal == 25 or "File too large" in ex.stderr:
            raise ErreurGeoconv("SORTIE_TROP_GROSSE", f"sortie superieure au plafond de {self.lim.sortie_octets_max} octets")
        err = classer_signal(ex, "conversion")
        if err:
            raise err
        if not ex.ok:
            msg = nettoyer(ex.stderr[-300:] or "erreur inconnue")
            if "out of memory" in ex.stderr.lower() or "cannot allocate" in ex.stderr.lower():
                raise ErreurGeoconv("MEMOIRE_EPUISEE", "memoire insuffisante pour la conversion : " + msg)
            if reproj:
                raise ErreurGeoconv("REPROJECTION_ECHEC", "conversion ou reprojection echouee : " + msg)
            raise ErreurGeoconv("CONVERSION_ECHEC", "conversion echouee : " + msg)
        if "not recognised" in ex.stderr.lower() or "not recognized" in ex.stderr.lower():
            raise ErreurGeoconv("ERREUR_INTERNE", "option de creation GDAL non reconnue : " + nettoyer(ex.stderr[-200:]))

        stats = analyse.analyser_geojson(dest)
        if stats["nb"] > self.lim.objets_max:
            os.unlink(dest)
            raise ErreurGeoconv("TROP_D_OBJETS", f"plus de {self.lim.objets_max} objets dans la couche", couche=nettoyer(c["nom"], 80))
        declare = c["nbObjets"]
        if isinstance(declare, int) and declare >= 0 and declare != stats["nb"]:
            av("COMPTE_DECLARE_DIVERGENT", f"le fichier declare {declare} objets, {stats['nb']} lus", declare=declare, lus=stats["nb"])
        if stats["non_finies"]:
            av("COORDONNEES_NON_FINIES", f"{stats['non_finies']} sommet(s) NaN ou infini(s) releve(s)", nb=stats["non_finies"])
        em = stats["emprise"]
        if (reproj or epsg_src == 4326) and em and (abs(em[0]) > 180 or abs(em[2]) > 180 or abs(em[1]) > 90 or abs(em[3]) > 90):
            av("COORDONNEES_HORS_PLAGE", "coordonnees WGS84 hors plage (longitude > 180 ou latitude > 90)")
        if stats["non_analysees"]:
            av("ANALYSE_GEOMETRIE_PARTIELLE", f"{stats['non_analysees']} objet(s) trop volumineux pour l'analyse", nb=stats["non_analysees"])
        if stats["nb"] == 0:
            av("COUCHE_VIDE", "couche sans aucun objet")

        # CRS de sortie : WGS84 seulement si le CRS source etait connu ; sinon null.
        crs_sortie = {"epsg": 4326, "nom": "WGS 84"} if (reproj or epsg_src == 4326) else None
        info = {
            "nom": nettoyer(c["nom"], 256), "fichier": "couches/" + nom_fichier, "octets": taille_sortie,
            "nbObjets": stats["nb"], "typesGeometrieReels": stats["types"], "sommets": stats["sommets"],
            "emprise": stats["emprise"], "crs": crs_sortie, "reprojete": reproj,
            "crsSource": ({"origine": origine_crs, "epsg": epsg_src,
                           "nom": crs.get("nom") if crs and origine_crs == "fichier" else None} if origine_crs else None),
            "coordonnees": "wgs84" if crs_sortie else "brutes",
            "avertissements": [a["code"] for a in avert_couche],
        }
        self.resultat_couches.append(info)
        # complete l'inventaire avec les mesures reelles
        for ic in self.inventaire["couches"]:
            if ic is c:
                ic["typesGeometrieReels"] = stats["types"]
                ic["empriseSortie"] = stats["emprise"]
                ic["sommets"] = stats["sommets"]
                ic["convertie"] = True
        return taille_sortie, stats["nb"]
