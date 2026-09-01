"""Longueur par NATURE de la couche ROUTE, et liste des NUMERO.
Lit les polylignes du .shp et les attributs du .dbf en parallele (meme ordre)."""
import struct, math, sys, os
from collections import Counter, defaultdict
from shp import dbf_header

R = 6371008.8  # rayon terrestre moyen, metres

def seg_len(pts):
    """Longueur d'une polyligne en metres (haversine)."""
    tot = 0.0
    for i in range(1, len(pts)):
        lon1, lat1 = pts[i-1]; lon2, lat2 = pts[i]
        p1 = math.radians(lat1); p2 = math.radians(lat2)
        dp = p2 - p1; dl = math.radians(lon2 - lon1)
        a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
        tot += 2 * R * math.asin(math.sqrt(a))
    return tot

def iter_shp(path):
    """Rend (index, longueur_m, n_points) pour chaque polyligne."""
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
                yield idx, 0.0, 0; idx += 1; continue
            nparts, npoints = struct.unpack("<II", body[36:44])
            off = 44 + nparts*4
            parts = list(struct.unpack(f"<{nparts}I", body[44:off])) + [npoints]
            coords = struct.unpack(f"<{2*npoints}d", body[off:off+16*npoints])
            total = 0.0
            for p in range(nparts):
                s, e = parts[p], parts[p+1]
                pts = [(coords[2*i], coords[2*i+1]) for i in range(s, e)]
                total += seg_len(pts)
            yield idx, total, npoints
            idx += 1

def attrs(base, wanted):
    hdr = dbf_header(base + ".dbf")
    names = [f[0] for f in hdr["fields"]]; lens = [f[2] for f in hdr["fields"]]
    keep = {n: (sum(lens[:i])+1, lens[i]) for i, n in enumerate(names) if n in wanted}
    with open(base + ".dbf", "rb") as f:
        f.seek(hdr["hlen"])
        for _ in range(hdr["n"]):
            raw = f.read(hdr["rlen"])
            if len(raw) < hdr["rlen"]: break
            out = {}
            for n, (pos, L) in keep.items():
                v = raw[pos:pos+L]
                try: v = v.decode("utf-8").strip()
                except UnicodeDecodeError: v = v.decode("latin-1").strip()
                out[n] = v
            yield out

if __name__ == "__main__":
    base = sys.argv[1]
    km_by_nature = Counter(); n_by_nature = Counter()
    pts_by_nature = Counter()
    km_by_numero = Counter()
    numeros = Counter()
    for (i, length, np_), a in zip(iter_shp(base + ".shp"), attrs(base, {"NATURE","NUMERO","NOM"})):
        nat = a["NATURE"]; num = a["NUMERO"]
        km_by_nature[nat] += length/1000.0
        n_by_nature[nat] += 1
        pts_by_nature[nat] += np_
        if num != "NC":
            numeros[num] += 1
            km_by_numero[num] += length/1000.0

    print(f"{'NATURE':<28}{'segments':>10}{'km':>12}{'pts/km':>9}")
    print("-"*59)
    tot_km = 0; tot_n = 0
    for nat, km in km_by_nature.most_common():
        n = n_by_nature[nat]; d = pts_by_nature[nat]/km if km else 0
        print(f"{nat[:27]:<28}{n:>10,}{km:>12,.0f}{d:>9.1f}".replace(",", " "))
        tot_km += km; tot_n += n
    print("-"*59)
    print(f"{'TOTAL':<28}{tot_n:>10,}{tot_km:>12,.0f}".replace(",", " "))

    print(f"\n\nNUMERO renseigne : {sum(numeros.values()):,} segments, "
          f"{len(numeros)} designations, {sum(km_by_numero.values()):,.0f} km".replace(",", " "))
    print(f"\n{'NUMERO':<10}{'segments':>10}{'km':>10}")
    print("-"*30)
    for num, km in sorted(km_by_numero.items(), key=lambda x: -x[1]):
        print(f"{num:<10}{numeros[num]:>10}{km:>10,.0f}".replace(",", " "))
