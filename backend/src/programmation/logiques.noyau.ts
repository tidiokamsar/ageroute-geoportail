/**
 * LOGIQUES D'ARBITRAGE DU SIMULATEUR : dans quel ORDRE le simulateur examine les interventions. AUCUN IMPORT.
 *
 * PRIORITE TECHNIQUE ET ORDRE D'ARBITRAGE SONT DEUX CHOSES (audit du lot 0 : « le ratio cout/impact classe un
 * troncon CRITIQUE dernier s'il est cher »). La `prioriteTechnique` dit quelle intervention est la plus urgente
 * a traiter en soi ; l'`ordreArbitrage` dit dans quel ordre le budget est distribue. Ce module ne produit QUE
 * l'ordre d'arbitrage, et il ne remplace jamais la priorite technique : chaque ligne du simulateur porte les
 * deux, separement. Choisir « criticite » ou « urgence » rapproche l'arbitrage de la priorite technique ; choisir
 * « ratio_cout_impact » l'en eloigne volontairement (c'est l'objet de cette logique : le plus de risque par franc).
 *
 * CINQ LOGIQUES, TOUTES DETERMINISTES (ordre TOTAL : le dernier departage est le code puis l'identifiant) :
 *
 *   ratio_cout_impact      risque attendu / cout decroissant, compare EXACTEMENT en BigInt (produit croise).
 *                          C'est l'ordre historique du moteur v2 : meme resultat que `construireScenario`.
 *   urgence                gravite de l'etat decroissante (CRITIQUE, MAUVAIS, MOYEN, BON), puis AGGRAVATION attendue
 *                          a l'horizon (risque attendu - risque courant) decroissante, puis risque courant.
 *                          PROVISOIRE : la donnee ne porte ni l'anciennete d'un defaut ni la date du dernier constat ;
 *                          l'urgence n'est donc lue que dans l'etat et la projection de degradation du moteur.
 *   criticite              risque COURANT decroissant, sans le cout : la criticite pure (le meme indice que la
 *                          priorite technique du moteur), puis risque attendu decroissant, puis cout croissant.
 *   equilibre_territorial  ordre de base = ratio_cout_impact ; la REGLE d'equilibre (plancher de depense par
 *                          region) est appliquee a la selection, voir `contraintes.noyau.ts`.
 *   personnalise           l'ordre fourni par l'utilisateur (liste d'identifiants de troncons, validee : pas de doublon,
 *                          tout identifiant est un candidat) ; les candidats NON listes passent apres, dans l'ordre du ratio.
 *
 * AUCUNE LOGIQUE NE COMBLE UN MANQUE : un element sans risque calculable ou sans cout fiable n'arrive jamais
 * ici, il est ecarte avant avec son motif. Les ordres ne portent que sur des interventions chiffrables.
 */

export const CODES_LOGIQUE = ["ratio_cout_impact", "urgence", "criticite", "equilibre_territorial", "personnalise"] as const;
export type CodeLogique = (typeof CODES_LOGIQUE)[number];

export const estCodeLogique = (v: unknown): v is CodeLogique => typeof v === "string" && (CODES_LOGIQUE as readonly string[]).includes(v);

export interface DefinitionLogique {
  code: CodeLogique;
  libelle: string;
  /** Une phrase que l'ecran affiche : ce que la logique fait. */
  explication: string;
  /** La regle, assez precise pour etre refaite a la main. */
  regle: string;
  /** Vrai si la regle repose sur une convention non validee par le metier. */
  provisoire: boolean;
  /** Parametres que la logique exige en plus de l'enveloppe. */
  exige: readonly ("ordrePersonnalise" | "equilibre")[];
}

