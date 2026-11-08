/**
 * Lecture et nettoyage d'une trace GPS exportee par un telephone (GPX ou CSV).
 *
 * Paragraphe 7.13 du mandat, cote serveur : une trace enregistree en roulage est importee, puis
 * rattachee au reseau par `appariement.trace.ts`. Ce module ne fait que LIRE et NETTOYER ; il ne
 * touche ni la base ni le reseau.
 *
 * AUCUN IMPORT : c'est un noyau pur, comme `appariement.noyau.ts`. Un test de garde le verifie.
 *
 * CHOIX QUI ENGAGENT LE RESULTAT
 *
 * 1. PAS DE BIBLIOTHEQUE XML. Un GPX est lu par expressions regulieres bornees, sans analyseur
 *    XML : aucune resolution d'entite externe n'est possible, donc aucune attaque XXE. Le prix est
 *    que seules les balises trkpt sont lues (pas les routes ni les waypoints), et c'est dit.
 *
 * 2. LE PAS MINIMAL EST UN CHOIX PROVISOIRE, PAS UNE NORME. Garder un point tous les `pasMinM`
 *    metres borne le cout de l'appariement (une requete par point) et retire les points d'arret.
 *    La valeur par defaut est 15 m ; elle n'a pas ete calibree sur des traces reelles
 *    d'AGEROUTE et l'appelant peut la changer.
 *
 * 3. LA PRECISION N'EST JAMAIS INVENTEE. Un GPX ne porte generalement pas de precision en metres
 *    (la balise hdop est un facteur, pas une distance). Elle reste donc `null`, et l'appariement
 *    applique alors son incertitude par defaut en le disant.
 */

export interface PointBrut {
  lat: number;
  lon: number;
  /** Horodatage en millisecondes depuis 1970, ou null quand le fichier n'en donne pas. */
  tMs: number | null;
  /** Precision annoncee en metres, ou null. */
  precisionM: number | null;
}

export type RefusLecture = "FORMAT_ILLISIBLE" | "AUCUN_POINT";

export type Lecture =
  | { refus: RefusLecture; message: string }
  | { refus: null; points: PointBrut[]; ignores: number; avertissements: string[] };

/** Pas minimal entre deux points conserves. Provisoire, voir l'en-tete. */
export const PAS_MIN_PAR_DEFAUT_M = 15;

/**
 * Nombre maximal de points apres nettoyage. Protection du serveur : l'appariement fait une
 * requete par point. Valeur choisie, non mesuree sur le reseau reel.
 */
export const POINTS_MAX = 3000;

const RAYON_TERRE_M = 6371008.8;

export function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * RAYON_TERRE_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function coordonneeValide(lat: number, lon: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
  // (0, 0) est la valeur que renvoie un recepteur sans fixation : jamais une position reelle ici.
  if (lat === 0 && lon === 0) return false;
  return true;
}

