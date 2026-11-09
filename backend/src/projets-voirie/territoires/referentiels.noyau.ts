/**
 * REFERENTIELS CONFIGURABLES (noyau pur) : domaines, schema zod des parametres de chaque domaine, repli de type de reseau sur la famille.
 * Contrat : docs/projets-voirie/CONTRAT-TERRITOIRES.md, section 5.
 *
 * AUCUNE VALEUR DE REFERENTIEL CODEE EN DUR ICI : les valeurs vivent dans la migration de peuplement (20261103100000) et dans la base.
 * Seules les FAMILLES techniques (enumeration Prisma `TypeReseauTiers`, constante du contrat) et les codes de FONCTIONS debloquees par un
 * document (constantes du contrat, lot D1) sont connus du code.
 */

import { z } from "zod";

export const DOMAINES = ["TYPE_RESEAU", "CATEGORIE_PROJET", "TYPE_DOCUMENT", "METHODE_ACQUISITION", "STATUT_QUALITE"] as const;
export type Domaine = (typeof DOMAINES)[number];
export const estDomaine = (v: unknown): v is Domaine => typeof v === "string" && (DOMAINES as readonly string[]).includes(v);

/** Familles techniques de reseau : l'enumeration Prisma `TypeReseauTiers`, qui reste la cle des regles de conflit. */
export const FAMILLES_RESEAU = ["TELECOM", "EAU_POTABLE", "ELECTRICITE", "ASSAINISSEMENT", "GAZ_HYDROCARBURES", "AUTRE"] as const;
export type FamilleReseau = (typeof FAMILLES_RESEAU)[number];

/** Fonctions qu'un type de document peut debloquer (constantes du contrat, utilisees par le lot D1). */
export const FONCTIONS_DEBLOQUABLES = ["ANALYSE_2D", "CONFLITS", "COMPARAISON_SOURCES", "RECOLEMENT", "EXPORT_DOSSIER"] as const;

export const CODE_REFERENTIEL = /^[A-Z0-9][A-Z0-9_-]{1,63}$/;
const COULEUR = /^#[0-9a-fA-F]{6}$/;

const schemaTypeReseau = z.object({
  famille: z.enum(FAMILLES_RESEAU),
  couleur: z.string().regex(COULEUR, "couleur #rrggbb attendue").optional(),
}).strict();

const schemaCategorieProjet = z.object({
  largeurEmpriseM: z.number().positive().max(200),
  largeurChausseeM: z.number().positive().max(200),
}).strict().refine((p) => p.largeurChausseeM <= p.largeurEmpriseM, { message: "largeurChausseeM doit etre au plus egale a largeurEmpriseM", path: ["largeurChausseeM"] });

const schemaTypeDocument = z.object({
  obligatoire: z.boolean(),
  fonctionsDebloquees: z.array(z.string().regex(/^[A-Z0-9_]{2,64}$/, "code de fonction en majuscules")).max(20),
}).strict();

const schemaMethodeAcquisition = z.object({
  precisionTypiqueM: z.number().positive().max(100_000).nullable().optional(),
}).strict();

const schemaStatutQualite = z.object({
  description: z.string().trim().max(500).optional(),
}).strict();

export const SCHEMAS_PARAMETRES: Record<Domaine, z.ZodTypeAny> = {
  TYPE_RESEAU: schemaTypeReseau,
  CATEGORIE_PROJET: schemaCategorieProjet,
  TYPE_DOCUMENT: schemaTypeDocument,
  METHODE_ACQUISITION: schemaMethodeAcquisition,
  STATUT_QUALITE: schemaStatutQualite,
};

export type VerdictParametres = { ok: true; parametres: Record<string, unknown> } | { ok: false; erreurs: Record<string, string[]> };

/** Valide les parametres d'une valeur selon son domaine (schema strict : une cle inconnue est refusee). */
export function validerParametres(domaine: Domaine, brut: unknown): VerdictParametres {
  const r = SCHEMAS_PARAMETRES[domaine].safeParse(brut ?? {});
  if (r.success) return { ok: true, parametres: r.data as Record<string, unknown> };
  const erreurs: Record<string, string[]> = {};
  for (const e of r.error.issues) {
    const cle = e.path.length ? e.path.join(".") : "parametres";
    (erreurs[cle] ??= []).push(e.message);
  }
  return { ok: false, erreurs };
}

export interface ValeurTypeReseau { code: string; parametres: unknown; deletedAt?: Date | null }

/**
 * REPLI DE TYPE : la famille technique d'un jeu ou d'un concessionnaire est celle du referentiel quand un code est porte (`parametres.famille`),
 * sinon la famille declaree (enumeration). Un code inconnu ou retire NE change pas la famille declaree : il est signale a l'appelant (`codeInconnu`).
 */
export function familleEffective(typeReseauCode: string | null | undefined, familleDeclaree: FamilleReseau | null, valeurs: readonly ValeurTypeReseau[]): { famille: FamilleReseau | null; source: "REFERENTIEL" | "FAMILLE_DECLAREE"; codeInconnu: boolean } {
  if (!typeReseauCode) return { famille: familleDeclaree, source: "FAMILLE_DECLAREE", codeInconnu: false };
  const v = valeurs.find((x) => x.code === typeReseauCode && !x.deletedAt);
  const famille = v ? (v.parametres as { famille?: unknown } | null)?.famille : undefined;
  if (typeof famille === "string" && (FAMILLES_RESEAU as readonly string[]).includes(famille)) return { famille: famille as FamilleReseau, source: "REFERENTIEL", codeInconnu: false };
  return { famille: familleDeclaree, source: "FAMILLE_DECLAREE", codeInconnu: true };
}

/** Prochaine version d'une valeur modifiee. */
export const prochaineVersion = (version: number): number => version + 1;
