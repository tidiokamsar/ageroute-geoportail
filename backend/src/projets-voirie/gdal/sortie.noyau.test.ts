import { describe, expect, it } from "vitest";
import {
  ErreurSortie, LIMITES_COUCHE_DEFAUT, ValidateurCouche, controlerResultat, controlerUnitesDxf, controlerUniteContreCrs, slugDeFichier, validerCoucheTexte,
  validerResultat, validerStatut, type AttendusJob, type OptionsCouche,
} from "./sortie.noyau";
import { DEUX_AXES, SHA_A, ligne, point, resultatValide, texteCouche } from "./fixtures.gdal";

/**
 * SORTIE DU CONTENEUR : NON FIABLE (lot B2). Chaque garde de validation a un test qui echoue si la garde disparait (voir aussi la mutation des gardes dans
 * le rapport du lot).
 */

const ID = "123e4567-e89b-42d3-a456-426614174000-t1";
const ATTENDUS: AttendusJob = { spoolId: ID, format: "GPKG", sha256: SHA_A, tailleOctets: 1000, objetsMax: 50_000, sortieOctetsMax: 80 * 1024 * 1024 };
const LIM = { sommetsParObjet: 100_000, sommetsParFichier: 2_000_000, objetsMax: 50_000, ...LIMITES_COUCHE_DEFAUT };
const OPT: OptionsCouche = { limites: LIM, coordonnees: "wgs84", retenir: true };
const refus = (f: () => unknown): string => { try { f(); } catch (e) { return e instanceof ErreurSortie ? e.code : `AUTRE:${String(e)}`; } return "AUCUN"; };

describe("statut.json et resultat.json : schémas stricts", () => {
  const statut = { jobId: ID, statut: "termine", etape: "termine", code: null, message: null, debut: "2026-11-08T10:00:00Z", fin: "2026-11-08T10:00:03Z", versionWorker: "0.2.0", versionContrat: 1, nbCouches: 1 };

  it("accepte ce que le worker écrit réellement", () => {
    expect(validerStatut(statut).statut).toBe("termine");
    expect(validerResultat(resultatValide({ spoolId: ID })).couches).toHaveLength(1);
  });

  it("refuse une clé inconnue, un type faux, une version de contrat étrangère", () => {
    expect(refus(() => validerStatut({ ...statut, inconnue: 1 }))).toBe("SORTIE_INVALIDE");
    expect(refus(() => validerStatut({ ...statut, statut: "termine !" }))).toBe("SORTIE_INVALIDE");
    expect(refus(() => validerStatut({ ...statut, versionContrat: 2 }))).toBe("SORTIE_INVALIDE");
    expect(refus(() => validerStatut({ ...statut, code: "minuscule" }))).toBe("SORTIE_INVALIDE");
    expect(refus(() => validerResultat({ ...resultatValide({ spoolId: ID }), inconnue: true }))).toBe("SORTIE_INVALIDE");
    const r = resultatValide({ spoolId: ID }) as { couches: Record<string, unknown>[] };
    expect(refus(() => validerResultat({ ...r, couches: [{ ...r.couches[0], cleEnPlus: 1 }] }))).toBe("SORTIE_INVALIDE");
    expect(refus(() => validerResultat({ ...r, couches: [{ ...r.couches[0], crs: { epsg: 3857, nom: "x" } }] }))).toBe("SORTIE_INVALIDE");
    expect(refus(() => validerResultat({ ...r, mesures: { dureeMs: -1, etapes: [], picMemoireWorkerKo: 1 } }))).toBe("SORTIE_INVALIDE");
    expect(refus(() => validerResultat("pas un objet"))).toBe("SORTIE_INVALIDE");
    expect(refus(() => validerResultat(null))).toBe("SORTIE_INVALIDE");
  });

  it("un message qui reprend du texte du fichier n'est jamais conservé dans l'erreur levée (aucune fuite de valeur)", () => {
    try { validerResultat({ ...resultatValide({ spoolId: ID }), code: "/tmp/secret/chemin.gpkg" }); } catch (e) {
      expect(String((e as Error).message)).not.toMatch(/secret|\/tmp/);
    }
  });

  it("le chemin d'une couche est un nom ASCII sous couches/, jamais un autre chemin", () => {
    expect(slugDeFichier("couches/axes.geojson")).toBe("axes");
    for (const mauvais of ["../axes.geojson", "couches/../x.geojson", "/etc/passwd", "couches/a/b.geojson", "couches/Axes.geojson", "couches/axes.geojson\u0000", "couches/axes.json", "couches/-x.geojson", "couches/.geojson"]) {
      expect(refus(() => slugDeFichier(mauvais)), mauvais).toBe("SORTIE_INVALIDE");
    }
  });
});

