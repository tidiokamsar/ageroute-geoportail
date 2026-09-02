"""
P4-01 — Audit des couches SIG OSM fournies par AGEROUTE.

LECTURE SEULE. N'ecrit que des fichiers de synthese, ne touche ni la base ni la
production.

POURQUOI PAS GDAL

Ni GDAL ni pyshp ne sont installes sur le poste. Les formats SHP et DBF sont
documentes et simples ; ce module les lit directement, en flux, pour ne jamais
charger 315 Mo d'attributs en memoire.

CE QUE L'AUDIT MESURE, PAR COUCHE

    nombre d'objets, type geometrique, CRS, emprise
    champs et leurs types
    valeurs distinctes et taux de remplissage REEL
    longueur totale et par categorie
    geometries nulles, invalides, multipart
    doublons de geometrie
    dates et sources

LE PIEGE DE CE JEU

Le vide n'y est pas une chaine vide mais la valeur « NC » (non communique). Un
taux de remplissage naif annonce 100 % sur les quinze champs de ROUTE, dont
trois sont en realite entierement vides. Toutes les mesures ci-dessous excluent
« NC » explicitement.

Usage :
    python scripts/osm-audit/audit_osm.py <repertoire> [<repertoire de sortie>]
"""

import hashlib
import math
import os
import struct
import sys
from collections import Counter, defaultdict

TYPES_GEOM = {
    0: "Null", 1: "Point", 3: "PolyLine", 5: "Polygon", 8: "MultiPoint",
    11: "PointZ", 13: "PolyLineZ", 15: "PolygonZ", 18: "MultiPointZ",
    21: "PointM", 23: "PolyLineM", 25: "PolygonM", 28: "MultiPointM",
}

TYPES_CHAMP = {
    "C": "texte", "N": "numerique", "F": "flottant", "D": "date",
    "L": "booleen", "M": "memo",
}

# Valeurs qui signifient « non renseigne » dans ce jeu.
VIDES = {"", "NC", "N/C", "NULL", "-"}

RAYON_TERRE = 6371008.8  # metres


# ─────────────────────────────────────────────────────────────
# Lecture DBF
# ─────────────────────────────────────────────────────────────

def entete_dbf(chemin):
    with open(chemin, "rb") as f:
        h = f.read(32)
        _, yy, mm, dd, nrec, hlen, rlen = struct.unpack("<BBBBIHH", h[:12])
        champs = []
        while True:
            fd = f.read(32)
            if not fd or fd[0] == 0x0D:
                break
            nom = fd[:11].split(b"\0")[0].decode("latin-1").strip()
            champs.append({
                "nom": nom,
                "type": chr(fd[11]),
                "longueur": fd[16],
                "decimales": fd[17],
            })
        return {
            "n": nrec, "hlen": hlen, "rlen": rlen, "champs": champs,
            "date_maj": f"{1900 + yy}-{mm:02d}-{dd:02d}",
        }


def lire_dbf(chemin, hdr, encodage="utf-8", lot=4000):
    """Rend chaque enregistrement comme un dict, en flux."""
    noms = [c["nom"] for c in hdr["champs"]]
    longs = [c["longueur"] for c in hdr["champs"]]
    with open(chemin, "rb") as f:
        f.seek(hdr["hlen"])
        lus = 0
        while lus < hdr["n"]:
            n = min(lot, hdr["n"] - lus)
            tampon = f.read(hdr["rlen"] * n)
            if not tampon:
                break
            for r in range(n):
                brut = tampon[r * hdr["rlen"]:(r + 1) * hdr["rlen"]]
                if len(brut) < hdr["rlen"]:
                    break
                pos, rec = 1, {}
                for nom, L in zip(noms, longs):
                    v = brut[pos:pos + L]
                    pos += L
                    try:
                        rec[nom] = v.decode(encodage).strip()
                    except UnicodeDecodeError:
                        rec[nom] = v.decode("latin-1").strip()
                yield rec
            lus += n


# ─────────────────────────────────────────────────────────────
# Lecture SHP
# ─────────────────────────────────────────────────────────────

