/**
 * ACCES SQL DU MOTEUR DE PROGRAMMATION.
 *
 * Tout passe par `$queryRaw` / `$executeRaw` ETIQUETES (valeurs liees par le pilote, jamais
 * concatenees) : les quatre tables du moteur ne sont pas dans le client Prisma genere au moment
 * ou ce code est ecrit, et le garde-fou `lib/sql-parametre.test.ts` interdit `$queryRawUnsafe`.
 * Les tables existantes (baremes, catalogue, conditions, matrices, troncons) sont lues par le meme
 * canal, pour qu'un seul module sache comment la base repond.
 *
 * Aucune decision ici : ce fichier lit et ecrit, le service decide, les noyaux calculent.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import type { LigneBareme } from "../engines/cout.noyau";
import type { ConditionTraitement, LigneMatrice, Traitement } from "../engines/traitement.noyau";
import { fragmentPerimetre } from "../lib/reseau";
import type { ParametresProgrammation } from "./parametres.noyau";
import type { CandidatTroncon } from "./scenario.noyau";

export type Db = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;

// ---------------------------------------------------------------------------------------------
// Parametres
// ---------------------------------------------------------------------------------------------

export interface LigneParametres {
  id: string;
  version: string;
  source: string;
  valeurs: unknown;
  motif: string | null;
  creeParId: string | null;
  createdAt: Date;
  approuveeLe: Date | null;
  approuveeParId: string | null;
  deletedAt: Date | null;
}

const COLONNES_PARAMETRES = Prisma.sql`"id", "version", "source", "valeurs", "motif", "creeParId", "createdAt", "approuveeLe", "approuveeParId", "deletedAt"`;

export function parametresDeLigne(l: LigneParametres): ParametresProgrammation {
  return {
    version: l.version,
    source: l.source as ParametresProgrammation["source"],
    approuveeLe: l.approuveeLe ? l.approuveeLe.toISOString() : null,
    approuveeParId: l.approuveeParId,
    valeurs: l.valeurs as ParametresProgrammation["valeurs"],
  };
}

export async function listerParametres(db: Db): Promise<LigneParametres[]> {
  return db.$queryRaw<LigneParametres[]>`SELECT ${COLONNES_PARAMETRES} FROM "parametres_programmation" WHERE "deletedAt" IS NULL ORDER BY "createdAt" DESC, "version" ASC`;
}

export async function lireParametresParId(db: Db, id: string): Promise<LigneParametres | null> {
  const r = await db.$queryRaw<LigneParametres[]>`SELECT ${COLONNES_PARAMETRES} FROM "parametres_programmation" WHERE "id" = ${id} AND "deletedAt" IS NULL`;
  return r[0] ?? null;
}

export async function insererParametres(db: Db, p: { id: string; version: string; valeursJson: string; motif: string | null; creeParId: string }): Promise<LigneParametres> {
  const r = await db.$queryRaw<LigneParametres[]>`
    INSERT INTO "parametres_programmation" ("id", "version", "source", "valeurs", "motif", "creeParId")
    VALUES (${p.id}, ${p.version}, 'saisie', ${p.valeursJson}::jsonb, ${p.motif}, ${p.creeParId})
    RETURNING ${COLONNES_PARAMETRES}`;
  return r[0];
}

export async function poserApprobation(db: Db, id: string, approbateurId: string | null): Promise<LigneParametres | null> {
  const r = approbateurId === null
    ? await db.$queryRaw<LigneParametres[]>`UPDATE "parametres_programmation" SET "approuveeLe" = NULL, "approuveeParId" = NULL WHERE "id" = ${id} AND "deletedAt" IS NULL RETURNING ${COLONNES_PARAMETRES}`
    : await db.$queryRaw<LigneParametres[]>`UPDATE "parametres_programmation" SET "approuveeLe" = CURRENT_TIMESTAMP(3), "approuveeParId" = ${approbateurId} WHERE "id" = ${id} AND "deletedAt" IS NULL RETURNING ${COLONNES_PARAMETRES}`;
  return r[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// Lecture des entrees du calcul
// ---------------------------------------------------------------------------------------------

export interface FiltreCandidats {
  regionId?: number | null;
  classe?: string | null;
  /** Plafond de lignes lu : on demande une ligne de plus que le maximum pour savoir si on le depasse. */
  limite: number;
}

interface LigneCandidat {
  id: string; code: string; nom: string | null; regionId: number | null; classe: string | null; revetement: string | null; etat: string | null;
  longueurKm: number | null; longueurGeometriqueM: number | null; traficMoyenJma: number | null; criticiteStrategique: number | null; nbPointsNoirs: number | null;
}

