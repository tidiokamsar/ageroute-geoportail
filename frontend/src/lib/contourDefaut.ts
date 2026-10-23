/**
 * Contour GPS d'un defaut surfacique, releve EN MARCHANT autour du defaut (scenario A5, paragraphe 7.1) :
 * la partie PURE, sans DOM ni reseau, pour que les regles se testent sans ecran.
 *
 * CE QUE CE MODULE FAIT : decider si un sommet est acceptable (position presente, recente, assez precise, differente
 * de la precedente, qui ne fait pas croiser le contour), valider un contour (au moins trois sommets distincts, une
 * surface non nulle, aucune auto-intersection) et en tirer l'EMPRISE GeoJSON (Polygon, SRID 4326, longitude puis
 * latitude, sens anti-horaire) que `POST /v2/defauts` et `POST /v2/sync/push` acceptent.
 *
 * CE QU'IL NE FAIT PAS, VOLONTAIREMENT : AUCUNE SURFACE. La surface officielle est celle que le SERVEUR mesure dans
 * son fuseau UTM (`metre_utm`, paragraphe 7.1 : jamais de surface en degres). Ce module projette les sommets en metres
 * locaux (plan tangent autour du premier sommet) UNIQUEMENT pour des tests geometriques (croisement, alignement) ;
 * il ne rend ni ne stocke jamais de surface, et aucun ecran ne doit en afficher une calculee ici. Un test le garde.
 *
 * LE SERVEUR RESTE L'ARBITRE. Ces controles evitent d'envoyer une geometrie evidemment fausse, pas de la declarer
 * valide : `ST_IsValid` decide, et refuse avec sa raison (jamais de `ST_MakeValid`, qui changerait la surface).
 *
 * SEUILS : TOUS PROVISOIRES ET NON CALIBRES. Aucun n'a ete mesure sur un recepteur reel ; ils sont affiches a l'ecran et
 * a decider par AGEROUTE apres essai sur le terrain (docs/roulage/COLLECTE-ROULAGE.md).
 */

/** Precision annoncee au-dela de laquelle un sommet est refuse, en metres. PROVISOIRE, non calibre. */
export const PRECISION_MAX_SOMMET_M = 10;
/** Anciennete au-dela de laquelle une position n'est plus « ici » (signal perdu), en ms. PROVISOIRE. */
export const AGE_MAX_POSITION_MS = 10_000;
/** Nombre minimal de sommets distincts d'un contour fermé. */
export const SOMMETS_MIN = 3;
/** Plafond de confort d'un contour releve a pied (le serveur accepte jusqu'a 20 000 positions). */
export const SOMMETS_MAX = 200;
/** Sous cette aire, en m2 (un decimetre carre), le contour n'a pas de surface exploitable : sommets alignes. PROVISOIRE. */
export const AIRE_MIN_M2 = 0.01;
/** Distance a la droite des deux points les plus eloignes sous laquelle les sommets sont dits alignes, en metres (l'ordre du centimetre d'arrondi des coordonnees). PROVISOIRE. */
export const ECART_ALIGNEMENT_M = 0.02;
/** Un contour dont l'etendue est inferieure a ce multiple de la pire precision est plus petit que l'incertitude du GPS. PROVISOIRE. */
export const FACTEUR_PRECISION_EMPRISE = 2;

export interface PositionCourante { lat: number; lon: number; precisionM: number; releveeLe: number }
export interface SommetContour { lat: number; lon: number; precisionM: number; poseLe: number }

export type EmpriseGeoJson = { type: "Polygon"; coordinates: [number, number][][] };

const DECIMALES = 7;
const arrondi = (v: number) => Math.round(v * 10 ** DECIMALES) / 10 ** DECIMALES;
const cle = (s: { lat: number; lon: number }) => `${arrondi(s.lat)}|${arrondi(s.lon)}`;
const finiDans = (v: number, min: number, max: number) => Number.isFinite(v) && v >= min && v <= max;

