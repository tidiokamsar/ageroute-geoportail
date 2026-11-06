import type {
  AnalyseConflit, ConflitFiche, ConflitResume, DecisionConflit, EntreeHistorique, PageConflits, Preuve, RegleConflit, TransitionPossible,
} from "../../lib/projetsVoirieConflitsApi";
import { O, S } from "./synthetique.testutil";

/**
 * Fixtures 100 % SYNTHETIQUES des dossiers de conflit : noms et identifiants inventes, coordonnees autour d'un point arbitraire.
 * Les objets sont au format LU par `projetsVoirieConflitsApi` ; serialises en JSON, ils sont aussi lisibles par ses lecteurs (aller-retour).
 */

export const GEOM_CONFLIT = { type: "LineString" as const, coordinates: [[O - 0.0004, S + 0.0002], [O + 0.0004, S + 0.0002]] };

export function conflit(over: Partial<ConflitResume> = {}): ConflitResume {
  return {
    id: "cf-1", cle: "cle-aaaa", type: "INTERSECTION_CHAUSSEE", axe: "Axe A",
    concessionnaire: { id: "c1", nom: "Operateur synthetique A" }, jeuReseauId: "jeu-tel", objetId: "2",
    mesure: { longueurChausseeM: 74.01, longueurEmpriseM: 145.02, distanceMinM: 0, nbCroisements: 2 },
    geom: GEOM_CONFLIT, statut: "POTENTIEL", risque: "MOYEN", responsable: { id: "u-resp", nom: "Awa Responsable" }, echeance: "2099-12-31",
    actionProposee: "Vérifier la profondeur avec le concessionnaire", classePrecision: "B", verticalEvalue: false, aReexaminer: false, motifReexamen: null,
    premiereAnalyse: { id: "an-1", numero: 1 }, derniereAnalyse: { id: "an-2", numero: 2 },
    tronconsProches: [{ code: "RN1-012", nom: "Kissidougou - Faranah" }], createdAt: "2026-11-02T08:00:00Z", updatedAt: "2026-11-03T08:00:00Z", ...over,
  };
}

export const CONFLIT_INVESTIGUER = conflit({ id: "cf-2", cle: "cle-bbbb", type: "PROXIMITE", statut: "A_INVESTIGUER", classePrecision: "INCONNUE", risque: null, echeance: "2020-01-01", axe: "Axe B", responsable: null, geom: { type: "Point", coordinates: [O, S] } });
export const CONFLIT_CONFIRME = conflit({ id: "cf-3", cle: "cle-cccc", type: "TRAVERSEE", statut: "CONFIRME", axe: "Axe C", risque: "ELEVE", echeance: null });
export const CONFLIT_REEXAMEN = conflit({ id: "cf-4", cle: "cle-dddd", type: "COUVERTURE_INSUFFISANTE", statut: "CONFIRME", aReexaminer: true, motifReexamen: "NON_RETROUVE", concessionnaire: null, axe: "Axe D", risque: "INCONNU" });

export const COMPTEURS = { A_INVESTIGUER: 1, POTENTIEL: 1, CONFIRME: 2, INFIRME: 0, TRAITEMENT_DECIDE: 0, CLOTURE: 0 };

export function pageConflits(liste: ConflitResume[] = [conflit(), CONFLIT_INVESTIGUER, CONFLIT_CONFIRME, CONFLIT_REEXAMEN], over: Partial<PageConflits> = {}): PageConflits {
  return { conflits: liste, suivant: null, compteurs: COMPTEURS, ignores: 0, ...over };
}

export function histo(over: Partial<EntreeHistorique> = {}): EntreeHistorique {
  return { id: "h1", action: "CREATION", ancienStatut: null, nouveauStatut: "POTENTIEL", justification: null, acteur: null, analyseId: "an-1", donnees: null, createdAt: "2026-11-02T08:00:00Z", ...over };
}

export function preuve(over: Partial<Preuve> = {}): Preuve {
  return { id: "pr1", type: "CONTACT_CONCESSIONNAIRE", texte: "Appel du 03/11 : le concessionnaire confirme un fourreau à 0,8 m.", reference: "Courrier 42/2026", auteur: { id: "u-gest", nom: "Moussa Gestionnaire" }, createdAt: "2026-11-03T09:00:00Z", ...over };
}

export function decision(over: Partial<DecisionConflit> = {}): DecisionConflit {
  return {
    id: "d1", option: "PROTEGER", justification: "Protection mécanique du fourreau sous la chaussée", contraintes: "Travaux de nuit", coutEstime: 12000, coutReel: null, deviseCout: "GNF",
    dateDebutPrevue: "2027-01-10", dateFinPrevue: "2027-01-20", statut: "PROPOSEE", proposePar: { id: "u-gest", nom: "Moussa Gestionnaire" }, approuvePar: null, approuveLe: null,
    motifDecision: null, derogationSeparation: null, createdAt: "2026-11-04T09:00:00Z", ...over,
  };
}