def entete_shp(chemin):
    with open(chemin, "rb") as f:
        h = f.read(100)
        _, stype = struct.unpack("<II", h[28:36])
        xmin, ymin, xmax, ymax = struct.unpack("<4d", h[36:68])
        return {"type": TYPES_GEOM.get(stype, f"?{stype}"),
                "bbox": (xmin, ymin, xmax, ymax)}


def longueur_polyligne(points):
    """Longueur en metres, haversine."""
    total = 0.0
    for i in range(1, len(points)):
        lon1, lat1 = points[i - 1]
        lon2, lat2 = points[i]
        p1, p2 = math.radians(lat1), math.radians(lat2)
        dp = p2 - p1
        dl = math.radians(lon2 - lon1)
        a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
        total += 2 * RAYON_TERRE * math.asin(math.sqrt(min(1.0, a)))
    return total


def lire_shp(chemin):
    """Rend (index, longueur_m, nb_points, nb_parties, empreinte) par objet.

    L'empreinte est un hachage des coordonnees arrondies au millionieme de degre
    (~0,1 m) : elle sert a detecter les doublons de geometrie, y compris entre
    deux couches.
    """
    with open(chemin, "rb") as f:
        f.seek(100)
        idx = 0
        while True:
            th = f.read(8)
            if len(th) < 8:
                break
            _, clen = struct.unpack(">II", th)
            corps = f.read(clen * 2)
            if len(corps) < 4:
                break
            stype, = struct.unpack("<I", corps[:4])
            if stype == 0:
                yield idx, 0.0, 0, 0, None
                idx += 1
                continue
            if stype not in (3, 5, 13, 15):  # polyligne / polygone
                yield idx, 0.0, 0, 0, None
                idx += 1
                continue
            nparties, npoints = struct.unpack("<II", corps[36:44])
            off = 44 + nparties * 4
            parties = list(struct.unpack(f"<{nparties}I", corps[44:off])) + [npoints]
            coords = struct.unpack(f"<{2 * npoints}d", corps[off:off + 16 * npoints])
            total = 0.0
            h = hashlib.blake2b(digest_size=16)
            for p in range(nparties):
                d, fin = parties[p], parties[p + 1]
                pts = [(coords[2 * i], coords[2 * i + 1]) for i in range(d, fin)]
                total += longueur_polyligne(pts)
                for x, y in pts:
                    h.update(struct.pack("<ii", round(x * 1e6), round(y * 1e6)))
            yield idx, total, npoints, nparties, h.digest()
            idx += 1


def crs_depuis_prj(chemin):
    try:
        with open(chemin, encoding="utf-8", errors="replace") as f:
            t = f.read()
    except OSError:
        return "absent", None
    nom = t.split('"')[1] if '"' in t else t[:40]
    # WGS 84 se reconnait au datum, le fichier ne portant pas de code EPSG.
    epsg = "4326 (déduit du datum WGS_1984)" if "WGS_1984" in t else "non déterminé"
    return nom, epsg


# ─────────────────────────────────────────────────────────────
# Audit d'une couche
# ─────────────────────────────────────────────────────────────

