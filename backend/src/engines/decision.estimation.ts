/**
 * Ce que l'ecran d'aide a la decision peut dire du cout et de la criticite d'un troncon.
 *
 * CE QUE CE FICHIER REMPLACE, ET POURQUOI
 *
 * `/api/dashboard/decision` portait deux baremes codes en dur :
 *
 *   COUT_REHAB_ESTIME_M_PAR_KM   { CRITIQUE: 800, MAUVAIS: 500, MOYEN: 150, BON: 0, NON_EVALUE: 200 }
 *   CRITICITE_ESTIMEE_PAR_CLASSE { RN: 90, RR: 70, RU: 50, PISTE: 30 }
 *
 * Le commentaire les appelait honnetement « estimations » et les suffixait `Estime`. Mais ce
 * sont des NORMES INVENTEES au sens du garde-fou V10 : personne ne les a arretees, et elles
 * CONTREDISENT les neuf baremes de `baremes_intervention` -- 800 millions GNF/km pour un
 * troncon critique, la ou le bareme dit 3,5 milliards pour une reconstruction bitume. Un ecran
 * de decision qui classe des troncons sur un prix que la base dement n'aide pas a decider.
 *
 * Ce module fait passer l'ecran par le moteur de cout (`cout.noyau.ts`), qui REFUSE quand il
 * ne sait pas : pas de ligne de bareme pour cet (revetement, etat), revetement non renseigne,
 * etat BON ou NON_EVALUE. Le montant devient alors `null`, et le motif est rendu. Un `null` se
 * lit « on ne sait pas » ; un 200 millions/km inventé se lisait « on sait ».
 *
 * La criticite est traitee de meme : il n'en existe AUCUNE source -- ni renseignee en base, ni
 * calculee par un moteur de risque (absent, voir MAINTENANCE_PROGRAMMING_DESIGN.md § 3.2). La
 * deduire de la classe de route etait une ponderation inventee. Elle est rendue `null`, et le
 * client le sait par `criteresReels.criticite = false`, qu'il affichait deja.
 *
 * AUCUN IMPORT hors des deux noyaux, eux-memes sans import.
 */

import { estimer, type LigneBareme } from "./cout.noyau";
import { familleCoutDeTroncon } from "./famille-cout";

export interface TronconPourDecision {
  etat: string;
  revetement: string | null | undefined;
  longueurKm: number | null | undefined;
  traficMoyenJma: number | null | undefined;
}

export interface EstimationDecision {
  /** Montant en MILLIARDS de GNF, pour rester compatible avec le client, ou `null` si refus. */
  montantRehabEstimeMd: number | null;
  /** Toujours `null` : aucune source. Conserve pour ne pas casser le client. */
  criticiteEstimee: null;
  estimationCout: {
    ok: boolean;
    classePrecision: string | null;
    margePct: number | null;
    provisoire: boolean;
    hypothesesManquantes: string[];
    bareme: { code: string | null; typeIntervention: string } | null;
    refus: { code: string; motif: string } | null;
    calcul: string | null;
  };
  estimations: { criticite: string; cout: string };
  criteresReels: { etat: boolean; trafic: boolean; criticite: boolean; cout: boolean };
}

/** Arrondi au million, puis en milliards a trois decimales : un affichage, pas une comptabilite. */
function enMilliards(montantGnf: bigint): number {
  const millions = Number(montantGnf / 1_000_000n);
  return Math.round(millions) / 1000;
}

export function estimerPourDecision(t: TronconPourDecision, baremes: readonly LigneBareme[]): EstimationDecision {
  const famille = familleCoutDeTroncon(t.revetement);
  const longueurM = (t.longueurKm ?? 0) * 1000;

  const resultat = famille === null
    ? { ok: false as const, code: "AUCUNE_LIGNE_DE_BAREME", motif: `revetement ${t.revetement ?? "inconnu"} : aucune famille de cout, le troncon ne se chiffre pas` }
    : estimer({ familleRevetement: famille, etatDepart: t.etat, longueurM, niveauMesure: "REFERENTIEL" }, baremes);

  const base = {
    criticiteEstimee: null as null,
    estimations: {
      criticite: "aucune source : la criticité n'est ni renseignée en base ni calculée par un moteur de risque",
      cout: "",
    },
    criteresReels: {
      etat: t.etat !== "NON_EVALUE",
      trafic: t.traficMoyenJma != null,
      criticite: false,
      // Le cout n'est JAMAIS un critere reel ici : c'est une estimation reseau a +-30 %, sur un
      // bareme non approuve. Le dire vrai ferait peser une hypothese comme un constat.
      cout: false,
    },
  };

  if (!resultat.ok) {
    return {
      ...base,
      montantRehabEstimeMd: null,
      estimationCout: { ok: false, classePrecision: null, margePct: null, provisoire: true, hypothesesManquantes: [], bareme: null, refus: { code: resultat.code, motif: resultat.motif }, calcul: null },
      estimations: { ...base.estimations, cout: `non estimé — ${resultat.motif}` },
    };
  }

  const manque = resultat.hypothesesManquantes.length > 0 ? ` ; ${resultat.hypothesesManquantes.join(", ")}` : "";
  return {
    ...base,
    montantRehabEstimeMd: enMilliards(resultat.montant),
    estimationCout: {
      ok: true,
      classePrecision: resultat.classePrecision,
      margePct: resultat.margePct,
      provisoire: resultat.provisoire,
      hypothesesManquantes: resultat.hypothesesManquantes,
      bareme: { code: resultat.bareme.code, typeIntervention: resultat.bareme.typeIntervention },
      refus: null,
      calcul: resultat.calcul,
    },
    estimations: {
      ...base.estimations,
      cout: `estimation réseau ±${resultat.margePct ?? 30} % sur le barème ${resultat.bareme.code ?? resultat.bareme.typeIntervention}${resultat.provisoire ? " (provisoire" + manque + ")" : ""}`,
    },
  };
}
