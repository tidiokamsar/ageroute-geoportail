import { createHash } from "node:crypto";
import { Pool } from "pg";
import { lireRun } from "./donnees";

/**
 * Verification COTE SERVEUR : lecture directe de la base `essai_eo_e2e`. On ne croit pas l'ecran quand il dit « enregistre » :
 * on regarde ce que la base contient. Lecture seule dans les specs ; les ecritures de fixtures sont dans global-setup / semis.
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

/** Un nombre (count) lu en base. */
export async function compter(sql: string, params: unknown[] = []): Promise<number> {
  const r = await requete<{ n: string }>(`SELECT (${sql})::text AS n`, params);
  return Number(r[0].n);
}

// ------------------------------------------------------------------------------------------------------------------
// Empreinte du referentiel : une proposition ne modifie JAMAIS troncons, portions, ouvrages (contrat, principe 2).
// ------------------------------------------------------------------------------------------------------------------

const TABLES_REFERENTIEL = ["troncons", "portions", "ouvrages"] as const;

/** SHA-256 du contenu complet de chaque table (toutes les colonnes de chaque ligne, triees par identifiant), via une requete donnee. */
export async function empreinteReferentiel(exec: (sql: string) => Promise<{ rows: { l: string }[] }>): Promise<Record<string, string>> {
  const res: Record<string, string> = {};
  for (const t of TABLES_REFERENTIEL) {
    const r = await exec(`SELECT x::text AS l FROM ${t} x ORDER BY x.id`);
    const h = createHash("sha256");
    for (const l of r.rows) h.update(l.l).update("\n");
    h.update(`#${r.rows.length}`);
    res[t] = h.digest("hex");
  }
  return res;
}

export function empreinte(): Promise<Record<string, string>> {
  return empreinteReferentiel((sql) => connexion().query(sql) as Promise<{ rows: { l: string }[] }>);
}

/**
 * TEMOIN de la sonde : modifier un troncon dans une transaction ANNULEE change l'empreinte. Sans lui, une empreinte
 * constante pourrait venir d'une sonde aveugle (colonne ignoree, table vide).
 */
export async function empreinteSensible(): Promise<{ avant: Record<string, string>; pendant: Record<string, string>; apres: Record<string, string> }> {
  const avant = await empreinte();
  const client = await connexion().connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE troncons SET nom = nom || ' (temoin)' WHERE id = (SELECT id FROM troncons ORDER BY id LIMIT 1)`);
    await client.query(`UPDATE portions SET "largeurM" = coalesce("largeurM", 0) + 1 WHERE id = (SELECT id FROM portions ORDER BY id LIMIT 1)`);
    await client.query(`UPDATE ouvrages SET nom = nom || ' (temoin)' WHERE id = (SELECT id FROM ouvrages ORDER BY id LIMIT 1)`);
    const pendant = await empreinteReferentiel((sql) => client.query(sql) as Promise<{ rows: { l: string }[] }>);
    await client.query("ROLLBACK");
    const apres = await empreinte();
    return { avant, pendant, apres };
  } finally {
    client.release();
  }
}
