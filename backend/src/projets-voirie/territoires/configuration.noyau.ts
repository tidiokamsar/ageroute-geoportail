/**
 * CONFIGURATION NATIONALE (noyau pur) : cles, defauts codes (identiques aux constantes historiques du socle), schemas zod, resolution
 * environnement > base > defaut, choix du CRS metrique par bandes de longitude. Contrat : docs/projets-voirie/CONTRAT-TERRITOIRES.md, section 6.
 *
 * Les defauts ci-dessous sont les SEULES valeurs geographiques du code : ce sont celles du socle (BBOX_GUINEE, epsgPourLongitude, liste blanche
 * par defaut), conservees pour que le comportement ne change pas tant que rien n'est administre. Tout le reste est donnee.
 */

import { z } from "zod";
import { BBOX_GUINEE, type Bbox } from "../lecture.types";

/** Liste blanche par defaut des CRS source d'import (celle du lot A1 ; `formats/import.config.ts` la reexporte). */
export const CRS_PAR_DEFAUT: readonly number[] = [4326, 32628, 32629];

export const CLES = ["EMPRISE_PLAUSIBILITE", "CRS_METRIQUE_BANDES", "CRS_IMPORT_LISTE_BLANCHE", "PROTECTIONS"] as const;
export type Cle = (typeof CLES)[number];
export const estCle = (v: unknown): v is Cle => typeof v === "string" && (CLES as readonly string[]).includes(v);

export interface Zone { nom: string; bbox: Bbox }
export interface Bande { jusquaLongitude: number; epsg: number }
export interface BandesCrs { bandes: Bande[]; epsgDefaut: number }
export interface ListeBlancheCrs { epsg: number[] }

/** Protections administrables (sous-cles facultatives ; les bornes sont celles de config.ts). */
export const PROTECTIONS_BORNES = {
  analyseIntervalleS: { env: "PROJETS_VOIRIE_ANALYSE_INTERVALLE_S", defaut: 60, min: 0, max: 3_600 },
  conflitsMax: { env: "PROJETS_VOIRIE_CONFLITS_MAX", defaut: 20_000, min: 100, max: 100_000 },
  sommetsParObjet: { env: "PROJETS_VOIRIE_SOMMETS_PAR_OBJET", defaut: 100_000, min: 1_000, max: 1_000_000 },
  sommetsParFichier: { env: "PROJETS_VOIRIE_SOMMETS_PAR_FICHIER", defaut: 2_000_000, min: 10_000, max: 10_000_000 },
  delaiAnalyseMs: { env: "PROJETS_VOIRIE_DELAI_ANALYSE_MS", defaut: 20_000, min: 1_000, max: 300_000 },
  delaiCarteMs: { env: "PROJETS_VOIRIE_DELAI_CARTE_MS", defaut: 10_000, min: 1_000, max: 120_000 },
  delaiDepotMs: { env: "PROJETS_VOIRIE_DELAI_DEPOT_MS", defaut: 60_000, min: 5_000, max: 600_000 },
} as const;
export type Protection = keyof typeof PROTECTIONS_BORNES;
export type Protections = Partial<Record<Protection, number>>;

export const DEFAUTS: { EMPRISE_PLAUSIBILITE: Zone; CRS_METRIQUE_BANDES: BandesCrs; CRS_IMPORT_LISTE_BLANCHE: ListeBlancheCrs; PROTECTIONS: Protections } = {
  EMPRISE_PLAUSIBILITE: { nom: "Guinee", bbox: [...BBOX_GUINEE] as Bbox },
  CRS_METRIQUE_BANDES: { bandes: [{ jusquaLongitude: -12, epsg: 32628 }], epsgDefaut: 32629 },
  CRS_IMPORT_LISTE_BLANCHE: { epsg: [...CRS_PAR_DEFAUT] },
  PROTECTIONS: {},
};
export type ValeurDe<K extends Cle> = (typeof DEFAUTS)[K];

const degre = (max: number) => z.number().finite().min(-max).max(max);
const epsg = z.number().int().min(1024).max(32767);

export const schemaEmprise = z.object({
  nom: z.string().trim().min(1).max(100),
  bbox: z.tuple([degre(180), degre(90), degre(180), degre(90)]),
}).strict().refine((z1) => z1.bbox[0] < z1.bbox[2] && z1.bbox[1] < z1.bbox[3], { message: "ouest < est et sud < nord attendus", path: ["bbox"] });

export const schemaBandes = z.object({
  bandes: z.array(z.object({ jusquaLongitude: degre(180), epsg }).strict()).max(20),
  epsgDefaut: epsg,
}).strict().refine((b) => b.bandes.every((x, i) => i === 0 || b.bandes[i - 1].jusquaLongitude < x.jusquaLongitude), { message: "bandes triees par longitude strictement croissante", path: ["bandes"] });