function lireHorodatage(brut: string | undefined): number | null {
  if (brut === undefined) return null;
  const s = brut.trim();
  if (s === "") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 1e12) return Math.round(n);
    if (n > 1e9) return Math.round(n * 1000);
    return null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function attribut(attributs: string, nom: string): number {
  const m = new RegExp(`\\b${nom}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attributs);
  if (!m) return NaN;
  return Number(m[1] ?? m[2]);
}

/** Lit les balises trkpt d'un GPX. Voir le choix 1 de l'en-tete. */
export function lireGpx(texte: string): Lecture {
  if (!/<gpx\b/i.test(texte)) {
    return { refus: "FORMAT_ILLISIBLE", message: "Le fichier n'est pas un GPX (balise gpx absente)." };
  }
  const points: PointBrut[] = [];
  let ignores = 0;
  // Attributs sans '>' ; corps lu paresseusement jusqu'a la balise fermante la plus proche.
  const re = /<trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texte)) !== null) {
    const lat = attribut(m[1], "lat");
    const lon = attribut(m[1], "lon");
    if (!coordonneeValide(lat, lon)) { ignores += 1; continue; }
    const corps = m[2] ?? "";
    const t = /<time>\s*([^<]*?)\s*<\/time>/i.exec(corps);
    points.push({ lat, lon, tMs: lireHorodatage(t?.[1]), precisionM: null });
  }
  if (points.length === 0) {
    return { refus: "AUCUN_POINT", message: "Aucun point de trace (trkpt) valide dans le GPX." };
  }
  const avertissements: string[] = [];
  if (ignores > 0) avertissements.push(`${ignores} point(s) aux coordonnees invalides ont ete ignores.`);
  return { refus: null, points, ignores, avertissements };
}

function normaliser(s: string): string {
  return s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
}

/** Lit un CSV : en-tete facultatif, separateur , ; ou tabulation. Voir `lireCsv` pour les colonnes. */
export function lireCsv(texte: string): Lecture {
  const lignes = texte.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "" && !l.trimStart().startsWith("#"));
  if (lignes.length === 0) return { refus: "AUCUN_POINT", message: "Le fichier CSV est vide." };

  const premiere = lignes[0];
  const nbPv = (premiere.match(/;/g) ?? []).length;
  const nbVirg = (premiere.match(/,/g) ?? []).length;
  const nbTab = (premiere.match(/\t/g) ?? []).length;
  const sep = nbTab > 0 && nbTab >= nbPv && nbTab >= nbVirg ? "\t" : nbPv > nbVirg ? ";" : ",";
  const decoupe = (l: string) => l.split(sep).map((c) => c.trim().replace(/^"|"$/g, ""));
  const nombre = (c: string | undefined) => (c === undefined || c === "" ? NaN : Number(sep === ";" ? c.replace(",", ".") : c));

  let iLat = 0, iLon = 1, iTemps = 2, iPrec = 3;
  let debut = 0;
  const champs = decoupe(premiere);
  if (!Number.isFinite(nombre(champs[0]))) {
    // Premiere ligne = en-tete : les colonnes sont retrouvees par leur nom, jamais supposees.
    debut = 1;
    const noms = champs.map(normaliser);
    const trouver = (candidats: string[]) => noms.findIndex((n) => candidats.includes(n));
    iLat = trouver(["lat", "latitude"]);
    iLon = trouver(["lon", "lng", "long", "longitude"]);
    iTemps = trouver(["time", "heure", "timestamp", "date", "datetime", "horodatage"]);
    iPrec = trouver(["precision", "precisionm", "accuracy", "accuracym"]);
    if (iLat < 0 || iLon < 0) {
      return { refus: "FORMAT_ILLISIBLE", message: "En-tete CSV sans colonne latitude/longitude reconnue (lat, latitude, lon, lng, longitude)." };
    }
  }

  const points: PointBrut[] = [];
  let ignores = 0;
  for (const l of lignes.slice(debut)) {
    const c = decoupe(l);
    const lat = nombre(c[iLat]);
    const lon = nombre(c[iLon]);
    if (!coordonneeValide(lat, lon)) { ignores += 1; continue; }
    const p = iPrec >= 0 ? nombre(c[iPrec]) : NaN;
    points.push({
      lat, lon,
      tMs: iTemps >= 0 ? lireHorodatage(c[iTemps]) : null,
      precisionM: Number.isFinite(p) && p > 0 && p <= 10_000 ? p : null,
    });
  }
  if (points.length === 0) return { refus: "AUCUN_POINT", message: "Aucune ligne CSV avec une latitude et une longitude valides." };
  const avertissements: string[] = [];
  if (ignores > 0) avertissements.push(`${ignores} ligne(s) aux coordonnees invalides ont ete ignorees.`);
  return { refus: null, points, ignores, avertissements };
}

export interface Nettoyage {
  points: PointBrut[];
  /** Points retires parce que trop proches du precedent conserve (arrets, sur-echantillonnage). */
  retiresParPas: number;
  avertissements: string[];
}

/**
 * Garde un point tous les `pasMinM` metres au moins, a partir du premier. Le parcours conserve est
 * donc plus court que le parcours reel d'au plus `pasMinM` metres en fin de trace : le dernier point
 * n'est PAS restitue, parce que le restituer ferait passer pour une trace deux points distants de
 * quelques metres.
 */
export function nettoyer(points: readonly PointBrut[], pasMinM: number = PAS_MIN_PAR_DEFAUT_M): Nettoyage {
  const gardes: PointBrut[] = [];
  let retires = 0;
  for (const p of points) {
    const dernier = gardes[gardes.length - 1];
    if (dernier && distanceM(dernier, p) < pasMinM) { retires += 1; continue; }
    gardes.push(p);
  }

  const avertissements: string[] = [];
  const avecTemps = gardes.filter((p) => p.tMs !== null).length;
  if (avecTemps === 0) avertissements.push("Le fichier ne porte aucun horodatage : duree et vitesse ne peuvent pas etre calculees.");
  else if (avecTemps < gardes.length) avertissements.push("Certains points n'ont pas d'horodatage.");
  let croissant = true;
  for (let i = 1; i < gardes.length; i += 1) {
    const a = gardes[i - 1].tMs, b = gardes[i].tMs;
    if (a !== null && b !== null && b < a) { croissant = false; break; }
  }
  if (!croissant) avertissements.push("Les horodatages ne sont pas croissants : l'ordre du fichier a ete conserve.");
  return { points: gardes, retiresParPas: retires, avertissements };
}

/** Rectangle englobant la trace, elargi de `margeM` metres, en degres decimaux. */
export function emprise(points: readonly { lat: number; lon: number }[], margeM: number) {
  let sud = 90, nord = -90, ouest = 180, est = -180;
  for (const p of points) {
    if (p.lat < sud) sud = p.lat;
    if (p.lat > nord) nord = p.lat;
    if (p.lon < ouest) ouest = p.lon;
    if (p.lon > est) est = p.lon;
  }
  const dLat = margeM / 111_320;
  const cosLat = Math.max(0.05, Math.cos((((sud + nord) / 2) * Math.PI) / 180));
  const dLon = margeM / (111_320 * cosLat);
  return { sud: sud - dLat, nord: nord + dLat, ouest: ouest - dLon, est: est + dLon };
}
