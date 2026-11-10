import { api } from "./api";
import {
  lireCompletude, lireEcritureDocument, lireFicheDocument, lirePageDocuments,
  type Completude, type FicheDocumentProjet, type PageDocuments, type ResultatEcritureDocument, type StatutDocument,
} from "./projetsVoirieDocuments";

/**
 * Client du lot D1 (documents du projet, complétude). Routes du contrat seulement (CONTRAT-DOCUMENTS.md, section 5). Le fichier d'une piece part
 * en multipart (champ `fichier`) : le serveur en calcule l'empreinte et l'oublie. Aucun stockage local ; les filtres saisis ne sont jamais dans
 * l'adresse de la page (seulement dans la requete a l'API).
 */

const BASE = "/v2/projets-voirie";
const id = encodeURIComponent;

export interface FiltresDocuments { statuts: readonly StatutDocument[]; typeCode: string | null; versions: "courantes" | "toutes" }
export const LIMITE_DOCUMENTS = 50;

export async function listerDocuments(projetId: string, f: FiltresDocuments, curseur: string | null, signal?: AbortSignal): Promise<PageDocuments> {
  const params: Record<string, string | number> = { limite: LIMITE_DOCUMENTS, versions: f.versions };
  if (f.statuts.length) params.statut = f.statuts.join(",");
  if (f.typeCode) params.typeCode = f.typeCode;
  if (curseur) params.curseur = curseur;
  const { data } = await api.get(`${BASE}/${id(projetId)}/documents`, { params, signal });
  return lirePageDocuments(data);
}

export async function lireDocumentFiche(projetId: string, docId: string, signal?: AbortSignal): Promise<FicheDocumentProjet> {
  const { data } = await api.get(`${BASE}/${id(projetId)}/documents/${id(docId)}`, { signal });
  return lireFicheDocument(data);
}

export async function lireCompletudeProjet(projetId: string, signal?: AbortSignal): Promise<Completude> {
  const { data } = await api.get(`${BASE}/${id(projetId)}/completude`, { signal });
  return lireCompletude(data);
}

/** Piece d'un document : une reference (texte), un fichier PDF ou DWG, ou un jeu de donnees du projet (le fichier et le jeu s'excluent). */
export interface PieceSaisie { reference?: string | null; jeuId?: string | null; fichier?: File | null }

export interface CreationDocument { typeCode: string; titre: string; description?: string | null; dateDocument?: string | null; concessionnaireId?: string | null }

/** Corps JSON sans fichier ; multipart avec. Les champs vides ne partent pas (le serveur applique ses defauts). */
function corpsAvecPiece(champs: Record<string, string | null | undefined>, piece: PieceSaisie): FormData | Record<string, string> {
  const valeurs: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...champs, reference: piece.reference, jeuId: piece.jeuId })) if (typeof v === "string" && v.trim() !== "") valeurs[k] = v.trim();
  if (!piece.fichier) return valeurs;
  const f = new FormData();
  for (const [k, v] of Object.entries(valeurs)) f.append(k, v);
  f.append("fichier", piece.fichier, piece.fichier.name);
  return f;
}

export async function creerDocument(projetId: string, d: CreationDocument, piece: PieceSaisie): Promise<ResultatEcritureDocument> {
  const corps = corpsAvecPiece({ typeCode: d.typeCode, titre: d.titre, description: d.description, dateDocument: d.dateDocument, concessionnaireId: d.concessionnaireId }, piece);
  const { data } = await api.post(`${BASE}/${id(projetId)}/documents`, corps);
  return lireEcritureDocument(data, "POST /v2/projets-voirie/:id/documents");
}

export async function deposerPieceDocument(projetId: string, docId: string, piece: PieceSaisie): Promise<ResultatEcritureDocument> {
  const { data } = await api.post(`${BASE}/${id(projetId)}/documents/${id(docId)}/depot`, corpsAvecPiece({}, piece));
  return lireEcritureDocument(data, "POST /v2/projets-voirie/:id/documents/:docId/depot");
}

export async function nouvelleVersionDocument(projetId: string, docId: string, piece: PieceSaisie): Promise<ResultatEcritureDocument> {
  const { data } = await api.post(`${BASE}/${id(projetId)}/documents/${id(docId)}/versions`, corpsAvecPiece({}, piece));
  return lireEcritureDocument(data, "POST /v2/projets-voirie/:id/documents/:docId/versions");
}

export async function changerStatutDocument(projetId: string, docId: string, statut: StatutDocument, justification: string | null): Promise<ResultatEcritureDocument> {
  const corps: Record<string, string> = { statut };
  if (justification && justification.trim()) corps.justification = justification.trim();
  const { data } = await api.post(`${BASE}/${id(projetId)}/documents/${id(docId)}/statut`, corps);
  return lireEcritureDocument(data, "POST /v2/projets-voirie/:id/documents/:docId/statut");
}

/** Retrait LOGIQUE (le document est fige et n'est plus montre) : justification obligatoire ; une piece VALIDE, ADMIN seulement. */
export async function retirerDocument(projetId: string, docId: string, justification: string): Promise<void> {
  await api.delete(`${BASE}/${id(projetId)}/documents/${id(docId)}`, { data: { justification: justification.trim() } });
}
