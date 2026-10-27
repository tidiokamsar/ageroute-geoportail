import type { FiltresDecision } from "../components/decision/types";
import type { Intervention, Longueur, ResumeClassement, StatutScore } from "./aideDecisionInterventions";
import { ORDRE_ETATS, SYMBOLES, symbole } from "../features/geoportail/map/symbology";
import { TRAIT_ETAT_DECLARE } from "../pages/geoportail/affichageTroncon";

/**
 * Noyau pur de la carte et de la liste du module Aide a la decision : emprises, plafond, validation des couches,
 * style des marqueurs de PRIORITE, serialisation des filtres, constats calcules. Aucun DOM, aucune horloge (la date du
 * jour est un PARAMETRE), aucun reseau : tout ce qui est decide ici se teste sans navigateur.
 *
 * La mecanique d'emprise, de plafond et de validation GeoJSON est COPIEE de `lib/teledetectionCarte.ts` (branche
 * feat/observation-terre, lue en lecture seule) : meme contrat de bornes cote serveur, memes garde-fous, pas de dependance
 * croisee entre worktrees. Les VALEURS PROVISOIRES ci-dessous sont celles du module Observation de la Terre.
 *
 * CE QUE CE NOYAU S'INTERDIT
 *
 * - Inventer une position, un score, un cout. Une feature sans geometrie lisible est ECARTEE ET COMPTEE, jamais replacee
 *   au centre du pays. Un score absent n'est pas 0 ; un score INCOMPLET n'est jamais presente comme un score complet.
 * - Dire la priorite avec la couleur de l'ETAT PHYSIQUE. L'etat du reseau garde sa palette (vert a rouge, symbology.ts) ;
 *   la priorite a la sienne (violet), sa propre forme (hexagone), son signe (le rang) : un test verifie qu'aucune teinte
 *   de priorite n'est une teinte d'etat.
 * - Taire une troncature : `messageTroncature` dit le total et le nombre affiche, `messagePlafond` ce que le navigateur
 *   n'a pas dessine.
 */

// ---------------------------------------------------------------------------------------------------------------
// Valeurs provisoires (reversibles)
// ---------------------------------------------------------------------------------------------------------------

/** Ouest, sud, est, nord, en degres decimaux (l'ordre de `?bbox=` du contrat). */
export type Bbox = [number, number, number, number];

/** Centre d'ouverture : celui du geoportail (`GUINEE_CENTER`, GeoportailPage.tsx). */
export const CENTRE_GUINEE: [number, number] = [10.5, -10.8];
export const ZOOM_INITIAL = 6;
export const ZOOM_OUVERTURE_MAX = 9;
/** En dessous, l'emprise visible depasse ce qu'on demande au serveur. PROVISOIRE. */
export const ZOOM_MINIMUM_INTERVENTIONS = 6;
/** Cote maximal (degres) d'une emprise demandee. PROVISOIRE ; borne du serveur (comme l'API d'Observation de la Terre). */
export const EMPRISE_MAX_DEGRES = 10;
/** Marqueurs dessines au plus (le serveur plafonne aussi a 300 et dit `tronque`/`total`). PROVISOIRE. */
export const PLAFOND_MARQUEURS = 300;
/** Part de chaque cote ajoutee a l'emprise demandee, pour qu'un petit deplacement ne relance rien. PROVISOIRE. */
export const MARGE_RECHARGEMENT = 0.1;
export const DELAI_EMPRISE_MS = 300;
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

export function arrondirBbox(b: Bbox, decimales = 4): Bbox {
  const f = 10 ** decimales;
  return b.map((v) => Math.round(v * f) / f) as Bbox;
}

export function bboxDepuisLimites(l: { ouest: number; sud: number; est: number; nord: number }): Bbox | null {
  const b: unknown = [l.ouest, l.sud, l.est, l.nord];
  return bboxValide(b) ? arrondirBbox(b) : null;
}

export function bboxVersLimitesLeaflet(b: Bbox): [[number, number], [number, number]] {
  return [[b[1], b[0]], [b[3], b[2]]];
}

export function bboxInclus(interieur: Bbox, exterieur: Bbox): boolean {
  return interieur[0] >= exterieur[0] && interieur[1] >= exterieur[1] && interieur[2] <= exterieur[2] && interieur[3] <= exterieur[3];
}

export const largeurBbox = (b: Bbox): number => b[2] - b[0];
export const hauteurBbox = (b: Bbox): number => b[3] - b[1];

export function bboxTropLarge(b: Bbox, max = EMPRISE_MAX_DEGRES): boolean {
  return largeurBbox(b) > max || hauteurBbox(b) > max;
}

/** Ajoute `ratio` de chaque cote ; rend la vue telle quelle si l'elargissement la ferait refuser (jamais une marge qui fait echouer). */
export function elargirBbox(b: Bbox, ratio = MARGE_RECHARGEMENT, max = EMPRISE_MAX_DEGRES): Bbox {
  const dx = largeurBbox(b) * ratio;
  const dy = hauteurBbox(b) * ratio;
  const large: Bbox = [Math.max(-180, b[0] - dx), Math.max(-90, b[1] - dy), Math.min(180, b[2] + dx), Math.min(90, b[3] + dy)];
  return bboxTropLarge(large, max) ? b : arrondirBbox(large);
}

export function zoomSuffisant(zoom: number, minimum = ZOOM_MINIMUM_INTERVENTIONS): boolean {
  return nombre(zoom) && zoom >= minimum;
}

export type RaisonInsuffisante = "zoom" | "emprise";

/** Zoom d'ouverture : le plus ELOIGNE dont l'emprise visible reste admise par le serveur. */
export function zoomOuverture(tropLarge: (zoom: number) => boolean, depart = ZOOM_INITIAL, max = ZOOM_OUVERTURE_MAX): number {
  for (let z = depart; z < max; z += 1) if (!tropLarge(z)) return z;
  return max;
}

export function etatZoom(zoom: number, bbox: Bbox | null): { suffisant: boolean; raison: RaisonInsuffisante | null } {
  if (!zoomSuffisant(zoom)) return { suffisant: false, raison: "zoom" };
  if (bbox && bboxTropLarge(bbox)) return { suffisant: false, raison: "emprise" };
  return { suffisant: true, raison: null };
}

/**
 * L'emprise a demander apres un deplacement de la vue. `null` = ne rien recharger.
 * Une reponse TRONQUEE n'est pas « l'emprise chargee » : zoomer dedans ferait manquer des interventions, on recharge.
 */