def auditer(base, champ_categorie=None):
    nom = os.path.basename(base)
    sh = entete_shp(base + ".shp")
    hdr = entete_dbf(base + ".dbf")
    crs_nom, crs_epsg = crs_depuis_prj(base + ".prj")

    try:
        with open(base + ".cpg", encoding="ascii") as f:
            encodage = f.read().strip() or "utf-8"
    except OSError:
        encodage = "latin-1"

    # Attributs : remplissage reel et valeurs distinctes.
    noms = [c["nom"] for c in hdr["champs"]]
    rempli = Counter()
    distinct = {n: set() for n in noms}
    trop_distinct = set()
    categories = []

    for rec in lire_dbf(base + ".dbf", hdr, encodage):
        for n in noms:
            v = rec[n]
            if v.upper() not in VIDES:
                rempli[n] += 1
                if n not in trop_distinct:
                    distinct[n].add(v)
                    # Au-dela de 2 000 valeurs, on cesse de collecter : le champ
                    # est manifestement un identifiant ou un texte libre.
                    if len(distinct[n]) > 2000:
                        trop_distinct.add(n)
                        distinct[n] = set()
        categories.append(rec.get(champ_categorie, "") if champ_categorie else "")

    # Geometries : longueur, validite, doublons.
    km_cat = defaultdict(float)
    n_cat = Counter()
    pts_cat = Counter()
    nulles = vides = multipart = 0
    empreintes = Counter()
    km_total = 0.0
    i = 0
    for idx, longueur, npts, nparties, emp in lire_shp(base + ".shp"):
        cat = categories[idx] if idx < len(categories) else ""
        if emp is None:
            nulles += 1
        else:
            empreintes[emp] += 1
            if npts < 2:
                vides += 1
            if nparties > 1:
                multipart += 1
        km_total += longueur / 1000.0
        km_cat[cat] += longueur / 1000.0
        n_cat[cat] += 1
        pts_cat[cat] += npts
        i += 1

    doublons = sum(c - 1 for c in empreintes.values() if c > 1)

    return {
        "nom": nom, "objets": hdr["n"], "objets_shp": i,
        "geometrie": sh["type"], "bbox": sh["bbox"],
        "crs_nom": crs_nom, "crs_epsg": crs_epsg, "encodage": encodage,
        "date_dbf": hdr["date_maj"], "champs": hdr["champs"],
        "rempli": rempli, "distinct": distinct, "trop_distinct": trop_distinct,
        "km_total": km_total, "km_cat": km_cat, "n_cat": n_cat, "pts_cat": pts_cat,
        "nulles": nulles, "degenerees": vides, "multipart": multipart,
        "doublons": doublons, "empreintes": empreintes,
    }


def formater(n):
    return f"{n:,}".replace(",", " ")


def rapport(a, champ_categorie):
    print(f"\n{'=' * 74}\n{a['nom']}\n{'=' * 74}")
    print(f"  objets (DBF / SHP) : {formater(a['objets'])} / {formater(a['objets_shp'])}")
    print(f"  geometrie          : {a['geometrie']}")
    print(f"  CRS                : {a['crs_nom']} — EPSG {a['crs_epsg']}")
    print(f"  encodage           : {a['encodage']}")
    print(f"  date du DBF        : {a['date_dbf']}")
    x0, y0, x1, y1 = a["bbox"]
    print(f"  emprise            : lon {x0:.4f} a {x1:.4f} | lat {y0:.4f} a {y1:.4f}")
    print(f"  longueur totale    : {a['km_total']:,.0f} km".replace(",", " "))
    print(f"  geometries nulles  : {a['nulles']}")
    print(f"  moins de 2 points  : {a['degenerees']}")
    print(f"  multipart          : {formater(a['multipart'])}")
    print(f"  doublons de geom.  : {formater(a['doublons'])}")

    print(f"\n  champs ({len(a['champs'])}) — remplissage REEL (« NC » exclu) :")
    print(f"      {'champ':<14}{'type':<12}{'renseignes':>12}{'taux':>8}  valeurs distinctes")
    for c in a["champs"]:
        n = a["rempli"][c["nom"]]
        taux = 100 * n / a["objets"] if a["objets"] else 0
        d = "> 2000" if c["nom"] in a["trop_distinct"] else str(len(a["distinct"][c["nom"]]))
        t = f"{TYPES_CHAMP.get(c['type'], c['type'])}({c['longueur']})"
        print(f"      {c['nom']:<14}{t:<12}{formater(n):>12}{taux:>7.1f}%  {d}")

    if champ_categorie:
        print(f"\n  longueur par {champ_categorie} :")
        print(f"      {'valeur':<28}{'objets':>9}{'km':>11}{'pts/km':>9}")
        for cat, km in sorted(a["km_cat"].items(), key=lambda x: -x[1]):
            n = a["n_cat"][cat]
            d = a["pts_cat"][cat] / km if km else 0
            libelle = (cat or "(vide)")[:27]
            print(f"      {libelle:<28}{formater(n):>9}{km:>11,.0f}{d:>9.1f}".replace(",", " "))


