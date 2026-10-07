/**
 * Protocole de synchronisation terrain : la DECISION, isolee de la base.
 *
 * Section 15 du cahier des charges. Six cas y sont nommes, et chacun correspond a une
 * facon precise de perdre ou de corrompre une donnee sur un reseau guineen :
 *
 *     CREATE nouveau              accepter
 *     meme operationId            rendre le resultat precedent, aucun doublon
 *     UPDATE meme version         appliquer
 *     UPDATE version differente   creer un conflit
 *     donnee patrimoniale         jamais d'ecrasement automatique
 *
 * POURQUOI CETTE LOGIQUE NE TOUCHE PAS LA BASE
 *
 * Une decision qui ne se teste qu'avec PostgreSQL allume ne se teste pas. Les regles
 * ci-dessous sont des fonctions pures : elles recoivent l'etat observe et rendent une
 * intention. Le service qui les appelle fait l'ecriture, dans une transaction.
 *
 * L'IDEMPOTENCE N'EST PAS UNE OPTIMISATION
 *
 * Elle est la raison d'etre du protocole. Le cas qui compte n'est pas la panne
 * franche — un envoi qui echoue se rejoue sans dommage — mais la REPONSE PERDUE : le
 * serveur a enregistre, l'accuse de reception n'arrive pas, le client conclut a
 * l'echec et reessaie. Sans cle d'idempotence, chaque coupure produit un doublon.
 *
 * Ce projet en a deja fait les frais deux fois. `Inspection.clientInspectionId` a ete
 * ajoute apres coup pour cette raison exacte. Et le 05/09, un import d'ouvrages a
 * perdu 349 lignes sur 963 parce que la cle d'unicite ne distinguait pas ce qu'elle
 * pretendait distinguer : ON CONFLICT DO NOTHING les a avalees sans un mot.
 */

/** Operation telle que l'appareil l'a produite, hors ligne. */
export interface OperationEntrante {
  /** Genere par le CLIENT avant tout envoi. C'est la cle d'idempotence. */
  operationId: string;
  entityType: string;
  entityId: string;
  operation: "CREATE" | "UPDATE" | "DELETE";
  /** Version de l'entite telle que l'appareil la connaissait. Nul pour un CREATE. */
  baseVersion?: number | null;
  payload: Record<string, unknown>;
}

/** Ce que la base sait au moment de decider. */
export interface EtatObserve {
  /** Resultat deja enregistre pour ce meme operationId, s'il existe. */
  dejaTraitee?: { entityId: string; statut: string } | null;
  /** Version actuelle de l'entite, ou null si elle n'existe pas. */
  versionActuelle?: number | null;
}

export type Decision =
  /** Deja traitee : on rend le resultat precedent, on n'ecrit rien. */
  | { action: "REJOUEE"; entityId: string }
  | { action: "CREER" }
  | { action: "APPLIQUER"; versionSuivante: number }
  /** Les deux versions sont conservees ; un responsable tranchera. */
  | { action: "CONFLIT"; motif: "VERSION_PERIMEE" | "DEJA_EXISTANTE" }
  | { action: "REFUSER"; motif: "ENTITE_INTROUVABLE" | "VERSION_MANQUANTE" };

/**
 * Types d'entite dont une valeur ne s'ecrase jamais sans arbitrage humain.
 *
 * Ce ne sont pas « les plus importantes » : ce sont celles qui alimentent le
 * referentiel patrimonial. Une observation de terrain est une PROPOSITION (section 10
 * du cahier des charges) ; un troncon ou un ouvrage est de la donnee officielle, et
 * deux agents qui modifient le meme ouvrage hors ligne ne peuvent pas etre departages
 * par l'horloge de leur telephone.
 */
export const ENTITES_PATRIMONIALES = new Set(["Troncon", "Ouvrage", "Chantier", "PointNoir", "Poste"]);

/**
 * Decide du sort d'une operation.
 *
 * L'ORDRE DES TESTS EST LA REGLE
 *
 * L'idempotence passe AVANT tout le reste. Une operation deja traitee ne doit meme pas
 * etre examinee : la reexaminer, c'est risquer de la juger differemment la deuxieme
 * fois — par exemple en conflit, parce que la version a change entre-temps du fait de
 * sa propre premiere application. Le client verrait alors un conflit avec lui-meme.
 */
export function decider(op: OperationEntrante, etat: EtatObserve): Decision {
  if (etat.dejaTraitee) {
    return { action: "REJOUEE", entityId: etat.dejaTraitee.entityId };
  }

  if (op.operation === "CREATE") {
    // Un CREATE sur une entite qui existe deja, sous un operationId NEUF : ce n'est
    // pas un rejeu, c'est deux appareils qui ont cree le meme objet hors ligne. Les
    // departager automatiquement reviendrait a en perdre un.
    return etat.versionActuelle == null ? { action: "CREER" } : { action: "CONFLIT", motif: "DEJA_EXISTANTE" };
  }

  if (etat.versionActuelle == null) {
    // Modifier ce qui n'existe pas. Cela arrive quand l'objet a ete supprime pendant
    // que l'agent etait hors ligne ; recreer silencieusement annulerait la suppression.
    return { action: "REFUSER", motif: "ENTITE_INTROUVABLE" };
  }

  if (op.baseVersion == null) {
    // Sans version de depart, on ne peut pas savoir si l'agent a modifie la valeur
    // courante ou une valeur perimee. Refuser vaut mieux que parier.
    return { action: "REFUSER", motif: "VERSION_MANQUANTE" };
  }

  if (op.baseVersion !== etat.versionActuelle) {
    return { action: "CONFLIT", motif: "VERSION_PERIMEE" };
  }

  return { action: "APPLIQUER", versionSuivante: etat.versionActuelle + 1 };
}

/**
 * Un conflit sur une entite patrimoniale se resout-il tout seul ?
 *
 * Jamais. La fonction existe pour que la reponse soit ECRITE quelque part plutot que
 * supposee, et pour qu'un futur assouplissement — « le dernier qui ecrit gagne sur les
 * observations » — doive passer par ici et par ses tests.
 */
export function resolutionAutomatiquePossible(entityType: string): boolean {
  return !ENTITES_PATRIMONIALES.has(entityType);
}

/**
 * Delai avant un nouvel essai, en millisecondes.
 *
 * Exponentiel et PLAFONNE. Sans plafond, un appareil qui echoue une dizaine de fois
 * attendrait des heures et l'agent croirait la synchronisation terminee. Sans
 * dispersion, tous les appareils d'une mission qui retrouvent le reseau au meme
 * virage reessaieraient a la seconde pres, et se refuseraient mutuellement l'acces.
 */
export function delaiAvantReessai(tentatives: number, alea = Math.random()): number {
  const base = Math.min(1000 * 2 ** Math.max(0, tentatives), 5 * 60 * 1000);
  // Jusqu'a 30 % de dispersion, pour desynchroniser les appareils entre eux.
  return Math.round(base * (1 + 0.3 * alea));
}
