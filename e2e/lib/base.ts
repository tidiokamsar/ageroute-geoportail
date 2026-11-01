import { Pool } from "pg";
import { lireRun } from "./donnees";

/**
 * Verification COTE SERVEUR : lecture directe de la base `essai_e2e`. C'est ce qui distingue un test de bout
 * en bout d'un test d'interface : on ne croit pas l'ecran quand il dit « envoye », on regarde ce que la base
 * contient. Lecture seule ; les specs n'ecrivent jamais ici.
 */
let pool: Pool | null = null;

function connexion(): Pool {
  if (!pool) {
    // `schema=public` est un parametre de Prisma, inconnu de `pg`.
    const url = new URL(lireRun().urlBase);
    url.searchParams.delete("schema");
    pool = new Pool({ connectionString: url.toString(), max: 2 });
  }
  return pool;
}

export async function requete<T extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await connexion().query(sql, params);
  return r.rows as T[];
}

export async function fermerBase(): Promise<void> {
  if (pool) { await pool.end(); pool = null; }
}

export interface LigneObservation {
  id: string; clientOperationId: string; agentId: string; type: string; statut: string;
  gravite: string | null; description: string | null; lat: number | null; lon: number | null;
}

/** Les observations dont la description contient le marqueur unique d'un test. */
export function observationsAvecMarqueur(marqueur: string): Promise<LigneObservation[]> {
  return requete<LigneObservation>(
    `SELECT id, "clientOperationId", "agentId", type::text AS type, statut::text AS statut, gravite::text AS gravite,
            description, lat, lon
       FROM observations WHERE description LIKE $1 AND "deletedAt" IS NULL ORDER BY "createdAt"`,
    [`%${marqueur}%`]);
}

/** Les observations creees avec cette cle d'idempotence (= `localId` genere par le telephone). Au plus une : la cle est unique. */
export function observationsParOperation(clientOperationId: string): Promise<LigneObservation[]> {
  return requete<LigneObservation>(
    `SELECT id, "clientOperationId", "agentId", type::text AS type, statut::text AS statut, gravite::text AS gravite,
            description, lat, lon
       FROM observations WHERE "clientOperationId" = $1 AND "deletedAt" IS NULL`,
    [clientOperationId]);
}

export interface LigneMedia { id: string; observationId: string; sha256: string; mimeType: string; tailleOctets: number; type: string }

export function mediasDeObservation(observationId: string): Promise<LigneMedia[]> {
  return requete<LigneMedia>(
    `SELECT id, "observationId", sha256, "mimeType", "tailleOctets", type FROM medias_observation WHERE "observationId" = $1`,
    [observationId]);
}

export interface LigneInspection {
  id: string; clientInspectionId: string | null; inspecteurId: string; tronconId: string | null;
  etatObserve: string; defautsConstates: string | null; photos: string[];
}

export function inspectionsAvecMarqueur(marqueur: string): Promise<LigneInspection[]> {
  return requete<LigneInspection>(
    `SELECT id, "clientInspectionId", "inspecteurId", "tronconId", "etatObserve"::text AS "etatObserve",
            "defautsConstates", photos
       FROM inspections WHERE "defautsConstates" LIKE $1 AND "deletedAt" IS NULL ORDER BY "createdAt"`,
    [`%${marqueur}%`]);
}

/**
 * Nettoyage du harnais (pas une assertion) : retire les appareils enregistres par les profils de test du compte des « actifs ». Le serveur
 * plafonne a 10 appareils ACTIFS par compte (`APPAREILS_ACTIFS_MAX`), et chaque profil de navigateur neuf en enregistre un.
 *
 * ON ANTIDATE LA REVOCATION (un jour) AU LIEU DE LA POSER A « MAINTENANT » : depuis la relecture D9, tant qu'un appareil du compte a ete
 * revoque depuis moins de `JWT_ACCESS_EXPIRES_IN` (15 min), le serveur refuse d'enregistrer un appareil NEUF (403
 * APPAREIL_REVOCATION_RECENTE). Une revocation « maintenant » bloquerait donc le test suivant du meme compte. Ecriture sur la base
 * jetable `essai_e2e` seulement.
 */
export async function revoquerAppareilsDeTest(): Promise<void> {
  await requete(`UPDATE appareils SET "revoqueA" = now() - interval '1 day' WHERE "revoqueA" IS NULL OR "revoqueA" > now() - interval '1 day'`);
}