def ecrire_csv(audits, sortie):
    os.makedirs(sortie, exist_ok=True)

    with open(os.path.join(sortie, "osm_inventory.csv"), "w", encoding="utf-8") as f:
        f.write("couche;objets;geometrie;crs;emprise_lon_min;emprise_lat_min;"
                "emprise_lon_max;emprise_lat_max;km_total;geom_nulles;geom_degenerees;"
                "multipart;doublons_geom;nb_champs;date_dbf\n")
        for a in audits:
            x0, y0, x1, y1 = a["bbox"]
            f.write(f"{a['nom']};{a['objets']};{a['geometrie']};{a['crs_epsg']};"
                    f"{x0:.6f};{y0:.6f};{x1:.6f};{y1:.6f};{a['km_total']:.1f};"
                    f"{a['nulles']};{a['degenerees']};{a['multipart']};{a['doublons']};"
                    f"{len(a['champs'])};{a['date_dbf']}\n")

    with open(os.path.join(sortie, "osm_categories.csv"), "w", encoding="utf-8") as f:
        f.write("couche;categorie;objets;km;points_par_km\n")
        for a in audits:
            for cat, km in sorted(a["km_cat"].items(), key=lambda x: -x[1]):
                n = a["n_cat"][cat]
                d = a["pts_cat"][cat] / km if km else 0
                f.write(f"{a['nom']};{cat or '(vide)'};{n};{km:.1f};{d:.1f}\n")

    with open(os.path.join(sortie, "osm_champs.csv"), "w", encoding="utf-8") as f:
        f.write("couche;champ;type;longueur;renseignes;taux_pct;valeurs_distinctes\n")
        for a in audits:
            for c in a["champs"]:
                n = a["rempli"][c["nom"]]
                taux = 100 * n / a["objets"] if a["objets"] else 0
                d = ">2000" if c["nom"] in a["trop_distinct"] else len(a["distinct"][c["nom"]])
                f.write(f"{a['nom']};{c['nom']};{TYPES_CHAMP.get(c['type'], c['type'])};"
                        f"{c['longueur']};{n};{taux:.1f};{d}\n")
    print(f"\nCSV ecrits dans {sortie}")


def recouvrement(a1, a2):
    """Combien des geometries de a2 sont deja presentes dans a1, a l'identique."""
    communes = set(a1["empreintes"]) & set(a2["empreintes"])
    n = sum(a2["empreintes"][e] for e in communes)
    return len(communes), n


if __name__ == "__main__":
    rep = sys.argv[1]
    sortie = sys.argv[2] if len(sys.argv) > 2 else "docs/phase4-voirie/donnees"

    couches = [("ROUTE", "NATURE"), ("CHEMIN", "NATURE"),
               ("SURFACE_ROUTE", "NATURE"), ("TOPONYME_COMMUNICATION", "NATURE")]
    audits = []
    for nom, champ in couches:
        base = os.path.join(rep, nom)
        if not os.path.exists(base + ".shp"):
            print(f"\n{nom} : SHP absent")
            continue
        if not os.path.exists(base + ".dbf"):
            print(f"\n{nom} : DBF ABSENT — attributs indisponibles")
            continue
        a = auditer(base, champ)
        audits.append(a)
        rapport(a, champ)

    par_nom = {a["nom"]: a for a in audits}
    if "ROUTE" in par_nom and "CHEMIN" in par_nom:
        print(f"\n{'=' * 74}\nCHEMIN est-il un sous-ensemble de ROUTE ?\n{'=' * 74}")
        d, n = recouvrement(par_nom["ROUTE"], par_nom["CHEMIN"])
        tot = par_nom["CHEMIN"]["objets"]
        print(f"  geometries de CHEMIN retrouvees a l'identique dans ROUTE : "
              f"{formater(n)} / {formater(tot)} ({100 * n / tot:.1f} %)")

    ecrire_csv(audits, sortie)