export const TRANSITIONS_POTENTIEL: TransitionPossible[] = [
  { vers: "CONFIRME", derogationPossible: false, exigences: ["Au moins une preuve"] },
  { vers: "INFIRME", derogationPossible: false, exigences: [] },
  { vers: "A_INVESTIGUER", derogationPossible: false, exigences: [] },
];

export function fiche(over: Partial<ConflitFiche> = {}): ConflitFiche {
  return {
    ...conflit(),
    regle: { id: "rg-0", code: "RC-2D-0.1", version: 0, famille: null, toleranceProximiteM: 0, margeIncertitude: 1, statut: "APPROUVEE" },
    sources: [
      { jeuId: "jeu-tel", nomFichier: "reseau-synthetique.kml", version: 2, sha256: "ab".repeat(32), role: "RESEAU_TIERS", statut: "AUTORISE", concessionnaire: "Operateur synthetique A", classePrecision: "B" },
      { jeuId: "jeu-axes", nomFichier: "axes-synthetiques.geojson", version: 1, sha256: "cd".repeat(32), role: "AXES_TRAVAUX", statut: "AUTORISE", concessionnaire: null, classePrecision: "B" },
    ],
    historique: [
      histo(),
      histo({ id: "h2", action: "STATUT", ancienStatut: "A_INVESTIGUER", nouveauStatut: "POTENTIEL", justification: "Classe B confirmée par le plan validé", acteur: { id: "u-gest", nom: "Moussa Gestionnaire" }, analyseId: null, createdAt: "2026-11-03T10:00:00Z" }),
    ],
    preuves: [preuve()],
    decisions: [],
    transitions: TRANSITIONS_POTENTIEL,
    ...over,
  };
}

export function analyseConflit(over: Partial<AnalyseConflit> = {}): AnalyseConflit {
  return {
    id: "an-2", numero: 2, statut: "TERMINEE", largeurEmpriseM: 15, largeurChausseeM: 7,
    regles: [{ regleId: "rg-0", code: "RC-2D-0.1", version: 0, famille: null }],
    jeux: [{ jeuId: "jeu-tel", sha256: "ab".repeat(32), version: 2, role: "RESEAU_TIERS", statut: "AUTORISE" }],
    versionAlgorithme: "2D-UTM-1",
    resume: { total: 4, parType: { INTERSECTION_CHAUSSEE: 2, PROXIMITE: 2 }, parStatut: { POTENTIEL: 2, A_INVESTIGUER: 2 }, nouveaux: 1, retrouves: 2, disparus: 1 },
    declenchePar: { id: "u-gest", nom: "Moussa Gestionnaire" }, dureeMs: 1840, createdAt: "2026-11-04T08:00:00Z", ...over,
  };
}
export const ANALYSE_1 = analyseConflit({ id: "an-1", numero: 1, resume: { total: 3, parType: {}, parStatut: {}, nouveaux: 3, retrouves: 0, disparus: 0 }, createdAt: "2026-11-02T08:00:00Z" });

export function regle(over: Partial<RegleConflit> = {}): RegleConflit {
  return {
    id: "rg-0", projetId: null, famille: null, code: "RC-2D-0.1", version: 0, toleranceProximiteM: 0, margeIncertitude: 1, statut: "APPROUVEE",
    justification: "Règle par défaut du socle", creePar: null, approuvePar: null, approuveLe: null, createdAt: "2026-10-30T08:00:00Z", ...over,
  };
}
export const REGLES = [
  regle(),
  regle({ id: "rg-1", projetId: "p1", famille: "TELECOM", code: "RC-TEL", version: 1, toleranceProximiteM: 2, margeIncertitude: 1.5, justification: "Tolérance convenue avec l'opérateur", creePar: { id: "u-gest", nom: "Moussa Gestionnaire" }, approuvePar: { id: "u-adm", nom: "Fatou Admin" }, approuveLe: "2026-11-01T08:00:00Z" }),
  regle({ id: "rg-2", projetId: "p1", famille: "TELECOM", code: "RC-TEL", version: 2, toleranceProximiteM: 3, margeIncertitude: 1.5, statut: "BROUILLON", justification: "Proposition de tolérance élargie", approuvePar: null, approuveLe: null, creePar: { id: "u-gest", nom: "Moussa Gestionnaire" } }),
];

/** JSON « brut » du serveur : l'objet lu, serialise. */
export const brut = <T,>(v: T): unknown => JSON.parse(JSON.stringify(v));
