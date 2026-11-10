/**
 * Territoires hierarchiques, referentiels configurables et configuration nationale (lot T1, interface UI-C) : constantes d'affichage et fonctions
 * pures. SOURCE DES FORMES : docs/projets-voirie/CONTRAT-TERRITOIRES.md (sections 3 a 8) et le code reel du backend
 * (backend/src/api-v2/projets-voirie.territoires.routes.ts, projets-voirie/territoires/*).
 *
 * AUCUN NOM DE LIEU, AUCUN CRS, AUCUN TYPE DE RESEAU NI AUCUNE VALEUR DE REFERENTIEL ICI : ils vivent dans les donnees (base, migration, graine).
 * Ne sont connus que les constantes du contrat : niveaux de territoire, domaines de referentiel, familles techniques de reseau (enumeration
 * `TypeReseauTiers`, cle des regles de conflit), codes de fonctions debloquees par un document, cles de configuration.
 *
 * Aucune E/S, aucun stockage, aucun DOM.
 */

import { classerErreur, versNombre, lireSaisieNombre, type Bbox, type ErreurPv, type GenreErreur } from "./projetsVoirie";
import { classerErreurConflit } from "./projetsVoirieConflits";

// ---------------------------------------------------------------------------------------------------
// Niveaux de territoire
// ---------------------------------------------------------------------------------------------------

export type NiveauTerritoire = "NATION" | "REGION" | "PREFECTURE" | "COMMUNE" | "QUARTIER" | "SECTEUR" | "ZONE";
/** Ordre du contrat : rang 0 (nation) a 6 (zone). Un parent est toujours de rang STRICTEMENT inferieur ; un niveau peut etre saute. */
export const NIVEAUX_TERRITOIRE: readonly NiveauTerritoire[] = ["NATION", "REGION", "PREFECTURE", "COMMUNE", "QUARTIER", "SECTEUR", "ZONE"];
export const LIBELLE_NIVEAU: Readonly<Record<NiveauTerritoire, string>> = {
  NATION: "Nation", REGION: "Région", PREFECTURE: "Préfecture", COMMUNE: "Commune", QUARTIER: "Quartier", SECTEUR: "Secteur", ZONE: "Zone ou corridor",
};
export const rangNiveau = (n: NiveauTerritoire): number => NIVEAUX_TERRITOIRE.indexOf(n);
export const estNiveau = (v: unknown): v is NiveauTerritoire => typeof v === "string" && (NIVEAUX_TERRITOIRE as readonly string[]).includes(v);

/** Niveaux qu'un enfant de `parent` peut avoir (rang strictement superieur) ; sans parent : la nation seule. */
export function niveauxEnfantsPossibles(parent: NiveauTerritoire | null): NiveauTerritoire[] {
  if (parent === null) return ["NATION"];
  return NIVEAUX_TERRITOIRE.filter((n) => rangNiveau(n) > rangNiveau(parent));
}

/** Motif des codes (territoires, referentiels, projets) : majuscules, chiffres, tiret et souligne, 2 a 64 caracteres. */
export const MOTIF_CODE = /^[A-Z0-9][A-Z0-9_-]{1,63}$/;

// ---------------------------------------------------------------------------------------------------
// Vues
// ---------------------------------------------------------------------------------------------------

export interface PersonneRef { id: string; nomComplet: string }

export interface TerritoireResume { id: string; code: string; nom: string; niveau: NiveauTerritoire }

/** Vue d'un territoire (liste) : la liste ne porte QUE la boite englobante, jamais l'emprise complete (lue sur la fiche). */
export interface Territoire extends TerritoireResume {
  parentId: string | null;
  chemin: string;
  profondeur: number;
  regionId: number | null;
  regionEffectiveId: number | null;
  crsMetriqueEpsg: number | null;
  bbox: Bbox | null;
  source: string | null;
  actif: boolean;
  version: number;
  creePar: PersonneRef | null;
  updatedAt: string | null;
}

export type EmpriseGeoJson = { type: "Polygon"; coordinates: number[][][] } | { type: "MultiPolygon"; coordinates: number[][][][] };

export interface FicheTerritoire extends Territoire {
  emprise: EmpriseGeoJson | null;
  ancetres: TerritoireResume[];
  nbEnfants: number | null;
}

export interface PageTerritoires { territoires: Territoire[]; suivant: string | null }

/** Identifiants des ancetres d'un territoire, nation en premier, lus dans son chemin materialise (`/id_nation/.../id/`). */
export function idsAncetres(chemin: string): string[] {
  return chemin.split("/").filter(Boolean).slice(0, -1);
}

/**
 * Chemin lisible d'un territoire : les noms de ses ancetres connus, nation en premier. Un ancetre absent de la liste chargee (hors du perimetre du
 * compte, ou non charge) est omis et `complet` le dit : rien n'est invente.
 */
export function cheminDesAncetres(t: Pick<Territoire, "chemin">, parId: ReadonlyMap<string, Pick<Territoire, "nom">>): { noms: string[]; complet: boolean } {
  const ids = idsAncetres(t.chemin);
  const noms: string[] = [];
  let complet = true;
  for (const id of ids) {
    const a = parId.get(id);
    if (a) noms.push(a.nom); else complet = false;
  }
  return { noms, complet };
}

