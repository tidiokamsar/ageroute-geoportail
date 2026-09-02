"""Extrait le reseau classe OSM en WKT, pour un chargement PostGIS sans GDAL.

Ne retient que les natures comparables au reseau BDRI : voie rapide, primaire,
secondaire, tertiaire. Les 171 525 chemins et les 41 083 non classifiees sont
exclus — ce sont eux qui font les 180 000 km de la couche, et ils n'ont pas
d'equivalent dans un referentiel de routes classees.

Sortie : CSV tabule  id, nature, numero, nom, wkt
"""
import struct, sys, os, csv
from shp import dbf_header

NATURES = {"Voie rapide", "Route primaire", "Route secondaire", "Route tertiaire"}

def iter_shp_wkt(path):
    with open(path, "rb") as f:
        f.seek(100)
        idx = 0
        while True:
            rh = f.read(8)
            if len(rh) < 8: break
            _, clen = struct.unpack(">II", rh)
            body = f.read(clen * 2)
            stype, = struct.unpack("<I", body[:4])
            if stype == 0:
                yield idx, None; idx += 1; continue
            nparts, npoints = struct.unpack("<II", body[36:44])
            off = 44 + nparts * 4
            parts = list(struct.unpack(f"<{nparts}I", body[44:off])) + [npoints]
            coords = struct.unpack(f"<{2*npoints}d", body[off:off + 16 * npoints])
            lignes = []
            for p in range(nparts):
                s, e = parts[p], parts[p + 1]
                pts = ", ".join(f"{coords[2*i]:.7f} {coords[2*i+1]:.7f}" for i in range(s, e))
                lignes.append(f"({pts})")
            wkt = f"MULTILINESTRING({', '.join(lignes)})" if nparts > 1 else f"LINESTRING{lignes[0]}"
            yield idx, wkt
            idx += 1

def iter_attrs(base):
    hdr = dbf_header(base + ".dbf")
    names = [f[0] for f in hdr["fields"]]; lens = [f[2] for f in hdr["fields"]]
    pos = {n: (sum(lens[:i]) + 1, lens[i]) for i, n in enumerate(names)}
    with open(base + ".dbf", "rb") as f:
        f.seek(hdr["hlen"])
        for _ in range(hdr["n"]):
            raw = f.read(hdr["rlen"])
            if len(raw) < hdr["rlen"]: break
            def champ(n):
                p, L = pos[n]; v = raw[p:p + L]
                try: return v.decode("utf-8").strip()
                except UnicodeDecodeError: return v.decode("latin-1").strip()
            yield {n: champ(n) for n in ("ID", "NATURE", "NUMERO", "NOM")}

if __name__ == "__main__":
    base, sortie = sys.argv[1], sys.argv[2]
    n_lus = n_gardes = 0
    with open(sortie, "w", newline="", encoding="utf-8") as out:
        w = csv.writer(out, delimiter="\t", quoting=csv.QUOTE_MINIMAL)
        for (i, wkt), a in zip(iter_shp_wkt(base + ".shp"), iter_attrs(base)):
            n_lus += 1
            if wkt is None or a["NATURE"] not in NATURES: continue
            w.writerow([a["ID"], a["NATURE"], a["NUMERO"], a["NOM"], wkt])
            n_gardes += 1
    print(f"{n_lus} lus, {n_gardes} retenus (reseau classe) -> {sortie}")
    print(f"taille : {os.path.getsize(sortie)/1e6:.1f} Mo")
