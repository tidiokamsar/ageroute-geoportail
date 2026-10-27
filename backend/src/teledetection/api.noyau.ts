/**
 * Noyau de l'API d'observation de la Terre (chantier EO-API) : lecture des parametres, validation des
 * entrees hostiles, curseur, mise en forme des reponses du contrat (CONTRAT-API-UI.md, paragraphes 5 et 6).
 *
 * PUR : aucun acces base, aucun reseau, aucune horloge (la date « maintenant » est un parametre), aucune
 * importation autre que des types et le noyau geometrique d'EO-SOURCES (pur lui aussi).
 *
 * POURQUOI CE FICHIER EXISTE
 *
 * L'audit du chantier a trouve des entrees qui donnaient 500 ou, pire, etaient ignorees en silence : des
 * `coordinates` en texte, un type de geometrie inconnu, un polygone auto-intersecte, une emprise hors du
 * globe, une date en l'an 2999, `?statut[]=X` ou `?statut=` qui ne filtraient rien. Ici, chaque entree est
 * ou BIEN FORMEE ou REFUSEE avec une phrase ; jamais ignoree, jamais une erreur serveur.
 *
 * Les bornes ecrites ici sont des choix de conduite PROVISOIRES (reversibles), reprises dans API.md.
 */

import { polygoneDeBbox, validerPolygone, type PolygoneGeoJson } from "./sources/geometrie";

export type Entree<T> = { ok: true; valeur: T } | { ok: false; message: string };
const ok = <T>(valeur: T): Entree<T> => ({ ok: true, valeur });
const ko = (message: string): { ok: false; message: string } => ({ ok: false, message });

// ============================================================ bornes PROVISOIRES

export const LIMITE_DEFAUT = 25;
export const LIMITE_MAX = 100;
/**
 * Cote maximal (degres) de l'emprise d'une requete GeoJSON : contrat, section 5. PROVISOIRE, une seule source de verite pour la borne
 * SERVEUR (le zoom minimal de la carte vit dans `frontend/src/lib/teledetectionCarte.ts`). 10 degres, et non plus 5 : la Guinee entiere
 * (environ 7,5 x 5,7 degres) doit tenir dans UNE requete pour que la vue d'ouverture soit nationale ; le plafond de marqueurs
 * (`GEOJSON_PLAFOND_DEFAUT`) et la troncature annoncee (`tronque`, `total`) bornent le volume. La limite reste un garde contre un balayage du globe.
 */
export const BBOX_COTE_MAX_DEG = 10;
export const GEOJSON_PLAFOND_DEFAUT = 300;
export const GEOJSON_PLAFOND_MAX = 1000;
/** Premiere date admise : en dessous, une date est une faute de saisie (le premier Sentinel-2 date de 2015). */
export const DATE_MIN_FILTRE = Date.UTC(2000, 0, 1);
export const DATE_MIN_CATALOGUE = Date.UTC(2015, 5, 23);
/** Une date admise ne depasse pas « maintenant » de plus d'un an (filtre) ou d'un jour (acquisition, catalogue). */
const JOURS_MS = 86_400_000;
export const SYNCHRO_BBOX_COTE_MAX_DEG = 2;
export const SYNCHRO_FENETRE_MAX_JOURS = 92;
export const SYNCHRO_PRODUITS_MAX = 200;
export const SYNCHRO_PAGES_MAX = 4;
/** Taille d'un lot du journal d'audit pour les identifiants de propositions deposees. */
export const AUDIT_IDS_PAR_LIGNE = 500;

export const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const estUuid = (v: unknown): v is string => typeof v === "string" && REGEX_UUID.test(v);

export const STATUTS = ["A_VERIFIER", "EN_ATTENTE", "NON_CONCLUANTE", "CONFIRMEE", "INFIRMEE"] as const;
export const TYPES = ["NOUVELLE_ROUTE", "COUPURE_PROBABLE", "VEGETATION", "INONDATION"] as const;
export const PRIORITES_FILTRE = ["HAUTE", "MOYENNE", "FAIBLE"] as const;
export const NATURES = ["OPTIQUE", "RADAR", "ALTIMETRIE", "PRECIPITATIONS", "POPULATION", "INONDATION", "ROUTES_EXTRAITES"] as const;
export const REGEX_CODE_SOURCE = /^[A-Za-z0-9_-]{1,64}$/;

// ============================================================ dates

const REGEX_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const REGEX_DATE_HEURE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export interface BornesDate { min: number; max: number }
export const bornesFiltre = (maintenant: Date): BornesDate => ({ min: DATE_MIN_FILTRE, max: maintenant.getTime() + 366 * JOURS_MS });
export const bornesCatalogue = (maintenant: Date): BornesDate => ({ min: DATE_MIN_CATALOGUE, max: maintenant.getTime() + JOURS_MS });

