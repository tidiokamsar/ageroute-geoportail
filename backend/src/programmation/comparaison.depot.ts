/**
 * ACCES SQL DU SIMULATEUR (lecture seule, hors enregistrement qui passe par `moteur.depot.insererScenario`).
 *
 * Tout passe par `$queryRaw` ETIQUETE (valeurs liees par le pilote, jamais concatenees). Rien n'est ecrit ici : le
 * simulateur ne touche ni `programmes_budgetaires`, ni `chantiers`, ni `marches`, ni `decomptes`, ni
 * `baremes_intervention` (le banc `aide-decision-scenarios.integration.mts` le prouve par empreintes avant/apres).
 */

import { Prisma } from "@prisma/client";
import type { LigneBareme } from "../engines/cout.noyau";
import { refDe, type BaremeRef } from "./comparaison.baremes.noyau";
import type { Db } from "./moteur.depot";

interface LigneBaremeSim {
  id: number; code: string | null; version: number; familleRevetement: string; etatDepart: string; typeIntervention: string; coutKmGnf: bigint;
  uniteCout: string; devise: string; anneeReference: number | null; largeurChausseeM: number | null; approuveLe: Date | null;
  validDe: string | null; validA: string | null;
}

export interface BaremesSimulation { baremes: LigneBareme[]; refs: BaremeRef[] }

/**
 * Les lignes de bareme du simulateur : actives, UNE par (famille, etat, type d'intervention).
 *
 * Pour une meme cle, une version qui COUVRE TOUTE LA PERIODE est preferee a une version plus recente qui ne la couvre pas ;
 * s'il n'y en a aucune, la derniere version est prise telle quelle et le noyau la declarera PERIMEE : un cout perime est
 * signale, il n'est ni masque (en retirant la ligne) ni simule comme fiable. `ids` restreint le choix aux lignes designees.
 */
export async function chargerBaremesSimulation(db: Db, periode: { debut: string; fin: string }, ids?: readonly number[] | null): Promise<BaremesSimulation> {
  const restriction = ids && ids.length > 0 ? Prisma.sql`AND "id" IN (${Prisma.join([...ids])})` : Prisma.empty;
  const l = await db.$queryRaw<LigneBaremeSim[]>`
    SELECT DISTINCT ON ("familleRevetement", "etatDepart", "typeIntervention")
           "id", "code", "version", "familleRevetement", "etatDepart", "typeIntervention", "coutKmGnf", "uniteCout", "devise",
           "anneeReference", "largeurChausseeM"::float8 AS "largeurChausseeM", "approuveLe",
           to_char("validDe", 'YYYY-MM-DD') AS "validDe", to_char("validA", 'YYYY-MM-DD') AS "validA"
      FROM "baremes_intervention"
     WHERE "actif" ${restriction}
     ORDER BY "familleRevetement", "etatDepart", "typeIntervention",
              (CASE WHEN ("validDe" IS NULL OR "validDe" <= ${periode.debut}::date) AND ("validA" IS NULL OR "validA" >= ${periode.fin}::date) THEN 0 ELSE 1 END),
              "version" DESC, "id" DESC`;
  const baremes: LigneBareme[] = l.map((b) => ({
    id: b.id, code: b.code, familleRevetement: b.familleRevetement, etatDepart: b.etatDepart, typeIntervention: b.typeIntervention, coutKmGnf: b.coutKmGnf,
    uniteCout: b.uniteCout, devise: b.devise, anneeReference: b.anneeReference, largeurChausseeM: b.largeurChausseeM, approuveLe: b.approuveLe, actif: true,
  }));
  const refs = l.map((b, i) => refDe(baremes[i], { version: b.version, validDe: b.validDe, validA: b.validA }));
  return { baremes, refs };
}

export interface ResumeSimulateur {
  id: string; annee: number; intitule: string; parametresVersion: string; parametresId: string; budgetGnf: bigint; perimetre: unknown;
  nbRetenues: number; nbEcartees: number; montantEngageGnf: bigint; provisoire: boolean; empreinteEntrees: string; empreinteResultat: string;
  creeParId: string; creeLe: Date; auteurNom: string | null;
  /** Lus dans les textes canoniques ; nuls pour un scenario herite (calcule avant le simulateur). */
  logique: string | null; periodeDebut: string | null; periodeFin: string | null; deficitGnf: string | null; deficitMinorant: boolean | null;
}

export interface FiltreListe { annee?: number | null; q?: string | null; logique?: string | null; limite: number; decalage: number; regions?: readonly number[] | null }

/** Liste des scenarios visibles, avec les champs du simulateur lus dans le JSON canonique (jamais recalcules). */
export async function listerResumes(db: Db, f: FiltreListe): Promise<{ total: number; lignes: ResumeSimulateur[] }> {
  const annee = f.annee != null ? Prisma.sql`AND s."annee" = ${f.annee}` : Prisma.empty;
  const region = f.regions ? Prisma.sql`AND s."perimetre"->>'regionId' IN (${Prisma.join(f.regions.map(String))})` : Prisma.empty;
  const q = f.q ? Prisma.sql`AND s."intitule" ILIKE ${"%" + f.q.replace(/[\\%_]/g, (c) => "\\" + c) + "%"}` : Prisma.empty;
  const logique = f.logique ? Prisma.sql`AND s."entreesCanoniques"::jsonb #>> '{simulation,logique}' = ${f.logique}` : Prisma.empty;
  const total = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS "n" FROM "scenarios_programmation" s WHERE s."deletedAt" IS NULL ${annee} ${region} ${q} ${logique}`;
  const lignes = await db.$queryRaw<ResumeSimulateur[]>`
    SELECT s."id", s."annee", s."intitule", s."parametresId", s."parametresVersion", s."budgetGnf", s."perimetre", s."nbRetenues", s."nbEcartees",
           s."montantEngageGnf", s."provisoire", s."empreinteEntrees", s."empreinteResultat", s."creeParId", s."creeLe", u."nomComplet" AS "auteurNom",
           s."entreesCanoniques"::jsonb #>> '{simulation,logique}' AS "logique",
           s."entreesCanoniques"::jsonb #>> '{simulation,periode,debut}' AS "periodeDebut",
           s."entreesCanoniques"::jsonb #>> '{simulation,periode,fin}' AS "periodeFin",
           s."resultatCanonique"::jsonb #>> '{simulation,bilan,deficitGnf}' AS "deficitGnf",
           (s."resultatCanonique"::jsonb #>> '{simulation,bilan,deficitMinorant}')::boolean AS "deficitMinorant"
      FROM "scenarios_programmation" s LEFT JOIN "users" u ON u."id" = s."creeParId"
     WHERE s."deletedAt" IS NULL ${annee} ${region} ${q} ${logique}
     ORDER BY s."creeLe" DESC, s."id" ASC LIMIT ${f.limite} OFFSET ${f.decalage}`;
  return { total: total[0].n, lignes };
}

/** Auteur lisible d'un scenario (nom complet) ; `null` si le compte n'existe plus. */
export async function nomsAuteurs(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const l = await db.$queryRaw<{ id: string; nomComplet: string }[]>`SELECT "id", "nomComplet" FROM "users" WHERE "id" IN (${Prisma.join([...ids])})`;
  return new Map(l.map((x) => [x.id, x.nomComplet]));
}
