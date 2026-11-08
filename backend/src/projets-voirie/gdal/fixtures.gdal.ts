/**
 * Fabrique de donnees SYNTHETIQUES pour les tests de la conversion GDAL (jamais importee par le code de production) : sorties du conteneur dans la mise en
 * forme reelle de GDAL (une Feature par ligne), resultat.json valides, DXF texte construit a la main. Aucune donnee reelle : coordonnees inventees autour de
 * l'UTM 29N (500000, 1200000) et de (-9,0 ; 10,855) en WGS 84.
 */
import type { ResultatWorker } from "./sortie.noyau";

export const SHA_A = "a".repeat(64);

export type Props = Record<string, unknown>;
export interface FeatureSpec { props?: Props; geom: unknown | null }

/** Texte d'une couche tel que GDAL 3.13 l'ecrit avec `RFC7946=NO`, `WRITE_NAME=NO`, `WRITE_BBOX=NO` (CRS84 ou aucun membre `crs`). */
export function texteCouche(features: FeatureSpec[], o: { crs?: "CRS84" | "EPSG4326" | null; resolution?: boolean } = {}): string {
  const crs = o.crs === undefined ? "CRS84" : o.crs;
  const lignes = ["{", '"type": "FeatureCollection",'];
  if (crs === "CRS84") lignes.push('"crs": { "type": "name", "properties": { "name": "urn:ogc:def:crs:OGC:1.3:CRS84" } },');
  if (crs === "EPSG4326") lignes.push('"crs": { "type": "name", "properties": { "name": "urn:ogc:def:crs:EPSG::4326" } },');
  if (o.resolution !== false) lignes.push('"xy_coordinate_resolution": 1e-09,');
  lignes.push('"features": [');
  features.forEach((f, i) => {
    lignes.push(`{"type":"Feature","properties":${JSON.stringify(f.props ?? {})},"geometry":${JSON.stringify(f.geom)}}${i < features.length - 1 ? "," : ""}`);
  });
  lignes.push("]", "}", "");
  return lignes.join("\n");
}

export const ligne = (...pts: [number, number][]) => ({ type: "LineString", coordinates: pts });
export const point = (x: number, y: number) => ({ type: "Point", coordinates: [x, y] });

/** Deux lignes de la region de Kissidougou-independante (WGS 84, degres) : Axe A (3 sommets) et Axe B (2 sommets). */
export const DEUX_AXES: FeatureSpec[] = [
  { props: { nom: "Axe A", n: 1 }, geom: ligne([-9.0, 10.855481222], [-8.999085058, 10.855933425], [-8.998170117, 10.85584298]) },
  { props: { nom: "Axe B", n: 1 }, geom: ligne([-9.0, 10.856385631], [-8.998627584, 10.85656651]) },
];

/** `resultat.json` d'un job termine, valide (mise en forme du worker 0.2.0). `surcharge` remplace des cles de premier niveau. */
export function resultatValide(o: {
  spoolId: string; format?: "GPKG" | "ZIP" | "DXF"; sha256?: string; octets?: number; slug?: string; nbObjets?: number; octetsCouche?: number;
  crsSource?: { origine: "fichier" | "demande"; epsg: number | null; nom: string | null } | null; coordonnees?: "wgs84" | "brutes"; dxf?: ResultatWorker["dxf"];
  surcharge?: Record<string, unknown>;
}): Record<string, unknown> {
  const famille = o.format ?? "GPKG";
  const coordonnees = o.coordonnees ?? "wgs84";
  const slug = o.slug ?? "axes";
  return {
    versionContrat: 1, jobId: o.spoolId, statut: "termine", code: null, message: null, details: {},
    source: { nom: `fichier.${famille === "ZIP" ? "zip" : famille.toLowerCase()}`, octets: o.octets ?? 1000, sha256: o.sha256 ?? SHA_A },
    format: { famille, pilote: famille === "ZIP" ? "ESRI Shapefile" : famille, detection: "contenu", extensionDeclaree: "gpkg", extensionCoherente: true },
    dxf: o.dxf ?? null,
    couches: [{
      nom: slug, fichier: `couches/${slug}.geojson`, octets: o.octetsCouche ?? 499, nbObjets: o.nbObjets ?? 2, typesGeometrieReels: { LineString: o.nbObjets ?? 2 }, sommets: 5,
      emprise: [-9, 10.855481222, -8.998170117, 10.85656651],
      crs: coordonnees === "wgs84" ? { epsg: 4326, nom: "WGS 84" } : null, reprojete: coordonnees === "wgs84",
      crsSource: o.crsSource === undefined ? { origine: "fichier", epsg: 32629, nom: "WGS 84 / UTM zone 29N" } : o.crsSource, coordonnees, avertissements: [],
    }],
    avertissements: [],
    limitesAppliquees: { taille_entree_octets: 26214400, entrees_archive_max: 200, taille_decompressee_octets: 262144000, taux_compression_max: 100, objets_max: 50000, couches_max: 50, champs_max: 500, sortie_octets_max: 83886080, delai_s: 90 },
    mesures: { dureeMs: 1200, etapes: [{ etape: "ogrinfo", dureeMs: 189, picMemoireKo: 51116 }], picMemoireWorkerKo: 29948 },
    gdal: { version: "3.13.3", proj: "9.8.1", pilotesActifs: ["DXF", "ESRI Shapefile", "GPKG", "GeoJSON"] },
    ...(o.surcharge ?? {}),
  };
}

