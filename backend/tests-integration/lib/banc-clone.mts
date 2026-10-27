/**
 * Ouverture d'un banc qui COMMITTE : clone jetable de `replay`, environnement du serveur pose
 * AVANT tout import du code applicatif, et chargeur de modules.
 *
 * Meme principe que `curseur.integration.mts`, mis en commun pour les bancs qui font passer le
 * code par ses routes reelles (jetons signes, autorisation lue en base, audit transactionnel).
 *
 *  - La cible est exigee locale ET nommee `replay` (la garde l'a deja verifie a l'import) ; le
 *    clone est cree sous le nom demande (`essai_<nom>`) et detruit par `fermer()`.
 *  - Les secrets de signature des jetons sont tires au hasard a chaque lancement, en memoire.
 *    Aucun secret n'est ecrit nulle part, et un jeton de banc ne vaut rien en dehors du processus.
 *  - `migrations` : dossiers de `prisma/migrations` a appliquer AU CLONE avant le banc, pour une
 *    migration plus recente que `replay`. `replay` n'est jamais ecrite. Une migration deja presente
 *    (objet existant) est ignoree : le banc reste rejouable quand `replay` aura ete mise a jour.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { evaluerCible } from "./garde.ts";
import { creerClone, supprimerClone, urlClone } from "./clone.ts";

export interface BancClone {
  /** Charge un module de `src/` APRES la bascule de DATABASE_URL vers le clone. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  imp: (chemin: string) => Promise<any>;
  fermer: () => Promise<void>;
  nomClone: string;
  urlClone: string;
}

/** Codes PostgreSQL « l'objet existe deja » : duplicate_object, duplicate_table, duplicate_column. */
const DEJA_PRESENT = new Set(["42710", "42P07", "42701"]);

export async function appliquerMigrations(url: string, dossiers: string[]): Promise<void> {
  const { Client } = (await import("pg")).default;
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    for (const dossier of dossiers) {
      const chemin = fileURLToPath(new URL(`../../prisma/migrations/${dossier}/migration.sql`, import.meta.url));
      try {
        await client.query(readFileSync(chemin, "utf8"));
        console.log(`Migration appliquee au clone : ${dossier}`);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code && DEJA_PRESENT.has(code)) console.log(`Migration deja presente dans replay : ${dossier}`);
        else throw e;
      }
    }
  } finally {
    await client.end();
  }
}

export async function ouvrirBancClone(nomClone: string, options: { migrations?: string[] } = {}): Promise<BancClone> {
  const origine = process.env.DATABASE_URL;
  const cible = evaluerCible(origine);
  if (!cible.ok || cible.base !== "replay") {
    console.error("Banc d'integration refuse : DATABASE_URL doit etre une base locale nommee replay (le clone est cree par le banc).");
    process.exit(3);
  }
  await creerClone(origine!, nomClone);
  const url = urlClone(origine!, nomClone);
  if (options.migrations?.length) await appliquerMigrations(url, options.migrations);
  process.env.DATABASE_URL = url;
  process.env.JWT_ACCESS_SECRET = randomBytes(32).toString("hex");
  process.env.JWT_REFRESH_SECRET = randomBytes(32).toString("hex");
  process.env.NODE_ENV = "test";
  console.log(`Cible du banc : clone jetable ${nomClone}`);

  const racine = new URL("../src/", pathToFileURL(process.argv[1]).href).href;
  return {
    imp: (chemin) => import(racine + chemin + ".ts"),
    fermer: async () => {
      process.env.DATABASE_URL = origine!;
      await supprimerClone(origine!, nomClone);
    },
    nomClone,
    urlClone: url,
  };
}
