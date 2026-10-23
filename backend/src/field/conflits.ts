/**
 * Conflits de synchronisation : ce qu'un responsable peut en faire, decide SANS base.
 *
 * LES REGLES VIENNENT DE `POST /sync/resolve`, ET NE SONT PAS REINVENTEES ICI
 *
 * La route de resolution refuse LOCAL dans trois cas (une creation, un defaut, une operation qui n'est ni
 * UPDATE ni DELETE). L'ecran qui liste les conflits doit le dire AVANT le clic : un bouton « retenir la
 * version du telephone » qui rendrait 409 apres coup donne l'impression d'une panne, alors que c'est une
 * regle (retenir une creation en conflit remplacerait une ligne qui existe deja).
 *
 * Ces fonctions sont la copie lisible de ces refus, et `sync.integration.mts` verifie contre la route reelle
 * que les deux ne divergent pas.
 */

export type ResolutionConflit = "LOCAL" | "SERVEUR";

export interface ResolutionsPossibles {
  SERVEUR: true;
  /** Vrai si retenir la version du telephone est permis. */
  LOCAL: boolean;
  /** Pourquoi LOCAL est impossible, en clair, ou null s'il est permis. */
  motifLocalImpossible: string | null;
}

export function resolutionsPossibles(entityType: string, operation: string | null): ResolutionsPossibles {
  if (entityType === "Defaut") {
    return {
      SERVEUR: true,
      LOCAL: false,
      motifLocalImpossible: "La version locale d'un défaut en conflit doit être représentée avec un nouvel identifiant avant arbitrage.",
    };
  }
  if (entityType !== "Observation") {
    return { SERVEUR: true, LOCAL: false, motifLocalImpossible: `Type de conflit non pris en charge : ${entityType}` };
  }
  if (operation === "CREATE") {
    return {
      SERVEUR: true,
      LOCAL: false,
      motifLocalImpossible: "Une création en conflit doit être représentée avec un nouvel identifiant avant arbitrage : la retenir remplacerait une ligne qui existe déjà.",
    };
  }
  if (operation !== "UPDATE" && operation !== "DELETE") {
    return { SERVEUR: true, LOCAL: false, motifLocalImpossible: "Opération locale non prise en charge." };
  }
  return { SERVEUR: true, LOCAL: true, motifLocalImpossible: null };
}

/** Roles qui voient et arbitrent les conflits : les memes que ceux de `POST /sync/resolve` pour un defaut. */
export function peutArbitrer(role: string): boolean {
  return role === "ADMIN" || role === "GESTIONNAIRE";
}
