import { api } from "./api";
import type { FiltresDecision } from "../components/decision/types";
import { paramsApi } from "./decision";
import { ReponseInattendue, classerErreurDecision, type ErreurDecision } from "./aideDecisionApi";
import { nomFichierExport, type CorpsExport } from "./aideDecisionRapports";

/**
 * Appels du lot 6 (docs/aide-decision/CONTRAT-AD.md paragraphe 4) : export gouverne, journal, rapport par region, historique
 * des baremes. Le serveur est la source ; une reponse mal formee est « reponse inattendue », jamais un vide ni un zero.
 *
 * TELECHARGEMENT AUTHENTIFIE : le fichier est la reponse du POST (blob), reçue avec le jeton Bearer de l'instance axios.
 * Aucune cle, aucun jeton dans l'URL, aucun lien `<a href>` vers l'API (qui echouerait en 401 sans le jeton).
 */

const BASE = "/v2/aide-decision";

const estObjet = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const texte = (v: unknown): string | null => (typeof v === "string" ? v : null);
const nombre = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// ---------------------------------------------------------------------------------------------- export

export interface FichierExporte {
  blob: Blob;
  nomFichier: string;
  exportId: string | null;
  empreinteSha256: string | null;
  nbLignes: number | null;
}

/**
 * Erreur d'un POST `responseType: "blob"` : le corps JSON `{ error, code }` du serveur arrive en Blob. On le relit pour que
 * « acces refuse », « 413 trop volumineux » ou « scenario introuvable » s'affichent avec le MOT du serveur.
 */
function lireTexte(b: Blob): Promise<string> {
  if (typeof b.text === "function") return b.text();
  // Anciens moteurs (et jsdom) : pas de Blob.text().
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(r.error);
    r.readAsText(b);
  });
}

export async function erreurExport(e: unknown): Promise<ErreurDecision & { code: string | null }> {
  const brut = (e as { response?: { data?: unknown } } | null)?.response?.data;
  let corps: unknown = brut;
  if (typeof Blob !== "undefined" && brut instanceof Blob) {
    try { corps = JSON.parse(await lireTexte(brut)); } catch { corps = null; }
  }
  const base = classerErreurDecision(estObjet(corps) ? { ...(e as object), response: { ...((e as { response?: object }).response ?? {}), data: corps } } : e);
  return { ...base, code: estObjet(corps) ? texte(corps.code) : null };
}

export async function exporterRapport(corps: CorpsExport): Promise<FichierExporte> {
  const r = await api.post<Blob>(`${BASE}/exports`, corps, { responseType: "blob" });
  const h = (r.headers ?? {}) as Record<string, string | undefined>;
  return {
    blob: r.data,
    nomFichier: nomFichierExport(h["content-disposition"], `aide-decision-${corps.type}.${corps.format}`),
    exportId: h["x-export-id"] ?? null,
    empreinteSha256: h["x-export-empreinte-sha256"] ?? null,
    nbLignes: h["x-export-nb-lignes"] !== undefined && Number.isFinite(Number(h["x-export-nb-lignes"])) ? Number(h["x-export-nb-lignes"]) : null,
  };
}

