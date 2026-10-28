/**
 * Nettoyage manuel apres un lancement interrompu ou conserve (`E2E_CONSERVER=1`) :
 *   node ../backend/node_modules/tsx/dist/cli.mjs --tsconfig ../e2e/tsconfig.json ../e2e/scripts/nettoyer.ts [--tout]
 * Detruit la base `essai_e2e` et les identifiants generes. `--tout` supprime aussi le dossier temporaire du harnais (sorties de
 * test, cache de Vite, extraction de HEAD). Ne touche jamais a `replay` ni a une autre base.
 */
import { nettoyer } from "../lib/donnees";
import { DOSSIER_RUN } from "../lib/env";

nettoyer(process.argv.includes("--tout"))
  .then(() => console.log(`Nettoye : base essai_e2e et identifiants${process.argv.includes("--tout") ? `, dossier ${DOSSIER_RUN}` : ""}.`))
  .catch((e) => { console.error("Nettoyage impossible :", e instanceof Error ? e.message : e); process.exit(1); });
