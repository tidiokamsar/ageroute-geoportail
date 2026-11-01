/**
 * Contrat de synchronisation d'une session de roulage avec le serveur.
 *
 * UNE SESSION = UNE OPERATION du protocole existant (`POST /api/v2/sync/push`, section 15) :
 *
 *     { operationId: <sessionId>, entityType: "SessionRoulage", entityId: <sessionId>,
 *       operation: "CREATE", baseVersion: null, payload: <PayloadSessionRoulage> }
 *
 * Meme convention que les defauts et les portions : l'identifiant est genere par l'APPAREIL avant
 * tout envoi, et sert de cle d'idempotence. Une reponse perdue en zone blanche fait renvoyer la
 * session ; le serveur rend l'enregistrement deja fait (statut REJOUEE) sans rien reecrire.
 *
 * Le schema serveur est `backend/src/roulage/contrat.ts` (zod). Les deux sont tenus d'accord par un
 * banc d'integration qui fait passer la charge produite ICI par la validation LA-BAS.
 *
 * Aucun calcul d'IRI n'est transporte : le serveur refuse une charge qui en porterait un.
 */
import type { EtatSession } from "./etat";
import { PROVENANCE_PARAMETRES, type ParametresRoulage } from "./parametres";
import type { Interruption, MotifRejet, Qualification, Trou } from "./types";

export const VERSION_CONTRAT = 1;
export const TYPE_ENTITE = "SessionRoulage";

/** [tMs, lat, lon, precisionM, vitesseMs, segment] : une forme compacte, 7 200 points tiennent dans environ 400 Ko. */
export type PointPayload = [number, number, number, number | null, number | null, number];

export interface ReperePayload {
  tMs: number;
  lat: number | null;
  lon: number | null;
  precisionM: number | null;
  ageFixMs: number | null;
  positionPerimee: boolean;
}

export interface MarqueurPayload {
  id: string;
  code: string;
  note: string | null;
  repere: ReperePayload;
  latenceLogicielleMs: number;
}

export interface EvenementPayload {
  id: string;
  code: string;
  note: string | null;
  statut: "CLOS" | "CLOS_PAR_ARRET" | "ABANDONNE";
  qualification: Qualification | null;
  debut: ReperePayload;
  fin: ReperePayload | null;
  couvertureGnss: number | null;
  distanceDirecteM: number | null;
  avertissements: string[];
  motifAbandon: string | null;
}

export interface PayloadSessionRoulage {
  versionContrat: typeof VERSION_CONTRAT;
  sessionId: string;
  missionId: string | null;
  debutMs: number;
  finMs: number;
  provenanceParametres: typeof PROVENANCE_PARAMETRES;
  parametres: ParametresRoulage;
  points: PointPayload[];
  marqueurs: MarqueurPayload[];
  evenements: EvenementPayload[];
  trous: Trou[];
  interruptions: Interruption[];
  pauses: { debutMs: number; finMs: number | null }[];
  compteurs: { rejets: Record<MotifRejet, number>; sansPrecision: number; alertes: number };
}

export type RefusPayload = "SESSION_NON_ARRETEE" | "TROP_PEU_DE_POINTS" | "EVENEMENT_ENCORE_OUVERT";

const arrondi = (v: number, decimales: number) => {
  const f = 10 ** decimales;
  return Math.round(v * f) / f;
};
const arrondiNul = (v: number | null, d: number) => (v === null ? null : arrondi(v, d));

function repere(r: EtatSession["evenements"][number]["debut"]): ReperePayload {
  return {
    tMs: r.tMs,
    lat: arrondiNul(r.lat, 7),
    lon: arrondiNul(r.lon, 7),
    precisionM: arrondiNul(r.precisionM, 1),
    ageFixMs: r.ageFixMs,
    positionPerimee: r.positionPerimee,
  };
}

