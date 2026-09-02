"""
P4-05 — Que pèserait la voirie locale servie en GeoJSON, selon l'échelle ?

La question qui tranche l'architecture d'affichage : un GeoJSON cadré sur la vue
suffit-il, ou faut-il des tuiles vectorielles ?

Mesure sur le TSV produit par shp_vers_tsv.py, sans base ni serveur. Le coût par
sommet vient de la production : 2 831 458 octets pour 124 090 sommets, soit
22,8 octets/sommet une fois sérialisé en GeoJSON.

Usage :
    python scripts/osm-comparison/poids_par_emprise.py <osm_route.tsv>
"""

import sys

# Mesure sur https://carte.ageroute.gov.gn/api/public/carte/geo
OCTETS_PAR_SOMMET = 22.8
RATIO_GZIP = 875968 / 2831458  # mesuré sur la même réponse

# Emprises de référence, centrées sur Conakry — la zone la plus dense du pays,
# donc le cas défavorable.
EMPRISES = [
    ("Pays entier",        -15.10, 7.15, -7.60, 12.75),
    ("Région (Conakry+)",  -13.80, 9.40, -13.20, 9.80),
    ("Ville (Conakry)",    -13.75, 9.48, -13.55, 9.65),
    ("Commune (Matoto)",   -13.62, 9.55, -13.56, 9.61),
    ("Quartier",           -13.60, 9.57, -13.57, 9.60),
]


def sommets_et_emprise(wkt):
    """Nombre de sommets et bbox d'un LINESTRING, sans le parser entièrement."""
    d = wkt.find("(")
    if d < 0:
        return 0, None
    corps = wkt[d + 1:wkt.rfind(")")]
    xs = []
    ys = []
    n = 0
    for couple in corps.split(","):
        p = couple.split()
        if len(p) != 2:
            continue
        xs.append(float(p[0]))
        ys.append(float(p[1]))
        n += 1
    if not xs:
        return 0, None
    return n, (min(xs), min(ys), max(xs), max(ys))


def intersecte(b, e):
    return not (b[2] < e[0] or b[0] > e[2] or b[3] < e[1] or b[1] > e[3])


def main(chemin):
    stats = {nom: [0, 0] for nom, *_ in EMPRISES}  # [objets, sommets]
    total_obj = total_pts = 0

    with open(chemin, encoding="utf-8") as f:
        for ligne in f:
            parts = ligne.rstrip("\n").split("\t")
            if len(parts) < 7:
                continue
            n, bbox = sommets_et_emprise(parts[6])
            if bbox is None:
                continue
            total_obj += 1
            total_pts += n
            for nom, x0, y0, x1, y1 in EMPRISES:
                if intersecte(bbox, (x0, y0, x1, y1)):
                    stats[nom][0] += 1
                    stats[nom][1] += n

    print(f"{'emprise':<22}{'objets':>10}{'sommets':>12}{'GeoJSON':>12}{'gzippé':>11}")
    print("-" * 67)
    for nom, *_ in EMPRISES:
        obj, pts = stats[nom]
        brut = pts * OCTETS_PAR_SOMMET
        gz = brut * RATIO_GZIP
        u = lambda v: f"{v/1e6:.1f} Mo" if v >= 1e6 else f"{v/1e3:.0f} Ko"
        print(f"{nom:<22}{obj:>10,}{pts:>12,}{u(brut):>12}{u(gz):>11}".replace(",", " "))
    print("-" * 67)
    print(f"{'(total du jeu)':<22}{total_obj:>10,}{total_pts:>12,}".replace(",", " "))


if __name__ == "__main__":
    main(sys.argv[1])
