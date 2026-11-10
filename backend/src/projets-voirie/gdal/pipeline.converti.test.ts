import { afterEach, describe, expect, it } from "vitest";
import { ErreurMetier } from "../erreurs";
import { META_WGS84, choisirCrsConverti, type MetaCrs } from "../formats/crs.noyau";
import { limitesImport } from "../formats/import.config";
import { detecter, detecterConvertie, inventaireConverti, preparer, type OptionsImport } from "../formats/lecture-import.noyau";
import { kmzSimple } from "../formats/zip.fixtures";
import { ErreurLecture } from "../lecture.types";
import { assembler, type ConversionValidee, type CoucheLue, type EntreeAssemblage } from "./conversion.noyau";
import { LIMITES_COUCHE_DEFAUT, validerCoucheTexte, validerResultat, type AttendusJob, type InventaireDxf } from "./sortie.noyau";
import { DEUX_AXES, SHA_A, dxfMixte, ligne, resultatValide, texteCouche, type FeatureSpec } from "./fixtures.gdal";

/**
 * LE RESULTAT D'UNE CONVERSION ENTRE DANS LE MEME PIPELINE que les formats simples (lot B2) : meme collecteur, memes limites, meme controle de zone, meme
 * regle de CRS, meme mapping, memes empreintes. Aucune seconde voie.
 */

const ID = "123e4567-e89b-42d3-a456-426614174000-t1";
const LIM = { sommetsParObjet: 100_000, sommetsParFichier: 2_000_000, objetsMax: 50_000, ...LIMITES_COUCHE_DEFAUT };
const META_UTM: MetaCrs = { epsg: 32629, nom: "WGS 84 / UTM zone 29N", unite: "metre", geographique: false };
const attendus = (format: AttendusJob["format"]): AttendusJob => ({ spoolId: ID, format, sha256: SHA_A, tailleOctets: 1000, objetsMax: 50_000, sortieOctetsMax: 80 * 1024 * 1024 });
const lim = limitesImport();

function lue(features: FeatureSpec[], dxf = false): { l: CoucheLue; octets: number } {
  const t = texteCouche(features);
  return { l: { v: validerCoucheTexte(t, { limites: LIM, coordonnees: "wgs84", retenir: true, ...(dxf ? { grouperPar: "Layer" } : {}) }), sha256: "c".repeat(64), octets: Buffer.byteLength(t) }, octets: Buffer.byteLength(t) };
}

function convGpkg(features: FeatureSpec[] = DEUX_AXES, crsSource: { origine: "fichier" | "demande"; epsg: number | null; nom: string | null } | null = { origine: "fichier", epsg: 32629, nom: "WGS 84 / UTM zone 29N" },
  parametres: EntreeAssemblage["parametres"] = {}, format: "GPKG" | "SHAPEFILE" = "GPKG"): ConversionValidee {
  const { l, octets } = lue(features);
  const c = assembler({
    format, resultat: validerResultat(resultatValide({ spoolId: ID, format: format === "GPKG" ? "GPKG" : "ZIP", nbObjets: features.length, octetsCouche: octets, octets: 1000, crsSource })),
    attendus: attendus(format), parametres, lues: new Map([["axes", l]]), insunits: null, uniteCrsSource: null, nomFichier: "axes.gpkg",
  });
  c.metaSource = META_UTM;
  return c;
}

function lire(conv: ConversionValidee, opts: OptionsImport = {}) {
  const det = detecterConvertie(conv, opts);
  const prep = preparer(det, opts, lim);
  return prep.terminer(META_WGS84, null);
}
const refus = (f: () => unknown): string => { try { f(); } catch (e) { return e instanceof ErreurMetier || e instanceof ErreurLecture ? e.code : `AUTRE:${String(e)}`; } return "AUCUN"; };

