/**
 * Consultation des releves en roulage : regles PURES (aucun import, ni base, ni horloge, ni Express).
 *
 * CE QUE CE FICHIER DECIDE
 *
 * 1. Qui voit quoi (`porteeDe`) : la regle de visibilite d'un releve, en une fonction testable seule.
 * 2. Ce que le client a le droit de demander (`lireParametresListe`, `lireOptionsDetail`) : une entree
 *    hostile (borne hors plage, date impossible, curseur forge, parametre repete) est un REFUS NOMME,
 *    jamais une exception ni une requete SQL qui echoue.
 * 3. Le curseur de pagination (`encoderCurseur`, `decoderCurseur`) : opaque pour le client, strictement
 *    valide en retour.
 *
 * POURQUOI LE CURSEUR PLUTOT QUE `page`
 *
 * La liste est triee par date de debut decroissante : un releve envoye pendant qu'on feuillette s'insere
 * AU DEBUT, ce qui decalerait toutes les pages d'un `OFFSET`. Un curseur (date, identifiant) designe la
 * ligne d'ou reprendre, il ne bouge pas quand le debut de la liste change. L'identifiant departage deux
 * releves du meme instant : sans lui, l'un des deux serait saute ou rendu deux fois.
 */

export const LIMITE_DEFAUT = 25;
export const LIMITE_MAX = 100;
/** Au-dela, la geometrie renvoyee pour l'affichage est simplifiee (le releve brut reste intact en base). */
export const SOMMETS_MAX_AFFICHAGE = 5_000;
/** Plafond des points bruts renvoyes par `?avecPoints=1` ; au-dela, la reponse est tronquee et le dit. */
export const POINTS_MAX_REPONSE = 20_000;
/** Bornes de plausibilite des dates, comme le contrat de la charge (2000-01-01 a 2100-01-01). */
const ANNEE_MIN = 2000;
const ANNEE_MAX = 2099;

export type CodeRefus = "PARAMETRE_INVALIDE" | "CURSEUR_INVALIDE";
export type Refus = { ok: false; code: CodeRefus; message: string };

const refus = (code: CodeRefus, message: string): Refus => ({ ok: false, code, message });

// ------------------------------------------------------------------ identifiants

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** L'identifiant d'une session est un UUID (contrat de la charge : `sessionId`). Tout autre texte n'existe pas. */
export const estIdentifiantSession = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** Identifiant de compte accepte en filtre : forme sobre, bornee. Un identifiant inconnu rend simplement une liste vide. */
const IDENTIFIANT_COMPTE = /^[A-Za-z0-9_-]{1,64}$/;

// ------------------------------------------------------------------ dates

const joursDuMois = (annee: number, mois: number): number =>
  mois === 2 ? (annee % 4 === 0 && (annee % 100 !== 0 || annee % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(mois) ? 30 : 31;

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2}))?$/;

export interface Instant {
  /** Instant en ms depuis l'epoque. */
  ms: number;
  /** `true` pour une date sans heure (`2026-10-25`) : une borne haute vise alors la FIN de ce jour. */
  jourSeul: boolean;
}

/**
 * Lit une date ISO 8601 STRICTE. Refuse (rend `null`) : une date impossible (`2026-02-30`, `2026-13-01`,
 * `2026-10-25T24:00:00Z`), une heure sans fuseau (ambigue : le serveur ne devine pas l'heure locale du
 * client), une annee hors 2000-2099, tout autre format. `new Date("2026-02-30")` rendrait le 2 mars, sans
 * erreur : c'est exactement ce que cette fonction empeche.
 */
export function lireInstant(texte: string): Instant | null {
  const m = ISO.exec(texte);
  if (!m) return null;
  const [, a, mo, j, h, mi, s, frac, zone] = m;
  const annee = Number(a); const mois = Number(mo); const jour = Number(j);
  if (annee < ANNEE_MIN || annee > ANNEE_MAX || mois < 1 || mois > 12 || jour < 1 || jour > joursDuMois(annee, mois)) return null;
  if (h === undefined) return { ms: Date.UTC(annee, mois - 1, jour), jourSeul: true };
  const heure = Number(h); const minute = Number(mi); const seconde = s === undefined ? 0 : Number(s);
  if (heure > 23 || minute > 59 || seconde > 59) return null;
  let decalageMin = 0;
  if (zone !== "Z") {
    const hz = Number(zone.slice(1, 3)); const mz = Number(zone.slice(4, 6));
    if (hz > 14 || mz > 59) return null;
    decalageMin = (zone[0] === "-" ? -1 : 1) * (hz * 60 + mz);
  }
  const millis = frac === undefined ? 0 : Number(frac.padEnd(3, "0"));
  const ms = Date.UTC(annee, mois - 1, jour, heure, minute, seconde, millis) - decalageMin * 60_000;
  return { ms, jourSeul: false };
}