/**
 * Date ISO stricte : « AAAA-MM-JJ » ou date et heure AVEC fuseau. Un jour inexistant (31 fevrier) est refuse, comme une
 * date hors bornes (l'an 2999, l'an 1). `finDeJour` : une date sans heure en borne HAUTE vaut la fin de ce jour.
 */
export function lireDateIso(texte: unknown, nom: string, bornes: BornesDate, finDeJour = false): Entree<Date> {
  if (typeof texte !== "string" || texte.trim() === "") return ko(`${nom} : une date ISO est attendue (AAAA-MM-JJ ou date et heure avec fuseau)`);
  const t = texte.trim();
  let d: Date;
  const j = REGEX_DATE.exec(t);
  if (j) {
    d = new Date(Date.UTC(Number(j[1]), Number(j[2]) - 1, Number(j[3])));
    if (d.getUTCFullYear() !== Number(j[1]) || d.getUTCMonth() !== Number(j[2]) - 1 || d.getUTCDate() !== Number(j[3])) return ko(`${nom} : jour inexistant (${t})`);
    if (finDeJour) d = new Date(d.getTime() + JOURS_MS - 1);
  } else if (REGEX_DATE_HEURE.test(t)) {
    d = new Date(t);
    if (Number.isNaN(d.getTime())) return ko(`${nom} : date illisible (${t})`);
  } else {
    return ko(`${nom} : format de date invalide (AAAA-MM-JJ ou date et heure avec fuseau)`);
  }
  if (d.getTime() < bornes.min || d.getTime() > bornes.max) {
    return ko(`${nom} : date hors des bornes admises (${new Date(bornes.min).toISOString().slice(0, 10)} a ${new Date(bornes.max).toISOString().slice(0, 10)})`);
  }
  return ok(d);
}

/** Format « AAAA-MM-JJ HH:MM:SS.mmm » (UTC) pour un parametre SQL converti en `timestamp` : sans ambiguite de fuseau. */
export const dateSql = (d: Date): string => d.toISOString().replace("T", " ").replace("Z", "");

// ============================================================ lecture des parametres de requete

type Brut = Record<string, unknown>;

/** Un parametre inconnu est refuse : l'ignorer ferait croire qu'un filtre a ete applique. */
export function parametresInconnus(q: Brut, connus: readonly string[]): string | null {
  const inconnus = Object.keys(q).filter((k) => !connus.includes(k));
  return inconnus.length ? `parametre(s) inconnu(s) : ${inconnus.slice(0, 5).map((k) => k.slice(0, 40)).join(", ")}` : null;
}

function unique(q: Brut, nom: string): Entree<string | undefined> {
  const v = q[nom];
  if (v === undefined) return ok(undefined);
  if (typeof v !== "string") return ko(`${nom} : une seule valeur texte est attendue`);
  if (v.trim() === "") return ko(`${nom} : valeur vide (omettre le parametre pour ne pas filtrer)`);
  return ok(v.trim());
}

/** Liste de valeurs d'une enumeration : `a`, `a,b`, `a&a=b` ou `a[]=a` ; chaque valeur est connue, sinon refus (jamais ignoree). */
export function lireListe<T extends string>(q: Brut, nom: string, valeurs: readonly T[]): Entree<T[] | undefined> {
  const v = q[nom];
  if (v === undefined) return ok(undefined);
  const morceaux = Array.isArray(v) ? v : [v];
  if (morceaux.length === 0 || morceaux.length > 10) return ko(`${nom} : de 1 a 10 valeurs`);
  const sortie: T[] = [];
  for (const m of morceaux) {
    if (typeof m !== "string") return ko(`${nom} : valeurs texte attendues`);
    for (const p of m.split(",")) {
      const x = p.trim();
      if (x === "") return ko(`${nom} : valeur vide`);
      if (!(valeurs as readonly string[]).includes(x)) return ko(`${nom} : « ${x.slice(0, 40)} » n'est pas une valeur connue (${valeurs.join(", ")})`);
      if (!sortie.includes(x as T)) sortie.push(x as T);
    }
  }
  return ok(sortie);
}

function entier(q: Brut, nom: string, min: number, max: number): Entree<number | undefined> {
  const t = unique(q, nom);
  if (!t.ok || t.valeur === undefined) return t as Entree<undefined>;
  if (!/^-?\d{1,9}$/.test(t.valeur)) return ko(`${nom} : un entier est attendu`);
  const n = Number(t.valeur);
  return n < min || n > max ? ko(`${nom} : de ${min} a ${max}`) : ok(n);
}

function uuid(q: Brut, nom: string): Entree<string | undefined> {
  const t = unique(q, nom);
  if (!t.ok || t.valeur === undefined) return t;
  return estUuid(t.valeur) ? t : ko(`${nom} : un identifiant UUID est attendu`);
}

