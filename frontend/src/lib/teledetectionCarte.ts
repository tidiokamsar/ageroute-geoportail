/**
 * Noyau pur de la carte « Observation de la Terre » : style des marqueurs, emprises, plafond d'affichage,
 * libelles accessibles. Aucun DOM, aucune horloge, aucun reseau : tout ce qui est decide ici se teste sans
 * navigateur (voir teledetectionCarte.test.ts). Le composant `CarteObservationTerre` ne fait que le dessiner.
 *
 * CE QUE CE NOYAU S'INTERDIT
 *
 * - Inventer une position, un statut ou une priorite. Une feature dont la geometrie est absente ou hors bornes
 *   est ECARTEE ET COMPTEE (`ignorees`), jamais replacee au centre du pays. Une valeur inconnue garde son code
 *   brut dans le libelle et recoit un style neutre : on ne la range pas dans la categorie la plus proche.
 * - Dire plus que la donnee. Les proprietes d'une feature sont `{ id, type, statut, priorite, rattachee }`
 *   (contrat §5) : ni confiance, ni date, ni tronçon. Aucun libelle d'ici n'en cite.
 * - Taire une troncature. Au-dela du plafond, le nombre de propositions non dessinees est rendu, avec le message
 *   qui dit quoi faire (`messagePlafond`).
 *
 * VALEURS PROVISOIRES (reversibles) : `ZOOM_MINIMUM_PROPOSITIONS`, `EMPRISE_MAX_DEGRES`, `PLAFOND_MARQUEURS`,
 * `MARGE_RECHARGEMENT`. Vue NATIONALE (decision de conduite EO-FIX-FRONT 9) : zoom minimal 6 et emprise de 10 degres de cote,
 * pour que la Guinee entiere (environ 7,5 x 5,7 degres) s'affiche des l'ouverture avec les `PLAFOND_MARQUEURS` propositions les plus
 * prioritaires et la troncature DITE. `EMPRISE_MAX_DEGRES` est la copie cliente de la borne serveur (`BBOX_COTE_MAX_DEG`,
 * `backend/src/teledetection/api.noyau.ts`, qui fait foi : le serveur refuse 10,01 degres) ; le zoom minimal n'existe qu'ici.
 */

/** Ouest, sud, est, nord, en degres decimaux (l'ordre de `?bbox=` du contrat). */
export type Bbox = [number, number, number, number];

/** Centre d'ouverture : celui du geoportail (`GUINEE_CENTER`, GeoportailPage.tsx). */
export const CENTRE_GUINEE: [number, number] = [10.5, -10.8];
/** Zoom NATIONAL de depart (le geoportail, lui, ouvre au zoom 7) ; la carte l'ajuste a la taille du conteneur (`zoomOuverture`). */
export const ZOOM_INITIAL = 6;
/** Au-dela, on ne cherche pas un zoom d'ouverture plus proche : un conteneur gigantesque n'est pas un cas de vue nationale. */
export const ZOOM_OUVERTURE_MAX = 9;

/** En dessous, l'emprise visible depasse ce qu'on demande au serveur. PROVISOIRE. */
export const ZOOM_MINIMUM_PROPOSITIONS = 6;
/** Cote maximal (degres) d'une emprise demandee. PROVISOIRE ; copie de `BBOX_COTE_MAX_DEG` du serveur. */
export const EMPRISE_MAX_DEGRES = 10;
/** Marqueurs dessines au plus : au-dela, le DOM de Leaflet ralentit. PROVISOIRE. */
export const PLAFOND_MARQUEURS = 300;
/** Part de chaque cote ajoutee a l'emprise demandee, pour qu'un petit deplacement ne relance rien. PROVISOIRE. */
export const MARGE_RECHARGEMENT = 0.1;
/** Delai (ms) avant d'annoncer une nouvelle emprise au parent. */
export const DELAI_EMPRISE_MS = 300;
/** Demi-cote (degres, environ 11 km) du cadrage sur une ville : un cadrage, pas une limite administrative. */
export const DEMI_COTE_CADRAGE_VILLE_DEG = 0.1;

// ---------------------------------------------------------------------------------------------------------------
// Emprises
// ---------------------------------------------------------------------------------------------------------------

const nombre = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Vrai pour quatre degres finis, dans les bornes terrestres, avec ouest <= est et sud <= nord. */
export function bboxValide(b: unknown): b is Bbox {
  if (!Array.isArray(b) || b.length !== 4 || !b.every(nombre)) return false;
  const [o, s, e, n] = b as number[];
  return o >= -180 && e <= 180 && s >= -90 && n <= 90 && o <= e && s <= n;
}

/** Arrondit chaque coordonnee (quatre decimales, environ 11 m, par defaut). */
export function arrondirBbox(b: Bbox, decimales = 4): Bbox {
  const f = 10 ** decimales;
  return b.map((v) => Math.round(v * f) / f) as Bbox;
}

