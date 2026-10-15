/**
 * Actifs routiers : ce qui est ponctuel, ce qui est lineaire, et ce qui refuse les deux.
 *
 * POURQUOI CE CLASSEMENT VIT DANS LE CODE, ALORS QUE LES REVETEMENTS VIVENT EN BASE
 *
 * L'asymetrie est voulue et elle merite d'etre justifiee.
 *
 * Le vocabulaire des REVETEMENTS est administrable : le cahier demande qu'on puisse en
 * ajouter sans deploiement, et un revetement ajoute demain ne dit pas au programme s'il est
 * bitumineux, d'ou un drapeau declare en base.
 *
 * Le type d'un ACTIF est un enum PostgreSQL. En ajouter un exige deja une migration, donc
 * un deploiement. Porter son caractere ponctuel ou lineaire en base n'affranchirait de rien
 * et ajouterait une table que seule cette constante lirait. La regle est donc ici, a cote
 * de l'enum qu'elle complete, et toute valeur ajoutee sans y etre rangee est signalee par
 * un test.
 *
 * LA SIGNALISATION EST MIXTE, ET C'EST UN FAIT DE TERRAIN
 *
 * Un panneau est ponctuel. Un marquage axial court sur des kilometres. Forcer un choix
 * ferait soit perdre l'etendue d'un marquage, soit exiger deux bornes pour un panneau.
 */

/** Les treize types de `TypeOuvrage`, apres l'ajout du 13/10/2026. */
export type TypeActif =
  | "PONT" | "DALOT" | "BUSE" | "RADIER" | "PONCEAU"
  | "MUR_SOUTENEMENT" | "TUNNEL" | "PASSERELLE" | "VIADUC"
  | "FOSSE" | "CANIVEAU" | "SIGNALISATION" | "GLISSIERE";

/**
 * Forme attendue d'un actif.
 *
 * PONCTUEL  une position suffit a le decrire. Un pont a une longueur, mais il est AU point
 *           ou il franchit : son etendue n'est pas une portion de route.
 * LINEAIRE  il court le long de la route, et son etendue est ce qui le caracterise.
 * MIXTE     les deux existent reellement sur le terrain.
 */
export type FormeActif = "PONCTUEL" | "LINEAIRE" | "MIXTE";

export const FORME_PAR_TYPE: Record<TypeActif, FormeActif> = {
  // Les neuf d'origine franchissent ou soutiennent : ils sont AU point.
  PONT: "PONCTUEL",
  DALOT: "PONCTUEL",
  BUSE: "PONCTUEL",
  RADIER: "PONCTUEL",
  PONCEAU: "PONCTUEL",
  MUR_SOUTENEMENT: "LINEAIRE",
  TUNNEL: "LINEAIRE",
  PASSERELLE: "PONCTUEL",
  VIADUC: "LINEAIRE",
  // Les quatre ajoutes courent le long de la route.
  FOSSE: "LINEAIRE",
  CANIVEAU: "LINEAIRE",
  GLISSIERE: "LINEAIRE",
  SIGNALISATION: "MIXTE",
};

/**
 * Un mur, un tunnel et un viaduc sont LINEAIRES bien qu'ils figurent parmi les neuf
 * d'origine, et c'est un changement de lecture qu'il faut assumer : un mur de soutenement
 * de 400 m decrit mal par une epingle, et un viaduc est une section de route a part
 * entiere. Les 1 172 ouvrages existants gardent leurs abscisses nulles, donc rien ne casse ;
 * mais un mur saisi demain peut desormais porter son etendue.
 */
export const LINEAIRES_PAR_RELECTURE: readonly TypeActif[] = ["MUR_SOUTENEMENT", "TUNNEL", "VIADUC"];

export interface EtendueActif {
  tronconId: string | null;
  abscisseDebutM: number | null;
  abscisseFinM: number | null;
}

export type RefusEtendue =
  | "ETENDUE_INCOMPLETE"
  | "ETENDUE_INVERSEE"
  | "ETENDUE_NEGATIVE"
  | "ETENDUE_HORS_TRONCON"
  | "ETENDUE_SANS_TRONCON"
  | "TYPE_PONCTUEL"
  | "ETENDUE_REQUISE"
  | "TROP_COURTE";