function booleen(q: Brut, nom: string): Entree<boolean | undefined> {
  const t = unique(q, nom);
  if (!t.ok || t.valeur === undefined) return t as Entree<undefined>;
  if (t.valeur === "true") return ok(true);
  if (t.valeur === "false") return ok(false);
  return ko(`${nom} : true ou false`);
}

function texte(q: Brut, nom: string, max: number, motif?: RegExp): Entree<string | undefined> {
  const t = unique(q, nom);
  if (!t.ok || t.valeur === undefined) return t;
  if (t.valeur.length > max) return ko(`${nom} : ${max} caracteres au plus`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(t.valeur)) return ko(`${nom} : caracteres de controle interdits`);
  if (motif && !motif.test(t.valeur)) return ko(`${nom} : forme invalide`);
  return t;
}

function periode(q: Brut, bornes: BornesDate): Entree<{ depuis?: Date; jusqua?: Date }> {
  const brutDepuis = unique(q, "depuis");
  if (!brutDepuis.ok) return brutDepuis;
  const brutJusqua = unique(q, "jusqua");
  if (!brutJusqua.ok) return brutJusqua;
  let depuis: Date | undefined;
  let jusqua: Date | undefined;
  if (brutDepuis.valeur !== undefined) { const d = lireDateIso(brutDepuis.valeur, "depuis", bornes); if (!d.ok) return d; depuis = d.valeur; }
  if (brutJusqua.valeur !== undefined) { const d = lireDateIso(brutJusqua.valeur, "jusqua", bornes, true); if (!d.ok) return d; jusqua = d.valeur; }
  if (depuis && jusqua && depuis > jusqua) return ko("depuis doit preceder jusqua");
  return ok({ depuis, jusqua });
}

function limite(q: Brut, defaut: number, max: number): Entree<number> {
  const l = entier(q, "limite", 1, max);
  if (!l.ok) return l;
  return ok(l.valeur ?? defaut);
}

// ------------------------------------------------------------ curseur

export interface Curseur { d: string; id: string }

export function encoderCurseur(c: Curseur): string {
  return Buffer.from(JSON.stringify({ d: c.d, id: c.id }), "utf8").toString("base64url");
}

/**
 * Un curseur est un jeton EMIS par l'API, mais le client le renvoie : sa date finit en `::timestamp` dans la requete. Une date
 * impossible (0000-01-01, 2026-02-31) y donnait une erreur SQL, donc un 500. La date doit donc etre canonique (relue par `Date`, elle
 * redonne le meme texte) et dans les bornes d'un filtre : de l'an 2000 a l'annee courante + 1.
 */
export function decoderCurseur(brut: string, maintenant: Date): Entree<Curseur> {
  if (brut.length > 300 || !/^[A-Za-z0-9_-]+$/.test(brut)) return ko("curseur : valeur illisible");
  let o: unknown;
  try { o = JSON.parse(Buffer.from(brut, "base64url").toString("utf8")); } catch { return ko("curseur : valeur illisible"); }
  if (!o || typeof o !== "object" || Array.isArray(o)) return ko("curseur : valeur illisible");
  const { d, id, ...reste } = o as Record<string, unknown>;
  if (Object.keys(reste).length > 0 || typeof d !== "string" || !estUuid(id)) return ko("curseur : valeur illisible");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(d)) return ko("curseur : valeur illisible");
  const t = new Date(d);
  if (Number.isNaN(t.getTime()) || t.toISOString() !== d) return ko("curseur : valeur illisible");
  const annee = t.getUTCFullYear();
  if (annee < 2000 || annee > maintenant.getUTCFullYear() + 1) return ko("curseur : valeur illisible");
  return ok({ d, id: id as string });
}

function lireCurseur(q: Brut, maintenant: Date): Entree<Curseur | undefined> {
  const t = unique(q, "curseur");
  if (!t.ok || t.valeur === undefined) return t as Entree<undefined>;
  return decoderCurseur(t.valeur, maintenant);
}

// ------------------------------------------------------------ bbox

export type Bbox = [number, number, number, number];

/** `ouest,sud,est,nord` en degres decimaux, dans le globe, non degenere, de cote borne (contrat : `BBOX_COTE_MAX_DEG` pour la carte). */
export function lireBbox(valeur: unknown, coteMax: number, nom = "bbox"): Entree<Bbox> {
  if (typeof valeur !== "string" || valeur.trim() === "") return ko(`${nom} obligatoire : ouest,sud,est,nord en degres`);
  const morceaux = valeur.split(",");
  if (morceaux.length !== 4 || !morceaux.every((m) => /^\s*-?\d{1,3}(\.\d{1,9})?\s*$/.test(m))) return ko(`${nom} : quatre nombres decimaux ouest,sud,est,nord`);
  const [o, s, e, n] = morceaux.map(Number);
  if (o < -180 || e > 180 || s < -90 || n > 90) return ko(`${nom} : hors du globe (longitude -180 a 180, latitude -90 a 90)`);
  if (!(o < e) || !(s < n)) return ko(`${nom} : ouest < est et sud < nord`);
  if (e - o > coteMax || n - s > coteMax) return ko(`${nom} : emprise trop grande (cote de ${coteMax} degres au plus)`);
  return ok([o, s, e, n]);
}

