/**
 * Le JOURNAL : source de verite de la session, pour survivre a un redemarrage.
 *
 * POURQUOI UN JOURNAL ET NON UN INSTANTANE
 *
 * Un telephone peut etre tue a tout instant : memoire, batterie, mise a jour, redemarrage utilisateur.
 * Ecrire l'etat COMPLET a chaque echantillon (7 200 positions en deux heures) est couteux ; ne
 * l'ecrire que de temps en temps perd tout ce qui suit le dernier instantane. Le noyau emet donc
 * chaque changement comme une entree ajoutee a la fin du journal, et l'etat se RECONSTRUIT en
 * rejouant les entrees (`SessionRoulage.rejouer`). Ce qui n'a pas ete ecrit avant la mort du
 * processus est perdu -- et c'est dit : l'interruption REDEMARRAGE couvre l'intervalle inconnu.
 *
 * L'hote (plugin natif, SQLite, IndexedDB) fournit le stockage : ce noyau ne connait qu'un rappel
 * `journal(entree)`. Il n'a AUCUN moyen de verifier que l'hote a vraiment ecrit sur le disque :
 * cela reste a verifier sur appareil.
 */
import type { ParametresRoulage } from "./parametres";
import type {
  Alerte, CauseInterruption, EchantillonGnss, EvenementLineaire, Marqueur, MotifRejet, Qualification, Repere, Trou, TypeAlerte,
} from "./types";

/** Version du format du journal. A incrementer a toute modification incompatible des entrees. */
export const VERSION_JOURNAL = 1;

export type CorpsEntree =
  | { type: "DEMARRAGE"; tMs: number; sessionId: string; parametres: ParametresRoulage; agentRef: string | null; versionJournal: number }
  | {
      type: "ECHANTILLON"; echantillon: EchantillonGnss; segment: number; trou: Trou | null; alertes: TypeAlerte[];
      ecartHorlogeMs: number; sautsConsecutifs: number; identiquesConsecutifs: number;
    }
  | { type: "REJET"; tMs: number; motif: MotifRejet; sautsConsecutifs: number; identiquesConsecutifs: number }
  | { type: "MARQUEUR"; marqueur: Marqueur }
  | { type: "EVT_DEBUT"; evenement: EvenementLineaire }
  | {
      type: "EVT_FIN"; id: string; fin: Repere; statut: "CLOS" | "CLOS_PAR_ARRET"; couvertureGnss: number;
      distanceDirecteM: number | null; avertissements: string[];
    }
  | { type: "EVT_ABANDON"; id: string; tMs: number; motif: string }
  /**
   * Qualification posee ou corrigee sur un evenement ENCORE OUVERT (saisie a la fin du segment, ou changement
   * d'avis en cours de route). Ajoutee apres la version 1 sans en changer la forme : un journal ecrit avant cet
   * ajout se rejoue a l'identique, et seul un journal qui la contient est inconnu des anciennes versions.
   */
  | { type: "EVT_QUALIFICATION"; id: string; qualification: Qualification | null; tMs: number }
  | { type: "PAUSE"; tMs: number }
  | { type: "REPRISE"; tMs: number }
  | { type: "INTERRUPTION_DEBUT"; cause: CauseInterruption; tMs: number }
  | { type: "INTERRUPTION_FIN"; cause: CauseInterruption; tMs: number }
  | { type: "REDEMARRAGE"; tMs: number; dernierMs: number }
  | { type: "ALERTE"; alerte: Alerte }
  | { type: "ARRET"; tMs: number };

export type EntreeJournal = CorpsEntree & { seq: number };

export type SinkJournal = (entree: EntreeJournal) => void;

/** Journal en memoire, pour les tests et les simulations. Un hote reel ecrit sur disque. */
export class JournalMemoire {
  readonly entrees: EntreeJournal[] = [];
  /** Rappel a passer a `SessionRoulage` : `{ journal: j.sink }`. */
  readonly sink: SinkJournal = (e) => {
    // Copie par JSON, comme le ferait une ecriture sur disque : une entree stockee ne partage aucun
    // objet avec l'etat en memoire.
    this.entrees.push(JSON.parse(JSON.stringify(e)) as EntreeJournal);
  };

  /** Simule une mort du processus : seules les `n` premieres entrees avaient ete ecrites. */
  tronque(n: number): EntreeJournal[] {
    return this.entrees.slice(0, Math.max(0, n));
  }
}

/** Une entree par ligne (NDJSON), la forme la plus simple a ajouter a la fin d'un fichier ou d'une table. */
export function serialiserEntree(e: EntreeJournal): string {
  return JSON.stringify(e);
}

export type LectureEntree = { ok: true; entree: EntreeJournal } | { ok: false; raison: string };

/** Relit une ligne. Une ligne illisible (ecriture interrompue en plein milieu) est rapportee, jamais ignoree en silence. */
export function lireEntree(ligne: string): LectureEntree {
  let brut: unknown;
  try { brut = JSON.parse(ligne); } catch { return { ok: false, raison: "JSON_ILLISIBLE" }; }
  if (typeof brut !== "object" || brut === null) return { ok: false, raison: "ENTREE_NON_OBJET" };
  const o = brut as { seq?: unknown; type?: unknown };
  if (!Number.isInteger(o.seq) || (o.seq as number) < 1) return { ok: false, raison: "SEQ_INVALIDE" };
  if (typeof o.type !== "string") return { ok: false, raison: "TYPE_MANQUANT" };
  return { ok: true, entree: brut as EntreeJournal };
}
