import { fermerBase } from "./lib/base";
import { nettoyer } from "./lib/donnees";
import { PORT_API, PORT_WEB } from "./lib/env";
import { libererPort } from "./lib/ports";

/**
 * Fin de lancement : detruit `essai_eo_e2e` et les identifiants generes. Les sorties de test (traces des echecs, captures) sont gardees.
 * `E2E_CONSERVER=1` garde aussi la base et les identifiants, pour inspecter l'etat apres un echec (le lancement suivant la recree).
 *
 * L'API (webServer) tient encore des connexions a la base : `DROP DATABASE ... WITH (FORCE)` les coupe.
 */
export default async function globalTeardown(): Promise<void> {
  await fermerBase().catch(() => undefined);
  if (process.env.E2E_CONSERVER) {
    console.log("E2E_CONSERVER : base essai_eo_e2e et identifiants conserves (nettoyage : scripts/nettoyer.ts).");
    return;
  }
  // Serveurs d'abord (ils tiennent la base et le dossier de travail de l'API), puis la base et les identifiants.
  libererPort(PORT_API);
  libererPort(PORT_WEB);
  await nettoyer();
}
