/**
 * Reglages du lot A1 (formats ouverts, CRS, apercu). Meme regle que `config.ts` : une valeur absente, illisible ou hors des bornes redonne
 * le defaut, un mauvais reglage ne peut ni supprimer un plafond ni le rendre absurde. Les valeurs par defaut sont des BORNES DE PROTECTION,
 * pas des seuils metier : elles sont a valider par le DSI. Contrat : docs/projets-voirie/CONTRAT-IMPORT.md, section 12.
 *
 *   PROJETS_VOIRIE_CRS_SOURCE_AUTORISES              defaut 4326,32628,32629   liste blanche des CRS source choisis par l'utilisateur
 *   PROJETS_VOIRIE_CONSERVER_ORIGINAL                defaut non                `non` (empreinte seule, comportement du socle) ou `oui`
 *   PROJETS_VOIRIE_ARCHIVE_ENTREES_MAX               defaut 100                (1 a 1 000)
 *   PROJETS_VOIRIE_ARCHIVE_TAILLE_DECOMPRESSEE_MAX   defaut 104 857 600        (1 Mo a 1 Go)
 *   PROJETS_VOIRIE_ARCHIVE_TAUX_MAX                  defaut 100                (2 a 1 000)
 *   PROJETS_VOIRIE_CSV_LIGNES_MAX                    defaut 500 000            (100 a 5 000 000)
 *   PROJETS_VOIRIE_APERCU_ECHANTILLON                defaut 20                 (1 a 100)
 *   PROJETS_VOIRIE_DELAI_APERCU_MS                   defaut 30 000             (1 000 a 300 000)
 *   PROJETS_VOIRIE_LANDXML_TOLERANCE_ARC_MM          defaut 10                 (1 a 1 000) lot D1 : fleche maximale (mm) entre un arc LandXML et ses cordes
 */

import { sommetsParFichierMax, sommetsParObjetMax } from "../config";
import { TAILLE_MAX_OCTETS } from "../lecture.types";
import { configurationEnCache } from "../territoires/configuration.cache";
import { CRS_PAR_DEFAUT, listeCrsEnv } from "../territoires/configuration.noyau";
import type { LimitesCsv } from "./csv.noyau";
import type { LimitesImport } from "./lecture-import.noyau";
import type { LimitesZip } from "./zip.noyau";

function borne(nom: string, defaut: number, min: number, max: number): number {
  const brut = process.env[nom];
  if (brut === undefined || brut.trim() === "") return defaut;
  const v = Number(brut);
  return Number.isInteger(v) && v >= min && v <= max ? v : defaut;
}

// Lot T1 : la liste par defaut vit dans le noyau de configuration (une seule definition) ; reexportee pour les appelants historiques.
export { CRS_PAR_DEFAUT } from "../territoires/configuration.noyau";

/**
 * Liste blanche des CRS source qu'un utilisateur peut choisir. Une entree illisible fait revenir a la liste par defaut en entier.
 * Lot T1 : resolution environnement > configuration en base (derniere lecture en cache) > defaut ; les services asynchrones passent par
 * `contexteSpatialDuProjet` (territoires/contexte-spatial.ts), qui rafraichit le cache avant de lire.
 */
export function crsSourceAutorises(): number[] {
  const env = listeCrsEnv(process.env.PROJETS_VOIRIE_CRS_SOURCE_AUTORISES);
  if (env) return env;
  const base = configurationEnCache()?.CRS_IMPORT_LISTE_BLANCHE.epsg;
  return base ? [...base] : [...CRS_PAR_DEFAUT];
}

export type ModeConservation = "EMPREINTE_SEULE" | "STOCKE";
/** Decision de retention NON PRISE : le defaut est le comportement du socle (empreinte et taille seules). */
export function modeConservationOriginal(): ModeConservation {
  return (process.env.PROJETS_VOIRIE_CONSERVER_ORIGINAL ?? "").trim().toLowerCase() === "oui" ? "STOCKE" : "EMPREINTE_SEULE";
}

export const limitesZip = (): LimitesZip => ({
  entreesMax: borne("PROJETS_VOIRIE_ARCHIVE_ENTREES_MAX", 100, 1, 1_000),
  tailleEntreeMax: TAILLE_MAX_OCTETS,
  tailleTotaleMax: borne("PROJETS_VOIRIE_ARCHIVE_TAILLE_DECOMPRESSEE_MAX", 100 * 1024 * 1024, 1024 * 1024, 1024 * 1024 * 1024),
  tauxMax: borne("PROJETS_VOIRIE_ARCHIVE_TAUX_MAX", 100, 2, 1_000),
  profondeurMax: 8,
});

export const limitesCsv = (): LimitesCsv => ({
  lignesMax: borne("PROJETS_VOIRIE_CSV_LIGNES_MAX", 500_000, 100, 5_000_000),
  colonnesMax: 200,
  celluleMax: 10_000,
  // O5 : 24 Mo de cellules vides tenaient ~536 Mo de memoire ; 5 000 000 de cellules au plus (defaut a valider par le DSI, borne de protection).
  cellulesMax: borne("PROJETS_VOIRIE_CSV_CELLULES_MAX", 5_000_000, 10_000, 100_000_000),
});

export const tailleEchantillon = () => borne("PROJETS_VOIRIE_APERCU_ECHANTILLON", 20, 1, 100);
export const delaiApercuMs = () => borne("PROJETS_VOIRIE_DELAI_APERCU_MS", 30_000, 1_000, 300_000);
/** Sommets au-dela desquels une geometrie de l'echantillon est decimee. */
export const SOMMETS_ECHANTILLON_MAX = 500;
/** Elements de la liste de rejets, de problemes et d'exemples renvoyes au plus. */
export const LISTE_MAX = 50;

/** Toutes les limites de lecture du lot A1, lues dans l'environnement a chaque appel (un reglage change sans redemarrage des tests). */
export const limitesImport = (): LimitesImport => ({
  lecture: { sommetsParObjet: sommetsParObjetMax(), sommetsParFichier: sommetsParFichierMax() },
  zip: limitesZip(),
  csv: limitesCsv(),
  crsAutorises: crsSourceAutorises(),
  landxml: { toleranceArcM: toleranceArcLandXmlMm() / 1000 },
});

/** Lot D1 : tolerance de discretisation des arcs d'un LandXML, en millimetres (borne de protection, a valider par le DSI). */
export const toleranceArcLandXmlMm = () => borne("PROJETS_VOIRIE_LANDXML_TOLERANCE_ARC_MM", 10, 1, 1_000);
