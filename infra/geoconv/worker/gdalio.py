"""Appels aux outils GDAL (ogrinfo, ogr2ogr, projinfo) et lecture de leurs resultats.

Tout passe par processus.lancer : arguments en liste, environnement explicite et minimal,
liste blanche de pilotes appliquee par GDAL_SKIP/OGR_SKIP ET par `-if` a chaque ouverture.
"""
import json
import os
import re
import shutil

import processus
from config import PILOTES_AUTORISES
from erreurs import ErreurGeoconv, nettoyer

_LIGNE_PILOTE = re.compile(r"^\s+(.+?) -([a-z, ]+)- \(([^)]*)\):")
TAILLE_JSON_MAX = 64 * 1024 * 1024


def _exe(nom):
    chemin = shutil.which(nom)
    if not chemin:
        raise ErreurGeoconv("ERREUR_INTERNE", f"outil GDAL introuvable : {nom}")
    return chemin


def classer_signal(ex, contexte):
    """Traduit une fin anormale d'un outil GDAL en erreur a code stable (ou None si fin normale)."""
    if ex.delai_depasse or ex.signal == 24:
        return ErreurGeoconv("DELAI_DEPASSE", f"{contexte} : delai ou temps CPU depasse", mesureMs=ex.duree_ms)
    if ex.signal == 25:
        return ErreurGeoconv("SORTIE_TROP_GROSSE", f"{contexte} : plafond de taille de fichier atteint")
    if ex.signal in (6, 9):
        return ErreurGeoconv("MEMOIRE_EPUISEE",
                             f"{contexte} : processus arrete (memoire epuisee ou allocation refusee), signal {ex.signal}",
                             picMemoireKo=ex.pic_memoire_ko)
    if ex.signal is not None:
        return ErreurGeoconv("GDAL_PLANTAGE", f"{contexte} : GDAL s'est arrete sur le signal {ex.signal}")
    return None


