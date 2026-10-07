/**
 * Defauts : du texte libre a une quantite qu'un cout peut utiliser.
 *
 * CE QUI MANQUE AUJOURD'HUI, MESURE SUR LE SCHEMA
 *
 * Le seul endroit ou le systeme note une degradation est `Inspection.defautsConstates`,
 * de type String. Un inspecteur y ecrit « nids de poule importants sur 2 km ». Cette
 * phrase est lisible par un humain et inexploitable par tout le reste : on n'en tire ni
 * surface, ni cout, ni priorite, et deux inspecteurs n'ecriront jamais la meme chose
 * pour la meme chaussee.
 *
 * `MatriceDegradation` existe mais ne comble pas ce vide : elle PREDIT un glissement
 * d'etat (bon vers moyen vers mauvais) par famille de revetement et classe de trafic.
 * Elle dit comment une route vieillit, pas ce qu'elle a.
 *
 * LE PK N'EST PAS UNE DEPENDANCE STRUCTURELLE
 *
 * Un defaut est d'abord un objet geospatial : un point GPS, un troncon apparie, une
 * abscisse locale sur ce troncon. Le PK de route est une information DERIVEE, affichee
 * quand une calibration existe, absente sinon. Elle ne bloque ni la creation, ni le
 * metre, ni la validation.
 *
 * Cette regle n'est pas une precaution theorique. Mesure du 07/10/2026 : 552 des 1 691
 * troncons du reseau classe portent des PK exploitables, et les 1 029 regionales n'ont
 * meme pas de structure de route a laquelle rapporter un PK (docs/rai-v3/08). Exiger un
 * PK rendrait le terrain impossible sur les deux tiers du reseau.
 *
 * QUATRE CHOIX QUI PORTENT TOUT LE RESTE
 *
 * 1. LES MESURES OBLIGATOIRES VIENNENT DU CATALOGUE. Un ornierage se releve en longueur
 *    et profondeur, un faiencage en longueur et largeur, une signalisation en quantite.
 *    Coder ces listes dans l'application obligerait a livrer une version a chaque
 *    evolution du referentiel ; elles sont donc administrables.
 *
 * 2. L'UNITE DU METRE AUSSI, ET ELLE EST DISTINCTE DES MESURES REQUISES. Un ornierage
 *    exige une profondeur sans que celle-ci entre dans son metre : la profondeur
 *    qualifie la gravite, le metre reste lineaire. Confondre les deux listes produirait
 *    des volumes la ou on veut des metres.
 *
 * 3. ON STOCKE LES MESURES, PAS SEULEMENT LE RESULTAT. Une surface de 12 m2 dont on a
 *    perdu le 4 par 3 ne se verifie plus et ne se corrige plus.
 *
 * 4. GRAVITE ET ETENDUE SONT DEUX AXES. « Faiencage, gravite forte, etendue generalisee,
 *    2 850 m2 » se traite ; « defaut important » ne se traite pas. Une gravite forte sur
 *    trois metres carres et la meme gravite sur trois mille ne demandent ni le meme
 *    chantier ni le meme budget.
 *
 * CE QUI N'EST PAS DECIDE ICI
 *
 * Les SEUILS de gravite sont normatifs. « A partir de quelle profondeur une orniere est
 * grave » se tranche dans un catalogue officiel, pas dans ce fichier. Ils restent vides
 * et visibles, et la gravite saisie par un agent est un JUGEMENT trace comme tel.
 *
 * POURQUOI CE FICHIER N'EST PAS DANS LES ROUTES
 *
 * Cinquieme extraction de meme nature, apres l'appariement, la synchronisation, les
 * missions et les observations. Importer un fichier de routes entraine les middlewares,
 * donc `config/env`, qui appelle `process.exit(1)` faute de `.env` : le test ne tombe
 * pas en echec, il ne demarre pas.
 */

