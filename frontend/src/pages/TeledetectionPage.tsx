import { EcranObservationTerre } from "../components/observation-terre/EcranObservationTerre";

/**
 * Observation de la Terre : propositions de teledetection, carte, sources et verdict du terrain.
 *
 * Point d'entree de la route `/teledetection`. L'ecran vit dans
 * `components/observation-terre/` ; les regles d'integrite qu'il respecte sont dans
 * `docs/observation-terre/CONTRAT-API-UI.md` :
 *
 * - **Une proposition n'est pas un fait.** Elle reste « a verifier » jusqu'a ce qu'un constat de
 *   terrain la confirme ou l'infirme ; aucune ne modifie le referentiel.
 * - **Un indice n'est pas une probabilite**, sauf calibrage declare par le serveur.
 * - **Le taux de confirmation terrain n'est pas la precision statistique** de la detection.
 * - **Rien n'est telecharge ni traite ici** : produits et propositions arrivent par l'API.
 */
export function TeledetectionPage() {
  return <EcranObservationTerre />;
}