class Gdal:
    def __init__(self, config, tmp):
        self.config = config
        self.tmp = tmp
        self.exe_ogrinfo = _exe("ogrinfo")
        self.exe_ogr2ogr = _exe("ogr2ogr")
        self.exe_gdalinfo = _exe("gdalinfo")
        self.exe_projinfo = _exe("projinfo")
        self.exe_python = _exe("python3")
        self.skip = None
        self.version = None
        self.proj = None
        self.pilotes_installes = None
        self.pilotes_actifs = None

    # -- environnement des enfants -------------------------------------------------------
    def env(self, avec_skip=True):
        e = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": self.tmp,
            "LANG": "C.UTF-8",
            "CPL_TMPDIR": self.tmp,
            "GDAL_DRIVER_PATH": "disable",
            "GDAL_CACHEMAX": "128",
            "GDAL_NUM_THREADS": "1",
            "OGR_GPKG_NUM_THREADS": "1",
            "PROJ_NETWORK": "OFF",
            "SHAPE_RESTORE_SHX": "NO",
            "GDAL_HTTP_MAX_RETRY": "0",
            "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".none",
            "OGR_FORCE_ASCII": "NO",
        }
        if "LD_PRELOAD" in os.environ:
            e["LD_PRELOAD"] = os.environ["LD_PRELOAD"]
        if avec_skip and self.skip:
            e["GDAL_SKIP"] = self.skip  # couvre pilotes raster ET vecteur (verifie sur 3.13.3)
        return e

    def _run(self, args, stdout, delai_s, fsize=TAILLE_JSON_MAX, avec_skip=True, memoire=True):
        return processus.lancer(
            args, env=self.env(avec_skip), cwd=self.tmp, delai_s=delai_s, stdout_chemin=stdout,
            fsize_octets=fsize, as_octets=self.config.memoire_enfant_octets if memoire else 0,
            nofile=self.config.nofile_enfant,
        )

    # -- pilotes -------------------------------------------------------------------------
    def _formats(self, exe, sortie, avec_skip):
        ex = self._run([exe, "--formats"], sortie, 30, avec_skip=avec_skip, memoire=False)
        if not ex.ok:
            raise ErreurGeoconv("ERREUR_INTERNE", "impossible de lister les pilotes GDAL")
        noms = {}
        with open(sortie, encoding="utf-8", errors="replace") as f:
            for ligne in f:
                m = _LIGNE_PILOTE.match(ligne)
                if m:
                    noms[m.group(1)] = (m.group(2), m.group(3))
        return noms

    def initialiser(self):
        """Calcule GDAL_SKIP (complement de la liste blanche), releve les versions et
        verifie que seuls les pilotes autorises restent enregistres."""
        sortie = os.path.join(self.tmp, "init.out")
        v = self._run([self.exe_ogrinfo, "--version"], sortie, 30, avec_skip=False, memoire=False)
        m = re.match(r"GDAL (\S+)", open(sortie, encoding="utf-8", errors="replace").read())
        if not v.ok or not m:
            raise ErreurGeoconv("ERREUR_INTERNE", "version de GDAL illisible")
        self.version = m.group(1)
        pj = self._run([self.exe_python, "-E", "-s", "-c",
                        "from osgeo import osr;print('%d.%d.%d'%(osr.GetPROJVersionMajor(),osr.GetPROJVersionMinor(),osr.GetPROJVersionMicro()))"],
                       sortie, 30, avec_skip=False, memoire=False)
        self.proj = open(sortie, encoding="utf-8", errors="replace").read().strip() if pj.ok else None
        vect = self._formats(self.exe_ogrinfo, sortie, False)
        rast = self._formats(self.exe_gdalinfo, sortie, False)
        self.pilotes_installes = sorted(set(vect) | set(rast))
        absents = PILOTES_AUTORISES - set(self.pilotes_installes)
        if absents:
            raise ErreurGeoconv("PILOTES_NON_CONFORMES", "pilote(s) autorise(s) absent(s) de l'image : " + ", ".join(sorted(absents)))
        self.skip = ",".join(n for n in self.pilotes_installes if n not in PILOTES_AUTORISES)
        # Auto-verification : apres GDAL_SKIP, le registre doit etre EXACTEMENT la liste blanche.
        actifs = set(self._formats(self.exe_ogrinfo, sortie, True)) | set(self._formats(self.exe_gdalinfo, sortie, True))
        if actifs != set(PILOTES_AUTORISES):
            raise ErreurGeoconv("PILOTES_NON_CONFORMES",
                                "registre apres restriction different de la liste blanche : " + ", ".join(sorted(actifs)))
        self.pilotes_actifs = sorted(actifs)

    # -- ogrinfo -------------------------------------------------------------------------
    def ogrinfo_json(self, source, pilote, delai_s, options_ouverture=()):
        sortie = os.path.join(self.tmp, "ogrinfo.json")
        args = [self.exe_ogrinfo, "-json", "-ro", "-so", "-al", "-nomd", "-if", pilote]
        for o in options_ouverture:
            args += ["-oo", o]
        args.append(source)
        ex = self._run(args, sortie, delai_s)
        err = classer_signal(ex, "lecture du fichier")
        if err:
            raise err
        if not ex.ok:
            raise ErreurGeoconv("SOURCE_ILLISIBLE", "GDAL n'a pas pu lire le fichier : " + nettoyer(ex.stderr[-300:] or "erreur inconnue"))
        try:
            with open(sortie, "rb") as f:
                return json.loads(f.read()), ex
        except (ValueError, OSError):
            raise ErreurGeoconv("SOURCE_ILLISIBLE", "inventaire GDAL illisible")

    # -- projinfo ------------------------------------------------------------------------
    def epsg_connu(self, code):
        sortie = os.path.join(self.tmp, "projinfo.out")
        ex = self._run([self.exe_projinfo, "-q", "-o", "PROJJSON", f"EPSG:{int(code)}"], sortie, 20, memoire=False)
        if not ex.ok:
            return None
        try:
            with open(sortie, "rb") as f:
                return json.loads(f.read())
        except ValueError:
            return None

    # -- ogr2ogr -------------------------------------------------------------------------
    def convertir(self, source, pilote, couche, destination, *, limite_objets, fsize, delai_s,
                  epsg_source=None, vers_wgs84=False):
        args = [self.exe_ogr2ogr, "-f", "GeoJSON", "-lco", "RFC7946=NO", "-lco", "WRITE_NAME=NO",
                "-lco", "WRITE_BBOX=NO", "-limit", str(limite_objets + 1), "-if", pilote]
        if vers_wgs84:
            args += ["-lco", "COORDINATE_PRECISION=9"]
        if epsg_source is not None:
            args += ["-s_srs", f"EPSG:{int(epsg_source)}"]
        if vers_wgs84:
            args += ["-t_srs", "EPSG:4326"]
        # destination puis source puis nom de couche, tous passes en liste (aucun shell, aucune interpolation).
        args += [destination, source, couche]
        sortie = os.path.join(self.tmp, "ogr2ogr.out")
        return self._run(args, sortie, delai_s, fsize=fsize)