// ---------------------------------------------------------------------------------------------------------
// Etat serveur d'un compte (preparation de scenarios : ce que fait un administrateur pendant que l'agent est hors ligne)
// et lectures de controle. Ecritures sur la base jetable `essai_e2e` seulement ; chaque test remet ce qu'il a change.
// ---------------------------------------------------------------------------------------------------------

export async function definirCompteActif(userId: string, actif: boolean): Promise<void> {
  await requete(`UPDATE users SET actif = $2, "failedLoginAttempts" = 0, "lockedUntil" = NULL WHERE id = $1`, [userId, actif]);
}

export async function lireModules(userId: string): Promise<string[]> {
  return (await requete<{ modulesAutorises: string[] }>(`SELECT "modulesAutorises" FROM users WHERE id = $1`, [userId]))[0].modulesAutorises;
}

export async function definirModules(userId: string, modules: string[]): Promise<void> {
  await requete(`UPDATE users SET "modulesAutorises" = $2::text[] WHERE id = $1`, [userId, modules]);
}

export interface LigneAppareil { id: string; userId: string; revoqueA: Date | null }

export function appareilsDe(userId: string): Promise<LigneAppareil[]> {
  return requete<LigneAppareil>(`SELECT id, "userId", "revoqueA" FROM appareils WHERE "userId" = $1 ORDER BY "createdAt"`, [userId]);
}

/** Evenements de la session locale deposes par le telephone (`POST /api/auth/evenements-locaux`) : une ligne d'audit chacun. */
export function evenementsLocauxDe(userId: string): Promise<{ evenement: string; occurrences: number }[]> {
  return requete<{ evenement: string; occurrences: number }>(
    `SELECT after->>'evenement' AS evenement, COALESCE((after->>'occurrences')::int, 1) AS occurrences
       FROM audit_logs WHERE "entityType" = 'EvenementLocal' AND "userId" = $1 ORDER BY "createdAt"`, [userId]);
}

/** Sessions de rafraichissement encore vivantes d'un compte (la deconnexion et la revocation d'appareil les coupent). */
export async function sessionsVivantes(userId: string): Promise<number> {
  const r = await requete<{ n: string }>(`SELECT count(*)::text AS n FROM refresh_tokens WHERE "userId" = $1 AND "revokedAt" IS NULL`, [userId]);
  return Number(r[0].n);
}

// ---------------------------------------------------------------------------------------------------------
// Lots d'import : lecture de ce qui est en base, et PREUVE que le referentiel n'a pas bouge.
// ---------------------------------------------------------------------------------------------------------

export interface LigneLot {
  id: string; reference: string; statut: string; nomFichier: string; systemeSource: string; empreinte: string | null;
  format: string; lignesLues: number; lignesValidees: number; lignesImportees: number; lignesRejetees: number; motifRejetLot: string | null;
}

/** Les lots dont le nom de fichier ou la source contient le marqueur (colonnes lues telles que le schema les nomme). */
export function lotsAvecMarqueur(marqueur: string): Promise<LigneLot[]> {
  return requete<LigneLot>(
    `SELECT id, reference, statut::text AS statut, "nomFichier", "systemeSource", "empreinteFichier" AS empreinte, format,
            "lignesLues", "lignesValidees", "lignesImportees", "lignesRejetees", rapport->>'motifRejetLot' AS "motifRejetLot"
       FROM lots_import WHERE "nomFichier" LIKE $1 OR "systemeSource" LIKE $1 ORDER BY "importeLe", id`,
    [`%${marqueur}%`]);
}

/** Comptes des tables du referentiel qu'un import pourrait ecrire : ils ne doivent PAS changer a la reception d'un lot. */
export async function comptesReferentiel(): Promise<Record<string, number>> {
  const tables = ["troncons", "ouvrages", "points_noirs", "postes", "chantiers", "portions", "defauts", "observations", "inspections", "regions"];
  const sortie: Record<string, number> = {};
  for (const t of tables) {
    const r = await requete<{ n: string }>(`SELECT count(*)::text AS n FROM ${t}`);
    sortie[t] = Number(r[0].n);
  }
  return sortie;
}

export async function auditDuLot(lotId: string): Promise<{ action: string; userId: string | null }[]> {
  return requete<{ action: string; userId: string | null }>(
    `SELECT action::text AS action, "userId" FROM audit_logs WHERE "entityType" = 'LotImport' AND "entityId" = $1 ORDER BY "createdAt"`, [lotId]);
}

export async function nombreLots(): Promise<number> {
  return Number((await requete<{ n: string }>(`SELECT count(*)::text AS n FROM lots_import`))[0].n);
}
