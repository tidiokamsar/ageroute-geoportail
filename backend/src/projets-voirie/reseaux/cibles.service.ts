/**
 * NATURE DE LA CIBLE DES DOSSIERS DE CONFLIT (lot B1, extension minimale de RC-3 : voir CONTRAT-CONFLITS.md, section 9, points 35 et suivants).
 *
 * Pour une liste d'objets de reseau, rend la nature EFFECTIVE (objet, sinon jeu, sinon inconnue) et le support physique du circuit (relations
 * PORTE_PAR validees et proposees dont la cible est dans un jeu AUTORISE, pour tous les roles), puis la qualification du conflit : infrastructure physique,
 * circuit logique porte par une infrastructure validee, simple circuit logique, equipement ou nature inconnue (cible.noyau.ts).
 *
 * C'est une INFORMATION du dossier, calculee a la lecture : elle ne change ni le statut initial, ni la cle, ni la mesure d'un conflit.
 */

import { prisma } from "../../lib/prisma";
import { qualifierCible, type CibleConflit } from "./cible.noyau";
import * as depot from "./reseaux.depot";
import { natureEffective } from "./types.noyau";

/** `objetIds` : identifiants d'objets (texte). Un objet absent de la base est absent du resultat. */
export async function cibleDesObjets(_role: string, objetIds: readonly string[]): Promise<Map<string, CibleConflit>> {
  if (objetIds.length === 0) return new Map();
  // m3 : le role n'intervient plus (les supports ne se comptent que sur des jeux AUTORISE, pour tous) ; le parametre reste pour les appelants.
  const lignes = await depot.cibles(prisma, objetIds);
  return new Map(lignes.map((l) => {
    const n = natureEffective(l.nature, l.natureJeu);
    return [l.objetId, qualifierCible({ nature: n.nature, origineNature: n.origine, nbSupportsValides: l.valides, nbSupportsProposes: l.proposes })] as const;
  }));
}

/** Nombre d'autres objets du meme jeu a la trace strictement identique (circuits superposes). */
export const tracePartageeDe = (objetId: string): Promise<number> => depot.tracePartagee(prisma, objetId);
