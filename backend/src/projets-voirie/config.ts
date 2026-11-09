/**
 * Reglages du module Projets de voirie et reseaux : delais cote BASE et plafonds, bornes et configurables par variable
 * d'environnement (revue de securite, M2). Une valeur absente, illisible ou hors des bornes redonne le defaut : un mauvais reglage
 * ne peut ni supprimer un delai ni le rendre absurde.
 *
 *   PROJETS_VOIRIE_DELAI_ANALYSE_MS   defaut 20 000   (bornes 1 000 a 300 000)   `statement_timeout` de l'analyse et de l'export CSV
 *   PROJETS_VOIRIE_DELAI_CARTE_MS     defaut 10 000   (bornes 1 000 a 120 000)   `statement_timeout` de la carte
 *   PROJETS_VOIRIE_DELAI_DEPOT_MS     defaut 60 000   (bornes 5 000 a 600 000)   `statement_timeout` de chaque requete d'un depot
 *   PROJETS_VOIRIE_VERROU_MS          defaut 5 000    (bornes 500 a 60 000)      `lock_timeout` (attente du verrou du projet)
 *   PROJETS_VOIRIE_SOMMETS_PAR_OBJET  defaut 100 000  (bornes 1 000 a 1 000 000)
 *   PROJETS_VOIRIE_SOMMETS_PAR_FICHIER defaut 2 000 000 (bornes 10 000 a 10 000 000)
 *   PROJETS_VOIRIE_CONFLITS_MAX       defaut 20 000   (bornes 100 a 100 000)       conflits au plus par analyse persistee (422 ANALYSE_TROP_VOLUMINEUSE)
 *   PROJETS_VOIRIE_ANALYSE_INTERVALLE_S defaut 60     (bornes 0 a 3 600)           delai minimal entre deux analyses TERMINEES d un meme projet (429 ANALYSE_TROP_FREQUENTE) ;
 *                                                     0 desactive le delai (bancs d essai ; jamais en production). Une analyse en ECHEC ne compte pas.
 *
 * POURQUOI CES DEFAUTS. Le delai de transaction de Prisma est un delai CLIENT : il ferme la transaction cote application mais la
 * requete continue dans PostgreSQL (415 s de calcul pour un delai de 120 s dans la revue). `SET LOCAL statement_timeout` coupe la
 * requete dans la base. 20 s pour l'analyse et 10 s pour la carte : une analyse de projet urbain (quelques dizaines d'axes, quelques
 * milliers d'objets) prend moins d'une seconde (banc : 118 verifications) ; au-dela de 20 s, on refuse plutot que de monopoliser une
 * connexion partagee avec l'authentification. 60 s par requete de depot : un lot de 500 objets s'insere en quelques secondes.
 * Plafonds de sommets : un cable de 100 km releve au metre fait 100 000 sommets (un objet legitime ne depasse pas cela) ; 2 millions
 * de sommets par fichier correspondent a la limite de 25 Mo en GeoJSON compact (environ 12 octets par position).
 */

import { protectionEnCache } from "./territoires/configuration.cache";
import { PROTECTIONS_BORNES, entierEnv, type Protection } from "./territoires/configuration.noyau";

/**
 * Lot T1 : RESOLUTION environnement > configuration en base > defaut (CONTRAT-TERRITOIRES.md, section 6). La valeur en base est celle de la
 * derniere lecture du cache (`territoires/configuration.cache.ts`, rafraichi par les services asynchrones avant tout calcul) ; une valeur
 * hors bornes, d'ou qu'elle vienne, est ignoree. Sans administration, le comportement est celui d'avant.
 */
const PROTECTION_PAR_ENV = new Map<string, Protection>(Object.entries(PROTECTIONS_BORNES).map(([k, b]) => [b.env, k as Protection]));