/**
 * Les troncons candidats : reseau classe de reference, non supprimes, ni rejetes ni a corriger.
 *
 * SECURITE : le nombre de points noirs n'est lu que si le registre en contient au moins un (sinon
 * il n'y a pas de source et le facteur est ABSENT, pas zero). Le registre n'est pas prouve
 * exhaustif ; le facteur le dit.
 *
 * LONGUEUR : la colonne `longueurKm` si elle est positive, sinon la longueur de la geometrie
 * (geography), AVEC SON ORIGINE, pour que la ligne dise de quoi son cout est fait.
 */
export async function chargerCandidats(db: Db, f: FiltreCandidats): Promise<CandidatTroncon[]> {
  const region = f.regionId != null ? Prisma.sql`AND tr."regionId" = ${f.regionId}` : Prisma.empty;
  const classe = f.classe ? Prisma.sql`AND tr."classe"::text = ${f.classe}` : Prisma.empty;
  const lignes = await db.$queryRaw<LigneCandidat[]>`
    SELECT tr."id", tr."code", tr."nom", tr."regionId", tr."classe"::text AS "classe", tr."revetement"::text AS "revetement", tr."etat"::text AS "etat",
           tr."longueurKm", ST_Length(tr."geom"::geography) AS "longueurGeometriqueM",
           tr."traficMoyenJma", tr."criticiteStrategique",
           CASE WHEN EXISTS (SELECT 1 FROM "points_noirs" x WHERE x."deletedAt" IS NULL)
                THEN (SELECT count(*)::int FROM "points_noirs" pn WHERE pn."tronconId" = tr."id" AND pn."deletedAt" IS NULL)
                ELSE NULL END AS "nbPointsNoirs"
      FROM "troncons" tr
     WHERE tr."deletedAt" IS NULL
       AND (tr."statutValidation" IS NULL OR tr."statutValidation" = 'VALIDE')
       ${fragmentPerimetre("reference", 'tr."sourceReference"')}
       ${region} ${classe}
     ORDER BY tr."id" ASC
     LIMIT ${f.limite}`;
  return lignes.map((l) => {
    const saisie = l.longueurKm !== null && l.longueurKm > 0;
    const geo = l.longueurGeometriqueM !== null && l.longueurGeometriqueM > 0;
    return {
      id: l.id, code: l.code, nom: l.nom, regionId: l.regionId, classe: l.classe, revetement: l.revetement, etat: l.etat,
      longueurM: saisie ? Math.round((l.longueurKm as number) * 1000) : geo ? Math.round(l.longueurGeometriqueM as number) : null,
      longueurOrigine: saisie ? "LONGUEUR_KM" : geo ? "GEOMETRIE" : null,
      traficMoyenJma: l.traficMoyenJma, criticiteStrategique: l.criticiteStrategique, nbPointsNoirs: l.nbPointsNoirs,
      vulnerabiliteClimatique: null, populationDesservie: null,
    } satisfies CandidatTroncon;
  });
}

interface LigneBaremeBrute {
  id: number; code: string | null; familleRevetement: string; etatDepart: string; typeIntervention: string; coutKmGnf: bigint; uniteCout: string; devise: string;
  anneeReference: number | null; largeurChausseeM: number | null; approuveLe: Date | null;
}

/**
 * Les lignes de bareme APPLICABLES a l'annee du programme : actives, dans leur fenetre de validite,
 * et, pour un meme (famille, etat, intervention), la derniere version seulement (deux versions
 * actives feraient refuser le moteur de cout pour ambiguite).
 */
export async function chargerBaremes(db: Db, annee: number): Promise<LigneBareme[]> {
  const l = await db.$queryRaw<LigneBaremeBrute[]>`
    SELECT DISTINCT ON ("familleRevetement", "etatDepart", "typeIntervention")
           "id", "code", "familleRevetement", "etatDepart", "typeIntervention", "coutKmGnf", "uniteCout", "devise",
           "anneeReference", "largeurChausseeM"::float8 AS "largeurChausseeM", "approuveLe"
      FROM "baremes_intervention"
     WHERE "actif"
       AND ("validDe" IS NULL OR "validDe" <= make_date(${annee}::int, 12, 31))
       AND ("validA" IS NULL OR "validA" >= make_date(${annee}::int, 1, 1))
     ORDER BY "familleRevetement", "etatDepart", "typeIntervention", "version" DESC, "id" DESC`;
  return l.map((b) => ({ ...b, actif: true }));
}

interface LigneTraitementBrute {
  code: string; libelle: string; famille: string; dureeVieAttendueAns: number | null; effetSurIndice: string | null;
  fenetreRealisation: string | null; version: number; approuveLe: Date | null;
}