const sansAccents = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Filtre local d'une liste de territoires : texte (nom ou code, sans accents ni casse), niveau, actifs seulement. L'ordre (celui de l'arbre) est conserve. */
export function filtrerTerritoires<T extends Pick<Territoire, "nom" | "code" | "niveau" | "actif">>(liste: readonly T[], f: { q?: string; niveau?: NiveauTerritoire | ""; actifsSeulement?: boolean }): T[] {
  const q = sansAccents((f.q ?? "").trim());
  return liste.filter((t) => (!f.niveau || t.niveau === f.niveau) && (!f.actifsSeulement || t.actif) && (!q || sansAccents(t.nom).includes(q) || sansAccents(t.code).includes(q)));
}

// ---------------------------------------------------------------------------------------------------
// Emprise : saisie GeoJSON et rectangle
// ---------------------------------------------------------------------------------------------------

/** Plafond du contrat (10 000 sommets) : une emprise est approximative par nature. */
export const SOMMETS_EMPRISE_MAX = 10_000;

export type LectureEmprise = { ok: true; emprise: EmpriseGeoJson; bbox: Bbox; sommets: number } | { ok: false; message: string };

function lireAnneau(brut: unknown, compte: { n: number }): number[][] | string {
  if (!Array.isArray(brut) || brut.length < 4) return "un anneau porte au moins quatre positions, dont la fermeture";
  const anneau: number[][] = [];
  for (const p of brut) {
    if (!Array.isArray(p) || p.length < 2 || typeof p[0] !== "number" || typeof p[1] !== "number" || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return "une position est illisible (deux nombres attendus : longitude puis latitude)";
    if (Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) return "une position sort des bornes WGS 84 (longitude de -180 à 180, latitude de -90 à 90 ; longitude en premier)";
    anneau.push([p[0], p[1]]);
    compte.n += 1;
    if (compte.n > SOMMETS_EMPRISE_MAX) return `plus de ${SOMMETS_EMPRISE_MAX} sommets : simplifiez l'emprise`;
  }
  const a = anneau[0], z = anneau[anneau.length - 1];
  if (a[0] !== z[0] || a[1] !== z[1]) return "un anneau n'est pas fermé (la dernière position doit répéter la première)";
  return anneau;
}

/**
 * Lit une emprise saisie en texte GeoJSON : un objet `Polygon` ou `MultiPolygon` (ou un `Feature` qui en porte un), en WGS 84. Controle de forme
 * seulement, avant envoi : la validite topologique est verifiee par le serveur (PostGIS, 422 EMPRISE_INVALIDE). Une saisie vide = pas d'emprise.
 */
export function lireSaisieEmprise(texte: string): LectureEmprise | null {
  if (texte.trim() === "") return null;
  let brut: unknown;
  try { brut = JSON.parse(texte); } catch { return { ok: false, message: "Le texte n'est pas du JSON lisible. Collez un objet GeoJSON Polygon ou MultiPolygon." }; }
  return lireObjetEmprise(brut);
}

export function lireObjetEmprise(brut: unknown): LectureEmprise {
  const refus = (m: string): LectureEmprise => ({ ok: false, message: `Emprise invalide : ${m}.` });
  let g = brut as { type?: unknown; coordinates?: unknown; geometry?: unknown } | null;
  if (g && typeof g === "object" && g.type === "Feature") g = g.geometry as typeof g;
  if (!g || typeof g !== "object" || Array.isArray(g)) return refus("un objet GeoJSON Polygon ou MultiPolygon est attendu");
  const compte = { n: 0 };
  let polygones: number[][][][];
  if (g.type === "Polygon") {
    if (!Array.isArray(g.coordinates) || g.coordinates.length === 0) return refus("un polygone porte au moins un anneau");
    const anneaux: number[][][] = [];
    for (const a of g.coordinates) { const r = lireAnneau(a, compte); if (typeof r === "string") return refus(r); anneaux.push(r); }
    polygones = [anneaux];
  } else if (g.type === "MultiPolygon") {
    if (!Array.isArray(g.coordinates) || g.coordinates.length === 0 || g.coordinates.length > 500) return refus("un multipolygone porte de un à cinq cents polygones");
    polygones = [];
    for (const poly of g.coordinates) {
      if (!Array.isArray(poly) || poly.length === 0) return refus("un polygone porte au moins un anneau");
      const anneaux: number[][][] = [];
      for (const a of poly) { const r = lireAnneau(a, compte); if (typeof r === "string") return refus(r); anneaux.push(r); }
      polygones.push(anneaux);
    }
  } else {
    return refus("le type doit être Polygon ou MultiPolygon (une ligne ou un point ne délimitent pas un territoire)");
  }
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const poly of polygones) for (const [x, y] of poly[0]) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
  if (!(w < e && s < n)) return refus("l'emprise est dégénérée (largeur ou hauteur nulle)");
  const emprise: EmpriseGeoJson = g.type === "Polygon" ? { type: "Polygon", coordinates: polygones[0] } : { type: "MultiPolygon", coordinates: polygones };
  return { ok: true, emprise, bbox: [w, s, e, n], sommets: compte.n };
}

/** Rectangle WGS 84 (ouest, sud, est, nord) en polygone GeoJSON ferme, sens trigonometrique. `null` si les bornes sont incoherentes. */
export function rectangleVersEmprise(b: Bbox): EmpriseGeoJson | null {
  const [o, s, e, n] = b;
  if (![o, s, e, n].every(Number.isFinite) || o < -180 || e > 180 || s < -90 || n > 90 || !(o < e) || !(s < n)) return null;
  return { type: "Polygon", coordinates: [[[o, s], [e, s], [e, n], [o, n], [o, s]]] };
}

/** Rectangle depuis deux coins quelconques (dessin sur la carte : deux clics). */
export function rectangleDepuisCoins(a: { lat: number; lng: number }, b: { lat: number; lng: number }): Bbox {
  return [Math.min(a.lng, b.lng), Math.min(a.lat, b.lat), Math.max(a.lng, b.lng), Math.max(a.lat, b.lat)];
}

export function formaterBbox(b: Bbox | null): string {
  if (!b) return "aucune";
  const f = (x: number) => x.toFixed(4).replace(".", ",");
  return `ouest ${f(b[0])}, sud ${f(b[1])}, est ${f(b[2])}, nord ${f(b[3])}`;
}

/** Saisie des quatre bornes d'un rectangle (texte, virgule ou point). */
export function lireBornes(saisie: { ouest: string; sud: string; est: string; nord: string }): { bbox: Bbox | null; message: string | null } {
  const v = [saisie.ouest, saisie.sud, saisie.est, saisie.nord].map(lireSaisieNombre);
  if (v.some((x) => x === null)) return { bbox: null, message: "Saisissez les quatre bornes en degrés décimaux (WGS 84)." };
  const b = v as number[] as Bbox;
  if (!rectangleVersEmprise(b)) return { bbox: null, message: "Bornes incohérentes : l'ouest doit être inférieur à l'est et le sud au nord, dans les bornes WGS 84." };
  return { bbox: b, message: null };
}

// ---------------------------------------------------------------------------------------------------
// Referentiels
// ---------------------------------------------------------------------------------------------------

export type DomaineReferentiel = "TYPE_RESEAU" | "CATEGORIE_PROJET" | "TYPE_DOCUMENT" | "METHODE_ACQUISITION" | "STATUT_QUALITE";
export const DOMAINES_REFERENTIEL: readonly DomaineReferentiel[] = ["TYPE_RESEAU", "CATEGORIE_PROJET", "TYPE_DOCUMENT", "METHODE_ACQUISITION", "STATUT_QUALITE"];
export const LIBELLE_DOMAINE: Readonly<Record<DomaineReferentiel, string>> = {
  TYPE_RESEAU: "Types de réseau", CATEGORIE_PROJET: "Catégories de projet", TYPE_DOCUMENT: "Types de document attendu",
  METHODE_ACQUISITION: "Méthodes d'acquisition", STATUT_QUALITE: "Statuts de qualité",
};
export const AIDE_DOMAINE: Readonly<Record<DomaineReferentiel, string>> = {
  TYPE_RESEAU: "Chaque type configurable se rattache à une famille technique, qui porte les règles de conflit et la symbologie.",
  CATEGORIE_PROJET: "Une catégorie donne les largeurs d'emprise et de chaussée proposées à la création d'un projet (théoriques tant qu'elles ne sont pas validées).",
  TYPE_DOCUMENT: "Pièces attendues d'un dossier de projet et fonctions qu'elles débloquent.",
  METHODE_ACQUISITION: "Méthode par laquelle un jeu de données a été obtenu : deux méthodes différentes font deux sources d'un même réseau.",
  STATUT_QUALITE: "États de qualité d'une donnée.",
};
export const estDomaine = (v: unknown): v is DomaineReferentiel => typeof v === "string" && (DOMAINES_REFERENTIEL as readonly string[]).includes(v);

/** Familles techniques de reseau : l'enumeration du contrat (`TypeReseauTiers`), PAS une liste de choix metier. Les types de reseau, eux, sont des donnees. */
export const FAMILLES_TECHNIQUES = ["TELECOM", "EAU_POTABLE", "ELECTRICITE", "ASSAINISSEMENT", "GAZ_HYDROCARBURES", "AUTRE"] as const;
export type FamilleTechnique = (typeof FAMILLES_TECHNIQUES)[number];

/** Fonctions qu'un type de document peut debloquer : constantes du contrat (CONTRAT-TERRITOIRES.md section 5, lot D1). */
export const FONCTIONS_DEBLOQUABLES = ["ANALYSE_2D", "CONFLITS", "COMPARAISON_SOURCES", "RECOLEMENT", "EXPORT_DOSSIER"] as const;
export const LIBELLE_FONCTION: Readonly<Record<string, string>> = {
  ANALYSE_2D: "Analyse 2D", CONFLITS: "Dossiers de conflit", COMPARAISON_SOURCES: "Comparaison entre sources", RECOLEMENT: "Récolement", EXPORT_DOSSIER: "Export du dossier",
};

export interface ValeurReferentiel {
  id: string;
  domaine: DomaineReferentiel;
  code: string;
  libelle: string;
  ordre: number;
  actif: boolean;
  parametres: Record<string, unknown>;
  version: number;
  systeme: boolean;
  approuvePar: PersonneRef | null;
  approuveLe: string | null;
}

/** Libelle d'un code de referentiel porte par un objet : la valeur connue (meme desactivee), sinon le code tel quel, jamais vide. */
export function libelleDeCode(code: string | null | undefined, valeurs: readonly Pick<ValeurReferentiel, "code" | "libelle" | "actif">[] | undefined, absent = "Non renseigné"): string {
  if (!code) return absent;
  const v = valeurs?.find((x) => x.code === code);
  if (!v) return code;
  return v.actif ? v.libelle : `${v.libelle} (valeur désactivée)`;
}

/**
 * Options d'une liste de choix : les valeurs ACTIVES, plus la valeur courante si elle est desactivee (elle reste lisible sur l'objet qui la porte,
 * marquee comme telle, mais n'est pas proposee pour une nouvelle saisie).
 */
export function optionsDeChoix(valeurs: readonly ValeurReferentiel[] | undefined, courant?: string | null): { code: string; libelle: string; desactivee: boolean }[] {
  const actives = (valeurs ?? []).filter((v) => v.actif).map((v) => ({ code: v.code, libelle: v.libelle, desactivee: false }));
  if (courant && !actives.some((o) => o.code === courant)) {
    const v = valeurs?.find((x) => x.code === courant);
    actives.push({ code: courant, libelle: v ? `${v.libelle} (valeur désactivée)` : `${courant} (valeur inconnue du référentiel)`, desactivee: true });
  }
  return actives;
}

/** Famille technique d'un type de reseau configurable (`parametres.famille`), ou `null`. */
export function familleDuType(v: Pick<ValeurReferentiel, "parametres"> | undefined): FamilleTechnique | null {
  const f = v?.parametres.famille;
  return typeof f === "string" && (FAMILLES_TECHNIQUES as readonly string[]).includes(f) ? (f as FamilleTechnique) : null;
}

/** Largeurs par defaut d'une categorie de projet, ou `null` si ses parametres sont illisibles. */
export function largeursDeCategorie(v: Pick<ValeurReferentiel, "parametres"> | undefined): { largeurEmpriseM: number; largeurChausseeM: number } | null {
  const e = versNombre(v?.parametres.largeurEmpriseM);
  const c = versNombre(v?.parametres.largeurChausseeM);
  return e !== null && c !== null ? { largeurEmpriseM: e, largeurChausseeM: c } : null;
}

/** Saisie des parametres d'une valeur, en texte (formulaire). Cles utilisees selon le domaine. */
export interface SaisieParametres {
  famille: string; couleur: string;
  largeurEmpriseM: string; largeurChausseeM: string;
  obligatoire: boolean; fonctionsDebloquees: string[];
  precisionTypiqueM: string;
  description: string;
  /** Domaine inconnu de cette interface : parametres saisis en JSON. */
  json: string;
}

export const SAISIE_PARAMETRES_VIDE: SaisieParametres = {
  famille: "", couleur: "", largeurEmpriseM: "", largeurChausseeM: "", obligatoire: false, fonctionsDebloquees: [], precisionTypiqueM: "", description: "", json: "{}",
};

const texteNombre = (v: unknown): string => { const n = versNombre(v); return n === null ? "" : String(n).replace(".", ","); };

export function saisieDepuisParametres(domaine: string, p: Record<string, unknown>): SaisieParametres {
  const s = { ...SAISIE_PARAMETRES_VIDE };
  if (domaine === "TYPE_RESEAU") { s.famille = typeof p.famille === "string" ? p.famille : ""; s.couleur = typeof p.couleur === "string" ? p.couleur : ""; }
  else if (domaine === "CATEGORIE_PROJET") { s.largeurEmpriseM = texteNombre(p.largeurEmpriseM); s.largeurChausseeM = texteNombre(p.largeurChausseeM); }
  else if (domaine === "TYPE_DOCUMENT") { s.obligatoire = p.obligatoire === true; s.fonctionsDebloquees = Array.isArray(p.fonctionsDebloquees) ? p.fonctionsDebloquees.filter((x): x is string => typeof x === "string") : []; }
  else if (domaine === "METHODE_ACQUISITION") s.precisionTypiqueM = texteNombre(p.precisionTypiqueM);
  else if (domaine === "STATUT_QUALITE") s.description = typeof p.description === "string" ? p.description : "";
  else s.json = JSON.stringify(p, null, 2);
  return s;
}

/**
 * Construit les parametres a envoyer selon le schema du domaine (CONTRAT-TERRITOIRES.md section 5). Controle de forme avant envoi ; le serveur
 * reste la reference (400 PARAMETRES_INVALIDES avec le detail). Aucune valeur n'est inventee : un champ facultatif vide n'est pas envoye.
 */
export function construireParametres(domaine: string, s: SaisieParametres): { parametres: Record<string, unknown> | null; erreurs: string[] } {
  const erreurs: string[] = [];
  const p: Record<string, unknown> = {};
  if (domaine === "TYPE_RESEAU") {
    if (!(FAMILLES_TECHNIQUES as readonly string[]).includes(s.famille)) erreurs.push("Choisissez la famille technique du type de réseau.");
    else p.famille = s.famille;
    if (s.couleur.trim()) { if (/^#[0-9a-fA-F]{6}$/.test(s.couleur.trim())) p.couleur = s.couleur.trim(); else erreurs.push("La couleur s'écrit #rrggbb (six chiffres hexadécimaux)."); }
  } else if (domaine === "CATEGORIE_PROJET") {
    const e = lireSaisieNombre(s.largeurEmpriseM);
    const c = lireSaisieNombre(s.largeurChausseeM);
    if (e === null || c === null) erreurs.push("Saisissez les deux largeurs en mètres.");
    else if (e <= 0 || c <= 0 || e > 200 || c > 200) erreurs.push("Une largeur est strictement positive et au plus égale à 200 m.");
    else if (c > e) erreurs.push("La chaussée ne peut pas être plus large que l'emprise.");
    else { p.largeurEmpriseM = e; p.largeurChausseeM = c; }
  } else if (domaine === "TYPE_DOCUMENT") {
    p.obligatoire = s.obligatoire;
    p.fonctionsDebloquees = s.fonctionsDebloquees.filter((f) => /^[A-Z0-9_]{2,64}$/.test(f)).slice(0, 20);
  } else if (domaine === "METHODE_ACQUISITION") {
    if (s.precisionTypiqueM.trim()) {
      const n = lireSaisieNombre(s.precisionTypiqueM);
      if (n === null || n <= 0 || n > 100_000) erreurs.push("La précision typique est un nombre de mètres strictement positif, au plus 100 000 (laissez vide si elle n'est pas connue).");
      else p.precisionTypiqueM = n;
    }
  } else if (domaine === "STATUT_QUALITE") {
    if (s.description.trim()) { if (s.description.trim().length > 500) erreurs.push("La description compte 500 caractères au plus."); else p.description = s.description.trim(); }
  } else {
    try {
      const v: unknown = JSON.parse(s.json || "{}");
      if (!v || typeof v !== "object" || Array.isArray(v)) erreurs.push("Les paramètres sont un objet JSON."); else Object.assign(p, v);
    } catch { erreurs.push("Les paramètres ne sont pas du JSON lisible."); }
  }
  return { parametres: erreurs.length ? null : p, erreurs };
}

/** Resume lisible des parametres d'une valeur (liste d'administration). */
export function resumeParametres(domaine: string, p: Record<string, unknown>, libelleFamille: (f: string) => string): string {
  if (domaine === "TYPE_RESEAU") return `Famille : ${typeof p.famille === "string" ? libelleFamille(p.famille) : "non renseignée"}${typeof p.couleur === "string" ? `, couleur ${p.couleur}` : ""}`;
  if (domaine === "CATEGORIE_PROJET") { const l = largeursDeCategorie({ parametres: p }); return l ? `Emprise ${texteNombre(l.largeurEmpriseM)} m, chaussée ${texteNombre(l.largeurChausseeM)} m` : "Largeurs illisibles"; }
  if (domaine === "TYPE_DOCUMENT") {
    const f = Array.isArray(p.fonctionsDebloquees) ? p.fonctionsDebloquees.filter((x): x is string => typeof x === "string") : [];
    return `${p.obligatoire === true ? "Obligatoire" : "Facultatif"}${f.length ? ` ; débloque : ${f.map((x) => LIBELLE_FONCTION[x] ?? x).join(", ")}` : ""}`;
  }
  if (domaine === "METHODE_ACQUISITION") { const n = versNombre(p.precisionTypiqueM); return n === null ? "Précision typique non renseignée" : `Précision typique ${texteNombre(n)} m`; }
  if (domaine === "STATUT_QUALITE") return typeof p.description === "string" && p.description ? p.description : "Sans description";
  return JSON.stringify(p);
}

// ---------------------------------------------------------------------------------------------------
// Configuration nationale
// ---------------------------------------------------------------------------------------------------

export type SourceConfiguration = "ENV" | "BASE" | "DEFAUT";
export const LIBELLE_SOURCE: Readonly<Record<SourceConfiguration, string>> = {
  ENV: "Variable d'environnement du serveur",
  BASE: "Valeur enregistrée par un administrateur",
  DEFAUT: "Valeur par défaut du code",
};
export const AIDE_SOURCE: Readonly<Record<SourceConfiguration, string>> = {
  ENV: "Une variable d'environnement définie l'emporte toujours : une valeur écrite ici est enregistrée mais n'a aucun effet tant que la variable reste définie sur le serveur.",
  BASE: "Valeur écrite depuis cette interface ; elle s'applique au plus tard après la fenêtre de rafraîchissement du serveur (30 secondes par défaut).",
  DEFAUT: "Aucune valeur n'a été enregistrée : le comportement historique s'applique.",
};

export interface EntreeConfiguration {
  cle: string;
  valeur: unknown;
  /** Source unique, ou une source par sous-cle (`PROTECTIONS`). */
  source: SourceConfiguration | Record<string, SourceConfiguration>;
  valeurBase: unknown;
  valeurDefaut: unknown;
  variableEnvironnement: string | string[] | null;
  version: number;
  approuvePar: PersonneRef | null;
  approuveLe: string | null;
  justification: string | null;
  updatedAt: string | null;
}

export const LIBELLE_CLE: Readonly<Record<string, string>> = {
  EMPRISE_PLAUSIBILITE: "Emprise nationale de plausibilité",
  CRS_METRIQUE_BANDES: "Système métrique de calcul (bandes de longitude)",
  CRS_IMPORT_LISTE_BLANCHE: "Systèmes de coordonnées admis à l'import",
  PROTECTIONS: "Protections du serveur (délais, plafonds, cadences)",
};
export const AIDE_CLE: Readonly<Record<string, string>> = {
  EMPRISE_PLAUSIBILITE: "Rectangle au-delà duquel un élément déposé est écarté. L'emprise d'un territoire, approximative, ne fait que signaler.",
  CRS_METRIQUE_BANDES: "Système projeté utilisé pour les calculs en mètres, choisi selon la longitude du projet ; un territoire peut imposer le sien.",
  CRS_IMPORT_LISTE_BLANCHE: "Codes EPSG qu'un fichier peut déclarer ; 4326 (WGS 84) est obligatoire. Chaque code doit être connu de la base.",
  PROTECTIONS: "Bornes de protection du serveur ; chaque valeur doit rester dans les bornes du serveur, qui la refuse sinon.",
};
export const LIBELLE_PROTECTION: Readonly<Record<string, string>> = {
  analyseIntervalleS: "Intervalle minimal entre deux analyses (s)", conflitsMax: "Dossiers de conflit au plus par analyse", sommetsParObjet: "Sommets au plus par objet",
  sommetsParFichier: "Sommets au plus par fichier", delaiAnalyseMs: "Délai d'une analyse (ms)", delaiCarteMs: "Délai de la carte (ms)", delaiDepotMs: "Délai d'un dépôt (ms)",
};

export const estSource = (v: unknown): v is SourceConfiguration => v === "ENV" || v === "BASE" || v === "DEFAUT";

/** Une variable d'environnement l'emporte-t-elle (au moins pour une sous-cle) ? */
export function enveloppeEnv(e: Pick<EntreeConfiguration, "source">): boolean {
  return typeof e.source === "string" ? e.source === "ENV" : Object.values(e.source).includes("ENV");
}

/** Saisie d'une cle de configuration, en texte. */
export interface SaisieConfiguration {
  nom: string; ouest: string; sud: string; est: string; nord: string;
  /** Bandes : une par ligne, « longitude ; epsg ». */
  bandes: string; epsgDefaut: string;
  epsg: string;
  protections: Record<string, string>;
  json: string;
}

const texteDe = (v: unknown): string => (typeof v === "number" && Number.isFinite(v) ? String(v).replace(".", ",") : typeof v === "string" ? v : "");

export function saisieDepuisValeur(cle: string, valeur: unknown): SaisieConfiguration {
  const o = valeur && typeof valeur === "object" && !Array.isArray(valeur) ? (valeur as Record<string, unknown>) : {};
  const s: SaisieConfiguration = { nom: "", ouest: "", sud: "", est: "", nord: "", bandes: "", epsgDefaut: "", epsg: "", protections: {}, json: JSON.stringify(valeur ?? {}, null, 2) };
  if (cle === "EMPRISE_PLAUSIBILITE") {
    s.nom = typeof o.nom === "string" ? o.nom : "";
    const b = Array.isArray(o.bbox) ? o.bbox : [];
    [s.ouest, s.sud, s.est, s.nord] = [0, 1, 2, 3].map((i) => texteDe(b[i]));
  } else if (cle === "CRS_METRIQUE_BANDES") {
    const bandes = Array.isArray(o.bandes) ? o.bandes : [];
    s.bandes = bandes.flatMap((b) => (b && typeof b === "object" ? [`${texteDe((b as Record<string, unknown>).jusquaLongitude)} ; ${texteDe((b as Record<string, unknown>).epsg)}`] : [])).join("\n");
    s.epsgDefaut = texteDe(o.epsgDefaut);
  } else if (cle === "CRS_IMPORT_LISTE_BLANCHE") {
    s.epsg = Array.isArray(o.epsg) ? o.epsg.filter((x) => typeof x === "number").join(", ") : "";
  } else if (cle === "PROTECTIONS") {
    for (const k of Object.keys(LIBELLE_PROTECTION)) s.protections[k] = texteDe(o[k]);
  }
  return s;
}

const entierEpsg = (t: string): number | null => (/^\d{4,6}$/.test(t.trim()) ? Number(t.trim()) : null);

/** Valeur a envoyer pour une cle, depuis la saisie ; controle de forme (le serveur valide le schema et les CRS : 400 VALEUR_INVALIDE, CRS_NON_AUTORISE, 422 CRS_NON_DISPONIBLE). */
export function valeurDepuisSaisie(cle: string, s: SaisieConfiguration): { valeur: Record<string, unknown> | null; erreurs: string[] } {
  const erreurs: string[] = [];
  let valeur: Record<string, unknown> | null = null;
  if (cle === "EMPRISE_PLAUSIBILITE") {
    if (!s.nom.trim() || s.nom.trim().length > 100) erreurs.push("Nommez l'emprise (100 caractères au plus).");
    const b = lireBornes(s);
    if (b.message) erreurs.push(b.message);
    if (!erreurs.length && b.bbox) valeur = { nom: s.nom.trim(), bbox: b.bbox };
  } else if (cle === "CRS_METRIQUE_BANDES") {
    const lignes = s.bandes.split("\n").map((l) => l.trim()).filter(Boolean);
    const bandes: { jusquaLongitude: number; epsg: number }[] = [];
    for (const l of lignes) {
      const [lon, ep] = l.split(";").map((x) => x.trim());
      const n = lireSaisieNombre(lon ?? "");
      const e = entierEpsg(ep ?? "");
      if (n === null || e === null) { erreurs.push(`Ligne illisible « ${l} » : écrivez « longitude ; code EPSG », par exemple « -12 ; 32628 ».`); continue; }
      bandes.push({ jusquaLongitude: n, epsg: e });
    }
    if (bandes.length > 20) erreurs.push("Vingt bandes au plus.");
    for (let i = 1; i < bandes.length; i += 1) if (bandes[i].jusquaLongitude <= bandes[i - 1].jusquaLongitude) { erreurs.push("Les bandes sont triées par longitude croissante."); break; }
    const d = entierEpsg(s.epsgDefaut);
    if (d === null) erreurs.push("Saisissez le code EPSG par défaut (au-delà de la dernière bande).");
    if ([...bandes.map((b) => b.epsg), d].includes(4326)) erreurs.push("Le système de calcul est métrique : EPSG:4326 (degrés) n'est pas admis.");
    if (!erreurs.length && d !== null) valeur = { bandes, epsgDefaut: d };
  } else if (cle === "CRS_IMPORT_LISTE_BLANCHE") {
    const parts = s.epsg.split(/[\s,;]+/).filter(Boolean);
    const codes = parts.map(entierEpsg);
    if (codes.some((c) => c === null)) erreurs.push("Chaque code EPSG compte quatre à six chiffres.");
    else {
      const uniques = [...new Set(codes as number[])];
      if (uniques.length === 0 || uniques.length > 20) erreurs.push("Un à vingt codes.");
      if (!uniques.includes(4326)) erreurs.push("EPSG:4326 (WGS 84) est obligatoire dans la liste.");
      if (!erreurs.length) valeur = { epsg: uniques };
    }
  } else if (cle === "PROTECTIONS") {
    const v: Record<string, number> = {};
    for (const [k, t] of Object.entries(s.protections)) {
      if (!t.trim()) continue;
      const n = lireSaisieNombre(t);
      if (n === null || !Number.isInteger(n) || n < 0) erreurs.push(`${LIBELLE_PROTECTION[k] ?? k} : un nombre entier positif est attendu.`); else v[k] = n;
    }
    if (!erreurs.length) valeur = v;
  } else {
    try {
      const j: unknown = JSON.parse(s.json || "{}");
      if (!j || typeof j !== "object" || Array.isArray(j)) erreurs.push("La valeur est un objet JSON."); else valeur = j as Record<string, unknown>;
    } catch { erreurs.push("La valeur n'est pas du JSON lisible."); }
  }
  return { valeur: erreurs.length ? null : valeur, erreurs };
}

/** Valeur effective lisible (une ligne), pour la fiche de configuration. */
export function resumeValeurConfiguration(cle: string, valeur: unknown): string {
  const o = valeur && typeof valeur === "object" && !Array.isArray(valeur) ? (valeur as Record<string, unknown>) : null;
  if (!o) return "Valeur illisible";
  if (cle === "EMPRISE_PLAUSIBILITE") { const b = Array.isArray(o.bbox) && o.bbox.length === 4 ? o.bbox.map(versNombre) : null; return `${typeof o.nom === "string" ? o.nom : "Sans nom"} : ${b && b.every((x) => x !== null) ? formaterBbox(b as Bbox) : "rectangle illisible"}`; }
  if (cle === "CRS_METRIQUE_BANDES") {
    const bandes = Array.isArray(o.bandes) ? o.bandes as Record<string, unknown>[] : [];
    const t = bandes.map((b) => `longitude < ${texteDe(b.jusquaLongitude)} : EPSG:${texteDe(b.epsg)}`).join(" ; ");
    return `${t ? `${t} ; ` : ""}sinon EPSG:${texteDe(o.epsgDefaut)}`;
  }
  if (cle === "CRS_IMPORT_LISTE_BLANCHE") return Array.isArray(o.epsg) ? o.epsg.map((e) => `EPSG:${String(e)}`).join(", ") : "Liste illisible";
  if (cle === "PROTECTIONS") return Object.entries(o).map(([k, v]) => `${LIBELLE_PROTECTION[k] ?? k} : ${texteDe(v)}`).join(" ; ");
  return JSON.stringify(o);
}

/** Liste blanche effective des CRS (codes), lue dans la configuration ; `null` si absente ou illisible. */
export function listeBlancheEffective(config: readonly EntreeConfiguration[] | undefined): number[] | null {
  const e = config?.find((c) => c.cle === "CRS_IMPORT_LISTE_BLANCHE");
  const v = e?.valeur && typeof e.valeur === "object" ? (e.valeur as Record<string, unknown>).epsg : null;
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : null;
}

// ---------------------------------------------------------------------------------------------------
// Erreurs typees du lot T1
// ---------------------------------------------------------------------------------------------------

const RIEN = " Rien n'a été modifié.";

/** Messages en clair des codes du lot T1 (CONTRAT-TERRITOIRES.md section 8). Les complements numeriques viennent du corps. */
export const MESSAGE_CODE_TERRITOIRES: Record<string, string> = {
  TERRITOIRE_REQUIS: "Le territoire du projet est obligatoire : choisissez-le dans la liste." + RIEN,
  TERRITOIRE_INTROUVABLE: "Ce territoire est introuvable : il n'existe pas, il a été retiré ou désactivé, ou il n'est pas dans votre périmètre. Choisissez-en un autre dans la liste.",
  TERRITOIRE_PARENT_INTROUVABLE: "Le territoire parent est inconnu ou retiré : choisissez un parent existant." + RIEN,
  TERRITOIRE_PARENT_REQUIS: "Un territoire qui n'est pas la nation exige un parent." + RIEN,
  NIVEAU_INCOMPATIBLE: "Ce niveau n'est pas admis sous ce parent : le parent doit être d'un niveau supérieur (une commune peut être directement sous une région, jamais l'inverse)." + RIEN,
  NATION_DEJA_DEFINIE: "Une nation existe déjà : il n'y a qu'un territoire de niveau Nation à la fois." + RIEN,
  TERRITOIRE_UTILISE: "Ce territoire porte encore des territoires enfants ou des projets non retirés : il ne peut pas être retiré. Rattachez ou retirez-les d'abord, ou désactivez-le (il reste alors lisible, mais n'est plus proposé à la création d'un projet)." + RIEN,
  TERRITOIRE_REGION_INCOHERENTE: "Ce territoire n'est pas dans la même région que le projet : un changement de territoire ne déplace jamais un projet d'une région à une autre. Choisissez un territoire de la région du projet." + RIEN,
  EMPRISE_INVALIDE: "L'emprise est refusée par le serveur : un polygone ou un multipolygone WGS 84 valide est attendu (anneaux fermés, sans auto-intersection, 10 000 sommets au plus)." + RIEN,
  DOMAINE_INCONNU: "Ce domaine de référentiel est inconnu du serveur.",
  VALEUR_INTROUVABLE: "Cette valeur de référentiel est introuvable (retirée, ou code inconnu).",
  VALEUR_UTILISEE: "Cette valeur est portée par des objets non retirés (jeux, concessionnaires ou projets) : elle ne peut pas être retirée. Désactivez-la plutôt : elle restera lisible sur ces objets et ne sera plus proposée." + RIEN,
  TYPE_RESEAU_INCOHERENT: "Le type de réseau choisi n'appartient pas à la famille indiquée : choisissez le type seul, la famille en est déduite." + RIEN,
  TYPE_RESEAU_INCONNU: "Ce type de réseau est inconnu ou retiré du référentiel : choisissez-en un dans la liste." + RIEN,
  CATEGORIE_INCONNUE: "Cette catégorie de projet est inconnue ou retirée du référentiel : choisissez-en une dans la liste." + RIEN,
  CLE_INCONNUE: "Cette clé de configuration est inconnue du serveur.",
  VALEUR_INVALIDE: "La valeur ne respecte pas le schéma de cette clé de configuration : vérifiez la saisie." + RIEN,
  CRS_NON_AUTORISE: "Ce système de coordonnées n'est pas admis : un système métrique de calcul doit être projeté et figurer dans la liste blanche des systèmes d'import." + RIEN,
  CRS_NON_DISPONIBLE: "Un code EPSG saisi est inconnu de la base de données géographique du serveur." + RIEN,
  CODE_DEJA_UTILISE: "Ce code est déjà utilisé (y compris par un élément retiré) : choisissez-en un autre." + RIEN,
  PARAMETRES_INVALIDES: "Les paramètres sont refusés par le serveur pour ce domaine : vérifiez la saisie." + RIEN,
  CHAMPS_INVALIDES: "Les valeurs envoyées sont refusées par le serveur (champ inconnu ou hors des bornes). Vérifiez la saisie." + RIEN,
  REGION_INCONNUE: "Cette région est inconnue du référentiel administratif." + RIEN,
  HORS_PERIMETRE: "Cette région n'est pas dans le périmètre de votre compte." + RIEN,
  IDENTIFIANT_INVALIDE: "L'identifiant demandé n'est pas valide (adresse modifiée ou lien tronqué).",
};

type O = Record<string, unknown>;
const enObjet = (v: unknown): O | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as O) : null);
const corpsErreur = (e: unknown): O | null => enObjet(enObjet(enObjet(e)?.response)?.data);

/**
 * Detail par champ d'une erreur 400 : le serveur rend `details` sous deux formes (`details` = erreurs par champ d'un zod aplati, ou
 * `details.details` / `details.fieldErrors`) : on lit les deux. Rien n'est invente.
 */
export function detailsParChamp(e: unknown): Record<string, string[]> {
  const c = corpsErreur(e);
  const d = enObjet(c?.details);
  const source = enObjet(d?.fieldErrors) ?? enObjet(d?.details) ?? d;
  const sortie: Record<string, string[]> = {};
  if (source) for (const [k, v] of Object.entries(source)) if (Array.isArray(v)) { const m = v.filter((x): x is string => typeof x === "string"); if (m.length) sortie[k] = m; }
  return sortie;
}

/** Classe une erreur des ecrans T1 : codes du lot en clair (avec complements), le reste comme les ecrans de conflits (429, 503, 504, reseau). Jamais d'exception. */
export function classerErreurTerritoires(e: unknown): ErreurPv {
  const base = classerErreur(e);
  const corps = corpsErreur(e);
  if (base.code && MESSAGE_CODE_TERRITOIRES[base.code]) {
    const genre: GenreErreur = base.status === 409 ? "conflit" : base.status === 404 ? "introuvable" : base.status === 403 ? "droit" : base.status === 503 || base.status === 504 || base.status === 429 ? "serveur" : "validation";
    let message = MESSAGE_CODE_TERRITOIRES[base.code];
    if (base.code === "TERRITOIRE_UTILISE") {
      const enfants = versNombre(corps?.enfants), projets = versNombre(corps?.projets);
      if (enfants !== null || projets !== null) message = `Ce territoire porte encore ${enfants ?? 0} territoire(s) enfant(s) et ${projets ?? 0} projet(s) non retirés : il ne peut pas être retiré. Rattachez ou retirez-les d'abord, ou désactivez-le (il reste lisible, mais n'est plus proposé à la création d'un projet).${RIEN}`;
    }
    if (base.code === "VALEUR_UTILISEE") {
      const u = enObjet(corps?.usages);
      const parts = u ? Object.entries(u).flatMap(([k, v]) => { const n = versNombre(v); return n ? [`${n} ${k}`] : []; }) : [];
      if (parts.length) message = `Cette valeur est portée par ${parts.join(", ")} non retiré(s) : elle ne peut pas être retirée. Désactivez-la plutôt : elle restera lisible sur ces objets et ne sera plus proposée.${RIEN}`;
    }
    const champs = detailsParChamp(e);
    if ((base.code === "PARAMETRES_INVALIDES" || base.code === "VALEUR_INVALIDE" || base.code === "CHAMPS_INVALIDES") && Object.keys(champs).length) {
      message += ` Détail : ${Object.entries(champs).map(([k, m]) => `${k} : ${m.join(", ")}`).join(" ; ")}.`;
    }
    if (base.code === "CRS_NON_DISPONIBLE" || base.code === "CRS_NON_AUTORISE") {
      const ep = Array.isArray(corps?.epsg) ? corps.epsg : typeof corps?.epsg === "number" ? [corps.epsg] : [];
      if (ep.length) message += ` Codes concernés : ${ep.map((x) => `EPSG:${String(x)}`).join(", ")}.`;
    }
    return { ...base, genre, message, champs };
  }
  return classerErreurConflit(e);
}

// ---------------------------------------------------------------------------------------------------
// Saisie d'une emprise (formulaire d'administration)
// ---------------------------------------------------------------------------------------------------

/** `conserver` (modification seulement), `aucune` (pas d'emprise, ou la retirer), `bornes` (rectangle), `geojson` (texte), `carte` (rectangle dessine). */
export type ModeEmprise = "conserver" | "aucune" | "bornes" | "geojson" | "carte";
export interface SaisieEmprise { mode: ModeEmprise; ouest: string; sud: string; est: string; nord: string; texte: string; dessin: Bbox | null }
export const SAISIE_EMPRISE_VIDE: SaisieEmprise = { mode: "aucune", ouest: "", sud: "", est: "", nord: "", texte: "", dessin: null };

/**
 * Valeur a envoyer pour l'emprise : `undefined` = ne pas toucher (champ absent du corps), `null` = pas d'emprise (ou la retirer), sinon le
 * GeoJSON. `erreur` dit en clair pourquoi la saisie n'est pas utilisable (rien n'est envoye).
 */
export function empriseDepuisSaisie(s: SaisieEmprise): { valeur: EmpriseGeoJson | null | undefined; erreur: string | null; bbox: Bbox | null } {
  if (s.mode === "conserver") return { valeur: undefined, erreur: null, bbox: null };
  if (s.mode === "aucune") return { valeur: null, erreur: null, bbox: null };
  if (s.mode === "bornes") {
    const b = lireBornes(s);
    if (!b.bbox) return { valeur: undefined, erreur: b.message, bbox: null };
    return { valeur: rectangleVersEmprise(b.bbox), erreur: null, bbox: b.bbox };
  }
  if (s.mode === "carte") {
    if (!s.dessin) return { valeur: undefined, erreur: "Dessinez le rectangle sur la carte : cliquez un premier coin, puis le coin opposé.", bbox: null };
    const e = rectangleVersEmprise(s.dessin);
    return e ? { valeur: e, erreur: null, bbox: s.dessin } : { valeur: undefined, erreur: "Rectangle dessiné dégénéré : recommencez.", bbox: null };
  }
  const l = lireSaisieEmprise(s.texte);
  if (!l) return { valeur: undefined, erreur: "Collez l'emprise en GeoJSON (Polygon ou MultiPolygon, WGS 84).", bbox: null };
  if (!l.ok) return { valeur: undefined, erreur: l.message, bbox: null };
  return { valeur: l.emprise, erreur: null, bbox: l.bbox };
}