function borne(nom: string, defaut: number, min: number, max: number): number {
  const env = entierEnv(process.env[nom], min, max);
  if (env !== undefined) return env;
  const protection = PROTECTION_PAR_ENV.get(nom);
  const base = protection ? protectionEnCache(protection) : undefined;
  if (base !== undefined && Number.isInteger(base) && base >= min && base <= max) return base;
  return defaut;
}

export const delaiAnalyseMs = () => borne("PROJETS_VOIRIE_DELAI_ANALYSE_MS", 20_000, 1_000, 300_000);
export const delaiCarteMs = () => borne("PROJETS_VOIRIE_DELAI_CARTE_MS", 10_000, 1_000, 120_000);
export const delaiDepotMs = () => borne("PROJETS_VOIRIE_DELAI_DEPOT_MS", 60_000, 5_000, 600_000);
export const delaiVerrouMs = () => borne("PROJETS_VOIRIE_VERROU_MS", 5_000, 500, 60_000);
export const sommetsParObjetMax = () => borne("PROJETS_VOIRIE_SOMMETS_PAR_OBJET", 100_000, 1_000, 1_000_000);
export const conflitsParAnalyseMax = () => borne("PROJETS_VOIRIE_CONFLITS_MAX", 20_000, 100, 100_000);
/** Une analyse persistee cree une ligne immuable et une ligne d audit meme sans changement : une par minute et par projet suffit (revue RC-3, m8). */
export const analyseIntervalleMinS = () => borne("PROJETS_VOIRIE_ANALYSE_INTERVALLE_S", 60, 0, 3_600);
export const sommetsParFichierMax = () => borne("PROJETS_VOIRIE_SOMMETS_PAR_FICHIER", 2_000_000, 10_000, 10_000_000);

/** Fenetre pendant laquelle une meme consultation d'un jeu sensible par un meme compte n'est tracee qu'une fois. */
export const FENETRE_CONSULTATION_MIN = 15;

/** Lecteur d'entier borne de l'environnement, partage avec le workflow (lot B3, `workflow/config.ts`) : une valeur absente ou hors bornes redonne le defaut. */
export { borne as borneEnv };

// ------------------------------------------------------------------------------------------------
// Lot S1 : sources multiples et comparaison entre sources (contrat : docs/projets-voirie/CONTRAT-SOURCES.md).
//   PROJETS_VOIRIE_COMPARAISON_OBJETS_MAX     defaut 20 000 (bornes 100 a 200 000) : objets lineaires au plus pour les deux jeux compares (422 COMPARAISON_TROP_VOLUMINEUSE)
//   PROJETS_VOIRIE_COMPARAISON_INTERVALLE_S   defaut 60     (bornes 0 a 3 600)     : delai minimal entre deux comparaisons TERMINEES d un meme projet (429 COMPARAISON_TROP_FREQUENTE) ;
//                                                                                    0 desactive le delai (bancs d essai ; jamais en production). Une comparaison en ECHEC ne compte pas.
// ------------------------------------------------------------------------------------------------

export const comparaisonObjetsMax = () => borne("PROJETS_VOIRIE_COMPARAISON_OBJETS_MAX", 20_000, 100, 200_000);
export const comparaisonIntervalleMinS = () => borne("PROJETS_VOIRIE_COMPARAISON_INTERVALLE_S", 60, 0, 3_600);

/**
 * Methodes d acquisition d un jeu (`projets_voirie_jeux.methodeAcquisition`) : correctifs T1+S1 (M2), la SEULE source de verite est le referentiel
 * METHODE_ACQUISITION du lot T1 (administrable, aucune liste dans le code). Le code ne connait que la FORME d un code, celle que la base impose a la
 * colonne (contrainte `pvj_methode_acquisition_forme`) ; la valeur est verifiee contre le referentiel par le depot (active) et par la base (non retiree).
 */
export const FORME_METHODE_ACQUISITION = /^[A-Z][A-Z0-9_]{1,39}$/;
export const estFormeMethodeAcquisition = (v: unknown): v is string => typeof v === "string" && FORME_METHODE_ACQUISITION.test(v);
