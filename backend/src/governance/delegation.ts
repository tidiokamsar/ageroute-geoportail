/**
 * La delegation de validation : qui est DESIGNE pour trancher, et sur quoi.
 *
 * CE QUE LE CAHIER DEMANDE, ET OU IL LE DIT
 *
 * Le paragraphe 5 decrit le Coordonnateur comme faisant « validation selon delegation ».
 * Pris seul, cela ne dit pas ce qu'est une delegation. La reponse est au paragraphe 35,
 * « Gouvernance des donnees » :
 *
 *     « Un validateur est designe pour chaque domaine. »
 *
 * Une delegation n'est donc pas une permission generique : c'est une DESIGNATION, par
 * domaine. Le paragraphe 26 ajoute « controle de separation des roles pour validation »,
 * et les criteres d'acceptation precisent « lorsque la separation de roles s'applique » —
 * le conditionnel est dans le texte, et il suppose que quelqu'un ait decide ou elle
 * s'applique.
 *
 * L'ETAT AVANT
 *
 * `ROLES_VALIDATEURS` admet ADMIN et GESTIONNAIRE. Tout gestionnaire pouvait donc valider
 * n'importe quel defaut, n'importe quelle observation, partout dans le pays. Il n'y avait
 * ni domaine, ni perimetre, ni terme, ni delegant. « Selon delegation » n'avait aucun
 * equivalent dans le code.
 *
 * LE CHOIX DIFFICILE : QUE FAIRE D'UN DOMAINE SANS VALIDATEUR DESIGNE
 *
 * Deux reponses possibles, et aucune n'est evidente.
 *
 * Exiger une delegation ARRETERAIT la validation tant que personne n'en a cree. Les
 * releves de terrain s'accumuleraient en A_VALIDER, et la chaine de decision — defaut,
 * etat, traitement, cout — resterait vide. Designer des validateurs est un acte
 * d'organisation : cela prend des semaines, pas une soiree de deploiement.
 *
 * Ne rien exiger laisse le comportement actuel, et la delegation devient decorative.
 *
 * LA REGLE RETENUE : RESSERREMENT PAR DOMAINE
 *
 * Tant qu'AUCUN validateur n'est designe sur un domaine, la regle d'avant s'applique :
 * tout ADMIN ou GESTIONNAIRE y valide. Des qu'un seul est designe, le domaine devient
 * reserve aux designes.
 *
 * AGEROUTE peut ainsi designer domaine par domaine, sans jour de bascule, et le premier
 * domaine resserre n'attend pas le onzieme.
 *
 * POURQUOI CE N'EST PAS LE MEME DEFAUT QUE CELUI DES MODULES
 *
 * Ce depot a deja paye pour un defaut de cette forme : `modulesAutorises` vide valait
 * « aucune restriction », si bien qu'un compte dont la configuration avait ete oubliee
 * obtenait tous les modules — et l'interface affirmait l'inverse. La ressemblance est
 * reelle et il faut la regarder en face.
 *
 * La difference tient en un mot : VISIBLE. Le defaut des modules etait silencieux, et
 * contredit par l'ecran. Ici, `domainesSansValidateur` compte les domaines non designes
 * pour que l'etat de la gouvernance se lise, au lieu de se deviner. Un chiffre qui ne
 * descend pas se voit.
 *
 * CE QUI N'EST PAS DELEGABLE
 *
 * L'auto-validation reste refusee en toutes circonstances. Les criteres du cahier la
 * conditionnent — « lorsque la separation de roles s'applique » — ce qui ouvre la porte a
 * des exceptions. Cette porte reste fermee ici : une delegation qui autoriserait son
 * titulaire a valider ses propres releves supprimerait le controle a deux personnes dont
 * depend toute la chaine, et le supprimerait precisement pour celui a qui on a fait
 * confiance.
 */

/**
 * Domaines sur lesquels un validateur peut etre designe.
 *
 * Alignes sur les entites validables de `governance/validation.ts` : un domaine qui n'y
 * figurerait pas designerait un validateur pour quelque chose qui ne se valide pas.
 */
export type DomaineValidation =
  | "TRONCON"
  | "OUVRAGE"
  | "DEFAUT"
  | "OBSERVATION"
  | "POINT_NOIR"
  | "POSTE"
  | "CHANTIER";

export const DOMAINES_VALIDATION: readonly DomaineValidation[] = [
  "TRONCON", "OUVRAGE", "DEFAUT", "OBSERVATION", "POINT_NOIR", "POSTE", "CHANTIER",
];

/** Correspondance entre le type d'entite et son domaine de validation. */
const DOMAINE_PAR_ENTITE: Record<string, DomaineValidation> = {
  Troncon: "TRONCON",
  Ouvrage: "OUVRAGE",
  Defaut: "DEFAUT",
  Observation: "OBSERVATION",
  PointNoir: "POINT_NOIR",
  Poste: "POSTE",
  Chantier: "CHANTIER",
};

export function domaineDeLEntite(entityType: string): DomaineValidation | null {
  return DOMAINE_PAR_ENTITE[entityType] ?? null;
}

