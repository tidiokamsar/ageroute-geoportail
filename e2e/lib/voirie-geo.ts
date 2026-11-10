import zlib from "node:zlib";

/**
 * Geometrie SYNTHETIQUE des scenarios « Projets de voirie et reseaux » : des segments inventes, construits en METRES dans le repere UTM 29N
 * a partir d'une origine arbitraire, puis convertis en WGS 84 par une formule INDEPENDANTE de l'application (series de Kruger, sans PROJ ni
 * PostGIS). Cette independance est voulue : le test « le plan UTM se superpose au KML WGS 84 a moins de 5 cm » compare la transformation de
 * l'application (PostGIS/PROJ) a un oracle qui n'en partage aucun code.
 *
 * Aucune donnee reelle : ni le plan, ni les fichiers d'un concessionnaire. L'origine est un point quelconque de la Guinee.
 */

/** Origine arbitraire des plans synthetiques, en UTM 29N (metres). Environ 9,13 N, 9,9 O : dans la Guinee, loin de tout lieu nomme. */
export const ORIGINE = { x: 412_000, y: 1_010_000 } as const;

export type Point = [number, number];
export interface Ligne { nom: string; coords: Point[]; props?: Record<string, string | number> }

// ------------------------------------------------------------------------------------------------ UTM 29N -> WGS 84 (series de Kruger)

const A = 6378137;
const F = 1 / 298.257223563;
const K0 = 0.9996;
const E0 = 500_000;
const LON0_DEG = -9; // meridien central du fuseau 29
const N = F / (2 - F);

const n2 = N * N, n3 = n2 * N, n4 = n3 * N, n5 = n4 * N, n6 = n5 * N;
const AA = (A / (1 + N)) * (1 + n2 / 4 + n4 / 64 + n6 / 256);
const BETA = [
  N / 2 - (2 * n2) / 3 + (37 * n3) / 96 - n4 / 360 - (81 * n5) / 512 + (96199 * n6) / 604800,
  n2 / 48 + n3 / 15 - (437 * n4) / 1440 + (46 * n5) / 105 - (1118711 * n6) / 3870720,
  (17 * n3) / 480 - (37 * n4) / 840 - (209 * n5) / 4480 + (5569 * n6) / 90720,
  (4397 * n4) / 161280 - (11 * n5) / 504 - (830251 * n6) / 7257600,
];
const DELTA = [
  2 * N - (2 * n2) / 3 - 2 * n3 + (116 * n4) / 45 + (26 * n5) / 45 - (2854 * n6) / 675,
  (7 * n2) / 3 - (8 * n3) / 5 - (227 * n4) / 45 + (2704 * n5) / 315 + (2323 * n6) / 945,
  (56 * n3) / 15 - (136 * n4) / 35 - (1262 * n5) / 105 + (73814 * n6) / 2835,
  (4279 * n4) / 630 - (332 * n5) / 35 - (399572 * n6) / 14175,
];

/** UTM 29N (est, nord en metres, hemisphere nord) vers [longitude, latitude] en degres WGS 84. */
export function utm29nVersWgs84(x: number, y: number): Point {
  const xi = y / (K0 * AA);
  const eta = (x - E0) / (K0 * AA);
  let xiP = xi, etaP = eta;
  for (let j = 1; j <= 4; j++) {
    xiP -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etaP -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xiP) / Math.cosh(etaP));
  let phi = chi;
  for (let j = 1; j <= 4; j++) phi += DELTA[j - 1] * Math.sin(2 * j * chi);
  const lam = (LON0_DEG * Math.PI) / 180 + Math.atan2(Math.sinh(etaP), Math.cos(xiP));
  return [(lam * 180) / Math.PI, (phi * 180) / Math.PI];
}

/** Metres locales (relatifs a ORIGINE) vers UTM 29N absolu. */
export const versUtm = ([dx, dy]: Point): Point => [ORIGINE.x + dx, ORIGINE.y + dy];
/** Metres locales vers [longitude, latitude] WGS 84. */
export const versWgs84 = (p: Point): Point => { const [x, y] = versUtm(p); return utm29nVersWgs84(x, y); };

