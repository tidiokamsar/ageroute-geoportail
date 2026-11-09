/**
 * CACHE EN MEMOIRE de la configuration nationale (sans base, sans E/S) : la derniere configuration chargee et son age. Separe du service
 * (qui parle a Prisma) pour que `config.ts`, importe partout, puisse lire une valeur de PROTECTION de facon synchrone sans dependre de la base.
 *
 *   - `configurationEnCache()` : la derniere configuration lue, ou `null` avant le premier chargement ;
 *   - `estPerime()` : vrai apres la fenetre (`PROJETS_VOIRIE_CONFIG_CACHE_MS`, defaut 30 s, 1 s a 10 min) ou apres une invalidation ;
 *   - `poser()` / `invalider()` : par le service, a chaque lecture en base et a chaque ecriture.
 */

import { DEFAUTS, type Cle, type ValeurDe } from "./configuration.noyau";

export type ConfigurationLue = { [K in Cle]: ValeurDe<K> };
export interface EtatCache { valeurs: ConfigurationLue; chargeLe: number }

let etat: EtatCache | null = null;
let invalide = true;

export function fenetreCacheMs(): number {
  const brut = process.env.PROJETS_VOIRIE_CONFIG_CACHE_MS;
  if (brut === undefined || brut.trim() === "") return 30_000;
  const v = Number(brut);
  return Number.isInteger(v) && v >= 1_000 && v <= 600_000 ? v : 30_000;
}

export const configurationEnCache = (): ConfigurationLue | null => etat?.valeurs ?? null;
export const estPerime = (maintenant = Date.now()): boolean => invalide || etat === null || maintenant - etat.chargeLe > fenetreCacheMs();

export function poser(valeurs: ConfigurationLue, maintenant = Date.now()): void {
  etat = { valeurs, chargeLe: maintenant };
  invalide = false;
}

/** Invalidation (ecriture dans ce processus, ou test) : la prochaine lecture relit la base. */
export function invalider(): void { invalide = true; }

/** Vide le cache (tests). */
export function vider(): void { etat = null; invalide = true; }

/** Valeur d'une protection lue dans la derniere configuration chargee (`undefined` avant chargement ou si la base n'en porte pas). */
export function protectionEnCache(nom: keyof ValeurDe<"PROTECTIONS">): number | undefined {
  return etat?.valeurs.PROTECTIONS[nom];
}

/** Configuration par defaut complete (celle du code), pour un appelant qui n'a rien charge. */
export const configurationParDefaut = (): ConfigurationLue => ({
  EMPRISE_PLAUSIBILITE: { nom: DEFAUTS.EMPRISE_PLAUSIBILITE.nom, bbox: [...DEFAUTS.EMPRISE_PLAUSIBILITE.bbox] as ConfigurationLue["EMPRISE_PLAUSIBILITE"]["bbox"] },
  CRS_METRIQUE_BANDES: { bandes: DEFAUTS.CRS_METRIQUE_BANDES.bandes.map((b) => ({ ...b })), epsgDefaut: DEFAUTS.CRS_METRIQUE_BANDES.epsgDefaut },
  CRS_IMPORT_LISTE_BLANCHE: { epsg: [...DEFAUTS.CRS_IMPORT_LISTE_BLANCHE.epsg] },
  PROTECTIONS: {},
});
