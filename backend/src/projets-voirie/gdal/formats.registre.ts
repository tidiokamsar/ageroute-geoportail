/**
 * REGISTRE DES FORMATS GDAL ANNONCES PAR L'API (lot B2). Un format n'est annonce `SUPPORTE` que s'il a un test REEL de bout en bout (voir `TESTS_REELS` :
 * le banc `tests-integration/gdal-jobs.integration.mts` envoie un fichier synthetique par l'API, le fait convertir par le VRAI conteneur, puis le depose) ET que
 * l'interrupteur est actif ET que le dossier d'echange est accessible. Sinon `INDISPONIBLE`, avec la raison. Un test unitaire verifie que chaque preuve citee
 * existe dans le banc.
 */

import { spoolRacine, reglagesGdal } from "./config";
import { ENTITES_DXF_SUPPORTEES, UNITES_DXF, type FormatGdal } from "./contrat.noyau";
import type { Disponibilite } from "./jobs.service";

/** Preuve de bout en bout : fichier du banc et nom de la verification qui la porte (le texte exact y figure). */
export const TESTS_REELS: Readonly<Record<FormatGdal, { fichier: string; verification: string }>> = {
  GPKG: { fichier: "backend/tests-integration/gdal-jobs.integration.mts", verification: "E2E GPKG" },
  SHAPEFILE: { fichier: "backend/tests-integration/gdal-jobs.integration.mts", verification: "E2E SHAPEFILE" },
  DXF: { fichier: "backend/tests-integration/gdal-jobs.integration.mts", verification: "E2E DXF" },
};

interface Fiche {
  format: FormatGdal;
  extensions: string[];
  detection: "contenu";
  /** Regle de CRS annoncee a l'interface (jamais devine). */
  crs: string;
  specifique: Record<string, unknown>;
}

const FICHES: readonly Fiche[] = [
  {
    format: "GPKG", extensions: [".gpkg"], detection: "contenu",
    crs: "declare par le fichier ; un CRS projete declare doit etre confirme (epsgSource identique) ; un fichier sans CRS exige epsgSource",
    specifique: { couches: "une couche par table geometrique ; les tables sans geometrie sont ignorees et signalees" },
  },
  {
    format: "SHAPEFILE", extensions: [".zip"], detection: "contenu",
    crs: "epsgSource OBLIGATOIRE (le .prj est lu mais ne vaut jamais confirmation) ; un .prj different est refuse (CRS_CONFLIT)",
    specifique: { archive: "ZIP avec .shp, .shx et .dbf obligatoires pour chaque jeu ; .prj lu ; protections zip-slip et bombe de decompression", couches: "un jeu .shp par couche" },
  },
  {
    format: "DXF", extensions: [".dxf"], detection: "contenu",
    crs: "epsgSource OBLIGATOIRE (un DXF n'a pas de georeferencement) ; unites declarees (unitesDxf) et controlees contre l'en-tete et le CRS, sans mise a l'echelle",
    specifique: {
      texte: "DXF texte (ASCII) seulement ; le DXF binaire est refuse",
      entitesSupportees: [...ENTITES_DXF_SUPPORTEES],
      entitesIgnoreesEtComptees: "blocs (INSERT et definitions), hachures (HATCH), textes (TEXT, MTEXT), points, cercles, arcs, splines, cotes, espace papier : ignores et comptes dans l'inventaire",
      couches: "les calques sont les couches du wizard (calque:<nom>) et sont inventories avec leurs comptes",
      unitesDxf: [...UNITES_DXF],
    },
  },
];

export interface FormatGdalAnnonce extends Fiche {
  etat: "SUPPORTE" | "INDISPONIBLE";
  raison: string | null;
  preuve: { fichier: string; verification: string };
}

export function formatsGdalAnnonces(d: Disponibilite): { actif: boolean; disponible: boolean; raison: string | null; formats: FormatGdalAnnonce[]; limites: Record<string, number> | null; spoolConfigure: boolean } {
  const reg = reglagesGdal();
  return {
    actif: d.actif, disponible: d.disponible, raison: d.raison,
    spoolConfigure: spoolRacine() !== null,
    formats: FICHES.map((f) => ({
      ...f,
      etat: d.actif && d.disponible ? "SUPPORTE" : "INDISPONIBLE",
      raison: d.actif && d.disponible ? null : d.raison,
      preuve: TESTS_REELS[f.format],
    })),
    // Limites annoncees seulement quand le traitement est actif : desactive, rien ne depend du conteneur.
    limites: d.actif ? {
      delaiJobS: reg.delaiJobS, objetsMax: reg.objetsMax, sortieOctetsMax: reg.sortieOctetsMax, entreeOctetsMax: reg.entreeOctetsMax, tentativesMax: reg.tentativesMax,
      retentionH: reg.retentionH, actifsParCompte: reg.actifsParCompte, actifsParProjet: reg.actifsParProjet, fileMax: reg.fileMax, creationsParHeure: reg.creationsParHeure,
    } : null,
  };
}