// ------------------------------------------------------------------ geometrie locale (tests seulement)

interface Pt { x: number; y: number }
const M_PAR_DEGRE = 111_320;

/** Metres locaux autour du premier point : sert aux TESTS de croisement et d'alignement, jamais a une mesure. */
function projeter(points: readonly { lat: number; lon: number }[]): Pt[] {
  const o = points[0];
  const k = Math.cos((o.lat * Math.PI) / 180);
  return points.map((p) => ({ x: (p.lon - o.lon) * M_PAR_DEGRE * k, y: (p.lat - o.lat) * M_PAR_DEGRE }));
}

const EPS = 1e-9;
const orient = (a: Pt, b: Pt, c: Pt) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const signe = (v: number) => (v > EPS ? 1 : v < -EPS ? -1 : 0);
const dansBoite = (a: Pt, b: Pt, p: Pt) => p.x >= Math.min(a.x, b.x) - EPS && p.x <= Math.max(a.x, b.x) + EPS && p.y >= Math.min(a.y, b.y) - EPS && p.y <= Math.max(a.y, b.y) + EPS;

/** Deux segments FERMES se rencontrent-ils (croisement, contact d'une extremite, chevauchement) ? */
function segmentsSeRencontrent(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d1 = signe(orient(p3, p4, p1));
  const d2 = signe(orient(p3, p4, p2));
  const d3 = signe(orient(p1, p2, p3));
  const d4 = signe(orient(p1, p2, p4));
  if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  if (d1 === 0 && dansBoite(p3, p4, p1)) return true;
  if (d2 === 0 && dansBoite(p3, p4, p2)) return true;
  if (d3 === 0 && dansBoite(p1, p2, p3)) return true;
  if (d4 === 0 && dansBoite(p1, p2, p4)) return true;
  return false;
}

/** Aire signee (shoelace) en m2 locaux : sert au sens de l'anneau et a detecter l'alignement, jamais affichee. */
function aireSigneeLocale(pts: readonly Pt[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** Tous les points sont-ils sur une meme droite, a `ECART_ALIGNEMENT_M` pres ? (droite portee par les deux points les plus eloignes) */
function sontAlignes(pts: readonly Pt[]): boolean {
  let a = pts[0];
  let b = pts[0];
  let max = -1;
  for (const p of pts) for (const q of pts) {
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d > max) { max = d; a = p; b = q; }
  }
  if (max <= 0) return true;
  return pts.every((p) => Math.abs(orient(a, b, p)) / max <= ECART_ALIGNEMENT_M);
}

/** Premiere paire d'aretes de l'anneau FERME qui se rencontrent (hors aretes voisines), ou un demi-tour sur place. */
function premierCroisement(pts: readonly Pt[]): { a: number; b: number } | null {
  const n = pts.length;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const voisines = j === i + 1 || (i === 0 && j === n - 1);
      const [a1, a2] = [pts[i], pts[(i + 1) % n]];
      const [b1, b2] = [pts[j], pts[(j + 1) % n]];
      if (voisines) {
        // Deux aretes voisines ne partagent qu'un sommet. Alignees ET en sens inverse, elles se recouvrent : un demi-tour sur place.
        const commun = j === i + 1 ? a2 : a1;
        const autreA = j === i + 1 ? a1 : a2;
        const autreB = j === i + 1 ? b2 : b1;
        if (signe(orient(autreA, commun, autreB)) === 0) {
          const dot = (autreA.x - commun.x) * (autreB.x - commun.x) + (autreA.y - commun.y) * (autreB.y - commun.y);
          if (dot > EPS) return { a: i, b: j };
        }
        continue;
      }
      if (segmentsSeRencontrent(a1, a2, b1, b2)) return { a: i, b: j };
    }
  }
  return null;
}

// ------------------------------------------------------------------ un sommet

