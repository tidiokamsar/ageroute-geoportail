/**
 * ESTIMATION DE COUT -- noyau du Cost Engine (paragraphe 7.7). AUCUN IMPORT.
 *
 * « Estimation = quantites issues du referentiel x bordereau, avec CLASSE DE PRECISION
 * affichee : estimation reseau (+-30 %), pre-etude (+-15 %), metre detaille valide. » Et le
 * garde-fou : « Distinguer clairement estimation reseau / pre-etude / metre detaille valide.
 * AUCUNE estimation ne cree de marche, contrat, ordre de travaux, chantier, decompte,
 * certification de paiement ou engagement financier. »
 *
 * LA REGLE QUI FAIT CE MODULE : IL REFUSE QUAND IL NE SAIT PAS.
 *
 * `baremes_intervention` compte neuf lignes, et aucune pour BETON, AUTRE ou NON_RENSEIGNE
 * (D-07). Un moteur qui « completerait » avec la ligne la plus proche produirait un montant
 * d'apparence complete pour une chaussee dont personne n'a jamais chiffre le prix. Deviner un
 * prix est pire que n'en donner aucun : ce module rend un REFUS MOTIVE, et l'appelant doit
 * l'afficher comme tel.
 *
 * CE QUE « PROVISOIRE » VEUT DIRE ICI, ET POURQUOI C'EST PRESQUE TOUJOURS LE CAS
 *
 * Un montant est provisoire des que l'une de ces conditions tient :
 *   - la ligne de bareme n'est pas approuvee (`approuveLe` nul) -- aucune des neuf ne l'est ;
 *   - la ligne n'a pas de millesime (`anneeReference` nul) : « 3,5 milliards GNF/km » sans
 *     annee ne se compare a rien et ne s'actualise pas ;
 *   - la ligne n'a pas de largeur de chaussee de reference : le meme prix au kilometre peut
 *     designer une 2x2 voies ou une piste de 5 m.
 * Les hypotheses manquantes sont RENDUES NOMMEMENT dans le resultat. Rien n'est complete par
 * defaut : ni annee, ni largeur, ni famille.
 *
 * LE MONTANT EST UN BIGINT, et il faut dire pourquoi sans exagerer. Une estimation isolee tient
 * dans un double : 3,5 milliards/km x 21 156,6 km = 7,4 x 10^13, sous 2^53 (9 x 10^15). Trois
 * raisons tout de meme : `coutKmGnf` EST un BigInt en base et le convertir en nombre serait
 * une perte de type gratuite ; les totaux d'un programme pluriannuel multi-scenarios
 * s'additionnent ; et surtout un montant en francs doit etre EXACT au franc, ce qu'un flottant
 * ne garantit pas des que les produits intermediaires grossissent. La division par 1 000 pour
 * passer du kilometre au metre est entiere : on arrondit au franc inferieur, et on le dit, pour
 * que deux calculs donnent toujours le meme franc.
 */

/** Une ligne de bareme, telle que `baremes_intervention` la porte (champs utiles au calcul). */
export interface LigneBareme {
  id: number | string;
  code?: string | null;
  familleRevetement: string;
  etatDepart: string;
  typeIntervention: string;
  /** Cout au kilometre, en unite monetaire entiere. */
  coutKmGnf: bigint;
  uniteCout: string;
  devise: string;
  anneeReference?: number | null;
  largeurChausseeM?: number | null;
  approuveLe?: Date | string | null;
  actif?: boolean;
}

/** Niveau de connaissance des quantites, qui fixe la classe de precision (paragraphe 7.7). */
export type NiveauMesure = "REFERENTIEL" | "PRE_ETUDE" | "METRE_VALIDE";

export type ClassePrecision = "RESEAU_30" | "PRE_ETUDE_15" | "METRE_DETAILLE";

export const CLASSE_PAR_NIVEAU: Record<NiveauMesure, ClassePrecision> = {
  REFERENTIEL: "RESEAU_30",
  PRE_ETUDE: "PRE_ETUDE_15",
  METRE_VALIDE: "METRE_DETAILLE",
};

/** Marge affichee a cote de la classe, en pourcent. `null` pour un metre valide : la marge est celle du metre. */
export const MARGE_PCT: Record<ClassePrecision, number | null> = {
  RESEAU_30: 30,
  PRE_ETUDE_15: 15,
  METRE_DETAILLE: null,
};

export interface DemandeEstimation {
  familleRevetement: string;
  etatDepart: string;
  /** Longueur a traiter, en metres, issue du referentiel ou du metre. */
  longueurM: number;
  niveauMesure: NiveauMesure;
  /** Type d'intervention vise, s'il est deja choisi ; sinon la matrice (famille, etat) le donne. */
  typeIntervention?: string | null;
}

export type CodeRefusEstimation =
  | "LONGUEUR_INVALIDE"
  | "AUCUNE_LIGNE_DE_BAREME"
  | "PLUSIEURS_LIGNES_DE_BAREME"
  | "UNITE_NON_GEREE"
  | "COUT_INVALIDE";

export interface Estimation {
  ok: true;
  montant: bigint;
  devise: string;
  classePrecision: ClassePrecision;
  margePct: number | null;
  /** Vrai si le montant ne peut pas etre presente comme officiel. Voir l'en-tete. */
  provisoire: boolean;
  /** Ce qui manque pour que le montant soit lisible : chaque element est une hypothese NON FAITE. */
  hypothesesManquantes: string[];
  bareme: { id: number | string; code: string | null; typeIntervention: string; coutKm: bigint; anneeReference: number | null; largeurChausseeM: number | null; approuve: boolean };
  longueurM: number;
  /** Note de calcul, pour la decomposition « pourquoi ce montant ». */
  calcul: string;
}

