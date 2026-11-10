/**
 * CONTEXTE SPATIAL d'un projet : ce que la configuration nationale et le territoire du projet decident pour la lecture des fichiers et les
 * calculs (CONTRAT-TERRITOIRES.md, section 6, « Territoire du projet »).
 *
 *   - `zoneNationale` : emprise de plausibilite configuree (au-dela, un element est ECARTE : codes historiques ELEMENTS_HORS_GUINEE / HORS_GUINEE) ;
 *   - `zoneTerritoire` : boite englobante de l'emprise du territoire du projet (ou du plus proche ancetre qui en porte une) : zone attendue de
 *     la plausibilite, jamais un motif d'ecart (emprise approximative) ;
 *   - `epsgPour(longitude)` : CRS metrique impose par le territoire (le sien ou celui du plus proche ancetre), sinon la regle par bandes ;
 *   - `crsAutorises` : liste blanche effective (environnement > base > defaut).
 *
 * Remplace les constantes BBOX_GUINEE et epsgPourLongitude dans les services. Sans territoire (projet inexistant, appel hors projet), le
 * contexte national seul s'applique.
 */

import { prisma } from "../../lib/prisma";
import type { Bbox } from "../lecture.types";
import { configurationCourante, listeBlancheEffective } from "./configuration.service";
import { epsgPourLongitudeSelon, type Zone } from "./configuration.noyau";

export interface ContexteSpatial {
  zoneNationale: Zone;
  zoneTerritoire: Zone | null;
  /** Identifiant du territoire du projet (nul hors projet ou projet sans territoire). */
  territoireId: string | null;
  crsImpose: number | null;
  epsgDefaut: number;
  epsgPour: (longitude: number) => number;
  crsAutorises: number[];
}

interface LigneTerritoireSpatial { id: string; nom: string; crs: number | null; ouest: number | null; sud: number | null; est: number | null; nord: number | null }

/**
 * Territoire du projet et ses ancetres, du plus proche au plus lointain, avec la boite englobante de leur emprise : le premier CRS et la
 * premiere emprise rencontres l'emportent. Un projet retire ou sans territoire ne rend rien.
 */
async function territoiresDuProjet(projetId: string): Promise<LigneTerritoireSpatial[]> {
  return prisma.$queryRaw<LigneTerritoireSpatial[]>`
    SELECT a."id", a."nom", a."crsMetriqueEpsg" AS "crs",
           ST_XMin(a."emprise") AS "ouest", ST_YMin(a."emprise") AS "sud", ST_XMax(a."emprise") AS "est", ST_YMax(a."emprise") AS "nord"
      FROM "projets_voirie" p
      JOIN "territoires_voirie" t ON t."id" = p."territoireId"
      JOIN "territoires_voirie" a ON t."chemin" LIKE a."chemin" || '%'
     WHERE p."id" = ${projetId} AND p."deletedAt" IS NULL
     ORDER BY a."profondeur" DESC`;
}

export async function contexteNational(): Promise<ContexteSpatial> {
  const c = await configurationCourante();
  const bandes = c.CRS_METRIQUE_BANDES;
  return {
    zoneNationale: { nom: c.EMPRISE_PLAUSIBILITE.nom, bbox: [...c.EMPRISE_PLAUSIBILITE.bbox] as Bbox },
    zoneTerritoire: null, territoireId: null, crsImpose: null, epsgDefaut: bandes.epsgDefaut,
    epsgPour: (lon) => epsgPourLongitudeSelon(bandes, lon),
    crsAutorises: listeBlancheEffective(c).valeur,
  };
}

export async function contexteSpatialDuProjet(projetId: string): Promise<ContexteSpatial> {
  const national = await contexteNational();
  const chaine = await territoiresDuProjet(projetId);
  if (chaine.length === 0) return national;
  const avecCrs = chaine.find((t) => t.crs !== null && t.crs !== undefined);
  const avecEmprise = chaine.find((t) => t.ouest !== null && t.sud !== null && t.est !== null && t.nord !== null);
  // Un CRS impose doit rester dans la liste blanche effective : sinon il est ignore (la regle par bandes s'applique) ; le service d'ecriture le refuse en amont.
  const crsImpose = avecCrs && national.crsAutorises.includes(Number(avecCrs.crs)) ? Number(avecCrs.crs) : null;
  return {
    ...national,
    territoireId: chaine[0].id,
    zoneTerritoire: avecEmprise ? { nom: avecEmprise.nom, bbox: [Number(avecEmprise.ouest), Number(avecEmprise.sud), Number(avecEmprise.est), Number(avecEmprise.nord)] } : null,
    crsImpose,
    epsgDefaut: crsImpose ?? national.epsgDefaut,
    epsgPour: crsImpose !== null ? () => crsImpose : national.epsgPour,
  };
}