// ------------------------------------------------------------------------------------------------ DXF texte construit a la main

const g = (code: number, val: string | number): string => `${String(code).padStart(3, " ")}\n${val}\n`;

export interface OptionsDxf {
  /** Code de $INSUNITS ; `null` : variable absente. */
  insunits?: number | null;
  version?: string;
  /** Origine UTM (metres) de tous les objets. */
  origine?: [number, number];
  /** Ajoute une ligne en espace papier (ignoree et comptee). */
  espacePapier?: boolean;
  /** Ajoute un calque a nom accentue en ANSI_1252 (octet 0xE9). */
  calqueAccentue?: boolean;
}

/**
 * DXF texte (AC1015 par defaut) : 2 LINE, 1 LWPOLYLINE, 1 POLYLINE 2D, 1 POLYLINE 3D, et des entites IGNOREES (TEXT, MTEXT, POINT, CIRCLE, ARC, HATCH,
 * INSERT avec sa definition de bloc), sur les calques AXES et RESEAU. Attendu : 5 entites retenues, 8 ignorees (+ 1 en espace papier si demande).
 */
export function dxfMixte(o: OptionsDxf = {}): Buffer {
  const [ox, oy] = o.origine ?? [500000, 1200000];
  let s = g(0, "SECTION") + g(2, "HEADER") + g(9, "$ACADVER") + g(1, o.version ?? "AC1015");
  if (o.calqueAccentue) s += g(9, "$DWGCODEPAGE") + g(3, "ANSI_1252");
  if (o.insunits !== null) s += g(9, "$INSUNITS") + g(70, o.insunits ?? 6);
  s += g(0, "ENDSEC");
  s += g(0, "SECTION") + g(2, "BLOCKS") + g(0, "BLOCK") + g(8, "0") + g(2, "BLK1") + g(70, 0) + g(10, 0) + g(20, 0) + g(30, 0) + g(3, "BLK1");
  s += g(0, "LINE") + g(8, "0") + g(10, 0) + g(20, 0) + g(30, 0) + g(11, 10) + g(21, 0) + g(31, 0) + g(0, "ENDBLK") + g(8, "0") + g(0, "ENDSEC");
  s += g(0, "SECTION") + g(2, "ENTITIES");
  const L = (h: string, calque: string, x1: number, y1: number, x2: number, y2: number) =>
    g(0, "LINE") + g(5, h) + g(8, calque) + g(10, ox + x1) + g(20, oy + y1) + g(30, 0) + g(11, ox + x2) + g(21, oy + y2) + g(31, 0);
  s += L("A1", "AXES", 0, 0, 100, 50) + L("A2", "AXES", 100, 50, 200, 40);
  s += g(0, "LWPOLYLINE") + g(5, "A3") + g(100, "AcDbEntity") + g(8, "AXES") + g(100, "AcDbPolyline") + g(90, 3) + g(70, 0);
  for (const [x, y] of [[0, 100], [80, 120], [160, 100]]) s += g(10, ox + x) + g(20, oy + y);
  s += g(0, "POLYLINE") + g(5, "A4") + g(8, "RESEAU") + g(66, 1) + g(70, 0) + g(10, 0) + g(20, 0) + g(30, 0);
  for (const [x, y] of [[0, 200], [50, 210], [100, 200]]) s += g(0, "VERTEX") + g(8, "RESEAU") + g(10, ox + x) + g(20, oy + y) + g(30, 0);
  s += g(0, "SEQEND") + g(8, "RESEAU");
  s += g(0, "POLYLINE") + g(5, "A5") + g(8, "RESEAU") + g(66, 1) + g(70, 8) + g(10, 0) + g(20, 0) + g(30, 0);
  for (const [x, y, z] of [[0, 300, 5], [50, 310, 6], [100, 300, 7]]) s += g(0, "VERTEX") + g(8, "RESEAU") + g(10, ox + x) + g(20, oy + y) + g(30, z) + g(70, 32);
  s += g(0, "SEQEND") + g(8, "RESEAU");
  s += g(0, "TEXT") + g(5, "B1") + g(8, "RESEAU") + g(10, ox) + g(20, oy + 10) + g(30, 0) + g(40, 2.5) + g(1, "Regard R1");
  s += g(0, "MTEXT") + g(5, "B2") + g(100, "AcDbEntity") + g(8, "RESEAU") + g(100, "AcDbMtext") + g(10, ox) + g(20, oy + 20) + g(30, 0) + g(40, 2.5) + g(1, "Note");
  s += g(0, "POINT") + g(5, "B3") + g(8, "RESEAU") + g(10, ox + 5) + g(20, oy + 5) + g(30, 0);
  s += g(0, "CIRCLE") + g(5, "B4") + g(8, "RESEAU") + g(10, ox + 20) + g(20, oy + 20) + g(30, 0) + g(40, 5);
  s += g(0, "ARC") + g(5, "B5") + g(8, "RESEAU") + g(10, ox + 40) + g(20, oy + 20) + g(30, 0) + g(40, 5) + g(50, 0) + g(51, 90);
  s += g(0, "INSERT") + g(5, "B6") + g(8, "RESEAU") + g(2, "BLK1") + g(10, ox + 300) + g(20, oy + 300) + g(30, 0);
  s += g(0, "HATCH") + g(5, "B7") + g(100, "AcDbEntity") + g(8, "AXES") + g(100, "AcDbHatch") + g(10, 0) + g(20, 0) + g(30, 0) + g(210, 0) + g(220, 0) + g(230, 1)
    + g(2, "SOLID") + g(70, 1) + g(71, 0) + g(91, 1) + g(92, 1) + g(93, 4);
  const aretes: [[number, number], [number, number]][] = [[[0, 0], [30, 0]], [[30, 0], [30, 30]], [[30, 30], [0, 30]], [[0, 30], [0, 0]]];
  for (const [a, b] of aretes) s += g(72, 1) + g(10, ox + a[0]) + g(20, oy + a[1]) + g(11, ox + b[0]) + g(21, oy + b[1]);
  s += g(97, 0) + g(75, 0) + g(76, 1) + g(98, 0);
  if (o.espacePapier) s += g(0, "LINE") + g(5, "P1") + g(67, 1) + g(8, "AXES") + g(10, 0) + g(20, 0) + g(30, 0) + g(11, 10) + g(21, 10) + g(31, 0);
  s += g(0, "ENDSEC") + g(0, "EOF");
  if (!o.calqueAccentue) return Buffer.from(s, "latin1");
  // Calque « Réseau » en cp1252 (octet 0xE9) pour une LINE supplementaire.
  const entites = g(0, "LINE") + g(5, "C1") + "  8\nRéseau\n" + g(10, ox) + g(20, oy + 400) + g(30, 0) + g(11, ox + 10) + g(21, oy + 400) + g(31, 0);
  return Buffer.from(s.replace(g(0, "ENDSEC") + g(0, "EOF"), entites + g(0, "ENDSEC") + g(0, "EOF")), "latin1");
}

export const ATTENDU_DXF_MIXTE = {
  lues: { "3DPOLYLINE": 1, LINE: 2, LWPOLYLINE: 1, POLYLINE: 1 },
  ignorees: { ARC: 1, CIRCLE: 1, HATCH: 1, INSERT: 1, MTEXT: 1, POINT: 1, TEXT: 1 },
  nbRetenues: 5,
} as const;
