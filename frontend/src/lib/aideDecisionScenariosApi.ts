import { api } from "./api";
import {
  estCandidats, estComparaison, estDetail, estEnregistrement, estListe, estOptions, estRapportRejeu, estResultatCalcul, exportPorteLaMention,
  type Comparaison, type DemandeSimulateur, type DetailScenario, type ListeScenarios, type OptionsSimulateur, type ReponseCandidats, type ReponseEnregistrement,
  type ResultatCalcul, type CodeLogique,
} from "./aideDecisionScenarios";
import type { RapportRejeu } from "./moteurProgrammation";

/**
 * Appels du simulateur budgetaire (`/api/v2/aide-decision/scenarios`). Aucune logique metier ici : des appels types, une verification
 * minimale de la FORME de chaque reponse (une reponse mal formee leve `ReponseInvalide`, que l'ecran rend en etat d'erreur propre),
 * et un controle a la reception de l'export. Les erreurs HTTP remontent telles quelles (l'ecran distingue 403 d'une panne).
 */

const BASE = "/v2/aide-decision/scenarios";

export class ReponseInvalide extends Error {
  constructor(partie: string) { super(`La réponse du serveur (${partie}) est mal formée : elle n'est pas affichée.`); }
}

function verifier<T>(brut: unknown, garde: (v: unknown) => v is T, partie: string): T {
  if (!garde(brut)) throw new ReponseInvalide(partie);
  return brut;
}

export async function chargerOptions(periode?: { debut: string; fin: string }): Promise<OptionsSimulateur> {
  const r = await api.get<unknown>(`${BASE}/options`, { params: periode ? { debut: periode.debut, fin: periode.fin } : undefined });
  return verifier(r.data, estOptions, "options du simulateur");
}

export async function chargerCandidats(p: { regionId?: number; classe?: string }): Promise<ReponseCandidats> {
  const r = await api.get<unknown>(`${BASE}/candidats`, { params: { ...(p.regionId ? { regionId: p.regionId } : {}), ...(p.classe ? { classe: p.classe } : {}) } });
  return verifier(r.data, estCandidats, "interventions candidates");
}

export async function simuler(d: DemandeSimulateur): Promise<ResultatCalcul> {
  return verifier((await api.post<unknown>(`${BASE}/simuler`, d)).data, estResultatCalcul, "résultat de la simulation");
}

export async function enregistrerScenario(d: DemandeSimulateur, intitule: string): Promise<ReponseEnregistrement> {
  return verifier((await api.post<unknown>(BASE, { ...d, intitule })).data, estEnregistrement, "scénario enregistré");
}

export interface FiltresListe { q?: string; logique?: CodeLogique | ""; annee?: number; page?: number; pageSize?: number }

export async function listerScenarios(f: FiltresListe): Promise<ListeScenarios> {
  const params = { ...(f.q ? { q: f.q } : {}), ...(f.logique ? { logique: f.logique } : {}), ...(f.annee ? { annee: f.annee } : {}), page: f.page ?? 1, pageSize: f.pageSize ?? 20 };
  return verifier((await api.get<unknown>(BASE, { params })).data, estListe, "liste des scénarios");
}

export async function lireScenario(id: string): Promise<DetailScenario> {
  return verifier((await api.get<unknown>(`${BASE}/${id}`)).data, estDetail, "détail du scénario");
}

export async function rejouerScenario(id: string): Promise<RapportRejeu> {
  return verifier((await api.post<unknown>(`${BASE}/${id}/rejouer`)).data, estRapportRejeu, "rapport de rejeu");
}

export async function supprimerScenario(id: string): Promise<{ ok: true; id: string }> {
  return (await api.post<{ ok: true; id: string }>(`${BASE}/${id}/supprimer`)).data;
}

export async function comparerScenarios(ids: string[]): Promise<Comparaison> {
  return verifier((await api.post<unknown>(`${BASE}/comparer`, { ids })).data, estComparaison, "comparaison");
}

/** Texte d'un blob ; `Blob.text()` n'existe pas partout (jsdom), `FileReader` si. */
function lireTexte(b: Blob): Promise<string> {
  if (typeof b.text === "function") return b.text();
  return new Promise((resolve, reject) => {
    const lecteur = new FileReader();
    lecteur.onload = () => resolve(String(lecteur.result ?? ""));
    lecteur.onerror = () => reject(lecteur.error ?? new Error("lecture de l'export impossible"));
    lecteur.readAsText(b);
  });
}

export class ExportSansMention extends Error {
  constructor() { super("L'export reçu ne porte pas la mention « simulation non engageante » : il n'est pas remis."); }
}

const MESSAGE_PAR_STATUT: Record<number, string> = {
  401: "Votre session a expiré : reconnectez-vous.",
  403: "Accès refusé : l'export exige le module Rapports et un rôle administrateur ou gestionnaire.",
  404: "Scénario introuvable ou supprimé.",
  422: "L'export de ce scénario est refusé.",
};

/**
 * Avec `responseType: "blob"`, le corps d'une erreur JSON arrive en Blob : `data.error` est alors illisible et l'utilisateur ne verrait
 * que « Request failed with status code 4xx ». On relit le blob, et on remonte une erreur au format habituel (`response.data.error`),
 * avec la phrase du serveur, ou a defaut une phrase en francais selon le statut.
 */
export async function normaliserErreurBlob(e: unknown): Promise<unknown> {
  const reponse = (e as { response?: { status?: number; data?: unknown } } | null)?.response;
  if (!reponse) return e;
  let message: string | undefined;
  if (typeof Blob !== "undefined" && reponse.data instanceof Blob) {
    try {
      const corps = JSON.parse(await lireTexte(reponse.data)) as { error?: unknown };
      if (typeof corps.error === "string" && corps.error !== "") message = corps.error;
    } catch { /* corps non JSON : on retombe sur la phrase par statut */ }
  } else if (typeof (reponse.data as { error?: unknown } | undefined)?.error === "string") {
    return e;
  }
  const phrase = message ?? (reponse.status !== undefined ? MESSAGE_PAR_STATUT[reponse.status] : undefined) ?? "L'export a échoué : réessayez dans un instant.";
  return Object.assign(new Error(phrase), { response: { status: reponse.status, data: { error: phrase } } });
}

/**
 * Telecharge un export (avec le jeton de session : un lien direct n'enverrait pas l'en-tete d'authentification) et refuse
 * de le remettre s'il ne porte pas la mention « simulation non engageante ».
 */
export async function telechargerExport(id: string, format: "csv" | "json"): Promise<{ blob: Blob; nom: string }> {
  let r;
  try {
    r = await api.get<Blob>(`${BASE}/${id}/export`, { params: { format }, responseType: "blob" });
  } catch (e) {
    throw await normaliserErreurBlob(e);
  }
  const texte = await lireTexte(r.data);
  if (!exportPorteLaMention(texte)) throw new ExportSansMention();
  const dispo = String(r.headers?.["content-disposition"] ?? "");
  const nom = /filename="([^"]+)"/.exec(dispo)?.[1] ?? `simulation-${id.slice(0, 8)}.${format}`;
  return { blob: r.data, nom };
}

/** Remet un fichier a l'utilisateur (lien temporaire, libere aussitot). */
export function remettreFichier(blob: Blob, nom: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nom;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