/** Distance en metres entre deux positions WGS 84 voisines (quelques km au plus) : plan local, erreur negligeable devant 1 mm a cette echelle. */
export function distanceMetres(a: Point, b: Point): number {
  const latMoy = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  // Rayons de courbure du meridien et du parallele (ellipsoide WGS 84).
  const e2 = F * (2 - F);
  const s = Math.sin(latMoy);
  const w = Math.sqrt(1 - e2 * s * s);
  const mParDegLat = (Math.PI / 180) * ((A * (1 - e2)) / (w * w * w));
  const mParDegLon = (Math.PI / 180) * ((A * Math.cos(latMoy)) / w);
  return Math.hypot((b[0] - a[0]) * mParDegLon, (b[1] - a[1]) * mParDegLat);
}

// ------------------------------------------------------------------------------------------------ Jeux de lignes du scenario de conflits

/** Plan d'axes : A (200 m) et B (150 m) forment un carrefour en (200, 0) ; C est a 600 m au nord, hors de tout reseau. */
export const AXES: Ligne[] = [
  { nom: "Axe A", coords: [[0, 0], [200, 0]] },
  { nom: "Axe B", coords: [[200, 0], [200, 150]] },
];
export const AXE_ISOLE: Ligne = { nom: "Axe C", coords: [[0, 600], [200, 600]] };

/**
 * Reseau d'un concessionnaire de telecommunications. Largeur de chaussee 7 m (demi 3,5), emprise 15 m (demi 7,5), valeurs par defaut du module :
 *   L2 a 2 m de l'axe A (en chaussee), L6 a 6 m (emprise hors chaussee), P perpendiculaire a l'axe A en x=150 (croise l'axe), K a 5 m du carrefour.
 * L2 bis et L2 ter reprennent la trace de L2 (sens inverse compris) : trois circuits sur un meme trace.
 */
export const RESEAU_TELECOM: Ligne[] = [
  { nom: "Fibre-Synth L2", coords: [[20, 2], [80, 2]], props: { circuit: "C1" } },
  { nom: "Fibre-Synth L6", coords: [[20, 6], [80, 6]], props: { circuit: "C2" } },
  { nom: "Fibre-Synth L2 bis", coords: [[20, 2], [80, 2]], props: { circuit: "C3" } },
  { nom: "Fibre-Synth L2 ter", coords: [[80, 2], [20, 2]], props: { circuit: "C4" } },
  { nom: "Fibre-Synth P", coords: [[150, -20], [150, 20]], props: { circuit: "C5" } },
  { nom: "Fibre-Synth K", coords: [[195, 5], [205, 5]], props: { circuit: "C6" } },
];

/**
 * Reseau de gaz dont l'emprise englobante (x -10 a 210, y -100 a 10) contient l'axe A mais NI l'axe B NI l'axe C : il sert a prouver qu'un axe sans
 * couverture donne « zone a investiguer ». Aucun de ses objets n'est pres d'un axe.
 */
export const RESEAU_GAZ: Ligne[] = [
  { nom: "Gaz-Synth Z1", coords: [[-10, -100], [210, -100]] },
  { nom: "Gaz-Synth Z2", coords: [[-10, -100], [-10, 10]] },
];

/**
 * Trois circuits logiques superposes (meme trace, y compris en sens inverse) + une infrastructure physique de meme trace + un cable physique
 * isole. Sert au comptage par nature (KIS-LOGIC-01) : le nombre d'infrastructures, la somme des circuits et la longueur de trace fusionnee
 * sont trois nombres distincts.
 */
export const CIRCUITS_SUPERPOSES: Ligne[] = [
  { nom: "Circuit-Synth 1", coords: [[0, 40], [100, 40]] },
  { nom: "Circuit-Synth 2", coords: [[0, 40], [100, 40]] },
  { nom: "Circuit-Synth 3", coords: [[100, 40], [0, 40]] },
];
export const CABLE_PHYSIQUE: Ligne[] = [
  { nom: "Fourreau-Synth 1", coords: [[0, 40], [100, 40]] },
  { nom: "Fourreau-Synth 2", coords: [[0, 80], [100, 80]] },
];

// ------------------------------------------------------------------------------------------------ Emprises de territoires (lot T1), synthetiques

/** Boite [ouest, sud, est, nord] en degres WGS 84 d'un rectangle donne en metres locaux (relatifs a ORIGINE). */
export function boiteWgs84(dxMin: number, dyMin: number, dxMax: number, dyMax: number): [number, number, number, number] {
  const coins = [versWgs84([dxMin, dyMin]), versWgs84([dxMax, dyMin]), versWgs84([dxMax, dyMax]), versWgs84([dxMin, dyMax])];
  const lon = coins.map((c) => c[0]), lat = coins.map((c) => c[1]);
  return [Math.min(...lon), Math.min(...lat), Math.max(...lon), Math.max(...lat)];
}

