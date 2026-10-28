"""Fabrique les jeux de test du worker GDAL (valides, invalides, anormaux, volumineux).

S'execute DANS l'image GDAL de base (bibliotheques osgeo, sqlite3), sans reseau, en ecrivant :
  <entree>/<jobId>/fichier.<ext> + demande.json   (le spool d'entree)
  <entree>/attendus.json                          (ce que le verificateur doit constater)
Toutes les donnees sont SYNTHETIQUES (coordonnees autour de Kissidougou, valeurs inventees).
Aucune donnee de concessionnaire, aucun fichier reel, aucun telechargement.

Usage : python3 fabriquer_jeux.py <repertoire_entree> <repertoire_sortie>
"""
import json
import math
import os
import random
import shutil
import sqlite3
import struct
import sys
import tempfile
import zlib
import zipfile

from osgeo import gdal, ogr, osr

gdal.UseExceptions()
ogr.UseExceptions()
osr.UseExceptions()

ENTREE = sys.argv[1]
SORTIE = sys.argv[2]
ATTENDUS = {}
LON0, LAT0 = -10.10, 9.18  # Kissidougou (synthetique : points inventes autour)


def srs(epsg):
    s = osr.SpatialReference()
    s.ImportFromEPSG(epsg)
    s.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    return s


def vers_utm(lon, lat):
    ct = osr.CoordinateTransformation(srs(4326), srs(32629))
    x, y, _ = ct.TransformPoint(lon, lat)
    return x, y


def vers_wgs(x, y):
    ct = osr.CoordinateTransformation(srs(32629), srs(4326))
    lon, lat, _ = ct.TransformPoint(x, y)
    return lon, lat


def job(nom, ext, octets=None, demande=None, attendu=None):
    """Cree entree/<nom>/fichier.<ext> (+ demande.json) et enregistre l'attendu."""
    jid = "t-" + nom
    d = os.path.join(ENTREE, jid)
    os.makedirs(d)
    if octets is not None:
        with open(os.path.join(d, "fichier." + ext), "wb") as f:
            f.write(octets)
    # demande.json ECRIT EN DERNIER (c'est le signal pour le worker).
    dem = {"version": 1}
    dem.update(demande or {})
    with open(os.path.join(d, "demande.json.tmp"), "w") as f:
        json.dump(dem, f)
    os.rename(os.path.join(d, "demande.json.tmp"), os.path.join(d, "demande.json"))
    ATTENDUS[jid] = attendu or {}
    return d


def lire(chemin):
    with open(chemin, "rb") as f:
        return f.read()


def tmp():
    return tempfile.mkdtemp(prefix="fab-", dir="/tmp")


# ----------------------------------------------------------------------------- jeux valides
def lignes_utm(n, decalage=0.0):
    x0, y0 = vers_utm(LON0, LAT0)
    return [[(x0 + i * 50 + decalage, y0 + i * 10), (x0 + i * 50 + 120 + decalage, y0 + i * 10 + 35),
             (x0 + i * 50 + 260 + decalage, y0 + i * 10 + 20)] for i in range(n)]


def creer_couche(ds, nom, epsg, geomtype, geoms, champs=(("nom", ogr.OFTString), ("n", ogr.OFTInteger)), options=None):
    lyr = ds.CreateLayer(nom, srs(epsg) if epsg else None, geomtype, options or [])
    for c, t in champs:
        lyr.CreateField(ogr.FieldDefn(c, t))
    for i, g in enumerate(geoms):
        f = ogr.Feature(lyr.GetLayerDefn())
        f.SetField("nom", f"objet-{i}")
        f.SetField("n", i)
        if g is not None:
            f.SetGeometry(g)
        lyr.CreateFeature(f)
    return lyr


def geom_ligne(pts):
    g = ogr.Geometry(ogr.wkbLineString)
    for p in pts:
        g.AddPoint_2D(*p)
    return g


def geom_point(x, y):
    g = ogr.Geometry(ogr.wkbPoint)
    g.AddPoint_2D(x, y)
    return g


def wkb_pt(x, y):
    return struct.pack("<BIdd", 1, 1, x, y)


def blob_gpkg(srs_id, wkb):
    return b"GP" + bytes([0, 1]) + struct.pack("<i", srs_id) + wkb


def ajouter_table_gpkg(chemin, nom, points, srs_id=4326):
    """Ajoute une table de points dont le NOM est arbitraire (ce que GDAL refuse de creer)."""
    c = sqlite3.connect(chemin)
    q = '"' + nom.replace('"', '""') + '"'
    c.execute(f"create table {q} (fid integer primary key autoincrement, geom blob, nom text)")
    for i, (x, y) in enumerate(points):
        c.execute(f"insert into {q}(geom, nom) values (?, ?)", (blob_gpkg(srs_id, wkb_pt(x, y)), f"p{i}"))
    c.execute("insert into gpkg_contents(table_name,data_type,identifier,srs_id) values (?,?,?,?)", (nom, "features", nom, srs_id))
    c.execute("insert into gpkg_geometry_columns values (?,?,?,?,0,0)", (nom, "geom", "POINT", srs_id))
    c.commit()
    c.close()


def zipper(chemin_zip, fichiers):
    with zipfile.ZipFile(chemin_zip, "w", zipfile.ZIP_DEFLATED) as z:
        for arc, src in fichiers:
            z.write(src, arc)