export function empriseARecharger(args: { chargee: Bbox | null; courante: Bbox; zoom: number; tronquee?: boolean }): Bbox | null {
  const { chargee, courante, zoom, tronquee = false } = args;
  if (!etatZoom(zoom, courante).suffisant) return null;
  if (chargee && !tronquee && bboxInclus(courante, chargee)) return null;
  return elargirBbox(courante);
}

export function bboxAutour(lat: number, lon: number, demiCote = DEMI_COTE_CADRAGE_VILLE_DEG): Bbox | null {
  if (!nombre(lat) || !nombre(lon) || !nombre(demiCote) || demiCote < 0) return null;
  const b: unknown = [lon - demiCote, lat - demiCote, lon + demiCote, lat + demiCote];
  return bboxValide(b) ? arrondirBbox(b, 5) : null;
}

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

export function bboxDeGeometrie(g: unknown): Bbox | null {
  const pos = positionsGeometrie(g);
  if (pos.length === 0) return null;
  let [o, s, e, n] = [pos[0][0], pos[0][1], pos[0][0], pos[0][1]];
  for (const [x, y] of pos) { o = Math.min(o, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  return [o, s, e, n];
}

/** Idem pour une geometrie portee en TEXTE (`ST_AsGeoJSON` des troncons). Texte illisible : null. */
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
// Couches optionnelles : validation AVANT de les confier a Leaflet
// ---------------------------------------------------------------------------------------------------------------

/**
 * Leaflet leve « Invalid GeoJSON object » a la creation du calque : l'exception part dans le rendu React et emporte toute la
 * page. Une couche ne doit jamais avoir ce pouvoir : on lit la reponse ici, on ecarte et on COMPTE ce qui n'est pas
 * dessinable, on refuse la couche entiere si rien ne l'est (la page continue, le message le dit).
 */
export type LectureCouche<T> = { ok: true; donnees: T; ignores: number } | { ok: false; raison: string };

const TYPES_GEOMETRIE_SIMPLES = Object.keys(PROFONDEUR);

function coordonneesLisibles(coords: unknown, profondeur: number): boolean {
  if (profondeur === 0) return estPosition(coords);
  return Array.isArray(coords) && coords.length > 0 && coords.every((c) => coordonneesLisibles(c, profondeur - 1));
}

export function geometrieDessinable(g: unknown): boolean {
  if (!g || typeof g !== "object") return false;
  const { type, coordinates, geometries } = g as { type?: unknown; coordinates?: unknown; geometries?: unknown };
  if (type === "GeometryCollection") return Array.isArray(geometries) && geometries.length > 0 && geometries.every(geometrieDessinable);
  if (typeof type !== "string" || !TYPES_GEOMETRIE_SIMPLES.includes(type)) return false;
  return coordonneesLisibles(coordinates, PROFONDEUR[type]);
}

/** Valide une reponse destinee a `<GeoJSON data>` : FeatureCollection, Feature ou geometrie seule. */
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

/** Valide une reponse qui doit etre un TABLEAU (ouvrages, chantiers, points noirs) ; le reste est ecarte et compte. */
export function lireTableauCouche<T>(donnees: unknown, garder: (x: unknown) => boolean): LectureCouche<T[]> {
  if (!Array.isArray(donnees)) return { ok: false, raison: donnees === null || donnees === undefined ? "réponse vide" : "la réponse n'est pas une liste" };
  const lisibles = donnees.filter(garder) as T[];
  const ignores = donnees.length - lisibles.length;
  if (donnees.length > 0 && lisibles.length === 0) return { ok: false, raison: `aucun des ${donnees.length} éléments n'est lisible` };
  return { ok: true, donnees: lisibles, ignores };
}

export function chantierLisible(x: unknown): boolean {
  if (!x || typeof x !== "object") return false;
  const id = (x as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number";
}

export function messageCoucheInvalide(libelleCouche: string, raison: string): string {
  return `Données de la couche « ${libelleCouche} » invalides : couche ignorée (${raison}).`;
}

export function messageIgnores(ignores: number): string {
  if (!(ignores > 0)) return "";
  return ignores === 1 ? "1 élément illisible ignoré" : `${ignores.toLocaleString("fr-FR")} éléments illisibles ignorés`;
}

// ---------------------------------------------------------------------------------------------------------------
// Reseau classe (couche ETAT PHYSIQUE)
// ---------------------------------------------------------------------------------------------------------------

export interface TronconReseau {
  id: string;
  code: string;
  nom: string;
  classe: string;
  etat: string;
  /** Etat seulement DECLARE (pas constate) : dessine en pointille (convention du geoportail). */
  etatDeclare: boolean;
  region: string | null;
  longueurKm: number | null;
  geometrie: GeoJSON.Geometry;
}

/** Lit la reponse de `/troncons/geo` (geometrie en TEXTE). Un troncon sans identifiant ou a geometrie illisible est ecarte et compte. */
export function lireReseau(donnees: unknown): LectureCouche<TronconReseau[]> {
  if (!Array.isArray(donnees)) return { ok: false, raison: donnees === null || donnees === undefined ? "réponse vide" : "la réponse n'est pas une liste" };
  const sortie: TronconReseau[] = [];
  const vus = new Set<string>();
  for (const x of donnees) {
    const o = x as Record<string, unknown> | null;
    if (!o || typeof o !== "object" || typeof o.id !== "string" || vus.has(o.id) || typeof o.geometry !== "string") continue;
    let g: unknown;
    try { g = JSON.parse(o.geometry); } catch { continue; }
    if (!geometrieDessinable(g)) continue;
    vus.add(o.id);
    sortie.push({
      id: o.id,
      code: typeof o.code === "string" ? o.code : "",
      nom: typeof o.nom === "string" ? o.nom : "",
      classe: typeof o.classe === "string" ? o.classe : "NON_CLASSEE",
      etat: typeof o.etat === "string" ? o.etat : "NON_EVALUE",
      etatDeclare: o.etatDeclare === true,
      region: typeof o.region === "string" ? o.region : null,
      longueurKm: nombre(o.longueurKm) ? o.longueurKm : null,
      geometrie: g as GeoJSON.Geometry,
    });
  }
  const ignores = donnees.length - sortie.length;
  if (donnees.length > 0 && sortie.length === 0) return { ok: false, raison: `aucun des ${donnees.length} tronçons n'a de géométrie lisible` };
  return { ok: true, donnees: sortie, ignores };
}

export function reseauEnFeatureCollection(troncons: readonly TronconReseau[]): GeoJSON.FeatureCollection<GeoJSON.Geometry, { id: string }> {
  return { type: "FeatureCollection", features: troncons.map((t) => ({ type: "Feature" as const, geometry: t.geometrie, properties: { id: t.id } })) };
}

export type ModeStyleReseau = "etat" | "neutre";
const EPAISSEUR_CLASSE: Record<string, number> = { RN: 4.5, RR: 3.8, RU: 3.2, PISTE: 2.8, NON_CLASSEE: 2.6 };
export const COULEUR_RESEAU_NEUTRE = "#9aa0aa";

/**
 * Style d'un troncon. En mode `etat`, la couleur est celle de l'ETAT PHYSIQUE (echelle unique de symbology.ts) et un etat
 * seulement declare est POINTILLE (meme trait que le geoportail). En mode `neutre` (vue Priorites), le reseau n'est qu'un
 * fond gris : l'etat n'y est pas peint, pour qu'aucune couleur d'etat ne se lise comme une priorite.
 */
export function styleReseau(t: Pick<TronconReseau, "etat" | "etatDeclare" | "classe">, mode: ModeStyleReseau): { color: string; weight: number; opacity: number; dashArray?: string } {
  const weight = EPAISSEUR_CLASSE[t.classe] ?? 2.6;
  if (mode === "neutre") return { color: COULEUR_RESEAU_NEUTRE, weight: Math.min(weight, 3), opacity: 0.75 };
  return { color: symbole(t.etat).trait, weight, opacity: 0.95, dashArray: t.etatDeclare ? TRAIT_ETAT_DECLARE : undefined };
}

// ---------------------------------------------------------------------------------------------------------------
// Filtres : libelles et application aux couches de contexte (la SERIALISATION unique est `paramsApi` de `lib/decision.ts`, lot 1)
// ---------------------------------------------------------------------------------------------------------------

export const CLASSES_ROUTE: { code: string; libelle: string }[] = [
  { code: "RN", libelle: "Routes nationales (RN)" },
  { code: "RR", libelle: "Routes préfectorales (RP)" },
  { code: "RU", libelle: "Voiries urbaines (VU)" },
  { code: "PISTE", libelle: "Pistes rurales" },
  { code: "NON_CLASSEE", libelle: "Non classées" },
];

export const STATUTS_CHANTIER: { code: string; libelle: string }[] = [
  { code: "PLANIFIE", libelle: "Planifiés" },
  { code: "EN_COURS", libelle: "En cours" },
  { code: "SUSPENDU", libelle: "Suspendus" },
  { code: "TERMINE", libelle: "Terminés" },
];

/** Les etats physiques, libelles DIRECTS (ceux de symbology.ts : « Critique » se lit « Critique »). */
export const ETATS_PHYSIQUES: { code: string; libelle: string }[] = ORDRE_ETATS.map((e) => ({ code: e, libelle: SYMBOLES[e].libelle }));

export function basculerDansListe(liste: string[] | undefined, code: string): string[] | undefined {
  const l = liste ?? [];
  const suite = l.includes(code) ? l.filter((x) => x !== code) : [...l, code];
  return suite.length ? suite : undefined;
}

/** Applique region/classe/etat au reseau. Region non resolue (liste des regions indisponible) : le filtre n'est PAS applique, et on le dit. */
export function filtrerReseau(troncons: readonly TronconReseau[], f: FiltresDecision, nomRegion: string | null): { troncons: TronconReseau[]; regionNonAppliquee: boolean } {
  const regionNonAppliquee = nombre(f.regionId) && nomRegion === null;
  const classes = f.classe?.length ? new Set(f.classe) : null;
  const etats = f.etat?.length ? new Set(f.etat) : null;
  return {
    regionNonAppliquee,
    troncons: troncons.filter((t) =>
      (!nombre(f.regionId) || nomRegion === null || t.region === nomRegion) && (!classes || classes.has(t.classe)) && (!etats || etats.has(t.etat))),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Modes de vue et couches
// ---------------------------------------------------------------------------------------------------------------

export type ModeVue = "etat" | "priorites" | "chantiers" | "budget";

export interface DefinitionMode { id: ModeVue; libelle: string; disponible: boolean; raison: string | null }

/** Un mode sans donnees structurees est DESACTIVE avec sa raison : jamais un mode vide et muet. */
export const MODES_VUE: DefinitionMode[] = [
  { id: "etat", libelle: "État actuel", disponible: true, raison: null },
  { id: "priorites", libelle: "Priorités", disponible: true, raison: null },
  {
    id: "chantiers", libelle: "Chantiers", disponible: false,
    raison: "le statut, la période et le bailleur des chantiers ne sont pas encore structurés (le bailleur est un texte libre) ; la couche « Chantiers » reste consultable à part",
  },
  {
    id: "budget", libelle: "Budget", disponible: false,
    raison: "la source financière n'est pas validée (décision B-08) : rien n'est affiché plutôt qu'un chiffre inventé",
  },
];

export interface CouchesCarte { reseau: boolean; priorites: boolean; chantiers: boolean; ouvrages: boolean; pointsNoirs: boolean; limites: boolean }

export const COUCHES_PAR_DEFAUT: CouchesCarte = { reseau: true, priorites: false, chantiers: false, ouvrages: false, pointsNoirs: false, limites: true };

/** Choisir un mode regle les deux couches qu'il concerne ; les couches de contexte restent au choix de l'agent. */
export function couchesPourMode(mode: ModeVue, courantes: CouchesCarte): CouchesCarte {
  if (mode === "priorites") return { ...courantes, reseau: true, priorites: true };
  return { ...courantes, reseau: true, priorites: false };
}

/** Le reseau est peint par l'etat dans la vue « Etat actuel » seulement. */
export function modeStyleReseau(mode: ModeVue): ModeStyleReseau {
  return mode === "etat" ? "etat" : "neutre";
}

// ---------------------------------------------------------------------------------------------------------------
// Interventions sur la carte (couche PRIORITES)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Forme lue : `properties` du backend reel = `{ id, code, nom, rang, score, scoreIncomplet, statutScore, etatPhysique, classe, regionId,
 * couverture, rangArbitrage }`. Il n'y a PAS de niveau de priorite (haute, moyenne, faible) : la priorite est un RANG et un score ; on n'en
 * invente pas de seuils. La carte distingue trois genres seulement : classee, classee sur score INCOMPLET, NON CLASSEE (exclue).
 */
export interface InterventionCarte {
  id: string;
  code: string | null;
  nom: string | null;
  rang: number | null;
  score: number | null;
  scoreIncomplet: boolean;
  statutScore: "CALCULE" | "INCOMPLET" | "EXCLU" | null;
  etatPhysique: string | null;
  classe: string | null;
  /** [lat, lon] du repere : le point lui-meme, ou le sommet median d'une ligne. */
  position: [number, number];
  /** Trace [lat, lon] des lignes (troncon), absent pour un point. */
  lignes: [number, number][][] | null;
}

export type LectureInterventionCarte =
  | { ok: true; intervention: InterventionCarte }
  | { ok: false; raison: "SANS_IDENTIFIANT" | "GEOMETRIE_ABSENTE" | "GEOMETRIE_NON_DESSINABLE" | "POSITION_INVALIDE" };

const texteOuNull = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/** Lit UNE feature de `interventions.geojson`. Seuls Point, LineString et MultiLineString sont dessines ; le reste est ecarte et compte. */
export function lireInterventionCarte(feature: unknown): LectureInterventionCarte {
  const f = feature as { properties?: Record<string, unknown> | null; geometry?: { type?: unknown; coordinates?: unknown } | null } | null;
  const props = f?.properties ?? null;
  const idBrut = props?.id;
  const id = typeof idBrut === "string" ? idBrut.trim() : nombre(idBrut) ? String(idBrut) : "";
  if (!id) return { ok: false, raison: "SANS_IDENTIFIANT" };
  const geo = f?.geometry;
  if (!geo || typeof geo !== "object") return { ok: false, raison: "GEOMETRIE_ABSENTE" };

  let position: [number, number];
  let lignes: [number, number][][] | null = null;
  if (geo.type === "Point") {
    const p = positionsDe(geo.coordinates, 0);
    if (p.length !== 1) return { ok: false, raison: "POSITION_INVALIDE" };
    position = [p[0][1], p[0][0]];
  } else if (geo.type === "LineString" || geo.type === "MultiLineString") {
    const brutes = geo.type === "LineString" ? [geo.coordinates] : Array.isArray(geo.coordinates) ? geo.coordinates : [];
    const l = brutes.map((c) => positionsDe(c, 1).map(([lon, lat]) => [lat, lon] as [number, number])).filter((x) => x.length >= 2);
    if (l.length === 0) return { ok: false, raison: "POSITION_INVALIDE" };
    lignes = l;
    const premiere = l[0];
    position = premiere[Math.floor(premiere.length / 2)];
  } else {
    return { ok: false, raison: "GEOMETRIE_NON_DESSINABLE" };
  }
  const statut = props?.statutScore;
  return {
    ok: true,
    intervention: {
      id,
      code: texteOuNull(props?.code),
      nom: texteOuNull(props?.nom),
      rang: nombre(props?.rang) ? props.rang : null,
      score: nombre(props?.score) ? props.score : null,
      scoreIncomplet: props?.scoreIncomplet === true,
      statutScore: statut === "CALCULE" || statut === "INCOMPLET" || statut === "EXCLU" ? statut : null,
      etatPhysique: texteOuNull(props?.etatPhysique),
      classe: texteOuNull(props?.classe),
      position,
      lignes,
    },
  };
}

/** Lit une FeatureCollection. Une feature illisible ou un identifiant en double est ecarte et COMPTE : l'ecran le dit. */
export function lireInterventionsGeo(fc: { features?: unknown } | null | undefined): { interventions: InterventionCarte[]; ignorees: number } {
  const features = Array.isArray(fc?.features) ? (fc!.features as unknown[]) : [];
  const vus = new Set<string>();
  const interventions: InterventionCarte[] = [];
  let ignorees = 0;
  for (const f of features) {
    const l = lireInterventionCarte(f);
    if (!l.ok || vus.has(l.intervention.id)) { ignorees += 1; continue; }
    vus.add(l.intervention.id);
    interventions.push(l.intervention);
  }
  return { interventions, ignorees };
}

/** Rang croissant (les rangs absents, c'est-a-dire les non classees, en dernier), puis identifiant : l'ordre de lecture ET de plafonnement. */
export function comparerInterventions(a: InterventionCarte, b: InterventionCarte): number {
  const ra = a.rang ?? Number.POSITIVE_INFINITY;
  const rb = b.rang ?? Number.POSITIVE_INFINITY;
  if (ra !== rb) return ra < rb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Au plus `plafond` marqueurs ; l'intervention selectionnee reste TOUJOURS dessinee (la masquer contredirait la fiche ouverte). Le reste est compte. */
export function limiterMarqueurs(
  items: readonly InterventionCarte[], plafond = PLAFOND_MARQUEURS, selectionId: string | null = null,
): { affichees: InterventionCarte[]; nonAffichees: number } {
  const tri = [...items].sort(comparerInterventions);
  if (tri.length <= plafond) return { affichees: tri, nonAffichees: 0 };
  const selection = selectionId ? tri.find((p) => p.id === selectionId) : undefined;
  const base = tri.filter((p) => p !== selection).slice(0, Math.max(0, plafond - (selection ? 1 : 0)));
  const affichees = (selection ? [...base, selection] : base).sort(comparerInterventions);
  return { affichees, nonAffichees: tri.length - affichees.length };
}

export function messagePlafond(nonAffichees: number): string {
  if (!(nonAffichees > 0)) return "";
  return nonAffichees === 1 ? "1 intervention non affichée, zoomez" : `${nonAffichees} interventions non affichées, zoomez`;
}

export function messageIllisibles(ignorees: number): string {
  if (!(ignorees > 0)) return "";
  return ignorees === 1 ? "1 intervention illisible ignorée (géométrie ou identifiant invalide)" : `${ignorees} interventions illisibles ignorées (géométrie ou identifiant invalide)`;
}

// ---------------------------------------------------------------------------------------------------------------
// Troncature cote serveur (membres etrangers `tronque` et `total` de la FeatureCollection) et meta de la reponse
// ---------------------------------------------------------------------------------------------------------------

export interface Troncature { tronque: boolean; total: number }

/** `tronque: true` est TOUJOURS rendu, meme avec un `total` illisible (alors NaN, dit « total inconnu ») : une troncature ne se perd jamais en silence. */
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

/** « 412 interventions au total, seules les 300 plus prioritaires sont affichées : zoomez ». Vide si la reponse n'est pas tronquee. */
export function messageTroncature(t: Troncature | null | undefined, affichees: number): string {
  if (!t || !t.tronque) return "";
  const m = Math.max(0, Math.trunc(affichees));
  const suite = m === 0 ? "aucune n'est affichée" : m === 1 ? "seule la plus prioritaire est affichée" : `seules les ${m.toLocaleString("fr-FR")} plus prioritaires sont affichées`;
  if (!Number.isFinite(t.total)) return `Résultat tronqué par le serveur, total inconnu, ${suite} : zoomez`;
  return `${pluriel(t.total, "intervention", "interventions")} au total, ${suite} : zoomez`;
}

/** Ce que le serveur dit de la selection : combien d'interventions n'ont pas de geometrie exploitable (elles restent dans la liste), et les filtres non appliques. */
export function lireMetaGeo(fc: unknown): { horsGeometrie: number | null; filtresNonAppliques: string[] } {
  const o = fc && typeof fc === "object" ? (fc as { horsGeometrie?: unknown; filtres?: { nonAppliques?: unknown } }) : {};
  const na = Array.isArray(o.filtres?.nonAppliques) ? (o.filtres!.nonAppliques as unknown[]) : [];
  return {
    horsGeometrie: nombre(o.horsGeometrie) && o.horsGeometrie >= 0 ? o.horsGeometrie : null,
    filtresNonAppliques: na.map((x) => texteOuNull((x as { filtre?: unknown })?.filtre)).filter((x): x is string => x !== null),
  };
}

export function messageHorsGeometrie(n: number | null): string {
  if (n === null || n <= 0) return "";
  return n === 1
    ? "1 intervention du périmètre n'a pas de localisation valide : absente de la carte, elle reste dans la liste"
    : `${n.toLocaleString("fr-FR")} interventions du périmètre n'ont pas de localisation valide : absentes de la carte, elles restent dans la liste`;
}

// ---------------------------------------------------------------------------------------------------------------
// Style des marqueurs : hexagone violet + rang ; JAMAIS la palette de l'etat physique
// ---------------------------------------------------------------------------------------------------------------

/** Les trois genres que la donnee distingue : classee (score complet), classee sur score INCOMPLET, NON CLASSEE (exclue, sans rang ni score). */
export type GenreMarqueur = "CALCULE" | "INCOMPLET" | "EXCLU";

export function genreMarqueur(i: Pick<InterventionCarte, "statutScore" | "scoreIncomplet" | "rang">): GenreMarqueur {
  if (i.statutScore === "EXCLU" || (i.statutScore === null && i.rang === null)) return "EXCLU";
  if (i.scoreIncomplet || i.statutScore === "INCOMPLET") return "INCOMPLET";
  return "CALCULE";
}

export interface CouleursPriorite { fond: string; texte: string; bord: string }

/**
 * Teintes de la priorite : une famille VIOLETTE (l'etat physique va du vert au rouge, symbology.ts). La couleur n'est jamais seule : le rang est
 * ecrit dans le marqueur, le score incomplet porte un contour pointille et le signe « ? », une ligne non classee est GRISE et sans rang.
 * Texte clair sur fond fonce >= 4,5:1, texte fonce sur fonds clairs >= 4,5:1.
 */
export const COULEURS_PRIORITE: Record<GenreMarqueur, CouleursPriorite> = {
  CALCULE: { fond: "#4c1d95", texte: "#ffffff", bord: "#ffffff" },
  INCOMPLET: { fond: "#ddd6fe", texte: "#2e1065", bord: "#4c1d95" },
  EXCLU: { fond: "#e5e7eb", texte: "#1f2937", bord: "#4b5563" },
};
/** Signe du score incomplet : disque ambre portant « ? ». Distinct de toute teinte d'etat. */
export const COULEUR_SIGNE_INCOMPLET = "#92400e";
export const COULEUR_HALO_SELECTION = "#f5a623";

export interface StyleMarqueurIntervention extends CouleursPriorite {
  /** Texte ecrit dans l'hexagone (le rang, ou « · » s'il manque). */
  etiquette: string;
  /** Contour pointille et signe « ? » : le score est INCOMPLET. */
  incomplet: boolean;
  genre: GenreMarqueur;
}

export function etiquetteRang(rang: number | null): string {
  if (rang === null) return "·";
  return rang > 999 ? "999+" : String(Math.max(0, Math.trunc(rang)));
}

export function styleMarqueurIntervention(i: Pick<InterventionCarte, "statutScore" | "scoreIncomplet" | "rang">): StyleMarqueurIntervention {
  const genre = genreMarqueur(i);
  return { ...COULEURS_PRIORITE[genre], etiquette: etiquetteRang(i.rang), incomplet: genre === "INCOMPLET", genre };
}

export function tailleMarqueur(selectionne: boolean): number {
  return selectionne ? 46 : 38;
}

/**
 * Le marqueur en SVG (chaine). Decoratif pour les technologies d'assistance (`aria-hidden`) : le nom accessible est porte par l'element
 * qui l'enveloppe (`libelleIntervention`). Contour POINTILLE + disque « ? » = score incomplet ; halo dore = selection.
 */
export function svgMarqueurIntervention(s: StyleMarqueurIntervention, opts: { selectionne?: boolean; taille?: number } = {}): string {
  const selectionne = opts.selectionne === true;
  const t = opts.taille ?? tailleMarqueur(selectionne);
  const halo = selectionne ? `<circle cx="16" cy="16" r="15.4" fill="rgba(245,166,35,0.35)" stroke="${COULEUR_HALO_SELECTION}" stroke-width="1.6"/>` : "";
  const tirets = s.incomplet ? ` stroke-dasharray="3 2.4"` : "";
  const hexagone = `<polygon points="16,3.5 26.8,9.75 26.8,22.25 16,28.5 5.2,22.25 5.2,9.75" fill="${s.fond}" stroke="${s.bord}" stroke-width="${s.incomplet ? 2.2 : 2}" stroke-linejoin="round"${tirets}/>`;
  const taillePolice = s.etiquette.length >= 4 ? 8 : s.etiquette.length === 3 ? 9.5 : 12;
  const texte = `<text x="16" y="${16 + taillePolice * 0.36}" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="${taillePolice}" font-weight="700" fill="${s.texte}">${s.etiquette}</text>`;
  const signe = s.incomplet
    ? `<circle cx="25.5" cy="7" r="5.4" fill="${COULEUR_SIGNE_INCOMPLET}" stroke="#ffffff" stroke-width="1.4"/><text x="25.5" y="9.7" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="8" font-weight="700" fill="#ffffff">?</text>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${t}" height="${t}" aria-hidden="true" focusable="false">${halo}${hexagone}${texte}${signe}</svg>`;
}

/** Cle de cache d'une icone : tout ce qui change le dessin, rien d'autre. */
export function cleIcone(i: Pick<InterventionCarte, "statutScore" | "scoreIncomplet" | "rang" | "code">, selectionne: boolean): string {
  return `${genreMarqueur(i)}|${etiquetteRang(i.rang)}|${i.code ?? "-"}|${selectionne ? "s" : "-"}`;
}

export function libelleEtatPhysique(etat: string | null): string {
  return etat ? `état ${symbole(etat).libelle.toLowerCase()}` : "état physique inconnu";
}

/** Libelle d'un marqueur, lu par les technologies d'assistance et affiche en infobulle. */
export function libelleIntervention(i: Pick<InterventionCarte, "rang" | "code" | "statutScore" | "scoreIncomplet" | "etatPhysique">): string {
  const genre = genreMarqueur(i);
  const rang = genre === "EXCLU" ? "non classée" : i.rang === null ? "rang non établi" : `rang ${i.rang}`;
  const score = genre === "EXCLU" ? "sans score" : genre === "INCOMPLET" ? "score incomplet" : "score complet";
  return `Intervention ${rang}${i.code ? ` ${i.code}` : ""}, ${score}, ${libelleEtatPhysique(i.etatPhysique)}`;
}

export function syntheseAffichage(affichees: readonly InterventionCarte[]): string {
  const n = affichees.length;
  if (n === 0) return "Aucune intervention affichée.";
  const inc = affichees.filter((p) => genreMarqueur(p) === "INCOMPLET").length;
  const exc = affichees.filter((p) => genreMarqueur(p) === "EXCLU").length;
  const base = `${n} intervention${n > 1 ? "s" : ""} affichée${n > 1 ? "s" : ""}`;
  const parts = [inc > 0 ? `${inc} au score incomplet` : null, exc > 0 ? `${exc} non classée${exc > 1 ? "s" : ""}` : null].filter(Boolean);
  return parts.length ? `${base}, dont ${parts.join(" et ")}.` : `${base}.`;
}

/** Trace d'une intervention sur un troncon : violet, JAMAIS la couleur de l'etat. */
export function styleLigneIntervention(selectionne: boolean, scoreIncomplet: boolean): { color: string; weight: number; opacity: number; dashArray?: string } {
  return {
    color: selectionne ? COULEUR_HALO_SELECTION : "#6d28d9",
    weight: selectionne ? 8 : 6,
    opacity: selectionne ? 0.9 : 0.55,
    dashArray: scoreIncomplet ? "2 7" : undefined,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Presentation du score, du cout, des longueurs, des dates
// ---------------------------------------------------------------------------------------------------------------

export function formaterNombre(n: number, decimales = 1): string {
  return n.toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: decimales });
}

export type GenreScore = "complet" | "incomplet" | "exclu" | "absent";
export interface ScorePresente { genre: GenreScore; libelle: string; valeur: string | null; motif: string | null }

/**
 * Le score tel qu'il se LIT. Un score incomplet est PARTIEL : il n'est jamais rendu comme un score complet (cahier 6.3, AD-06). Il porte son
 * libelle « Score incomplet » et, s'il existe, sa valeur partielle nommee comme telle. Une ligne NON CLASSEE (exclue) n'a ni rang ni score : elle
 * dit son motif. Un score absent n'est pas 0. L'echelle du score est 0 a 100 (backend).
 */
export function presenterScore(score: number | null, scoreIncomplet: boolean, exclusion: { code: string; motif: string } | null = null): ScorePresente {
  const valeur = score === null ? null : formaterNombre(score, 1);
  if (exclusion) return { genre: "exclu", libelle: "Non classée", valeur: null, motif: `${libelleExclusion(exclusion.code)} : ${exclusion.motif}` };
  if (scoreIncomplet) return { genre: "incomplet", libelle: "Score incomplet", valeur, motif: null };
  if (valeur === null) return { genre: "absent", libelle: "Score non calculé", valeur: null, motif: null };
  return { genre: "complet", libelle: `Score ${valeur}`, valeur, motif: null };
}

/** Motifs d'exclusion connus du noyau de priorite (`CodeExclusionPriorite`) ; un autre code reste lisible tel quel. */
export function libelleExclusion(code: string): string {
  const L: Record<string, string> = {
    ETAT_NON_EVALUE: "état non évalué",
    COUVERTURE_INSUFFISANTE: "couverture des critères insuffisante",
    AUCUN_CRITERE_PONDERE: "aucun critère pondéré",
  };
  return L[code] ?? code.replace(/_/g, " ").toLowerCase();
}

/** « 1 200 000 000 » : separateur de milliers insecable, sur la CHAINE (un montant en GNF depasse la precision d'un `number` flottant). */
export function formaterMontant(valeur: string): string {
  const m = valeur.trim().match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!m) return valeur;
  const entier = m[2].replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${m[1]}${entier}${m[3] ? `,${m[3]}` : ""}`;
}

/** « 23/10/2026 » depuis « 2026-10-23 » ou « 2026-10-23T09:12:00Z », sans passer par `Date` (pas de fuseau, pas d'horloge). */
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

export type ValiditeCout = "valide" | "perime" | "inconnue";

/** Validite d'un cout a une date (AAAA-MM-JJ) donnee PAR L'APPELANT : le noyau n'a pas d'horloge. Fin absente ou illisible : « inconnue ». */
export function validiteCout(validiteFin: string | null, aujourdhui: string): ValiditeCout {
  const fin = validiteFin?.trim().slice(0, 10) ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fin) || formaterDate(fin) === null) return "inconnue";
  return fin < aujourdhui ? "perime" : "valide";
}

export interface CoutPresente {
  genre: "estime" | "non-estimable" | "non-renseigne";
  libelle: string;
  detail: string | null;
  validite: ValiditeCout | null;
}

/**
 * Le cout tel qu'il se LIT : montant + devise, source du bareme et validite (fin de validite du bareme), ou « Coût non estimable » avec le
 * MOTIF du serveur, ou « Coût non renseigné » ; JAMAIS 0.
 */
export function presenterCout(i: Pick<Intervention, "coutEstime" | "coutNonEstimable">, aujourdhui: string): CoutPresente {
  const c = i.coutEstime;
  if (c) {
    const validite = validiteCout(c.bareme?.validA ?? null, aujourdhui);
    const fin = formaterDate(c.bareme?.validA);
    const txtValidite = validite === "perime" ? `périmé depuis le ${fin}` : validite === "valide" ? `valide jusqu'au ${fin}` : "validité inconnue";
    return {
      genre: "estime",
      libelle: `${formaterMontant(c.montantGnf)} ${c.devise}`,
      detail: `source : ${c.bareme?.source ?? "non précisée"} ; ${txtValidite}${c.provisoire ? " ; estimation provisoire" : ""}`,
      validite,
    };
  }
  if (i.coutNonEstimable) return { genre: "non-estimable", libelle: "Coût non estimable", detail: i.coutNonEstimable.motif, validite: null };
  return { genre: "non-renseigne", libelle: "Coût non renseigné", detail: null, validite: null };
}

export interface EcartLongueur { ecartKm: number | null; ecartRelatif: number | null; signale: boolean }

/**
 * Divergence longueur metier / geometrique. Elle est CALCULEE PAR LE SERVEUR (seuils PROVISOIRES du detecteur de qualite) : le client ne
 * recalcule rien, il rend `divergence.signalee`. Sans divergence connue : null (pas de calcul).
 */
export function ecartLongueur(l: Longueur | null): EcartLongueur | null {
  if (!l || !l.divergence) return null;
  const ecartKm = l.metierKm !== null && l.geometriqueKm !== null ? Math.abs(l.metierKm - l.geometriqueKm) : null;
  return { ecartKm, ecartRelatif: l.divergence.ecartRelatif, signale: l.divergence.signalee === true };
}

// ---------------------------------------------------------------------------------------------------------------
// Constats calcules (panneau « Insights et recommandations ») et vues de la liste
// ---------------------------------------------------------------------------------------------------------------

/**
 * Vues de la liste, posees par un constat. « Score incomplet » et « Non classées » sont des filtres d'AFFICHAGE du SERVEUR (`statutScore`, les rangs
 * ne changent pas) : la liste est alors exacte et paginee. Les trois autres portent sur les lignes chargees.
 */
export type VueListe = "toutes" | "score-incomplet" | "non-classees" | "sans-localisation" | "cout-non-estimable" | "critiques";

export const VUES_LISTE: { id: VueListe; libelle: string }[] = [
  { id: "toutes", libelle: "Toutes les interventions chargées" },
  { id: "score-incomplet", libelle: "Score incomplet" },
  { id: "non-classees", libelle: "Non classées (exclues du classement)" },
  { id: "sans-localisation", libelle: "Sans localisation valide" },
  { id: "cout-non-estimable", libelle: "Coût non estimable" },
  { id: "critiques", libelle: "État physique critique" },
];

export function vueListeValide(v: unknown): v is VueListe {
  return VUES_LISTE.some((x) => x.id === v);
}

/** Le filtre d'affichage que le SERVEUR sait appliquer pour cette vue (`statutScore`), ou undefined si la vue est locale. */
export function statutScoreServeur(vue: VueListe): StatutScore | undefined {
  return vue === "score-incomplet" ? "INCOMPLET" : vue === "non-classees" ? "EXCLU" : undefined;
}

export function filtrerParVue(items: readonly Intervention[], vue: VueListe): Intervention[] {
  switch (vue) {
    case "score-incomplet": return items.filter((i) => i.scoreIncomplet);
    case "non-classees": return items.filter((i) => i.statutScore === "EXCLU" || i.exclusion !== null);
    case "sans-localisation": return items.filter((i) => i.localisation !== "valide");
    case "cout-non-estimable": return items.filter((i) => i.coutNonEstimable !== null);
    case "critiques": return items.filter((i) => i.etatPhysique === "CRITIQUE");
    default: return [...items];
  }
}

export type PorteeConstat = "perimetre" | "chargees";
export interface Constat { code: string; nombre: number; libelle: string; detail: string | null; vue: VueListe; portee: PorteeConstat }
export interface Couverture { chargees: number; total: number | null; complet: boolean; phrase: string }
export interface ConstatsCalcules { couverture: Couverture; constats: Constat[] }

const pl = (n: number) => (n > 1 ? "s" : "");

/**
 * « Calcule sur les 48 interventions du perimetre » ou, quand il en reste, ce qui vient du serveur sur TOUT le perimetre et ce qui ne porte que
 * sur les lignes chargees : un compte partiel se dit.
 */
export function phraseCouverture(chargees: number, total: number | null, complet: boolean, resumeServeur = false): string {
  if (complet) return `Calculé sur les ${chargees.toLocaleString("fr-FR")} intervention${pl(chargees)} du périmètre filtré.`;
  const sur = total === null ? "total inconnu" : `${total.toLocaleString("fr-FR")} au total`;
  const debut = resumeServeur ? "Scores incomplets et non classées : comptes du serveur sur tout le périmètre. Autres constats : calculés sur" : "Calculé sur";
  return `${debut} les ${chargees.toLocaleString("fr-FR")} intervention${pl(chargees)} chargée${pl(chargees)} (${sur}) : ils peuvent changer en chargeant la suite.`;
}

/**
 * Constats CALCULES, jamais ecrits d'avance : des comptes et des regles explicables. Score incomplet et non classees viennent du decompte exact du
 * serveur (`resume`) quand il est la ; le reste est compte sur les lignes chargees. Aucune recommandation : un compte dit ce qu'il compte et sur quoi.
 */
export function calculerConstats(items: readonly Intervention[], total: number | null, suivantExiste: boolean, resume: ResumeClassement | null = null): ConstatsCalcules {
  const complet = !suivantExiste;
  const couverture: Couverture = { chargees: items.length, total, complet, phrase: phraseCouverture(items.length, total, complet, resume !== null) };
  const incompletes = filtrerParVue(items, "score-incomplet");
  const manquants = new Map<string, number>();
  for (const i of incompletes) for (const c of new Set(i.criteresManquants.map((m) => m.libelle))) manquants.set(c, (manquants.get(c) ?? 0) + 1);
  const frequent = [...manquants.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  const exact = resume !== null && !complet;
  const nIncomplet = exact ? resume.incomplets : incompletes.length;
  const nExclus = exact ? resume.exclus : filtrerParVue(items, "non-classees").length;
  const motifs = Object.entries((exact ? resume.parMotifExclusion : null) ?? {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([code, n]) => `${libelleExclusion(code)} (${n.toLocaleString("fr-FR")})`);
  const sans = filtrerParVue(items, "sans-localisation").length;
  const critiques = filtrerParVue(items, "critiques").length;
  const sansCout = filtrerParVue(items, "cout-non-estimable").length;
  const ligne = (code: string, n: number, un: string, zero: string, vue: VueListe, portee: PorteeConstat, detail: string | null = null): Constat => ({
    code, nombre: n, libelle: n === 0 ? zero : `${n.toLocaleString("fr-FR")} ${un}`, detail: n === 0 ? null : detail, vue, portee,
  });
  return {
    couverture,
    constats: [
      ligne("score_incomplet", nIncomplet, `intervention${pl(nIncomplet)} au score incomplet`, "Aucune intervention au score incomplet", "score-incomplet", exact ? "perimetre" : "chargees",
        frequent ? `Critère le plus souvent manquant parmi les chargées : ${frequent[0]} (${frequent[1].toLocaleString("fr-FR")} intervention${pl(frequent[1])}).` : null),
      ligne("non_classees", nExclus, `intervention${pl(nExclus)} non classée${pl(nExclus)}`, "Aucune intervention non classée", "non-classees", exact ? "perimetre" : "chargees",
        motifs.length ? `Motifs : ${motifs.join(", ")}.` : "Exclues du classement : ni rang ni score."),
      ligne("sans_localisation", sans, `intervention${pl(sans)} sans localisation valide`, "Aucune intervention sans localisation valide", "sans-localisation", "chargees",
        "Elles restent dans la liste, sans « voir sur la carte »."),
      ligne("critiques", critiques, `intervention${pl(critiques)} sur un tronçon à l'état critique`, "Aucune intervention à l'état critique", "critiques", "chargees"),
      ligne("cout_non_estimable", sansCout, `intervention${pl(sansCout)} au coût non estimable`, "Aucune intervention au coût non estimable", "cout-non-estimable", "chargees",
        "Leur coût n'est pas compté comme zéro."),
    ],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Resume des filtres, tri de la liste, emprise de lignes
// ---------------------------------------------------------------------------------------------------------------

/** Resume lisible des filtres partages actifs (« region Kindia, classe RN, etat Critique, periode du ... au ... »), ou null s'il n'y en a aucun. */
export function resumeFiltres(f: FiltresDecision, nomRegion: string | null): string | null {
  const parts: string[] = [];
  if (nombre(f.regionId)) parts.push(`région ${nomRegion ?? `n° ${f.regionId}`}`);
  if (f.classe?.length) parts.push(`classe ${f.classe.map((c) => CLASSES_ROUTE.find((x) => x.code === c)?.libelle ?? c).join(", ")}`);
  if (f.etat?.length) parts.push(`état ${f.etat.map((e) => ETATS_PHYSIQUES.find((x) => x.code === e)?.libelle ?? e).join(", ")}`);
  if (f.statutChantier?.length) parts.push(`chantiers ${f.statutChantier.map((c) => STATUTS_CHANTIER.find((x) => x.code === c)?.libelle ?? c).join(", ").toLowerCase()}`);
  const d = formaterDate(f.depuis);
  const j = formaterDate(f.jusqua);
  if (d && j) parts.push(`période du ${d} au ${j}`);
  else if (d) parts.push(`période à partir du ${d}`);
  else if (j) parts.push(`période jusqu'au ${j}`);
  return parts.length ? parts.join(" ; ") : null;
}

/** Tris de la liste, appliques aux lignes DEJA CHARGEES (le serveur pagine par curseur, dans l'ordre du rang) : la liste le dit. */
export type TriListe = "rang" | "score" | "constat" | "region";
export const TRIS_LISTE: { id: TriListe; libelle: string }[] = [
  { id: "rang", libelle: "Rang (ordre du serveur)" },
  { id: "score", libelle: "Score décroissant" },
  { id: "constat", libelle: "Dernier constat le plus ancien" },
  { id: "region", libelle: "Région" },
];

/** Tri stable ; les valeurs absentes passent EN DERNIER (une absence n'est ni la plus haute ni la plus basse). */
export function trierInterventions(items: readonly Intervention[], tri: TriListe): Intervention[] {
  const index = new Map(items.map((i, k) => [i.id, k]));
  const base = (a: Intervention, b: Intervention) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0);
  const absentsFin = <T,>(va: T | null, vb: T | null, cmp: (x: T, y: T) => number): number | null => {
    if (va === null && vb === null) return null;
    if (va === null) return 1;
    if (vb === null) return -1;
    return cmp(va, vb);
  };
  const copie = [...items];
  if (tri === "rang") return copie;
  copie.sort((a, b) => {
    let r: number | null = null;
    if (tri === "score") r = absentsFin(a.score, b.score, (x, y) => y - x);
    else if (tri === "constat") r = absentsFin(formaterDate(a.dateDernierConstat) ? a.dateDernierConstat : null, formaterDate(b.dateDernierConstat) ? b.dateDernierConstat : null, (x, y) => (x < y ? -1 : x > y ? 1 : 0));
    else r = absentsFin(a.troncon?.regionNom ?? null, b.troncon?.regionNom ?? null, (x, y) => x.localeCompare(y, "fr"));
    return r !== null && r !== 0 ? r : base(a, b);
  });
  return copie;
}

/** Emprise d'un ensemble de lignes [lat, lon][][] (trace d'une intervention sur un troncon), ou null si elles n'ont aucun point lisible. */
export function bboxDeLignes(lignes: readonly (readonly [number, number][])[]): Bbox | null {
  return bboxDeGeometrie({ type: "MultiLineString", coordinates: lignes.map((l) => l.map(([lat, lon]) => [lon, lat])) });
}

/** Couche demandee mais sans source reutilisable : case desactivee et dite, jamais une couche vide qui laisserait croire a l'absence de donnees. */
export const COUCHES_INDISPONIBLES: { cle: string; libelle: string; raison: string }[] = [
  { cle: "limitesRegions", libelle: "Limites des régions et préfectures", raison: "non disponible dans cette vue : seul le contour du pays (simplifié) existe comme source" },
];