// ============================================================ filtres des listes

export interface FiltresPropositions {
  statut?: (typeof STATUTS)[number][];
  type?: (typeof TYPES)[number][];
  source?: string[];
  methode?: string;
  regionId?: number;
  tronconId?: string;
  priorite?: (typeof PRIORITES_FILTRE)[number][];
  rattachee?: boolean;
  depuis?: Date;
  jusqua?: Date;
  q?: string;
  curseur?: Curseur;
  limite: number;
}

export const PARAMS_PROPOSITIONS = ["statut", "type", "source", "methode", "regionId", "tronconId", "priorite", "rattachee", "depuis", "jusqua", "q", "curseur", "limite"] as const;

/** Liste d'identifiants de source : chacun a la forme d'un code, jamais ignore. */
function codesSource(q: Brut): Entree<string[] | undefined> {
  const v = q.source;
  if (v === undefined) return ok(undefined);
  const morceaux = (Array.isArray(v) ? v : [v]).flatMap((m) => (typeof m === "string" ? m.split(",") : [null]));
  if (morceaux.length === 0 || morceaux.length > 10 || morceaux.some((m) => typeof m !== "string" || !REGEX_CODE_SOURCE.test(m.trim()))) return ko("source : de 1 a 10 codes de source (lettres, chiffres, _ et -)");
  return ok([...new Set(morceaux.map((m) => (m as string).trim()))]);
}

export function lireFiltresPropositions(q: Brut, maintenant: Date): Entree<FiltresPropositions> {
  const inconnu = parametresInconnus(q, PARAMS_PROPOSITIONS);
  if (inconnu) return ko(inconnu);
  const statut = lireListe(q, "statut", STATUTS); if (!statut.ok) return statut;
  const type = lireListe(q, "type", TYPES); if (!type.ok) return type;
  const priorite = lireListe(q, "priorite", PRIORITES_FILTRE); if (!priorite.ok) return priorite;
  const source = codesSource(q); if (!source.ok) return source;
  const methode = texte(q, "methode", 200); if (!methode.ok) return methode;
  const regionId = entier(q, "regionId", 1, 1_000_000); if (!regionId.ok) return regionId;
  const tronconId = uuid(q, "tronconId"); if (!tronconId.ok) return tronconId;
  const rattachee = booleen(q, "rattachee"); if (!rattachee.ok) return rattachee;
  const p = periode(q, bornesFiltre(maintenant)); if (!p.ok) return p;
  const rech = texte(q, "q", 100); if (!rech.ok) return rech;
  const curseur = lireCurseur(q, maintenant); if (!curseur.ok) return curseur;
  const lim = limite(q, LIMITE_DEFAUT, LIMITE_MAX); if (!lim.ok) return lim;
  return ok({
    statut: statut.valeur, type: type.valeur, priorite: priorite.valeur, source: source.valeur, methode: methode.valeur,
    regionId: regionId.valeur, tronconId: tronconId.valeur, rattachee: rattachee.valeur, depuis: p.valeur.depuis, jusqua: p.valeur.jusqua,
    q: rech.valeur, curseur: curseur.valeur, limite: lim.valeur,
  });
}

export interface FiltresGeo { bbox: Bbox; statut?: (typeof STATUTS)[number][]; type?: (typeof TYPES)[number][]; priorite?: (typeof PRIORITES_FILTRE)[number][]; limite: number }

export function lireFiltresGeo(q: Brut): Entree<FiltresGeo> {
  const inconnu = parametresInconnus(q, ["bbox", "statut", "type", "priorite", "limite"]);
  if (inconnu) return ko(inconnu);
  const bbox = lireBbox(q.bbox, BBOX_COTE_MAX_DEG); if (!bbox.ok) return bbox;
  const statut = lireListe(q, "statut", STATUTS); if (!statut.ok) return statut;
  const type = lireListe(q, "type", TYPES); if (!type.ok) return type;
  const priorite = lireListe(q, "priorite", PRIORITES_FILTRE); if (!priorite.ok) return priorite;
  const lim = limite(q, GEOJSON_PLAFOND_DEFAUT, GEOJSON_PLAFOND_MAX); if (!lim.ok) return lim;
  return ok({ bbox: bbox.valeur, statut: statut.valeur, type: type.valeur, priorite: priorite.valeur, limite: lim.valeur });
}

