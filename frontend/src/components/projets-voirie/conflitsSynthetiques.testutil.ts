import type {
  AnalyseConflit, ConflitFiche, ConflitResume, DecisionConflit, EntreeHistorique, PageConflits, Preuve, RegleConflit, TransitionPossible,
} from "../../lib/projetsVoirieConflitsApi";
import { O, S } from "./synthetique.testutil";

/**
 * Fixtures 100 % SYNTHETIQUES des dossiers de conflit : noms et identifiants inventes, coordonnees autour d'un point arbitraire.
 *
 * Deux jeux de fonctions : les constructeurs (`conflit`, `fiche`, `decision`...) rendent le MODELE LU par `projetsVoirieConflitsApi`, pratique a ecrire ;
 * les convertisseurs `serveur*` en font le JSON tel que le BACKEND le rend (forme relevee dans `api-v2/projets-voirie.conflits.routes.ts` et
 * `projets-voirie/conflits/*.service.ts`, commit 2a5e9cb de `feat/rc3-conflits`). Les tests de page simulent l'API avec les convertisseurs : les
 * lecteurs sont ainsi exerces sur la forme reelle, pas sur celle qu'on aurait devinee.
 */

export const GEOM_CONFLIT = { type: "LineString" as const, coordinates: [[O - 0.0004, S + 0.0002], [O + 0.0004, S + 0.0002]] };

export function conflit(over: Partial<ConflitResume> = {}): ConflitResume {
  return {
    id: "cf-1", cle: "cle-aaaa", type: "INTERSECTION_CHAUSSEE", axe: "Axe A",
    concessionnaire: { id: "c1", nom: "Operateur synthetique A" }, typeReseau: "TELECOM", jeuReseauId: "jeu-tel", objet: { id: "2", nom: "Fibre FO-01" },
    mesure: { longueurChausseeM: 74.01, longueurEmpriseM: 145.02, distanceMinM: 0, nbCroisements: 2, longueurPieceM: 145.02 },
    geom: GEOM_CONFLIT, bbox: [O - 0.0004, S + 0.0002, O + 0.0004, S + 0.0002], geometrieMasquee: false,
    statut: "POTENTIEL", risque: "MOYEN", responsable: { id: "u-resp", nom: "Awa Responsable" }, echeance: "2099-12-31", echeanceDepassee: false,
    actionProposee: "Vérifier la profondeur avec le concessionnaire", classePrecision: "B", verticalEvalue: false, aReexaminer: false, motifReexamen: null,
    premiereAnalyse: { id: "an-1", numero: 1 }, derniereAnalyse: { id: "an-2", numero: 2 },
    tronconsProches: [{ code: "RN1-012", nom: "Kissidougou - Faranah" }], createdAt: "2026-11-02T08:00:00Z", updatedAt: "2026-11-03T08:00:00Z", ...over,
  };
}

export const CONFLIT_INVESTIGUER = conflit({
  id: "cf-2", cle: "cle-bbbb", type: "PROXIMITE", statut: "A_INVESTIGUER", classePrecision: "INCONNUE", risque: null, echeance: "2020-01-01", echeanceDepassee: true, axe: "Axe B",
  responsable: null, geom: { type: "Point", coordinates: [O, S] }, objet: { id: "3", nom: "Fibre FO-02" },
});
export const CONFLIT_CONFIRME = conflit({ id: "cf-3", cle: "cle-cccc", type: "TRAVERSEE", statut: "CONFIRME", axe: "Axe C", risque: "ELEVE", echeance: null, echeanceDepassee: false });
export const CONFLIT_REEXAMEN = conflit({
  id: "cf-4", cle: "cle-dddd", type: "COUVERTURE_INSUFFISANTE", statut: "CONFIRME", aReexaminer: true, motifReexamen: "NON_RETROUVE", concessionnaire: null, typeReseau: null,
  jeuReseauId: null, objet: null, axe: "Axe D", risque: "INCONNU",
});

