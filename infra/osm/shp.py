"""Lecteur minimal DBF/SHP — en-tetes et echantillons seulement, sans charger le fichier."""
import struct, sys, os

SHAPE_TYPES = {0:"Null",1:"Point",3:"PolyLine",5:"Polygon",8:"MultiPoint",
               11:"PointZ",13:"PolyLineZ",15:"PolygonZ",18:"MultiPointZ",
               21:"PointM",23:"PolyLineM",25:"PolygonM",28:"MultiPointM"}

def dbf_header(path):
    with open(path,"rb") as f:
        h = f.read(32)
        version, yy, mm, dd, nrec, hlen, rlen = struct.unpack("<BBBBIHH", h[:12])
        fields = []
        while True:
            fd = f.read(32)
            if not fd or fd[0] == 0x0D: break
            name = fd[:11].split(b"\0")[0].decode("latin-1").strip()
            ftype = chr(fd[11]); flen = fd[16]; fdec = fd[17]
            fields.append((name, ftype, flen, fdec))
        return {"n": nrec, "hlen": hlen, "rlen": rlen, "fields": fields,
                "date": f"{1900+yy}-{mm:02d}-{dd:02d}"}

def dbf_records(path, hdr, indices, encoding="utf-8"):
    out = []
    with open(path,"rb") as f:
        for i in indices:
            if i >= hdr["n"]: continue
            f.seek(hdr["hlen"] + i*hdr["rlen"])
            raw = f.read(hdr["rlen"])
            if not raw or len(raw) < hdr["rlen"]: continue
            pos = 1  # premier octet = marqueur de suppression
            rec = {}
            for name, ftype, flen, fdec in hdr["fields"]:
                val = raw[pos:pos+flen]
                try: val = val.decode(encoding).strip()
                except UnicodeDecodeError: val = val.decode("latin-1").strip()
                rec[name] = val
                pos += flen
            out.append(rec)
    return out

def shp_header(path):
    with open(path,"rb") as f:
        h = f.read(100)
        code, = struct.unpack(">I", h[:4])
        length, = struct.unpack(">I", h[24:28])
        ver, stype = struct.unpack("<II", h[28:36])
        xmin, ymin, xmax, ymax = struct.unpack("<4d", h[36:68])
        return {"type": SHAPE_TYPES.get(stype, f"?{stype}"),
                "bbox": (xmin, ymin, xmax, ymax),
                "bytes": length*2}

def describe(base):
    name = os.path.basename(base)
    print(f"\n{'='*70}\n{name}\n{'='*70}")
    sh = shp_header(base + ".shp")
    hdr = dbf_header(base + ".dbf")
    print(f"  geometrie      : {sh['type']}")
    print(f"  enregistrements: {hdr['n']:,}".replace(",", " "))
    print(f"  emprise        : lon {sh['bbox'][0]:.4f} a {sh['bbox'][2]:.4f} | "
          f"lat {sh['bbox'][1]:.4f} a {sh['bbox'][3]:.4f}")
    print(f"  maj DBF        : {hdr['date']}")
    print(f"  champs ({len(hdr['fields'])}) :")
    for n,t,l,d in hdr["fields"]:
        print(f"      {n:<22} {t}({l}{','+str(d) if d else ''})")
    return hdr

if __name__ == "__main__":
    D = sys.argv[1]
    for layer in ["ROUTE","CHEMIN","SURFACE_ROUTE","TOPONYME_COMMUNICATION"]:
        p = os.path.join(D, layer)
        if not os.path.exists(p + ".shp"): continue
        try:
            hdr = describe(p)
        except Exception as e:
            print(f"  ERREUR: {e}")