const FORME_CANONIQUE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

// ------------------------------------------------------------------ curseur

export interface Curseur {
  /** `debutA` du dernier releve rendu, en ISO UTC a la milliseconde. */
  debutA: string;
  id: string;
}

const BASE64URL = /^[A-Za-z0-9_-]{1,300}$/;

export function encoderCurseur(c: Curseur): string {
  return Buffer.from(JSON.stringify({ d: c.debutA, i: c.id }), "utf8").toString("base64url");
}

/**
 * Un curseur est une valeur que le CLIENT renvoie : il peut etre forge. On le relit donc comme une entree
 * hostile : alphabet base64url borne, JSON a deux cles exactement, date reelle au format canonique, identifiant
 * au format UUID. Tout ecart est `CURSEUR_INVALIDE` (400), jamais une requete SQL qui echoue.
 */
export function decoderCurseur(texte: string): { ok: true; curseur: Curseur } | Refus {
  const invalide = refus("CURSEUR_INVALIDE", "Curseur invalide.");
  if (!BASE64URL.test(texte)) return invalide;
  let brut: unknown;
  try { brut = JSON.parse(Buffer.from(texte, "base64url").toString("utf8")); } catch { return invalide; }
  if (typeof brut !== "object" || brut === null || Array.isArray(brut)) return invalide;
  const cles = Object.keys(brut).sort();
  if (cles.length !== 2 || cles[0] !== "d" || cles[1] !== "i") return invalide;
  const { d, i } = brut as { d: unknown; i: unknown };
  if (typeof d !== "string" || !FORME_CANONIQUE.test(d) || lireInstant(d) === null) return invalide;
  if (!estIdentifiantSession(i)) return invalide;
  return { ok: true, curseur: { debutA: d, id: i } };
}

// ------------------------------------------------------------------ parametres de la liste

export interface ParametresListe {
  limite: number;
  curseur: Curseur | null;
  userId: string | null;
  /** Borne basse INCLUSIVE sur `debutA`, ISO UTC. */
  depuis: string | null;
  /** Borne haute EXCLUSIVE sur `debutA`, ISO UTC (une date sans heure vise la fin du jour). */
  avant: string | null;
}

type Requete = Record<string, unknown>;

/** Un parametre de requete doit etre UN texte : `?limite=1&limite=2` (tableau) et `?limite[a]=1` (objet) sont refuses. */
function unTexte(requete: Requete, nom: string): { ok: true; valeur: string | undefined } | Refus {
  const v = requete[nom];
  if (v === undefined) return { ok: true, valeur: undefined };
  if (typeof v !== "string") return refus("PARAMETRE_INVALIDE", `Parametre ${nom} invalide : une seule valeur texte est attendue.`);
  return { ok: true, valeur: v };
}

export const versIso = (ms: number): string => new Date(ms).toISOString();

export function lireParametresListe(requete: Requete): { ok: true; valeur: ParametresListe } | Refus {
  const lus: Record<string, string | undefined> = {};
  for (const nom of ["limite", "curseur", "userId", "depuis", "jusqua"]) {
    const r = unTexte(requete, nom);
    if (!r.ok) return r;
    lus[nom] = r.valeur;
  }

  let limite = LIMITE_DEFAUT;
  if (lus.limite !== undefined) {
    if (!/^\d{1,3}$/.test(lus.limite)) return refus("PARAMETRE_INVALIDE", `Parametre limite invalide : entier de 1 a ${LIMITE_MAX}.`);
    limite = Number(lus.limite);
    if (limite < 1 || limite > LIMITE_MAX) return refus("PARAMETRE_INVALIDE", `Parametre limite invalide : entier de 1 a ${LIMITE_MAX}.`);
  }

  let curseur: Curseur | null = null;
  if (lus.curseur !== undefined) {
    const c = decoderCurseur(lus.curseur);
    if (!c.ok) return c;
    curseur = c.curseur;
  }

  let userId: string | null = null;
  if (lus.userId !== undefined) {
    if (!IDENTIFIANT_COMPTE.test(lus.userId)) return refus("PARAMETRE_INVALIDE", "Parametre userId invalide.");
    userId = lus.userId;
  }

  let depuis: string | null = null;
  let avant: string | null = null;
  let depuisMs: number | null = null;
  let avantMs: number | null = null;
  if (lus.depuis !== undefined) {
    const i = lireInstant(lus.depuis);
    if (!i) return refus("PARAMETRE_INVALIDE", "Parametre depuis invalide : date ISO 8601 reelle attendue (AAAA-MM-JJ ou AAAA-MM-JJThh:mm:ssZ).");
    depuisMs = i.ms;
    depuis = versIso(i.ms);
  }
  if (lus.jusqua !== undefined) {
    const i = lireInstant(lus.jusqua);
    if (!i) return refus("PARAMETRE_INVALIDE", "Parametre jusqua invalide : date ISO 8601 reelle attendue (AAAA-MM-JJ ou AAAA-MM-JJThh:mm:ssZ).");
    // La colonne est a la milliseconde : « jusqu'a T inclus » = « strictement avant T + 1 ms » ; « jusqu'au jour J » = avant J+1.
    avantMs = i.ms + (i.jourSeul ? 86_400_000 : 1);
    avant = versIso(avantMs);
  }
  if (depuisMs !== null && avantMs !== null && depuisMs >= avantMs) {
    return refus("PARAMETRE_INVALIDE", "Plage de dates invalide : depuis doit preceder jusqua.");
  }
  return { ok: true, valeur: { limite, curseur, userId, depuis, avant } };
}

