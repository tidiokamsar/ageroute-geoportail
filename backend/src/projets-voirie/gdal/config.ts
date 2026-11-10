/**
 * Reglages de la conversion GDAL (lot B2). MEME REGLE que `../config.ts` : une valeur absente, illisible ou hors des bornes redonne le defaut ; un mauvais
 * reglage ne peut ni supprimer un plafond ni le rendre absurde. Les defauts sont des BORNES DE PROTECTION, pas des seuils metier : a valider par le DSI.
 *
 *   PROJETS_VOIRIE_GDAL                       defaut ABSENT = DESACTIVE    interrupteur (`1`, `oui`, `true`, `on`) ; desactive : aucune dependance au conteneur
 *   PROJETS_VOIRIE_GDAL_SPOOL                 aucun defaut                 racine du spool partage avec le conteneur (sous-dossiers `entree/` et `sortie/`)
 *   PROJETS_VOIRIE_GDAL_DELAI_S               defaut 90   (10 a 120)       delai total d'un job cote conteneur (`limites.delai_s`)
 *   PROJETS_VOIRIE_GDAL_SORTIE_MAX_OCTETS     defaut 80 Mo (1 a 200 Mo)    octets de GeoJSON qu'un job peut produire (cote conteneur ET cote backend)
 *   PROJETS_VOIRIE_GDAL_TENTATIVES            defaut 3    (1 a 5)          tentatives d'un job perdu ou interrompu
 *   PROJETS_VOIRIE_GDAL_RETENTION_H           defaut 24   (1 a 72)         duree de vie des fichiers du spool d'un job (le conteneur purge a 72 h)
 *   PROJETS_VOIRIE_GDAL_SONDAGE_S             defaut 3    (1 a 60)         periode du sondage du spool
 *   PROJETS_VOIRIE_GDAL_CONCURRENCE           defaut 2    (1 a 4)          jobs transmis en meme temps au conteneur (il les traite un par un)
 *   PROJETS_VOIRIE_GDAL_ACTIFS_COMPTE         defaut 2    (1 a 10)         jobs actifs (EN_ATTENTE ou EN_COURS) par compte
 *   PROJETS_VOIRIE_GDAL_ACTIFS_PROJET         defaut 3    (1 a 20)         jobs actifs par projet
 *   PROJETS_VOIRIE_GDAL_FILE_MAX              defaut 20   (1 a 200)        jobs EN_ATTENTE au total
 *   PROJETS_VOIRIE_GDAL_CREATIONS_HEURE       defaut 12   (1 a 200)        creations de jobs par heure, par compte ET par projet (cadence)
 *   PROJETS_VOIRIE_GDAL_RESULTATS_MAX         defaut 20   (1 a 500)        jobs TERMINE non encore utilises, au total (chacun garde jusqu'a sortieOctetsMax dans le spool)
 *   PROJETS_VOIRIE_GDAL_DELAI_TOUR_S          defaut 120  (1 a 600)        budget de temps d'un tour du sondage (garde contre un acces au spool qui bloque)
 *   PROJETS_VOIRIE_GDAL_PRIVE                 defaut <spool>/prive         dossier PRIVE du backend ou le fichier attend sa reclamation (jamais monte dans le conteneur)
 *
 * Le conteneur n'est JAMAIS sollicite tant que l'interrupteur est desactive : ni au demarrage, ni dans les routes (voir `disponibilite()` de `jobs.service.ts`).
 */

import { OBJETS_MAX, TAILLE_MAX_OCTETS } from "../lecture.types";
import { borneEnv } from "../config";

const UN_MO = 1024 * 1024;

/** Interrupteur : DESACTIVE par defaut. Lu a chaque appel (un reglage change sans redemarrage des tests). */
export function gdalActif(): boolean {
  return ["1", "oui", "true", "on"].includes((process.env.PROJETS_VOIRIE_GDAL ?? "").trim().toLowerCase());
}

/** Racine du spool, ou `null` si elle n'est pas configuree. */
export function spoolRacine(): string | null {
  const v = (process.env.PROJETS_VOIRIE_GDAL_SPOOL ?? "").trim();
  return v === "" || v.includes("\u0000") ? null : v;
}

/** Dossier prive du backend (M2 de la revue), ou `null` pour le defaut `<spool>/prive`. */
export function spoolPrive(): string | null {
  const v = (process.env.PROJETS_VOIRIE_GDAL_PRIVE ?? "").trim();
  return v === "" || v.includes("\u0000") ? null : v;
}

export interface ReglagesGdal {
  delaiJobS: number;
  /** Plafond d'objets demande au conteneur (jamais au-dessus du plafond du module). */
  objetsMax: number;
  sortieOctetsMax: number;
  /** Taille maximale du fichier depose (alignee sur la reception du module). */
  entreeOctetsMax: number;
  tentativesMax: number;
  retentionH: number;
  sondageS: number;
  concurrence: number;
  actifsParCompte: number;
  actifsParProjet: number;
  fileMax: number;
  creationsParHeure: number;
  /** Jobs TERMINE non utilises conserves au total (chacun retient sa sortie dans le spool jusqu'a usage ou expiration). */
  resultatsMax: number;
  /** Budget d'un tour du sondage, en secondes. */
  delaiTourS: number;
}

export function reglagesGdal(): ReglagesGdal {
  return {
    delaiJobS: borneEnv("PROJETS_VOIRIE_GDAL_DELAI_S", 90, 10, 120),
    objetsMax: OBJETS_MAX,
    sortieOctetsMax: borneEnv("PROJETS_VOIRIE_GDAL_SORTIE_MAX_OCTETS", 80 * UN_MO, UN_MO, 200 * UN_MO),
    entreeOctetsMax: TAILLE_MAX_OCTETS,
    tentativesMax: borneEnv("PROJETS_VOIRIE_GDAL_TENTATIVES", 3, 1, 5),
    retentionH: borneEnv("PROJETS_VOIRIE_GDAL_RETENTION_H", 24, 1, 72),
    sondageS: borneEnv("PROJETS_VOIRIE_GDAL_SONDAGE_S", 3, 1, 60),
    concurrence: borneEnv("PROJETS_VOIRIE_GDAL_CONCURRENCE", 2, 1, 4),
    actifsParCompte: borneEnv("PROJETS_VOIRIE_GDAL_ACTIFS_COMPTE", 2, 1, 10),
    actifsParProjet: borneEnv("PROJETS_VOIRIE_GDAL_ACTIFS_PROJET", 3, 1, 20),
    fileMax: borneEnv("PROJETS_VOIRIE_GDAL_FILE_MAX", 20, 1, 200),
    creationsParHeure: borneEnv("PROJETS_VOIRIE_GDAL_CREATIONS_HEURE", 12, 1, 200),
    resultatsMax: borneEnv("PROJETS_VOIRIE_GDAL_RESULTATS_MAX", 20, 1, 500),
    delaiTourS: borneEnv("PROJETS_VOIRIE_GDAL_DELAI_TOUR_S", 120, 1, 600),
  };
}

/** Plafond par acces court au spool (lecture d'un statut, purge, copie) a l'interieur du budget d'un tour. */
export const DELAI_ACCES_SPOOL_MS = 10_000;

/** Marge ajoutee au delai du conteneur avant de considerer un job comme perdu (file d'attente derriere les autres jobs comprise). */
export const MARGE_PERTE_S = 30;