/**
 * Unite du metre. Portee par le CATALOGUE et non par l'agent : si chacun choisit, deux
 * releves du meme nid-de-poule arrivent l'un en unites et l'autre en metres carres, et
 * leur somme ne veut rien dire.
 */
export type UniteDefaut = "UNITE" | "METRE" | "METRE_CARRE" | "METRE_CUBE";

/**
 * Mesures qu'un catalogue peut exiger.
 *
 * `QUANTITE` couvre les types dont le releve est un total direct — une longueur de
 * caniveau a reprendre, un nombre de panneaux — sans passage par des facteurs.
 */
export type MesureDefaut = "NOMBRE" | "LONGUEUR" | "LARGEUR" | "PROFONDEUR" | "QUANTITE";

/** Mesures relevees sur le terrain. Toutes facultatives ici : le catalogue tranche. */
export interface MesuresDefaut {
  nombre?: number | null;
  longueurM?: number | null;
  largeurM?: number | null;
  profondeurM?: number | null;
  /** Quantite relevee directement, quand l'agent a pu la mesurer. */
  quantiteSaisie?: number | null;
}

/** Ce que le catalogue dit d'un type de defaut, et dont le moteur a besoin. */
export interface TypeDefaut {
  code: string;
  unite: UniteDefaut;
  /** Mesures sans lesquelles le releve est incomplet. */
  mesuresRequises: readonly MesureDefaut[];
  /** Nombre de crans de gravite. NUL pour les types qui ne se graduent pas. */
  graviteMax: number | null;
}

export type MethodeQuantite =
  | "SAISIE"
  | "COMPTAGE"
  | "LONGUEUR"
  | "LONGUEUR_LARGEUR"
  | "LONGUEUR_LARGEUR_PROFONDEUR";

export type RefusQuantite =
  | "MESURES_INSUFFISANTES"
  | "MESURE_ABERRANTE"
  | "DEPASSE_LE_TRONCON";

export type ResultatQuantite =
  | { valeur: number; methode: MethodeQuantite }
  | { valeur: null; motif: RefusQuantite };

