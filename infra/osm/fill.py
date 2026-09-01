"""Taux de remplissage et distributions d'une couche DBF, en flux."""
import sys, os
from collections import Counter
from shp import dbf_header

def scan(base, top_fields, encoding="utf-8", chunk=4000):
    hdr = dbf_header(base + ".dbf")
    names = [f[0] for f in hdr["fields"]]
    lens  = [f[2] for f in hdr["fields"]]
    filled = Counter()
    dist   = {f: Counter() for f in top_fields}
    n = hdr["n"]
    with open(base + ".dbf", "rb") as f:
        f.seek(hdr["hlen"])
        read = 0
        while read < n:
            batch = min(chunk, n - read)
            buf = f.read(hdr["rlen"] * batch)
            if not buf: break
            for r in range(batch):
                raw = buf[r*hdr["rlen"]:(r+1)*hdr["rlen"]]
                pos = 1
                for name, L in zip(names, lens):
                    v = raw[pos:pos+L]
                    pos += L
                    try: v = v.decode(encoding).strip()
                    except UnicodeDecodeError: v = v.decode("latin-1").strip()
                    if v:
                        filled[name] += 1
                        if name in dist: dist[name][v] += 1
            read += batch
    return hdr, n, filled, dist

if __name__ == "__main__":
    base = sys.argv[1]
    top  = sys.argv[2].split(",") if len(sys.argv) > 2 else []
    hdr, n, filled, dist = scan(base, top)
    print(f"{os.path.basename(base)} — {n:,} enregistrements".replace(",", " "))
    print(f"\n{'champ':<14}{'renseignes':>12}{'taux':>9}")
    print("-" * 35)
    for name, *_ in hdr["fields"]:
        c = filled[name]
        print(f"{name:<14}{c:>12,}{100*c/n:>8.1f}%".replace(",", " "))
    for fld in top:
        if fld not in dist: continue
        print(f"\n--- {fld} : {len(dist[fld])} valeurs distinctes ---")
        for v, c in dist[fld].most_common(15):
            print(f"   {c:>8,}  {v[:60]}".replace(",", " "))