export type ResultatEstimation = Estimation | { ok: false; code: CodeRefusEstimation; motif: string };

export const EXPLICATIONS_REFUS: Record<CodeRefusEstimation, string> = {
  LONGUEUR_INVALIDE: "La longueur doit etre un nombre strictement positif de metres.",
  AUCUNE_LIGNE_DE_BAREME: "Aucune ligne de bareme ne couvre cette famille de revetement et cet etat : le moteur n'estime pas ce qu'il ne sait pas chiffrer.",
  PLUSIEURS_LIGNES_DE_BAREME: "Plusieurs lignes de bareme couvrent ce cas : precisez le type d'intervention, le moteur ne choisit pas a votre place.",
  UNITE_NON_GEREE: "Cette unite de cout n'est pas geree : seul le cout au kilometre l'est aujourd'hui.",
  COUT_INVALIDE: "Le cout de la ligne de bareme n'est pas un montant positif.",
};

function estActive(b: LigneBareme): boolean {
  return b.actif !== false;
}

/**
 * Trouve LA ligne de bareme applicable, ou refuse.
 *
 * Deux candidates sans type d'intervention precise sont un refus, pas un choix : trancher entre
 * rehabilitation et reconstruction est une decision de programmation, pas d'arithmetique.
 */
export function ligneApplicable(
  d: Pick<DemandeEstimation, "familleRevetement" | "etatDepart" | "typeIntervention">,
  baremes: readonly LigneBareme[],
): { ok: true; ligne: LigneBareme } | { ok: false; code: CodeRefusEstimation; motif: string } {
  const candidates = baremes.filter((b) =>
    estActive(b)
    && b.familleRevetement === d.familleRevetement
    && b.etatDepart === d.etatDepart
    && (!d.typeIntervention || b.typeIntervention === d.typeIntervention));

  if (candidates.length === 0) {
    return { ok: false, code: "AUCUNE_LIGNE_DE_BAREME", motif: `${EXPLICATIONS_REFUS.AUCUNE_LIGNE_DE_BAREME} (${d.familleRevetement}, ${d.etatDepart}${d.typeIntervention ? `, ${d.typeIntervention}` : ""})` };
  }
  if (candidates.length > 1) {
    return { ok: false, code: "PLUSIEURS_LIGNES_DE_BAREME", motif: `${EXPLICATIONS_REFUS.PLUSIEURS_LIGNES_DE_BAREME} (${candidates.map((c) => c.typeIntervention).join(", ")})` };
  }
  return { ok: true, ligne: candidates[0] };
}

/**
 * Estime, ou refuse en disant pourquoi.
 */
export function estimer(d: DemandeEstimation, baremes: readonly LigneBareme[]): ResultatEstimation {
  if (!Number.isFinite(d.longueurM) || d.longueurM <= 0) {
    return { ok: false, code: "LONGUEUR_INVALIDE", motif: `${EXPLICATIONS_REFUS.LONGUEUR_INVALIDE} (recu : ${d.longueurM})` };
  }

  const choix = ligneApplicable(d, baremes);
  if (!choix.ok) return choix;
  const b = choix.ligne;

  if (b.uniteCout !== "KM") {
    return { ok: false, code: "UNITE_NON_GEREE", motif: `${EXPLICATIONS_REFUS.UNITE_NON_GEREE} (recu : ${b.uniteCout})` };
  }
  if (typeof b.coutKmGnf !== "bigint" || b.coutKmGnf <= 0n) {
    return { ok: false, code: "COUT_INVALIDE", motif: EXPLICATIONS_REFUS.COUT_INVALIDE };
  }

  // Metres entiers, puis cout_km x metres / 1000, arrondi au franc inferieur. Ecrit en une
  // seule expression pour que deux appels donnent toujours le meme franc.
  const metres = BigInt(Math.round(d.longueurM));
  const montant = (b.coutKmGnf * metres) / 1000n;

  const approuve = b.approuveLe !== null && b.approuveLe !== undefined;
  const hypothesesManquantes: string[] = [];
  if (!approuve) hypothesesManquantes.push("ligne de bareme non approuvee");
  if (b.anneeReference === null || b.anneeReference === undefined) hypothesesManquantes.push("millesime du prix inconnu");
  if (b.largeurChausseeM === null || b.largeurChausseeM === undefined) hypothesesManquantes.push("largeur de chaussee de reference inconnue");

  const classePrecision = CLASSE_PAR_NIVEAU[d.niveauMesure];

  return {
    ok: true,
    montant,
    devise: b.devise,
    classePrecision,
    margePct: MARGE_PCT[classePrecision],
    provisoire: hypothesesManquantes.length > 0,
    hypothesesManquantes,
    bareme: {
      id: b.id, code: b.code ?? null, typeIntervention: b.typeIntervention, coutKm: b.coutKmGnf,
      anneeReference: b.anneeReference ?? null, largeurChausseeM: b.largeurChausseeM ?? null, approuve,
    },
    longueurM: d.longueurM,
    calcul: `${b.coutKmGnf.toString()} ${b.devise}/km x ${metres.toString()} m / 1000 = ${montant.toString()} ${b.devise} (arrondi au franc inferieur)`,
  };
}

/**
 * Formate un montant pour l'affichage, en separant les milliers, SANS jamais le convertir en
 * nombre flottant -- c'est la perte de precision que le BigInt existe pour eviter.
 */
export function formaterMontant(m: bigint, devise: string): string {
  const s = m.toString();
  const avecSep = s.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${avecSep} ${devise}`;
}
