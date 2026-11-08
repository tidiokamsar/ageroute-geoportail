/**
 * MACHINE A ETATS DE L'OUTBOX ET POLITIQUE DE REPRISE. AUCUN IMPORT DE BASE, AUCUN RESEAU.
 *
 *   EN_ATTENTE --reclamation--> EN_COURS --accepte / doublon reconnu--> ENVOYE      (terminal)
 *                                  |--echec temporaire, tentatives restantes--> ECHEC --echeance--> EN_COURS
 *                                  |--echec temporaire, tentatives epuisees---> ABANDONNE
 *                                  |--refus definitif (4xx) -------------------> ABANDONNE
 *   ECHEC | ABANDONNE --relance humaine--> EN_ATTENTE
 *   EN_ATTENTE | ECHEC --abandon humain motive--> ABANDONNE
 *
 * ENVOYE est TERMINAL : aucune transition n'en sort. C'est ce qui rend le rejeu sans effet de
 * bord. Re-emettre une donnee dont le contenu a change cree un NOUVEL evenement (version + 1),
 * jamais une modification de l'ancien.
 *
 * LES MEMES TRANSITIONS SONT TENUES PAR LE DECLENCHEUR `outbox_garde` : ce fichier decide, la
 * base refuse ce qui lui aurait echappe. Les deux listes doivent rester identiques (test).
 *
 * LA TEMPORISATION est exponentielle et BORNEE : base * 2^(n-1), plafonnee, avec une gigue qui ne
 * fait que RACCOURCIR (jusqu'a -20 %), de sorte que le plafond reste un plafond. La gigue vient
 * d'une valeur injectee (0 en test) : ce noyau n'a pas de hasard.
 */
import type { ResultatEmission, StatutOutbox } from "./types";

export const TRANSITIONS: Record<StatutOutbox, readonly StatutOutbox[]> = {
  EN_ATTENTE: ["EN_COURS", "ABANDONNE"],
  EN_COURS: ["EN_COURS", "ENVOYE", "ECHEC", "ABANDONNE"],
  ECHEC: ["EN_COURS", "EN_ATTENTE", "ABANDONNE"],
  ABANDONNE: ["EN_ATTENTE"],
  ENVOYE: [],
};

export function transitionPermise(de: StatutOutbox, vers: StatutOutbox): boolean {
  return TRANSITIONS[de].includes(vers);
}

/** Un evenement ENVOYE ne change plus jamais. */
export function estTerminal(statut: StatutOutbox): boolean {
  return TRANSITIONS[statut].length === 0;
}

export interface PolitiqueReprise {
  tentativesMax: number;
  delaiBaseMs: number;
  delaiPlafondMs: number;
}

export const POLITIQUE_PAR_DEFAUT: PolitiqueReprise = {
  tentativesMax: 8,
  delaiBaseMs: 30_000,
  delaiPlafondMs: 3_600_000,
};

/**
 * Delai avant la tentative suivante, apres `echecs` echecs consecutifs (>= 1).
 * `gigue` est dans [0, 1) : 0 = delai plein, proche de 1 = delai reduit de 20 %.
 */
export function delaiAvantReprise(echecs: number, p: Pick<PolitiqueReprise, "delaiBaseMs" | "delaiPlafondMs">, gigue = 0): number {
  const n = Math.max(1, Math.floor(echecs));
  const g = Math.min(Math.max(gigue, 0), 0.999999);
  // 2 ** (n - 1) deborde pour n tres grand : on plafonne l'exposant avant de multiplier.
  const brut = p.delaiBaseMs * 2 ** Math.min(n - 1, 40);
  const borne = Math.min(brut, p.delaiPlafondMs);
  return Math.max(0, Math.round(borne * (1 - 0.2 * g)));
}

export type Decision =
  | { statut: "ENVOYE"; tentatives: number; accuseReference: string; doublon: boolean }
  | { statut: "ECHEC"; tentatives: number; prochaineTentativeLe: Date; code: string; message: string }
  | { statut: "ABANDONNE"; tentatives: number; code: string; message: string; motifAbandon: string };

/**
 * Ce que devient un evenement apres une tentative.
 *
 * ECHEC_TEMPORAIRE (reseau, delai depasse, 5xx, 408, 425, 429) et ACCUSE_INVALIDE (la reponse est
 * 2xx mais ne ressemble pas a un accuse de reception) se retentent : dans le second cas on ne sait
 * pas si le destinataire a traite, et la cle d'idempotence rend la reprise sure. Les deux sont
 * bornes par `tentativesMax`.
 *
 * ECHEC_DEFINITIF (autres 4xx, redirection) ne se retente pas seul : retenter un refus ne le
 * change pas, et cela fabriquerait du bruit chez un tiers. Il faut un humain (relance).
 */
export function decider(
  resultat: ResultatEmission,
  contexte: { tentativesAvant: number; maintenant: Date; politique: PolitiqueReprise; gigue?: number },
): Decision {
  const tentatives = contexte.tentativesAvant + 1;
  if (resultat.issue === "ACCEPTE" || resultat.issue === "DOUBLON_RECONNU") {
    return { statut: "ENVOYE", tentatives, accuseReference: resultat.accuseReference, doublon: resultat.issue === "DOUBLON_RECONNU" };
  }
  if (resultat.issue === "ECHEC_DEFINITIF") {
    return {
      statut: "ABANDONNE", tentatives, code: resultat.codeErreur, message: resultat.message,
      motifAbandon: `REFUS_DEFINITIF : ${resultat.codeErreur} (${resultat.message})`,
    };
  }
  if (tentatives >= contexte.politique.tentativesMax) {
    return {
      statut: "ABANDONNE", tentatives, code: resultat.codeErreur, message: resultat.message,
      motifAbandon: `TENTATIVES_EPUISEES : ${tentatives} sur ${contexte.politique.tentativesMax}, dernier echec ${resultat.codeErreur}`,
    };
  }
  const delai = delaiAvantReprise(tentatives, contexte.politique, contexte.gigue ?? 0);
  return {
    statut: "ECHEC", tentatives, code: resultat.codeErreur, message: resultat.message,
    prochaineTentativeLe: new Date(contexte.maintenant.getTime() + delai),
  };
}