describe("cohérence du résultat avec ce que le backend a envoyé", () => {
  const ok = () => validerResultat(resultatValide({ spoolId: ID, sha256: SHA_A, octets: 1000 }));

  it("passe quand tout correspond", () => { expect(refus(() => controlerResultat(ok(), ATTENDUS))).toBe("AUCUN"); });

  it("refuse un autre fichier (empreinte ou taille), un autre job, un autre format", () => {
    expect(refus(() => controlerResultat(validerResultat(resultatValide({ spoolId: ID, sha256: "b".repeat(64), octets: 1000 })), ATTENDUS))).toBe("SORTIE_INCOHERENTE");
    expect(refus(() => controlerResultat(validerResultat(resultatValide({ spoolId: ID, octets: 999 })), ATTENDUS))).toBe("SORTIE_INCOHERENTE");
    expect(refus(() => controlerResultat(validerResultat(resultatValide({ spoolId: ID.replace("-t1", "-t2"), octets: 1000 })), ATTENDUS))).toBe("SORTIE_INCOHERENTE");
    expect(refus(() => controlerResultat(ok(), { ...ATTENDUS, format: "SHAPEFILE" }))).toBe("SORTIE_INCOHERENTE");
    expect(refus(() => controlerResultat(ok(), { ...ATTENDUS, format: "DXF" }))).toBe("SORTIE_INCOHERENTE"); // DXF sans inventaire dxf
  });

  it("refuse un résultat d'échec présenté comme terminé, sans couche, ou au-dessus des plafonds demandés", () => {
    expect(refus(() => controlerResultat(validerResultat({ ...resultatValide({ spoolId: ID, octets: 1000 }), statut: "echec", code: "CRS_CONFLIT" }), ATTENDUS))).toBe("SORTIE_INCOHERENTE");
    expect(refus(() => controlerResultat(validerResultat({ ...resultatValide({ spoolId: ID, octets: 1000 }), couches: [] }), ATTENDUS))).toBe("SORTIE_INCOHERENTE");
    expect(refus(() => controlerResultat(ok(), { ...ATTENDUS, objetsMax: 1 }))).toBe("TROP_D_OBJETS");
    expect(refus(() => controlerResultat(ok(), { ...ATTENDUS, sortieOctetsMax: 10 }))).toBe("SORTIE_TROP_GROSSE");
  });

  it("CRS EXPLICITE : WGS 84 avec un CRS source connu, ou coordonnées brutes sans CRS, jamais un mélange", () => {
    const base = resultatValide({ spoolId: ID, octets: 1000 }) as { couches: Record<string, unknown>[] };
    const brutes = (o: Record<string, unknown>) => validerResultat({ ...base, couches: [{ ...base.couches[0], ...o }] });
    expect(refus(() => controlerResultat(brutes({ coordonnees: "brutes" }), ATTENDUS))).toBe("SORTIE_INCOHERENTE"); // crs encore 4326
    expect(refus(() => controlerResultat(brutes({ coordonnees: "brutes", crs: null, reprojete: true }), ATTENDUS))).toBe("SORTIE_INCOHERENTE");
    expect(refus(() => controlerResultat(brutes({ crsSource: null }), ATTENDUS))).toBe("SORTIE_INCOHERENTE");
    expect(refus(() => controlerResultat(brutes({ coordonnees: "brutes", crs: null, reprojete: false, crsSource: null }), ATTENDUS))).toBe("AUCUN");
  });

  it("refuse deux couches qui portent le même fichier", () => {
    const base = resultatValide({ spoolId: ID, octets: 1000 }) as { couches: Record<string, unknown>[] };
    expect(refus(() => controlerResultat(validerResultat({ ...base, couches: [base.couches[0], { ...base.couches[0], nom: "autre" }] }), ATTENDUS))).toBe("SORTIE_INVALIDE");
  });
});

