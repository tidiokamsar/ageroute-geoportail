"""Extrait la couche CHEMIN de l'extraction OSM (8 mars 2023) en WKT.

La Phase 4 n'a compare la BDRI qu'au reseau classe (ROUTE, 5 394 polylignes).
L'hypothese centrale de la Phase 5 est que le lot RES-* — 1 028 troncons
regionaux sans code metier, 2,5 % de recouvrement avec le reseau OSM classe —
pourrait correspondre au reseau de chemins/pistes (171 570 entites) que la
Phase 4 avait explicitement ecartes faute de question a leur sujet.

Cette extraction produit la table necessaire pour mesurer cette proximite.
Elle n'affirme rien : la mesure dira.

Coordonnees a 6 decimales (~11 cm) au lieu des 7 du reseau classe : les seuils
d'analyse sont de 25 a 250 m, et la couche fait 171 570 entites — le gain de
poids importe plus que le centimetre.

Sortie : CSV tabule  id, nature, source, wkt
Usage  : python extraire-chemin-wkt.py chemin/sans/extension chemin/sortie.tsv
"""
import struct, sys, os, csv
from shp import dbf_header


def iter_shp_wkt(path):
    with open(path, "rb") as f:
        f.seek(100)
        idx = 0
        while True:
            rh = f.read(8)
            if len(rh) < 8:
                break
            _, clen = struct.unpack(">II", rh)
            body = f.read(clen * 2)
            stype, = struct.unpack("<I", body[:4])
            if stype == 0:
                yield idx, None
                idx += 1
                continue
            nparts, npoints = struct.unpack("<II", body[36:44])
            off = 44 + nparts * 4
            parts = list(struct.unpack(f"<{nparts}I", body[44:off])) + [npoints]
            coords = struct.unpack(f"<{2*npoints}d", body[off:off + 16 * npoints])
            lignes = []
            for p in range(nparts):
                s, e = parts[p], parts[p + 1]
                pts = ", ".join(f"{coords[2*i]:.6f} {coords[2*i+1]:.6f}" for i in range(s, e))
                lignes.append(f"({pts})")
            wkt = f"MULTILINESTRING({', '.join(lignes)})" if nparts > 1 else f"LINESTRING{lignes[0]}"
            yield idx, wkt
            idx += 1


def iter_attrs(base):
    hdr = dbf_header(base + ".dbf")
    names = [f[0] for f in hdr["fields"]]
    lens = [f[2] for f in hdr["fields"]]
    pos = {n: (sum(lens[:i]) + 1, lens[i]) for i, n in enumerate(names)}
    with open(base + ".dbf", "rb") as f:
        f.seek(hdr["hlen"])
        for _ in range(hdr["n"]):
            raw = f.read(hdr["rlen"])
            if len(raw) < hdr["rlen"]:
                break

            def champ(n):
                p, L = pos[n]
                v = raw[p:p + L]
                try:
                    return v.decode("utf-8").strip()
                except UnicodeDecodeError:
                    return v.decode("latin-1").strip()
            yield {n: champ(n) for n in ("ID", "NATURE", "SOURCE")}


if __name__ == "__main__":
    base, sortie = sys.argv[1], sys.argv[2]
    n_lus = n_gardes = n_null = 0
    natures = {}
    with open(sortie, "w", newline="", encoding="utf-8") as out:
        w = csv.writer(out, delimiter="\t", quoting=csv.QUOTE_MINIMAL)
        for (i, wkt), a in zip(iter_shp_wkt(base + ".shp"), iter_attrs(base)):
            n_lus += 1
            if wkt is None:
                n_null += 1
                continue
            natures[a["NATURE"]] = natures.get(a["NATURE"], 0) + 1
            w.writerow([a["ID"], a["NATURE"], a["SOURCE"], wkt])
            n_gardes += 1
    print(f"{n_lus} lus, {n_gardes} retenus, {n_null} geometries nulles -> {sortie}")
    for n, c in sorted(natures.items(), key=lambda x: -x[1]):
        print(f"  {n}: {c}")
    print(f"taille : {os.path.getsize(sortie)/1e6:.1f} Mo")
