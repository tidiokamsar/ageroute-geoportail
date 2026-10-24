/**
 * Ecriture des portions : creer, decouper, fusionner, requalifier, decider.
 *
 * TOUT EST UNE PROPOSITION
 *
 * Une portion ecrite depuis le terrain sort en `A_VALIDER`. Elle ne devient officielle que
 * par `decider`, et jamais par son auteur : `validationPermise` refuse l'auto-validation.
 * C'est la raison pour laquelle ce module ne porte aucun raccourci « creer et valider ».
 *
 * RIEN N'EST MODIFIE EN PLACE
 *
 * Decouper, fusionner et requalifier ne touchent pas la ligne existante : ils la marquent
 * `remplaceeLe` et inserent la ou les nouvelles versions, en inscrivant le lignage. Une
 * portion modifiee en place perdrait ce qu'elle disait avant, et les validations rendues
 * sous elle deviendraient inexplicables.
 *
 * LA GEOMETRIE EST DERIVEE, ET LA CONVERSION EST EXACTE
 *
 * `ST_LineSubstring` prend des FRACTIONS de la longueur planaire. L'abscisse, elle, est
 * definie par `geo/appariement.ts` comme `ST_LineLocatePoint(...) * ST_Length(geom::geography)`,
 * c'est-a-dire fraction x longueur geodesique. L'inverse `fraction = abscisseM / longueurM`
 * est donc exact PAR CONSTRUCTION vis-a-vis de cette definition, et non une approximation :
 * les deux sens utilisent la meme longueur de reference.
 *
 * CE MODULE NE TOUCHE JAMAIS `troncons.geom`
 *
 * Qualifier le terrain et corriger un trace sont deux operations distinctes, aux droits
 * distincts. Rien ici ne peut deplacer une route.
 */
import {
  LONGUEUR_MINIMALE_M,
  courantes,
  decouper,
  fusionner,
  refusFusion,
  refusPortion,
  type Portion,
  type RefusDecoupe,
  type RefusFusion,
  type RefusPortion,
} from "./portions";

/** Attributs qu'une qualification peut porter. Tous facultatifs sauf les bornes. */
export interface Qualification {
  revetement?: string | null;
  etat?: string | null;
  praticabilite?: string | null;
  largeurM?: number | null;
  source?: string | null;
  observeeLe?: Date | null;
  /**
   * DEPUIS QUAND cette qualification est vraie sur le terrain (jour UTC). Facultative, et
   * « absente » veut dire INCONNUE : la portion ne sera alors placee a aucune date du curseur
   * temporel. Distincte de `observeeLe`, voir `date-effet.ts`.
   */
  valideDu?: Date | null;
  confiance?: "HIGH" | "MEDIUM" | "LOW" | null;
  observationId?: string | null;
}

export interface DemandeCreation extends Qualification {
  tronconId: string;
  debutM: number;
  finM: number;
  /** Cle d'idempotence de l'appareil. Absente pour une saisie console. */
  clientOperationId?: string | null;
}

/**
 * Ce que le service a besoin de faire en base, et rien de plus.
 *
 * Un port etroit plutot que le client Prisma entier : les invariants ci-dessous se testent
 * avec un faux, sans PostGIS ni conteneur. C'est la meme separation que `contexte.ts`.
 */
export interface DepotPortions {
  /** Longueur geodesique reelle du troncon. Nulle sans geometrie exploitable. */
  longueurTronconM(tronconId: string): Promise<number | null>;
  /** Portions du troncon, historique compris : les refus doivent voir les remplacees. */
  portionsDuTroncon(tronconId: string): Promise<Portion[]>;
  portionParId(id: string): Promise<Portion | null>;
  /** Rend la portion deja enregistree sous cette cle, ou `null`. */
  portionParCleClient(cle: string): Promise<Portion | null>;
  /**
   * Insere les portions, marque les remplacees, inscrit le lignage et audite, EN UNE SEULE
   * TRANSACTION. Le tout ou rien est la seule garantie qui compte ici : une portion
   * inseree sans que son parent soit marque remplace creerait un chevauchement silencieux.
   */
  appliquer(ecriture: Ecriture): Promise<Portion[]>;
  /** Met a jour le statut de validation et audite, en une transaction. */
  decider(id: string, statut: Portion["statutValidation"], decideParId: string, commentaire: string | null): Promise<Portion>;
}

export interface Ecriture {
  /** Portions a inserer, deja completes. */
  inserer: Omit<Portion, "id">[];
  /** Identifiants a marquer `remplaceeLe`. */
  remplacer: string[];
  /** Couples parent -> enfant, par index dans `inserer`. */
  lignage: { parentId: string; enfantIndex: number }[];
  auteurId: string;
  /**
   * Cloture TERRAIN des versions remplacees : leur `valideAu` prend cette date, SI elles n'en
   * ont pas deja une. C'est le geste qui distingue les deux axes : `remplaceeLe` se pose a
   * l'enregistrement, `valideAu` a la date ou la realite a change.
   */
  cloreTerrain?: { valideAu: Date };
  /** Pour l'audit : ce que l'operation est, en un mot. */
  operation: "CREATION" | "DECOUPE" | "FUSION" | "REQUALIFICATION";
  /**
   * Troncon de reference, pour deriver la geometrie des portions inserees.
   *
   * Les ABSCISSES suffisent : le helper geometrique divise par la longueur geodesique du
   * troncon, qui est la reference ayant servi a les mesurer. Transmettre des fractions
   * calculees ici aurait cree une seconde source de verite pour la meme conversion.
   */
  tronconId: string;
}