describe("CRS d'un fichier converti : jamais deviné, mêmes règles que les autres formats", () => {
  const f = (format: "GPKG" | "SHAPEFILE" | "DXF", source: Parameters<typeof choisirCrsConverti>[1], coord: "wgs84" | "brutes", deja?: number, option?: number) =>
    () => choisirCrsConverti(format, source, coord, deja, option, [4326, 32628, 32629]);
  const fichier32629 = { origine: "fichier" as const, epsg: 32629, nom: "UTM" };
  const fichier4326 = { origine: "fichier" as const, epsg: 4326, nom: "WGS 84" };

  it("coordonnées brutes ou CRS inconnu : CRS_REQUIS", () => {
    expect(refus(f("GPKG", null, "brutes"))).toBe("CRS_REQUIS");
    expect(refus(f("GPKG", fichier32629, "brutes"))).toBe("CRS_REQUIS");
    expect(refus(f("GPKG", null, "wgs84"))).toBe("CRS_REQUIS");
  });

  it("GeoPackage : 4326 déclaré admis tel quel ; projeté déclaré exige la confirmation du MÊME code ; autre code : CRS_CONFLIT", () => {
    expect(f("GPKG", fichier4326, "wgs84")()).toEqual({ epsg: 4326, origine: "declare_dans_le_fichier", transformer: false });
    expect(refus(f("GPKG", fichier32629, "wgs84"))).toBe("CRS_REQUIS");
    expect(f("GPKG", fichier32629, "wgs84", undefined, 32629)()).toEqual({ epsg: 32629, origine: "declare_dans_le_fichier", transformer: false });
    expect(f("GPKG", fichier32629, "wgs84", 32629)()).toMatchObject({ epsg: 32629 });
    expect(refus(f("GPKG", fichier32629, "wgs84", undefined, 32628))).toBe("CRS_CONFLIT");
    expect(refus(f("GPKG", fichier4326, "wgs84", undefined, 32629))).toBe("CRS_CONFLIT");
    expect(refus(f("GPKG", fichier32629, "wgs84", 32629, 32628))).toBe("CRS_CONFLIT");
  });

  it("Shapefile : le .prj ne vaut jamais confirmation, même en WGS 84", () => {
    expect(refus(f("SHAPEFILE", fichier32629, "wgs84"))).toBe("CRS_REQUIS");
    expect(refus(f("SHAPEFILE", fichier4326, "wgs84"))).toBe("CRS_REQUIS");
    // Defaut D5 du pilote : un CRS declare par le fichier puis confirme garde son origine (declare_dans_le_fichier) ; seul un CRS demande sans declaration est « choisi ».
    expect(f("SHAPEFILE", fichier32629, "wgs84", 32629)()).toMatchObject({ epsg: 32629, origine: "declare_dans_le_fichier" });
    expect(refus(f("SHAPEFILE", fichier32629, "wgs84", 32628))).toBe("CRS_CONFLIT");
  });

  it("Shapefile sans .prj ou DXF : le CRS vient de la demande (liste blanche)", () => {
    const demande = { origine: "demande" as const, epsg: 32629, nom: null };
    expect(f("DXF", demande, "wgs84", 32629)()).toMatchObject({ epsg: 32629, origine: "choisi_par_utilisateur" });
    expect(refus(f("DXF", { ...demande, epsg: 3857 }, "wgs84", 3857))).toBe("CRS_NON_AUTORISE");
    expect(refus(f("DXF", demande, "wgs84", 32629, 32628))).toBe("CRS_CONFLIT");
  });

  it("un CRS sans code EPSG ou hors liste blanche est refusé", () => {
    expect(refus(f("GPKG", { origine: "fichier", epsg: null, nom: "Perso" }, "wgs84"))).toBe("CRS_NON_SUPPORTE");
    expect(refus(f("GPKG", { origine: "fichier", epsg: 3857, nom: "Mercator" }, "wgs84", undefined, 3857))).toBe("CRS_NON_AUTORISE");
  });
});

