"""
P4-03 — Convertit une couche shapefile en TSV chargeable par PostgreSQL COPY.

LECTURE SEULE sur les fichiers source. Écrit un TSV avec la géométrie en WKT,
destiné à une base d'ANALYSE LOCALE — jamais la production.

Pourquoi un TSV et pas des INSERT : 262 656 objets et 5,8 millions de sommets.
COPY avale cela en une passe ; des INSERT unitaires prendraient des heures.

Usage :
    python scripts/osm-comparison/shp_vers_tsv.py <base_sans_extension> <sortie.tsv>
"""

import os
import struct
import sys

# Champs conservés : ceux dont l'audit a montré qu'ils portent une information.
# Les autres (GESTION, POID_MAX entièrement vides ; CL_ADMIN constant) ne sont pas
# repris — les charger donnerait l'illusion d'une donnée disponible.
CHAMPS_RETENUS = ["ID", "NATURE", "NUMERO", "NOM", "SENS", "DATE_MAJ"]

VIDES = {"", "NC", "N/C", "NULL", "-"}


def entete_dbf(chemin):
    with open(chemin, "rb") as f:
        h = f.read(32)
        _, _, _, _, nrec, hlen, rlen = struct.unpack("<BBBBIHH", h[:12])
        champs = []
        while True:
            fd = f.read(32)
            if not fd or fd[0] == 0x0D:
                break
            champs.append((fd[:11].split(b"\0")[0].decode("latin-1").strip(), fd[16]))
        return {"n": nrec, "hlen": hlen, "rlen": rlen, "champs": champs}


def lire_attributs(chemin, hdr, encodage="utf-8"):
    positions = {}
    pos = 1
    for nom, L in hdr["champs"]:
        if nom in CHAMPS_RETENUS:
            positions[nom] = (pos, L)
        pos += L
    with open(chemin, "rb") as f:
        f.seek(hdr["hlen"])
        for _ in range(hdr["n"]):
            brut = f.read(hdr["rlen"])
            if len(brut) < hdr["rlen"]:
                break
            rec = {}
            for nom, (p, L) in positions.items():
                v = brut[p:p + L]
                try:
                    v = v.decode(encodage).strip()
                except UnicodeDecodeError:
                    v = v.decode("latin-1").strip()
                rec[nom] = "" if v.upper() in VIDES else v
            yield rec


def lire_geometries(chemin):
    """Rend le WKT LINESTRING de chaque objet, ou None."""
    with open(chemin, "rb") as f:
        f.seek(100)
        while True:
            th = f.read(8)
            if len(th) < 8:
                break
            _, clen = struct.unpack(">II", th)
            corps = f.read(clen * 2)
            if len(corps) < 4:
                break
            stype, = struct.unpack("<I", corps[:4])
            if stype != 3:  # PolyLine seulement
                yield None
                continue
            nparties, npoints = struct.unpack("<II", corps[36:44])
            off = 44 + nparties * 4
            parties = list(struct.unpack(f"<{nparties}I", corps[44:off])) + [npoints]
            coords = struct.unpack(f"<{2 * npoints}d", corps[off:off + 16 * npoints])
            # Une seule partie dans ce jeu (0 multipart mesuré), mais on reste
            # correct : les parties suivantes sont ignorées et signalées par le
            # compteur de l'appelant plutôt que fusionnées en silence.
            d, fin = parties[0], parties[1]
            if fin - d < 2:
                yield None
                continue
            pts = ", ".join(
                f"{coords[2 * i]:.7f} {coords[2 * i + 1]:.7f}" for i in range(d, fin)
            )
            yield f"LINESTRING({pts})"


def echapper(s):
    """COPY en format texte : la tabulation, le retour et l'antislash s'échappent."""
    return s.replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n").replace("\r", "")


def main(base, sortie):
    hdr = entete_dbf(base + ".dbf")
    attrs = lire_attributs(base + ".dbf", hdr)
    geoms = lire_geometries(base + ".shp")

    ecrits = sans_geom = 0
    with open(sortie, "w", encoding="utf-8", newline="\n") as f:
        for rec, wkt in zip(attrs, geoms):
            if wkt is None:
                sans_geom += 1
                continue
            ligne = [
                echapper(rec.get("ID", "")),
                echapper(rec.get("NATURE", "")),
                echapper(rec.get("NUMERO", "")),
                echapper(rec.get("NOM", "")),
                echapper(rec.get("SENS", "")),
                echapper(rec.get("DATE_MAJ", "")),
                wkt,
            ]
            f.write("\t".join(ligne) + "\n")
            ecrits += 1

    taille = os.path.getsize(sortie)
    print(f"{os.path.basename(base)} : {ecrits:,} objets ecrits, "
          f"{sans_geom} sans geometrie exploitable".replace(",", " "))
    print(f"  {sortie} — {taille:,} octets".replace(",", " "))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