/** Construit la charge a envoyer. Refuse tant que la session n'est pas arretee : une trace en cours n'est pas finie. */
export function construirePayload(
  etat: Readonly<EtatSession>,
  options: { missionId?: string | null } = {},
): { ok: true; payload: PayloadSessionRoulage } | { ok: false; refus: RefusPayload } {
  if (etat.statut !== "ARRETEE" || etat.finMs === null) return { ok: false, refus: "SESSION_NON_ARRETEE" };
  if (etat.echantillons.length < 2) return { ok: false, refus: "TROP_PEU_DE_POINTS" };
  if (etat.evenements.some((e) => e.statut === "OUVERT")) return { ok: false, refus: "EVENEMENT_ENCORE_OUVERT" };

  const points: PointPayload[] = etat.echantillons.map((s) => [
    Math.round(s.tMs), arrondi(s.lat, 7), arrondi(s.lon, 7), arrondiNul(s.precisionM, 1), arrondiNul(s.vitesseMs, 2), s.segment,
  ]);
  return {
    ok: true,
    payload: {
      versionContrat: VERSION_CONTRAT,
      sessionId: etat.sessionId,
      missionId: options.missionId ?? null,
      debutMs: etat.debutMs,
      finMs: etat.finMs,
      provenanceParametres: PROVENANCE_PARAMETRES,
      parametres: etat.parametres,
      points,
      marqueurs: etat.marqueurs.map((m) => ({
        id: m.id, code: m.code, note: m.note, repere: repere(m.repere), latenceLogicielleMs: arrondi(m.latenceLogicielleMs, 2),
      })),
      evenements: etat.evenements.map((e) => ({
        id: e.id, code: e.code, note: e.note,
        statut: e.statut as EvenementPayload["statut"],
        qualification: e.qualification,
        debut: repere(e.debut),
        fin: e.fin ? repere(e.fin) : null,
        couvertureGnss: arrondiNul(e.couvertureGnss, 3),
        distanceDirecteM: e.distanceDirecteM,
        avertissements: e.avertissements,
        motifAbandon: e.motifAbandon,
      })),
      trous: etat.trous.map((t) => ({ ...t })),
      interruptions: etat.interruptions.map((i) => ({ ...i })),
      pauses: etat.pauses.map((p) => ({ ...p })),
      compteurs: { rejets: { ...etat.rejets }, sansPrecision: etat.sansPrecision, alertes: etat.alertesTotal },
    },
  };
}

export interface OperationSync {
  operationId: string;
  entityType: typeof TYPE_ENTITE;
  entityId: string;
  operation: "CREATE";
  baseVersion: null;
  payload: PayloadSessionRoulage;
}

export function operationPourSynchronisation(payload: PayloadSessionRoulage): OperationSync {
  return {
    operationId: payload.sessionId,
    entityType: TYPE_ENTITE,
    entityId: payload.sessionId,
    operation: "CREATE",
    baseVersion: null,
    payload,
  };
}

/** Ce que la file locale doit faire d'une reponse du serveur a `POST /v2/sync/push` pour cette operation. */
export type SuiteReponse =
  | { action: "RETIRER_DE_LA_FILE"; rejeu: boolean }
  | { action: "ABANDONNER"; motif: string }
  | { action: "REESSAYER"; apresMs: number | null; motif: string };

export interface ResultatPush {
  statut?: string;
  entityId?: string;
  motif?: string;
  reessayerDansMs?: number;
}

/**
 * Meme regle que `syncOnePortion` : le SERVEUR sait si un refus est definitif. Un REJETE sans
 * `reessayerDansMs` est definitif (la session est conservee localement, marquee abandonnee, et reste
 * visible) ; avec `reessayerDansMs`, on reessaie ; tout autre cas (reponse absente, CONFLIT) se reessaie.
 */
export function interpreterReponse(r: ResultatPush | undefined): SuiteReponse {
  if (!r) return { action: "REESSAYER", apresMs: null, motif: "REPONSE_ABSENTE" };
  if (r.statut === "SYNCHRONISE") return { action: "RETIRER_DE_LA_FILE", rejeu: false };
  if (r.statut === "REJOUEE") return { action: "RETIRER_DE_LA_FILE", rejeu: true };
  if (r.statut === "REJETE") {
    if (typeof r.reessayerDansMs === "number" && r.reessayerDansMs > 0) {
      return { action: "REESSAYER", apresMs: r.reessayerDansMs, motif: r.motif ?? "REJET_TEMPORAIRE" };
    }
    return { action: "ABANDONNER", motif: r.motif ?? "REJET_SANS_MOTIF" };
  }
  return { action: "REESSAYER", apresMs: null, motif: r.motif ?? `STATUT_${r.statut ?? "INCONNU"}` };
}
