import { api } from "./api";
import { enregistrerBlob, erreurAvecCorpsJson } from "./download";
import { versNombre } from "./projetsVoirie";
import {
  DELAI_EXPORT_NAVIGATEUR_MS, lireDerogation, lireDerogations, lireJournalExports, lireTableauDeBord, nomFichierExport,
  type CompteBeneficiaire, type Derogation, type ResultatExport, type TableauDeBord, type TentativeExport,
} from "./projetsVoirieExports";
import { ReponseInattendue } from "./projetsVoirieApi";
import { lireComptes } from "./projetsVoirieWorkflowApi";

/**
 * Client du lot X1 : export du dossier technique, journal des exports, derogations, tableaux de bord. Routes du contrat seulement
 * (CONTRAT-EXPORTS.md, sections 4 a 6). L'archive est recue en memoire puis remise au navigateur comme un fichier a enregistrer : elle n'est ni
 * ouverte, ni lue, ni conservee par l'application. Aucun stockage local. L'identifiant d'une derogation n'est jamais dans l'adresse de la page.
 */

const BASE = "/v2/projets-voirie";
const id = encodeURIComponent;
type Obj = Record<string, unknown>;
const estObjet = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Fabrique et telecharge le dossier technique. Attente BORNEE (`DELAI_EXPORT_NAVIGATEUR_MS`) et annulable (`signal`) : un abandon est consigne
 * ECHEC_ENVOI par le serveur et libere la derogation citee. Une erreur est relue (corps JSON du Blob) avant d'etre levee, pour garder son code.
 */
export async function exporterDossier(projetId: string, code: string, o: { geojson: boolean; derogationId: string | null }, signal?: AbortSignal): Promise<ResultatExport> {
  const params: Record<string, string> = { geojson: o.geojson ? "true" : "false" };
  if (o.geojson && o.derogationId) params.derogation = o.derogationId;
  let res;
  try {
    res = await api.get(`${BASE}/${id(projetId)}/export/dossier`, { params, responseType: "blob", signal, timeout: DELAI_EXPORT_NAVIGATEUR_MS });
  } catch (e) {
    throw await erreurAvecCorpsJson(e);
  }
  const h = estObjet(res.headers) ? res.headers : {};
  const entete = (k: string): unknown => h[k] ?? h[k.toLowerCase()];
  const blob = res.data;
  if (typeof Blob === "undefined" || !(blob instanceof Blob)) throw new ReponseInattendue(`GET ${BASE}/:id/export/dossier`);
  const nom = nomFichierExport(entete("content-disposition"), code);
  enregistrerBlob(blob, nom);
  const t = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  return {
    exportId: t(entete("x-export-id")), sha256: t(entete("x-empreinte-sha256")), nbFichiers: versNombre(entete("x-fichiers")),
    nbJeuxGeojson: versNombre(entete("x-jeux-geojson")), nomFichier: nom, tailleOctets: blob.size,
  };
}

export async function journalExports(projetId: string, signal?: AbortSignal): Promise<TentativeExport[]> {
  const { data } = await api.get(`${BASE}/${id(projetId)}/export/journal`, { params: { limite: 50 }, signal });
  return lireJournalExports(data);
}

export async function listerDerogations(projetId: string, signal?: AbortSignal): Promise<Derogation[]> {
  const { data } = await api.get(`${BASE}/${id(projetId)}/export/derogations`, { signal });
  return lireDerogations(data);
}

export interface CorpsDerogation { jeuxIds: string[]; justification: string; beneficiaireId: string; dureeHeures: number }

export async function accorderDerogation(projetId: string, c: CorpsDerogation): Promise<Derogation> {
  const { data } = await api.post(`${BASE}/${id(projetId)}/export/derogations`, { jeuxIds: c.jeuxIds, justification: c.justification.trim(), beneficiaireId: c.beneficiaireId, dureeHeures: c.dureeHeures });
  const d = estObjet(data) ? lireDerogation(data.derogation) : null;
  if (!d) throw new ReponseInattendue(`POST ${BASE}/:id/export/derogations`);
  return d;
}

/** Page maximale de `GET /users` (route ADMIN, hors module). */
export const COMPTES_BENEFICIAIRES_MAX = 200;
/**
 * Comptes beneficiaires possibles : ADMIN et GESTIONNAIRE actifs (deux pages, sans terme de recherche : la saisie de l'administrateur est filtree
 * cote client et n'entre jamais dans une URL). Le perimetre et la cle du module sont verifies par le serveur a l'octroi.
 */
export async function listerComptesBeneficiaires(signal?: AbortSignal): Promise<CompteBeneficiaire[]> {
  const [admins, gestionnaires] = await Promise.all((["ADMIN", "GESTIONNAIRE"] as const).map(async (role) => {
    const { data } = await api.get("/users", { params: { role, actif: "true", pageSize: COMPTES_BENEFICIAIRES_MAX }, signal });
    return lireComptes(data).map((c): CompteBeneficiaire => ({ id: c.id, nom: c.nom, email: c.email, role, modules: c.modules }));
  }));
  return [...admins, ...gestionnaires];
}

export async function tableauNational(signal?: AbortSignal): Promise<TableauDeBord> {
  const { data } = await api.get(`${BASE}/tableau-de-bord`, { signal });
  return lireTableauDeBord(data);
}

export async function tableauTerritoire(territoireId: string, signal?: AbortSignal): Promise<TableauDeBord> {
  const { data } = await api.get(`${BASE}/tableau-de-bord/territoires/${id(territoireId)}`, { signal });
  return lireTableauDeBord(data);
}
