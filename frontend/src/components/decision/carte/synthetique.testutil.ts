import { vi } from "vitest";

/**
 * Donnees SYNTHETIQUES des tests de la carte et de la liste (`synth-*`). Aucune valeur ne decrit une intervention, un troncon ou un cout reels.
 * La FORME est celle du backend reel (`LigneClassee` de `backend/src/programmation/priorite.noyau.ts`, enveloppes de `priorite.service.ts`).
 * Fichier utilise par les tests seulement : il n'est jamais importe par le code de production (contrat paragraphe 10).
 */

/** Une `LigneClassee` : classee (score complet) par defaut ; `over` remplace des champs de premier niveau. */
export function interventionSynth(i: number, over: Record<string, unknown> = {}) {
  return {
    id: `synth-${i}`,
    objet: { type: "TRONCON", id: `t-${i}`, code: `SYN-${i}`, nom: `Tronçon synthétique ${i}` },
    regionId: 2, regionNom: "Région synthétique", classe: "RN", prefecture: null, etatPhysique: "MAUVAIS",
    dernierConstat: { date: "2026-09-01", source: "inspections.dateInspection", ageJours: 55 },
    prioriteTechnique: {
      statut: "CALCULE", rang: i, score: 80 - i, scoreIncomplet: false, couverture: 1,
      contributions: [
        { critere: "ETAT_GRAVITE", libelle: "État et gravité", poids: 40, poidsPct: 40, valeurNormalisee: 90, points: 36, brut: "MAUVAIS", provenance: "valeurs_qualite", note: "état validé" },
        { critere: "TRAFIC", libelle: "Trafic", poids: 30, poidsPct: 30, valeurNormalisee: 50, points: 15, brut: 1200, provenance: "troncons.traficMoyenJma", note: "comptage de 2019" },
      ],
      criteresManquants: [], exclusion: null,
    },
    ordreArbitrage: { rang: i, ratioPointsParMilliardGnf: "1.5", risqueCourant: 40, risqueAttendu: 20, motifAbsence: null },
    confiance: { niveau: "MOYENNE", statutEtat: "VALIDE", source: "inspection", observeLe: "2026-09-01" },
    completude: 1, sources: { troncon: { type: "OFFICIEL", confiance: "HAUTE" }, etat: "inspection" },
    coutEstime: {
      montantGnf: "1200000000", devise: "GNF", unite: "GNF", classePrecision: "ORDRE_GRANDEUR", margePct: 30, provisoire: true, hypothesesManquantes: [],
      traitement: { code: "REHAB", libelle: "Réhabilitation" },
      bareme: { id: 1, code: "SYN", typeIntervention: "REHAB", coutKmGnf: "100000000", anneeReference: 2026, largeurChausseeM: null, approuve: false, version: 1, source: "barème synthétique", validDe: "2026-01-01", validA: "2099-01-01" },
      longueurM: 12000, calcul: "12 km x 100 000 000 GNF/km",
    },
    coutNonEstimable: null,
    longueur: {
      metierKm: 12, metierDerivee: false, geometriqueM: 12200, utiliseeM: 12000, longueurOrigine: "LONGUEUR_KM",
      divergence: { signalee: false, ecartRelatif: 0.016, seuilRelatif: 0.1, seuilAbsoluMinKm: 0.05, statutSeuil: "PROVISOIRE" },
    },
    localisation: "valide", localisationMotif: null, provisoire: true, modeleVersion: "modele-synth-1", parametresVersion: "parametres-synth-1",
    ...over,
  };
}

/** Une ligne classee sur score INCOMPLET. */
export function incompleteSynth(i: number, manquants: { critere: string; libelle: string; raison: string }[], score: number | null = 22.5, over: Record<string, unknown> = {}) {
  const base = interventionSynth(i, over);
  return { ...base, completude: 0.6, prioriteTechnique: { ...base.prioriteTechnique, statut: "INCOMPLET", scoreIncomplet: true, score, couverture: 0.6, criteresManquants: manquants } };
}

/** Une ligne NON CLASSEE (exclue) : ni rang ni score. */
export function exclueSynth(i: number, code = "ETAT_NON_EVALUE", motif = "l'état du tronçon n'est pas évalué", over: Record<string, unknown> = {}) {
  const base = interventionSynth(i, { etatPhysique: "NON_EVALUE", ...over });
  return { ...base, completude: 0, prioriteTechnique: { statut: "EXCLU", rang: null, score: null, scoreIncomplet: false, couverture: 0, contributions: [], criteresManquants: [], exclusion: { code, motif } } };
}

export const RESUME_SYNTH = { candidats: 3, classes: 3, complets: 3, incomplets: 0, exclus: 0, parMotifExclusion: {} };

