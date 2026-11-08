/**
 * LECTURE DES PARAMETRES DE REQUETE DES INTERVENTIONS PRIORISEES (module d'aide a la decision, lot 3).
 * PUR : aucune base, aucune horloge (la date « maintenant » est un parametre), aucun import hors types.
 *
 * Chaque entree est ou BIEN FORMEE ou REFUSEE avec une phrase (400) ; jamais ignoree en silence, jamais une erreur
 * serveur. Meme discipline que `teledetection/api.noyau.ts` (observation de la Terre), dont les bornes de l'emprise
 * sont reprises : 10 degres de cote, plafond de 300 elements par defaut. Ces bornes sont PROVISOIRES et reversibles.
 *
 * Les filtres sont ceux de `FiltresDecision` (CONTRAT-AD.md, paragraphe 3) que les donnees des interventions supportent.
 * `statutChantier` est ACCEPTE mais NON APPLIQUE, et la reponse le dit (`filtresNonAppliques`) : l'ecran serialise les
 * memes filtres pour tous les onglets, et un refus 400 le casserait ; l'ignorer en silence ferait croire qu'il filtre.
 */

export type Entree<T> = { ok: true; valeur: T } | { ok: false; message: string };
const ok = <T>(valeur: T): Entree<T> => ({ ok: true, valeur });
const ko = (message: string): { ok: false; message: string } => ({ ok: false, message });

export const LIMITE_DEFAUT = 25;
export const LIMITE_MAX = 100;
export const BBOX_COTE_MAX_DEG = 10;
export const GEOJSON_PLAFOND_DEFAUT = 300;
export const GEOJSON_PLAFOND_MAX = 1000;
export const DATE_MIN_FILTRE = Date.UTC(2000, 0, 1);

export const CLASSES = ["RN", "RR", "RU", "PISTE", "NON_CLASSEE"] as const;
export const ETATS = ["BON", "MOYEN", "MAUVAIS", "CRITIQUE", "NON_EVALUE"] as const;
export const STATUTS_SCORE = ["CALCULE", "INCOMPLET", "EXCLU"] as const;

const REGEX_IDENTIFIANT = /^[A-Za-z0-9_-]{1,64}$/;
export const estIdentifiant = (v: unknown): v is string => typeof v === "string" && REGEX_IDENTIFIANT.test(v);

type Brut = Record<string, unknown>;

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

/** Liste d'une enumeration : `a`, `a,b`, `a&a=b` ou `a[]=a` ; chaque valeur est connue, sinon refus. */
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

/** Liste libre de codes (statutChantier) : de 1 a 10 mots en majuscules, jamais interpretes. */
function listeLibre(q: Brut, nom: string): Entree<string[] | undefined> {
  const v = q[nom];
  if (v === undefined) return ok(undefined);
  const morceaux = (Array.isArray(v) ? v : [v]).flatMap((m) => (typeof m === "string" ? m.split(",") : [null]));
  if (morceaux.length === 0 || morceaux.length > 10 || morceaux.some((m) => typeof m !== "string" || !/^[A-Za-z0-9_]{1,40}$/.test(m.trim()))) {
    return ko(`${nom} : de 1 a 10 codes (lettres, chiffres, _)`);
  }
  return ok([...new Set(morceaux.map((m) => (m as string).trim()))]);
}

function entier(q: Brut, nom: string, min: number, max: number): Entree<number | undefined> {
  const t = unique(q, nom);
  if (!t.ok || t.valeur === undefined) return t as Entree<undefined>;
  if (!/^-?\d{1,9}$/.test(t.valeur)) return ko(`${nom} : un entier est attendu`);
  const n = Number(t.valeur);
  return n < min || n > max ? ko(`${nom} : de ${min} a ${max}`) : ok(n);
}

function identifiant(q: Brut, nom: string): Entree<string | undefined> {
  const t = unique(q, nom);
  if (!t.ok || t.valeur === undefined) return t;
  return estIdentifiant(t.valeur) ? t : ko(`${nom} : identifiant invalide (lettres, chiffres, _ et -, 64 au plus)`);
}