/** Les limites d'une vue Leaflet (`getWest()`, ...) en bbox arrondie. */
export function bboxDepuisLimites(l: { ouest: number; sud: number; est: number; nord: number }): Bbox | null {
  const b: unknown = [l.ouest, l.sud, l.est, l.nord];
  return bboxValide(b) ? arrondirBbox(b) : null;
}

/** « ouest,sud,est,nord » : la forme du parametre `bbox` de l'API. */
export function bboxEnChaine(b: Bbox): string {
  return b.join(",");
}

/** Lit « ouest,sud,est,nord ». Une chaine mal formee rend null, jamais une emprise devinee. */
export function bboxDepuisChaine(s: string): Bbox | null {
  const morceaux = s.split(",").map((x) => x.trim());
  if (morceaux.length !== 4 || morceaux.some((x) => x === "")) return null;
  const b: unknown = morceaux.map(Number);
  return bboxValide(b) ? (b as Bbox) : null;
}

/** [[sud, ouest], [nord, est]] : ce que `fitBounds` de Leaflet attend. */
export function bboxVersLimitesLeaflet(b: Bbox): [[number, number], [number, number]] {
  return [[b[1], b[0]], [b[3], b[2]]];
}

/** `interieur` tient-elle tout entiere dans `exterieur` (bords compris) ? */
export function bboxInclus(interieur: Bbox, exterieur: Bbox): boolean {
  return interieur[0] >= exterieur[0] && interieur[1] >= exterieur[1] && interieur[2] <= exterieur[2] && interieur[3] <= exterieur[3];
}

export function largeurBbox(b: Bbox): number { return b[2] - b[0]; }
export function hauteurBbox(b: Bbox): number { return b[3] - b[1]; }

export function bboxTropLarge(b: Bbox, max = EMPRISE_MAX_DEGRES): boolean {
  return largeurBbox(b) > max || hauteurBbox(b) > max;
}

/**
 * Ajoute `ratio` de la largeur (et de la hauteur) de chaque cote, borne aux limites terrestres. Si la vue
 * elle-meme depasse deja `max`, ou si l'elargissement la ferait depasser, elle est rendue telle quelle : on
 * n'ajoute jamais une marge qui ferait refuser l'emprise.
 */
export function elargirBbox(b: Bbox, ratio = MARGE_RECHARGEMENT, max = EMPRISE_MAX_DEGRES): Bbox {
  const dx = largeurBbox(b) * ratio;
  const dy = hauteurBbox(b) * ratio;
  const large: Bbox = [Math.max(-180, b[0] - dx), Math.max(-90, b[1] - dy), Math.min(180, b[2] + dx), Math.min(90, b[3] + dy)];
  return bboxTropLarge(large, max) ? b : arrondirBbox(large);
}

/** Le zoom suffit-il pour demander des propositions ? Un zoom non numerique ne suffit jamais. */
export function zoomSuffisant(zoom: number, minimum = ZOOM_MINIMUM_PROPOSITIONS): boolean {
  return nombre(zoom) && zoom >= minimum;
}

export type RaisonInsuffisante = "zoom" | "emprise";

/**
 * Zoom d'ouverture : le plus ELOIGNE (donc le plus national) dont l'emprise visible reste admise. `tropLarge(z)` dit si la vue de la carte
 * au zoom `z` depasse `EMPRISE_MAX_DEGRES` ; la carte la repond avec ses limites reelles. Pur : aucune horloge, aucun DOM.
 */
export function zoomOuverture(tropLarge: (zoom: number) => boolean, depart = ZOOM_INITIAL, max = ZOOM_OUVERTURE_MAX): number {
  for (let z = depart; z < max; z += 1) if (!tropLarge(z)) return z;
  return max;
}

/** Dit si la vue permet de demander des propositions, et sinon pourquoi (zoom trop bas, ou emprise trop large). */
export function etatZoom(zoom: number, bbox: Bbox | null): { suffisant: boolean; raison: RaisonInsuffisante | null } {
  if (!zoomSuffisant(zoom)) return { suffisant: false, raison: "zoom" };
  if (bbox && bboxTropLarge(bbox)) return { suffisant: false, raison: "emprise" };
  return { suffisant: true, raison: null };
}

/**
 * L'emprise a demander apres un deplacement de la vue. `null` = ne rien recharger.
 *
 * - zoom ou emprise insuffisants : null (rien a demander, le parent est prevenu a part) ;
 * - emprise courante incluse dans la derniere chargee : null, SAUF si cette derniere reponse etait tronquee
 *   (`tronquee`), car zoomer sur une reponse tronquee ferait manquer des propositions ;
 * - sinon : la vue elargie de la marge.
 */
export function empriseARecharger(args: { chargee: Bbox | null; courante: Bbox; zoom: number; tronquee?: boolean }): Bbox | null {
  const { chargee, courante, zoom, tronquee = false } = args;
  if (!etatZoom(zoom, courante).suffisant) return null;
  if (chargee && !tronquee && bboxInclus(courante, chargee)) return null;
  return elargirBbox(courante);
}

