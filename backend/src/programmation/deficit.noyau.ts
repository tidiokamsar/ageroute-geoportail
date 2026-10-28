/**
 * BILAN BUDGETAIRE D'UNE SIMULATION : consomme, reste, besoin, deficit. AUCUN IMPORT, aucun acces base.
 *
 * LES QUATRE QUANTITES, ET POURQUOI UN DEFICIT N'EST PAS « L'ENVELOPPE MOINS LE CONSOMME »
 *
 *   consomme = somme des couts des interventions RETENUES ;
 *   reste    = enveloppe - consomme (jamais negatif : une intervention n'est retenue que si elle tient) ;
 *   besoin   = somme des couts FIABLES de tous les candidats chiffrables (retenus ou non) ;
 *   deficit  = besoin - enveloppe, s'il est strictement positif, sinon 0.
 *
 * Le reste dit ce qui n'a pas ete depense ; le deficit dit ce qui manque pour tout financer. Ce sont deux
 * informations distinctes : une enveloppe de 10 Md peut avoir un reste de 3 Md (aucune intervention restante
 * ne tient dedans) ET un deficit de 20 Md. Les deux sont rendus, aucun ne masque l'autre.
 *
 * LE DEFICIT EST UN MINORANT QUAND DES COUTS SONT INCONNUS. Un candidat dont le cout manque, est perime ou n'a
 * pas de traitement n'est PAS compte dans le besoin (on n'invente pas de montant) : le besoin reel est au moins
 * celui-ci. `deficitMinorant` le dit, et `nbCoutsNonFiables` en donne le nombre. Un deficit nul avec des couts
 * inconnus ne veut donc pas dire « tout est finance ».
 *
 * MONTANTS : BigInt en entree, CHAINES DE CHIFFRES en sortie (un GNF depasse 2^53 sur un reseau reel). Le solde
 * est une chaine signee (« -1200 ») : jamais un negatif masque par un maximum avec zero. Aucun flottant.
 */

export const MENTION_SIMULATION = "SIMULATION NON ENGAGEANTE : ne constitue ni une autorisation de dépense ni un ordre de travaux.";

export interface EntreesBilan {
  enveloppeGnf: bigint;
  /** Somme des couts retenus : le bilan verifie qu'elle ne depasse pas l'enveloppe (invariant du moteur). */
  consommeGnf: bigint;
  /** Couts fiables de tous les candidats chiffrables (retenus ou non). */
  coutsFiablesGnf: readonly bigint[];
  /** Candidats dont le cout est inconnu, perime ou sans traitement : leur besoin n'est pas dans le total. */
  nbCoutsNonFiables: number;
  /** Couts fiables des interventions obligatoires. */
  coutsObligatoiresGnf: readonly bigint[];
}

export interface BilanBudgetaire {
  enveloppeGnf: string;
  consommeGnf: string;
  resteGnf: string;
  besoinTotalGnf: string;
  /** Besoin - enveloppe si positif, sinon "0". */
  deficitGnf: string;
  /** Enveloppe - besoin si positif, sinon "0". */
  excedentGnf: string;
  /** Enveloppe - besoin, SIGNE : "-1200" signifie 1 200 GNF de deficit. Jamais masque. */
  soldeGnf: string;
  /** Part du besoin couverte par l'enveloppe, en pourcent a une decimale (« 66.6 ») ; `null` si le besoin est nul. */
  couvertureBesoinPct: string | null;
  nbCoutsFiables: number;
  nbCoutsNonFiables: number;
  /** Vrai si des couts inconnus ne sont pas comptes : le deficit reel est au moins celui-ci. */
  deficitMinorant: boolean;
  besoinObligatoiresGnf: string;
  /** Besoin des obligatoires - enveloppe, si positif : les obligatoires seuls depassent l'enveloppe. */
  deficitObligatoiresGnf: string;
}

const somme = (l: readonly bigint[]): bigint => l.reduce((a, b) => a + b, 0n);

/** Pourcentage a UNE decimale, tronque, calcule en entiers ; `null` si le denominateur est nul. */
export function pourcentage(numerateur: bigint, denominateur: bigint): string | null {
  if (denominateur <= 0n) return null;
  const dixiemes = (numerateur * 1000n) / denominateur;
  return `${(dixiemes / 10n).toString()}.${(dixiemes % 10n).toString()}`;
}

export function bilanBudgetaire(e: EntreesBilan): BilanBudgetaire {
  if (e.enveloppeGnf < 0n) throw new Error("bilanBudgetaire : enveloppe negative");
  if (e.consommeGnf < 0n || e.consommeGnf > e.enveloppeGnf) throw new Error("bilanBudgetaire : le consomme depasse l'enveloppe (invariant rompu)");
  const besoin = somme(e.coutsFiablesGnf);
  const besoinOblig = somme(e.coutsObligatoiresGnf);
  const solde = e.enveloppeGnf - besoin;
  return {
    enveloppeGnf: e.enveloppeGnf.toString(),
    consommeGnf: e.consommeGnf.toString(),
    resteGnf: (e.enveloppeGnf - e.consommeGnf).toString(),
    besoinTotalGnf: besoin.toString(),
    deficitGnf: (solde < 0n ? -solde : 0n).toString(),
    excedentGnf: (solde > 0n ? solde : 0n).toString(),
    soldeGnf: solde.toString(),
    couvertureBesoinPct: pourcentage(e.enveloppeGnf < besoin ? e.enveloppeGnf : besoin, besoin),
    nbCoutsFiables: e.coutsFiablesGnf.length,
    nbCoutsNonFiables: e.nbCoutsNonFiables,
    deficitMinorant: e.nbCoutsNonFiables > 0,
    besoinObligatoiresGnf: besoinOblig.toString(),
    deficitObligatoiresGnf: (besoinOblig > e.enveloppeGnf ? besoinOblig - e.enveloppeGnf : 0n).toString(),
  };
}
