/**
 * Moteur de catalogue satellitaire : point d'entree. Aucun acces base. L'API (EO-API) consomme ceci
 * et se charge de la persistance (registre des produits, etat des sources).
 */
import { AdaptateurCdseStac } from "./adaptateurs/cdse-stac";
import { AdaptateurEarthSearch } from "./adaptateurs/earth-search";
import { creerFacadePlanetScope, creerFacadeSpot } from "./adaptateurs/facade";
import type { OptionsAdaptateurStac } from "./adaptateurs/commun";
import type { CodeSource, SourceAdaptateur } from "./contrat";

export * from "./contrat";
export * from "./geometrie";
export { ClientHttp, masquerUrl, nettoyerLien, assainirTexte, lireRetryAfter, DEFAUTS_HTTP } from "./http";
export type { EvenementJournal, FetchLike, OptionsClientHttp } from "./http";
export { CompteurRequetes, LIMITES_CDSE, LIMITES_EARTH_SEARCH } from "./quotas";
export { normaliserItemStac, COLLECTIONS_CONNUES, RESOLUTION_S2_PAR_BANDE_M, RESOLUTION_S1_IW_GRDH, isoUtc } from "./normalisation";
export { rechercherStac, construireCorps, validerParams, ZONE_SONDE_PAR_DEFAUT, PLAFOND_DECALAGE_STAC } from "./stac";
export { AdaptateurCdseStac, creerAdaptateurCdseStac, DESCRIPTIF_CDSE, URL_STAC_CDSE } from "./adaptateurs/cdse-stac";
export { AdaptateurEarthSearch, creerAdaptateurEarthSearch, DESCRIPTIF_EARTH_SEARCH, URL_STAC_EARTH_SEARCH } from "./adaptateurs/earth-search";
export { creerFacadePlanetScope, creerFacadeSpot, MESSAGE_FACADE } from "./adaptateurs/facade";
export * from "./selection";

/**
 * Les quatre adaptateurs. Les deux facades ne contactent rien. Les options (fetch, horloge, journal...)
 * s'appliquent aux deux adaptateurs reseau.
 */
export function creerAdaptateurs(options: Omit<OptionsAdaptateurStac, "urlBase"> = {}): Record<CodeSource, SourceAdaptateur> {
  return {
    "cdse-stac": new AdaptateurCdseStac(options),
    "earth-search": new AdaptateurEarthSearch(options),
    planetscope: creerFacadePlanetScope(options.maintenant),
    spot: creerFacadeSpot(options.maintenant),
  };
}