/** Une mesure doit etre un nombre fini et strictement positif, ou ne pas etre. */
function mesureValide(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/** Une mesure presente mais non exploitable : zero, negative, NaN, Infinity. */
function mesurePresenteMaisFausse(v: number | null | undefined): boolean {
  return v !== null && v !== undefined && !mesureValide(v);
}

/** Arrondi a trois decimales : au-dela, on affiche du bruit de calcul. */
function arrondir(v: number): number {
  return Math.round(v * 1000) / 1000;
}

const LECTEURS: Record<MesureDefaut, (m: MesuresDefaut) => number | null | undefined> = {
  NOMBRE: (m) => m.nombre,
  LONGUEUR: (m) => m.longueurM,
  LARGEUR: (m) => m.largeurM,
  PROFONDEUR: (m) => m.profondeurM,
  QUANTITE: (m) => m.quantiteSaisie,
};

/**
 * Mesures exigees par le catalogue et absentes du releve.
 *
 * Rend la liste et non un booleen : l'agent doit savoir QUOI retourner mesurer, et un
 * « releve incomplet » sans precision le renvoie sur le terrain a l'aveugle.
 */
export function mesuresManquantes(
  m: MesuresDefaut,
  requises: readonly MesureDefaut[],
): MesureDefaut[] {
  return requises.filter((r) => !mesureValide(LECTEURS[r](m)));
}

/**
 * Quantite d'un defaut, et par quelle voie on l'obtient.
 *
 * UNE MESURE SAISIE L'EMPORTE SUR UNE DERIVATION
 *
 * Si l'agent a mesure la surface au decametre, cette valeur est un constat ; le produit
 * longueur par largeur n'est qu'une approximation de rectangle. On prend le constat et
 * on dit qu'il en est un.
 *
 * UNE MESURE FAUSSE FAIT REFUSER, ELLE N'EST PAS IGNOREE
 *
 * Une largeur a zero vient d'une faute de saisie. L'ignorer et deriver sur les champs
 * restants rendrait une quantite plausible issue d'une donnee fausse, et cette quantite
 * finirait dans un cout que personne ne pourrait plus mettre en doute.
 *
 * `longueurTronconM` borne le resultat quand on le connait : un defaut plus long que le
 * troncon qui le porte est une erreur de saisie ou de rattachement, jamais un defaut.
 */
export function quantite(
  m: MesuresDefaut,
  unite: UniteDefaut,
  longueurTronconM?: number | null,
): ResultatQuantite {
  for (const v of [m.nombre, m.longueurM, m.largeurM, m.profondeurM, m.quantiteSaisie]) {
    if (mesurePresenteMaisFausse(v)) return { valeur: null, motif: "MESURE_ABERRANTE" };
  }

  // Le depassement se juge sur la longueur relevee, seule mesure comparable a celle du
  // troncon. Une surface de 400 m2 sur un troncon de 200 m est parfaitement possible.
  if (mesureValide(longueurTronconM) && mesureValide(m.longueurM) && m.longueurM > longueurTronconM) {
    return { valeur: null, motif: "DEPASSE_LE_TRONCON" };
  }

  if (mesureValide(m.quantiteSaisie)) {
    return { valeur: arrondir(m.quantiteSaisie), methode: "SAISIE" };
  }

  switch (unite) {
    case "UNITE":
      return mesureValide(m.nombre)
        ? { valeur: m.nombre, methode: "COMPTAGE" }
        : { valeur: null, motif: "MESURES_INSUFFISANTES" };

    case "METRE":
      return mesureValide(m.longueurM)
        ? { valeur: arrondir(m.longueurM), methode: "LONGUEUR" }
        : { valeur: null, motif: "MESURES_INSUFFISANTES" };

    case "METRE_CARRE":
      return mesureValide(m.longueurM) && mesureValide(m.largeurM)
        ? { valeur: arrondir(m.longueurM * m.largeurM), methode: "LONGUEUR_LARGEUR" }
        : { valeur: null, motif: "MESURES_INSUFFISANTES" };

    case "METRE_CUBE":
      return mesureValide(m.longueurM) && mesureValide(m.largeurM) && mesureValide(m.profondeurM)
        ? {
            valeur: arrondir(m.longueurM * m.largeurM * m.profondeurM),
            methode: "LONGUEUR_LARGEUR_PROFONDEUR",
          }
        : { valeur: null, motif: "MESURES_INSUFFISANTES" };
  }
}

export type RefusMetre = RefusQuantite | "RELEVE_INCOMPLET";

export type Metre =
  | { valeur: number; unite: UniteDefaut; methode: MethodeQuantite }
  | { valeur: null; motif: RefusMetre; manquantes?: MesureDefaut[] };

/**
 * Metre complet : le catalogue determine les champs necessaires, puis on calcule.
 *
 * L'ORDRE DES DEUX CONTROLES COMPTE
 *
 * Les mesures requises sont verifiees AVANT la derivation. Un ornierage sans profondeur
 * a bien de quoi calculer son metre lineaire ; le laisser passer donnerait une quantite
 * juste sur un releve inutilisable, car sans profondeur personne ne pourra jamais
 * classer sa gravite ni choisir son traitement.
 *
 * Le releve est donc refuse en disant QUOI manque, pendant que l'agent est encore sur
 * place. C'est la seule fenetre ou la correction coute une minute plutot qu'un
 * deplacement.
 */
export function metrer(
  m: MesuresDefaut,
  type: TypeDefaut,
  longueurTronconM?: number | null,
): Metre {
  // Une mesure fausse se signale avant toute chose : elle expliquerait autrement un
  // « releve incomplet » trompeur, puisqu'un zero compte comme absent.
  for (const v of [m.nombre, m.longueurM, m.largeurM, m.profondeurM, m.quantiteSaisie]) {
    if (mesurePresenteMaisFausse(v)) return { valeur: null, motif: "MESURE_ABERRANTE" };
  }

  const manquantes = mesuresManquantes(m, type.mesuresRequises);
  if (manquantes.length > 0) return { valeur: null, motif: "RELEVE_INCOMPLET", manquantes };

  const q = quantite(m, type.unite, longueurTronconM);
  return q.valeur === null ? q : { valeur: q.valeur, unite: type.unite, methode: q.methode };
}

/**
 * Une quantite derivee n'est pas un constat.
 *
 * Elle sert a decider, donc elle doit porter d'ou elle vient. Seule la valeur mesuree
 * au metre par l'agent est OBSERVED ; tout produit de mesures est DERIVED, meme quand
 * ses facteurs sont justes.
 */
export function statutQualiteQuantite(methode: MethodeQuantite): "OBSERVED" | "DERIVED" {
  return methode === "SAISIE" || methode === "COMPTAGE" ? "OBSERVED" : "DERIVED";
}

/**
 * Gravite : un jugement borne, et refuse quand le type n'en admet pas.
 *
 * L'echelle par defaut compte quatre crans (faible, moderee, forte, critique), mais elle
 * reste portee par le catalogue : un type a trois crans doit pouvoir exister sans
 * toucher au code. `graviteMax` nul designe les types qui ne se graduent pas — un
 * panneau manquant est absent ou present, le graduer remplirait un champ sans rien
 * mesurer.
 */
export const GRAVITE_MAX_PAR_DEFAUT = 4;

export type RefusGravite = "HORS_ECHELLE" | "TYPE_SANS_GRAVITE" | "GRAVITE_REQUISE";

export function graviteValide(
  gravite: number | null | undefined,
  graviteMax: number | null,
): { permis: true } | { permis: false; motif: RefusGravite } {
  if (gravite === null || gravite === undefined) {
    // Un type gradue sans gravite donnerait un defaut qu'on ne peut pas hierarchiser,
    // et la programmation des travaux repose sur cette hierarchie.
    return graviteMax === null ? { permis: true } : { permis: false, motif: "GRAVITE_REQUISE" };
  }
  if (graviteMax === null) return { permis: false, motif: "TYPE_SANS_GRAVITE" };
  if (!Number.isInteger(gravite) || gravite < 1 || gravite > graviteMax) {
    return { permis: false, motif: "HORS_ECHELLE" };
  }
  return { permis: true };
}

/**
 * Etendue : l'importance spatiale du defaut sur le troncon, independante de sa gravite.
 *
 * POURQUOI UNE ECHELLE QUALITATIVE ET NON UN TAUX
 *
 * Un taux d'occupation (surface affectee sur surface totale) serait plus exploitable.
 * Il n'est pas calculable : `Troncon` ne porte que `longueurKm`, aucune largeur ni
 * nombre de voies. La surface d'un troncon est donc inconnue sur la totalite du reseau,
 * et un taux calcule dessus serait une invention.
 *
 * L'echelle qualitative est ce qu'un agent peut reellement constater. Le jour ou les
 * largeurs existeront, le taux viendra s'ajouter sans retirer celle-ci : l'agent
 * continuera de voir ce qu'il voit.
 */
export type EtendueDefaut = "PONCTUEL" | "LOCALISE" | "ETENDU" | "GENERALISE";

export const ETENDUES: readonly EtendueDefaut[] = ["PONCTUEL", "LOCALISE", "ETENDU", "GENERALISE"];

/**
 * Taux d'occupation, quand la largeur du troncon est connue.
 *
 * Rend null plutot qu'une approximation : c'est la fonction qui attend la donnee, pas
 * la donnee qui doit s'inventer pour satisfaire la fonction.
 */
export function tauxOccupation(
  surfaceDefautM2: number | null | undefined,
  longueurTronconM: number | null | undefined,
  largeurTronconM: number | null | undefined,
): number | null {
  if (!mesureValide(surfaceDefautM2) || !mesureValide(longueurTronconM) || !mesureValide(largeurTronconM)) {
    return null;
  }
  const surfaceTroncon = longueurTronconM * largeurTronconM;
  // Un taux superieur a 1 signale une erreur de releve, pas une chaussee degradee a
  // 180 %. On le rend tel quel pour qu'il se voie, borne a trois decimales.
  return Math.round((surfaceDefautM2 / surfaceTroncon) * 1000) / 1000;
}

/**
 * Validation : deleguee a la couche de gouvernance partagee.
 *
 * La regle « observation ou import n'est pas donnee officielle » ne concerne pas que les
 * defauts : elle vaut pour les troncons, les ouvrages, les points noirs, les postes et
 * les chantiers. Elle vit donc dans `governance/validation`, et ce module s'y rapporte
 * au lieu d'en garder une copie.
 *
 * Deux copies de cette regle divergeraient, et la divergence serait invisible : chacune
 * continuerait de passer ses propres tests pendant que l'une des deux laisserait valider
 * ce que l'autre refuse.
 */
export {
  validationPermise,
  transitionPermise as transitionStatutPermise,
  TRANSITIONS as TRANSITIONS_STATUT,
  ROLES_VALIDATEURS,
  type StatutValidation as StatutDefaut,
  type DemandeValidation,
  type RefusValidation,
} from "../governance/validation";

/**
 * Cycle de vie physique du defaut, distinct de sa validation.
 *
 * POURQUOI DEUX AXES ET NON UN
 *
 * Un defaut valide peut etre encore ACTIF ; une fois repare il devient TRAITE sans
 * cesser d'avoir existe. Fondre les deux axes obligerait a remonter le statut de
 * validation pour dire « repare », ce qui effacerait qui l'avait valide et quand.
 *
 * DISPARU n'est pas TRAITE : un ravinement comble par une crue a disparu sans qu'on ait
 * depense un franc, et confondre les deux fausserait le suivi des travaux realises.
 */
export type EtatDefaut = "ACTIF" | "TRAITE" | "DISPARU";

export const TRANSITIONS_ETAT: Record<EtatDefaut, readonly EtatDefaut[]> = {
  // Un defaut traite peut redevenir actif : une reparation qui ne tient pas est le cas
  // courant, pas l'exception, et le nier obligerait a creer un faux doublon.
  ACTIF: ["TRAITE", "DISPARU"],
  TRAITE: ["ACTIF"],
  DISPARU: ["ACTIF"],
};

export function transitionEtatPermise(de: string, vers: string): boolean {
  return (TRANSITIONS_ETAT[de as EtatDefaut] ?? []).includes(vers as EtatDefaut);
}

/** Nom lisible d'une mesure, pour dire a un agent ce qu'il doit retourner relever. */
export const NOMS_MESURES: Record<MesureDefaut, string> = {
  NOMBRE: "le nombre",
  LONGUEUR: "la longueur",
  LARGEUR: "la largeur",
  PROFONDEUR: "la profondeur",
  QUANTITE: "la quantité",
};

/** Message destine a un agent, et non a un developpeur. */
export const EXPLICATIONS: Record<RefusMetre | RefusGravite, string> = {
  MESURES_INSUFFISANTES: "Les mesures relevées ne permettent pas de calculer la quantité pour cette unité.",
  MESURE_ABERRANTE: "Une des mesures est nulle ou négative : corrigez-la avant d'enregistrer.",
  DEPASSE_LE_TRONCON: "Le défaut est plus long que le tronçon qui le porte : vérifiez la mesure ou le rattachement.",
  RELEVE_INCOMPLET: "Ce type de défaut demande des mesures qui n'ont pas été relevées.",
  HORS_ECHELLE: "La gravité sort de l'échelle prévue pour ce type de défaut.",
  TYPE_SANS_GRAVITE: "Ce type de défaut ne se gradue pas : il est constaté ou il ne l'est pas.",
  GRAVITE_REQUISE: "Ce type de défaut demande une gravité pour pouvoir être hiérarchisé.",
};
