import { nettoyer } from "./lib/donnees";

/**
 * Fin de lancement : detruit `essai_e2e` et les identifiants generes. Les sorties de test (traces des
 * echecs) sont gardees dans le dossier temporaire. `E2E_CONSERVER=1` garde aussi la base et les
 * identifiants, pour inspecter l'etat apres un echec (le lancement suivant la recree de toute facon).
 */
export default async function globalTeardown(): Promise<void> {
  if (process.env.E2E_CONSERVER) {
    console.log("E2E_CONSERVER : base essai_e2e et identifiants conserves (voir docs/e2e/README.md pour le nettoyage).");
    return;
  }
  await nettoyer();
}