export interface OptionsDetail { avecPoints: boolean }

export function lireOptionsDetail(requete: Requete): { ok: true; valeur: OptionsDetail } | Refus {
  const r = unTexte(requete, "avecPoints");
  if (!r.ok) return r;
  if (r.valeur === undefined || r.valeur === "0" || r.valeur === "false") return { ok: true, valeur: { avecPoints: false } };
  if (r.valeur === "1" || r.valeur === "true") return { ok: true, valeur: { avecPoints: true } };
  return refus("PARAMETRE_INVALIDE", "Parametre avecPoints invalide : 1 ou 0.");
}

// ------------------------------------------------------------------ portee (qui voit quoi)

/**
 * Ce qu'un compte peut voir. Trois portees, jamais davantage :
 *
 *  - `tous`    : ADMIN, et GESTIONNAIRE sans rattachement regional (compte national, comme partout ailleurs) ;
 *  - `regions` : GESTIONNAIRE rattache a des regions : ses propres releves, plus ceux dont un troncon
 *                traverse (portion creee) est dans une de ses regions ;
 *  - `siens`   : tout autre compte (INSPECTEUR, LECTEUR, role futur) : ses propres releves. Le defaut est
 *                RESTREINT, pour qu'un role ajoute un jour tombe du cote ferme sans que personne y pense.
 *
 * Un releve sans aucun troncon rattache n'a pas de region : un compte regional ne le voit que s'il en est
 * l'auteur (meme principe que le reste du territoire : on ne deduit pas une localisation de son absence).
 */
export type Portee =
  | { type: "tous" }
  | { type: "siens"; userId: string }
  | { type: "regions"; userId: string; regions: readonly number[] };

/**
 * `regionsVisibles` : ce que rend `territoire.lecture.regionsVisibles` (`null` = compte national). Il n'est
 * lu que pour un GESTIONNAIRE (les autres roles ne l'utilisent pas : voir `roleALePerimetre`).
 */
export function porteeDe(compte: { id: string; role: string }, regionsVisibles: readonly number[] | null): Portee {
  if (compte.role === "ADMIN") return { type: "tous" };
  if (compte.role === "GESTIONNAIRE") {
    if (regionsVisibles === null) return { type: "tous" };
    // Une liste vide ne peut pas venir d'un compte regional ; si elle venait, on ferme plutot que d'ouvrir.
    return regionsVisibles.length > 0 ? { type: "regions", userId: compte.id, regions: [...regionsVisibles] } : { type: "siens", userId: compte.id };
  }
  return { type: "siens", userId: compte.id };
}

/** Seul un GESTIONNAIRE voit au-dela de ses propres releves : inutile de lire son perimetre pour les autres roles. */
export const roleALePerimetre = (role: string): boolean => role === "GESTIONNAIRE";

// ------------------------------------------------------------------ geometrie

export interface GeoJsonMultiLigne { type: "MultiLineString"; coordinates: number[][][] }

/**
 * Relit le GeoJSON rendu par PostGIS et garantit le type annonce au client : MultiLineString. Une
 * simplification peut, dans certains cas, rendre une LineString ; on la ramene a une MultiLineString plutot
 * que de laisser le client gerer deux formes.
 */
export function versMultiLigne(texte: string | null): GeoJsonMultiLigne | null {
  if (texte === null) return null;
  let g: unknown;
  try { g = JSON.parse(texte); } catch { return null; }
  if (typeof g !== "object" || g === null) return null;
  const { type, coordinates } = g as { type?: unknown; coordinates?: unknown };
  if (type === "MultiLineString" && Array.isArray(coordinates)) return { type: "MultiLineString", coordinates: coordinates as number[][][] };
  if (type === "LineString" && Array.isArray(coordinates)) return { type: "MultiLineString", coordinates: [coordinates as number[][]] };
  return null;
}

/** Tolerances de simplification essayees (degres, ~1 m a ~140 m), de la plus fine a la plus grossiere. */
export const TOLERANCES_SIMPLIFICATION: readonly number[] = [0.00001, 0.00002, 0.00004, 0.00008, 0.00016, 0.00032, 0.00064, 0.00128];