/** Enveloppe de `GET /interventions` (`listerInterventions`). */
export function listeSynth(lignes: unknown[], extra: Record<string, unknown> = {}) {
  return {
    data: lignes,
    page: { limite: 25, prochainCurseur: null, aSuivant: false },
    total: lignes.length, totalAffiche: lignes.length,
    resume: { ...RESUME_SYNTH, candidats: lignes.length, classes: lignes.length, complets: lignes.length },
    perimetre: { national: true, regions: null },
    filtres: { appliques: {}, nonAppliques: [] },
    modele: { id: "priorite", version: "priorite.1" }, parametres: { id: "p1", version: "parametres-synth-1", etiquette: "provisoire" },
    dateReference: "2026-10-26", provisoire: true, motifsProvisoire: ["paramètres non approuvés (synthétique)"],
    avertissement: "Consultatif, non engageant (synthétique).", empreinte: "synth",
    ...extra,
  };
}

/** Enveloppe de `GET /interventions/:id` (`detailIntervention`). */
export function ficheSynth(i: number, over: Record<string, unknown> = {}, ligne: Record<string, unknown> = interventionSynth(i)) {
  return {
    intervention: ligne,
    motif: "Motif synthétique : état dégradé sur un axe fréquenté.",
    limites: ["Trafic de 2019 (synthétique)."],
    modele: { id: "priorite", version: "priorite.1" }, parametres: { id: "p1", version: "parametres-synth-1", etiquette: "provisoire" },
    fiches: [],
    historique: {
      recalculs: { disponible: false, raison: "le classement est calculé à la volée et n'est pas enregistré" },
      decisions: [{ ficheId: "f1", rang: 1, de: "BROUILLON", vers: "PROPOSE", origine: "GEOPORTAIL", motif: "revue synthétique", auteurId: "u1", enregistreLe: "2026-10-01T10:00:00Z" }],
      parametres: [{ version: "parametres-synth-1", creeLe: "2026-10-01", auteurId: "u1", approuveeLe: null, approuveeParId: null, utilisee: true }],
    },
    actions: { disponibles: [], nonDisponibles: ["examiner", "affecter", "proposer_a_la_programmation", "reporter", "rejeter"], raison: "Aucun workflow n'existe pour une intervention candidate (synthétique)." },
    provisoire: true, motifsProvisoire: ["paramètres non approuvés (synthétique)"], avertissement: "la priorité est calculée, elle ne remplace pas le jugement de l'ingénieur (synthétique).",
    dateReference: "2026-10-26", empreinte: "synth",
    ...over,
  };
}

/** Une feature de `GET /interventions.geojson`. */
export function featureSynth(i: number, over: Record<string, unknown> = {}, geometrie?: unknown) {
  return {
    type: "Feature" as const,
    id: `synth-${i}`,
    geometry: geometrie ?? { type: "Point" as const, coordinates: [-13.7 + (i % 50) * 0.001, 9.6 + Math.floor(i / 50) * 0.001] },
    properties: {
      id: `synth-${i}`, code: `SYN-${i}`, nom: `Tronçon synthétique ${i}`, rang: i, score: 80 - (i % 70), scoreIncomplet: false, statutScore: "CALCULE",
      etatPhysique: "MAUVAIS", classe: "RN", regionId: 2, couverture: 1, rangArbitrage: i, ...over,
    },
  };
}

export const collectionSynth = (features: unknown[], extra: Record<string, unknown> = {}) => ({
  type: "FeatureCollection" as const, features, total: features.length, tronque: false, limite: 300, horsGeometrie: 0, selection: features.length, filtres: { appliques: {}, nonAppliques: [] }, ...extra,
});

export const REGIONS_SYNTH = [{ id: 1, nom: "Région synthétique A" }, { id: 2, nom: "Région synthétique B" }];

export function erreurHttp(status: number, error?: string) {
  return Object.assign(new Error(`HTTP ${status}`), { isAxiosError: true, response: { status, data: error ? { error } : {} } });
}

type Routeur = Record<string, (params?: Record<string, string>) => unknown | Promise<unknown>>;

/** Branche `api.get` sur un routeur d'URL : une URL non declaree est une erreur du test (jamais une reponse devinee). */
export function brancherApi(get: ReturnType<typeof vi.fn>, routes: Routeur) {
  get.mockImplementation(async (url: string, opts?: { params?: Record<string, string> }) => {
    const route = routes[url] ?? Object.entries(routes).filter(([k]) => url.startsWith(k)).sort((a, b) => b[0].length - a[0].length)[0]?.[1];
    if (!route) throw new Error(`URL non prevue par le test : ${url}`);
    return { data: await route(opts?.params) };
  });
}
