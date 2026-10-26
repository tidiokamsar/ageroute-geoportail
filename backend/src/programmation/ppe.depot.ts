/**
 * ACCES SQL DE LA PROGRAMMATION PLURIANNUELLE (PPE).
 *
 * Meme principe que `moteur.depot.ts` : `$queryRaw` / `$executeRaw` ETIQUETES (valeurs liees par le pilote,
 * jamais concatenees), parce que la table n'est pas dans le client Prisma genere au moment ou ce code est
 * ecrit et que `lib/sql-parametre.test.ts` interdit `$queryRawUnsafe`. Aucune decision ici : le service decide,
 * le noyau calcule.
 *
 * Les lectures de la programmation (candidats, baremes, catalogue, conditions, matrices) sont celles du moteur
 * annuel (`moteur.depot.ts`) : un seul module sait comment la base repond pour le calcul.
 */

import { Prisma } from "@prisma/client";
import type { Db } from "./moteur.depot";

export interface LignePlanDb {
  id: string; intitule: string; anneeDebut: number; nbAnnees: number; parametresId: string; parametresVersion: string;
  enveloppeTotaleGnf: bigint; perimetre: unknown; entreesCanoniques: string; empreinteEntrees: string;
  resultatCanonique: string; empreinteResultat: string; nbRetenus: number; nbNonRetenus: number; montantEngageGnf: bigint;
  provisoire: boolean; creeParId: string; creeLe: Date; deletedAt: Date | null;
}

export type ResumePlanDb = Omit<LignePlanDb, "entreesCanoniques" | "resultatCanonique">;

const COLONNES_RESUME = Prisma.sql`"id", "intitule", "anneeDebut", "nbAnnees", "parametresId", "parametresVersion", "enveloppeTotaleGnf", "perimetre", "empreinteEntrees", "empreinteResultat", "nbRetenus", "nbNonRetenus", "montantEngageGnf", "provisoire", "creeParId", "creeLe", "deletedAt"`;

export async function insererPlan(db: Db, p: Omit<LignePlanDb, "creeLe" | "deletedAt" | "perimetre"> & { perimetreJson: string }): Promise<ResumePlanDb> {
  const r = await db.$queryRaw<ResumePlanDb[]>`
    INSERT INTO "plans_pluriannuels"
      ("id", "intitule", "anneeDebut", "nbAnnees", "parametresId", "parametresVersion", "enveloppeTotaleGnf", "perimetre", "entreesCanoniques",
       "empreinteEntrees", "resultatCanonique", "empreinteResultat", "nbRetenus", "nbNonRetenus", "montantEngageGnf", "provisoire", "creeParId")
    VALUES (${p.id}, ${p.intitule}, ${p.anneeDebut}, ${p.nbAnnees}, ${p.parametresId}, ${p.parametresVersion}, ${p.enveloppeTotaleGnf}, ${p.perimetreJson}::jsonb,
            ${p.entreesCanoniques}, ${p.empreinteEntrees}, ${p.resultatCanonique}, ${p.empreinteResultat}, ${p.nbRetenus}, ${p.nbNonRetenus},
            ${p.montantEngageGnf}, ${p.provisoire}, ${p.creeParId})
    RETURNING ${COLONNES_RESUME}`;
  return r[0];
}

export async function lirePlan(db: Db, id: string): Promise<LignePlanDb | null> {
  const r = await db.$queryRaw<LignePlanDb[]>`SELECT * FROM "plans_pluriannuels" WHERE "id" = ${id} AND "deletedAt" IS NULL`;
  return r[0] ?? null;
}

/** `regions` (A10) : regions visibles d'un compte regional (`perimetre.regionId`) ; `null` ou absent = toutes. Un plan national n'est visible que d'un compte national. */
export async function listerPlans(db: Db, f: { anneeDebut?: number | null; limite: number; decalage: number; regions?: readonly number[] | null }): Promise<{ total: number; lignes: ResumePlanDb[] }> {
  const debut = f.anneeDebut != null ? Prisma.sql`AND "anneeDebut" = ${f.anneeDebut}` : Prisma.empty;
  const region = f.regions ? Prisma.sql`AND "perimetre"->>'regionId' IN (${Prisma.join(f.regions.map(String))})` : Prisma.empty;
  const total = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS "n" FROM "plans_pluriannuels" WHERE "deletedAt" IS NULL ${debut} ${region}`;
  const lignes = await db.$queryRaw<ResumePlanDb[]>`
    SELECT ${COLONNES_RESUME} FROM "plans_pluriannuels" WHERE "deletedAt" IS NULL ${debut} ${region}
     ORDER BY "creeLe" DESC, "id" ASC LIMIT ${f.limite} OFFSET ${f.decalage}`;
  return { total: total[0].n, lignes };
}

export async function supprimerPlanLogiquement(db: Db, id: string): Promise<number> {
  return db.$executeRaw`UPDATE "plans_pluriannuels" SET "deletedAt" = CURRENT_TIMESTAMP(3) WHERE "id" = ${id} AND "deletedAt" IS NULL`;
}

// ---------------------------------------------------------------------------------------------
// Praticabilite (D-02) : lecture seule, jamais ecrite par le moteur
// ---------------------------------------------------------------------------------------------

export interface LignePraticabilite {
  code: string; libelle: string; franchissable: boolean; saisonniere: boolean; approuveeLe: Date | null; actif: boolean; ordre: number;
}

export async function lirePraticabilites(db: Db): Promise<LignePraticabilite[]> {
  return db.$queryRaw<LignePraticabilite[]>`
    SELECT "code", "libelle", "franchissable", "saisonniere", "approuveeLe", "actif", "ordre"
      FROM "referentiel_praticabilites" ORDER BY "ordre" ASC, "code" ASC`;
}

export interface PortionPraticabilite { tronconId: string; code: string; debutM: number; finM: number }

/**
 * Les portions COURANTES et VALIDEES de ces troncons qui portent une praticabilite APPROUVEE. Une proposition de
 * terrain (A_VALIDER) ou une valeur non approuvee n'est jamais lue.
 */
export async function portionsAvecPraticabiliteApprouvee(db: Db, tronconIds: string[]): Promise<PortionPraticabilite[]> {
  if (tronconIds.length === 0) return [];
  return db.$queryRaw<PortionPraticabilite[]>`
    SELECT p."tronconId", p."praticabilite" AS "code", p."debutM", p."finM"
      FROM "portions" p
      JOIN "referentiel_praticabilites" r ON r."code" = p."praticabilite" AND r."actif" AND r."approuveeLe" IS NOT NULL
     WHERE p."tronconId" = ANY(${tronconIds}::text[])
       AND p."deletedAt" IS NULL AND p."remplaceeLe" IS NULL AND p."statutValidation"::text = 'VALIDE'
     ORDER BY p."tronconId" ASC, p."debutM" ASC, p."id" ASC`;
}