def fabriquer_valides():
    t = tmp()
    # V01 GeoPackage : lignes UTM 29N, points WGS84, table sans geometrie
    p = os.path.join(t, "v01.gpkg")
    ds = ogr.GetDriverByName("GPKG").CreateDataSource(p)
    creer_couche(ds, "axes", 32629, ogr.wkbLineString, [geom_ligne(l) for l in lignes_utm(20)])
    creer_couche(ds, "regards", 4326, ogr.wkbPoint, [geom_point(LON0 + i * 0.001, LAT0 + i * 0.0005) for i in range(5)])
    creer_couche(ds, "attributs", None, ogr.wkbNone, [None] * 3)
    ds = None
    x0, y0 = vers_utm(LON0, LAT0)
    job("v01-gpkg-utm", "gpkg", lire(p), attendu={
        "statut": "termine",
        "couches": {"axes": {"nb": 20, "reprojete": True, "crs_epsg": 4326, "premier_sommet": list(vers_wgs(x0, y0)),
                             "types": {"LineString": 20}, "origine_crs": "fichier", "epsg_source": 32629},
                    "regards": {"nb": 5, "reprojete": False, "crs_epsg": 4326, "types": {"Point": 5}}},
        "nb_couches": 2, "avert": ["COUCHE_SANS_GEOMETRIE_IGNOREE"], "inventaire_pilote": "GPKG"})

    # V02 Shapefile ZIP complet avec .prj, dans un sous-dossier, avec un readme ignore
    sh = os.path.join(t, "shp"); os.mkdir(sh)
    ds = ogr.GetDriverByName("ESRI Shapefile").CreateDataSource(sh)
    creer_couche(ds, "troncons", 32629, ogr.wkbLineString, [geom_ligne(l) for l in lignes_utm(10)])
    ds = None
    z = os.path.join(t, "v02.zip")
    fich = [("livraison/" + n, os.path.join(sh, n)) for n in os.listdir(sh)]
    open(os.path.join(t, "LISEZMOI.txt"), "w").write("synthetique")
    fich.append(("livraison/LISEZMOI.txt", os.path.join(t, "LISEZMOI.txt")))
    zipper(z, fich)
    job("v02-shp-zip-prj", "zip", lire(z), attendu={
        "statut": "termine",
        "couches": {"troncons": {"nb": 10, "reprojete": True, "crs_epsg": 4326, "premier_sommet": list(vers_wgs(x0, y0)),
                                 "types": {"LineString": 10}, "origine_crs": "fichier"}},
        "avert": ["ENTREES_ARCHIVE_IGNOREES"], "inventaire_pilote": "ESRI Shapefile"})

    # V03 DXF : lignes + points, $INSUNITS patche a 6 (metres) ; pas de CRS dans un DXF
    p = os.path.join(t, "v03.dxf")
    ds = ogr.GetDriverByName("DXF").CreateDataSource(p)
    lyr = ds.CreateLayer("entities", None, ogr.wkbUnknown)
    for l in lignes_utm(8):
        f = ogr.Feature(lyr.GetLayerDefn()); f.SetGeometry(geom_ligne(l)); lyr.CreateFeature(f)
    for i in range(3):
        f = ogr.Feature(lyr.GetLayerDefn()); f.SetGeometry(geom_point(x0 + i, y0 + i)); lyr.CreateFeature(f)
    ds = None
    brut = lire(p)
    assert b"$INSUNITS" in brut, "INSUNITS absent du DXF fabrique"
    txt = brut.decode("latin-1")
    i = txt.index("$INSUNITS")
    j = txt.index("70", i)
    # remplace la valeur qui suit le groupe 70 par 6 (metres)
    k = txt.index("\n", j) + 1
    fin = txt.index("\n", k)
    txt2 = txt[:k] + "     6" + txt[fin:]
    open(p, "wb").write(txt2.encode("latin-1"))
    job("v03-dxf", "dxf", lire(p), attendu={
        "statut": "termine", "avert": ["CRS_ABSENT"], "inventaire_pilote": "DXF", "unites_dxf": 6,
        "couches": {"entities": {"nb": 11, "reprojete": False, "crs_null": True, "premier_sommet": [x0, y0],
                                 "coordonnees": "brutes", "origine_crs": None}}})
    dxf_valide = lire(p)

    # V04 Shapefile ZIP SANS .prj : valide, coordonnees brutes, crs null
    sh2 = os.path.join(t, "shp2"); os.mkdir(sh2)
    ds = ogr.GetDriverByName("ESRI Shapefile").CreateDataSource(sh2)
    creer_couche(ds, "reseau", None, ogr.wkbLineString, [geom_ligne(l) for l in lignes_utm(6)])
    ds = None
    assert not any(n.endswith(".prj") for n in os.listdir(sh2))
    z4 = os.path.join(t, "v04.zip")
    zipper(z4, [(n, os.path.join(sh2, n)) for n in os.listdir(sh2)])
    job("v04-shp-sans-prj", "zip", lire(z4), attendu={
        "statut": "termine", "avert": ["CRS_ABSENT"],
        "couches": {"reseau": {"nb": 6, "reprojete": False, "crs_null": True, "premier_sommet": [x0, y0], "coordonnees": "brutes"}}})
    # V05 meme fichier avec EPSG explicite : reprojete, origine = demande
    job("v05-shp-sans-prj-epsg", "zip", lire(z4), demande={"epsg_source": 32629}, attendu={
        "statut": "termine", "avert": ["CRS_FOURNI_PAR_LA_DEMANDE"],
        "couches": {"reseau": {"nb": 6, "reprojete": True, "crs_epsg": 4326, "premier_sommet": list(vers_wgs(x0, y0)),
                               "origine_crs": "demande", "epsg_source": 32629}}})
    # V06 / V07 conflit de CRS entre fichier (32629) et demande (32628)
    p6 = os.path.join(t, "v06.gpkg")
    ds = ogr.GetDriverByName("GPKG").CreateDataSource(p6)
    creer_couche(ds, "axes", 32629, ogr.wkbLineString, [geom_ligne(l) for l in lignes_utm(4)])
    ds = None
    job("v06-crs-conflit", "gpkg", lire(p6), demande={"epsg_source": 32628}, attendu={"statut": "echec", "code": "CRS_CONFLIT"})
    job("v07-crs-surcharge", "gpkg", lire(p6), demande={"epsg_source": 32628, "autoriser_surcharge_crs": True}, attendu={
        "statut": "termine", "avert": ["CRS_SURCHARGE"],
        "couches": {"axes": {"nb": 4, "reprojete": True, "origine_crs": "demande", "epsg_source": 32628}}})
    # V08 couche choisie ; V09 couche inconnue
    pv1 = os.path.join(t, "v01.gpkg")
    job("v08-couche-choisie", "gpkg", lire(pv1), demande={"couches": ["regards"]}, attendu={
        "statut": "termine", "nb_couches": 1, "couches": {"regards": {"nb": 5}}})
    job("v09-couche-inconnue", "gpkg", lire(pv1), demande={"couches": ["nexiste-pas"]}, attendu={"statut": "echec", "code": "COUCHE_INTROUVABLE"})
    # V10 EPSG inexistant sur DXF
    job("v10-epsg-inconnu", "dxf", dxf_valide, demande={"epsg_source": 999998}, attendu={"statut": "echec", "code": "CRS_NON_RECONNU"})
    # V11 DXF + EPSG explicite : reprojete
    job("v11-dxf-epsg", "dxf", dxf_valide, demande={"epsg_source": 32629}, attendu={
        "statut": "termine", "avert": ["CRS_FOURNI_PAR_LA_DEMANDE"],
        "couches": {"entities": {"nb": 11, "reprojete": True, "crs_epsg": 4326, "premier_sommet": list(vers_wgs(x0, y0)), "origine_crs": "demande"}}})
    # V12 DXF tel qu'ecrit par GDAL, sans patch : l'unite lue est celle de l'en-tete
    # V13 extension mensongere MAIS contenu valide : DXF nomme .gpkg => accepte avec avertissement
    job("v13-dxf-nomme-gpkg", "gpkg", dxf_valide, attendu={"statut": "termine", "avert": ["EXTENSION_INCOHERENTE"]})
    # V14 GeoPackage en 4326 : pas de reprojection
    p14 = os.path.join(t, "v14.gpkg")
    ds = ogr.GetDriverByName("GPKG").CreateDataSource(p14)
    creer_couche(ds, "points", 4326, ogr.wkbPoint, [geom_point(LON0 + i * 0.01, LAT0) for i in range(4)])
    ds = None
    job("v14-gpkg-wgs84", "gpkg", lire(p14), attendu={
        "statut": "termine", "couches": {"points": {"nb": 4, "reprojete": False, "crs_epsg": 4326, "premier_sommet": [LON0, LAT0]}}})
    return t


