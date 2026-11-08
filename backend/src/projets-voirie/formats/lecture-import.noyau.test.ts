import { describe, expect, it } from "vitest";
import { ErreurMetier } from "../erreurs";
import { ErreurLecture } from "../lecture.types";
import { META_WGS84, type MetaCrs } from "./crs.noyau";
import { limitesCsv, limitesZip } from "./import.config";
import { detecter, inventorier, preparer, type LimitesImport, type OptionsImport, type ResultatImport } from "./lecture-import.noyau";
import { analyserMapping } from "./mapping.noyau";
import { construireZip, kmzSimple } from "./zip.fixtures";

/**
 * Fixtures 100 % SYNTHETIQUES : coordonnees inventees autour de (-10,10 ; 9,20), aucun fichier d'un tiers.
 * La transformation de CRS est faite par PostGIS (banc d'integration) : ici une transformation de test, lineaire, pour verifier la plomberie
 * (ordre des sommets, sommets illisibles, controle de zone, confirmation).
 */
const LIM: LimitesImport = { lecture: {}, zip: limitesZip(), csv: limitesCsv(), crsAutorises: [4326, 32628, 32629] };
const META_UTM29: MetaCrs = { epsg: 32629, nom: "WGS 84 / UTM zone 29N", unite: "metre", geographique: false };
const UTM = (x: number, y: number) => [-10 + (x - 380000) / 110000, 9.2 + (y - 1015000) / 110000];
const code = (f: () => unknown): string | null => { try { f(); } catch (e) { if (e instanceof ErreurLecture || e instanceof ErreurMetier) return e.code; throw e; } return null; };

function lire(contenu: Buffer | string, nom: string, opts: OptionsImport = {}, lim = LIM): ResultatImport {
  const b = Buffer.isBuffer(contenu) ? contenu : Buffer.from(contenu);
  const p = preparer(detecter(b, nom, opts, lim), opts, lim);
  if (!p.besoinTransformation) return p.terminer(META_WGS84, null);
  const s = p.sommets!;
  const lon = new Float64Array(s.x.length), lat = new Float64Array(s.x.length);
  for (let i = 0; i < s.x.length; i++) [lon[i], lat[i]] = UTM(s.x[i], s.y[i]);
  return p.terminer(META_UTM29, "9.x.y", { lon, lat });
}

const pm = (nom: string, geom: string) => `<Placemark><name>${nom}</name>${geom}</Placemark>`;
const ligne = (c: string) => `<LineString><coordinates>${c}</coordinates></LineString>`;
const kml = (corps: string) => `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>${corps}</Document></kml>`;
const KML_UN = kml(pm("A", ligne("-10.1,9.2 -10.09,9.2")));
const geojson = (features: unknown[], extra: object = {}) => JSON.stringify({ type: "FeatureCollection", ...extra, features });
const feat = (props: object, coordinates: unknown, type = "Point") => ({ type: "Feature", properties: props, geometry: { type, coordinates } });