export interface FiltresSynthese { regionId?: number; depuis?: Date; jusqua?: Date }

export function lireFiltresSynthese(q: Brut, maintenant: Date): Entree<FiltresSynthese> {
  const inconnu = parametresInconnus(q, ["regionId", "depuis", "jusqua"]);
  if (inconnu) return ko(inconnu);
  const regionId = entier(q, "regionId", 1, 1_000_000); if (!regionId.ok) return regionId;
  const p = periode(q, bornesFiltre(maintenant)); if (!p.ok) return p;
  return ok({ regionId: regionId.valeur, depuis: p.valeur.depuis, jusqua: p.valeur.jusqua });
}

export interface FiltresProduits {
  source?: string[]; nature?: (typeof NATURES)[number][]; depuis?: Date; jusqua?: Date; bbox?: Bbox; curseur?: Curseur; limite: number;
}

export function lireFiltresProduits(q: Brut, maintenant: Date): Entree<FiltresProduits> {
  const inconnu = parametresInconnus(q, ["source", "nature", "depuis", "jusqua", "bbox", "curseur", "limite"]);
  if (inconnu) return ko(inconnu);
  const source = codesSource(q); if (!source.ok) return source;
  const nature = lireListe(q, "nature", NATURES); if (!nature.ok) return nature;
  const p = periode(q, bornesFiltre(maintenant)); if (!p.ok) return p;
  let bbox: Bbox | undefined;
  if (q.bbox !== undefined) { const b = lireBbox(q.bbox, 20); if (!b.ok) return b; bbox = b.valeur; }
  const curseur = lireCurseur(q, maintenant); if (!curseur.ok) return curseur;
  const lim = limite(q, LIMITE_DEFAUT, LIMITE_MAX); if (!lim.ok) return lim;
  return ok({ source: source.valeur, nature: nature.valeur, depuis: p.valeur.depuis, jusqua: p.valeur.jusqua, bbox, curseur: curseur.valeur, limite: lim.valeur });
}

/** `like` : texte litteral protege (%, _ et \ n'ont plus de sens de motif). */
export const echapperLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// ============================================================ geometrie hostile

const TYPES_GEOMETRIE_DEPOT = ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"] as const;
const POSITIONS_MAX = 20_000;
const SOMMETS_ANNEAU_AUTO_INTERSECTION_MAX = 5000;

type Position = [number, number];

function position(p: unknown): Position | null {
  if (!Array.isArray(p) || p.length !== 2) return null; // une altitude est refusee : la colonne est en 2D
  const [x, y] = p;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < -180 || x > 180 || y < -90 || y > 90) return null;
  return [x, y];
}

function orient(a: Position, b: Position, c: Position): number {
  const v = (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1]);
  return v === 0 ? 0 : v > 0 ? 1 : 2;
}
function sur(a: Position, b: Position, c: Position): boolean {
  return b[0] <= Math.max(a[0], c[0]) && b[0] >= Math.min(a[0], c[0]) && b[1] <= Math.max(a[1], c[1]) && b[1] >= Math.min(a[1], c[1]);
}
/** Les segments [p1,q1] et [p2,q2] se coupent ou se touchent. */
function segmentsSeCoupent(p1: Position, q1: Position, p2: Position, q2: Position): boolean {
  const o1 = orient(p1, q1, p2), o2 = orient(p1, q1, q2), o3 = orient(p2, q2, p1), o4 = orient(p2, q2, q1);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && sur(p1, p2, q1)) || (o2 === 0 && sur(p1, q2, q1)) || (o3 === 0 && sur(p2, p1, q2)) || (o4 === 0 && sur(p2, q1, q2));
}

/** Anneau ferme : au moins 4 positions, ferme, d'aire non nulle, sans auto-intersection (deux aretes non voisines qui se touchent). */
function verifierAnneau(brut: unknown, nom: string): string | null {
  if (!Array.isArray(brut) || brut.length < 4) return `${nom} : au moins 4 positions`;
  if (brut.length > POSITIONS_MAX) return `${nom} : trop de positions`;
  const pts: Position[] = [];
  for (const p of brut) { const x = position(p); if (!x) return `${nom} : position invalide (deux nombres finis, longitude -180 a 180, latitude -90 a 90)`; pts.push(x); }
  const a = pts[0], z = pts[pts.length - 1];
  if (a[0] !== z[0] || a[1] !== z[1]) return `${nom} : anneau non ferme`;
  let aire = 0;
  for (let i = 0; i < pts.length - 1; i++) aire += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
  if (Math.abs(aire / 2) < 1e-14) return `${nom} : anneau d'aire nulle`;
  // au-dela du plafond le controle quadratique est saute (cout) : c'est alors la base (`ST_IsValid`) qui tranche, et son refus devient un 400
  if (pts.length > SOMMETS_ANNEAU_AUTO_INTERSECTION_MAX) return null;
  const n = pts.length - 1; // aretes 0..n-1
  // deux aretes voisines ne partagent que leur sommet : si elles sont colineaires et se recouvrent (pointe repliee), c'est une auto-intersection
  const replie = (a: Position, partage: Position, b: Position) => orient(a, partage, b) === 0 && (sur(partage, a, b) || sur(partage, b, a));
  for (let i = 0; i < n; i++) {
    if (replie(pts[i], pts[i + 1], pts[((i + 1) % n) + 1])) return `${nom} : polygone auto-intersecte`;
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // voisines par le sommet de fermeture
      if (segmentsSeCoupent(pts[i], pts[i + 1], pts[j], pts[j + 1])) return `${nom} : polygone auto-intersecte`;
    }
  }
  return null;
}