const REGEX_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Date AAAA-MM-JJ qui existe, de 2000 a l'annee courante + 1. */
function lireDate(texte: string, nom: string, maintenant: Date): Entree<string> {
  const j = REGEX_DATE.exec(texte);
  if (!j) return ko(`${nom} : une date AAAA-MM-JJ est attendue`);
  const d = new Date(Date.UTC(Number(j[1]), Number(j[2]) - 1, Number(j[3])));
  if (d.getUTCFullYear() !== Number(j[1]) || d.getUTCMonth() !== Number(j[2]) - 1 || d.getUTCDate() !== Number(j[3])) return ko(`${nom} : jour inexistant (${texte})`);
  if (d.getTime() < DATE_MIN_FILTRE || d.getUTCFullYear() > maintenant.getUTCFullYear() + 1) return ko(`${nom} : date hors des bornes admises (2000 a l'annee courante + 1)`);
  return ok(texte);
}

// ------------------------------------------------------------ curseur

export interface CurseurInterventions { v: string; g: 0 | 1; s: number; c: string; i: string }

export function encoderCurseur(c: CurseurInterventions): string {
  return Buffer.from(JSON.stringify({ v: c.v, g: c.g, s: c.s, c: c.c, i: c.i }), "utf8").toString("base64url");
}

/**
 * Un curseur est un jeton EMIS par l'API, mais le client le renvoie : il est relu strictement (caracteres, taille, cles,
 * types, bornes). Il porte la version des parametres : un curseur d'un autre classement est refuse, pas reinterprete.
 */
export function decoderCurseur(brut: string): Entree<CurseurInterventions> {
  if (brut.length > 600 || !/^[A-Za-z0-9_-]+$/.test(brut)) return ko("curseur : valeur illisible");
  let o: unknown;
  try { o = JSON.parse(Buffer.from(brut, "base64url").toString("utf8")); } catch { return ko("curseur : valeur illisible"); }
  if (!o || typeof o !== "object" || Array.isArray(o)) return ko("curseur : valeur illisible");
  const { v, g, s, c, i, ...reste } = o as Record<string, unknown>;
  if (Object.keys(reste).length > 0) return ko("curseur : valeur illisible");
  if (typeof v !== "string" || !estIdentifiant(v)) return ko("curseur : valeur illisible");
  if (g !== 0 && g !== 1) return ko("curseur : valeur illisible");
  if (typeof s !== "number" || !Number.isInteger(s) || Math.abs(s) > 10_000_000) return ko("curseur : valeur illisible");
  if (typeof c !== "string" || c.length === 0 || c.length > 200 || typeof i !== "string" || !estIdentifiant(i)) return ko("curseur : valeur illisible");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(c)) return ko("curseur : valeur illisible");
  return ok({ v, g, s, c, i });
}

// ------------------------------------------------------------ bbox

export type Bbox = [number, number, number, number];

/** `ouest,sud,est,nord` en degres decimaux, dans le globe, non degenere, de cote borne. */
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

// ------------------------------------------------------------ filtres

/** Filtres qui RESTREIGNENT les candidats AVANT le classement : le rang est celui de la selection. */
export interface FiltresSelection {
  regionId?: number;
  classe?: (typeof CLASSES)[number][];
  etat?: (typeof ETATS)[number][];
  /** Date du dernier constat (AAAA-MM-JJ) : bornes incluses. Une intervention sans constat date n'a pas de date : elle est ecartee. */
  depuis?: string;
  jusqua?: string;
  /** Code de la version de parametres demandee ; absent = la regle du moteur (version approuvee la plus recente). */
  parametresId?: string;
  /** Accepte, non applique (aucune donnee) : renvoye dans `filtresNonAppliques`. */
  statutChantier?: string[];
}

export interface FiltresListe extends FiltresSelection {
  /** Filtre d'AFFICHAGE apres classement : les rangs ne changent pas. */
  statutScore?: (typeof STATUTS_SCORE)[number][];
  curseur?: CurseurInterventions;
  limite: number;
}