/** Polygone GeoJSON (WGS 84, anneau ferme, sens trigonometrique) d'une boite [ouest, sud, est, nord]. */
export function polygoneDeBoite([o, s, e, n]: [number, number, number, number]): { type: "Polygon"; coordinates: number[][][] } {
  return { type: "Polygon", coordinates: [[[o, s], [e, s], [e, n], [o, n], [o, s]]] };
}

// ------------------------------------------------------------------------------------------------ Construction de fichiers

const echapperXml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** GeoJSON (WGS 84) d'un ensemble de lignes locales. `decalage` deplace tout le jeu (metres), pour fabriquer des fichiers distincts. */
export function geojson(lignes: Ligne[], decalage: Point = [0, 0]): Buffer {
  const features = lignes.map((l) => ({
    type: "Feature",
    properties: { name: l.nom, ...(l.props ?? {}) },
    geometry: { type: "LineString", coordinates: l.coords.map(([x, y]) => versWgs84([x + decalage[0], y + decalage[1]])) },
  }));
  return Buffer.from(JSON.stringify({ type: "FeatureCollection", features }));
}

/** KML (WGS 84) d'un ensemble de lignes locales. Sans nom si `sansNoms`. */
export function kml(lignes: Ligne[], options: { decalage?: Point; sansNoms?: boolean } = {}): Buffer {
  const d = options.decalage ?? [0, 0];
  const corps = lignes.map((l) => {
    const c = l.coords.map(([x, y]) => versWgs84([x + d[0], y + d[1]]).map((v) => v.toFixed(9)).join(",") + ",0").join(" ");
    return `<Placemark>${options.sansNoms ? "" : `<name>${echapperXml(l.nom)}</name>`}<LineString><coordinates>${c}</coordinates></LineString></Placemark>`;
  }).join("");
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>${corps}</Document></kml>`);
}

/**
 * CSV d'un plan d'axes en UTM 29N : une ligne par sommet (axe ; ordre ; x ; y), separateur « ; », virgule decimale, BOM, comme un tableau
 * exporte d'un plan. Les points sont donnes dans un ORDRE MELANGE (l'assistant doit les remettre dans l'ordre de la colonne `ordre`).
 * `decalage` : metres ajoutes aux coordonnees UTM (fabriquer un axe hors zone ou un fichier distinct).
 */
export function csvUtm(lignes: Ligne[], options: { decalage?: Point; sansDecimaleVirgule?: boolean } = {}): Buffer {
  const d = options.decalage ?? [0, 0];
  const fmt = (v: number) => (options.sansDecimaleVirgule ? v.toFixed(3) : v.toFixed(3).replace(".", ","));
  const lignesCsv: string[] = [];
  for (const l of lignes) {
    l.coords.forEach((p, i) => {
      const [x, y] = versUtm([p[0] + d[0], p[1] + d[1]]);
      lignesCsv.push(`${l.nom};${i + 1};${fmt(x)};${fmt(y)}`);
    });
  }
  // Ordre melange, deterministe : les lignes impaires d'abord, puis les paires.
  const melange = [...lignesCsv.filter((_, i) => i % 2 === 1), ...lignesCsv.filter((_, i) => i % 2 === 0)];
  return Buffer.from(`﻿axe;ordre;x;y\r\n${melange.join("\r\n")}\r\n`, "utf8");
}

// ------------------------------------------------------------------------------------------------ ZIP minimal (KMZ, archives dangereuses)

export interface EntreeZip {
  nom: string;
  /** Contenu ; ignore si `contenuDeclare` est donne (bombe : taille declaree sans octets reels). */
  donnees: Buffer;
  methode?: "stocke" | "deflate";
}

function entete32(valeurs: number[]): Buffer {
  const b = Buffer.alloc(valeurs.length * 4);
  valeurs.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4));
  return b;
}

/**
 * ZIP valide (sans ZIP64, sans chiffrement). Les noms sont ecrits tels quels : `../evil.kml` est un nom que l'on peut mettre dans un ZIP, et
 * c'est ce que ce constructeur permet de tester (zip-slip). La methode par defaut est deflate.
 */
export function zip(entrees: EntreeZip[]): Buffer {
  const parties: Buffer[] = [];
  const centrales: Buffer[] = [];
  let decalage = 0;
  for (const e of entrees) {
    const nom = Buffer.from(e.nom, "utf8");
    const methode = e.methode === "stocke" ? 0 : 8;
    const compresse = methode === 0 ? e.donnees : zlib.deflateRawSync(e.donnees, { level: 9 });
    const crc = zlib.crc32(e.donnees) >>> 0;
    const local = Buffer.concat([
      entete32([0x04034b50]),
      Buffer.from([20, 0, 0, 0]), // version, indicateurs
      Buffer.from([methode, 0, 0, 0, 0x21, 0]), // methode, heure, date (1980-01-01)
      entete32([crc, compresse.length, e.donnees.length]),
      Buffer.from([nom.length & 0xff, nom.length >> 8, 0, 0]),
      nom, compresse,
    ]);
    centrales.push(Buffer.concat([
      entete32([0x02014b50]),
      Buffer.from([20, 0, 20, 0, 0, 0]), // fabriquee par, version requise, indicateurs
      Buffer.from([methode, 0, 0, 0, 0x21, 0]),
      entete32([crc, compresse.length, e.donnees.length]),
      Buffer.from([nom.length & 0xff, nom.length >> 8, 0, 0, 0, 0, 0, 0, 0, 0]), // nom, extra, commentaire, disque, attributs internes
      entete32([0, decalage]), // attributs externes, decalage de l'entree locale
      nom,
    ]));
    parties.push(local);
    decalage += local.length;
  }
  const centrale = Buffer.concat(centrales);
  const fin = Buffer.concat([
    entete32([0x06054b50]),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from([entrees.length & 0xff, entrees.length >> 8, entrees.length & 0xff, entrees.length >> 8]),
    entete32([centrale.length, decalage]),
    Buffer.from([0, 0]),
  ]);
  return Buffer.concat([...parties, centrale, fin]);
}

/**
 * Lecteur ZIP minimal et INDEPENDANT de l'application (relit l'archive du dossier technique, lot X1) : repertoire central, methodes « stocke »
 * et « deflate », CRC verifie. Refuse un nom absolu, un `..` ou un antislash (l'archive du serveur n'en porte jamais). Rend les entrees dans
 * l'ordre du repertoire central.
 */
export function lireZip(b: Buffer): Array<{ nom: string; donnees: Buffer; methode: number }> {
  let fin = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65_535); i--) if (b.readUInt32LE(i) === 0x06054b50) { fin = i; break; }
  if (fin < 0) throw new Error("ZIP : fin du repertoire central introuvable");
  const nb = b.readUInt16LE(fin + 10);
  let p = b.readUInt32LE(fin + 16);
  const sortie: Array<{ nom: string; donnees: Buffer; methode: number }> = [];
  for (let k = 0; k < nb; k++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error("ZIP : entree centrale invalide");
    const methode = b.readUInt16LE(p + 10);
    const crc = b.readUInt32LE(p + 16);
    const tailleCompressee = b.readUInt32LE(p + 20);
    const taille = b.readUInt32LE(p + 24);
    const lnom = b.readUInt16LE(p + 28), lextra = b.readUInt16LE(p + 30), lcom = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const nom = b.subarray(p + 46, p + 46 + lnom).toString("utf8");
    if (nom.startsWith("/") || nom.includes("\\") || nom.split("/").includes("..")) throw new Error(`ZIP : nom dangereux ${nom}`);
    if (b.readUInt32LE(local) !== 0x04034b50) throw new Error("ZIP : entree locale invalide");
    const debut = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const compresse = b.subarray(debut, debut + tailleCompressee);
    const donnees = methode === 0 ? Buffer.from(compresse) : methode === 8 ? zlib.inflateRawSync(compresse) : (() => { throw new Error(`ZIP : methode ${methode}`); })();
    if (donnees.length !== taille) throw new Error(`ZIP : taille de ${nom}`);
    if ((zlib.crc32(donnees) >>> 0) !== crc) throw new Error(`ZIP : CRC de ${nom}`);
    sortie.push({ nom, donnees, methode });
    p += 46 + lnom + lextra + lcom;
  }
  return sortie;
}