describe("même pipeline que les formats simples", () => {
  it("objets, noms, types et EMPREINTES identiques à ceux d'un GeoJSON équivalent", () => {
    const conv = convGpkg(DEUX_AXES, { origine: "fichier", epsg: 4326, nom: "WGS 84" });
    const viaGdal = lire(conv);
    const fc = { type: "FeatureCollection", features: DEUX_AXES.map((x) => ({ type: "Feature", properties: x.props, geometry: x.geom })) };
    const direct = preparer(detecter(Buffer.from(JSON.stringify(fc)), "axes.geojson", {}, lim), {}, lim).terminer(META_WGS84, null);
    const vue = (r: typeof viaGdal) => r.objets.map((o) => [o.nom, o.typeGeom, o.empreinte, o.geometrie, o.attributs]);
    expect(vue(viaGdal)).toEqual(vue(direct));
    expect(viaGdal.resume).toEqual(direct.resume);
    expect(viaGdal.format).toBe("GPKG");
  });

  it("resume.crs : source, cible, unités, méthode GDAL/PROJ versionnée, origine, plausibilité", () => {
    const r = lire(convGpkg(), { epsgSource: 32629 });
    expect(r.crs).toMatchObject({
      source: "EPSG:32629 (WGS 84 / UTM zone 29N)", cible: "EPSG:4326", epsgSource: 32629, epsgCible: 4326, uniteSource: "metre", uniteCible: "degre",
      transformation: "GDAL_PROJ", versionProj: "9.8.1", origine: "declare_dans_le_fichier",
    });
    expect(r.crs.methode).toBe("GDAL 3.13.3 / PROJ 9.8.1 (conteneur isole)");
    expect(r.crs.justification).toMatch(/conteneur isole/);
    expect(r.crs.plausibilite).toMatchObject({ statut: "CONFORME", nbElementsHorsZone: 0, nbObjets: 2, confirmationRequise: false });
    expect(r.importInfo.conversion).toMatchObject({ jobId: ID.replace("-t1", ""), formatSource: "GPKG", gdal: { version: "3.13.3" }, couches: ["axes"], crsSource: { origine: "fichier", epsg: 32629 } });
  });

  it("GeoPackage en WGS 84 : aucune transformation, CRS déclaré par le fichier", () => {
    const r = lire(convGpkg(DEUX_AXES, { origine: "fichier", epsg: 4326, nom: "WGS 84" }));
    expect(r.crs).toMatchObject({ transformation: "aucune", methode: "aucune transformation", origine: "declare_dans_le_fichier", versionProj: null, uniteSource: "degre" });
    expect(r.avertissements.map((a) => a.code)).toContain("CRS_DECLARE_DANS_LE_FICHIER");
  });

  it("GeoPackage projeté déclaré sans confirmation : CRS_REQUIS ; Shapefile sans confirmation : CRS_REQUIS ; confirmation différente : CRS_CONFLIT", () => {
    expect(refus(() => lire(convGpkg()))).toBe("CRS_REQUIS");
    expect(refus(() => lire(convGpkg(DEUX_AXES, undefined, {}, "SHAPEFILE")))).toBe("CRS_REQUIS");
    expect(refus(() => lire(convGpkg(), { epsgSource: 32628 }))).toBe("CRS_CONFLIT");
    expect(refus(() => lire(convGpkg(DEUX_AXES, undefined, {}, "SHAPEFILE"), { epsgSource: 32629 }))).toBe("AUCUN");
    expect(refus(() => lire(convGpkg(DEUX_AXES, undefined, { epsgSource: 32629 }, "SHAPEFILE")))).toBe("AUCUN"); // confirmé à la création du job
  });

  it("une conversion en coordonnées brutes (sans CRS connu) n'entre jamais dans le pipeline", () => {
    const { l, octets } = lue(DEUX_AXES);
    const t = texteCouche(DEUX_AXES, { crs: null });
    const brutes = assembler({
      format: "GPKG", resultat: validerResultat(resultatValide({ spoolId: ID, nbObjets: 2, octetsCouche: Buffer.byteLength(t), octets: 1000, coordonnees: "brutes", crsSource: null })), attendus: attendus("GPKG"), parametres: {},
      lues: new Map([["axes", { v: validerCoucheTexte(t, { limites: LIM, coordonnees: "brutes", retenir: true }), sha256: l.sha256, octets: Buffer.byteLength(t) }]]), insunits: null, uniteCrsSource: null, nomFichier: "axes.gpkg",
    });
    void octets;
    expect(refus(() => lire(brutes))).toBe("CRS_REQUIS");
    // m9 : l'inventaire annonce le choix OBLIGATOIRE des que l'apercu refusera (GeoPackage sans CRS : coordonnees brutes, aucun CRS source)
    expect(inventaireConverti(brutes).crs).toEqual({ normeDuFormat: null, declareDansLeFichier: null, choixObligatoire: true });
  });

  it("inventaire : choixObligatoire suit exactement la regle de l'apercu (m9)", () => {
    const wgs = { origine: "fichier" as const, epsg: 4326, nom: "WGS 84" };
    expect(inventaireConverti(convGpkg(DEUX_AXES, wgs)).crs.choixObligatoire).toBe(false); // 4326 declare : admis tel quel
    expect(inventaireConverti(convGpkg()).crs.choixObligatoire).toBe(true); // projete declare : confirmation exigee
    expect(inventaireConverti(convGpkg(DEUX_AXES, { origine: "fichier", epsg: null, nom: "Perso" })).crs.choixObligatoire).toBe(true); // sans code EPSG
    expect(inventaireConverti(convGpkg(DEUX_AXES, undefined, { epsgSource: 32629 })).crs.choixObligatoire).toBe(false); // deja confirme a la creation
    expect(inventaireConverti(convGpkg(DEUX_AXES, wgs, {}, "SHAPEFILE")).crs.choixObligatoire).toBe(true); // le .prj ne vaut jamais confirmation
  });

  it("zone attendue : tout hors Guinée = HORS_GUINEE ; une partie = confirmation exigée (409), confirmée les autres sont gardés", () => {
    const hors: FeatureSpec = { props: { nom: "Loin" }, geom: ligne([30, 10], [30.1, 10]) };
    expect(refus(() => lire(convGpkg([hors]), { epsgSource: 32629 }))).toBe("HORS_GUINEE");
    const mixte = convGpkg([...DEUX_AXES, hors]);
    expect(refus(() => lire(mixte, { epsgSource: 32629 }))).toBe("CONFIRMATION_HORS_ZONE_REQUISE");
    const r = lire(mixte, { epsgSource: 32629, confirmerHorsZone: true });
    expect(r.objets).toHaveLength(2);
    expect(r.crs.plausibilite).toMatchObject({ statut: "PARTIELLEMENT_HORS_ZONE", nbElementsHorsZone: 1, confirmee: true });
    expect(r.avertissements.map((a) => a.code)).toContain("ELEMENTS_HORS_GUINEE");
  });

  it("les plafonds de sommets du module s'appliquent au résultat converti", () => {
    const det = detecterConvertie(convGpkg(DEUX_AXES, { origine: "fichier", epsg: 4326, nom: "WGS 84" }), {});
    expect(refus(() => preparer(det, {}, { ...lim, lecture: { sommetsParObjet: 2, sommetsParFichier: 1_000 } }).terminer(META_WGS84, null))).toBe("TROP_DE_SOMMETS");
  });

  it("mapping : colonne absente refusée, nom pris dans une colonne, objets sans nom signalés", () => {
    const c = convGpkg(DEUX_AXES, { origine: "fichier", epsg: 4326, nom: "WGS 84" });
    expect(refus(() => lire(c, { mapping: { nom: "absente" } }))).toBe("MAPPING_COLONNE_INTROUVABLE");
    expect(lire(c, { mapping: { nom: "nom", identifiant: "n" } }).objets.map((o) => o.nom)).toEqual(["Axe A", "Axe B"]);
    const sansNom = convGpkg([{ props: { n: 1 }, geom: ligne([-9, 10.8], [-8.9, 10.8]) }], { origine: "fichier", epsg: 4326, nom: "WGS 84" });
    expect(lire(sansNom).avertissements.map((a) => a.code)).toContain("OBJETS_SANS_NOM");
  });

  it("réimport idempotent : mêmes entités, mêmes empreintes (base du delta de versions)", () => {
    const a = lire(convGpkg(DEUX_AXES, { origine: "fichier", epsg: 4326, nom: "WGS 84" }));
    const b = lire(convGpkg(DEUX_AXES, { origine: "fichier", epsg: 4326, nom: "WGS 84" }));
    expect(a.objets.map((o) => o.empreinte)).toEqual(b.objets.map((o) => o.empreinte));
  });

  it("couche : sélection par identifiant, COUCHE_INTROUVABLE sinon", () => {
    const c = convGpkg(DEUX_AXES, { origine: "fichier", epsg: 4326, nom: "WGS 84" });
    expect(lire(c, { couche: "axes" }).importInfo.couche).toEqual({ id: "axes", nom: "axes" });
    expect(refus(() => lire(c, { couche: "autre" }))).toBe("COUCHE_INTROUVABLE");
  });

  it("inventaire d'un fichier converti : couches, champs, CRS déclaré, suggestions de mapping", () => {
    const inv = inventaireConverti(convGpkg());
    expect(inv.couches).toEqual([{ id: "axes", nom: "axes", nbObjets: 2, parTypeGeom: { LIGNE: 2, POINT: 0, POLYGONE: 0 } }]);
    expect(inv.crs).toEqual({ normeDuFormat: null, declareDansLeFichier: "EPSG:32629", choixObligatoire: true });
    expect(inv.suggestionsMapping.nom).toBe("nom");
    expect(JSON.stringify(inv)).not.toContain("coordinates");
  });
});

