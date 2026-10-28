/**
 * Nettoyage manuel apres un lancement interrompu ou conserve (`E2E_CONSERVER=1`) :
 *   cd frontend && node ../backend/node_modules/tsx/dist/cli.mjs --tsconfig ../e2e-eo/tsconfig.json ../e2e-eo/scripts/nettoyer.ts [--tout]
 * Detruit la base `essai_eo_e2e` et les identifiants generes. `--tout` supprime aussi le dossier temporaire du harnais (sorties de
 * test, cache de Vite). Ne touche jamais a un modele ni a une autre base.
 */
import { nettoyer } from "../lib/donnees";
import { DOSSIER_RUN, PORT_API, PORT_WEB } from "../lib/env";
import { libererPort } from "../lib/ports";

// Arrete aussi les serveurs orphelins des ports 3401 et 5410.
console.log(`Serveurs arretes : API ${libererPort(PORT_API)}, Vite ${libererPort(PORT_WEB)}`);

nettoyer(process.argv.includes("--tout"))
  .then(() => console.log(`Nettoye : base essai_eo_e2e et identifiants${process.argv.includes("--tout") ? `, dossier ${DOSSIER_RUN}` : ""}.`))
  .catch((e) => { console.error("Nettoyage impossible :", e instanceof Error ? e.message : e); process.exit(1); });