describe("detection par le contenu, jamais par l'extension", () => {
  it("un KML nomme .csv, un GeoJSON nomme .txt, un GPX nomme .xml sont lus pour ce qu'ils sont ; l'extension incoherente est signalee", () => {
    const k = lire(KML_UN, "reseau.csv");
    expect(k.format).toBe("KML");
    expect(k.avertissements).toContainEqual(expect.objectContaining({ code: "EXTENSION_INCOHERENTE" }));
    expect(k.detection).toEqual({ extensionDeclaree: "csv", extensionCoherente: false });
    expect(lire(geojson([feat({}, [-10.1, 9.2])]), "pts.txt").format).toBe("GEOJSON");
    expect(lire(`<gpx version="1.1"><wpt lat="9.2" lon="-10.1"/></gpx>`, "trace.xml").format).toBe("GPX");
    expect(lire(KML_UN, "reseau.kml").avertissements.find((a) => a.code === "EXTENSION_INCOHERENTE")).toBeUndefined();
  });

  it("un KMZ nomme .kml et un KML nomme .kmz : le contenu decide (un fichier .kmz qui n'est pas une archive n'est plus refuse a l'extension)", () => {
    expect(lire(kmzSimple(KML_UN), "reseau.kml").format).toBe("KMZ");
    expect(lire(KML_UN, "reseau.kmz").format).toBe("KML");
  });

  it("HTML, PDF, executable, octets NUL, script : CONTENU_NON_RECONNU quelle que soit l'extension, y compris .csv", () => {
    for (const [c, n] of [["<!DOCTYPE html><html><body>x,y</body></html>", "a.csv"], ["%PDF-1.7\n1 0 obj", "a.csv"], ["#!/bin/sh\nrm -rf /", "a.txt"]] as const) {
      expect(code(() => lire(c, n)), n).toBe("CONTENU_NON_RECONNU");
    }
    expect(code(() => lire(Buffer.from([0x4d, 0x5a, 0x90, 0]), "a.csv"))).toBe("CONTENU_NON_RECONNU");
    expect(code(() => lire(Buffer.from("a,b\n1,\u0000\n"), "a.csv"))).toBe("CONTENU_NON_RECONNU");
  });

  it("texte libre, DXF renomme, XML d'une autre racine, ZIP de Shapefile, JSON non GeoJSON : FORMAT_NON_SUPPORTE", () => {
    expect(code(() => lire("Bonjour,\nceci est une lettre.\n", "plan.txt"))).toBe("FORMAT_NON_SUPPORTE");
    expect(code(() => lire("0\nSECTION\n2\nHEADER\n0\nENDSEC\n", "plan.txt"))).toBe("FORMAT_NON_SUPPORTE");
    expect(code(() => lire("0\nSECTION\n2\nHEADER\n", "plan.dxf"))).toBe("FORMAT_NON_SUPPORTE");
    expect(code(() => lire(`<svgx/>`, "a.xml"))).toBe("FORMAT_NON_SUPPORTE");
    expect(code(() => lire(construireZip([{ nom: "axes.shp", contenu: "x" }, { nom: "axes.dbf", contenu: "x" }]).buffer, "axes.zip"))).toBe("FORMAT_NON_SUPPORTE");
    expect(code(() => lire(JSON.stringify({ hello: 1 }), "a.json"))).toBe("FORMAT_NON_SUPPORTE");
  });

  it("fichier vide ou de blancs : FICHIER_VIDE ; trop gros : FICHIER_TROP_GROS", () => {
    expect(code(() => lire(Buffer.alloc(0), "a.csv"))).toBe("FICHIER_VIDE");
    expect(code(() => lire("   \n  ", "a.json"))).toBe("FICHIER_VIDE");
    expect(code(() => detecter(Buffer.alloc(26 * 1024 * 1024, 0x61), "a.csv", {}, LIM))).toBe("FICHIER_TROP_GROS");
  });

  it("XXE : une entite externe dans un GPX ou dans le KML d'un KMZ est refusee, jamais resolue", () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE gpx [<!ENTITY x SYSTEM "file:///etc/passwd">]><gpx><wpt lat="9" lon="-10"><name>&x;</name></wpt></gpx>`;
    expect(code(() => lire(xxe, "a.gpx"))).toBe("DTD_REFUSEE");
    const kmlXxe = `<?xml version="1.0"?><!DOCTYPE kml [<!ENTITY x SYSTEM "file:///etc/passwd">]><kml><Document><Placemark><name>&x;</name></Placemark></Document></kml>`;
    expect(code(() => lire(kmzSimple(kmlXxe), "a.kmz"))).toBe("DTD_REFUSEE");
  });
});

describe("KMZ", () => {
  it("nominal : lit uniquement l'entree KML principale ; les autres entrees sont comptees, jamais lues", () => {
    const b = kmzSimple(KML_UN, [{ nom: "images/icone.png", contenu: Buffer.from([0x89, 0x50]) }, { nom: "notes.txt", contenu: "ignore" }]);
    const r = lire(b, "reseau.kmz");
    expect(r.format).toBe("KMZ");
    expect(r.resume.nbObjets).toBe(1);
    expect(r.archive).toMatchObject({ nbEntrees: 3, kmlPrincipal: "doc.kml", entreesKml: ["doc.kml"], choixRequis: false });
    expect(r.importInfo.entreeKml).toBe("doc.kml");
    expect(r.avertissements).toContainEqual(expect.objectContaining({ code: "ENTREES_ARCHIVE_IGNOREES", nb: 2 }));
  });

  it("plusieurs KML : l'import refuse (KMZ_PLUSIEURS_KML) ; l'inventaire liste les entrees ; entreeKml choisit sans rien deviner", () => {
    const b = construireZip([{ nom: "a.kml", contenu: kml(pm("A", ligne("-10.1,9.2 -10.09,9.2"))) }, { nom: "b.kml", contenu: kml(pm("B", ligne("-10.1,9.3 -10.09,9.3"))) }]).buffer;
    expect(code(() => lire(b, "x.kmz"))).toBe("KMZ_PLUSIEURS_KML");
    const inv = inventorier(detecter(b, "x.kmz", {}, LIM, { inventaire: true }));
    expect(inv.archive).toMatchObject({ choixRequis: true, kmlPrincipal: null, entreesKml: ["a.kml", "b.kml"] });
    expect(inv.couches).toEqual([]);
    const r = lire(b, "x.kmz", { entreeKml: "b.kml" });
    expect(r.objets[0].nom).toBe("B");
    expect(code(() => lire(b, "x.kmz", { entreeKml: "c.kml" }))).toBe("ENTREE_KML_INTROUVABLE");
  });

  it("KMZ sans KML : KMZ_SANS_KML ; KML interne qui est une archive, du HTML ou du binaire : refus", () => {
    expect(code(() => lire(construireZip([{ nom: "notes.txt", contenu: "x" }]).buffer, "x.kmz"))).toBe("KMZ_SANS_KML");
    const interne = construireZip([{ nom: "doc.kml", contenu: construireZip([{ nom: "a", contenu: "b" }]).buffer }]).buffer;
    expect(code(() => lire(interne, "x.kmz"))).toBe("ARCHIVE_IMBRIQUEE");
    expect(code(() => lire(kmzSimple("<html><script>x</script></html>"), "x.kmz"))).toBe("CONTENU_NON_RECONNU");
    expect(code(() => lire(construireZip([{ nom: "doc.kml", contenu: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]) }]).buffer, "x.kmz"))).toBe("CONTENU_NON_RECONNU");
  });

  it("archive dangereuse ou corrompue : refus typé, jamais un 500", () => {
    expect(code(() => lire(construireZip([{ nom: "../doc.kml", contenu: KML_UN }]).buffer, "x.kmz"))).toBe("ARCHIVE_CHEMIN_DANGEREUX");
    const b = kmzSimple(KML_UN);
    expect(code(() => lire(b.subarray(0, b.length - 5), "x.kmz"))).toBe("ARCHIVE_INVALIDE");
    expect(code(() => lire(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), "x.kmz"))).toBe("ARCHIVE_INVALIDE");
  });
});

describe("GPX", () => {
  const GPX = `<?xml version="1.0"?><gpx version="1.1" creator="essai" xmlns="http://www.topografix.com/GPX/1/1">
    <wpt lat="9.2" lon="-10.1"><ele>350</ele><time>2026-11-01T10:00:00Z</time><name>Regard 1</name><desc>d</desc><sym>Flag</sym></wpt>
    <wpt lat="9.21" lon="-10.1"><name>Regard 2</name></wpt>
    <rte><name>Route R</name><rtept lat="9.2" lon="-10.1"/><rtept lat="9.2" lon="-10.09"><time>2026-11-01T10:01:00Z</time></rtept></rte>
    <trk><name>Trace T</name><trkseg><trkpt lat="9.2" lon="-10.1"><ele>1</ele><time>2026-11-01T10:00:00Z</time></trkpt><trkpt lat="9.2" lon="-10.099"><time>2026-11-01T10:00:05Z</time></trkpt></trkseg>
      <trkseg><trkpt lat="9.3" lon="-10.1"/><trkpt lat="9.3" lon="-10.099"/></trkseg></trk></gpx>`;
  it("waypoints, routes et traces : points, lignes, un objet par trace avec une ligne par segment ; WGS 84 sans choix de CRS", () => {
    const r = lire(GPX, "t.gpx");
    expect(r.format).toBe("GPX");
    expect(r.resume.parTypeGeom).toEqual({ POINT: 2, LIGNE: 2, POLYGONE: 0 });
    const trace = r.objets.find((o) => o.nom === "Trace T")!;
    expect(trace.geometrie.type).toBe("MultiLineString");
    expect((trace.geometrie.coordinates as unknown[]).length).toBe(2);
    expect(r.objets.find((o) => o.nom === "Route R")!.geometrie.type).toBe("LineString");
    expect(r.crs).toMatchObject({ epsgSource: 4326, transformation: "aucune", origine: "norme_du_format" });
    expect(r.crs.justification).toContain("GPX 1.1");
  });
  it("horodatages ignores (points de route et de trace) et signales ; l'altitude est ignoree et signalee ; le temps d'un waypoint reste un attribut", () => {
    const r = lire(GPX, "t.gpx");
    expect(r.avertissements).toContainEqual(expect.objectContaining({ code: "HORODATAGES_IGNORES", nb: 3 }));
    expect(r.avertissements).toContainEqual(expect.objectContaining({ code: "ALTITUDE_IGNOREE" }));
    expect(r.objets.find((o) => o.nom === "Regard 1")!.attributs).toMatchObject({ name: "Regard 1", desc: "d", sym: "Flag", time: "2026-11-01T10:00:00Z" });
    expect(JSON.stringify(r.objets.find((o) => o.nom === "Trace T")!.attributs)).not.toContain("2026");
  });
  it("inventaire par famille ; choix d'une couche ; couche inconnue refusee", () => {
    const inv = inventorier(detecter(Buffer.from(GPX), "t.gpx", {}, LIM));
    expect(inv.couches.map((c) => [c.id, c.nbObjets])).toEqual([["waypoints", 2], ["routes", 1], ["traces", 1]]);
    expect(inv.avertissements).toContainEqual(expect.objectContaining({ code: "COUCHES_MULTIPLES" }));
    const t = lire(GPX, "t.gpx", { couche: "traces" });
    expect(t.resume.nbObjets).toBe(1);
    expect(t.importInfo.couche).toEqual({ id: "traces", nom: "Traces" });
    expect(code(() => lire(GPX, "t.gpx", { couche: "autre" }))).toBe("COUCHE_INTROUVABLE");
    expect(lire(GPX, "t.gpx").avertissements).toContainEqual(expect.objectContaining({ code: "COUCHES_MULTIPLES", nb: 3 }));
  });
  it("latitude ou longitude illisible ou hors plage : l'element est ecarte et compte, pas lu de travers", () => {
    const r = lire(`<gpx><wpt lat="9.2" lon="-10.1"/><wpt lat="abc" lon="-10.1"/><wpt lat="95" lon="-10.1"/><wpt lat="9.2"/></gpx>`, "t.gpx");
    expect(r.resume.nbObjets).toBe(1);
    expect(r.avertissements).toContainEqual(expect.objectContaining({ code: "GEOMETRIES_INVALIDES_IGNOREES", nb: 3 }));
  });
  it("un GPX hors de la Guinee : HORS_GUINEE (latitude et longitude inversees)", () => {
    expect(code(() => lire(`<gpx><wpt lat="-10.1" lon="9.2"/></gpx>`, "t.gpx"))).toBe("HORS_GUINEE");
  });
});

describe("CRS : choisi par l'utilisateur, jamais devine", () => {
  const CSV = "id;x;y\nR1;380000;1015000\nR2;380110;1015110\n";
  const O = { colonneX: "x", colonneY: "y" };

  it("CSV sans epsgSource : CRS_REQUIS ; hors liste blanche : CRS_NON_AUTORISE ; liste blanche configurable", () => {
    expect(code(() => lire(CSV, "p.csv", { csv: O }))).toBe("CRS_REQUIS");
    expect(code(() => lire(CSV, "p.csv", { csv: O, epsgSource: 32630 }))).toBe("CRS_NON_AUTORISE");
    expect(code(() => lire(CSV, "p.csv", { csv: O, epsgSource: 4326 }, { ...LIM, crsAutorises: [32629] }))).toBe("CRS_NON_AUTORISE");
  });

  it("UTM 29N declare : transformation demandee, resultat en WGS 84, resume du CRS complet (source, cible, unites, methode, plausibilite)", () => {
    const r = lire(CSV, "p.csv", { csv: O, epsgSource: 32629 });
    expect(r.objets).toHaveLength(2);
    expect(r.objets[0].geometrie).toEqual({ type: "Point", coordinates: [-10, 9.2] });
    expect(r.crs).toMatchObject({
      source: "EPSG:32629 (WGS 84 / UTM zone 29N)", cible: "EPSG:4326", epsgSource: 32629, epsgCible: 4326, uniteSource: "metre", uniteCible: "degre",
      origine: "choisi_par_utilisateur", transformation: "ST_Transform", versionProj: "9.x.y",
    });
    expect(r.crs.methode).toBe("ST_Transform (PostGIS, PROJ 9.x.y)");
    expect(r.crs.plausibilite).toMatchObject({ statut: "CONFORME", nbElementsHorsZone: 0, nbObjets: 2, confirmationRequise: false });
    expect(r.crs.plausibilite.zoneAttendue.bbox).toEqual([-15.2, 7.1, -7.5, 12.8]);
    expect(r.crs.plausibilite.empriseResultat).toEqual(r.resume.bbox);
    expect(r.avertissements).toContainEqual(expect.objectContaining({ code: "CRS_CHOISI_PAR_UTILISATEUR" }));
  });

  it("CAS OBLIGATOIRE plan UTM 29N contre WGS 84 : des metres declares en degres sont refuses, avec le code qui dit pourquoi", () => {
    expect(code(() => lire(CSV, "p.csv", { csv: O, epsgSource: 4326 }))).toBe("CRS_INCOHERENT");
    const r = (() => { try { lire(CSV, "p.csv", { csv: O, epsgSource: 4326 }); return null; } catch (e) { return e as ErreurLecture; } })()!;
    expect(r.message).toContain("32629");
    // Le meme plan lu comme un fichier WGS 84 par GeoJSON sans CRS : aucune valeur n'est reinterpretee.
    expect(code(() => lire(geojson([feat({}, [380000, 1015000])]), "p.geojson"))).toBe("GEOMETRIE_INVALIDE");
    // Un KML WGS 84 reste lu tel quel et ne peut pas recevoir un CRS projete.
    expect(code(() => lire(KML_UN, "r.kml", { epsgSource: 32629 }))).toBe("CRS_INCOMPATIBLE_FORMAT");
    expect(code(() => lire(kmzSimple(KML_UN), "r.kmz", { epsgSource: 32629 }))).toBe("CRS_INCOMPATIBLE_FORMAT");
    expect(code(() => lire(`<gpx><wpt lat="9.2" lon="-10.1"/></gpx>`, "r.gpx", { epsgSource: 32628 }))).toBe("CRS_INCOMPATIBLE_FORMAT");
    expect(lire(KML_UN, "r.kml", { epsgSource: 4326 }).crs.origine).toBe("norme_du_format");
  });

  it("mauvaise zone UTM (la transformation du test envoie hors Guinee) : HORS_GUINEE, jamais contournable par la confirmation", () => {
    const loin = "id;x;y\nR1;900000;5000000\n";
    expect(code(() => lire(loin, "p.csv", { csv: O, epsgSource: 32629 }))).toBe("HORS_GUINEE");
    expect(code(() => lire(loin, "p.csv", { csv: O, epsgSource: 32629, confirmerHorsZone: true }))).toBe("HORS_GUINEE");
  });

  it("une partie des points hors zone : 409 CONFIRMATION_HORS_ZONE_REQUISE ; confirme, ils sont ecartes, comptes et jamais stockes", () => {
    const mixte = "id;x;y\nR1;380000;1015000\nR2;900000;5000000\nR3;380100;1015100\n";
    let erreur: ErreurMetier | null = null;
    try { lire(mixte, "p.csv", { csv: O, epsgSource: 32629 }); } catch (e) { erreur = e as ErreurMetier; }
    expect(erreur).toMatchObject({ status: 409, code: "CONFIRMATION_HORS_ZONE_REQUISE", extra: { nbElementsHorsZone: 1, nbObjets: 2 } });
    const r = lire(mixte, "p.csv", { csv: O, epsgSource: 32629, confirmerHorsZone: true });
    expect(r.resume.nbObjets).toBe(2);
    expect(r.crs.plausibilite).toMatchObject({ statut: "PARTIELLEMENT_HORS_ZONE", nbElementsHorsZone: 1, confirmationRequise: true, confirmee: true });
    expect(r.avertissements).toContainEqual(expect.objectContaining({ code: "ELEMENTS_HORS_GUINEE", nb: 1 }));
    // Rapport par element ecarte : numero dans le fichier, code, message fixe sans coordonnee.
    expect(r.ecartes).toEqual([expect.objectContaining({ element: 2, code: "COORDONNEES_HORS_ZONE" })]);
    expect(JSON.stringify(r.ecartes)).not.toMatch(/900000|5000000|900100/);
  });

  it("rapport des elements ecartes d'un KML : hors Guinee et geometrie inexploitable, numero d'element et nom, borne a 50", () => {
    const corps = pm("Bon", ligne("-10.1,9.2 -10.09,9.2")) + pm("Loin", ligne("-30,9.2 -29.9,9.2")) + pm("Court", ligne("-10.1,9.3")) + pm("Autre bon", ligne("-10.1,9.4 -10.09,9.4"));
    const r = lire(kml(corps), "r.kml");
    expect(r.ecartes).toEqual([
      expect.objectContaining({ element: 2, nom: "Loin", code: "COORDONNEES_HORS_ZONE" }),
      expect.objectContaining({ element: 3, nom: "Court", code: "GEOMETRIE_INVALIDE" }),
    ]);
    const beaucoup = Array.from({ length: 80 }, (_, i) => pm(`L${i}`, ligne("-30,9.2 -29.9,9.2"))).join("") + pm("Bon", ligne("-10.1,9.2 -10.09,9.2"));
    const b = lire(kml(beaucoup), "r.kml");
    expect(b.ecartes).toHaveLength(50);
    expect(b.avertissements).toContainEqual(expect.objectContaining({ code: "ELEMENTS_HORS_GUINEE", nb: 80 }));
  });

  it("un CSV en WGS 84 (4326 choisi) suit la meme regle de confirmation ; un KML garde le comportement historique (ecarte, avertit, sans confirmation)", () => {
    const csv = "id,lon,lat\nA,-10.1,9.2\nB,-30,9.2\n";
    expect(code(() => lire(csv, "p.csv", { csv: { colonneX: "lon", colonneY: "lat" }, epsgSource: 4326 }))).toBe("CONFIRMATION_HORS_ZONE_REQUISE");
    expect(lire(csv, "p.csv", { csv: { colonneX: "lon", colonneY: "lat" }, epsgSource: 4326, confirmerHorsZone: true }).resume.nbObjets).toBe(1);
    const r = lire(kml(pm("A", ligne("-10.1,9.2 -10.09,9.2")) + pm("Loin", ligne("-30,9.2 -29.9,9.2"))), "r.kml");
    expect(r.resume.nbObjets).toBe(1);
    expect(r.crs.plausibilite).toMatchObject({ statut: "PARTIELLEMENT_HORS_ZONE", nbElementsHorsZone: 1, confirmationRequise: false });
  });

  it("des coordonnees illisibles (NaN, hors domaine) ne partent jamais a la base : elles sont marquees invalides et l'objet est ecarte", () => {
    const p = preparer(detecter(Buffer.from("id;x;y\nA;380000;1015000\nB;1e300;5\n"), "p.csv", { csv: O, epsgSource: 32629 }, LIM), { csv: O, epsgSource: 32629 }, LIM);
    expect(Array.from(p.sommets!.invalide)).toEqual([0, 1]);
    expect(Array.from(p.sommets!.x)).toEqual([380000, 0]);
  });

  it("GeoJSON : membre crs projete exige la confirmation du meme code ; code different : CRS_CONFLIT ; WGS 84 declare + autre code : CRS_CONFLIT ; non EPSG : CRS_NON_SUPPORTE", () => {
    const projete = (name: string) => geojson([feat({}, [380000, 1015000])], { crs: { type: "name", properties: { name } } });
    expect(code(() => lire(projete("urn:ogc:def:crs:EPSG::32629"), "a.geojson"))).toBe("CRS_REQUIS");
    expect(code(() => lire(projete("urn:ogc:def:crs:EPSG::32629"), "a.geojson", { epsgSource: 32628 }))).toBe("CRS_CONFLIT");
    expect(lire(projete("EPSG:32629"), "a.geojson", { epsgSource: 32629 }).crs).toMatchObject({ transformation: "ST_Transform", epsgSource: 32629 });
    expect(code(() => lire(projete("urn:ogc:def:crs:OGC:1.3:CRS83"), "a.geojson", { epsgSource: 32629 }))).toBe("CRS_NON_SUPPORTE");
    const wgs = geojson([feat({}, [-10.1, 9.2])], { crs: { type: "name", properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" } } });
    expect(code(() => lire(wgs, "a.geojson", { epsgSource: 32629 }))).toBe("CRS_CONFLIT");
    expect(lire(wgs, "a.geojson").crs.transformation).toBe("aucune");
  });

  it("GeoJSON sans membre crs : WGS 84 par la RFC 7946 ; un CRS projete peut etre choisi explicitement (liste blanche)", () => {
    const g = geojson([feat({ name: "P" }, [380000, 1015000])]);
    const r = lire(g, "a.geojson", { epsgSource: 32629 });
    expect(r.crs).toMatchObject({ origine: "choisi_par_utilisateur", transformation: "ST_Transform" });
    expect(code(() => lire(g, "a.geojson", { epsgSource: 32630 }))).toBe("CRS_NON_AUTORISE");
    expect(lire(geojson([feat({}, [-10.1, 9.2])]), "a.geojson").crs).toMatchObject({ origine: "norme_du_format", source: "WGS84 (EPSG:4326)", methode: "aucune transformation" });
  });
});

describe("couches et inventaire", () => {
  const KML_COUCHES = kml(
    pm("Hors dossier", ligne("-10.1,9.2 -10.09,9.2")) +
    `<Folder><name>Fibre</name>${pm("F1", ligne("-10.1,9.3 -10.09,9.3"))}${pm("F2", ligne("-10.1,9.31 -10.09,9.31"))}<Folder><name>Sous</name>${pm("F3", `<Point><coordinates>-10.1,9.4</coordinates></Point>`)}</Folder></Folder>` +
    `<Folder><name>Eau</name>${pm("E1", ligne("-10.1,9.5 -10.09,9.5"))}</Folder>`,
  );
  it("inventaire KML : une couche par chemin de dossier (racine comprise), comptes et familles de geometrie ; les coordonnees ne sont pas controlees", () => {
    const inv = inventorier(detecter(Buffer.from(KML_COUCHES), "r.kml", {}, LIM));
    expect(inv.couches.map((c) => [c.id, c.nom, c.nbObjets])).toEqual([["c0", "(racine du document)", 1], ["c1", "Fibre", 2], ["c2", "Fibre / Sous", 1], ["c3", "Eau", 1]]);
    expect(inv.couches[2].parTypeGeom).toEqual({ POINT: 1, LIGNE: 0, POLYGONE: 0 });
    expect(inv.avertissements).toContainEqual(expect.objectContaining({ code: "COUCHES_MULTIPLES" }));
    expect(inv.crs).toEqual({ normeDuFormat: "EPSG:4326", declareDansLeFichier: null, choixObligatoire: false });
    // Fichier entierement hors Guinee : il s'inventorie quand meme.
    const hors = inventorier(detecter(Buffer.from(kml(pm("X", ligne("100,10 101,10")))), "r.kml", {}, LIM));
    expect(hors.couches[0].nbObjets).toBe(1);
  });
  it("import d'une couche choisie : seuls ses objets sont lus ; sans choix, tout (avertissement COUCHES_MULTIPLES) ; couche inconnue : COUCHE_INTROUVABLE", () => {
    const r = lire(KML_COUCHES, "r.kml", { couche: "c1" });
    expect(r.objets.map((o) => o.nom)).toEqual(["F1", "F2"]);
    expect(r.importInfo.couche).toEqual({ id: "c1", nom: "Fibre" });
    expect(lire(KML_COUCHES, "r.kml").resume.nbObjets).toBe(5);
    expect(code(() => lire(KML_COUCHES, "r.kml", { couche: "c9" }))).toBe("COUCHE_INTROUVABLE");
  });
  it("GeoJSON et CSV : une seule couche, c0", () => {
    const g = geojson([feat({ name: "A" }, [-10.1, 9.2])]);
    expect(inventorier(detecter(Buffer.from(g), "a.geojson", {}, LIM)).couches).toEqual([expect.objectContaining({ id: "c0", nom: "(fichier entier)", nbObjets: 1 })]);
    expect(lire(g, "a.geojson", { couche: "c0" }).resume.nbObjets).toBe(1);
    expect(code(() => lire(g, "a.geojson", { couche: "c1" }))).toBe("COUCHE_INTROUVABLE");
  });
  it("inventaire CSV : delimiteur, encodage, colonnes avec exemples, echantillon, suggestions de mapping (a confirmer, jamais appliquees)", () => {
    const inv = inventorier(detecter(Buffer.from("Libelle;Code;X;Y\nRegard A;R1;380000;1015000\nRegard B;R2;380100;1015100\n"), "p.csv", {}, LIM));
    expect(inv.format).toBe("CSV");
    expect(inv.couches).toEqual([]);
    expect(inv.csv).toMatchObject({ delimiteur: ";", delimiteurDetecte: true, encodage: "utf-8", nbLignes: 2 });
    expect(inv.csv!.colonnes.map((c) => c.nom)).toEqual(["Libelle", "Code", "X", "Y"]);
    expect(inv.csv!.colonnes[0].exemples).toEqual(["Regard A", "Regard B"]);
    expect(inv.crs).toEqual({ normeDuFormat: null, declareDansLeFichier: null, choixObligatoire: true });
    expect(inv.suggestionsMapping).toEqual({ nom: "Libelle", identifiant: "Code" });
    // Non applique : sans mapping, aucun objet n'a de nom.
    expect(lire("Libelle;X;Y\nA;380000;1015000\n", "p.csv", { csv: { colonneX: "X", colonneY: "Y" }, epsgSource: 32629 }).objets[0].nom).toBeNull();
  });
});

describe("mapping de champs", () => {
  const G = geojson([
    feat({ Libelle: "Regard 1", Type: "telecom", Precision: "B", Operateur: "Op A", Prec: "1,5" }, [-10.1, 9.2]),
    feat({ Libelle: "Regard 2", Type: "telecom", Precision: "B", Operateur: "Op A", Prec: "1,5" }, [-10.1, 9.21]),
  ]);
  it("liste blanche des champs cibles : champ inconnu, JSON invalide, valeur non textuelle, NUL, trop long : MAPPING_INVALIDE", () => {
    expect(analyserMapping('{"nom":"Libelle","identifiant":"Code"}')).toEqual({ nom: "Libelle", identifiant: "Code" });
    for (const t of ['{"geom":"x"}', '{"__proto__":"x"}', "pas du json", "[]", '{"nom":3}', '{"nom":""}', `{"nom":"a\\u0000b"}`, `{"nom":"${"a".repeat(201)}"}`, `{"x":"${"a".repeat(4001)}"}`]) {
      expect(code(() => analyserMapping(t)), t.slice(0, 30)).toBe("MAPPING_INVALIDE");
    }
  });
  it("`nom` renomme les objets depuis la colonne ; les propositions de champs du jeu portent la valeur UNIQUE, validee ; rien n'est invente", () => {
    const r = lire(G, "a.geojson", { mapping: { nom: "Libelle", typeReseau: "Type", classePrecision: "Precision", precisionHorizontaleM: "Prec", concessionnaire: "Operateur" } });
    expect(r.objets.map((o) => o.nom)).toEqual(["Regard 1", "Regard 2"]);
    expect(r.propositionsJeu).toEqual({
      typeReseau: { valeur: "TELECOM", colonne: "Type" }, classePrecision: { valeur: "B", colonne: "Precision" },
      precisionHorizontaleM: { valeur: 1.5, colonne: "Prec" }, concessionnaire: { valeur: "Op A", colonne: "Operateur" },
    });
    expect(lire(G, "a.geojson").propositionsJeu).toEqual({});
  });
  it("plusieurs valeurs distinctes : rien n'est propose (un jeu n'a qu'une valeur) ; valeur invalide ou colonne vide : avertissement", () => {
    const g = geojson([feat({ T: "TELECOM", C: "Z", P: "-3", V: "" }, [-10.1, 9.2]), feat({ T: "EAU_POTABLE", C: "Z", P: "-3", V: "" }, [-10.1, 9.21])]);
    const r = lire(g, "a.geojson", { mapping: { typeReseau: "T", classePrecision: "C", precisionVerticaleM: "P", methode: "V" } });
    expect(r.propositionsJeu).toEqual({});
    const codes = r.avertissements.map((a) => a.code);
    expect(codes).toContain("MAPPING_VALEURS_MULTIPLES");
    expect(codes.filter((c) => c === "MAPPING_VALEUR_INCONNUE")).toHaveLength(2);
    expect(codes).toContain("MAPPING_CHAMP_IGNORE");
  });
  it("une colonne source absente du fichier : MAPPING_COLONNE_INTROUVABLE (CSV : avant toute lecture ; autres formats : sur la couche choisie)", () => {
    expect(code(() => lire(G, "a.geojson", { mapping: { nom: "Absente" } }))).toBe("MAPPING_COLONNE_INTROUVABLE");
    expect(code(() => lire("a;x;y\n1;2;3\n", "p.csv", { csv: { colonneX: "x", colonneY: "y" }, epsgSource: 4326, mapping: { nom: "zzz" } }))).toBe("MAPPING_COLONNE_INTROUVABLE");
  });
  it("la classe de precision n'est JAMAIS inventee : sans mapping, aucune proposition ; hors A a E, rien", () => {
    const g = geojson([feat({ classe: "Z" }, [-10.1, 9.2])]);
    expect(lire(g, "a.geojson", { mapping: { classePrecision: "classe" } }).propositionsJeu.classePrecision).toBeUndefined();
    expect(lire(geojson([feat({ classe: "c" }, [-10.1, 9.2])]), "a.geojson", { mapping: { classePrecision: "classe" } }).propositionsJeu.classePrecision).toEqual({ valeur: "C", colonne: "classe" });
  });
});