describe("GeoJSON de couche : lecture ligne à ligne, schéma strict par objet", () => {
  it("lit la mise en forme réelle de GDAL (en-tête, CRS84, résolution, une Feature par ligne)", () => {
    const c = validerCoucheTexte(texteCouche(DEUX_AXES), OPT);
    expect(c.nb).toBe(2);
    expect(c.parFamille).toEqual({ LIGNE: 2, POINT: 0, POLYGONE: 0 });
    expect(c.sommets).toBe(5);
    expect(c.attributs).toEqual(["n", "nom"]);
    expect(c.emprise).toEqual([-9, 10.855481222, -8.998170117, 10.85656651]);
    expect(c.features).toHaveLength(2);
    expect(validerCoucheTexte(texteCouche([]), OPT).nb).toBe(0);
  });

  it("sans retenir, ne garde que des comptes (inventaire du job)", () => {
    expect(validerCoucheTexte(texteCouche(DEUX_AXES), { ...OPT, retenir: false }).features).toBeNull();
  });

  it("accepte une altitude (position à trois valeurs) et la retire des coordonnées lues", () => {
    const c = validerCoucheTexte(texteCouche([{ geom: { type: "LineString", coordinates: [[-9, 10.8, 0], [-9.001, 10.8, 5]] } }]), OPT);
    expect(c.features![0].geometry).toEqual({ type: "LineString", coordinates: [[-9, 10.8], [-9.001, 10.8]] });
  });

  it("refuse un document mal formé : début, en-tête inconnu, contenu après la fin, troncature", () => {
    const t = texteCouche(DEUX_AXES);
    expect(refus(() => validerCoucheTexte("[\n" + t.slice(2), OPT))).toBe("SORTIE_INVALIDE");
    expect(refus(() => validerCoucheTexte(t.replace('"features": [', '"name": "evil",\n"features": ['), OPT))).toBe("SORTIE_INVALIDE");
    expect(refus(() => validerCoucheTexte(t + "{}\n", OPT))).toBe("SORTIE_INVALIDE");
    expect(refus(() => validerCoucheTexte(t.split("\n").slice(0, -3).join("\n"), OPT))).toBe("SORTIE_INVALIDE"); // sans ] ni }
    expect(refus(() => validerCoucheTexte(t.replace('{"type":"Feature"', '{ "type": "Feature"'), OPT))).toBe("SORTIE_INVALIDE"); // ligne hors motif
  });

  it("CRS : un document wgs84 n'a aucun membre crs ou un membre CRS84 ; brutes n'en porte aucun ; un autre CRS est refusé", () => {
    expect(refus(() => validerCoucheTexte(texteCouche(DEUX_AXES, { crs: null }), OPT))).toBe("AUCUN"); // GDAL n'ecrit pas de crs quand la source est deja EPSG:4326
    expect(refus(() => validerCoucheTexte(texteCouche(DEUX_AXES, { crs: "EPSG4326" }), OPT))).toBe("AUCUN");
    expect(refus(() => validerCoucheTexte(texteCouche(DEUX_AXES, { crs: "CRS84" }), { ...OPT, coordonnees: "brutes" }))).toBe("SORTIE_INCOHERENTE");
    expect(refus(() => validerCoucheTexte(texteCouche(DEUX_AXES, { crs: null }), { ...OPT, coordonnees: "brutes" }))).toBe("AUCUN");
    const autre = texteCouche(DEUX_AXES).replace("urn:ogc:def:crs:OGC:1.3:CRS84", "urn:ogc:def:crs:EPSG::32629");
    expect(refus(() => validerCoucheTexte(autre, OPT))).toBe("SORTIE_INCOHERENTE");
  });

  it("refuse les objets hors contrat : clé en trop, type de géométrie inconnu, coordonnées non finies, positions de longueur 4, tableaux mal imbriqués", () => {
    const un = (f: unknown) => `{\n"type": "FeatureCollection",\n"crs": { "type": "name", "properties": { "name": "urn:ogc:def:crs:OGC:1.3:CRS84" } },\n"features": [\n${JSON.stringify(f)}\n]\n}\n`;
    const feat = (geometry: unknown, extra: Record<string, unknown> = {}) => ({ type: "Feature", properties: {}, geometry, ...extra });
    expect(refus(() => validerCoucheTexte(un(feat(ligne([-9, 10], [-9.1, 10]), { extra: 1 })), OPT))).toBe("SORTIE_INVALIDE");
    expect(refus(() => validerCoucheTexte(un(feat({ type: "Curve", coordinates: [] })), OPT))).toBe("SORTIE_INVALIDE");
    expect(refus(() => validerCoucheTexte(un(feat({ type: "LineString", coordinates: [[-9, 10], [-9.1, 1e12]] })), OPT))).toBe("SORTIE_INVALIDE");
    expect(refus(() => validerCoucheTexte(un(feat({ type: "LineString", coordinates: [[-9, 10, 0, 0], [-9.1, 10, 0, 0]] })), OPT))).toBe("SORTIE_INVALIDE");
    expect(refus(() => validerCoucheTexte(un(feat({ type: "LineString", coordinates: [-9, 10] })), OPT))).toBe("SORTIE_INVALIDE");
    expect(refus(() => validerCoucheTexte(un(feat({ type: "Polygon", coordinates: [[-9, 10]] })), OPT))).toBe("SORTIE_INVALIDE");
    expect(refus(() => validerCoucheTexte(un(feat({ type: "Point", coordinates: [-9, 10], geometries: [] })), OPT))).toBe("SORTIE_INVALIDE");
    expect(refus(() => validerCoucheTexte(un(feat({ type: "Point", coordinates: [-9, 10], cle: 1 })), OPT))).toBe("SORTIE_INVALIDE");
    expect(refus(() => validerCoucheTexte(un({ type: "Feature", properties: [], geometry: null }), OPT))).toBe("SORTIE_INVALIDE");
    expect(refus(() => validerCoucheTexte(un({ type: "Autre", properties: {}, geometry: null }), OPT))).toBe("SORTIE_INVALIDE");
    // NaN et Infinity ne sont pas du JSON : la ligne est illisible
    expect(refus(() => validerCoucheTexte(un(feat(null)).replace('"geometry":null', '"geometry":{"type":"Point","coordinates":[NaN,1]}'), OPT))).toBe("SORTIE_INVALIDE");
  });

  it("une geometrie nulle est comptée sans geometrie, pas refusée", () => {
    const c = validerCoucheTexte(texteCouche([...DEUX_AXES, { props: { nom: "vide" }, geom: null }]), OPT);
    expect(c.nb).toBe(3);
    expect(c.sansGeometrie).toBe(1);
    expect(c.typesReels.null).toBe(1);
  });

  it("types : points, polygones, collections ; compte par famille", () => {
    const c = validerCoucheTexte(texteCouche([
      { geom: point(-9, 10.8) },
      { geom: { type: "Polygon", coordinates: [[[-9, 10], [-9.1, 10], [-9.1, 10.1], [-9, 10]]] } },
      { geom: { type: "GeometryCollection", geometries: [point(-9, 10.8), ligne([-9, 10], [-9.1, 10])] } },
      { geom: { type: "MultiLineString", coordinates: [[[-9, 10], [-9.1, 10]], [[-9, 10.2], [-9.1, 10.2]]] } },
    ]), OPT);
    expect(c.parFamille).toEqual({ LIGNE: 2, POINT: 2, POLYGONE: 1 });
  });

  it("plafonds : objets, sommets par objet, sommets par fichier, taille de ligne", () => {
    const f = Array.from({ length: 5 }, (_, i) => ({ props: { i }, geom: ligne([-9, 10], [-9.1, 10]) }));
    expect(refus(() => validerCoucheTexte(texteCouche(f), { ...OPT, limites: { ...LIM, objetsMax: 4 } }))).toBe("TROP_D_OBJETS");
    expect(refus(() => validerCoucheTexte(texteCouche(f), { ...OPT, limites: { ...LIM, objetsMax: 5 } }))).toBe("AUCUN");
    expect(refus(() => validerCoucheTexte(texteCouche([{ geom: ligne([-9, 10], [-9.1, 10], [-9.2, 10]) }]), { ...OPT, limites: { ...LIM, sommetsParObjet: 2 } }))).toBe("TROP_DE_SOMMETS");
    expect(refus(() => validerCoucheTexte(texteCouche(f), { ...OPT, limites: { ...LIM, sommetsParFichier: 9 } }))).toBe("TROP_DE_SOMMETS");
    expect(refus(() => validerCoucheTexte(texteCouche(f), { ...OPT, limites: { ...LIM, sommetsParFichier: 10 } }))).toBe("AUCUN");
    expect(refus(() => validerCoucheTexte(texteCouche([{ props: { a: "x".repeat(500) }, geom: null }]), { ...OPT, limites: { ...LIM, ligneMax: 200 } }))).toBe("SORTIE_INVALIDE");
  });

  it("le nombre d'objets annoncé par resultat.json doit être celui du fichier", () => {
    expect(refus(() => validerCoucheTexte(texteCouche(DEUX_AXES), { ...OPT, nbObjetsDeclare: 3 }))).toBe("SORTIE_INCOHERENTE");
    expect(refus(() => validerCoucheTexte(texteCouche(DEUX_AXES), { ...OPT, nbObjetsDeclare: 2 }))).toBe("AUCUN");
  });

  it("attributs : plats, bornés, sans __proto__, structures converties en texte, clés assainies", () => {
    const longue = "é".repeat(12_000);
    const c = validerCoucheTexte(texteCouche([{ props: { a: longue, liste: ["x", "y"], obj: { k: 1 }, ok: 1.5, b: true, n: null, ["__proto__"]: "x" as unknown, ["cl\u0007e"]: "y" }, geom: null }]), { ...OPT, retenir: true });
    const p = c.features![0].properties;
    expect((p.a as string).length).toBe(10_000);
    expect(p.liste).toBe('["x","y"]');
    expect(p.obj).toBe('{"k":1}');
    expect(p.ok).toBe(1.5);
    expect(Object.keys(p)).not.toContain("__proto__");
    expect(Object.keys(p)).toContain("cl?e");
    expect(Object.getPrototypeOf(p)).toBe(Object.prototype);
    expect(c.attributsAdaptes).toBeGreaterThanOrEqual(4);
    const beaucoup = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`c${i}`, i]));
    expect(refus(() => validerCoucheTexte(texteCouche([{ props: beaucoup, geom: null }]), OPT))).toBe("SORTIE_INVALIDE");
  });

  it("regroupe par calque (propriété Layer) pour un DXF, avec un plafond de groupes", () => {
    const f = [
      { props: { Layer: "AXES" }, geom: ligne([-9, 10], [-9.1, 10]) }, { props: { Layer: "AXES" }, geom: ligne([-9, 10.1], [-9.1, 10.1]) },
      { props: { Layer: "RESEAU" }, geom: ligne([-9, 10.2], [-9.1, 10.2]) }, { props: {}, geom: ligne([-9, 10.3], [-9.1, 10.3]) },
    ];
    const c = validerCoucheTexte(texteCouche(f), { ...OPT, grouperPar: "Layer" });
    expect([...c.groupes!.entries()].map(([k, v]) => [k, v.nb])).toEqual([["AXES", 2], ["RESEAU", 1], ["(sans calque)", 1]]);
    expect(c.features!.map((x) => x.groupe)).toEqual(["AXES", "AXES", "RESEAU", "(sans calque)"]);
    expect(refus(() => validerCoucheTexte(texteCouche(f), { ...OPT, grouperPar: "Layer", groupesMax: 2 }))).toBe("SORTIE_INVALIDE");
  });

  it("comptes PAR GROUPE (calque) : types reels, sommets et emprise du calque seul, jamais ceux du fichier entier (m11)", () => {
    const f = [
      { props: { Layer: "AXES" }, geom: ligne([-9, 10.8], [-8.9, 10.8]) }, { props: { Layer: "AXES" }, geom: ligne([-9, 10.9], [-8.9, 10.9], [-8.95, 10.95]) },
      { props: { Layer: "RESEAU" }, geom: point(-9.5, 10.7) }, { props: { Layer: "VIDE" }, geom: null },
    ];
    const c = validerCoucheTexte(texteCouche(f), { ...OPT, grouperPar: "Layer" });
    const g = Object.fromEntries(c.groupes!.entries());
    expect(g.AXES).toEqual({ nb: 2, parFamille: { LIGNE: 2, POINT: 0, POLYGONE: 0 }, typesReels: { LineString: 2 }, sommets: 5, emprise: [-9, 10.8, -8.9, 10.95] });
    expect(g.RESEAU).toEqual({ nb: 1, parFamille: { LIGNE: 0, POINT: 1, POLYGONE: 0 }, typesReels: { Point: 1 }, sommets: 1, emprise: [-9.5, 10.7, -9.5, 10.7] });
    expect(g.VIDE).toEqual({ nb: 1, parFamille: { LIGNE: 0, POINT: 0, POLYGONE: 0 }, typesReels: { null: 1 }, sommets: 0, emprise: null });
    // le fichier entier reste compte a part
    expect(c.sommets).toBe(6);
    expect(c.emprise).toEqual([-9.5, 10.7, -8.9, 10.95]);
  });

  it("le validateur n'accepte rien après la fin ni avant le début (machine à états)", () => {
    const v = new ValidateurCouche(OPT);
    expect(refus(() => v.terminer())).toBe("SORTIE_INVALIDE");
  });
});

