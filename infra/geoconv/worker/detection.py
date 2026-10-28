"""Detection du format PAR LE CONTENU (jamais par l'extension seule).

Trois familles seulement sont reconnues pour l'entree : GeoPackage (SQLite avec identifiant
d'application GeoPackage), ZIP (qui doit contenir un Shapefile) et DXF (texte ou binaire).
Tout le reste est refuse, avec une indication de ce que le contenu semble etre.
"""
import re
import struct

from erreurs import ErreurGeoconv

# Identifiants d'application SQLite d'un GeoPackage (octets 68 a 71 de l'en-tete).
APP_ID_GPKG = {0x47504B47: "GPKG (1.2 et suivants)", 0x47503130: "GP10", 0x47503131: "GP11"}
EN_TETE_SQLITE = b"SQLite format 3\x00"
DXF_BINAIRE = b"AutoCAD Binary DXF\r\n\x1a\x00"


def _paires_dxf(texte, maxi=12):
    lignes = texte.splitlines()
    paires = []
    for i in range(0, min(len(lignes) - 1, maxi * 2), 2):
        paires.append((lignes[i].strip(), lignes[i + 1].strip()))
    return paires


def _ressemble_a(debut):
    d = debut.lstrip(b"\xef\xbb\xbf \t\r\n")[:512].lower()
    if d.startswith((b"<!doctype html", b"<html", b"<head", b"<body")):
        return "HTML"
    if debut.startswith(b"%PDF"):
        return "PDF"
    if debut[:2] == b"MZ":
        return "executable Windows"
    if debut[:4] == b"\x7fELF":
        return "executable Linux"
    if d.startswith((b"<?xml", b"<kml", b"<gpx", b"<gml")):
        return "XML (KML, GPX ou GML : non pris en charge par cette chaine)"
    if d.startswith((b"{", b"[")):
        return "JSON (GeoJSON : non pris en charge par cette chaine)"
    if debut[:3] == b"\xff\xd8\xff" or debut[:8] == b"\x89PNG\r\n\x1a\n":
        return "image"
    if b"\x00" in debut[:512]:
        return "binaire inconnu"
    return "texte inconnu"


def detecter(chemin, taille):
    """Retourne 'GPKG', 'ZIP' ou 'DXF' ; leve ErreurGeoconv sinon."""
    if taille == 0:
        raise ErreurGeoconv("FICHIER_VIDE", "fichier de 0 octet")
    with open(chemin, "rb") as f:
        debut = f.read(65536)
    if debut.startswith(b"PK\x03\x04") or debut.startswith(b"PK\x05\x06"):
        return "ZIP"
    if debut.startswith(EN_TETE_SQLITE):
        if len(debut) < 100:
            raise ErreurGeoconv("FICHIER_TRONQUE", "en-tete SQLite incomplet")
        app_id = struct.unpack(">I", debut[68:72])[0]
        if app_id not in APP_ID_GPKG:
            raise ErreurGeoconv("FORMAT_NON_AUTORISE",
                                "base SQLite qui n'est pas un GeoPackage (SQLite/Spatialite non autorises)")
        _controle_gpkg(debut, taille)
        return "GPKG"
    if debut.startswith(DXF_BINAIRE):
        return "DXF"
    if b"\x00" not in debut[:4096]:
        try:
            texte = debut.decode("utf-8-sig")
        except UnicodeDecodeError:
            texte = debut.decode("latin-1")
        paires = [p for p in _paires_dxf(texte) if p[0] != "999"]
        if len(paires) >= 2 and paires[0] == ("0", "SECTION") and paires[1][0] == "2" \
                and re.match(r"^[A-Z]+$", paires[1][1] or ""):
            return "DXF"
    raise ErreurGeoconv("FORMAT_NON_RECONNU",
                        "contenu non reconnu comme GeoPackage, ZIP (Shapefile) ou DXF : " + _ressemble_a(debut))


def _controle_gpkg(entete, taille):
    """Un GeoPackage tronque est refuse avant d'ouvrir SQLite (taille declaree par l'en-tete)."""
    taille_page = struct.unpack(">H", entete[16:18])[0]
    taille_page = 65536 if taille_page == 1 else taille_page
    if taille_page < 512 or taille_page > 65536 or taille_page & (taille_page - 1):
        raise ErreurGeoconv("FICHIER_INVALIDE", "taille de page SQLite aberrante")
    compteur = struct.unpack(">I", entete[24:28])[0]
    nb_pages = struct.unpack(">I", entete[28:32])[0]
    valide_pour = struct.unpack(">I", entete[92:96])[0]
    if nb_pages > 0 and valide_pour == compteur and taille < nb_pages * taille_page:
        raise ErreurGeoconv("FICHIER_TRONQUE",
                            f"GeoPackage tronque : {taille} octets lus, {nb_pages * taille_page} attendus")
    if taille % taille_page != 0:
        raise ErreurGeoconv("FICHIER_TRONQUE", "taille du fichier non multiple de la taille de page SQLite")


def unites_dxf(chemin, octets_max=8 * 1024 * 1024):
    """Lit $INSUNITS dans l'en-tete d'un DXF ASCII (lecture bornee). Retourne {code, nom} ou None."""
    codes = {0: "sans unite", 1: "pouces", 2: "pieds", 3: "miles", 4: "millimetres", 5: "centimetres",
             6: "metres", 7: "kilometres", 8: "micropouces", 9: "mils", 10: "yards", 11: "angstroms",
             12: "nanometres", 13: "microns", 14: "decimetres"}
    lu = 0
    try:
        with open(chemin, "rb") as f:
            prec = None
            while lu < octets_max:
                a = f.readline(4096)
                b = f.readline(4096)
                if not b:
                    return None
                lu += len(a) + len(b)
                code, val = a.strip(), b.strip()
                if prec == b"$INSUNITS" and code == b"70":
                    try:
                        n = int(val)
                    except ValueError:
                        return None
                    return {"code": n, "nom": codes.get(n, "code non repertorie")}
                prec = val if code == b"9" else None
                if code == b"0" and val == b"ENDSEC":
                    return None
    except OSError:
        return None
    return None
