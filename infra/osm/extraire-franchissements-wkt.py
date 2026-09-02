"""Extrait les franchissements de la couche ROUTE (P4 — ponts OSM x ouvrages BDRI).

FRANCHISST est le seul attribut riche reellement rempli de l'extraction OSM 2023 :
2 698 Pont, 441 Gue, 39 Tunnel. La BDRI ne reference que 126 ouvrages d'art —
le croisement de ces deux ensembles produit l'inventaire des ponts
POTENTIELLEMENT manquants, en propositions a valider (jamais d'import automatique,
regle Phase 5).

Sortie : CSV tabule  id, nature, numero, nom, franchissement, wkt
Usage  : python extraire-franchissements-wkt.py chemin/sans/extension sortie.tsv
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
    gardees = ("ID", "NATURE", "NUMERO", "NOM", "FRANCHISST")

    def champ(raw, n):
        p, L = pos[n]
        v = raw[p:p + L]
        try:
            return v.decode("utf-8").strip()
        except UnicodeDecodeError:
            return v.decode("latin-1").strip()

    with open(base + ".dbf", "rb") as f:
        f.seek(hdr["hlen"])
        for _ in range(hdr["n"]):
            raw = f.read(hdr["rlen"])
            if len(raw) < hdr["rlen"]:
                break
            yield {n: champ(raw, n) for n in gardees}


GARDES = {"Pont", "Gué", "Tunnel"}  # valeurs constatées dans FRANCHISST (mesure du 02/09/2026)

if __name__ == "__main__":
    base, sortie = sys.argv[1], sys.argv[2]
    n_lus = n_gardes = 0
    par_type = {}
    with open(sortie, "w", newline="", encoding="utf-8") as out:
        w = csv.writer(out, delimiter="\t", quoting=csv.QUOTE_MINIMAL)
        for (i, wkt), a in zip(iter_shp_wkt(base + ".shp"), iter_attrs(base)):
            n_lus += 1
            fr = a["FRANCHISST"]
            if wkt is None or fr not in GARDES:
                continue
            par_type[fr] = par_type.get(fr, 0) + 1
            numero = a["NUMERO"] if a["NUMERO"] not in ("", "NC") else ""
            nom = a["NOM"] if a["NOM"] not in ("", "NC") else ""
            w.writerow([a["ID"], a["NATURE"], numero, nom, fr, wkt])
            n_gardes += 1
    print(f"{n_lus} lus, {n_gardes} franchissements retenus -> {sortie}")
    for t, c in sorted(par_type.items(), key=lambda x: -x[1]):
        print(f"  {t}: {c}")
    print(f"taille : {os.path.getsize(sortie)/1e6:.1f} Mo")