export async function chargerCatalogue(db: Db): Promise<Traitement[]> {
  const l = await db.$queryRaw<LigneTraitementBrute[]>`
    SELECT "code", "libelle", "famille", "dureeVieAttendueAns", "effetSurIndice"::text AS "effetSurIndice", "fenetreRealisation", "version", "approuveLe"
      FROM "catalogue_traitements" WHERE "actif" ORDER BY "code"`;
  return l.map((t) => ({ ...t, actif: true }));
}

export async function chargerConditions(db: Db): Promise<ConditionTraitement[]> {
  const l = await db.$queryRaw<{ traitementCode: string; familleRevetement: string; etatDepart: string; classeTrafic: string | null }[]>`
    SELECT "traitementCode", "familleRevetement", "etatDepart", "classeTrafic" FROM "conditions_traitement" WHERE "actif"
     ORDER BY "familleRevetement", "etatDepart", "classeTrafic" NULLS FIRST, "traitementCode"`;
  return l.map((c) => ({ ...c, actif: true }));
}

export async function chargerMatrices(db: Db): Promise<LigneMatrice[]> {
  const l = await db.$queryRaw<{ familleRevetement: string; classeTrafic: string; pBonVersMoyen: number; pMoyenVersMauvais: number; pMauvaisVersCritique: number; version: number; approuveLe: Date | null }[]>`
    SELECT "familleRevetement", "classeTrafic", "pBonVersMoyen", "pMoyenVersMauvais", "pMauvaisVersCritique", "version", "approuveLe"
      FROM "matrices_degradation" WHERE "actif" ORDER BY "familleRevetement", "classeTrafic"`;
  return l.map((m) => ({ ...m, actif: true }));
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

export interface LigneScenarioDb {
  id: string; annee: number; intitule: string; parametresId: string; parametresVersion: string; budgetGnf: bigint;
  perimetre: unknown; entreesCanoniques: string; empreinteEntrees: string; resultatCanonique: string; empreinteResultat: string;
  nbRetenues: number; nbEcartees: number; montantEngageGnf: bigint; provisoire: boolean; creeParId: string; creeLe: Date; deletedAt: Date | null;
}

export type ResumeScenarioDb = Omit<LigneScenarioDb, "entreesCanoniques" | "resultatCanonique">;

const COLONNES_RESUME_SCENARIO = Prisma.sql`"id", "annee", "intitule", "parametresId", "parametresVersion", "budgetGnf", "perimetre", "empreinteEntrees", "empreinteResultat", "nbRetenues", "nbEcartees", "montantEngageGnf", "provisoire", "creeParId", "creeLe", "deletedAt"`;

export async function insererScenario(db: Db, s: Omit<LigneScenarioDb, "creeLe" | "deletedAt" | "perimetre"> & { perimetreJson: string }): Promise<ResumeScenarioDb> {
  const r = await db.$queryRaw<ResumeScenarioDb[]>`
    INSERT INTO "scenarios_programmation"
      ("id", "annee", "intitule", "parametresId", "parametresVersion", "budgetGnf", "perimetre", "entreesCanoniques", "empreinteEntrees",
       "resultatCanonique", "empreinteResultat", "nbRetenues", "nbEcartees", "montantEngageGnf", "provisoire", "creeParId")
    VALUES (${s.id}, ${s.annee}, ${s.intitule}, ${s.parametresId}, ${s.parametresVersion}, ${s.budgetGnf}, ${s.perimetreJson}::jsonb, ${s.entreesCanoniques}, ${s.empreinteEntrees},
            ${s.resultatCanonique}, ${s.empreinteResultat}, ${s.nbRetenues}, ${s.nbEcartees}, ${s.montantEngageGnf}, ${s.provisoire}, ${s.creeParId})
    RETURNING ${COLONNES_RESUME_SCENARIO}`;
  return r[0];
}

export async function lireScenario(db: Db, id: string): Promise<LigneScenarioDb | null> {
  const r = await db.$queryRaw<LigneScenarioDb[]>`SELECT * FROM "scenarios_programmation" WHERE "id" = ${id} AND "deletedAt" IS NULL`;
  return r[0] ?? null;
}

export async function listerScenarios(db: Db, f: { annee?: number | null; limite: number; decalage: number }): Promise<{ total: number; lignes: ResumeScenarioDb[] }> {
  const annee = f.annee != null ? Prisma.sql`AND "annee" = ${f.annee}` : Prisma.empty;
  const total = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS "n" FROM "scenarios_programmation" WHERE "deletedAt" IS NULL ${annee}`;
  const lignes = await db.$queryRaw<ResumeScenarioDb[]>`
    SELECT ${COLONNES_RESUME_SCENARIO} FROM "scenarios_programmation" WHERE "deletedAt" IS NULL ${annee}
     ORDER BY "creeLe" DESC, "id" ASC LIMIT ${f.limite} OFFSET ${f.decalage}`;
  return { total: total[0].n, lignes };
}

export async function supprimerScenarioLogiquement(db: Db, id: string): Promise<number> {
  return db.$executeRaw`UPDATE "scenarios_programmation" SET "deletedAt" = CURRENT_TIMESTAMP(3) WHERE "id" = ${id} AND "deletedAt" IS NULL`;
}

// ---------------------------------------------------------------------------------------------
// Fiches et statuts
// ---------------------------------------------------------------------------------------------

export interface LigneFicheDb {
  id: string; reference: string; scenarioId: string; tronconId: string; annee: number; parametresVersion: string;
  contenuCanonique: string; empreinteSha256: string; figeLe: Date; figeParId: string;
}

export interface LigneFicheCourante {
  id: string; reference: string; scenarioId: string; tronconId: string; annee: number; parametresVersion: string;
  empreinteSha256: string; figeLe: Date; figeParId: string; statut: string; rangStatut: number; statutDepuis: Date;
}

export async function insererFiche(db: Db, f: Omit<LigneFicheDb, "figeLe">): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "fiches_intervention" ("id", "reference", "scenarioId", "tronconId", "annee", "parametresVersion", "contenuCanonique", "empreinteSha256", "figeParId")
    VALUES (${f.id}, ${f.reference}, ${f.scenarioId}, ${f.tronconId}, ${f.annee}, ${f.parametresVersion}, ${f.contenuCanonique}, ${f.empreinteSha256}, ${f.figeParId})`;
}

export async function fichesDuScenario(db: Db, scenarioId: string): Promise<{ id: string; tronconId: string }[]> {
  return db.$queryRaw<{ id: string; tronconId: string }[]>`SELECT "id", "tronconId" FROM "fiches_intervention" WHERE "scenarioId" = ${scenarioId}`;
}

export async function lireFiche(db: Db, id: string): Promise<LigneFicheDb | null> {
  const r = await db.$queryRaw<LigneFicheDb[]>`SELECT * FROM "fiches_intervention" WHERE "id" = ${id}`;
  return r[0] ?? null;
}

export async function lireFicheCourante(db: Db, id: string): Promise<LigneFicheCourante | null> {
  const r = await db.$queryRaw<LigneFicheCourante[]>`SELECT * FROM "fiches_intervention_courantes" WHERE "id" = ${id}`;
  return r[0] ?? null;
}

export async function listerFiches(db: Db, f: { annee?: number | null; scenarioId?: string | null; statut?: string | null; limite: number; decalage: number }): Promise<{ total: number; lignes: LigneFicheCourante[] }> {
  const annee = f.annee != null ? Prisma.sql`AND "annee" = ${f.annee}` : Prisma.empty;
  const scenario = f.scenarioId ? Prisma.sql`AND "scenarioId" = ${f.scenarioId}` : Prisma.empty;
  const statut = f.statut ? Prisma.sql`AND "statut" = ${f.statut}` : Prisma.empty;
  const total = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS "n" FROM "fiches_intervention_courantes" WHERE true ${annee} ${scenario} ${statut}`;
  const lignes = await db.$queryRaw<LigneFicheCourante[]>`
    SELECT * FROM "fiches_intervention_courantes" WHERE true ${annee} ${scenario} ${statut}
     ORDER BY "figeLe" DESC, "id" ASC LIMIT ${f.limite} OFFSET ${f.decalage}`;
  return { total: total[0].n, lignes };
}

export interface LigneStatut {
  id: string; ficheId: string; rang: number; de: string | null; vers: string; origine: string; motif: string | null;
  messageDigitalRoadId: string | null; inspectionId: string | null; versionFigee: string | null; auteurId: string | null; enregistreLe: Date;
}

export async function insererStatut(db: Db, s: { id: string; ficheId: string; rang: number; de: string | null; vers: string; origine: string; motif: string | null; auteurId: string }): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "fiches_intervention_statuts" ("id", "ficheId", "rang", "de", "vers", "origine", "motif", "auteurId")
    VALUES (${s.id}, ${s.ficheId}, ${s.rang}, ${s.de}, ${s.vers}, ${s.origine}, ${s.motif}, ${s.auteurId})`;
}

export async function historiqueStatuts(db: Db, ficheId: string): Promise<LigneStatut[]> {
  return db.$queryRaw<LigneStatut[]>`SELECT * FROM "fiches_intervention_statuts" WHERE "ficheId" = ${ficheId} ORDER BY "rang" ASC`;
}