export type RefusEcriture =
  | RefusPortion
  | RefusDecoupe
  | RefusFusion
  | "PORTION_INTROUVABLE"
  | "CHEVAUCHE_UNE_VALIDEE"
  | "DATE_EFFET_NON_POSTERIEURE";

export type Resultat<T> = { refus: RefusEcriture } | { refus: null; valeur: T };

/** Gabarit commun des portions neuves. Une proposition, jamais une donnee officielle. */
function neuve(
  tronconId: string,
  debutM: number,
  finM: number,
  q: Qualification,
  origine: Portion["origine"],
): Omit<Portion, "id"> {
  return {
    tronconId,
    debutM,
    finM,
    revetement: q.revetement ?? null,
    etat: q.etat ?? null,
    praticabilite: q.praticabilite ?? null,
    largeurM: q.largeurM ?? null,
    source: q.source ?? null,
    observeeLe: q.observeeLe ?? null,
    valideDu: q.valideDu ?? null,
    valideAu: null,
    confiance: q.confiance ?? null,
    statutValidation: "A_VALIDER",
    remplaceeLe: null,
    deletedAt: null,
    origine,
    clientOperationId: null,
  };
}

/**
 * Une portion neuve ne doit pas recouvrir une portion DEJA VALIDEE.
 *
 * La contrainte d'exclusion de la base l'interdit entre deux validees. Mais une
 * proposition qui recouvre une validee passerait, et c'est precisement le cas qu'il faut
 * refuser EN AMONT avec un message utile : l'agent doit REQUALIFIER la portion existante,
 * pas en proposer une seconde par-dessus. Lui laisser creer le doublon produirait deux
 * verites concurrentes qu'un valideur devrait departager sans savoir laquelle est la
 * correction de l'autre.
 *
 * Deux propositions entre elles, en revanche, peuvent se contredire : c'est ainsi
 * qu'arrive un second releve, et le cahier interdit tout ecrasement silencieux.
 */
function chevaucheUneValidee(
  portions: readonly Portion[],
  debutM: number,
  finM: number,
  sauf: readonly string[] = [],
): boolean {
  const TOL = 0.05;
  return courantes(portions).some(
    (p) => p.statutValidation === "VALIDE"
      && !sauf.includes(p.id)
      && Math.min(p.finM, finM) - Math.max(p.debutM, debutM) > TOL,
  );
}

export async function creerPortion(
  d: DemandeCreation,
  auteurId: string,
  depot: DepotPortions,
): Promise<Resultat<Portion>> {
  // L'IDEMPOTENCE D'ABORD. Une reponse perdue en zone blanche fait renvoyer l'operation ;
  // rendre la portion deja enregistree est la bonne reponse, pas une erreur.
  if (d.clientOperationId) {
    const deja = await depot.portionParCleClient(d.clientOperationId);
    if (deja) return { refus: null, valeur: deja };
  }

  const longueurM = await depot.longueurTronconM(d.tronconId);
  const refus = refusPortion({ debutM: d.debutM, finM: d.finM }, longueurM);
  if (refus !== null) return { refus };

  const existantes = await depot.portionsDuTroncon(d.tronconId);
  if (chevaucheUneValidee(existantes, d.debutM, d.finM)) {
    return { refus: "CHEVAUCHE_UNE_VALIDEE" };
  }

  const portion = neuve(d.tronconId, d.debutM, d.finM, d, "SAISIE_TERRAIN");

  const [creee] = await depot.appliquer({
    inserer: [{ ...portion, clientOperationId: d.clientOperationId ?? null }],
    remplacer: [],
    lignage: [],
    auteurId,
    operation: "CREATION",
    tronconId: d.tronconId,
  });
  return { refus: null, valeur: creee };
}

