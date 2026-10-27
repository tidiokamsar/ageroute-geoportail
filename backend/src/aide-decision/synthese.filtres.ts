/**
 * Filtres partages de l'Aide a la decision (contrat AD, paragraphe 3) : lecture STRICTE de la requete.
 *
 * Une requete hostile (cle inconnue, tableau d'objets `classe[a]=b`, valeur hors nomenclature, date impossible,
 * entier hors borne, chaine demesuree) rend un refus lisible, jamais une exception : la route repond 400
 * `{ error, code: "FILTRE_INVALIDE", details }`.
 *
 * Deux filtres sont APPLIQUES a la synthese : `regionId` et `classe` (ils ont un sens exact sur les troncons).
 * Les autres sont valides syntaxiquement puis rendus comme NON APPLIQUES avec leur raison : le frontend serialise les
 * memes filtres pour tous les endpoints, un refus ici casserait le panneau d'indicateurs. Jamais ignores en silence.
 */
import { z } from "zod";
import { ClasseRoute, EtatPatrimoine, StatutChantier } from "@prisma/client";

export interface FiltresSynthese {
  regionId?: number;
  classe?: string[];
  etat?: string[];
  statutChantier?: string[];
  depuis?: string;
  jusqua?: string;
}

const MAX_TEXTE = 200;
const MAX_ELEMENTS = 10;

/** `a,b` ou `a&a=b` : les deux formes sont lues ; une valeur vide ou hors nomenclature est refusee. */
function liste(nom: string, autorisees: readonly string[]) {
  return z.union([z.string().max(MAX_TEXTE), z.array(z.string().max(MAX_TEXTE)).max(MAX_ELEMENTS)]).optional().transform((v, ctx) => {
    if (v === undefined) return undefined;
    const brut = (Array.isArray(v) ? v : [v]).flatMap((s) => s.split(",")).map((s) => s.trim());
    if (brut.length === 0 || brut.some((s) => s === "")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${nom} : valeur vide` });
      return z.NEVER;
    }
    const inconnues = brut.filter((s) => !autorisees.includes(s));
    if (inconnues.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${nom} : valeur inconnue (${inconnues.slice(0, 3).join(", ")}) ; attendu : ${autorisees.join(", ")}` });
      return z.NEVER;
    }
    return [...new Set(brut)];
  });
}

/** AAAA-MM-JJ, date de calendrier reelle, annee 2000 a 2100. */
const jour = (nom: string) => z.string().max(MAX_TEXTE).optional().transform((v, ctx) => {
  if (v === undefined) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) {
    const [a, mo, j] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const d = new Date(Date.UTC(a, mo - 1, j));
    if (a >= 2000 && a <= 2100 && d.getUTCFullYear() === a && d.getUTCMonth() === mo - 1 && d.getUTCDate() === j) return v;
  }
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${nom} : date AAAA-MM-JJ valide attendue` });
  return z.NEVER;
});

const schema = z.object({
  regionId: z.string().max(MAX_TEXTE).regex(/^[0-9]{1,9}$/, "regionId : entier positif attendu").transform(Number)
    .refine((n) => n > 0, "regionId : entier positif attendu").optional(),
  classe: liste("classe", Object.values(ClasseRoute)),
  etat: liste("etat", Object.values(EtatPatrimoine)),
  statutChantier: liste("statutChantier", Object.values(StatutChantier)),
  depuis: jour("depuis"),
  jusqua: jour("jusqua"),
}).strict().superRefine((f, ctx) => {
  if (f.depuis !== undefined && f.jusqua !== undefined && f.depuis > f.jusqua) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "depuis doit etre anterieur ou egal a jusqua" });
  }
});

export type LectureFiltres = { ok: true; filtres: FiltresSynthese } | { ok: false; details: { champ: string; message: string }[] };

export function lireFiltres(query: unknown): LectureFiltres {
  const r = schema.safeParse(query ?? {});
  if (!r.success) {
    return { ok: false, details: r.error.issues.slice(0, 10).map((i) => ({ champ: i.path.join(".") || "(requete)", message: i.message.slice(0, 200) })) };
  }
  const f: FiltresSynthese = {};
  if (r.data.regionId !== undefined) f.regionId = r.data.regionId;
  if (r.data.classe !== undefined) f.classe = r.data.classe;
  if (r.data.etat !== undefined) f.etat = r.data.etat;
  if (r.data.statutChantier !== undefined) f.statutChantier = r.data.statutChantier;
  if (r.data.depuis !== undefined) f.depuis = r.data.depuis;
  if (r.data.jusqua !== undefined) f.jusqua = r.data.jusqua;
  return { ok: true, filtres: f };
}

export interface FiltreNonApplique { nom: string; raison: string }

/** Les filtres valides que la synthese n'applique pas, avec la raison (affichee, jamais ignoree en silence). */
export function filtresNonAppliques(f: FiltresSynthese): FiltreNonApplique[] {
  const a: FiltreNonApplique[] = [];
  if (f.etat) a.push({ nom: "etat", raison: "Non appliqué : les indicateurs d'état portent sur toutes les classes d'état (le taux de dégradation se calcule contre l'ensemble des états valides)." });
  if (f.statutChantier) a.push({ nom: "statutChantier", raison: "Non appliqué : chaque indicateur de chantier porte son propre statut (en cours, en retard)." });
  if (f.depuis || f.jusqua) a.push({ nom: "periode", raison: "Non appliqué : les indicateurs sont des instantanés calculés à la date de la requête, sans historique d'état dans la base." });
  return a;
}