export interface FiltresGeo extends FiltresSelection { bbox: Bbox; limite: number }

const PARAMS_SELECTION = ["regionId", "classe", "etat", "depuis", "jusqua", "parametresId", "statutChantier"] as const;
export const PARAMS_LISTE = [...PARAMS_SELECTION, "statutScore", "curseur", "limite"] as const;
export const PARAMS_GEO = [...PARAMS_SELECTION, "bbox", "limite"] as const;

function lireSelection(q: Brut, maintenant: Date): Entree<FiltresSelection> {
  const regionId = entier(q, "regionId", 1, 1_000_000); if (!regionId.ok) return regionId;
  const classe = lireListe(q, "classe", CLASSES); if (!classe.ok) return classe;
  const etat = lireListe(q, "etat", ETATS); if (!etat.ok) return etat;
  const parametresId = identifiant(q, "parametresId"); if (!parametresId.ok) return parametresId;
  const statutChantier = listeLibre(q, "statutChantier"); if (!statutChantier.ok) return statutChantier;
  const brutDepuis = unique(q, "depuis"); if (!brutDepuis.ok) return brutDepuis;
  const brutJusqua = unique(q, "jusqua"); if (!brutJusqua.ok) return brutJusqua;
  let depuis: string | undefined;
  let jusqua: string | undefined;
  if (brutDepuis.valeur !== undefined) { const d = lireDate(brutDepuis.valeur, "depuis", maintenant); if (!d.ok) return d; depuis = d.valeur; }
  if (brutJusqua.valeur !== undefined) { const d = lireDate(brutJusqua.valeur, "jusqua", maintenant); if (!d.ok) return d; jusqua = d.valeur; }
  if (depuis && jusqua && depuis > jusqua) return ko("depuis doit preceder jusqua");
  return ok({ regionId: regionId.valeur, classe: classe.valeur, etat: etat.valeur, depuis, jusqua, parametresId: parametresId.valeur, statutChantier: statutChantier.valeur });
}

export function lireFiltresListe(q: Brut, maintenant: Date): Entree<FiltresListe> {
  const inconnu = parametresInconnus(q, PARAMS_LISTE);
  if (inconnu) return ko(inconnu);
  const sel = lireSelection(q, maintenant); if (!sel.ok) return sel;
  const statutScore = lireListe(q, "statutScore", STATUTS_SCORE); if (!statutScore.ok) return statutScore;
  const brutCurseur = unique(q, "curseur"); if (!brutCurseur.ok) return brutCurseur;
  let curseur: CurseurInterventions | undefined;
  if (brutCurseur.valeur !== undefined) { const c = decoderCurseur(brutCurseur.valeur); if (!c.ok) return c; curseur = c.valeur; }
  const lim = entier(q, "limite", 1, LIMITE_MAX); if (!lim.ok) return lim;
  return ok({ ...sel.valeur, statutScore: statutScore.valeur, curseur, limite: lim.valeur ?? LIMITE_DEFAUT });
}

export function lireFiltresGeo(q: Brut, maintenant: Date): Entree<FiltresGeo> {
  const inconnu = parametresInconnus(q, PARAMS_GEO);
  if (inconnu) return ko(inconnu);
  const bbox = lireBbox(q.bbox, BBOX_COTE_MAX_DEG); if (!bbox.ok) return bbox;
  const sel = lireSelection(q, maintenant); if (!sel.ok) return sel;
  const lim = entier(q, "limite", 1, GEOJSON_PLAFOND_MAX); if (!lim.ok) return lim;
  return ok({ ...sel.valeur, bbox: bbox.valeur, limite: lim.valeur ?? GEOJSON_PLAFOND_DEFAUT });
}

/** Le detail n'accepte que le choix de la version de parametres. */
export function lireFiltresDetail(q: Brut): Entree<{ parametresId?: string }> {
  const inconnu = parametresInconnus(q, ["parametresId"]);
  if (inconnu) return ko(inconnu);
  const p = identifiant(q, "parametresId"); if (!p.ok) return p;
  return ok({ parametresId: p.valeur });
}
