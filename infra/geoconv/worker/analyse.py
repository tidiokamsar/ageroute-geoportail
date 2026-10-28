"""Analyse en flux du GeoJSON ECRIT PAR GDAL (une Feature par ligne) et lecture du CRS.

Ce module ne CONTROLE pas la geometrie (c'est le travail du backend) : il compte et signale
de quoi eclairer le backend (types reels, sommets, valeurs non finies, plages de coordonnees).
La lecture se fait ligne par ligne avec une borne : une ligne trop longue est comptee mais
non analysee, pour ne jamais charger un objet de plusieurs dizaines de Mo en memoire.
"""
import json
import math

LIGNE_MAX = 16 * 1024 * 1024
DEBUT_FEATURES = (b'{"type":"Feature"', b'{ "type": "Feature"')  # GeoJSON compact (RFC7946=NO) ou indente


def _parcourir(coords, etat):
    """Parcourt iterativement un tableau de coordonnees GeoJSON ; met a jour etat."""
    pile = [coords]
    while pile:
        c = pile.pop()
        if not c:
            continue
        if isinstance(c[0], (int, float)):
            etat["sommets"] += 1
            x = c[0]
            y = c[1] if len(c) > 1 else None
            if not isinstance(y, (int, float)) or not math.isfinite(x) or not math.isfinite(y):
                etat["non_finies"] += 1
                continue
            b = etat["bbox"]
            if x < b[0]:
                b[0] = x
            if y < b[1]:
                b[1] = y
            if x > b[2]:
                b[2] = x
            if y > b[3]:
                b[3] = y
        else:
            pile.extend(c)


def analyser_geojson(chemin):
    types = {}
    etat = {"sommets": 0, "non_finies": 0, "bbox": [math.inf, math.inf, -math.inf, -math.inf]}
    nb = 0
    non_analysees = 0
    sans_geometrie = 0
    with open(chemin, "rb") as f:
        while True:
            ligne = f.readline(LIGNE_MAX)
            if not ligne:
                break
            trop_longue = not ligne.endswith(b"\n") and len(ligne) >= LIGNE_MAX
            if trop_longue:
                while True:  # consomme le reste de la ligne sans la conserver
                    reste = f.readline(LIGNE_MAX)
                    if not reste or reste.endswith(b"\n"):
                        break
            if not ligne.startswith(DEBUT_FEATURES):
                continue
            nb += 1
            if trop_longue:
                non_analysees += 1
                continue
            texte = ligne.strip()
            if texte.endswith(b","):
                texte = texte[:-1]
            try:
                feat = json.loads(texte)
            except ValueError:
                non_analysees += 1
                continue
            geom = feat.get("geometry") if isinstance(feat, dict) else None
            if not geom:
                sans_geometrie += 1
                types["null"] = types.get("null", 0) + 1
                continue
            t = geom.get("type", "inconnu")
            types[t] = types.get(t, 0) + 1
            if t == "GeometryCollection":
                for g in geom.get("geometries") or []:
                    _parcourir(g.get("coordinates") or [], etat)
            else:
                _parcourir(geom.get("coordinates") or [], etat)
    b = etat["bbox"]
    emprise = [b[0], b[1], b[2], b[3]] if b[0] != math.inf else None
    return {"nb": nb, "types": types, "sommets": etat["sommets"], "non_finies": etat["non_finies"],
            "emprise": emprise, "non_analysees": non_analysees, "sans_geometrie": sans_geometrie}


def _unite(proj):
    try:
        ax = proj["coordinate_system"]["axis"][0]
        u = ax.get("unit")
        if isinstance(u, dict):
            return {"nom": u.get("name"), "facteur": u.get("conversion_factor")}
        if isinstance(u, str):
            return {"nom": u, "facteur": 1.0}
    except (KeyError, IndexError, TypeError, AttributeError):
        pass
    return None


def lire_crs(couche_json):
    """CRS TEL QUE DECLARE par le fichier : None si le fichier n'en declare pas.
    Retourne dict {epsg, autorite, nom, type, unite, wkt}."""
    champs = couche_json.get("geometryFields") or []
    cs = champs[0].get("coordinateSystem") if champs else None
    if not cs:
        return None
    wkt = cs.get("wkt")
    proj = cs.get("projjson") if isinstance(cs.get("projjson"), dict) else None
    if not wkt and not proj:
        return None
    ident = (proj or {}).get("id") or {}
    code = ident.get("code")
    return {
        "autorite": ident.get("authority"),
        "epsg": int(code) if ident.get("authority") == "EPSG" and isinstance(code, int) else None,
        "nom": (proj or {}).get("name"),
        "type": (proj or {}).get("type"),
        "unite": _unite(proj) if proj else None,
        "wkt": (wkt[:6000] if isinstance(wkt, str) else None),
    }
