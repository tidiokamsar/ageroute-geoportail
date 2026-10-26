import { api } from "./api";

/**
 * Client de l'API Observation de la Terre (prefixe /api/v2/teledetection).
 *
 * Les types suivent a la lettre docs/observation-terre/CONTRAT-API-UI.md, paragraphes 5 et 6. Ce
 * module ne fabrique AUCUNE valeur : une reponse absente est une erreur typee (`ErreurTd`), jamais
 * un tableau vide ni un zero. Le serveur decide du role, du module et du perimetre territorial ;
 * l'interface ne fait que masquer ce qu'elle sait refuse d'avance.
 */

// ---------------------------------------------------------------- types du contrat

export type StatutProposition = "A_VERIFIER" | "EN_ATTENTE" | "NON_CONCLUANTE" | "CONFIRMEE" | "INFIRMEE";
export type NiveauPriorite = "HAUTE" | "MOYENNE" | "FAIBLE";
export type ConfianceRattachement = "HAUTE" | "MOYENNE" | "FAIBLE" | "AUCUN";
export type EtatSource =
  | "NON_CONFIGUREE" | "CONFIGUREE" | "AUTHENTIFIEE" | "ACCESSIBLE" | "PRODUIT_DISPONIBLE"
  | "TRAITEMENT_OPERATIONNEL" | "EN_ERREUR" | "EN_ATTENTE_CONFIGURATION";

export interface Synthese {
  periode: { depuis: string | null; jusqua: string | null };
  propositions: { aVerifier: number; enAttente: number; nonConcluantes: number; confirmees: number; infirmees: number; prioritaires: number };
  tauxConfirmation: {
    confirmees: number; infirmees: number; jugees: number; valeur: number | null;
    echantillonSuffisant: boolean; seuil: number; definition: string;
  };
  sources: { total: number; parEtat: Record<string, number>; actives: number };
  derniereAcquisition: { produitId: string; source: string; date: string; resolutionM: number | null } | null;
  fraicheur: { dateCalcul: string; ageDerniereAcquisitionJours: number | null };
}

export interface Proposition {
  id: string;
  type: string;
  statut: StatutProposition;
  priorite: { niveau: NiveauPriorite | null; regle: string };
  confianceDetection: { valeur: number | null; calibree: boolean; signification: string };
  qualiteImage: { couvertureNuagesPct: number | null; note: string | null };
  rattachement: { confiance: ConfianceRattachement; distanceM: number | null; algorithme: string };
  methode: { nom: string; version: string };
  source: {
    code: string; nom: string; capteur: string | null; resolutionM: number | null;
    /** D'ou vient la resolution affichee : NATIVE_PRODUIT = native du produit ; PRODUIT_LIVRE = repli (resolution du produit livre) ; absent ou null = non dit. */
    resolutionOrigine?: "NATIVE_PRODUIT" | "PRODUIT_LIVRE" | null;
    /** D'ou vient le capteur affiche : PRODUIT, ou SOURCE = repli sur la ligne de source. */
    capteurOrigine?: "PRODUIT" | "SOURCE" | null;
  };
  dateObservation: string;
  dateReference: string | null;
  troncon: { id: string; code: string; nom: string; regionId: number | null; regionNom: string | null } | null;
  rattachee: boolean;
  centre: { lat: number; lon: number } | null;
  apercuDisponible: boolean;
  synthetique: boolean;
  missionId: string | null;
}

export interface ApercuImage { url: string | null; date: string | null }

export interface HistoriqueTransition {
  de: string | null;
  vers: string;
  auteur: { id: string; nom: string } | null;
  date: string;
  motif: string | null;
  commentaire: string | null;
}

export interface ObservationTerrain { id: string; date: string; auteur: string | null; resume: string | null }

export interface PropositionDetail extends Proposition {
  /** Le contrat ne decrit pas la forme des references de produit : l'ecran ne s'en sert pas. */
  produitApres: unknown;
  produitAvant: unknown;
  /** null = non renseignees (ligne d'avant la migration) : ce n'est pas « aucune limite » ; voir limitesNonRenseignees. */
  limites: string[] | null;
  limitesNonRenseignees?: boolean;
  provenance: {
    fournisseur: string | null; identifiantFournisseur: string | null; licence: string | null;
    attribution: string | null; versionTraitement: string | null; empreinteSha256: string | null;
  };
  geometrie: GeoJSON.Geometry | null;
  historique: HistoriqueTransition[];
  mission: { id: string; statut: string; assigneNom: string | null } | null;
  /** `observationsMasquees` : observations du dossier hors du perimetre du lecteur, comptees et jamais omises en silence. */
  terrain: { observations: ObservationTerrain[]; observationsMasquees?: number };
  apercus: { avant: ApercuImage; apres: ApercuImage };
}