# ----------------------------------------------------------------------------- invalides
def zip_brut(entrees, avec_dossier_central=True):
    """Ecrit un ZIP octet par octet : noms, attributs et partages d'offsets arbitraires.
    entree = dict(nom=bytes, donnees=bytes, methode=0|8, attr=0, flags=0, taille_declaree=None,
                  partage=None (index d'une entree dont on reprend l'offset))"""
    out = bytearray()
    centraux = []
    offsets = []
    for e in entrees:
        if e.get("partage") is not None:
            offsets.append(offsets[e["partage"]])
            comp = centraux[e["partage"]]["comp"]
            crc = centraux[e["partage"]]["crc"]
            taille = centraux[e["partage"]]["taille"]
        else:
            donnees = e["donnees"]
            crc = zlib.crc32(donnees) & 0xFFFFFFFF
            if e.get("methode", 0) == 8:
                co = zlib.compressobj(9, zlib.DEFLATED, -15)
                comp = co.compress(donnees) + co.flush()
            else:
                comp = donnees
            taille = len(donnees)
            offsets.append(len(out))
            nom = e["nom"]
            out += struct.pack("<IHHHHHIIIHH", 0x04034B50, 20, e.get("flags", 0), e.get("methode", 0), 0, 0x21,
                               crc, len(comp), taille, len(nom), 0) + nom + comp
        centraux.append({"comp": comp, "crc": crc, "taille": taille})
    debut_cd = len(out)
    for e, off, c in zip(entrees, offsets, centraux):
        nom = e["nom"]
        decl = e.get("taille_declaree", c["taille"])
        out += struct.pack("<IHHHHHHIIIHHHHHII", 0x02014B50, (3 << 8) | 20, 20, e.get("flags", 0), e.get("methode", 0), 0, 0x21,
                           c["crc"], len(c["comp"]), decl, len(nom), 0, 0, 0, 0, e.get("attr", 0), off) + nom
    taille_cd = len(out) - debut_cd
    out += struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, len(entrees), len(entrees), taille_cd, debut_cd, 0)
    return bytes(out)