export const COMPTEURS = { A_INVESTIGUER: 1, POTENTIEL: 1, CONFIRME: 2, INFIRME: 0, TRAITEMENT_DECIDE: 0, CLOTURE: 0 };

export function pageConflits(liste: ConflitResume[] = [conflit(), CONFLIT_INVESTIGUER, CONFLIT_CONFIRME, CONFLIT_REEXAMEN], over: Partial<PageConflits> = {}): PageConflits {
  return { conflits: liste, suivant: null, compteurs: COMPTEURS, ignores: 0, ...over };
}

export function histo(over: Partial<EntreeHistorique> = {}): EntreeHistorique {
  return { id: "h1", action: "CREATION", ancienStatut: null, nouveauStatut: "POTENTIEL", justification: null, acteur: null, analyse: { id: "an-1", numero: 1 }, donnees: null, createdAt: "2026-11-02T08:00:00Z", ...over };
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

export const transition = (vers: TransitionPossible["vers"], over: Partial<TransitionPossible> = {}): TransitionPossible =>
  ({ vers, preuveRequise: false, decisionRequise: false, cloture: vers === "CLOTURE", bloquee: null, ...over });

export const TRANSITIONS_POTENTIEL: TransitionPossible[] = [
  transition("CONFIRME", { preuveRequise: true }), transition("INFIRME"), transition("A_INVESTIGUER"),
];

export function fiche(over: Partial<ConflitFiche> = {}): ConflitFiche {
  return {
    ...conflit(),
    regle: { id: "rg-0", code: "RC-2D-0.1", version: 0, famille: null, portee: "GENERALE", toleranceProximiteM: 0, margeIncertitude: 1, versionAlgorithme: "2D-UTM-1" },
    largeurs: { empriseM: 15, chausseeM: 7 },
    sources: [
      { jeuId: "jeu-tel", nomFichier: "reseau-synthetique.kml", version: 2, sha256: "ab".repeat(32), role: "RESEAU_TIERS", statut: "AUTORISE", concessionnaire: "Operateur synthetique A", classePrecision: "B", precisionHorizontaleM: 2, dateDonnees: "2026-10-24" },
      { jeuId: "jeu-axes", nomFichier: "axes-synthetiques.geojson", version: 1, sha256: "cd".repeat(32), role: "AXES_TRAVAUX", statut: "AUTORISE", concessionnaire: null, classePrecision: "B", precisionHorizontaleM: null, dateDonnees: null },
    ],
    historique: [
      histo(),
      histo({ id: "h2", action: "STATUT", ancienStatut: "A_INVESTIGUER", nouveauStatut: "POTENTIEL", justification: "Classe B confirmée par le plan validé", acteur: { id: "u-gest", nom: "Moussa Gestionnaire" }, analyse: null, createdAt: "2026-11-03T10:00:00Z" }),
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
    regles: [{ regleId: "rg-0", code: "RC-2D-0.1", version: 0, famille: null, portee: "GENERALE", toleranceProximiteM: 0, margeIncertitude: 1 }],
    jeux: [{ jeuId: "jeu-tel", nomFichier: "reseau-synthetique.kml", sha256: "ab".repeat(32), version: 2, role: "RESEAU_TIERS", statut: "AUTORISE", classePrecision: "B" }],
    versionAlgorithme: "2D-UTM-1",
    resume: {
      total: 4, axes: 3, jeuxReseau: 1, axesNonCouverts: 1, parType: { INTERSECTION_CHAUSSEE: 2, PROXIMITE: 2 }, parStatut: { POTENTIEL: 2, A_INVESTIGUER: 2 },
      nouveaux: 1, retrouves: 2, identiques: 1, modifies: 1, disparus: 1, reapparus: 0, marquesAReexaminer: 2,
      limites: ["Conflit vertical non évalué : profondeur et altitude absentes.", "Seuls les réseaux linéaires sont évalués."],
    },
    erreur: null, declenchePar: { id: "u-gest", nom: "Moussa Gestionnaire" }, dureeMs: 1840, createdAt: "2026-11-04T08:00:00Z", ...over,
  };
}
export const ANALYSE_1 = analyseConflit({
  id: "an-1", numero: 1, createdAt: "2026-11-02T08:00:00Z",
  resume: { total: 3, axes: 3, jeuxReseau: 1, axesNonCouverts: 0, parType: {}, parStatut: {}, nouveaux: 3, retrouves: 0, identiques: 0, modifies: 0, disparus: 0, reapparus: 0, marquesAReexaminer: 0, limites: [] },
});

export function regle(over: Partial<RegleConflit> = {}): RegleConflit {
  return {
    id: "rg-0", projetId: null, portee: "GENERALE", famille: null, code: "RC-2D-0.1", version: 0, toleranceProximiteM: 0, margeIncertitude: 1, statut: "APPROUVEE",
    justification: "Règle par défaut du socle", systeme: true, creePar: null, approuvePar: null, approuveLe: null, motifApprobation: null, derogationApprobation: null,
    createdAt: "2026-10-30T08:00:00Z", ...over,
  };
}
export const REGLES = [
  regle(),
  regle({
    id: "rg-1", projetId: "p1", portee: "PROJET", famille: "TELECOM", code: "RC-TEL", version: 1, toleranceProximiteM: 2, margeIncertitude: 1.5, justification: "Tolérance convenue avec l'opérateur",
    systeme: false, creePar: { id: "u-gest", nom: "Moussa Gestionnaire" }, approuvePar: { id: "u-adm", nom: "Fatou Admin" }, approuveLe: "2026-11-01T08:00:00Z", motifApprobation: "Validée avec la direction",
  }),
  regle({
    id: "rg-2", projetId: "p1", portee: "PROJET", famille: "TELECOM", code: "RC-TEL", version: 2, toleranceProximiteM: 3, margeIncertitude: 1.5, statut: "BROUILLON", justification: "Proposition de tolérance élargie",
    systeme: false, creePar: { id: "u-gest", nom: "Moussa Gestionnaire" },
  }),
];

// ---------------------------------------------------------------------------------------------------
// Convertisseurs : le JSON du serveur
// ---------------------------------------------------------------------------------------------------

const pers = (p: { id: string | null; nom: string | null } | null) => (p ? { id: p.id, nomComplet: p.nom } : null);

/** `vueConflit` du backend (liste) : pas de geometrie, une `bbox` ; `classePrecision` nul quand elle est inconnue. */
export function serveurConflit(c: ConflitResume) {
  return {
    id: c.id, projetId: "p1", cle: c.cle, type: c.type, axe: c.axe, statut: c.statut, risque: c.risque, aReexaminer: c.aReexaminer, motifReexamen: c.motifReexamen,
    responsable: pers(c.responsable), echeance: c.echeance, echeanceDepassee: c.echeanceDepassee, actionProposee: c.actionProposee,
    classePrecision: c.classePrecision === "INCONNUE" ? null : c.classePrecision, verticalEvalue: c.verticalEvalue,
    concessionnaire: c.concessionnaire, typeReseau: c.typeReseau, jeuReseauId: c.jeuReseauId, objet: c.objet,
    mesure: c.mesure, premiereAnalyseId: c.premiereAnalyse?.id ?? null, derniereAnalyseId: c.derniereAnalyse?.id ?? null,
    bbox: c.geometrieMasquee ? null : c.bbox, geometrieMasquee: c.geometrieMasquee, createdAt: c.createdAt, updatedAt: c.updatedAt,
  };
}

export const serveurPage = (p: PageConflits) => ({
  conflits: p.conflits.map(serveurConflit), compteurs: p.compteurs, total: p.compteurs ? Object.values(p.compteurs).reduce((a, b) => a + (b ?? 0), 0) : 0, curseurSuivant: p.suivant,
});

export const serveurDecision = (d: DecisionConflit) => ({
  id: d.id, conflitId: "cf-1", option: d.option, justification: d.justification, contraintes: d.contraintes, coutEstime: d.coutEstime, deviseCout: d.deviseCout, coutReel: d.coutReel,
  dateDebutPrevue: d.dateDebutPrevue, dateFinPrevue: d.dateFinPrevue, statut: d.statut, proposePar: pers(d.proposePar), approuvePar: pers(d.approuvePar), approuveLe: d.approuveLe,
  motifDecision: d.motifDecision, derogationSeparation: d.derogationSeparation, createdAt: d.createdAt,
});

/** `ficheConflit` du backend : `{ conflit (avec geometrie), sources, regle, largeurs, analyses, tronconsProches, historique, preuves, decisions, transitionsPossibles, avertissements }`. */
export function serveurFiche(f: ConflitFiche) {
  return {
    conflit: { ...serveurConflit(f), geometrie: f.geometrieMasquee ? null : f.geom },
    sources: f.sources.map((s) => ({
      jeuId: s.jeuId, role: s.role, version: s.version, sha256: s.sha256, statut: s.statut, nomFichier: s.nomFichier, typeReseau: null,
      concessionnaire: s.concessionnaire ? { id: "c1", nom: s.concessionnaire } : null, classePrecision: s.classePrecision, precisionHorizontaleM: s.precisionHorizontaleM,
      confidentialite: "CONFIDENTIEL_CONCESSIONNAIRE", dateDonnees: s.dateDonnees,
    })),
    regle: f.regle ? { regleId: f.regle.id, code: f.regle.code, version: f.regle.version, famille: f.regle.famille, portee: f.regle.portee, toleranceProximiteM: f.regle.toleranceProximiteM, margeIncertitude: f.regle.margeIncertitude, versionAlgorithme: f.regle.versionAlgorithme } : null,
    largeurs: f.largeurs,
    analyses: {
      premiere: f.premiereAnalyse ? { id: f.premiereAnalyse.id, numero: f.premiereAnalyse.numero, createdAt: "2026-11-02T08:00:00Z" } : null,
      derniere: f.derniereAnalyse ? { id: f.derniereAnalyse.id, numero: f.derniereAnalyse.numero, createdAt: "2026-11-04T08:00:00Z" } : null,
    },
    tronconsProches: f.tronconsProches,
    historique: f.historique.map((h) => ({
      id: h.id, action: h.action, ancienStatut: h.ancienStatut, nouveauStatut: h.nouveauStatut, justification: h.justification, acteur: pers(h.acteur),
      analyseId: h.analyse?.id ?? null, analyseNumero: h.analyse?.numero ?? null, donnees: h.donnees, createdAt: h.createdAt,
    })),
    preuves: f.preuves.map((p) => ({ id: p.id, type: p.type, texte: p.texte, reference: p.reference, auteur: pers(p.auteur), createdAt: p.createdAt })),
    decisions: f.decisions.map(serveurDecision),
    ...(f.transitions ? { transitionsPossibles: f.transitions.map((t) => ({ vers: t.vers, justificationRequise: true, preuveRequise: t.preuveRequise, decisionRequise: t.decisionRequise, cloture: t.cloture, bloquee: t.bloquee })) } : {}),
    avertissements: [
      "Un conflit est un signal de vérification : aucun déplacement n'est décidé ni ordonné par le système.",
      "Conflit vertical non évalué : profondeur et altitude absentes.",
      "L'absence de conflit détecté ne prouve pas l'absence de réseau.",
    ],
  };
}

/** `vueAnalyse` du backend ; `resume` est celui de la base (`totaux`, `parType`, ...), ou `{ statut: "ECHEC", erreur }` pour une analyse en echec. */
export function serveurAnalyse(a: AnalyseConflit) {
  const r = a.resume;
  return {
    id: a.id, projetId: "p1", numero: a.numero, statut: a.statut, largeurEmpriseM: a.largeurEmpriseM, largeurChausseeM: a.largeurChausseeM,
    regles: a.regles, jeux: a.jeux, versionAlgorithme: a.versionAlgorithme,
    resume: a.statut === "ECHEC"
      ? { statut: "ECHEC", erreur: a.erreur ?? { code: "ANALYSE_TROP_LONGUE", message: "délai dépassé" } }
      : {
        statut: "TERMINEE", versionAlgorithme: a.versionAlgorithme, totaux: { conflitsTrouves: r.total, axes: r.axes, jeuxReseau: r.jeuxReseau, axesNonCouverts: r.axesNonCouverts },
        parType: r.parType, parStatut: r.parStatut, nouveaux: r.nouveaux, retrouves: r.retrouves, identiques: r.identiques, modifies: r.modifies, disparus: r.disparus,
        reapparus: r.reapparus, marquesAReexaminer: r.marquesAReexaminer, plafond: { conflitsMax: 20000 }, limites: r.limites,
      },
    nbConflitsTrouves: a.statut === "ECHEC" ? 0 : (r.total ?? 0), declenchePar: pers(a.declenchePar), duree: a.dureeMs, createdAt: a.createdAt,
  };
}
export const serveurListeAnalyses = (liste: AnalyseConflit[], suivant: string | null = null) => ({ analyses: liste.map(serveurAnalyse), curseurSuivant: suivant });
export const serveurDetailAnalyse = (a: AnalyseConflit) => ({ analyse: serveurAnalyse(a) });
/** Reponse de `POST /analyses` : `{ analyse, resume }`. */
export const serveurLancement = (a: AnalyseConflit) => ({ analyse: serveurAnalyse(a), resume: serveurAnalyse(a).resume });

export function serveurRegle(r: RegleConflit) {
  return {
    id: r.id, projetId: r.projetId, portee: r.portee, famille: r.famille, code: r.code, version: r.version, toleranceProximiteM: r.toleranceProximiteM, margeIncertitude: r.margeIncertitude,
    statut: r.statut, justification: r.justification, systeme: r.systeme, creePar: pers(r.creePar), approuvePar: pers(r.approuvePar), approuveLe: r.approuveLe,
    motifApprobation: r.motifApprobation, derogationApprobation: r.derogationApprobation, createdAt: r.createdAt,
  };
}
export const serveurRegles = (regles: RegleConflit[]) => ({
  regles: regles.map(serveurRegle),
  effectives: (["TELECOM", "EAU_POTABLE", "ELECTRICITE", "ASSAINISSEMENT", "GAZ_HYDROCARBURES", "AUTRE"] as const).map((famille) => {
    const r = regles.filter((x) => x.statut === "APPROUVEE" && (x.famille === famille || x.famille === null)).sort((a, b) => (b.famille === famille ? 1 : 0) - (a.famille === famille ? 1 : 0) || b.version - a.version)[0] ?? regles[0];
    return { famille, regleId: r.id, code: r.code, version: r.version, portee: r.portee, toleranceProximiteM: r.toleranceProximiteM, margeIncertitude: r.margeIncertitude };
  }),
});

/** Reponse de comparaison : `reference` (`avec`), `comparee`, chaque categorie `{ nb, cles, conflits, detailsTronques }`. */
export function serveurComparaison(over: Record<string, unknown> = {}) {
  return {
    reference: { id: "an-1", numero: 1, createdAt: "2026-11-02T08:00:00Z" }, comparee: { id: "an-2", numero: 2, createdAt: "2026-11-04T08:00:00Z" },
    apparus: { nb: 1, cles: ["cle-bbbb"], conflits: [{ cle: "cle-bbbb", id: "cf-2", type: "PROXIMITE", axe: "Axe B", statut: "A_INVESTIGUER", aReexaminer: false }], detailsTronques: false },
    disparus: { nb: 1, cles: ["cle-dddd"], conflits: [{ cle: "cle-dddd", id: "cf-4", type: "COUVERTURE_INSUFFISANTE", axe: "Axe D", statut: "CONFIRME", aReexaminer: true }], detailsTronques: false },
    modifies: { nb: 0, cles: [], conflits: [], detailsTronques: false },
    identiques: { nb: 2, cles: ["k1", "k2"] },
    ...over,
  };
}

/** JSON « brut » : un objet quelconque passe par JSON (supprime les `undefined`, comme le fil). */
export const brut = <T,>(v: T): unknown => JSON.parse(JSON.stringify(v));