export type MotifRefusSommet =
  | "AUCUNE_POSITION" | "COORDONNEES_INVALIDES" | "POSITION_PERIMEE" | "PRECISION_INSUFFISANTE"
  | "TROP_DE_SOMMETS" | "MEME_POSITION" | "CROISE_LE_CONTOUR";

export type DecisionSommet = { ok: true; sommet: SommetContour } | { ok: false; motif: MotifRefusSommet; message: string };

const refuse = (motif: MotifRefusSommet, message: string): DecisionSommet => ({ ok: false, motif, message });

/**
 * Le sommet « ici » est-il acceptable ? REFUSE, sans rien corriger ni arrondir en douce :
 *   - pas de position, ou coordonnees hors de l'etendue WGS 84 ;
 *   - position plus vieille que `ageMaxMs` : le signal est perdu, ce n'est plus « ici » ;
 *   - precision annoncee au-dessus du seuil (ou inconnue) : un sommet pose a 40 m pres ne dessine pas un defaut ;
 *   - meme position que le sommet precedent (a 1 cm pres) ;
 *   - une arete qui croiserait ou toucherait le contour deja pose.
 */
export function evaluerSommet(
  position: PositionCourante | null,
  sommets: readonly SommetContour[],
  maintenantMs: number,
  options: { precisionMaxM?: number; ageMaxMs?: number } = {},
): DecisionSommet {
  const precisionMax = options.precisionMaxM ?? PRECISION_MAX_SOMMET_M;
  const ageMax = options.ageMaxMs ?? AGE_MAX_POSITION_MS;
  if (!position) return refuse("AUCUNE_POSITION", "Aucune position GPS pour l'instant : attendre le signal.");
  if (!finiDans(position.lat, -90, 90) || !finiDans(position.lon, -180, 180)) return refuse("COORDONNEES_INVALIDES", "Coordonnées GPS invalides : sommet refusé.");
  if (!Number.isFinite(position.releveeLe) || maintenantMs - position.releveeLe > ageMax) {
    return refuse("POSITION_PERIMEE", `La dernière position date de plus de ${Math.round(ageMax / 1000)} s : le signal est perdu, attendre une nouvelle position.`);
  }
  if (!Number.isFinite(position.precisionM) || position.precisionM > precisionMax) {
    return refuse("PRECISION_INSUFFISANTE", `Précision ± ${Math.round(position.precisionM)} m : au-dessus du seuil de ${precisionMax} m. Attendre une meilleure précision ou se placer à découvert.`);
  }
  if (sommets.length >= SOMMETS_MAX) return refuse("TROP_DE_SOMMETS", `Un contour ne dépasse pas ${SOMMETS_MAX} sommets : fermer le contour.`);
  const sommet: SommetContour = { lat: arrondi(position.lat), lon: arrondi(position.lon), precisionM: position.precisionM, poseLe: maintenantMs };
  const dernier = sommets[sommets.length - 1];
  if (dernier && cle(dernier) === cle(sommet)) return refuse("MEME_POSITION", "Même position que le sommet précédent : avancer le long du contour avant d'en poser un autre.");
  if (sommets.length >= 2) {
    const pts = projeter([...sommets, sommet]);
    const n = pts.length;
    const [n1, n2] = [pts[n - 2], pts[n - 1]];
    // La nouvelle arete (avant-dernier -> dernier) contre toutes les aretes deja posees, sauf celle qui la precede.
    for (let i = 0; i < n - 3; i += 1) {
      if (segmentsSeRencontrent(n1, n2, pts[i], pts[i + 1])) {
        return refuse("CROISE_LE_CONTOUR", "Ce sommet ferait croiser ou toucher le contour déjà posé. Si le tour est terminé, utiliser « Fermer le contour » ; sinon, retirer le dernier sommet.");
      }
    }
  }
  return { ok: true, sommet };
}