function verifierPolygone(rings: unknown, nom: string): string | null {
  if (!Array.isArray(rings) || rings.length === 0 || rings.length > 100) return `${nom} : de 1 a 100 anneaux`;
  for (let i = 0; i < rings.length; i++) {
    const e = verifierAnneau(rings[i], i === 0 ? `${nom} anneau exterieur` : `${nom} trou ${i}`);
    if (e) return e;
  }
  return null;
}

/**
 * Geometrie GeoJSON deposee par un traitement (detection). Refuse, avec une phrase : un type inconnu, des `coordinates`
 * absentes ou en texte, une position hors du globe ou en 3D, un anneau ouvert, nul ou auto-intersecte. Les croisements
 * entre anneaux d'un meme polygone restent juges par la base (`ST_IsValid`), dont le refus est traduit en 400.
 */
export function verifierGeometrieDepot(g: unknown): Entree<null> {
  if (!g || typeof g !== "object" || Array.isArray(g)) return ko("geometrie : un objet GeoJSON est attendu");
  const { type, coordinates } = g as { type?: unknown; coordinates?: unknown };
  if (typeof type !== "string" || !(TYPES_GEOMETRIE_DEPOT as readonly string[]).includes(type)) return ko(`geometrie.type : ${TYPES_GEOMETRIE_DEPOT.join(", ")}`);
  if (!Array.isArray(coordinates)) return ko("geometrie.coordinates : un tableau de coordonnees est attendu");
  let erreur: string | null = null;
  const lignes = (c: unknown, nom: string): string | null => {
    if (!Array.isArray(c) || c.length < 2 || c.length > POSITIONS_MAX) return `${nom} : au moins 2 positions`;
    const pts = c.map(position);
    if (pts.some((p) => p === null)) return `${nom} : position invalide (deux nombres finis, longitude -180 a 180, latitude -90 a 90)`;
    return (pts as Position[]).every((p) => p[0] === pts[0]![0] && p[1] === pts[0]![1]) ? `${nom} : toutes les positions sont identiques` : null;
  };
  switch (type) {
    case "Point": erreur = position(coordinates) ? null : "geometrie.coordinates : une position [longitude, latitude] est attendue"; break;
    case "MultiPoint":
      erreur = coordinates.length === 0 || coordinates.length > POSITIONS_MAX || coordinates.some((p) => !position(p)) ? "geometrie.coordinates : de 1 a 20000 positions valides" : null; break;
    case "LineString": erreur = lignes(coordinates, "geometrie"); break;
    case "MultiLineString":
      erreur = coordinates.length === 0 || coordinates.length > 1000 ? "geometrie : de 1 a 1000 lignes" : (coordinates.map((l, i) => lignes(l, `geometrie ligne ${i + 1}`)).find((e) => e) ?? null); break;
    case "Polygon": erreur = verifierPolygone(coordinates, "geometrie"); break;
    case "MultiPolygon":
      erreur = coordinates.length === 0 || coordinates.length > 1000 ? "geometrie : de 1 a 1000 polygones" : (coordinates.map((p, i) => verifierPolygone(p, `geometrie polygone ${i + 1}`)).find((e) => e) ?? null); break;
  }
  return erreur ? ko(erreur) : ok(null);
}

/** Emprise d'un produit : Polygon dans le globe (noyau d'EO-SOURCES), sans auto-intersection. Rend le polygone propre. */
export function verifierEmpriseProduit(g: unknown): Entree<PolygoneGeoJson> {
  const v = validerPolygone(g);
  if (!v.ok) return ko(`emprise : ${v.raison}`);
  for (let i = 0; i < v.polygone.coordinates.length; i++) {
    const e = verifierAnneau(v.polygone.coordinates[i], i === 0 ? "emprise anneau exterieur" : `emprise trou ${i}`);
    if (e) return ko(e);
  }
  return ok(v.polygone);
}

// ============================================================ synchronisation du catalogue

export interface DemandeSynchro { bbox: Bbox; depuis: Date; jusqua: Date; nuagesMax: number }