export interface Delegation {
  domaine: DomaineValidation;
  validateurId: string;
  /** Perimetre geographique. NUL = national, c'est-a-dire toutes les regions. */
  regionId: number | null;
  /** Debut d'effet. */
  debutLe: Date;
  /** Fin d'effet. NULLE = sans terme. */
  finLe: Date | null;
  /** Revocation anticipee. Conservee : une delegation revoquee a existe. */
  revoqueeLe: Date | null;
}

/**
 * Une delegation est-elle en vigueur a cet instant ?
 *
 * Separe de la couverture de perimetre, parce que les deux se trompent differemment :
 * une delegation expiree qui continue d'agir est une faille, une delegation future qui
 * agit deja en est une autre.
 */
export function delegationEnVigueur(d: Delegation, maintenant: Date): boolean {
  if (d.revoqueeLe !== null && d.revoqueeLe <= maintenant) return false;
  if (d.debutLe > maintenant) return false;
  if (d.finLe !== null && d.finLe <= maintenant) return false;
  return true;
}

/**
 * Une delegation couvre-t-elle cette cible ?
 *
 * LE CAS DE LA REGION INCONNUE EST LE PLUS DELICAT
 *
 * Un defaut peut n'avoir aucune region : son troncon n'est pas apparie, ou sa mission
 * n'en declare pas. Mesure du 07/10/2026 : l'appariement rend `null` plutot que de
 * deviner, et c'est la bonne reponse — mais elle laisse des objets sans region.
 *
 * Une delegation NATIONALE les couvre, puisqu'elle couvre tout. Une delegation
 * REGIONALE ne les couvre pas : on ne peut pas affirmer qu'un objet dont la region est
 * inconnue se trouve dans la region deleguee. Accepter reviendrait a deduire une
 * localisation de l'absence de localisation.
 */
export function delegationCouvre(
  d: Delegation,
  cible: { domaine: DomaineValidation; regionId: number | null },
  maintenant: Date,
): boolean {
  if (!delegationEnVigueur(d, maintenant)) return false;
  if (d.domaine !== cible.domaine) return false;
  if (d.regionId === null) return true;
  return cible.regionId !== null && d.regionId === cible.regionId;
}

export interface DemandeDelegation {
  /** Les delegations EN BASE pour ce domaine, toutes validateurs confondus. */
  delegationsDuDomaine: readonly Delegation[];
  validateurId: string;
  domaine: DomaineValidation;
  /** Region de l'objet a valider. NULLE quand elle n'est pas connue. */
  regionId: number | null;
  maintenant: Date;
}

export type VerdictDelegation =
  | { permis: true; motif: "DOMAINE_NON_DESIGNE" | "DELEGATION_COUVRANTE" }
  | { permis: false; motif: "HORS_DELEGATION" };

/**
 * Le validateur est-il designe pour cette cible ?
 *
 * Rend le MOTIF meme quand c'est permis, et ce n'est pas du zele : « personne n'est
 * designe sur ce domaine » et « vous etes designe » autorisent la meme action pour des
 * raisons opposees. Le journal doit pouvoir les distinguer, sans quoi on ne saura pas,
 * dans un an, si une validation reposait sur une designation ou sur son absence.
 */
export function validationDeleguee(d: DemandeDelegation): VerdictDelegation {
  const enVigueur = d.delegationsDuDomaine.filter((x) => delegationEnVigueur(x, d.maintenant));

  // Resserrement par domaine : tant que personne n'est designe, la regle d'avant
  // s'applique. Voir l'en-tete pour pourquoi ce choix, et pourquoi il est compte.
  if (enVigueur.length === 0) return { permis: true, motif: "DOMAINE_NON_DESIGNE" };

  const couvrante = enVigueur.some(
    (x) => x.validateurId === d.validateurId
      && delegationCouvre(x, { domaine: d.domaine, regionId: d.regionId }, d.maintenant),
  );
  return couvrante
    ? { permis: true, motif: "DELEGATION_COUVRANTE" }
    : { permis: false, motif: "HORS_DELEGATION" };
}

/**
 * Domaines sur lesquels personne n'est designe.
 *
 * C'est la mesure qui empeche le resserrement progressif de devenir un oubli permanent.
 * Un domaine non designe n'est pas une erreur ; vingt domaines non designes pendant deux
 * ans en sont une, et seul un chiffre le dira.
 */
export function domainesSansValidateur(
  delegations: readonly Delegation[],
  maintenant: Date,
): DomaineValidation[] {
  const couverts = new Set(
    delegations.filter((d) => delegationEnVigueur(d, maintenant)).map((d) => d.domaine),
  );
  return DOMAINES_VALIDATION.filter((dom) => !couverts.has(dom));
}

/** Message destine a un agent, et non a un developpeur. */
export const EXPLICATIONS: Record<"HORS_DELEGATION", string> = {
  HORS_DELEGATION:
    "La validation de ce domaine est réservée aux personnes désignées, et vous ne l'êtes pas pour cette zone.",
};