def shapefile_octets(n=3):
    t = tmp()
    ds = ogr.GetDriverByName("ESRI Shapefile").CreateDataSource(t)
    creer_couche(ds, "couche", 32629, ogr.wkbLineString, [geom_ligne(l) for l in lignes_utm(n)])
    ds = None
    return {e.rsplit(".", 1)[1]: lire(os.path.join(t, e)) for e in os.listdir(t)}


def fabriquer_invalides():
    sh = shapefile_octets()
    def zip_shp(exclure=(), extra=(), nom="couche"):
        entrees = [dict(nom=f"{nom}.{e}".encode(), donnees=d, methode=8) for e, d in sh.items() if e not in exclure]
        entrees += list(extra)
        return zip_brut(entrees)

    job("i01-shp-sans-shx", "zip", zip_shp(exclure=("shx",)), attendu={"statut": "echec", "code": "SHAPEFILE_INCOMPLET"})
    job("i02-shp-sans-dbf", "zip", zip_shp(exclure=("dbf",)), attendu={"statut": "echec", "code": "SHAPEFILE_INCOMPLET"})
    job("i03-shp-sans-prj-ok", "zip", zip_shp(exclure=("prj",)), attendu={"statut": "termine", "avert": ["CRS_ABSENT"]})
    job("i04-zip-sans-shp", "zip", zip_brut([dict(nom=b"notes.txt", donnees=b"rien", methode=8)]), attendu={"statut": "echec", "code": "ARCHIVE_SANS_DONNEES"})
    mauvais = dict(sh); mauvais["shp"] = b"\x00\x00\x00\x00" + sh["shp"][4:]
    job("i05-shp-entete-invalide", "zip", zip_brut([dict(nom=f"couche.{e}".encode(), donnees=d, methode=8) for e, d in mauvais.items()]),
        attendu={"statut": "echec", "code": "SHAPEFILE_INVALIDE"})
    # GPKG tronque (valide puis coupe a la moitie, a une limite de page ET au milieu d'une page)
    t = tmp()
    p = os.path.join(t, "g.gpkg")
    ds = ogr.GetDriverByName("GPKG").CreateDataSource(p)
    creer_couche(ds, "axes", 32629, ogr.wkbLineString, [geom_ligne(l) for l in lignes_utm(300)])
    ds = None
    g = lire(p)
    job("i06-gpkg-tronque-page", "gpkg", g[: (len(g) // 2 // 4096) * 4096], attendu={"statut": "echec", "code": "FICHIER_TRONQUE"})
    job("i07-gpkg-tronque-milieu", "gpkg", g[: len(g) // 2 + 100], attendu={"statut": "echec", "code": "FICHIER_TRONQUE"})
    job("i08-gpkg-tronque-100o", "gpkg", g[:100], attendu={"statut": "echec", "code": "FICHIER_TRONQUE"})
    # GPKG dont l'en-tete est bon mais dont le reste est du bruit
    rnd = random.Random(7)
    bruit = bytearray(g[:100]) + bytearray(rnd.getrandbits(8) for _ in range(len(g) - 100))
    job("i09-gpkg-corrompu", "gpkg", bytes(bruit), attendu={"statut": "echec", "codes": ["SOURCE_ILLISIBLE", "CONVERSION_ECHEC", "GDAL_PLANTAGE"]})
    # DXF vide (0 octet), DXF coquille sans entite, DXF binaire tronque
    job("i10-dxf-vide-0o", "dxf", b"", attendu={"statut": "echec", "code": "FICHIER_VIDE"})
    coquille = b"  0\nSECTION\n  2\nHEADER\n  0\nENDSEC\n  0\nSECTION\n  2\nENTITIES\n  0\nENDSEC\n  0\nEOF\n"
    job("i11-dxf-sans-entite", "dxf", coquille, attendu={"statut": "echec", "codes": ["AUCUN_OBJET", "AUCUNE_COUCHE"]})
    job("i12-dxf-binaire-tronque", "dxf", b"AutoCAD Binary DXF\r\n\x1a\x00" + b"\x00" * 20, attendu={"statut": "echec", "codes": ["SOURCE_ILLISIBLE", "AUCUN_OBJET", "AUCUNE_COUCHE", "FORMAT_NON_RECONNU"]})
    # extensions mensongeres
    job("i13-html-nomme-gpkg", "gpkg", b"<!DOCTYPE html><html><body>pas un gpkg</body></html>", attendu={"statut": "echec", "code": "FORMAT_NON_RECONNU"})
    job("i14-pdf-nomme-zip", "zip", b"%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", attendu={"statut": "echec", "code": "FORMAT_NON_RECONNU"})
    job("i15-fichier-0-octet", "gpkg", b"", attendu={"statut": "echec", "code": "FICHIER_VIDE"})
    job("i16-exe-nomme-dxf", "dxf", b"MZ\x90\x00" + b"\x00" * 200, attendu={"statut": "echec", "code": "FORMAT_NON_RECONNU"})
    # SQLite qui n'est pas un GeoPackage
    p = os.path.join(t, "s.sqlite")
    c = sqlite3.connect(p); c.execute("create table t(a)"); c.execute("insert into t values (1)"); c.commit(); c.close()
    job("i17-sqlite-non-gpkg", "gpkg", lire(p), attendu={"statut": "echec", "code": "FORMAT_NON_AUTORISE"})
    # demande invalide / entree absente / lien symbolique
    job("i18-demande-cle-inconnue", "gpkg", lire(os.path.join(t, "g.gpkg")), demande={"commande": "rm -rf /"}, attendu={"statut": "echec", "code": "DEMANDE_INVALIDE"})
    job("i19-limite-au-dessus-du-plafond", "gpkg", lire(os.path.join(t, "g.gpkg")), demande={"limites": {"objets_max": 10 ** 9}}, attendu={"statut": "echec", "code": "DEMANDE_INVALIDE"})
    job("i20-fichier-absent", "gpkg", None, attendu={"statut": "echec", "code": "ENTREE_ABSENTE"})
    d = job("i21-lien-symbolique", "gpkg", None, attendu={"statut": "echec", "code": "ENTREE_ABSENTE"})
    os.symlink("/etc/passwd", os.path.join(d, "fichier.gpkg"))
    d = job("i22-demande-pas-json", "gpkg", lire(os.path.join(t, "g.gpkg")), attendu={"statut": "echec", "code": "DEMANDE_INVALIDE"})
    open(os.path.join(d, "demande.json"), "w").write("{pas du json")
    job("i23-nom-fichier-hostile-dans-demande", "gpkg", lire(os.path.join(t, "g.gpkg")), demande={"fichier": "../../etc/passwd"}, attendu={"statut": "echec", "code": "DEMANDE_INVALIDE"})


# ----------------------------------------------------------------------------- malveillants
def fabriquer_malveillants():
    sh = shapefile_octets()
    ent_shp = [dict(nom=f"couche.{e}".encode(), donnees=d, methode=8) for e, d in sh.items()]
    job("m01-zip-slip", "zip", zip_brut(ent_shp + [dict(nom=b"../../evil.shp", donnees=b"x")]), attendu={"statut": "echec", "code": "ARCHIVE_CHEMIN_DANGEREUX"})
    job("m02-zip-chemin-absolu", "zip", zip_brut(ent_shp + [dict(nom=b"/etc/cron.d/x", donnees=b"x")]), attendu={"statut": "echec", "code": "ARCHIVE_CHEMIN_DANGEREUX"})
    job("m03-zip-lecteur-windows", "zip", zip_brut(ent_shp + [dict(nom=b"C:/Windows/x.dbf", donnees=b"x")]), attendu={"statut": "echec", "code": "ARCHIVE_CHEMIN_DANGEREUX"})
    job("m04-zip-antislash", "zip", zip_brut(ent_shp + [dict(nom=b"..\\..\\x.shp", donnees=b"x")]), attendu={"statut": "echec", "code": "ARCHIVE_CHEMIN_DANGEREUX"})
    job("m05-zip-lien-symbolique", "zip", zip_brut(ent_shp + [dict(nom=b"lien.shp", donnees=b"/etc/passwd", attr=(0o120777 << 16))]),
        attendu={"statut": "echec", "code": "ARCHIVE_LIEN_SYMBOLIQUE"})
    job("m06-zip-peripherique", "zip", zip_brut(ent_shp + [dict(nom=b"dev.shp", donnees=b"", attr=(0o020666 << 16))]),
        attendu={"statut": "echec", "code": "ARCHIVE_ENTREE_SPECIALE"})
    job("m07-zip-nom-nul", "zip", zip_brut(ent_shp + [dict(nom=b"ok.shp\x00.txt", donnees=b"x")]), attendu={"statut": "echec", "code": "ARCHIVE_CHEMIN_DANGEREUX"})
    job("m08-zip-nom-controle", "zip", zip_brut(ent_shp + [dict(nom=b"a\x1b[31mb\n.shp", donnees=b"x")]), attendu={"statut": "echec", "code": "ARCHIVE_CHEMIN_DANGEREUX"})
    job("m09-zip-chiffre", "zip", zip_brut([dict(nom=b"couche.shp", donnees=b"x", flags=1)]), attendu={"statut": "echec", "code": "ARCHIVE_CHIFFREE"})
    # zip-bomb : 10 Mo de zeros dans un .dbf, ratio ~ 1000 (limites par DEFAUT)
    bombe = b"\x00" * (10 * 1024 * 1024)
    job("m10-zip-bombe-taux", "zip", zip_brut([dict(nom=b"couche.shp", donnees=sh["shp"], methode=8), dict(nom=b"couche.shx", donnees=sh["shx"], methode=8),
                                               dict(nom=b"couche.dbf", donnees=bombe, methode=8)]),
        attendu={"statut": "echec", "code": "ARCHIVE_TAUX_COMPRESSION", "duree_max_ms": 5000})
    # zip-bomb a petite echelle : 3 x 900 Ko (sous le seuil du taux) mais total > 2 Mo (limite abaissee)
    petits = [dict(nom=f"c{i}.dbf".encode(), donnees=b"\x00" * 900_000, methode=8) for i in range(3)]
    job("m11-zip-bombe-total-abaisse", "zip", zip_brut(ent_shp + petits), demande={"limites": {"taille_decompressee_octets": 2_000_000}},
        attendu={"statut": "echec", "code": "ARCHIVE_TROP_GROSSE"})
    # en-tete qui MENT sur la taille (declare 10 octets, contient plus)
    job("m12-zip-taille-mensongere", "zip", zip_brut([dict(nom=b"couche.shp", donnees=sh["shp"], methode=0, taille_declaree=10),
                                                      dict(nom=b"couche.shx", donnees=sh["shx"], methode=0),
                                                      dict(nom=b"couche.dbf", donnees=sh["dbf"], methode=0)]),
        attendu={"statut": "echec", "codes": ["ARCHIVE_INVALIDE", "ARCHIVE_TROP_GROSSE", "ARCHIVE_CHEVAUCHEMENT"]})
    # entrees dont les donnees se chevauchent (une seule charge de 600 Ko, 200 entrees pointent dessus)
    base = dict(nom=b"c0.dbf", donnees=b"\x00" * 600_000, methode=8)
    job("m13-zip-chevauchement", "zip", zip_brut([base] + [dict(nom=f"c{i}.dbf".encode(), donnees=b"", partage=0, methode=8) for i in range(1, 150)]),
        attendu={"statut": "echec", "codes": ["ARCHIVE_TROP_GROSSE", "ARCHIVE_CHEVAUCHEMENT", "ARCHIVE_TAUX_COMPRESSION"]})
    # archive imbriquee (par nom, puis deguisee sous un nom banal)
    interne = zip_brut([dict(nom=b"x.txt", donnees=b"a")])
    job("m14-zip-imbrique-nom", "zip", zip_brut(ent_shp + [dict(nom=b"autre.zip", donnees=interne)]), attendu={"statut": "echec", "code": "ARCHIVE_IMBRIQUEE"})
    job("m15-zip-imbrique-deguise", "zip", zip_brut(ent_shp + [dict(nom=b"donnees.bin", donnees=interne)]), attendu={"statut": "echec", "code": "ARCHIVE_IMBRIQUEE"})
    # centaines de milliers d'entrees
    t = tmp()
    p = os.path.join(t, "beaucoup.zip")
    with zipfile.ZipFile(p, "w", zipfile.ZIP_STORED) as z:
        for i in range(300_000):
            z.writestr(f"e{i}.txt", b"")
    job("m16-zip-300000-entrees", "zip", lire(p), attendu={"statut": "echec", "code": "ARCHIVE_TROP_D_ENTREES", "duree_max_ms": 5000})
    # noms dupliques dans l'archive
    job("m17-zip-noms-dupliques", "zip", zip_brut(ent_shp + [dict(nom=b"couche.shp", donnees=sh["shp"])]), attendu={"statut": "echec", "code": "ARCHIVE_NOMS_AMBIGUS"})
    job("m18-zip-methode-bzip2", "zip", zip_brut([dict(nom=b"couche.shp", donnees=b"x", methode=12)]), attendu={"statut": "echec", "codes": ["ARCHIVE_METHODE_NON_SUPPORTEE", "ARCHIVE_INVALIDE"]})
    # shapefile dont le nom contient un tiret initial (option deguisee) : renomme, jamais interprete
    job("m19-shp-nom-tiret", "zip", zip_brut([dict(nom=f"-sql.{e}".encode(), donnees=d, methode=8) for e, d in sh.items()]),
        attendu={"statut": "termine", "avert": ["NOM_FICHIER_RENOMME"]})

    # ---- GeoPackage piegeux
    t = tmp()
    def gpkg_base(nom, n=3):
        p = os.path.join(t, nom)
        ds = ogr.GetDriverByName("GPKG").CreateDataSource(p)
        creer_couche(ds, "ok", 4326, ogr.wkbPoint, [geom_point(LON0 + i * 0.001, LAT0) for i in range(n)])
        return ds, p
    # noms de couches hostiles + declencheurs + vues
    ds, p = gpkg_base("noms.gpkg")
    ds = None
    for i, nm in enumerate(["-sql", 'x"; DROP TABLE ok;--', "$(touch pwned)`id`", "../../../tmp/evil", "ligne\nnouvelle\x1b[31m"]):
        ajouter_table_gpkg(p, nm, [(LON0, LAT0 + i * 0.001)])
    ds = None
    c = sqlite3.connect(p)
    c.execute("create trigger piege after insert on ok begin select load_extension('/tmp/x.so'); end")
    c.execute("create trigger piege2 after update on ok begin delete from ok; end")
    c.commit(); c.close()
    job("m20-gpkg-noms-hostiles-triggers", "gpkg", lire(p), attendu={
        "statut": "termine", "avert": ["COUCHE_NOM_REFUSE"], "pas_de_fichier_hors_couches": True,
        "couches_min": 4})
    # vue recursive infinie enregistree comme couche : doit tomber au delai, pas bloquer le worker
    ds, p = gpkg_base("boucle.gpkg")
    ds = None
    c = sqlite3.connect(p)
    c.execute("create view boucle as with recursive r(i) as (select 1 union all select i+1 from r) "
              "select i as fid, null as geom, 'x' as nom from r")
    c.execute("insert into gpkg_contents(table_name,data_type,identifier,srs_id) values ('boucle','features','boucle',4326)")
    c.execute("insert into gpkg_geometry_columns values ('boucle','geom','POINT',4326,0,0)")
    c.commit(); c.close()
    job("m21-gpkg-vue-boucle-infinie", "gpkg", lire(p), demande={"limites": {"delai_s": 6}},
        attendu={"statut": "echec", "codes": ["DELAI_DEPASSE", "SOURCE_ILLISIBLE", "TROP_D_OBJETS", "MEMOIRE_EPUISEE"], "duree_max_ms": 25000})
    # nombre d'objets MENTEUR : declare 999999999, contient 3
    ds, p = gpkg_base("menteur.gpkg")
    ds = None
    c = sqlite3.connect(p)
    c.execute("update gpkg_ogr_contents set feature_count=999999999 where table_name='ok'")
    c.commit(); c.close()
    job("m22-gpkg-compte-menteur-haut", "gpkg", lire(p), attendu={"statut": "termine", "avert": ["COMPTE_DECLARE_DIVERGENT"], "couches": {"ok": {"nb": 3}}})
    # et l'inverse : declare 3, contient 3000 (plafond abaisse a 1000) => le plafond reel s'applique
    ds, p = gpkg_base("menteur2.gpkg", n=3000)
    ds = None
    c = sqlite3.connect(p)
    c.execute("update gpkg_ogr_contents set feature_count=3 where table_name='ok'")
    c.commit(); c.close()
    job("m23-gpkg-compte-menteur-bas", "gpkg", lire(p), demande={"limites": {"objets_max": 1000}}, attendu={"statut": "echec", "code": "TROP_D_OBJETS"})

    # ---- geometries aberrantes (WKB fabrique a la main dans un GeoPackage)
    def gpkg_wkb(nom, srs_id, blobs):
        p = os.path.join(t, nom)
        ds = ogr.GetDriverByName("GPKG").CreateDataSource(p)
        creer_couche(ds, "bizarre", srs_id, ogr.wkbUnknown, [geom_point(0, 0)], options=["SPATIAL_INDEX=NO"])
        ds = None
        c = sqlite3.connect(p)
        c.execute("delete from bizarre")
        for i, wkb in enumerate(blobs):
            ent = blob_gpkg(srs_id, wkb)
            c.execute("insert into bizarre(fid,geom,nom,n) values (?,?,?,?)", (i + 1, ent, f"b{i}", i))
        c.execute("update gpkg_ogr_contents set feature_count=? where table_name='bizarre'", (len(blobs),))
        c.commit(); c.close()
        return p

    def wkb_ligne(pts):
        return struct.pack("<BII", 1, 2, len(pts)) + b"".join(struct.pack("<dd", *q) for q in pts)

    def wkb_poly(anneau):
        return struct.pack("<BIII", 1, 3, 1, len(anneau)) + b"".join(struct.pack("<dd", *q) for q in anneau)

    nan = float("nan")
    blobs = [
        wkb_pt(nan, nan), wkb_pt(float("inf"), 1.0), wkb_ligne([(LON0, LAT0), (nan, 3.0)]),
        wkb_pt(1e308, 1e308), wkb_pt(-1e308, 1e-308),
        wkb_poly([(0, 0), (4, 4), (4, 0), (0, 4), (0, 0)]),                 # noeud papillon, auto-intersection
        struct.pack("<BII", 1, 2, 2 ** 31 - 1) + struct.pack("<dd", 0.0, 0.0),       # annonce 2 milliards de points, 1 present
        struct.pack("<BI", 1, 999),                                                     # type inconnu, tronque
        wkb_pt(LON0, LAT0),
    ]
    p = gpkg_wkb("aberrant4326.gpkg", 4326, blobs)
    job("m24-geometries-aberrantes-4326", "gpkg", lire(p), attendu={"statut": "borne", "duree_max_ms": 30000})
    p = gpkg_wkb("aberrant32629.gpkg", 32629, [wkb_pt(1e308, 1e308), wkb_pt(nan, 1.0), wkb_pt(500000, 1015000)])
    job("m25-geometries-aberrantes-utm", "gpkg", lire(p), attendu={"statut": "borne", "duree_max_ms": 30000})
    # un million de sommets
    n = 1_000_000
    pts = [(LON0 + (i % 1000) * 1e-5, LAT0 + (i // 1000) * 1e-5) for i in range(n)]
    p = gpkg_wkb("million.gpkg", 4326, [wkb_ligne(pts)])
    job("m26-un-million-de-sommets", "gpkg", lire(p), attendu={"statut": "termine", "couches": {"bizarre": {"nb": 1}}, "duree_max_ms": 60000, "mesure": True})
    # DXF : bombe de blocs imbriques (10^6 insertions potentielles)
    def dxf_bombe(profondeur, largeur):
        l = ["0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", "6", "0", "ENDSEC", "0", "SECTION", "2", "BLOCKS"]
        for k in range(profondeur):
            l += ["0", "BLOCK", "8", "0", "2", f"B{k}", "70", "0", "10", "0", "20", "0", "30", "0", "3", f"B{k}"]
            if k == profondeur - 1:
                l += ["0", "LINE", "8", "0", "10", "0.0", "20", "0.0", "11", "1.0", "21", "1.0"]
            else:
                for j in range(largeur):
                    l += ["0", "INSERT", "8", "0", "2", f"B{k + 1}", "10", str(j), "20", "0", "30", "0"]
            l += ["0", "ENDBLK", "8", "0"]
        l += ["0", "ENDSEC", "0", "SECTION", "2", "ENTITIES", "0", "INSERT", "8", "0", "2", "B0", "10", "0", "20", "0", "30", "0", "0", "ENDSEC", "0", "EOF"]
        return ("\n".join(l) + "\n").encode()
    job("m27-dxf-bombe-blocs", "dxf", dxf_bombe(8, 10), demande={"limites": {"delai_s": 20}},
        attendu={"statut": "borne", "duree_max_ms": 40000})
    # DXF avec une ligne de 20 Mo sans fin de ligne
    job("m28-dxf-ligne-geante", "dxf", b"  0\nSECTION\n  2\nHEADER\n  9\n$X\n  1\n" + b"A" * (20 * 1024 * 1024) + b"\n  0\nENDSEC\n  0\nEOF\n",
        attendu={"statut": "borne", "duree_max_ms": 30000})


# ----------------------------------------------------------------------------- volumineux
def fabriquer_volumineux():
    t = tmp()
    # GeoPackage de 60 000 points (plafond par defaut : 50 000)
    p = os.path.join(t, "gros.gpkg")
    ds = ogr.GetDriverByName("GPKG").CreateDataSource(p)
    lyr = ds.CreateLayer("pts", srs(4326), ogr.wkbPoint)
    lyr.CreateField(ogr.FieldDefn("n", ogr.OFTInteger))
    lyr.StartTransaction()
    for i in range(60_000):
        f = ogr.Feature(lyr.GetLayerDefn()); f.SetField("n", i); f.SetGeometry(geom_point(LON0 + (i % 300) * 1e-4, LAT0 + (i // 300) * 1e-4)); lyr.CreateFeature(f)
    lyr.CommitTransaction()
    ds = None
    job("g01-gpkg-60000-objets", "gpkg", lire(p), attendu={"statut": "echec", "code": "TROP_D_OBJETS", "duree_max_ms": 60000, "mesure": True})
    # Shapefile de 60 000 points
    sh = os.path.join(t, "shp"); os.mkdir(sh)
    ds = ogr.GetDriverByName("ESRI Shapefile").CreateDataSource(sh)
    lyr = ds.CreateLayer("pts", srs(4326), ogr.wkbPoint)
    lyr.CreateField(ogr.FieldDefn("n", ogr.OFTInteger))
    for i in range(60_000):
        f = ogr.Feature(lyr.GetLayerDefn()); f.SetField("n", i); f.SetGeometry(geom_point(LON0 + (i % 300) * 1e-4, LAT0 + (i // 300) * 1e-4)); lyr.CreateFeature(f)
    ds = None
    z = os.path.join(t, "gros.zip")
    zipper(z, [(n, os.path.join(sh, n)) for n in os.listdir(sh)])
    job("g02-shp-60000-objets", "zip", lire(z), attendu={"statut": "echec", "code": "TROP_D_OBJETS", "duree_max_ms": 60000, "mesure": True})
    # DXF de 120 000 lignes (texte)
    l = ["0", "SECTION", "2", "ENTITIES"]
    for i in range(120_000):
        l += ["0", "LINE", "8", "0", "10", str(i * 0.01), "20", "0.0", "11", str(i * 0.01 + 1), "21", "1.0"]
    l += ["0", "ENDSEC", "0", "EOF"]
    job("g03-dxf-120000-lignes", "dxf", ("\n".join(l) + "\n").encode(), attendu={"statut": "echec", "code": "TROP_D_OBJETS", "duree_max_ms": 60000, "mesure": True})
    # au-dela du plafond de TAILLE de sortie : 20 000 lignes avec attributs de 1 Ko, plafond abaisse a 2 Mo
    p = os.path.join(t, "lourd.gpkg")
    ds = ogr.GetDriverByName("GPKG").CreateDataSource(p)
    lyr = ds.CreateLayer("lourd", srs(4326), ogr.wkbPoint)
    lyr.CreateField(ogr.FieldDefn("texte", ogr.OFTString))
    lyr.StartTransaction()
    for i in range(20_000):
        f = ogr.Feature(lyr.GetLayerDefn()); f.SetField("texte", ("x%d" % i) * 300); f.SetGeometry(geom_point(LON0, LAT0)); lyr.CreateFeature(f)
    lyr.CommitTransaction()
    ds = None
    job("g04-sortie-trop-grosse-abaissee", "gpkg", lire(p), demande={"limites": {"sortie_octets_max": 2_000_000}},
        attendu={"statut": "echec", "code": "SORTIE_TROP_GROSSE", "duree_max_ms": 60000, "mesure": True})
    # GeoPackage de 20 000 lignes sous le plafond : debit nominal
    p = os.path.join(t, "nominal.gpkg")
    ds = ogr.GetDriverByName("GPKG").CreateDataSource(p)
    lyr = ds.CreateLayer("axes", srs(32629), ogr.wkbLineString)
    lyr.CreateField(ogr.FieldDefn("nom", ogr.OFTString))
    lyr.StartTransaction()
    x0, y0 = vers_utm(LON0, LAT0)
    for i in range(20_000):
        f = ogr.Feature(lyr.GetLayerDefn()); f.SetField("nom", "axe%d" % i)
        f.SetGeometry(geom_ligne([(x0 + i, y0), (x0 + i + 50, y0 + 20), (x0 + i + 90, y0 + 5)])); lyr.CreateFeature(f)
    lyr.CommitTransaction()
    ds = None
    job("g05-gpkg-20000-lignes-nominal", "gpkg", lire(p), attendu={"statut": "termine", "couches": {"axes": {"nb": 20000, "reprojete": True}}, "duree_max_ms": 60000, "mesure": True})


if __name__ == "__main__":
    os.makedirs(ENTREE, exist_ok=True)
    os.makedirs(SORTIE, exist_ok=True)
    fabriquer_valides()
    fabriquer_invalides()
    fabriquer_malveillants()
    fabriquer_volumineux()
    with open(os.path.join(ENTREE, "attendus.json"), "w") as f:
        json.dump(ATTENDUS, f, indent=1)
    # le worker (UID 10001) doit pouvoir ecrire dans la sortie et lire l'entree
    os.chown(SORTIE, 10001, 10001)
    os.chmod(SORTIE, 0o755)
    print(f"{len(ATTENDUS)} jobs fabriques")
