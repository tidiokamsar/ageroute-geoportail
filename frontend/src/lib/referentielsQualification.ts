import { api } from "./api";
import { lireReferentiels, missionsRattachables, type MissionListee, type ReferentielsQualification } from "./qualificationSegment";

/**
 * Chargement, pour l'enregistreur de releve, des vocabulaires de qualification (`GET /v2/referentiels`) et des
 * missions de l'agent (`GET /v2/missions`).
 *
 * UNE COPIE EST GARDEE SUR LE TELEPHONE : on ouvre l'enregistreur AVANT de partir, en ligne, et on roule ensuite
 * dans des zones sans reseau. Sans copie, la qualification serait impossible exactement la ou on en a besoin.
 * La copie est celle que le SERVEUR a rendue, telle quelle, avec sa date, et l'ecran la montre : ce n'est pas un
 * vocabulaire local. Si un code a ete desactive depuis, le serveur refuse les portions de l'evenement a la
 * reception, avec le motif, et la session reste sur le telephone.
 */
export interface VocabulairesChargement {
  refs: ReferentielsQualification | null;
  /** `true` : la liste affichee est la copie gardee, pas une reponse du serveur a l'instant. */
  enCache: boolean;
  /** Date ISO de la copie gardee, si c'est elle qui est affichee. */
  copieDuLe: string | null;
}

const CLE = "bdri.roulage.referentiels";

function lireCopie(): { refs: ReferentielsQualification; chargeLe: string } | null {
  try {
    const brut = localStorage.getItem(CLE);
    if (!brut) return null;
    const o = JSON.parse(brut) as { refs?: unknown; chargeLe?: unknown };
    const refs = lireReferentiels(o.refs);
    return refs && typeof o.chargeLe === "string" ? { refs, chargeLe: o.chargeLe } : null;
  } catch {
    return null;
  }
}

export async function chargerVocabulairesQualification(): Promise<VocabulairesChargement> {
  const copie = lireCopie();
  const repli: VocabulairesChargement = copie ? { refs: copie.refs, enCache: true, copieDuLe: copie.chargeLe } : { refs: null, enCache: false, copieDuLe: null };
  if (!navigator.onLine) return repli;
  try {
    const { data } = await api.get("/v2/referentiels");
    const refs = lireReferentiels(data);
    if (!refs) return repli;
    try { localStorage.setItem(CLE, JSON.stringify({ refs, chargeLe: new Date().toISOString() })); } catch { /* copie impossible : l'ecran reste utilisable en ligne */ }
    return { refs, enCache: false, copieDuLe: null };
  } catch {
    return repli;
  }
}

/** Les missions rattachables de l'agent, ou `null` si le serveur n'a pas repondu (le lien reste alors facultatif et absent). */
export async function chargerMissionsDeLAgent(userId: string): Promise<MissionListee[] | null> {
  if (!navigator.onLine) return null;
  try {
    const { data } = await api.get("/v2/missions", { params: { limite: 100 } });
    return missionsRattachables(data, userId);
  } catch {
    return null;
  }
}