export interface PagePropositions { items: Proposition[]; suivant: string | null; total: number }

export interface SourceObservation {
  code: string;
  nom: string;
  fournisseur: string | null;
  capteur: string | null;
  resolutionM: number | null;
  etat: EtatSource | string;
  derniereVerification: string | null;
  derniereAcquisition: string | null;
  message: string | null;
  requiertIdentifiants: boolean;
}

// Longueur maximale de la reference d'un constat : celle du serveur (`teledetection.schemas.ts`, `constatRef`), definie dans le noyau d'affichage.
export { CONSTAT_REF_MAX } from "./teledetectionAffichage";

export interface CorpsTransition {
  vers: StatutProposition;
  motif: string;
  commentaire?: string;
  motifAttente?: "INFO_DEMANDEE" | "AUTRE";
  observationIds?: string[];
  /** Reference libre du constat de terrain : un verdict cite une observation OU une reference (le serveur refuse sinon, CONSTAT_REQUIS). */
  constatRef?: string;
}

/** Une ligne de `GET /qualite-methodes` : verdicts d'un type de changement et d'une methode, avec leur effectif. */
export interface LigneQualiteMethode {
  type: string;
  methode: string;
  methodeNom: string;
  methodeVersion: string | null;
  total: number;
  aVerifier: number;
  enAttente: number;
  nonConcluantes: number;
  confirmees: number;
  infirmees: number;
  jugees: number;
  /** Nul a zero verdict : jamais 0 %. */
  tauxConfirmation: number | null;
  echantillonSuffisant: boolean;
  seuilEchantillon: number;
}

export interface QualiteMethodes { seuilEchantillon: number; definition: string; lignes: LigneQualiteMethode[] }

// ---------------------------------------------------------------- erreurs

export type GenreErreur =
  | "permission"   // 403 : role ou perimetre
  | "session"      // 401
  | "introuvable"  // 404 (inexistant ou hors perimetre : meme reponse)
  | "conflit"      // 409 : transition interdite, verdict definitif
  | "entree"       // 400
  | "limite"       // 429
  | "indisponible" // 503 : source indisponible
  | "reseau"       // pas de reponse
  | "serveur";

export interface ErreurTd { genre: GenreErreur; status: number | null; code: string | null; message: string }

const MESSAGES_PAR_GENRE: Record<GenreErreur, string> = {
  permission: "Vous n'avez pas le droit d'accéder à cette ressource ou de faire cette action.",
  session: "Votre session a expiré. Reconnectez-vous.",
  introuvable: "Ressource introuvable ou hors de votre périmètre.",
  conflit: "Cette action n'est plus possible dans l'état actuel de la proposition.",
  entree: "La demande est invalide.",
  limite: "Trop de demandes. Réessayez dans un instant.",
  indisponible: "La source d'observation est indisponible.",
  reseau: "Le serveur ne répond pas. Vérifiez votre connexion.",
  serveur: "Erreur du serveur.",
};

/** Classe une erreur axios en genre stable. Le message du serveur prime quand il existe. */
export function classerErreur(e: unknown): ErreurTd {
  const r = (e as { response?: { status?: number; data?: { error?: unknown; code?: unknown } } } | null | undefined)?.response;
  const status = typeof r?.status === "number" ? r.status : null;
  const code = typeof r?.data?.code === "string" ? r.data.code : null;
  const msgServeur = typeof r?.data?.error === "string" && r.data.error.trim() ? r.data.error : null;
  let genre: GenreErreur;
  if (status === null) genre = "reseau";
  else if (status === 401) genre = "session";
  else if (status === 403) genre = "permission";
  else if (status === 404) genre = "introuvable";
  else if (status === 409) genre = "conflit";
  else if (status === 429) genre = "limite";
  else if (status === 503) genre = "indisponible";
  else if (status >= 400 && status < 500) genre = "entree";
  else genre = "serveur";
  return { genre, status, code, message: msgServeur ?? MESSAGES_PAR_GENRE[genre] };
}

/** Une erreur d'autorisation ne se retente pas : la rejouer ne change rien et masque le refus. */
export function estErreurAutorisation(e: unknown): boolean {
  const g = classerErreur(e).genre;
  return g === "permission" || g === "session";
}

// ---------------------------------------------------------------- parametres

export interface FiltresSynthese { regionId?: string; depuis?: string; jusqua?: string }

export interface FiltresPropositions extends FiltresSynthese {
  statut?: StatutProposition;
  type?: string;
  source?: string;
  tronconId?: string;
  priorite?: string;
  /** "oui" | "non" | "" (indifferent) : traduit en booleen pour le serveur. */
  rattachee?: string;
  q?: string;
}

function nettoyer(p: Record<string, string | number | undefined | null>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    out[k] = typeof v === "string" ? v.trim() : v;
  }
  return out;
}