describe("chaines du conteneur dans le resume et l'audit : plafonnees et assainies (m5)", () => {
  const base = () => resultatValide({ spoolId: ID }) as Record<string, unknown> & { couches: Record<string, unknown>[]; gdal: Record<string, unknown> };
  const dxfOk = { version: "AC1015", codepage: null, entitesSupportees: ["LINE"], lues: { LINE: 1 }, ignorees: {}, blocs: { definitions: 0, entitesDansBlocs: 0 }, calques: [{ nom: "AXES", lues: 1, ignorees: 0 }], nbEntitesTotal: 1 };
  const comptes = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`T${i}`, 1]));

  it("tables de comptes DXF : 200 cles au plus ; types reels d'une couche : 50 au plus", () => {
    expect(refus(() => validerResultat({ ...base(), dxf: { ...dxfOk, ignorees: comptes(200) } }))).toBe("AUCUN");
    expect(refus(() => validerResultat({ ...base(), dxf: { ...dxfOk, ignorees: comptes(201) } }))).toBe("SORTIE_INVALIDE");
    expect(refus(() => validerResultat({ ...base(), dxf: { ...dxfOk, lues: comptes(201) } }))).toBe("SORTIE_INVALIDE");
    const r = base();
    expect(refus(() => validerResultat({ ...r, couches: [{ ...r.couches[0], typesGeometrieReels: comptes(51) }] }))).toBe("SORTIE_INVALIDE");
    expect(refus(() => validerResultat({ ...r, couches: [{ ...r.couches[0], typesGeometrieReels: comptes(50) }] }))).toBe("AUCUN");
  });

  it("versions GDAL et PROJ, pilotes : motif etroit ; noms de couche, de CRS, de calque, de source : aucun caractere de controle", () => {
    const r = base();
    expect(refus(() => validerResultat({ ...r, gdal: { ...r.gdal, version: "3.13.3 <script>" } }))).toBe("SORTIE_INVALIDE");
    expect(refus(() => validerResultat({ ...r, gdal: { ...r.gdal, proj: "9.8.1\n" } }))).toBe("SORTIE_INVALIDE");
    expect(refus(() => validerResultat({ ...r, gdal: { ...r.gdal, pilotesActifs: ["GPKG", "../x"] } }))).toBe("SORTIE_INVALIDE");
    expect(refus(() => validerResultat({ ...r, gdal: { version: "3.13.3dev-abc+1", proj: "9.8.1", pilotesActifs: ["ESRI Shapefile", "GPKG"] } }))).toBe("AUCUN");
    expect(refus(() => validerResultat({ ...r, couches: [{ ...r.couches[0], nom: "axes\u0007" }] }))).toBe("SORTIE_INVALIDE");
    expect(refus(() => validerResultat({ ...r, couches: [{ ...r.couches[0], nom: "Réseau d'eau (2026)" }] }))).toBe("AUCUN");
    expect(refus(() => validerResultat({ ...r, couches: [{ ...r.couches[0], crsSource: { origine: "fichier", epsg: 32629, nom: "UTM\u001b[31m" } }] }))).toBe("SORTIE_INVALIDE");
    expect(refus(() => validerResultat({ ...r, couches: [{ ...r.couches[0], avertissements: ["pas un code"] }] }))).toBe("SORTIE_INVALIDE");
    expect(refus(() => validerResultat({ ...r, source: { nom: "fichier.gpkg\u0000", octets: 1000, sha256: SHA_A } }))).toBe("SORTIE_INVALIDE");
    expect(refus(() => validerResultat({ ...r, dxf: { ...dxfOk, calques: [{ nom: "AX\u0001ES", lues: 1, ignorees: 0 }] } }))).toBe("SORTIE_INVALIDE");
  });
});