export const schemaListeBlanche = z.object({
  epsg: z.array(z.number().int().min(1000).max(999_999)).min(1).max(20),
}).strict().refine((l) => l.epsg.includes(4326), { message: "la liste blanche contient toujours 4326 (WGS 84)", path: ["epsg"] })
  .refine((l) => new Set(l.epsg).size === l.epsg.length, { message: "codes en double", path: ["epsg"] });

export const schemaProtections = z.object(
  Object.fromEntries(Object.entries(PROTECTIONS_BORNES).map(([k, b]) => [k, z.number().int().min(b.min).max(b.max).optional()])) as Record<Protection, z.ZodOptional<z.ZodNumber>>,
).strict();

export const SCHEMAS: Record<Cle, z.ZodTypeAny> = {
  EMPRISE_PLAUSIBILITE: schemaEmprise,
  CRS_METRIQUE_BANDES: schemaBandes,
  CRS_IMPORT_LISTE_BLANCHE: schemaListeBlanche,
  PROTECTIONS: schemaProtections,
};

export type VerdictValeur<K extends Cle> = { ok: true; valeur: ValeurDe<K> } | { ok: false; erreurs: Record<string, string[]> };

/** Valide la valeur d'une cle (schema strict). */
export function validerValeur<K extends Cle>(cle: K, brut: unknown): VerdictValeur<K> {
  const r = SCHEMAS[cle].safeParse(brut);
  if (r.success) return { ok: true, valeur: r.data as ValeurDe<K> };
  const erreurs: Record<string, string[]> = {};
  for (const e of r.error.issues) (erreurs[e.path.length ? e.path.join(".") : "valeur"] ??= []).push(e.message);
  return { ok: false, erreurs };
}

/**
 * Lit la valeur d'une cle telle que stockee en base : une valeur illisible (schema change, ligne corrompue) redonne le DEFAUT, jamais une
 * erreur a l'utilisateur : un mauvais reglage ne peut pas rendre le module inutilisable.
 */
export function lireValeurBase<K extends Cle>(cle: K, brut: unknown): { valeur: ValeurDe<K>; valide: boolean } {
  const v = validerValeur(cle, brut);
  return v.ok ? { valeur: v.valeur, valide: true } : { valeur: DEFAUTS[cle], valide: false };
}

export type Source = "ENV" | "BASE" | "DEFAUT";
export interface Resolution<T> { valeur: T; source: Source }

/**
 * RESOLUTION d'une valeur : variable d'environnement definie et valide > valeur en base > defaut. `env` est deja interprete par l'appelant
 * (`undefined` = absente ou invalide), `base` est `undefined` quand la base ne porte rien pour cette (sous-)cle.
 */
export function resoudre<T>(env: T | undefined, base: T | undefined, defaut: T): Resolution<T> {
  if (env !== undefined) return { valeur: env, source: "ENV" };
  if (base !== undefined) return { valeur: base, source: "BASE" };
  return { valeur: defaut, source: "DEFAUT" };
}

/** Entier borne lu dans l'environnement : `undefined` si absent, illisible ou hors bornes (meme regle que `borne` de config.ts). */
export function entierEnv(brut: string | undefined, min: number, max: number): number | undefined {
  if (brut === undefined || brut.trim() === "") return undefined;
  const v = Number(brut);
  return Number.isInteger(v) && v >= min && v <= max ? v : undefined;
}

/** Liste de CRS lue dans l'environnement (meme regle que `crsSourceAutorises` : une entree illisible invalide toute la liste). */
export function listeCrsEnv(brut: string | undefined): number[] | undefined {
  if (brut === undefined || brut.trim() === "") return undefined;
  const morceaux = brut.split(",").map((s) => s.trim());
  if (morceaux.length > 20 || morceaux.some((s) => !/^[1-9]\d{3,5}$/.test(s))) return undefined;
  return [...new Set(morceaux.map(Number))];
}

/**
 * CHOIX DU CRS METRIQUE PAR BANDES : la premiere bande (triees croissantes) dont `longitude < jusquaLongitude` donne son EPSG, sinon le
 * defaut. Avec les defauts : longitude < -12 => 32628, sinon 32629 (la regle historique `epsgPourLongitude`).
 */
export function epsgPourLongitudeSelon(regle: BandesCrs, longitude: number): number {
  if (!Number.isFinite(longitude)) return regle.epsgDefaut;
  for (const b of regle.bandes) if (longitude < b.jusquaLongitude) return b.epsg;
  return regle.epsgDefaut;
}

/** Les EPSG d'une regle de bandes doivent etre metriques (jamais 4326) et dans la liste blanche. */
export function epsgHorsListe(regle: BandesCrs, listeBlanche: readonly number[]): number[] {
  const tous = [...regle.bandes.map((b) => b.epsg), regle.epsgDefaut];
  return [...new Set(tous.filter((e) => e === 4326 || !listeBlanche.includes(e)))];
}