/** Bornes de surface, de fenetre et de nuages d'une synchronisation : le catalogue est un service public partage, on le menage. */
export function verifierDemandeSynchro(
  d: { bbox: unknown; depuis: unknown; jusqua: unknown; nuagesMax: unknown }, maintenant: Date,
): Entree<DemandeSynchro> {
  const bbox = lireBbox(typeof d.bbox === "string" ? d.bbox : Array.isArray(d.bbox) ? d.bbox.join(",") : undefined, SYNCHRO_BBOX_COTE_MAX_DEG);
  if (!bbox.ok) return bbox;
  const depuis = lireDateIso(d.depuis, "depuis", bornesCatalogue(maintenant)); if (!depuis.ok) return depuis;
  const jusqua = lireDateIso(d.jusqua, "jusqua", bornesCatalogue(maintenant)); if (!jusqua.ok) return jusqua;
  if (!(depuis.valeur < jusqua.valeur)) return ko("depuis doit preceder strictement jusqua");
  if (jusqua.valeur.getTime() - depuis.valeur.getTime() > SYNCHRO_FENETRE_MAX_JOURS * JOURS_MS) return ko(`fenetre trop longue (${SYNCHRO_FENETRE_MAX_JOURS} jours au plus)`);
  if (typeof d.nuagesMax !== "number" || !Number.isFinite(d.nuagesMax) || d.nuagesMax < 0 || d.nuagesMax > 100) return ko("nuagesMax : un pourcentage de 0 a 100");
  return ok({ bbox: bbox.valeur, depuis: depuis.valeur, jusqua: jusqua.valeur, nuagesMax: d.nuagesMax });
}

export { polygoneDeBbox };

// ============================================================ mise en forme des reponses

export interface LignePropositionBase {
  id: string; type: string; statut: string; prioriteNiveau: string | null; prioriteRegle: string | null;
  confianceDetection: number | null; confianceCalibree: boolean | null;
  imageCouvertureNuagesPct: number | null; imageNote: string | null;
  rattachementConfiance: string | null; rattachementAlgorithme: string | null; distanceTronconM: number | null;
  methode: string; methodeNom: string | null; methodeVersion: string | null;
  missionId: string | null; synthetique: boolean; regionId: number | null;
  produitId: string; dateObservation: Date | string; dateReference: Date | string | null;
  sourceCode: string | null; sourceLibelle: string; produitCapteur: string | null; resolutionM: number | null; resolutionNativeM: number | null;
  fournisseur: string | null; identifiantFournisseur: string | null; collection: string | null; cycleVie: string | null; produitSynthetique: boolean;
  sourceNom: string | null; sourceCapteur: string | null; sourceResolutionM: number | null;
  tronconId: string | null; tronconCode: string | null; tronconNom: string | null; regionNom: string | null;
  lat: number | null; lon: number | null;
}

const iso = (d: Date | string | null | undefined): string | null => (d === null || d === undefined ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString());
const nombre = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export const SIGNIFICATION_INDICE_NON_CALIBRE =
  "Indice rendu par la methode de detection, non calibre : ce n'est pas une probabilite que la detection soit exacte.";
export const SIGNIFICATION_INDICE_ABSENT = "Aucun indice de detection n'a ete renseigne par la methode.";
export const REGLE_PRIORITE_ABSENTE = "Priorite non evaluee : aucune regle n'a ete appliquee a cette proposition.";

/** Une apercu est TENTABLE si le produit se retrouve chez son fournisseur et n'est pas synthetique ; l'existence reelle de la vignette n'est connue qu'a la requete. */
export function apercuTentable(l: Pick<LignePropositionBase, "identifiantFournisseur" | "collection" | "produitSynthetique" | "sourceCode">): boolean {
  return !!l.identifiantFournisseur && !!l.collection && !!l.sourceCode && !l.produitSynthetique;
}

export const urlApercuProduit = (produitId: string): string => `/api/v2/teledetection/produits/${produitId}/apercu`;

