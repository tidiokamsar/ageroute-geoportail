import type {
  PagePropositions, Proposition, PropositionDetail, SourceObservation, Synthese,
} from "../../lib/teledetectionApi";

/**
 * Jeux de donnees SYNTHETIQUES pour les tests de l'ecran Observation de la Terre.
 * Aucune de ces valeurs n'est une donnee reelle ni une constante de l'interface : elles servent a
 * exercer les etats d'ecran. Chaque proposition porte `synthetique: true` (contrat, paragraphe 9).
 * Ce fichier n'est importe que par des tests.
 */

export const synthese = (over: Partial<Synthese> = {}): Synthese => ({
  periode: { depuis: null, jusqua: null },
  propositions: { aVerifier: 5, enAttente: 2, nonConcluantes: 1, confirmees: 3, infirmees: 2, prioritaires: 2 },
  tauxConfirmation: { confirmees: 3, infirmees: 2, jugees: 5, valeur: 0.6, echantillonSuffisant: false, seuil: 30, definition: "Confirmées ÷ (confirmées + infirmées)." },
  sources: { total: 3, parEtat: { TRAITEMENT_OPERATIONNEL: 1, ACCESSIBLE: 1, NON_CONFIGUREE: 1 }, actives: 1 },
  derniereAcquisition: { produitId: "prod-1", source: "Source A", date: "2026-10-20T10:00:00Z", resolutionM: 10 },
  fraicheur: { dateCalcul: "2026-10-25T08:00:00Z", ageDerniereAcquisitionJours: 5 },
  ...over,
});

export const proposition = (over: Partial<Proposition> = {}): Proposition => ({
  id: "p-1",
  type: "INONDATION",
  statut: "A_VERIFIER",
  priorite: { niveau: "HAUTE", regle: "Type inondation sur un tronçon classé RN" },
  confianceDetection: { valeur: 0.87, calibree: false, signification: "Indice de la méthode, non calibré : pas une probabilité." },
  qualiteImage: { couvertureNuagesPct: 12, note: null },
  rattachement: { confiance: "HAUTE", distanceM: 18.4, algorithme: "plus-proche-troncon v1" },
  methode: { nom: "seuil-sar", version: "0" },
  source: { code: "SRC-A", nom: "Source A", capteur: "Capteur A", resolutionM: 10 },
  dateObservation: "2026-10-20T10:00:00Z",
  dateReference: "2026-09-15T10:00:00Z",
  troncon: { id: "t-1", code: "GN N0001", nom: "Conakry - Coyah", regionId: 1, regionNom: "Conakry" },
  rattachee: true,
  centre: { lat: 9.6, lon: -13.6 },
  apercuDisponible: true,
  synthetique: true,
  missionId: null,
  ...over,
});

export const detail = (over: Partial<PropositionDetail> = {}): PropositionDetail => ({
  ...proposition(),
  produitApres: null,
  produitAvant: null,
  limites: ["Un nuage résiduel peut produire une fausse détection."],
  provenance: { fournisseur: "Fournisseur A", identifiantFournisseur: "ID-123", licence: "Licence A", attribution: "Attribution A", versionTraitement: "t1", empreinteSha256: null },
  geometrie: null,
  historique: [],
  mission: null,
  terrain: { observations: [] },
  apercus: { avant: { url: null, date: "2026-09-15T10:00:00Z" }, apres: { url: null, date: "2026-10-20T10:00:00Z" } },
  ...over,
});

export const source = (over: Partial<SourceObservation> = {}): SourceObservation => ({
  code: "SRC-A", nom: "Source A", fournisseur: "Fournisseur A", capteur: "Capteur A", resolutionM: 10,
  etat: "TRAITEMENT_OPERATIONNEL", derniereVerification: "2026-10-24T09:00:00Z", derniereAcquisition: "2026-10-20T10:00:00Z",
  message: null, requiertIdentifiants: false, ...over,
});

export const page = (items: Proposition[], over: Partial<PagePropositions> = {}): PagePropositions => ({
  items, suivant: null, total: items.length, ...over,
});

/** Erreur de forme axios, avec statut et message serveur. */
export function echec(status: number, error?: string, code?: string) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status, data: { ...(error ? { error } : {}), ...(code ? { code } : {}) } } });
}
/**
 * Erreur de forme axios telle que la rend une requete en `responseType: "blob"` : le corps JSON de l'erreur est un BLOB,
 * pas un objet (c'est la forme que `echec` ne reproduit pas, et que les tests d'origine ne couvraient donc pas).
 */
export function echecBlob(status: number, corps: unknown, type = "application/json") {
  const data = new Blob([typeof corps === "string" ? corps : JSON.stringify(corps)], { type });
  return Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });
}
export function echecReseau() {
  return Object.assign(new Error("Network Error"), {});
}

type Reponse = unknown | ((config?: { params?: Record<string, unknown> }) => unknown);

/**
 * Routeur de GET : `table` associe une URL a une reponse (valeur, fonction, ou erreur a lever).
 * Une URL absente de la table leve une erreur claire (aucun faux vide).
 */
export function routeurGet(table: Record<string, Reponse>) {
  return async (url: string, config?: { params?: Record<string, unknown> }) => {
    if (!(url in table)) throw new Error(`URL non prevue par le test : ${url}`);
    const r = table[url];
    const v = typeof r === "function" ? (r as (c?: unknown) => unknown)(config) : r;
    if (v instanceof Error) throw v;
    return { data: v };
  };
}