// ------------------------------------------------------------------ le contour

export type MotifContourInvalide = "TROP_PEU_DE_SOMMETS" | "COORDONNEES_INVALIDES" | "SURFACE_NULLE" | "AUTO_INTERSECTION";

export type ResultatContour =
  | { ok: true; emprise: EmpriseGeoJson; sommets: number; precisionPireM: number; avertissements: string[] }
  | { ok: false; motif: MotifContourInvalide; message: string };

/**
 * Valide le contour fermé et en tire l'emprise GeoJSON. Rend le MOTIF d'un refus, jamais une geometrie « reparee ».
 * Le dernier sommet est relie au premier : l'anneau est ferme par la fonction, pas par l'agent.
 */
export function validerContour(sommets: readonly SommetContour[]): ResultatContour {
  if (sommets.some((s) => !finiDans(s.lat, -90, 90) || !finiDans(s.lon, -180, 180))) {
    return { ok: false, motif: "COORDONNEES_INVALIDES", message: "Un sommet a des coordonnées invalides : refaire le contour." };
  }
  // Sommets DISTINCTS a la precision envoyee (7 decimales, environ 1 cm) : deux positions confondues n'en font qu'un.
  const vus = new Set<string>();
  const distincts: SommetContour[] = [];
  for (const s of sommets) {
    if (vus.has(cle(s))) continue;
    vus.add(cle(s));
    distincts.push(s);
  }
  if (distincts.length < SOMMETS_MIN) {
    return { ok: false, motif: "TROP_PEU_DE_SOMMETS", message: `Il faut au moins ${SOMMETS_MIN} sommets distincts pour fermer un contour (${distincts.length} posé(s)).` };
  }
  const pts = projeter(distincts);
  const aucuneSurface = { ok: false, motif: "SURFACE_NULLE", message: "Les sommets sont alignés ou presque confondus : le contour n'enferme aucune surface. Faire le tour du défaut." } as const;
  if (sontAlignes(pts)) return aucuneSurface;
  // Le croisement se juge AVANT l'aire : un noeud papillon symetrique a une aire signee nulle (les deux boucles
  // s'annulent) et ne doit pas etre pris pour des sommets alignes.
  const croisement = premierCroisement(pts);
  if (croisement) {
    return { ok: false, motif: "AUTO_INTERSECTION", message: `Le contour se croise lui-même (côtés ${croisement.a + 1} et ${croisement.b + 1}) : retirer le dernier sommet ou refaire le contour sans croiser.` };
  }
  if (Math.abs(aireSigneeLocale(pts)) < AIRE_MIN_M2) return aucuneSurface;
  // Anneau en sens anti-horaire (RFC 7946), ferme par le premier sommet repete.
  const ordonnes = aireSigneeLocale(pts) < 0 ? [...distincts].reverse() : distincts;
  const anneau = ordonnes.map((s): [number, number] => [arrondi(s.lon), arrondi(s.lat)]);
  anneau.push([...anneau[0]] as [number, number]);

  const precisionPireM = Math.max(...distincts.map((s) => s.precisionM));
  const avertissements: string[] = [];
  let etendue = 0;
  for (const a of pts) for (const b of pts) etendue = Math.max(etendue, Math.hypot(a.x - b.x, a.y - b.y));
  if (etendue < FACTEUR_PRECISION_EMPRISE * precisionPireM) {
    avertissements.push(`Le contour mesure environ ${etendue.toFixed(1)} m de large pour une précision GPS de ± ${Math.round(precisionPireM)} m : sa surface n'est pas significative.`);
  }
  return { ok: true, emprise: { type: "Polygon", coordinates: [anneau] }, sommets: distincts.length, precisionPireM, avertissements };
}

// ------------------------------------------------------------------ ce que le contour change a la saisie