export async function decouperPortion(
  portionId: string,
  aM: number,
  auteurId: string,
  depot: DepotPortions,
): Promise<Resultat<Portion[]>> {
  const p = await depot.portionParId(portionId);
  if (p === null) return { refus: "PORTION_INTROUVABLE" };

  // La longueur est demandee pour le seul refus qu'elle permette : sans elle, les bornes
  // du morceau ne peuvent pas etre validees contre le troncon.
  if (await depot.longueurTronconM(p.tronconId) === null) {
    return { refus: "LONGUEUR_TRONCON_INCONNUE" };
  }

  // Les identifiants definitifs sont attribues par la base ; ceux-ci ne servent qu'a
  // satisfaire la signature pure et ne sont jamais ecrits.
  const r = decouper(p, aM, ["__g", "__d"]);
  if (r.refus !== null) return { refus: r.refus };

  const [g, d] = r.morceaux;
  const inserer: Omit<Portion, "id">[] = [g, d].map(({ id: _ignore, ...reste }) => ({
    ...reste,
    origine: "DECOUPE" as const,
    clientOperationId: null,
  }));

  const morceaux = await depot.appliquer({
    inserer,
    remplacer: [p.id],
    lignage: [{ parentId: p.id, enfantIndex: 0 }, { parentId: p.id, enfantIndex: 1 }],
    auteurId,
    operation: "DECOUPE",
    tronconId: p.tronconId,
  });
  return { refus: null, valeur: morceaux };
}

export async function fusionnerPortions(
  idA: string,
  idB: string,
  auteurId: string,
  depot: DepotPortions,
): Promise<Resultat<Portion>> {
  const [a, b] = await Promise.all([depot.portionParId(idA), depot.portionParId(idB)]);
  if (a === null || b === null) return { refus: "PORTION_INTROUVABLE" };

  const motif = refusFusion(a, b);
  if (motif !== null) return { refus: motif };

  if (await depot.longueurTronconM(a.tronconId) === null) {
    return { refus: "LONGUEUR_TRONCON_INCONNUE" };
  }

  const r = fusionner(a, b, "__n");
  if (r.refus !== null) return { refus: r.refus };

  const { id: _ignore, ...reste } = r.portion;
  const [portion] = await depot.appliquer({
    inserer: [{ ...reste, origine: "FUSION", clientOperationId: null }],
    remplacer: [a.id, b.id],
    lignage: [{ parentId: a.id, enfantIndex: 0 }, { parentId: b.id, enfantIndex: 0 }],
    auteurId,
    operation: "FUSION",
    tronconId: a.tronconId,
  });
  return { refus: null, valeur: portion };
}

/**
 * Requalifie une portion : memes bornes, attributs revus.
 *
 * Cree une NOUVELLE version et marque l'ancienne remplacee. L'ancienne reste lisible, ce
 * qui est le seul moyen de repondre plus tard a « qu'est-ce qui a change, et quand ».
 *
 * La nouvelle version repart en `A_VALIDER`, meme si l'ancienne etait validee : une
 * requalification est une proposition, et heriter du statut valide ferait entrer un
 * changement d'etat dans le referentiel officiel sans decision.
 */
export async function requalifierPortion(
  portionId: string,
  q: Qualification,
  auteurId: string,
  depot: DepotPortions,
): Promise<Resultat<Portion>> {
  const p = await depot.portionParId(portionId);
  if (p === null) return { refus: "PORTION_INTROUVABLE" };
  if (p.remplaceeLe !== null || p.deletedAt !== null) return { refus: "PORTION_REMPLACEE" };

  if (await depot.longueurTronconM(p.tronconId) === null) {
    return { refus: "LONGUEUR_TRONCON_INCONNUE" };
  }

  // La date d'effet de la nouvelle version doit etre STRICTEMENT posterieure a celle de
  // l'ancienne : sinon l'ancienne se fermerait avant d'avoir commence, ou le meme jour, et le
  // CHECK de la base refuserait l'intervalle vide -- un refus clair vaut mieux qu'une erreur SQL.
  const dateEffet = q.valideDu ?? null;
  if (dateEffet !== null && p.valideDu != null && dateEffet.getTime() <= p.valideDu.getTime()) {
    return { refus: "DATE_EFFET_NON_POSTERIEURE" };
  }

  const existantes = await depot.portionsDuTroncon(p.tronconId);
  // On s'exclut soi-meme : requalifier SA PROPRE emprise est precisement le geste voulu.
  if (chevaucheUneValidee(existantes, p.debutM, p.finM, [p.id])) {
    return { refus: "CHEVAUCHE_UNE_VALIDEE" };
  }

  const nouvelle = neuve(p.tronconId, p.debutM, p.finM, {
    revetement: q.revetement ?? p.revetement,
    etat: q.etat ?? p.etat,
    praticabilite: q.praticabilite ?? p.praticabilite,
    largeurM: q.largeurM ?? p.largeurM,
    source: q.source ?? null,
    observeeLe: q.observeeLe ?? null,
    valideDu: dateEffet,
    confiance: q.confiance ?? null,
  }, "REQUALIFICATION");

  const [creee] = await depot.appliquer({
    inserer: [nouvelle],
    remplacer: [p.id],
    lignage: [{ parentId: p.id, enfantIndex: 0 }],
    auteurId,
    operation: "REQUALIFICATION",
    tronconId: p.tronconId,
    // Sans date d'effet fournie, rien n'est invente : l'ancienne version garde un `valideAu`
    // inconnu, comme avant.
    ...(dateEffet !== null && p.valideAu == null ? { cloreTerrain: { valideAu: dateEffet } } : {}),
  });
  return { refus: null, valeur: creee };
}

export { LONGUEUR_MINIMALE_M };