describe("DXF converti : calques, entités ignorées comptées, noms absents", () => {
  const INV: InventaireDxf = {
    version: "AC1015", codepage: null, entitesSupportees: ["LINE", "LWPOLYLINE", "POLYLINE", "3DPOLYLINE"], lues: { LINE: 3 }, ignorees: { TEXT: 4, HATCH: 1 },
    blocs: { definitions: 1, entitesDansBlocs: 2 }, calques: [{ nom: "AXES", lues: 2, ignorees: 0 }, { nom: "RESEAU", lues: 1, ignorees: 5 }], nbEntitesTotal: 8,
  };
  const feats: FeatureSpec[] = [
    { props: { Layer: "AXES", EntityHandle: "A1" }, geom: ligne([-9, 10.8], [-8.9, 10.8]) }, { props: { Layer: "AXES", EntityHandle: "A2" }, geom: ligne([-9, 10.9], [-8.9, 10.9]) },
    { props: { Layer: "RESEAU", EntityHandle: "A3" }, geom: ligne([-9, 10.7], [-8.9, 10.7]) },
  ];
  function convDxf(unites: "metre" | "degre" = "metre"): ConversionValidee {
    const { l, octets } = lue(feats, true);
    const c = assembler({
      format: "DXF", resultat: validerResultat(resultatValide({ spoolId: ID, format: "DXF", slug: "entities", nbObjets: 3, octetsCouche: octets, octets: 1000, crsSource: { origine: "demande", epsg: 32629, nom: null }, dxf: INV })),
      attendus: attendus("DXF"), parametres: { epsgSource: 32629, unitesDxf: unites }, lues: new Map([["entities", l]]), insunits: 6, uniteCrsSource: "metre", nomFichier: "plan.dxf",
    });
    c.metaSource = META_UTM;
    return c;
  }

  it("un calque importé seul ; mapping sur EntityHandle ; CRS de la demande ; provenance DXF sans géométrie", () => {
    const r = lire(convDxf(), { couche: "calque:AXES", mapping: { nom: "EntityHandle" } });
    expect(r.objets.map((o) => o.nom)).toEqual(["A1", "A2"]);
    expect(r.crs).toMatchObject({ epsgSource: 32629, origine: "choisi_par_utilisateur", transformation: "GDAL_PROJ" });
    expect(r.importInfo.conversion!.dxf).toMatchObject({ unitesDeclarees: "metre", insunits: 6, lues: { LINE: 3 }, ignorees: { TEXT: 4, HATCH: 1 }, blocs: { definitions: 1 } });
    expect(JSON.stringify(r.importInfo)).not.toContain("coordinates");
  });

  it("tous les calques : COUCHES_MULTIPLES, la couche d'origine est conservée en attribut", () => {
    const r = lire(convDxf());
    expect(r.objets).toHaveLength(3);
    expect(r.avertissements.map((a) => a.code)).toContain("COUCHES_MULTIPLES");
    expect(r.objets.map((o) => o.attributs._couche)).toEqual(["AXES", "AXES", "RESEAU"]);
  });

  it("l'inventaire liste les calques comme couches", () => {
    expect(inventaireConverti(convDxf()).couches.map((c) => [c.id, c.nbObjets])).toEqual([["calque:AXES", 2], ["calque:RESEAU", 1]]);
  });
});

