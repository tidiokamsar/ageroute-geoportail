/**
 * Etat d'une session de roulage et reducteur du journal.
 *
 * `appliquerEntree` est le SEUL endroit qui modifie l'etat. Les commandes de `SessionRoulage` valident
 * puis produisent une entree ; la rejouer (apres redemarrage) passe par le meme reducteur. Un reducteur
 * ne decide de rien : les seuils ont ete appliques a l'ecriture de l'entree et sont figes dedans.
 *
 * L'etat est mute sur place : une session de deux heures porte 7 200 echantillons, et en recopier la
 * liste a chaque echantillon serait quadratique.
 */
import type { CorpsEntree } from "./journal";
import { MOTIFS_REJET } from "./types";
import type {
  Alerte, EchantillonRetenu, EvenementLineaire, Interruption, Marqueur, MotifRejet, StatutSession, Trou,
} from "./types";
import type { ParametresRoulage } from "./parametres";

/**
 * Copie profonde par JSON. L'etat ne doit JAMAIS partager un objet avec une entree du journal : un
 * evenement cloture ensuite modifierait l'entree qui l'a ouvert, et un rejeu partirait d'un etat deja
 * modifie. Une entree relue depuis un disque est de toute facon une copie.
 */
function copie<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

/** Au-dela, les alertes les plus anciennes sont abandonnees (le compteur reste exact). */
export const ALERTES_MAX = 200;

export interface PauseSession {
  debutMs: number;
  finMs: number | null;
}

export interface EtatSession {
  sessionId: string;
  parametres: ParametresRoulage;
  agentRef: string | null;
  statut: StatutSession;
  debutMs: number;
  finMs: number | null;
  /** Segment du dernier echantillon retenu. */
  segmentCourant: number;
  /** Le prochain echantillon ouvrira un nouveau segment (apres une pause ou un redemarrage). */
  nouveauSegmentAuProchain: boolean;
  echantillons: EchantillonRetenu[];
  rejets: Record<MotifRejet, number>;
  sansPrecision: number;
  trous: Trou[];
  interruptions: Interruption[];
  pauses: PauseSession[];
  marqueurs: Marqueur[];
  evenements: EvenementLineaire[];
  alertes: Alerte[];
  alertesTotal: number;
  sautsConsecutifs: number;
  identiquesConsecutifs: number;
  /** Dernier instant connu du journal, toutes entrees confondues. Sert a borner l'intervalle perdu au redemarrage. */
  dernierInstantMs: number;
  dernierSeq: number;
}

export function compteursRejetsVides(): Record<MotifRejet, number> {
  return Object.fromEntries(MOTIFS_REJET.map((m) => [m, 0])) as Record<MotifRejet, number>;
}

export function etatInitial(args: { sessionId: string; parametres: ParametresRoulage; agentRef: string | null; debutMs: number }): EtatSession {
  return {
    sessionId: args.sessionId,
    parametres: args.parametres,
    agentRef: args.agentRef,
    statut: "EN_COURS",
    debutMs: args.debutMs,
    finMs: null,
    segmentCourant: 0,
    nouveauSegmentAuProchain: false,
    echantillons: [],
    rejets: compteursRejetsVides(),
    sansPrecision: 0,
    trous: [],
    interruptions: [],
    pauses: [],
    marqueurs: [],
    evenements: [],
    alertes: [],
    alertesTotal: 0,
    sautsConsecutifs: 0,
    identiquesConsecutifs: 0,
    dernierInstantMs: args.debutMs,
    dernierSeq: 0,
  };
}

export function dernierEchantillon(etat: EtatSession): EchantillonRetenu | null {
  return etat.echantillons.length > 0 ? etat.echantillons[etat.echantillons.length - 1] : null;
}

function noter(etat: EtatSession, tMs: number): void {
  if (tMs > etat.dernierInstantMs) etat.dernierInstantMs = tMs;
}

function ajouterAlerte(etat: EtatSession, a: Alerte): void {
  etat.alertesTotal += 1;
  etat.alertes.push(a);
  if (etat.alertes.length > ALERTES_MAX) etat.alertes.shift();
}

/** Interruption encore ouverte pour cette cause, la plus recente d'abord. */
export function interruptionOuverte(etat: EtatSession, cause: Interruption["cause"]): Interruption | null {
  for (let i = etat.interruptions.length - 1; i >= 0; i -= 1) {
    const x = etat.interruptions[i];
    if (x.cause === cause && x.finMs === null) return x;
  }
  return null;
}

/**
 * Applique une entree. Rend `null` si elle est coherente, sinon la RAISON pour laquelle elle a ete
 * ignoree (l'etat n'est alors pas modifie). Un journal rejoue apres un crash peut contenir une entree
 * orpheline ; l'ignorer en le disant vaut mieux que de planter ou d'inventer son contexte.
 */
