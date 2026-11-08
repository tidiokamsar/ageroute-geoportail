import type { FamilleDefaut, Prisma, TypeObservation } from "@prisma/client";

/**
 * Materialiser l'observation qui porte un defaut, quand le terrain n'en a pas envoye.
 *
 * POURQUOI CECI EXISTE
 *
 * Le paragraphe 7.1 du cahier RAI V3.1 marque `observationId` « Oui », et
 * `defauts.observationId` est devenu NOT NULL le 13/10/2026 : c'est par l'observation
 * qu'un defaut remonte jusqu'a la photo, au point GPS et a l'agent qui l'a releve.
 *
 * Or le frontend n'envoyait JAMAIS `observationId` — zero occurrence dans tout
 * `frontend/src`. La contrainte seule aurait donc casse la saisie terrain a la premiere
 * photo, sur une interface deja livree.
 *
 * TROIS FACONS DE S'EN SORTIR, ET POURQUOI CELLE-CI
 *
 * 1. Exiger l'identifiant et faire creer l'observation par le client. Correct, mais cela
 *    transforme une operation hors ligne en DEUX operations dependantes a ordonner dans
 *    la file de synchronisation. C'est precisement la ou vit la perte silencieuse de
 *    donnees, et ce depot a deja paye pour l'apprendre : la file ne retirait un element
 *    qu'apres le succes de toutes ses photos, et une coupure recreait l'inspection a
 *    chaque tentative.
 *
 * 2. Laisser le serveur DEDUIRE une observation vraisemblable. Refuse : ce serait
 *    fabriquer un constat que personne n'a fait.
 *
 * 3. La materialiser depuis la soumission elle-meme, dans la MEME transaction. Retenue.
 *    Rien n'est invente : l'agent, la mission, le troncon, la position, la precision et
 *    l'horodatage viennent tous du releve que l'agent vient d'envoyer. L'observation est
 *    le conteneur que le paragraphe 8 decrit, ecrit explicitement au lieu d'etre
 *    sous-entendu.
 *
 * CE QUE CE CHOIX COUTE, ET IL FAUT LE DIRE
 *
 * Le paragraphe 8 prevoit qu'« une observation peut donner naissance a un ou plusieurs
 * defauts ». Par ce chemin, le rapport est de un pour un. Ce n'est pas faux — chaque
 * defaut a bien son conteneur reel — mais ce n'est pas le regroupement que le cahier
 * envisage. Le jour ou le terrain enverra une observation puis ses defauts, ils
 * passeront par `observationId` et ce chemin ne servira plus.
 */

/**
 * Famille du catalogue vers type d'observation.
 *
 * Les deux vocabulaires ont ete definis separement et ne se recouvrent pas tout a fait :
 * `ACCOTEMENT` n'a pas d'equivalent parmi les types d'observation. Le repli est
 * `DEGRADATION`, qui est vrai sans etre precis — et surtout il ne PRETEND rien. Inventer
 * un type plus flatteur ferait croire a une categorisation qui n'existe pas.
 */
const TYPES_PAR_FAMILLE: Record<FamilleDefaut, TypeObservation> = {
  CHAUSSEE: "CHAUSSEE",
  ACCOTEMENT: "DEGRADATION",
  ASSAINISSEMENT: "ASSAINISSEMENT",
  OUVRAGE: "OUVRAGE",
  SIGNALISATION: "SIGNALISATION",
  SECURITE: "SECURITE",
  ENVIRONNEMENT: "ENVIRONNEMENT",
};

export function typeObservationPourFamille(famille: FamilleDefaut): TypeObservation {
  return TYPES_PAR_FAMILLE[famille] ?? "DEGRADATION";
}

/**
 * Cle d'idempotence de l'observation conteneur.
 *
 * Elle DERIVE de celle du defaut au lieu d'etre tiree au hasard. Un rejeu de la meme
 * operation de synchronisation rencontre alors la meme collision d'unicite sur les deux
 * lignes, et non une observation de plus a chaque tentative — c'est-a-dire le doublon
 * silencieux que le protocole existe pour empecher.
 *
 * Quand le defaut n'a pas de cle (saisie directe au bureau, sans file hors ligne), il n'y
 * a rien a rejouer et une cle tiree convient.
 */
export function cleObservationConteneur(
  cleDefaut: string | null | undefined,
  tirerAuSort: () => string,
): string {
  return cleDefaut ? `${cleDefaut}-observation` : tirerAuSort();
}

export interface ReleveDefaut {
  famille: FamilleDefaut;
  agentId: string;
  missionId?: string | null;
  tronconId?: string | null;
  lat?: number | null;
  lon?: number | null;
  precisionM?: number | null;
  confianceAppariement?: number | null;
  pk?: number | null;
  observeA: Date;
  clientOperationId?: string | null;
  /** Libelle du type de defaut, pour que la fiche reste lisible sans jointure. */
  libelleCatalogue: string;
}

/**
 * Donnees de l'observation conteneur. Aucun champ n'est devine : tout vient du releve.
 *
 * Le statut reste celui que le schema pose par defaut. L'observation est une proposition,
 * comme le defaut qu'elle porte, et c'est le meme tiers habilite qui tranchera.
 */
export function donneesObservationConteneur(
  r: ReleveDefaut,
  tirerAuSort: () => string,
): Prisma.ObservationUncheckedCreateInput {
  return {
    clientOperationId: cleObservationConteneur(r.clientOperationId, tirerAuSort),
    agentId: r.agentId,
    missionId: r.missionId ?? null,
    tronconId: r.tronconId ?? null,
    type: typeObservationPourFamille(r.famille),
    // La description dit d'ou vient cette ligne. Sans elle, personne ne saurait dans six
    // mois que cette observation a ete ecrite par le serveur et non saisie par l'agent.
    description: `Conteneur créé avec le défaut « ${r.libelleCatalogue} ».`,
    lat: r.lat ?? null,
    lon: r.lon ?? null,
    precisionM: r.precisionM ?? null,
    confianceAppariement: r.confianceAppariement ?? null,
    pk: r.pk ?? null,
    observeA: r.observeA,
  };
}