describe("crochet synchrone : ces formats ne se lisent jamais dans le processus de l'API", () => {
  const sqlite = Buffer.alloc(4096);
  Buffer.from("SQLite format 3\u0000", "latin1").copy(sqlite, 0);
  sqlite.writeUInt32BE(0x47504b47, 68);
  const avant = process.env.PROJETS_VOIRIE_GDAL;
  afterEach(() => { if (avant === undefined) delete process.env.PROJETS_VOIRIE_GDAL; else process.env.PROJETS_VOIRIE_GDAL = avant; });

  it("désactivé (défaut) : code explicite FORMAT_GDAL_DESACTIVE (415) pour les trois formats", () => {
    delete process.env.PROJETS_VOIRIE_GDAL;
    for (const [b, nom, format] of [[sqlite, "a.gpkg", "GPKG"], [dxfMixte(), "a.dxf", "DXF"]] as const) {
      try { detecter(b, nom, {}, lim); expect.unreachable(); } catch (e) {
        expect(e).toBeInstanceOf(ErreurMetier);
        expect(e).toMatchObject({ status: 415, code: "FORMAT_GDAL_DESACTIVE", extra: { format } });
      }
    }
  });

  it("activé : la voie à suivre (job asynchrone) est indiquée, le DXF binaire est refusé", () => {
    process.env.PROJETS_VOIRIE_GDAL = "1";
    try { detecter(sqlite, "a.gpkg", {}, lim); expect.unreachable(); } catch (e) { expect(e).toMatchObject({ status: 422, code: "CONVERSION_ASYNCHRONE_REQUISE" }); }
    expect(refus(() => detecter(Buffer.concat([Buffer.from("AutoCAD Binary DXF\r\n\u001a\u0000", "latin1"), Buffer.alloc(40)]), "a.dxf", {}, lim))).toBe("DXF_BINAIRE_NON_PRIS_EN_CHARGE");
  });

  it("un KMZ, un GeoJSON et un CSV suivent leur voie habituelle, interrupteur coupé ou non", () => {
    for (const actif of [false, true]) {
      if (actif) process.env.PROJETS_VOIRIE_GDAL = "1"; else delete process.env.PROJETS_VOIRIE_GDAL;
      const kml = '<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>a</name><LineString><coordinates>-9,10.8,0 -8.9,10.8,0</coordinates></LineString></Placemark></Document></kml>';
      expect(detecter(kmzSimple(kml), "a.kmz", {}, lim).format).toBe("KMZ");
      expect(detecter(Buffer.from('{"type":"FeatureCollection","features":[]}'), "a.geojson", {}, lim).format).toBe("GEOJSON");
      expect(detecter(Buffer.from("x;y\n1;2\n"), "a.csv", {}, lim).format).toBe("CSV");
    }
  });
});