/** Cadre de `demiCote` degres autour d'un point. Borne aux limites terrestres. */
export function bboxAutour(lat: number, lon: number, demiCote = DEMI_COTE_CADRAGE_VILLE_DEG): Bbox | null {
  if (!nombre(lat) || !nombre(lon) || !nombre(demiCote) || demiCote < 0) return null;
  const b: unknown = [lon - demiCote, lat - demiCote, lon + demiCote, lat + demiCote];
  return bboxValide(b) ? arrondirBbox(b, 5) : null;
}

/** Centre [lat, lon] d'une emprise. */
export function centreBbox(b: Bbox): [number, number] {
  return [(b[1] + b[3]) / 2, (b[0] + b[2]) / 2];
}

// ---------------------------------------------------------------------------------------------------------------
// Geometries GeoJSON
// ---------------------------------------------------------------------------------------------------------------

type Position = [number, number];

function estPosition(p: unknown): p is Position {
  return Array.isArray(p) && p.length >= 2 && nombre(p[0]) && nombre(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
}

/** Toutes les positions d'une geometrie (Point, LineString, Polygon et leurs Multi). Vide si illisible. */
function positionsDe(coords: unknown, profondeur: number): Position[] {
  if (profondeur === 0) return estPosition(coords) ? [[coords[0], coords[1]]] : [];
  if (!Array.isArray(coords)) return [];
  return coords.flatMap((c) => positionsDe(c, profondeur - 1));
}

const PROFONDEUR: Record<string, number> = { Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3 };

/** Positions [lon, lat] d'une geometrie GeoJSON ; vide si le type est inconnu ou les coordonnees invalides. */
export function positionsGeometrie(g: unknown): Position[] {
  const geo = g as { type?: unknown; coordinates?: unknown } | null;
  if (!geo || typeof geo.type !== "string" || !(geo.type in PROFONDEUR)) return [];
  return positionsDe(geo.coordinates, PROFONDEUR[geo.type]);
}

/** Emprise d'une geometrie GeoJSON (objet), ou null si elle n'a aucune position lisible. */
export function bboxDeGeometrie(g: unknown): Bbox | null {
  const pos = positionsGeometrie(g);
  if (pos.length === 0) return null;
  let [o, s, e, n] = [pos[0][0], pos[0][1], pos[0][0], pos[0][1]];
  for (const [x, y] of pos) { o = Math.min(o, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  return [o, s, e, n];
}

/** Idem pour une geometrie portee en TEXTE (`ST_AsGeoJSON` des tronçons). Texte illisible : null. */
export function bboxDeGeometrieTexte(texte: string | null | undefined): Bbox | null {
  if (!texte) return null;
  try { return bboxDeGeometrie(JSON.parse(texte)); } catch { return null; }
}

/** [lat, lon][] d'une ligne GeoJSON portee en texte ; vide si ce n'est pas une LineString lisible. */
export function ligneVersLatLng(texte: string | null | undefined): [number, number][] {
  if (!texte) return [];
  try {
    const g = JSON.parse(texte) as { type?: string; coordinates?: unknown };
    if (g.type !== "LineString") return [];
    return positionsDe(g.coordinates, 1).map(([lon, lat]) => [lat, lon]);
  } catch { return []; }
}

// ---------------------------------------------------------------------------------------------------------------
// Propositions : lecture des features
// ---------------------------------------------------------------------------------------------------------------

export const STATUTS = ["A_VERIFIER", "EN_ATTENTE", "NON_CONCLUANTE", "CONFIRMEE", "INFIRMEE"] as const;
export type StatutProposition = (typeof STATUTS)[number];
export const PRIORITES = ["HAUTE", "MOYENNE", "FAIBLE"] as const;
export type NiveauPriorite = (typeof PRIORITES)[number];

export const LIBELLES_STATUT: Record<StatutProposition, string> = {
  A_VERIFIER: "À vérifier",
  EN_ATTENTE: "En attente",
  NON_CONCLUANTE: "Non concluante",
  CONFIRMEE: "Confirmée",
  INFIRMEE: "Infirmée",
};

export const LIBELLES_PRIORITE: Record<NiveauPriorite, string> = { HAUTE: "haute", MOYENNE: "moyenne", FAIBLE: "faible" };

/** Les quatre types connus du noyau backend (`TYPES_PROPOSITION`). Un autre code reste lisible tel quel. */
export const LIBELLES_TYPE: Record<string, string> = {
  NOUVELLE_ROUTE: "Nouvelle route",
  COUPURE_PROBABLE: "Coupure probable",
  VEGETATION: "Végétation",
  INONDATION: "Inondation",
};

export function libelleStatut(statut: string): string {
  return (LIBELLES_STATUT as Record<string, string>)[statut] ?? `statut ${statut}`;
}

export function libelleType(type: string): string {
  const connu = LIBELLES_TYPE[type];
  if (connu) return connu;
  const brut = type.replace(/_/g, " ").trim().toLowerCase();
  return brut ? brut.charAt(0).toUpperCase() + brut.slice(1) : "Type non renseigné";
}

/** « priorité haute », ou « priorité non établie » : l'absence se dit, elle ne devient pas « faible ». */
export function libellePriorite(p: NiveauPriorite | null): string {
  return p ? `priorité ${LIBELLES_PRIORITE[p]}` : "priorité non établie";
}

export type Rattachement = boolean | null;

export function libelleRattachement(r: Rattachement): string {
  if (r === true) return "rattachée à un tronçon";
  if (r === false) return "non rattachée à un tronçon";
  return "rattachement non renseigné";
}

export interface PropositionCarte {
  id: string;
  type: string;
  /** Code brut du serveur : peut etre hors de `STATUTS`, auquel cas le style est neutre. */
  statut: string;
  priorite: NiveauPriorite | null;
  rattachee: Rattachement;
  /** [lat, lon] du repere : le point lui-meme, ou le centre de l'emprise d'un polygone. */
  position: [number, number];
  /** Anneaux [lat, lon] d'un polygone, pour tracer sa surface ; absent pour un point. */
  contour: [number, number][] | null;
}

function lirePriorite(v: unknown): NiveauPriorite | null {
  const niveau = typeof v === "object" && v !== null ? (v as { niveau?: unknown }).niveau : v;
  return typeof niveau === "string" && (PRIORITES as readonly string[]).includes(niveau) ? (niveau as NiveauPriorite) : null;
}

export type LectureProposition =
  | { ok: true; proposition: PropositionCarte }
  | { ok: false; raison: "SANS_IDENTIFIANT" | "GEOMETRIE_ABSENTE" | "GEOMETRIE_NON_DESSINABLE" | "POSITION_INVALIDE" };

/**
 * Lit UNE feature. Priorite acceptee en chaine ou en objet `{ niveau }` (la liste du contrat §6 porte un objet,
 * le geojson §5 une valeur minimale : on lit les deux). Seuls Point et Polygon sont dessines (contrat §5).
 */
export function lireProposition(feature: unknown): LectureProposition {
  const f = feature as { properties?: Record<string, unknown> | null; geometry?: { type?: unknown; coordinates?: unknown } | null } | null;
  const props = f?.properties ?? null;
  const idBrut = props?.id;
  const id = typeof idBrut === "string" ? idBrut.trim() : nombre(idBrut) ? String(idBrut) : "";
  if (!id) return { ok: false, raison: "SANS_IDENTIFIANT" };
  const geo = f?.geometry;
  if (!geo || typeof geo !== "object") return { ok: false, raison: "GEOMETRIE_ABSENTE" };

  let position: [number, number];
  let contour: [number, number][] | null = null;
  if (geo.type === "Point") {
    const p = positionsDe(geo.coordinates, 0);
    if (p.length !== 1) return { ok: false, raison: "POSITION_INVALIDE" };
    position = [p[0][1], p[0][0]];
  } else if (geo.type === "Polygon") {
    const anneaux = Array.isArray(geo.coordinates) ? geo.coordinates : [];
    const exterieur = positionsDe(anneaux[0], 1);
    if (exterieur.length < 3) return { ok: false, raison: "POSITION_INVALIDE" };
    contour = exterieur.map(([lon, lat]) => [lat, lon]);
    const b = bboxDeGeometrie({ type: "Polygon", coordinates: [exterieur] }) as Bbox;
    position = centreBbox(b);
  } else {
    return { ok: false, raison: "GEOMETRIE_NON_DESSINABLE" };
  }

  return {
    ok: true,
    proposition: {
      id,
      type: typeof props?.type === "string" ? props.type : "",
      statut: typeof props?.statut === "string" ? props.statut : "",
      priorite: lirePriorite(props?.priorite),
      rattachee: typeof props?.rattachee === "boolean" ? props.rattachee : null,
      position,
      contour,
    },
  };
}

/**
 * Lit une FeatureCollection. Une feature illisible est ecartee et COMPTEE : l'ecran dit « N illisibles », il ne
 * les efface pas en silence. Un identifiant en double est ecarte aussi (la selection par identifiant serait ambigue).
 */
export function lirePropositions(fc: { features?: unknown } | null | undefined): { propositions: PropositionCarte[]; ignorees: number } {
  const features = Array.isArray(fc?.features) ? (fc!.features as unknown[]) : [];
  const vus = new Set<string>();
  const propositions: PropositionCarte[] = [];
  let ignorees = 0;
  for (const f of features) {
    const l = lireProposition(f);
    if (!l.ok || vus.has(l.proposition.id)) { ignorees += 1; continue; }
    vus.add(l.proposition.id);
    propositions.push(l.proposition);
  }
  return { propositions, ignorees };
}

// ---------------------------------------------------------------------------------------------------------------
// Plafond d'affichage
// ---------------------------------------------------------------------------------------------------------------

const RANG_PRIORITE: Record<string, number> = { HAUTE: 0, MOYENNE: 1, FAIBLE: 2 };
const RANG_STATUT: Record<string, number> = { A_VERIFIER: 0, EN_ATTENTE: 1, NON_CONCLUANTE: 2, CONFIRMEE: 3, INFIRMEE: 4 };

/** Ordre de lecture et de plafonnement : priorite haute d'abord, puis ce qu'il reste a verifier, puis l'identifiant. */
export function comparerPropositions(a: PropositionCarte, b: PropositionCarte): number {
  const pa = a.priorite ? RANG_PRIORITE[a.priorite] : 3;
  const pb = b.priorite ? RANG_PRIORITE[b.priorite] : 3;
  if (pa !== pb) return pa - pb;
  const sa = RANG_STATUT[a.statut] ?? 5;
  const sb = RANG_STATUT[b.statut] ?? 5;
  if (sa !== sb) return sa - sb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Au plus `plafond` propositions a dessiner. La proposition selectionnee reste TOUJOURS dessinee (la masquer
 * contredirait le panneau de detail ouvert). Le reste est compte, jamais perdu en silence.
 */
export function limiterMarqueurs(
  items: readonly PropositionCarte[],
  plafond = PLAFOND_MARQUEURS,
  selectionId: string | null = null,
): { affichees: PropositionCarte[]; nonAffichees: number } {
  const tri = [...items].sort(comparerPropositions);
  if (tri.length <= plafond) return { affichees: tri, nonAffichees: 0 };
  const selection = selectionId ? tri.find((p) => p.id === selectionId) : undefined;
  const base = tri.filter((p) => p !== selection).slice(0, Math.max(0, plafond - (selection ? 1 : 0)));
  const affichees = (selection ? [...base, selection] : base).sort(comparerPropositions);
  return { affichees, nonAffichees: tri.length - affichees.length };
}

/** « N propositions non affichées, zoomez » (accord au singulier). Vide si rien n'est cache. */
export function messagePlafond(nonAffichees: number): string {
  if (!(nonAffichees > 0)) return "";
  return nonAffichees === 1 ? "1 proposition non affichée, zoomez" : `${nonAffichees} propositions non affichées, zoomez`;
}

/** « N propositions illisibles ignorées » : les features sans identifiant ou sans geometrie dessinable. */
export function messageIllisibles(ignorees: number): string {
  if (!(ignorees > 0)) return "";
  return ignorees === 1 ? "1 proposition illisible ignorée (géométrie ou identifiant invalide)" : `${ignorees} propositions illisibles ignorées (géométrie ou identifiant invalide)`;
}

// ---------------------------------------------------------------------------------------------------------------
// Troncature cote serveur (contrat §5 : membres etrangers `tronque` et `total` de la FeatureCollection)
// ---------------------------------------------------------------------------------------------------------------

/** Ce que le serveur dit de sa propre reponse : plus de propositions existent que celles envoyees. */
export interface Troncature { tronque: boolean; total: number }

/**
 * Lit `tronque` et `total` sur une FeatureCollection. Absents ou mal formes : null (un serveur ancien ne dit rien,
 * on ne devine pas). Exception voulue : `tronque: true` est TOUJOURS rendu, meme avec un `total` illisible (alors
 * NaN, que `messageTroncature` dit « total inconnu ») : une troncature ne se perd jamais en silence.
 */
export function lireTroncature(fc: unknown): Troncature | null {
  if (!fc || typeof fc !== "object") return null;
  const { tronque, total } = fc as { tronque?: unknown; total?: unknown };
  if (typeof tronque !== "boolean") return null;
  const totalLisible = typeof total === "number" && Number.isFinite(total) && total >= 0;
  if (!totalLisible && !tronque) return null;
  return { tronque, total: totalLisible ? total : Number.NaN };
}

function pluriel(n: number, singulier: string, plurielMot: string): string {
  return `${n.toLocaleString("fr-FR")} ${n > 1 ? plurielMot : singulier}`;
}

/**
 * « 412 propositions au total, seules les 300 plus prioritaires sont affichées : zoomez ». Vide si la reponse n'est
 * pas tronquee. `affichees` est ce qui est reellement dessine (apres le plafond du navigateur), pas ce qui est recu.
 */
export function messageTroncature(t: Troncature | null | undefined, affichees: number): string {
  if (!t || !t.tronque) return "";
  const m = Math.max(0, Math.trunc(affichees));
  const suite = m === 0 ? "aucune n'est affichée" : m === 1 ? "seule la plus prioritaire est affichée" : `seules les ${m.toLocaleString("fr-FR")} plus prioritaires sont affichées`;
  if (!Number.isFinite(t.total)) return `Résultat tronqué par le serveur, total inconnu, ${suite} : zoomez`;
  return `${pluriel(t.total, "proposition", "propositions")} au total, ${suite} : zoomez`;
}

// ---------------------------------------------------------------------------------------------------------------
// Couches optionnelles (contour, reseau, ouvrages, chantiers) : validation AVANT de les confier a Leaflet
// ---------------------------------------------------------------------------------------------------------------

/**
 * Leaflet leve « Invalid GeoJSON object » (ou une TypeError sur `null`) a la creation du calque : l'exception part
 * dans le rendu React et emporte toute la page. Une couche optionnelle ne doit jamais avoir ce pouvoir : on lit la
 * reponse ici, on ecarte et on COMPTE ce qui n'est pas dessinable, on refuse la couche entiere si rien ne l'est.
 */
export type LectureCouche<T> =
  | { ok: true; donnees: T; ignores: number }
  | { ok: false; raison: string };

const TYPES_GEOMETRIE_SIMPLES = Object.keys(PROFONDEUR);

function coordonneesLisibles(coords: unknown, profondeur: number): boolean {
  if (profondeur === 0) return estPosition(coords);
  return Array.isArray(coords) && coords.length > 0 && coords.every((c) => coordonneesLisibles(c, profondeur - 1));
}

/** Une geometrie que Leaflet sait tracer : type connu, au moins une position, toutes les positions finies et bornees. */
export function geometrieDessinable(g: unknown): boolean {
  if (!g || typeof g !== "object") return false;
  const { type, coordinates, geometries } = g as { type?: unknown; coordinates?: unknown; geometries?: unknown };
  if (type === "GeometryCollection") return Array.isArray(geometries) && geometries.length > 0 && geometries.every(geometrieDessinable);
  if (typeof type !== "string" || !TYPES_GEOMETRIE_SIMPLES.includes(type)) return false;
  return coordonneesLisibles(coordinates, PROFONDEUR[type]);
}

/**
 * Valide une reponse GeoJSON destinee a `<GeoJSON data>` : FeatureCollection, Feature ou geometrie seule.
 * - `{}`, `null`, un texte (page HTML d'un repli SPA), un tableau : refuses ;
 * - FeatureCollection sans tableau `features` : refusee (Leaflet la prendrait pour une geometrie et leverait) ;
 * - FeatureCollection : les features sans geometrie dessinable sont ecartees et comptees (`ignores`) ; si TOUTES le sont,
 *   la couche est refusee ; une collection vide est valide (rien en base, pas une anomalie) ;
 * - Feature a geometrie nulle ou geometrie sans position : refusee (rien a tracer).
 */
export function lireGeoJsonCouche(donnees: unknown): LectureCouche<GeoJSON.GeoJsonObject> {
  if (donnees === null || donnees === undefined) return { ok: false, raison: "réponse vide" };
  if (typeof donnees !== "object" || Array.isArray(donnees)) return { ok: false, raison: "la réponse n'est pas un objet GeoJSON" };
  const o = donnees as { type?: unknown; features?: unknown; geometry?: unknown };
  if (o.type === "FeatureCollection") {
    if (!Array.isArray(o.features)) return { ok: false, raison: "FeatureCollection sans liste d'éléments" };
    const lisibles = o.features.filter((f) => f && typeof f === "object" && geometrieDessinable((f as { geometry?: unknown }).geometry));
    const ignores = o.features.length - lisibles.length;
    if (o.features.length > 0 && lisibles.length === 0) return { ok: false, raison: `aucun des ${o.features.length} éléments n'a de géométrie lisible` };
    return { ok: true, donnees: ignores === 0 ? (donnees as GeoJSON.GeoJsonObject) : ({ ...o, features: lisibles } as GeoJSON.GeoJsonObject), ignores };
  }
  if (o.type === "Feature") {
    return geometrieDessinable(o.geometry) ? { ok: true, donnees: donnees as GeoJSON.GeoJsonObject, ignores: 0 } : { ok: false, raison: "élément sans géométrie lisible" };
  }
  if (geometrieDessinable(donnees)) return { ok: true, donnees: donnees as GeoJSON.GeoJsonObject, ignores: 0 };
  return { ok: false, raison: "type GeoJSON absent ou inconnu" };
}

/** Un point exploitable : identifiant, latitude et longitude finies et bornees (un Marker sans position leve). */
export function pointLatLonLisible(x: unknown): boolean {
  if (!x || typeof x !== "object") return false;
  const { id, lat, lon } = x as { id?: unknown; lat?: unknown; lon?: unknown };
  return (typeof id === "string" || typeof id === "number") && nombre(lat) && nombre(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/**
 * Valide une reponse qui doit etre un TABLEAU d'elements (ouvrages, chantiers). `garder` dit ce qui est exploitable ;
 * le reste est ecarte et compte. Un objet, `null` ou un texte sont refuses (un `.map` dessus ferait planter le rendu).
 */
export function lireTableauCouche<T>(donnees: unknown, garder: (x: unknown) => boolean): LectureCouche<T[]> {
  if (!Array.isArray(donnees)) return { ok: false, raison: donnees === null || donnees === undefined ? "réponse vide" : "la réponse n'est pas une liste" };
  const lisibles = donnees.filter(garder) as T[];
  const ignores = donnees.length - lisibles.length;
  if (donnees.length > 0 && lisibles.length === 0) return { ok: false, raison: `aucun des ${donnees.length} éléments n'est lisible` };
  return { ok: true, donnees: lisibles, ignores };
}

/** Un chantier exploitable : un identifiant. Sa position (tracé ou point approximatif) est controlee au dessin. */
export function chantierLisible(x: unknown): boolean {
  if (!x || typeof x !== "object") return false;
  const id = (x as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number";
}

/** « Données de la couche « Limites administratives » invalides : couche ignorée (réponse vide). » */
export function messageCoucheInvalide(libelleCouche: string, raison: string): string {
  return `Données de la couche « ${libelleCouche} » invalides : couche ignorée (${raison}).`;
}

/** « 3 éléments illisibles ignorés » : la part d'une couche valide qui n'a pas pu etre dessinee. */
export function messageIgnores(ignores: number): string {
  if (!(ignores > 0)) return "";
  return ignores === 1 ? "1 élément illisible ignoré" : `${ignores.toLocaleString("fr-FR")} éléments illisibles ignorés`;
}

// ---------------------------------------------------------------------------------------------------------------
// Style des marqueurs
// ---------------------------------------------------------------------------------------------------------------

export type FormeMarqueur = "triangle" | "losange" | "cercle" | "carre";
export type GlypheStatut = "interrogation" | "pause" | "tiret" | "coche" | "croix" | "point";

/** La couleur du fond porte le STATUT ; elle n'est jamais seule : le glyphe le redit. Blanc dessus >= 4,5:1. */
export const COULEUR_STATUT: Record<StatutProposition, string> = {
  A_VERIFIER: "#b45309",
  EN_ATTENTE: "#1d4ed8",
  NON_CONCLUANTE: "#4b5563",
  CONFIRMEE: "#15803d",
  INFIRMEE: "#b91c1c",
};
export const COULEUR_STATUT_INCONNU = "#374151";

const GLYPHE_STATUT: Record<StatutProposition, GlypheStatut> = {
  A_VERIFIER: "interrogation",
  EN_ATTENTE: "pause",
  NON_CONCLUANTE: "tiret",
  CONFIRMEE: "coche",
  INFIRMEE: "croix",
};

/** La FORME porte la PRIORITE : triangle = haute, losange = moyenne, cercle = faible, carre = non etablie. */
const FORME_PRIORITE: Record<NiveauPriorite, FormeMarqueur> = { HAUTE: "triangle", MOYENNE: "losange", FAIBLE: "cercle" };

export interface StyleMarqueur {
  remplissage: string;
  forme: FormeMarqueur;
  glyphe: GlypheStatut;
  /** Vrai si le statut n'est pas l'un des cinq connus : style neutre, jamais celui d'un autre statut. */
  statutInconnu: boolean;
  /** Anneau pointille : proposition non rattachee a un tronçon (ou rattachement non renseigne). */
  anneauNonRattachee: boolean;
}

export function styleMarqueur(statut: string, priorite: NiveauPriorite | null, rattachee: Rattachement): StyleMarqueur {
  const connu = (STATUTS as readonly string[]).includes(statut);
  const s = statut as StatutProposition;
  return {
    remplissage: connu ? COULEUR_STATUT[s] : COULEUR_STATUT_INCONNU,
    forme: priorite ? FORME_PRIORITE[priorite] : "carre",
    glyphe: connu ? GLYPHE_STATUT[s] : "point",
    statutInconnu: !connu,
    anneauNonRattachee: rattachee !== true,
  };
}

/** Taille (px) du dessin : la proposition selectionnee est plus grande, en plus de son halo. */
export function tailleMarqueur(selectionne: boolean): number {
  return selectionne ? 42 : 34;
}

const BLANC = "#ffffff";

function dessinForme(forme: FormeMarqueur, remplissage: string): string {
  const commun = `fill="${remplissage}" stroke="${BLANC}" stroke-width="2.5" stroke-linejoin="round"`;
  switch (forme) {
    case "triangle": return `<polygon points="16,4 27.5,24.5 4.5,24.5" ${commun}/>`;
    case "losange": return `<polygon points="16,4.5 27.5,16 16,27.5 4.5,16" ${commun}/>`;
    case "cercle": return `<circle cx="16" cy="16" r="10.5" ${commun}/>`;
    case "carre": return `<rect x="5.5" y="5.5" width="21" height="21" rx="3" ${commun}/>`;
  }
}

function dessinGlyphe(glyphe: GlypheStatut, forme: FormeMarqueur): string {
  // Le triangle a son centre visuel plus bas que celui du cadre.
  const dy = forme === "triangle" ? 3 : 0;
  const trait = `fill="none" stroke="${BLANC}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"`;
  let corps: string;
  switch (glyphe) {
    case "interrogation": corps = `<text x="16" y="21" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="14" font-weight="700" fill="${BLANC}">?</text>`; break;
    case "pause": corps = `<path d="M13 11.5 V20.5 M19 11.5 V20.5" ${trait}/>`; break;
    case "tiret": corps = `<path d="M11 16 H21" ${trait}/>`; break;
    case "coche": corps = `<path d="M11 16.5 L14.5 20 L21.5 12" ${trait}/>`; break;
    case "croix": corps = `<path d="M12 12 L20 20 M20 12 L12 20" ${trait}/>`; break;
    case "point": corps = `<circle cx="16" cy="16" r="2" fill="${BLANC}"/>`; break;
  }
  return dy ? `<g transform="translate(0 ${dy})">${corps}</g>` : corps;
}

/**
 * Le marqueur en SVG (chaine). Anneau pointille sombre = non rattachee ; halo dore + taille accrue = selectionnee.
 * Decoratif pour les technologies d'assistance (`aria-hidden`) : le nom accessible est porte par l'element
 * qui l'enveloppe (voir `libelleMarqueur`).
 */
export function svgMarqueur(style: StyleMarqueur, opts: { selectionne?: boolean; taille?: number } = {}): string {
  const selectionne = opts.selectionne === true;
  const t = opts.taille ?? tailleMarqueur(selectionne);
  const halo = selectionne ? `<circle cx="16" cy="16" r="15.2" fill="rgba(245,166,35,0.35)" stroke="#f5a623" stroke-width="1.6"/>` : "";
  const anneau = style.anneauNonRattachee ? `<circle cx="16" cy="16" r="13.2" fill="none" stroke="#111827" stroke-width="1.7" stroke-dasharray="1.6 2.6" stroke-linecap="round"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${t}" height="${t}" aria-hidden="true" focusable="false">${halo}${anneau}${dessinForme(style.forme, style.remplissage)}${dessinGlyphe(style.glyphe, style.forme)}</svg>`;
}

/** Cle de cache d'une icone : tout ce qui change le dessin, rien d'autre. */
export function cleIcone(p: Pick<PropositionCarte, "statut" | "priorite" | "rattachee">, selectionne: boolean): string {
  return `${p.statut}|${p.priorite ?? "-"}|${p.rattachee === true ? "r" : "n"}|${selectionne ? "s" : "-"}`;
}

/** Libelle d'un marqueur, lu par les technologies d'assistance et affiche en infobulle. */
export function libelleMarqueur(p: Pick<PropositionCarte, "type" | "statut" | "priorite" | "rattachee">): string {
  return `${libelleType(p.type)}, ${libelleStatut(p.statut).toLowerCase()}, ${libellePriorite(p.priorite)}, ${libelleRattachement(p.rattachee)}`;
}

/** Phrase de synthese sous la carte : combien dessinees, dont combien non rattachees. */
export function syntheseAffichage(affichees: readonly PropositionCarte[]): string {
  const n = affichees.length;
  if (n === 0) return "Aucune proposition affichée.";
  const non = affichees.filter((p) => p.rattachee !== true).length;
  const base = `${n} proposition${n > 1 ? "s" : ""} affichée${n > 1 ? "s" : ""}`;
  return non > 0 ? `${base}, dont ${non} non rattachée${non > 1 ? "s" : ""} à un tronçon.` : `${base}.`;
}

// ---------------------------------------------------------------------------------------------------------------
// Dates (comparaison avant/apres)
// ---------------------------------------------------------------------------------------------------------------

/**
 * « 23/10/2026 » depuis « 2026-10-23 » ou « 2026-10-23T09:12:00Z ». On lit les chiffres de la date TELLE QU'ECRITE,
 * sans passer par `Date` : pas de decalage de fuseau, pas d'horloge. Illisible ou absente : null.
 */
export function formaterDate(iso: string | null | undefined): string | null {
  if (typeof iso !== "string") return null;
  const m = iso.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/);
  if (!m) return null;
  const [, a, mo, j] = m;
  const mois = Number(mo);
  const jour = Number(j);
  if (mois < 1 || mois > 12 || jour < 1 || jour > 31) return null;
  return `${j}/${mo}/${a}`;
}

/** « Avant (15/09/2026) », ou « Avant (date inconnue) » : une date absente se dit. */
export function libelleDate(prefixe: string, iso: string | null | undefined): string {
  return `${prefixe} (${formaterDate(iso) ?? "date inconnue"})`;
}
