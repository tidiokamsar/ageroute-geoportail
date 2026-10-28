/**
 * Lecture et validation de la requete de `GET /api/v2/aide-decision/contractuel` : filtres du contrat (§3) plus le statut de
 * marche, limite et curseur. Module PUR (zod seul).
 *
 * UNE ENTREE HOSTILE EST UN 400, jamais une valeur ignoree en silence : un identifiant de region mal forme, une date
 * impossible, une liste d'enumerations inconnues, un parametre repete ou imbrique (`classe[a]=b`), un curseur forge. Les
 * cles INCONNUES sont ignorees (les autres onglets du module partagent la serialisation des filtres, contrat §3).
 */
import { z } from "zod";
import { STATUTS_MARCHE, type FiltresContractuel, type StatutMarche } from "./contractuel.noyau";

export const CLASSES_ROUTE = ["RN", "RR", "RU", "PISTE", "NON_CLASSEE"] as const;
export const ETATS_PATRIMOINE = ["BON", "MOYEN", "MAUVAIS", "CRITIQUE", "NON_EVALUE"] as const;
export const STATUTS_CHANTIER = ["PLANIFIE", "EN_COURS", "SUSPENDU", "TERMINE"] as const;

export const LIMITE_DEFAUT = 25;
export const LIMITE_MAX = 100;
const MAX_VALEURS_PAR_LISTE = 10;
const ENTIER_SQL_MAX = 2_147_483_647;

function liste<T extends string>(nom: string, admises: readonly T[]) {
  return z.union([z.string(), z.array(z.string())]).optional().transform((v, ctx): T[] | undefined => {
    if (v === undefined) return undefined;
    const morceaux = (Array.isArray(v) ? v : [v]).flatMap((x) => x.split(",")).map((x) => x.trim()).filter((x) => x !== "");
    if (morceaux.length === 0) return undefined;
    if (morceaux.length > MAX_VALEURS_PAR_LISTE) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${nom} : au plus ${MAX_VALEURS_PAR_LISTE} valeurs` }); return z.NEVER; }
    const inconnues = morceaux.filter((x) => !(admises as readonly string[]).includes(x));
    if (inconnues.length > 0) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${nom} : valeur(s) inconnue(s)` }); return z.NEVER; }
    return [...new Set(morceaux)] as T[];
  });
}

const entierPositif = (nom: string, max = ENTIER_SQL_MAX) =>
  z.string().regex(/^[1-9]\d{0,9}$/, `${nom} : entier positif attendu`).transform((v, ctx) => {
    const n = Number(v);
    if (n > max) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${nom} : trop grand` }); return z.NEVER; }
    return n;
  }).optional();

function dateIso(nom: string) {
  return z.string().regex(/^\d{4}-\d{2}-\d{2}$/, `${nom} : date AAAA-MM-JJ attendue`).refine((v) => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, `${nom} : date inexistante`).optional();
}

const schema = z.object({
  regionId: entierPositif("regionId"),
  classe: liste("classe", CLASSES_ROUTE),
  etat: liste("etat", ETATS_PATRIMOINE),
  statutChantier: liste("statutChantier", STATUTS_CHANTIER),
  statutMarche: liste("statutMarche", STATUTS_MARCHE),
  bailleurId: entierPositif("bailleurId"),
  depuis: dateIso("depuis"),
  jusqua: dateIso("jusqua"),
  limite: entierPositif("limite", LIMITE_MAX),
  curseur: z.string().max(300).regex(/^[A-Za-z0-9_-]+$/, "curseur invalide").optional(),
}).superRefine((q, ctx) => {
  if (q.depuis && q.jusqua && q.depuis > q.jusqua) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "depuis doit preceder jusqua" });
});

export interface CurseurContractuel { c: string; i: string }

export function encoderCurseur(c: CurseurContractuel): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/** null si le curseur n'est pas un curseur que ce module a produit. */
export function decoderCurseur(brut: string): CurseurContractuel | null {
  try {
    const o = JSON.parse(Buffer.from(brut, "base64url").toString("utf8")) as unknown;
    if (typeof o !== "object" || o === null) return null;
    const { c, i } = o as { c?: unknown; i?: unknown };
    if (typeof c !== "string" || typeof i !== "string") return null;
    if (Number.isNaN(new Date(c).getTime()) || new Date(c).toISOString() !== c) return null;
    if (!/^[0-9a-f-]{36}$/i.test(i)) return null;
    return { c, i };
  } catch {
    return null;
  }
}

export interface RequeteContractuel { filtres: FiltresContractuel; limite: number; curseur: CurseurContractuel | null }

export type LectureRequete = { ok: true; requete: RequeteContractuel } | { ok: false; erreurs: string[] };

export function lireRequete(query: unknown): LectureRequete {
  const r = schema.safeParse(query ?? {});
  if (!r.success) return { ok: false, erreurs: r.error.issues.map((i) => i.message) };
  const q = r.data;
  let curseur: CurseurContractuel | null = null;
  if (q.curseur !== undefined) {
    curseur = decoderCurseur(q.curseur);
    if (!curseur) return { ok: false, erreurs: ["curseur invalide"] };
  }
  const filtres: FiltresContractuel = {};
  if (q.regionId !== undefined) filtres.regionId = q.regionId;
  if (q.classe) filtres.classe = q.classe;
  if (q.etat) filtres.etat = q.etat;
  if (q.statutChantier) filtres.statutChantier = q.statutChantier;
  if (q.statutMarche) filtres.statutMarche = q.statutMarche as StatutMarche[];
  if (q.bailleurId !== undefined) filtres.bailleurId = q.bailleurId;
  if (q.depuis) filtres.depuis = q.depuis;
  if (q.jusqua) filtres.jusqua = q.jusqua;
  return { ok: true, requete: { filtres, limite: q.limite ?? LIMITE_DEFAUT, curseur } };
}