describe("DXF : unités déclarées, jamais de mise à l'échelle silencieuse", () => {
  it("mètres : compatibles avec un CRS en mètres, un en-tête absent, 0 ou 6", () => {
    for (const ins of [null, 0, 6]) expect(refus(() => controlerUnitesDxf("metre", ins, "metre")), String(ins)).toBe("AUCUN");
  });

  it("refuse un en-tête en millimètres, pieds ou pouces déclaré comme des mètres, et un conflit avec le CRS", () => {
    for (const ins of [1, 2, 4, 5]) expect(refus(() => controlerUnitesDxf("metre", ins, "metre")), String(ins)).toBe("DXF_UNITES_CONFLIT");
    expect(refus(() => controlerUnitesDxf("metre", null, "degre"))).toBe("DXF_UNITES_CONFLIT");
    expect(refus(() => controlerUnitesDxf("degre", null, "metre"))).toBe("DXF_UNITES_CONFLIT");
    expect(refus(() => controlerUnitesDxf("degre", null, "degre"))).toBe("AUCUN");
    expect(refus(() => controlerUnitesDxf("degre", 6, "degre"))).toBe("DXF_UNITES_CONFLIT"); // un DXF n'a pas d'unité angulaire
    expect(refus(() => controlerUniteContreCrs("metre", "pied US"))).toBe("DXF_UNITES_CONFLIT");
  });
});