/**
 * Longueur minimale d'un actif lineaire, en metres.
 *
 * Deux metres, et non les dix des portions : une glissiere de trois metres devant un
 * ouvrage existe reellement, alors qu'une portion de chaussee de trois metres ne decrit que
 * la derive d'un GPS. Le seuil n'a pas le meme sens dans les deux cas, et les aligner par
 * souci de symetrie aurait interdit de saisir un vrai actif.
 */
export const LONGUEUR_ACTIF_MINIMALE_M = 2;

/**
 * L'etendue declaree tient-elle pour ce type d'actif ?
 *
 * `longueurTronconM` nulle signifie « non mesuree » : on ne refuse alors pas pour depassement,
 * puisqu'on ne sait pas ou le troncon s'arrete. Les autres controles s'appliquent quand meme.
 */
export function refusEtendue(
  type: TypeActif,
  e: EtendueActif,
  longueurTronconM: number | null,
): RefusEtendue | null {
  const forme = FORME_PAR_TYPE[type];
  const declaree = e.abscisseDebutM !== null || e.abscisseFinM !== null;

  // Un type lineaire SANS etendue n'est pas refuse : un fosse peut etre repere avant d'etre
  // mesure, et exiger les bornes des la creation empecherait de l'inventorier du tout.
  if (!declaree) return null;

  if (forme === "PONCTUEL") return "TYPE_PONCTUEL";
  if (e.abscisseDebutM === null || e.abscisseFinM === null) return "ETENDUE_INCOMPLETE";
  if (!Number.isFinite(e.abscisseDebutM) || !Number.isFinite(e.abscisseFinM)) return "ETENDUE_INCOMPLETE";
  if (e.abscisseDebutM < 0) return "ETENDUE_NEGATIVE";
  if (e.abscisseFinM <= e.abscisseDebutM) return "ETENDUE_INVERSEE";
  if (e.tronconId === null) return "ETENDUE_SANS_TRONCON";
  if (e.abscisseFinM - e.abscisseDebutM < LONGUEUR_ACTIF_MINIMALE_M) return "TROP_COURTE";
  if (longueurTronconM !== null && e.abscisseFinM > longueurTronconM + 0.05) {
    return "ETENDUE_HORS_TRONCON";
  }
  return null;
}

/** Longueur de l'etendue, ou `null` quand elle n'est pas declaree. */
export function longueurEtendueM(e: EtendueActif): number | null {
  if (e.abscisseDebutM === null || e.abscisseFinM === null) return null;
  return Math.round((e.abscisseFinM - e.abscisseDebutM) * 100) / 100;
}

/**
 * Quelle longueur retenir pour un actif, et d'ou elle vient.
 *
 * POURQUOI LA PROVENANCE EST RENDUE AVEC LA VALEUR
 *
 * `longueurM` est une donnee DECLAREE, saisie par un agent. L'etendue est une MESURE le long
 * du trace. Les deux peuvent differer, et rendre un nombre nu obligerait l'appelant a
 * deviner lequel il tient. Un metre de curage de fosse etabli sur une longueur declaree et
 * un metre etabli sur l'etendue geometrique n'ont pas la meme valeur de preuve.
 *
 * L'ETENDUE PRIME, quand elle existe : elle se verifie contre la geometrie, la declaration
 * non.
 */
export function longueurRetenue(
  e: EtendueActif,
  longueurDeclareeM: number | null,
): { longueurM: number; provenance: "ETENDUE" | "DECLAREE" } | null {
  const etendue = longueurEtendueM(e);
  if (etendue !== null) return { longueurM: etendue, provenance: "ETENDUE" };
  if (longueurDeclareeM !== null && Number.isFinite(longueurDeclareeM) && longueurDeclareeM > 0) {
    return { longueurM: longueurDeclareeM, provenance: "DECLAREE" };
  }
  return null;
}

/** Les types qui acceptent une etendue. Utile a un formulaire pour n'afficher que l'utile. */
export function typesAvecEtendue(): TypeActif[] {
  return (Object.keys(FORME_PAR_TYPE) as TypeActif[])
    .filter((t) => FORME_PAR_TYPE[t] !== "PONCTUEL");
}