export function appliquerEntree(etat: EtatSession, entree: CorpsEntree & { seq: number }): string | null {
  switch (entree.type) {
    case "DEMARRAGE":
      return "DEMARRAGE_DEJA_APPLIQUE";

    case "ECHANTILLON": {
      const e = entree.echantillon;
      etat.echantillons.push({ ...e, segment: entree.segment });
      etat.segmentCourant = entree.segment;
      etat.nouveauSegmentAuProchain = false;
      etat.sautsConsecutifs = entree.sautsConsecutifs;
      etat.identiquesConsecutifs = entree.identiquesConsecutifs;
      if (entree.trou) etat.trous.push({ ...entree.trou });
      for (const type of entree.alertes) {
        if (type === "SANS_PRECISION") { etat.sansPrecision += 1; continue; }
        ajouterAlerte(etat, { type, tMs: e.tMs });
      }
      noter(etat, e.tMs);
      break;
    }

    case "REJET":
      etat.rejets[entree.motif] += 1;
      etat.sautsConsecutifs = entree.sautsConsecutifs;
      etat.identiquesConsecutifs = entree.identiquesConsecutifs;
      noter(etat, entree.tMs);
      break;

    case "MARQUEUR":
      if (etat.marqueurs.some((m) => m.id === entree.marqueur.id)) return "MARQUEUR_DEJA_PRESENT";
      etat.marqueurs.push(copie(entree.marqueur));
      noter(etat, entree.marqueur.repere.tMs);
      break;

    case "EVT_DEBUT":
      if (etat.evenements.some((x) => x.id === entree.evenement.id)) return "EVENEMENT_DEJA_PRESENT";
      etat.evenements.push(copie(entree.evenement));
      noter(etat, entree.evenement.debut.tMs);
      break;

    case "EVT_FIN": {
      const ev = etat.evenements.find((x) => x.id === entree.id);
      if (!ev) return "EVENEMENT_INCONNU";
      if (ev.statut !== "OUVERT") return "EVENEMENT_NON_OUVERT";
      ev.fin = entree.fin;
      ev.statut = entree.statut;
      ev.couvertureGnss = entree.couvertureGnss;
      ev.distanceDirecteM = entree.distanceDirecteM;
      ev.avertissements = entree.avertissements;
      noter(etat, entree.fin.tMs);
      break;
    }

    case "EVT_ABANDON": {
      const ev = etat.evenements.find((x) => x.id === entree.id);
      if (!ev) return "EVENEMENT_INCONNU";
      if (ev.statut !== "OUVERT") return "EVENEMENT_NON_OUVERT";
      ev.statut = "ABANDONNE";
      ev.motifAbandon = entree.motif;
      noter(etat, entree.tMs);
      break;
    }

    case "PAUSE":
      if (etat.statut !== "EN_COURS") return "PAUSE_HORS_COURS";
      etat.statut = "EN_PAUSE";
      etat.pauses.push({ debutMs: entree.tMs, finMs: null });
      noter(etat, entree.tMs);
      break;

    case "REPRISE": {
      if (etat.statut !== "EN_PAUSE") return "REPRISE_HORS_PAUSE";
      etat.statut = "EN_COURS";
      const p = etat.pauses[etat.pauses.length - 1];
      if (p && p.finMs === null) p.finMs = entree.tMs;
      etat.nouveauSegmentAuProchain = true;
      noter(etat, entree.tMs);
      break;
    }

    case "INTERRUPTION_DEBUT":
      if (interruptionOuverte(etat, entree.cause)) return "INTERRUPTION_DEJA_OUVERTE";
      etat.interruptions.push({ cause: entree.cause, debutMs: entree.tMs, finMs: null });
      noter(etat, entree.tMs);
      break;

    case "INTERRUPTION_FIN": {
      const x = interruptionOuverte(etat, entree.cause);
      if (!x) return "INTERRUPTION_NON_OUVERTE";
      x.finMs = Math.max(entree.tMs, x.debutMs);
      noter(etat, entree.tMs);
      break;
    }

    case "REDEMARRAGE": {
      // Les interruptions du systeme encore ouvertes sont closes : leur fin est inconnue, et une
      // interruption ouverte pour toujours fausserait toute lecture ulterieure.
      for (const x of etat.interruptions) {
        if (x.finMs === null) { x.finMs = Math.max(entree.tMs, x.debutMs); x.closePar = "REDEMARRAGE"; }
      }
      etat.interruptions.push({ cause: "REDEMARRAGE", debutMs: Math.min(entree.dernierMs, entree.tMs), finMs: entree.tMs });
      etat.nouveauSegmentAuProchain = true;
      noter(etat, entree.tMs);
      break;
    }

    case "ALERTE":
      ajouterAlerte(etat, entree.alerte);
      break;

    case "ARRET": {
      if (etat.statut === "ARRETEE") return "SESSION_DEJA_ARRETEE";
      etat.statut = "ARRETEE";
      etat.finMs = entree.tMs;
      for (const x of etat.interruptions) {
        if (x.finMs === null) { x.finMs = Math.max(entree.tMs, x.debutMs); x.closePar = "ARRET"; }
      }
      const p = etat.pauses[etat.pauses.length - 1];
      if (p && p.finMs === null) p.finMs = entree.tMs;
      noter(etat, entree.tMs);
      break;
    }
  }
  etat.dernierSeq = entree.seq;
  return null;
}
