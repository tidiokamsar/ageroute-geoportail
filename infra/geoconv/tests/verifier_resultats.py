"""Verifie les sorties du worker contre attendus.json. S'execute dans l'image GDAL de base.

Usage : python3 verifier_resultats.py <repertoire_entree> <repertoire_sortie> [fichier_mesures.tsv]
Code de sortie : 0 si tous les jobs sont conformes, 1 sinon.
"""
import json
import os
import sys

ENTREE, SORTIE = sys.argv[1], sys.argv[2]
MESURES = sys.argv[3] if len(sys.argv) > 3 else None


def strict(chemin):
    def refuse(c):
        raise ValueError("constante non JSON : " + c)
    with open(chemin, "rb") as f:
        return json.loads(f.read(), parse_constant=refuse)


def premier_sommet(chemin):
    with open(chemin, "rb") as f:
        for ligne in f:
            if ligne.startswith(b'{"type":"Feature"'):
                feat = json.loads(ligne.strip().rstrip(b","))
                g = feat.get("geometry")
                while g and "coordinates" in g:
                    c = g["coordinates"]
                    while c and isinstance(c[0], list):
                        c = c[0]
                    return c[:2]
    return None


def verifier(jid, att):
    erreurs = []
    d = os.path.join(SORTIE, jid)
    if not os.path.isdir(d):
        return ["aucun repertoire de sortie"], None, None
    try:
        st = strict(os.path.join(d, "statut.json"))
        res = strict(os.path.join(d, "resultat.json"))
    except Exception as e:  # noqa
        return [f"statut/resultat illisible : {e}"], None, None
    if os.path.exists(os.path.join(d, "inventaire.json")):
        try:
            inv = strict(os.path.join(d, "inventaire.json"))
        except Exception as e:  # noqa
            erreurs.append(f"inventaire illisible : {e}")
            inv = None
    else:
        inv = None
    if st["statut"] not in ("termine", "echec"):
        erreurs.append(f"statut final {st['statut']}")
    attendu = att.get("statut")
    if attendu in ("termine", "echec") and st["statut"] != attendu:
        erreurs.append(f"statut {st['statut']} (code {st.get('code')}) au lieu de {attendu} : {st.get('message')}")
    if att.get("code") and st.get("code") != att["code"]:
        erreurs.append(f"code {st.get('code')} au lieu de {att['code']}")
    if att.get("codes") and st.get("code") not in att["codes"]:
        erreurs.append(f"code {st.get('code')} hors de {att['codes']}")
    if st["statut"] == "echec" and os.path.exists(os.path.join(d, "couches")):
        erreurs.append("sortie partielle conservee apres echec")
    if st["statut"] == "echec" and not st.get("code"):
        erreurs.append("echec sans code")
    codes_av = {a["code"] for a in res.get("avertissements", [])}
    for c in att.get("avert", []):
        if c not in codes_av:
            erreurs.append(f"avertissement {c} absent (presents : {sorted(codes_av)})")
    if att.get("inventaire_pilote") and (not inv or inv["format"]["pilote"] != att["inventaire_pilote"]):
        erreurs.append("pilote d'inventaire inattendu")
    if "unites_dxf" in att:
        u = (inv or {}).get("unites") or {}
        if u.get("code") != att["unites_dxf"]:
            erreurs.append(f"unites DXF {u} au lieu de {att['unites_dxf']}")
    if att.get("nb_couches") is not None and len(res["couches"]) != att["nb_couches"]:
        erreurs.append(f"{len(res['couches'])} couches au lieu de {att['nb_couches']}")
    if att.get("couches_min") is not None and len(res["couches"]) < att["couches_min"]:
        erreurs.append(f"{len(res['couches'])} couches, au moins {att['couches_min']} attendues")
    for nom, ch in (att.get("couches") or {}).items():
        c = next((x for x in res["couches"] if x["nom"] == nom), None)
        if not c:
            erreurs.append(f"couche {nom} absente")
            continue
        if "nb" in ch and c["nbObjets"] != ch["nb"]:
            erreurs.append(f"{nom}: {c['nbObjets']} objets au lieu de {ch['nb']}")
        if "reprojete" in ch and c["reprojete"] != ch["reprojete"]:
            erreurs.append(f"{nom}: reprojete={c['reprojete']}")
        if ch.get("crs_null") and c["crs"] is not None:
            erreurs.append(f"{nom}: crs devrait etre null")
        if "crs_epsg" in ch and (not c["crs"] or c["crs"].get("epsg") != ch["crs_epsg"]):
            erreurs.append(f"{nom}: crs {c['crs']}")
        if "coordonnees" in ch and c["coordonnees"] != ch["coordonnees"]:
            erreurs.append(f"{nom}: coordonnees {c['coordonnees']}")
        if "types" in ch and c["typesGeometrieReels"] != ch["types"]:
            erreurs.append(f"{nom}: types {c['typesGeometrieReels']}")
        if "origine_crs" in ch and (c.get("crsSource") or {}).get("origine") != ch["origine_crs"]:
            erreurs.append(f"{nom}: origine crs {c.get('crsSource')}")
        if "epsg_source" in ch and (c.get("crsSource") or {}).get("epsg") != ch["epsg_source"]:
            erreurs.append(f"{nom}: epsg source {c.get('crsSource')}")
        if "premier_sommet" in ch:
            ps = premier_sommet(os.path.join(d, c["fichier"]))
            attendu_ps = ch["premier_sommet"]
            tol = 2e-6 if c["coordonnees"] == "wgs84" else 1e-3
            if not ps or any(abs(a - b) > tol for a, b in zip(ps, attendu_ps)):
                erreurs.append(f"{nom}: premier sommet {ps} au lieu de {attendu_ps}")
    if att.get("pas_de_fichier_hors_couches"):
        permis = {"statut.json", "resultat.json", "inventaire.json", "couches"}
        for n in os.listdir(d):
            if n not in permis:
                erreurs.append(f"fichier inattendu dans la sortie : {n}")
        for n in (os.listdir(os.path.join(d, "couches")) if os.path.isdir(os.path.join(d, "couches")) else []):
            if not n.endswith(".geojson") or "/" in n or ".." in n:
                erreurs.append(f"nom de sortie suspect : {n!r}")
    duree = res["mesures"]["dureeMs"]
    if att.get("duree_max_ms") and duree > att["duree_max_ms"]:
        erreurs.append(f"duree {duree} ms > {att['duree_max_ms']} ms")
    pic = max([e.get("picMemoireKo", 0) for e in res["mesures"]["etapes"]] + [res["mesures"].get("picMemoireWorkerKo", 0)])
    return erreurs, (st, res), (duree, pic)


