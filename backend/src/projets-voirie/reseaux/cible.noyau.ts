/**
 * NATURE DE LA CIBLE D'UN CONFLIT (noyau pur, lot B1 ; extension minimale des dossiers RC-3, voir CONTRAT-CONFLITS.md section 9).
 *
 * Un dossier de conflit porte sur UN objet de reseau. Selon sa nature, le conflit n'a pas la meme portee :
 *   - avec une INFRASTRUCTURE PHYSIQUE declaree : le support est la ;
 *   - avec un CIRCUIT LOGIQUE porte par une infrastructure physique VALIDEE : c'est l'infrastructure qui est concernee, le circuit n'en
 *     est que l'usage ;
 *   - avec un SIMPLE CIRCUIT LOGIQUE sans support valide : le tracé est celui d'un service, pas celui d'un cable ; la position reelle du
 *     support physique n'est PAS etablie ;
 *   - avec un EQUIPEMENT, ou un objet de nature INCONNUE.
 * Cette qualification est une INFORMATION du dossier : elle ne change ni son statut initial, ni sa cle, ni sa mesure. Elle est calculee a la
 * lecture (nature et relations COURANTES), pas figee par l'analyse.
 */

import type { NatureObjet, OrigineValeur } from "./types.noyau";

export type QualificationCible =
  | "INFRASTRUCTURE_PHYSIQUE"
  | "CIRCUIT_LOGIQUE_SUR_INFRASTRUCTURE_VALIDEE"
  | "CIRCUIT_LOGIQUE_SANS_SUPPORT_VALIDE"
  | "EQUIPEMENT"
  | "NATURE_INCONNUE";

export interface EntreeCible {
  nature: NatureObjet;
  origineNature: OrigineValeur;
  /** Infrastructures physiques reliees au circuit par une relation PORTE_PAR VALIDEE (lisibles par le compte). */
  nbSupportsValides: number;
  /** Propositions PORTE_PAR en attente de validation (lisibles par le compte). */
  nbSupportsProposes: number;
}

export interface CibleConflit {
  nature: NatureObjet;
  origineNature: OrigineValeur;
  qualification: QualificationCible;
  libelle: string;
  /** Renseigne pour un circuit logique seulement. */
  supportPhysique: { valides: number; proposes: number } | null;
}

export function qualifierCible(e: EntreeCible): CibleConflit {
  const base = { nature: e.nature, origineNature: e.origineNature };
  switch (e.nature) {
    case "ACTIF_PHYSIQUE":
      return { ...base, qualification: "INFRASTRUCTURE_PHYSIQUE", libelle: "Conflit avec une infrastructure physique déclarée.", supportPhysique: null };
    case "CIRCUIT_LOGIQUE": {
      const sp = { valides: e.nbSupportsValides, proposes: e.nbSupportsProposes };
      return e.nbSupportsValides > 0
        ? { ...base, qualification: "CIRCUIT_LOGIQUE_SUR_INFRASTRUCTURE_VALIDEE", libelle: `Conflit avec un circuit logique porté par ${e.nbSupportsValides} infrastructure(s) physique(s) validée(s) : c'est l'infrastructure physique qui est concernée.`, supportPhysique: sp }
        : { ...base, qualification: "CIRCUIT_LOGIQUE_SANS_SUPPORT_VALIDE", libelle: "Conflit avec un simple circuit logique : son support physique n'est pas établi, la position réelle de l'infrastructure est inconnue.", supportPhysique: sp };
    }
    case "EQUIPEMENT":
      return { ...base, qualification: "EQUIPEMENT", libelle: "Conflit avec un équipement.", supportPhysique: null };
    default:
      return { ...base, qualification: "NATURE_INCONNUE", libelle: "Nature de l'objet inconnue : ni infrastructure physique ni circuit logique n'est établi.", supportPhysique: null };
  }
}