export const LOGIQUES: readonly DefinitionLogique[] = [
  {
    code: "ratio_cout_impact", libelle: "Ratio coût / impact", provisoire: false, exige: [],
    explication: "Retient d'abord les interventions qui réduisent le plus de risque par franc dépensé.",
    regle: "risque attendu / coût décroissant (produit croisé exact en entiers) ; départage : risque courant décroissant, coût croissant, code, identifiant.",
  },
  {
    code: "urgence", libelle: "Urgence", provisoire: true, exige: [],
    explication: "Retient d'abord les tronçons dont l'état est le plus dégradé, puis ceux dont la dégradation attendue est la plus forte.",
    regle: "état décroissant (CRITIQUE, MAUVAIS, MOYEN, BON), puis aggravation attendue (risque attendu - risque courant) décroissante, puis risque courant décroissant, coût croissant, code, identifiant. Provisoire : aucune ancienneté de défaut ni date de constat n'est disponible.",
  },
  {
    code: "criticite", libelle: "Criticité", provisoire: false, exige: [],
    explication: "Retient d'abord les tronçons au risque courant le plus élevé, quel que soit leur coût.",
    regle: "risque courant décroissant, puis risque attendu décroissant, coût croissant, code, identifiant.",
  },
  {
    code: "equilibre_territorial", libelle: "Équilibre territorial", provisoire: true, exige: ["equilibre"],
    explication: "Garantit à chaque région une part minimale de l'enveloppe, puis distribue le reste par ratio coût / impact.",
    regle: "Pour chaque région (ordre croissant), retient ses interventions par ratio coût / impact tant que sa dépense est inférieure au plancher (part minimale x enveloppe), un plancher pouvant être dépassé par la dernière intervention retenue (coût non divisible) ; puis le reste de l'enveloppe est distribué par ratio coût / impact. Un plancher non atteint est rendu en contrainte insatisfaisable, jamais comblé en silence.",
  },
  {
    code: "personnalise", libelle: "Ordre personnalisé", provisoire: false, exige: ["ordrePersonnalise"],
    explication: "Suit l'ordre fourni par l'utilisateur ; les tronçons non listés passent ensuite, par ratio coût / impact.",
    regle: "liste d'identifiants de tronçons dans l'ordre voulu (sans doublon, tous candidats) ; les non listés suivent dans l'ordre du ratio coût / impact.",
  },
];

export const logiqueDe = (code: CodeLogique): DefinitionLogique => LOGIQUES.find((l) => l.code === code) as DefinitionLogique;

/** Ce que les logiques lisent d'une intervention chiffrable. Montants en BigInt, risques en entiers (score x 10 000). */
export interface ElementClassable {
  id: string;
  code: string;
  regionId: number | null;
  coutGnf: bigint;
  risqueMicro: number;
  attenduMicro: number;
  etat: string | null;
}

const GRAVITE_ETAT: Record<string, number> = { BON: 0, MOYEN: 1, MAUVAIS: 2, CRITIQUE: 3 };

const comparerChaines = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Departage final commun : cout croissant, puis code, puis identifiant. */
function departage(a: ElementClassable, b: ElementClassable): number {
  if (a.coutGnf !== b.coutGnf) return a.coutGnf < b.coutGnf ? -1 : 1;
  return comparerChaines(a.code, b.code) || comparerChaines(a.id, b.id);
}

/** Meme ordre que `comparerPriorite` de `scenario.noyau.ts` (un test le verifie sur 2000 candidats). */
export function comparerRatio(a: ElementClassable, b: ElementClassable): number {
  const g = BigInt(a.attenduMicro) * b.coutGnf;
  const d = BigInt(b.attenduMicro) * a.coutGnf;
  if (g !== d) return g > d ? -1 : 1;
  if (a.risqueMicro !== b.risqueMicro) return a.risqueMicro > b.risqueMicro ? -1 : 1;
  return departage(a, b);
}

function comparerUrgence(a: ElementClassable, b: ElementClassable): number {
  const ga = GRAVITE_ETAT[a.etat ?? ""] ?? -1, gb = GRAVITE_ETAT[b.etat ?? ""] ?? -1;
  if (ga !== gb) return ga > gb ? -1 : 1;
  const aa = a.attenduMicro - a.risqueMicro, ab = b.attenduMicro - b.risqueMicro;
  if (aa !== ab) return aa > ab ? -1 : 1;
  if (a.risqueMicro !== b.risqueMicro) return a.risqueMicro > b.risqueMicro ? -1 : 1;
  return departage(a, b);
}

function comparerCriticite(a: ElementClassable, b: ElementClassable): number {
  if (a.risqueMicro !== b.risqueMicro) return a.risqueMicro > b.risqueMicro ? -1 : 1;
  if (a.attenduMicro !== b.attenduMicro) return a.attenduMicro > b.attenduMicro ? -1 : 1;
  return departage(a, b);
}

/**
 * Ordre d'arbitrage des interventions chiffrables. Ne modifie pas son entree. L'ordre est total : melanger
 * l'entree ne change pas la sortie.
 */
export function ordonner(elements: readonly ElementClassable[], logique: CodeLogique, ordrePersonnalise: readonly string[] = []): ElementClassable[] {
  const copie = [...elements];
  switch (logique) {
    case "ratio_cout_impact":
    case "equilibre_territorial":
      return copie.sort(comparerRatio);
    case "urgence":
      return copie.sort(comparerUrgence);
    case "criticite":
      return copie.sort(comparerCriticite);
    case "personnalise": {
      const rang = new Map(ordrePersonnalise.map((id, i) => [id, i] as const));
      return copie.sort((a, b) => {
        const ra = rang.get(a.id), rb = rang.get(b.id);
        if (ra !== undefined && rb !== undefined) return ra - rb;
        if (ra !== undefined) return -1;
        if (rb !== undefined) return 1;
        return comparerRatio(a, b);
      });
    }
  }
}
