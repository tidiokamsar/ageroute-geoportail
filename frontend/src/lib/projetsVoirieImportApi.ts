import { api } from "./api";
import { deposerJeu, type DonneesDepot, type ReponseDepot } from "./projetsVoirieApi";
import {
  lireApercu, lireDeltaDetail, lireInventaire, lireIssueRetourArriere, lireIssueRevue, lireOptionsImport,
  type Apercu, type DeltaDetail, type Inventaire, type IssueRetourArriere, type IssueRevue, type OptionsImportApi,
} from "./projetsVoirieImport";

/**
 * Client de l'assistant d'import. Routes et formes : docs/projets-voirie/CONTRAT-IMPORT.md (lot A1). Prefixe : `/api/v2/projets-voirie`.
 *
 * Le serveur ne garde aucune session entre deux etapes : le fichier est RENVOYE a chaque etape (champ multipart `fichier`) avec les memes
 * options, AVANT lui dans le corps. Toute requete accepte un `AbortSignal` (annulation) et rend la progression d'envoi.
 *
 * AUCUN STOCKAGE LOCAL : le fichier reste un objet `File` en memoire de la page, il n'est ni lu par le navigateur, ni mis en cache.
 */

const BASE = "/v2/projets-voirie";
const id = encodeURIComponent;

export interface OptionsEnvoi {
  signal?: AbortSignal;
  onProgression?: (envoye: number, total: number | null) => void;
}

function corpsFichier(fichier: File, champs: Readonly<Record<string, string>>): FormData {
  const corps = new FormData();
  for (const [k, v] of Object.entries(champs)) corps.append(k, v);
  corps.append("fichier", fichier);
  return corps;
}

const progression = (o: OptionsEnvoi) => (e: { loaded: number; total?: number }) => o.onProgression?.(e.loaded, typeof e.total === "number" && e.total > 0 ? e.total : null);

/** Etape 0 : formats acceptes, limites, CRS autorises, champs cibles du mapping. Lecture seule (ADMIN, GESTIONNAIRE). */
export async function chargerOptionsImport(projetId: string, signal?: AbortSignal): Promise<OptionsImportApi> {
  const { data } = await api.get(`${BASE}/${id(projetId)}/import/options`, { signal });
  return lireOptionsImport(data);
}

/** Detection du format PAR LE CONTENU, couches, colonnes. Ne persiste rien. */
export async function inventorierFichier(projetId: string, fichier: File, champs: Readonly<Record<string, string>>, o: OptionsEnvoi = {}): Promise<Inventaire> {
  const { data } = await api.post(`${BASE}/${id(projetId)}/import/inventaire`, corpsFichier(fichier, champs), { signal: o.signal, onUploadProgress: progression(o) });
  return lireInventaire(data);
}

/** Apercu borne : CRS, statistiques, validation geometrique, echantillon, mapping. Ne persiste rien. */
export async function apercevoirFichier(projetId: string, fichier: File, champs: Readonly<Record<string, string>>, o: OptionsEnvoi = {}): Promise<Apercu> {
  const { data } = await api.post(`${BASE}/${id(projetId)}/import/apercu`, corpsFichier(fichier, champs), { signal: o.signal, onUploadProgress: progression(o) });
  return lireApercu(data);
}

/** Simulation (`simuler: true`, transaction annulee) ou depot reel (jeu CONTROLE). `sha256Attendu` vient de l'apercu : garde contre un fichier modifie. */
export function deposerAvecOptions(projetId: string, d: DonneesDepot, opts: { simuler: boolean } & OptionsEnvoi): Promise<ReponseDepot> {
  return deposerJeu(projetId, d, { simuler: opts.simuler, onProgression: opts.onProgression, signal: opts.signal });
}

export async function lireDeltaJeu(projetId: string, jeuId: string, signal?: AbortSignal): Promise<DeltaDetail> {
  const { data } = await api.get(`${BASE}/${id(projetId)}/jeux/${id(jeuId)}/delta`, { signal });
  return lireDeltaDetail(data);
}

/** Revue des suppressions : decision ACCEPTER ou REFUSER, justification de 10 caracteres au moins. Auditee, jamais appliquee d'office. */
export async function revoirSuppressions(projetId: string, jeuId: string, decision: "ACCEPTER" | "REFUSER", justification: string): Promise<IssueRevue> {
  const { data } = await api.post(`${BASE}/${id(projetId)}/jeux/${id(jeuId)}/revue-suppressions`, { decision, justification });
  return lireIssueRevue(data);
}

/** Retour arriere : `jeuId` est le jeu actuellement AUTORISE ; la version qu'il avait remplacee redevient autorisee. Sans perte. */
export async function revenirEnArriere(projetId: string, jeuId: string, justification: string): Promise<IssueRetourArriere> {
  const { data } = await api.post(`${BASE}/${id(projetId)}/jeux/${id(jeuId)}/retour-arriere`, { justification });
  return lireIssueRetourArriere(data);
}