/** Remet le blob a l'utilisateur (meme mecanique que `lib/download.ts`, sans second appel reseau). */
export function remettreFichier(f: FichierExporte): void {
  const url = URL.createObjectURL(f.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = f.nomFichier;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------------------------- journal

export interface EntreeJournal {
  id: string;
  type: string;
  format: string;
  auteurEmail: string;
  auteurRole: string;
  filtres: Record<string, unknown>;
  perimetreLibelle: string | null;
  nbLignes: number | null;
  tailleOctets: number | null;
  empreinteSha256: string | null;
  droitFinancier: boolean | null;
  colonnesRetirees: string[];
  creeLe: string;
}
export interface JournalLu { total: number; entrees: EntreeJournal[] }

export function analyserJournal(brut: unknown): JournalLu | null {
  if (!estObjet(brut) || !Array.isArray(brut.data)) return null;
  const entrees: EntreeJournal[] = [];
  for (const e of brut.data) {
    if (!estObjet(e) || texte(e.id) === null || texte(e.type) === null || texte(e.creeLe) === null) return null;
    const auteur = estObjet(e.auteur) ? e.auteur : {};
    const perimetre = estObjet(e.perimetre) ? e.perimetre : {};
    entrees.push({
      id: e.id as string, type: e.type as string, format: texte(e.format) ?? "",
      auteurEmail: texte(auteur.email) ?? "compte inconnu", auteurRole: texte(auteur.role) ?? "",
      filtres: estObjet(e.filtres) ? e.filtres : {}, perimetreLibelle: texte(perimetre.libelle),
      nbLignes: nombre(e.nbLignes), tailleOctets: nombre(e.tailleOctets), empreinteSha256: texte(e.empreinteSha256),
      droitFinancier: typeof e.droitFinancier === "boolean" ? e.droitFinancier : null,
      colonnesRetirees: Array.isArray(e.colonnesRetirees) ? e.colonnesRetirees.filter((x): x is string => typeof x === "string") : [],
      creeLe: e.creeLe as string,
    });
  }
  return { total: nombre(brut.total) ?? entrees.length, entrees };
}

export async function lireJournalExports(limite = 20): Promise<JournalLu> {
  const r = await api.get<unknown>(`${BASE}/exports`, { params: { limite } });
  const lu = analyserJournal(r.data);
  if (!lu) throw new ReponseInattendue("le journal des exports");
  return lu;
}

// ---------------------------------------------------------------------------------------------- rapport par region

export interface LigneRegionLue {
  region: string;
  troncons: number | null;
  /** Troncons comptes mais sans longueur metier : leur longueur est INCONNUE (jamais 0 km). */
  tronconsSansLongueurMetier: number | null;
  kmPerimetre: number | null;
  kmBon: number | null; kmMoyen: number | null; kmMauvais: number | null; kmCritique: number | null;
  kmEtatNonValide: number | null; kmNonEvalue: number | null;
  kmEligible: number | null; degradePct: number | null; critiquePct: number | null;
  disponibilite: string;
}
export interface RapportRegionsLu {
  perimetreLibelle: string;
  regions: LigneRegionLue[];
  total: LigneRegionLue | null;
  avertissements: string[];
  filtresNonAppliques: { filtre: string; raison: string }[];
}

function ligneRegion(v: unknown): LigneRegionLue | null {
  if (!estObjet(v) || texte(v.region) === null) return null;
  return {
    region: v.region as string, troncons: nombre(v.troncons), tronconsSansLongueurMetier: nombre(v.tronconsSansLongueurMetier), kmPerimetre: nombre(v.kmPerimetre),
    kmBon: nombre(v.kmBon), kmMoyen: nombre(v.kmMoyen), kmMauvais: nombre(v.kmMauvais), kmCritique: nombre(v.kmCritique),
    kmEtatNonValide: nombre(v.kmEtatNonValide), kmNonEvalue: nombre(v.kmNonEvalue), kmEligible: nombre(v.kmEligible),
    // null reste null : un taux non calculable n'est JAMAIS rendu comme 0.
    degradePct: nombre(v.degradePct), critiquePct: nombre(v.critiquePct), disponibilite: texte(v.disponibilite) ?? "NON_DISPONIBLE",
  };
}

export function analyserRapportRegions(brut: unknown): RapportRegionsLu | null {
  if (!estObjet(brut) || !estObjet(brut.rapport) || !Array.isArray(brut.rapport.regions)) return null;
  const lignes = brut.rapport.regions.map(ligneRegion);
  if (lignes.some((l) => l === null)) return null;
  const per = estObjet(brut.rapport.perimetre) ? texte(brut.rapport.perimetre.libelle) : null;
  const filtres = estObjet(brut.filtres) && Array.isArray(brut.filtres.nonAppliques) ? brut.filtres.nonAppliques : [];
  return {
    perimetreLibelle: per ?? "Périmètre non précisé",
    regions: lignes as LigneRegionLue[],
    total: ligneRegion(brut.rapport.total),
    avertissements: Array.isArray(brut.rapport.avertissements) ? brut.rapport.avertissements.filter((x): x is string => typeof x === "string") : [],
    filtresNonAppliques: filtres.filter(estObjet).map((f) => ({ filtre: texte(f.filtre) ?? "", raison: texte(f.raison) ?? "" })).filter((f) => f.filtre !== ""),
  };
}

export async function lireRapportRegions(filtres: FiltresDecision): Promise<RapportRegionsLu> {
  const r = await api.get<unknown>(`${BASE}/rapports/regions`, { params: paramsApi(filtres) });
  const lu = analyserRapportRegions(r.data);
  if (!lu) throw new ReponseInattendue("le rapport par région");
  return lu;
}

// ---------------------------------------------------------------------------------------------- scenarios proposes a l'export

export interface ScenarioPropose { id: string; intitule: string; annee: number; provisoire: boolean }

export async function lireScenariosExportables(): Promise<ScenarioPropose[]> {
  const r = await api.get<unknown>("/v2/programmation/moteur/simulations", { params: { pageSize: 50 } });
  if (!estObjet(r.data) || !Array.isArray(r.data.data)) throw new ReponseInattendue("la liste des scénarios");
  const out: ScenarioPropose[] = [];
  for (const s of r.data.data) {
    if (!estObjet(s) || texte(s.id) === null || texte(s.intitule) === null || nombre(s.annee) === null) throw new ReponseInattendue("la liste des scénarios");
    out.push({ id: s.id as string, intitule: s.intitule as string, annee: s.annee as number, provisoire: s.provisoire !== false });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- relance

/**
 * Politique de relance des lectures du lot 6 : AUCUNE relance sur une erreur de requete (400, 401, 403, 404...) : la rejouer
 * ne change rien, retarde l'affichage du refus et, pour un 401, double les appels de rafraichissement. Une seule relance
 * pour une panne passagere (pas de reponse, 5xx).
 */
export function retryHorsErreurClient(nbEchecs: number, e: unknown): boolean {
  const statut = (e as { response?: { status?: unknown } } | null | undefined)?.response?.status;
  if (typeof statut === "number" && statut >= 400 && statut < 500) return false;
  return nbEchecs < 1;
}

export const OPTIONS_RELANCE = { retry: retryHorsErreurClient, retryDelay: 400 } as const;

/** Regions du filtre (noms pour l'apercu). Meme cle de cache que le filtre de la page ; politique de relance du lot 6. */
export async function lireRegionsApercu(): Promise<{ id: number; nom: string }[]> {
  const r = await api.get<unknown>("/regions");
  if (!Array.isArray(r.data)) throw new ReponseInattendue("les régions");
  return r.data.filter((x): x is { id: number; nom: string } => estObjet(x) && typeof x.id === "number" && typeof x.nom === "string");
}