export function paramsSynthese(f: FiltresSynthese) {
  return nettoyer({ regionId: f.regionId, depuis: f.depuis, jusqua: f.jusqua });
}

export function paramsPropositions(f: FiltresPropositions, curseur?: string | null, limite = 25) {
  return nettoyer({
    statut: f.statut, type: f.type, source: f.source, regionId: f.regionId, tronconId: f.tronconId,
    priorite: f.priorite, rattachee: f.rattachee === "oui" ? "true" : f.rattachee === "non" ? "false" : undefined,
    depuis: f.depuis, jusqua: f.jusqua, q: f.q, curseur: curseur ?? undefined, limite,
  });
}

// ---------------------------------------------------------------- appels

const BASE = "/v2/teledetection";

export async function lireSynthese(f: FiltresSynthese): Promise<Synthese> {
  return (await api.get<Synthese>(`${BASE}/synthese`, { params: paramsSynthese(f) })).data;
}

export async function lirePropositions(f: FiltresPropositions, curseur: string | null): Promise<PagePropositions> {
  return (await api.get<PagePropositions>(`${BASE}/propositions`, { params: paramsPropositions(f, curseur) })).data;
}

export type Emprise = [number, number, number, number];

export async function lirePropositionsGeo(
  bbox: Emprise, f: { statut?: string; type?: string; priorite?: string },
): Promise<GeoJSON.FeatureCollection> {
  const params = nettoyer({ bbox: bbox.join(","), statut: f.statut, type: f.type, priorite: f.priorite });
  return (await api.get<GeoJSON.FeatureCollection>(`${BASE}/propositions.geojson`, { params })).data;
}

export async function lireProposition(id: string): Promise<PropositionDetail> {
  return (await api.get<PropositionDetail>(`${BASE}/propositions/${encodeURIComponent(id)}`)).data;
}

export async function lireSources(): Promise<SourceObservation[]> {
  return (await api.get<SourceObservation[]>(`${BASE}/sources`)).data;
}

export async function poserTransition(id: string, corps: CorpsTransition): Promise<unknown> {
  return (await api.post(`${BASE}/propositions/${encodeURIComponent(id)}/transition`, corps)).data;
}

/** Cree la mission de verification (existant, conserve par le contrat). Le corps reste vide. */
export async function affecterAUneInspection(id: string): Promise<{ code?: string } & Record<string, unknown>> {
  return (await api.post(`${BASE}/propositions/${encodeURIComponent(id)}/verification`, {})).data;
}

export async function verifierSource(code: string): Promise<unknown> {
  return (await api.post(`${BASE}/sources/${encodeURIComponent(code)}/verifier`, {})).data;
}

/**
 * Les apercus sont servis par le serveur derriere l'authentification : une balise <img> ne porte
 * pas l'en-tete Authorization. On les recupere donc en blob par le client authentifie.
 *
 * SEULS les chemins RELATIFS de la meme origine sont acceptes (`/api/v2/...` ou `/v2/...`) : le client authentifie
 * ajoute le jeton Bearer a CHAQUE requete, et une URL absolue (`https://autre.example/...`, `//autre.example/...`,
 * un chemin qui remonte avec `..`) l'enverrait a un tiers. Toute autre forme est refusee ici, avant tout appel reseau.
 */
export function cheminApercuSur(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const u = url.trim();
  // Un seul « / » initial : « // » (URL sans schema) et « \ » (le navigateur le lit comme « // ») designent un autre hote.
  if (!u.startsWith("/") || u.startsWith("//") || u.includes("\\")) return null;
  if ([...u].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return null;
  let decode: string;
  try { decode = decodeURIComponent(u); } catch { return null; }
  if (decode.split(/[/?#]/).some((m) => m === "..")) return null;
  if (decode.startsWith("//") || decode.includes("\\")) return null;
  const chemin = u.startsWith("/api/") ? u.slice(4) : u;
  // Apres retrait du prefixe, « /api//hote/x » devient « //hote/x » : axios le tiendrait pour une URL absolue.
  return chemin.startsWith("//") || /^\/[a-z][a-z\d+\-.]*:/i.test(chemin) ? null : chemin;
}

export async function lireApercu(url: string): Promise<Blob> {
  const chemin = cheminApercuSur(url);
  if (chemin === null) throw new Error("Aperçu refusé : seule une adresse relative du serveur est admise.");
  return (await api.get<Blob>(chemin, { responseType: "blob" })).data;
}

/** Verdicts par type et methode (compte NATIONAL seulement : 403 HORS_PERIMETRE pour un compte regional). */
export async function lireQualiteMethodes(): Promise<QualiteMethodes> {
  return (await api.get<QualiteMethodes>(`${BASE}/qualite-methodes`)).data;
}