def main():
    attendus = strict(os.path.join(ENTREE, "attendus.json"))
    # La racine de la sortie ne doit contenir QUE des repertoires de jobs.
    racine_ok = True
    for n in os.listdir(SORTIE):
        if n not in attendus:
            print(f"ECHEC racine de sortie : element inattendu {n!r}")
            racine_ok = False
    ko = 0
    lignes = []
    for jid in sorted(attendus):
        erreurs, sr, mes = verifier(jid, attendus[jid])
        st = sr[0] if sr else {}
        res = sr[1] if sr else {}
        etat = "OK  " if not erreurs else "ECHEC"
        print(f"{etat} {jid:46s} {st.get('statut', '?'):8s} {str(st.get('code') or '-'):28s} "
              f"{(mes[0] if mes else 0):7d} ms {(mes[1] // 1024 if mes else 0):5d} Mo")
        for e in erreurs:
            print("       -", e)
        if erreurs:
            ko += 1
        if mes:
            lignes.append((jid, st.get("statut"), st.get("code") or "", mes[0], mes[1], attendus[jid].get("mesure", False),
                           (res.get("couches") or [{}])[0].get("sommets", 0) if res.get("couches") else 0))
    if MESURES:
        with open(MESURES, "w") as f:
            f.write("job\tstatut\tcode\tduree_ms\tpic_memoire_enfant_ko\tmesure\tsommets\n")
            for l in lignes:
                f.write("\t".join(map(str, l)) + "\n")
    total = len(attendus)
    print(f"\n{total - ko}/{total} jobs conformes" + ("" if racine_ok else " ; racine de sortie non conforme"))
    return 0 if ko == 0 and racine_ok else 1


if __name__ == "__main__":
    sys.exit(main())