export type UniteDefaut = "UNITE" | "METRE" | "METRE_CARRE" | "METRE_CUBE";
export type MesureRequise = "NOMBRE" | "LONGUEUR" | "LARGEUR" | "PROFONDEUR" | "QUANTITE";

/**
 * Mesures a saisir quand un contour FERME est joint. Meme regle que le serveur (`mesuresCouvertesParEmprise`,
 * backend/src/field/defauts.regles.ts) : pour une surface (m2) ou un volume (m3), le contour donne les deux facteurs
 * du rectangle (longueur et largeur) ; la profondeur et le nombre ne se tirent d'aucun contour. Pour un metre lineaire
 * ou une unite, le polygone ne dit rien : toutes les mesures restent exigees. Si cette copie derivait de la regle du
 * serveur, c'est le serveur qui l'emporte (refus `RELEVE_INCOMPLET` avec ce qui manque) : le banc d'integration
 * `contour-terrain` fait passer chaque unite par la vraie validation pour que la derive se voie.
 */
export function mesuresRequisesAvecContour(unite: UniteDefaut, requises: readonly MesureRequise[], contourFerme: boolean): MesureRequise[] {
  if (!contourFerme || (unite !== "METRE_CARRE" && unite !== "METRE_CUBE")) return [...requises];
  return requises.filter((m) => m !== "LONGUEUR" && m !== "LARGEUR");
}

/** Ce que le serveur tirera du contour pour cette unite : dit a l'agent a quoi il sert. */
export function usageDuContour(unite: UniteDefaut): string {
  switch (unite) {
    case "METRE_CARRE": return "La quantité du défaut sera la surface du contour, mesurée par le serveur.";
    case "METRE_CUBE": return "La quantité du défaut sera la surface du contour mesurée par le serveur, multipliée par la profondeur saisie.";
    case "METRE": return "Pour un défaut mesuré au mètre linéaire, le contour n'est pas converti en quantité : il reste enregistré comme emprise, la longueur saisie décide.";
    case "UNITE": return "Pour un défaut qui se compte, le contour n'est pas converti en quantité : il reste enregistré comme emprise, le nombre saisi décide.";
  }
}

// ------------------------------------------------------------------ reponse du serveur (apercu de la mesure)

export interface MesureServeur { surfaceM2: number; longueurM: number; epsg: number; ecartSurface: number | null }

/** Lit la reponse de `POST /v2/geo/metre`. Une reponse qui n'a pas la forme attendue n'est pas une mesure. */
export function lireMesureServeur(brut: unknown): MesureServeur | null {
  if (typeof brut !== "object" || brut === null) return null;
  const o = brut as Record<string, unknown>;
  const nombre = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
  const surfaceM2 = nombre(o.surfaceM2);
  const longueurM = nombre(o.longueurM);
  const epsg = nombre(o.epsg);
  if (surfaceM2 === null || longueurM === null || epsg === null || surfaceM2 <= 0) return null;
  return { surfaceM2, longueurM, epsg, ecartSurface: nombre(o.ecartSurface) };
}

export type RefusServeur = { refus: true; raison: string } | { refus: false; raison: string };

/**
 * Que dit le serveur quand la mesure echoue ? Un 400 est un JUGEMENT sur la geometrie (invalide, illisible) : sa raison
 * est rendue telle quelle et le contour est a refaire. Tout autre echec (reseau, droits, panne) ne juge rien : le
 * contour n'est pas declare faux, il sera mesure a l'enregistrement.
 */
export function lireRefusServeur(err: unknown): RefusServeur {
  const r = (err as { response?: { status?: number; data?: { error?: unknown; message?: unknown } } } | null)?.response;
  if (r?.status === 400) {
    const texte = typeof r.data?.error === "string" ? r.data.error : typeof r.data?.message === "string" ? r.data.message : "géométrie refusée";
    return { refus: true, raison: texte };
  }
  return { refus: false, raison: r?.status ? `réponse ${r.status}` : "serveur injoignable" };
}