export function formerProposition(l: LignePropositionBase) {
  const calibree = l.confianceCalibree === true;
  return {
    id: l.id,
    type: l.type,
    statut: l.statut,
    priorite: { niveau: l.prioriteNiveau, regle: l.prioriteNiveau ? (l.prioriteRegle ?? REGLE_PRIORITE_ABSENTE) : REGLE_PRIORITE_ABSENTE },
    confianceDetection: {
      valeur: nombre(l.confianceDetection), calibree,
      signification: l.confianceDetection === null ? SIGNIFICATION_INDICE_ABSENT : calibree ? "Probabilite calibree." : SIGNIFICATION_INDICE_NON_CALIBRE,
    },
    qualiteImage: { couvertureNuagesPct: nombre(l.imageCouvertureNuagesPct), note: l.imageNote },
    // `confiance` nulle = non evalue (ligne d'avant la migration du workflow) : on ne fabrique ni « faible » ni « aucun ».
    rattachement: {
      confiance: l.rattachementConfiance ?? (l.tronconId ? null : "AUCUN"),
      distanceM: nombre(l.distanceTronconM),
      algorithme: l.rattachementAlgorithme ?? "NON_EVALUE",
    },
    methode: { nom: l.methodeNom ?? l.methode, version: l.methodeVersion },
    // Les replis sont ETIQUETES : la resolution du produit livre n'est pas la resolution native du capteur, et le capteur de la ligne de
    // source n'est pas celui du produit. Une valeur de repli n'est jamais presentee comme la valeur d'origine.
    source: {
      code: l.sourceCode ?? l.sourceLibelle, nom: l.sourceNom ?? l.sourceLibelle,
      capteur: l.produitCapteur ?? l.sourceCapteur,
      capteurOrigine: l.produitCapteur !== null ? "PRODUIT" : l.sourceCapteur !== null ? "SOURCE" : null,
      resolutionM: nombre(l.resolutionNativeM ?? l.resolutionM),
      resolutionOrigine: l.resolutionNativeM !== null ? "NATIVE_PRODUIT" : l.resolutionM !== null ? "PRODUIT_LIVRE" : null,
    },
    dateObservation: iso(l.dateObservation),
    dateReference: iso(l.dateReference),
    troncon: l.tronconId ? { id: l.tronconId, code: l.tronconCode, nom: l.tronconNom, regionId: l.regionId, regionNom: l.regionNom } : null,
    rattachee: l.tronconId !== null,
    centre: l.lat !== null && l.lon !== null ? { lat: Number(l.lat), lon: Number(l.lon) } : null,
    apercuDisponible: apercuTentable(l),
    synthetique: l.synthetique,
    missionId: l.missionId,
  };
}

export type PropositionListee = ReturnType<typeof formerProposition>;

export interface LigneProduitRef {
  id: string; code: string; sourceCode: string | null; source: string; fournisseur: string | null; identifiantFournisseur: string | null;
  collection: string | null; capteur: string | null; nature: string; niveauTraitement: string | null; dateAcquisition: Date | string;
  resolutionM: number; resolutionNativeM: number | null; couvertureNuagesPct: number | null; cycleVie: string; scene: string | null; synthetique: boolean;
}

export function formerProduitRef(p: LigneProduitRef | null) {
  if (!p) return null;
  return {
    id: p.id, code: p.code, sourceCode: p.sourceCode, source: p.source, fournisseur: p.fournisseur, identifiantFournisseur: p.identifiantFournisseur,
    collection: p.collection, capteur: p.capteur, nature: p.nature, niveauTraitement: p.niveauTraitement, scene: p.scene,
    dateAcquisition: iso(p.dateAcquisition), resolutionM: nombre(p.resolutionM), resolutionNativeM: nombre(p.resolutionNativeM),
    couvertureNuagesPct: nombre(p.couvertureNuagesPct), cycleVie: p.cycleVie, synthetique: p.synthetique,
  };
}

/** Apercu d'un produit dans le detail : l'URL est celle du SERVEUR (jamais celle du fournisseur) ; nulle si aucune tentative n'est possible. */
export function formerApercu(p: LigneProduitRef | null, dateFallback: Date | string | null) {
  if (!p) return { url: null, date: iso(dateFallback) };
  const tentable = !!p.identifiantFournisseur && !!p.collection && !!p.sourceCode && !p.synthetique;
  return { url: tentable ? urlApercuProduit(p.id) : null, date: iso(p.dateAcquisition) };
}

export function resumeObservation(type: string | null, description: string | null): string | null {
  const d = description?.trim() ? description.trim().slice(0, 200) : null;
  if (type && d) return `${type} : ${d}`;
  return type ?? d;
}

export function formerSource(l: {
  code: string; nom: string; fournisseur: string; capteur: string | null; resolutionM: number | null; etat: string;
  derniereVerificationLe: Date | string | null; derniereAcquisitionLe: Date | string | null; dernierMessage: string | null; requiertIdentifiants: boolean;
}, adaptateur: string | null) {
  return {
    code: l.code, nom: l.nom, fournisseur: l.fournisseur, capteur: l.capteur, resolutionM: nombre(l.resolutionM), etat: l.etat,
    derniereVerification: iso(l.derniereVerificationLe), derniereAcquisition: iso(l.derniereAcquisitionLe), message: l.dernierMessage,
    requiertIdentifiants: l.requiertIdentifiants,
    // additions au contrat : l'adaptateur de catalogue relie a la source (null = aucun), et « active » = TRAITEMENT_OPERATIONNEL seulement
    adaptateur, active: l.etat === "TRAITEMENT_OPERATIONNEL",
  };
}
