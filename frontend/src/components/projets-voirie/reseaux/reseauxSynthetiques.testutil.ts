import { reponseApi, erreurHttp, type Params, type SurchargesApi } from "../conflitsPage.testutil";
import { O, S, jeu, projetFiche, JEU_AXES, JEU_GAZ_CONTROLE } from "../synthetique.testutil";

/**
 * Fixtures 100 % SYNTHETIQUES des reseaux physiques et circuits logiques (lot B1) : noms et identifiants inventes. Les constructeurs rendent le JSON tel que le
 * BACKEND le rend (formes relevees dans `projets-voirie/reseaux/vues.ts`, `descripteurs.service.ts`, `relations.service.ts`, `associations.service.ts`,
 * `comptage.service.ts`, et les reponses reelles de docs/projets-voirie/API.md). Les tests simulent l'API avec ces fonctions : les lecteurs sont exerces sur la
 * forme reelle, pas sur celle qu'on aurait devinee.
 */

export { erreurHttp };

export const JEU_RESEAU = "11111111-1111-4111-8111-111111111111";
export const BASE_RESEAU = "/v2/projets-voirie/p1/reseau";

export const sourceJeu = (over: Record<string, unknown> = {}) => ({
  jeuId: JEU_RESEAU, version: 1, role: "RESEAU_TIERS", statut: "AUTORISE", nomFichier: "circuits-synthetiques.geojson", typeReseau: "TELECOM",
  concessionnaire: { id: "c1", nom: "Operateur synthetique A" }, dateDonnees: null, confidentialite: "CONFIDENTIEL_CONCESSIONNAIRE", ...over,
});

const verticalAbsent = () => ({
  etat: "ABSENTE", evaluable: false, conclusion3D: null,
  motifs: ["Profondeur et altitude absentes : aucune conclusion 3D.", "Profondeur inconnue.", "Altitude inconnue.", "Précision verticale non déclarée."],
  profondeurM: null, altitudeM: null, referenceVerticale: null,
});

/** Un objet SANS descripteur : nature heritee du jeu, classe inconnue, vertical absent. */
export function objetServeur(over: Record<string, unknown> = {}) {
  return {
    id: "10", jeuId: JEU_RESEAU, nom: "Fibre FO-01", typeGeom: "LIGNE", longueurM: 60.01, source: sourceJeu(),
    nature: "CIRCUIT_LOGIQUE", origineNature: "JEU", typeObjet: null,
    qualite: { classePrecision: null, origineClasse: "INCONNUE", precisionHorizontaleM: null, precisionVerticaleM: null, methodeCollecte: null, dateConstat: null, niveauConfiance: null, statutQualite: "INCONNU" },
    vertical: verticalAbsent(), descripteur: null, ...over,
  };
}

/** Un objet QUALIFIE (descripteur present, classe A declaree, profondeur fournie avec sa reference). */
export function objetQualifie(over: Record<string, unknown> = {}) {
  return objetServeur({
    id: "4", nom: "Fibre FO-04", typeObjet: "FIBRE", origineNature: "OBJET",
    qualite: { classePrecision: "A", origineClasse: "OBJET", precisionHorizontaleM: 0.1, precisionVerticaleM: null, methodeCollecte: "GNSS RTK", dateConstat: "2026-10-01", niveauConfiance: "ELEVE", statutQualite: "OBSERVE" },
    vertical: {
      etat: "FOURNIE", evaluable: false, conclusion3D: null,
      motifs: ["Données verticales fournies par la source ; l'évaluation 3D n'est pas implémentée dans ce lot.", "Altitude inconnue.", "Précision verticale non déclarée."],
      profondeurM: 1.2, altitudeM: null, referenceVerticale: "terrain naturel",
    },
    descripteur: { justification: "Controle effectue avec le chef de projet", declarePar: "Sekou Gestionnaire", declareLe: "2026-11-08T00:40:23.884Z", modifiePar: null, modifieLe: "2026-11-08T00:40:23.884Z" },
    ...over,
  });
}

export const objetInfrastructure = (over: Record<string, unknown> = {}) => objetServeur({
  id: "20", nom: "Gaine G-01", nature: "ACTIF_PHYSIQUE", origineNature: "OBJET", typeObjet: "GAINE", longueurM: 120.5,
  source: sourceJeu({ nomFichier: "gaines-synthetiques.geojson" }), ...over,
});
export const objetEquipement = (over: Record<string, unknown> = {}) => objetServeur({
  id: "30", nom: "Vanne V1", typeGeom: "POINT", longueurM: null, nature: "EQUIPEMENT", origineNature: "OBJET", typeObjet: null, ...over,
});

const extremite = (objetId: string, nom: string, nature: string, typeGeom: string, typeObjet: string | null = null) => ({ objetId, nom, nature, typeObjet, typeGeom, jeuId: JEU_RESEAU });

/** Une relation PROPOSEE par l'association automatique (avec le calcul de la proposition). */
export function relationProposee(over: Record<string, unknown> = {}) {
  return {
    id: "r0000001-0000-4000-8000-000000000001", projetId: "p1", typeRelation: "PORTE_PAR", statut: "PROPOSEE", origine: "AUTOMATIQUE",
    proposition: {
      methode: "SUPERPOSITION", version: "ASSOC-0.1", toleranceM: 2, composantes: { circuitM: 2, infrastructureM: 2 }, couverture: 0.96, couvertureMin: 0.9,
      longueurCircuitM: 60.01, longueurDansToleranceM: 57.6, projection: "EPSG:32629", statutParametres: "PROVISOIRE_A_VALIDER",
    },
    source: extremite("10", "Fibre FO-01", "CIRCUIT_LOGIQUE", "LIGNE"), cible: extremite("20", "Gaine G-01", "ACTIF_PHYSIQUE", "LIGNE", "GAINE"),
    decision: null, creePar: "Sekou Gestionnaire", createdAt: "2026-11-08T00:40:30.513Z", updatedAt: "2026-11-08T00:40:30.513Z", actionsPossibles: ["valider", "refuser"], ...over,
  };
}

/** Une relation MANUELLE (equipement dans une chambre), creee VALIDEE. */
export function relationValidee(over: Record<string, unknown> = {}) {
  return {
    id: "r0000002-0000-4000-8000-000000000002", projetId: "p1", typeRelation: "CONTENU_DANS", statut: "VALIDEE", origine: "MANUELLE", proposition: {},
    source: extremite("30", "Vanne V1", "EQUIPEMENT", "POINT"), cible: extremite("21", "Chambre C1", "ACTIF_PHYSIQUE", "POINT", "CHAMBRE"),
    decision: { par: "Sekou Gestionnaire", le: "2026-11-08T00:40:30.513Z", justification: "Vanne visible dans la chambre au releve" },
    creePar: "Sekou Gestionnaire", createdAt: "2026-11-08T00:40:30.513Z", updatedAt: "2026-11-08T00:40:30.513Z", actionsPossibles: ["revoquer"], ...over,
  };
}

export const pageObjetsServeur = (objets: unknown[], curseurSuivant: string | null = null) => ({ objets, curseurSuivant });
export const pageRelationsServeur = (relations: unknown[], curseurSuivant: string | null = null) => ({ relations, curseurSuivant });
export const ficheObjetServeur = (objet: unknown, relations: unknown[] = [], tracePartagee: unknown = null) => ({ objet, relations, tracePartagee });
export const TRACE_PARTAGEE = { nbAutresObjets: 2, libelle: "autres objets du même jeu dont la trace est strictement identique : ils restent séparés, ce ne sont pas des câbles distincts" };

export function resultatPropositionServeur(over: Record<string, unknown> = {}) {
  return {
    statut: "PROPOSITIONS_A_VALIDER",
    parametres: {
      version: "ASSOC-0.1", statut: "PROVISOIRE_A_VALIDER", methodeTolerance: "maximum", tolerancesParClasseM: { A: 0.5, B: 1, C: 2, D: 5, INCONNUE: 2 }, couvertureMin: 0.9, parCircuitMax: 5,
      projection: "EPSG:32629", jeuId: null,
    },
    bilan: { circuitsExamines: 8, infrastructuresExaminees: 3, classeEExclus: { circuits: 1, infrastructures: 0 }, propositionsCalculees: 4, creees: 4, dejaConnues: 0, tronque: false },
    idsCrees: ["a", "b", "c", "d"],
    avertissements: ["Ce sont des PROPOSITIONS : aucune association n'est appliquée tant qu'une personne ne l'a pas validée (avec justification).", "Une simple superposition géométrique ne prouve pas qu'un circuit est porté par une infrastructure."],
    ...over,
  };
}

/** Trois circuits superposes, un cable distinct (KIS-LOGIC-01, comptage reel du banc) : 8 circuits, somme 410,05 m, trace fusionnee 290,04 m. */
export function comptageServeur(over: Record<string, unknown> = {}) {
  return {
    projet: { id: "p1", code: "KISSI-SYNTH", nom: "Projet synthetique" }, inclureNonAutorises: false,
    jeux: [{ jeuId: JEU_RESEAU, role: "RESEAU_TIERS", statut: "AUTORISE", nonAutorise: false, version: 1, nomFichier: "circuits-synthetiques.geojson", concessionnaire: { id: "c1", nom: "Operateur synthetique A" }, typeReseau: "TELECOM", natureObjets: "INCONNUE", confidentialite: "CONFIDENTIEL_CONCESSIONNAIRE", dateDonnees: null, nbObjets: 8, libelleNbObjets: "circuits ou objets du fichier", longueurTotaleM: 410.05, longueurTraceFusionneM: 290.04 }],
    infrastructuresPhysiques: { nombreDeclare: 4, nombreLineaires: 3, parType: { INCONNU: 4 }, longueurSommeM: 180.03, longueurTraceFusionneM: 180.03 },
    circuitsLogiques: {
      nombreDeclare: 8, nombreLineaires: 8, parType: { INCONNU: 8 }, sommeLongueursCircuitsM: 410.05, longueurTraceFusionneM: 290.04,
      tracesPartagees: { groupes: 1, circuitsConcernes: 3 }, supportPhysique: { avecSupportValide: 0, avecPropositionSeulement: 2, sansSupportConnu: 6 },
    },
    equipements: { nombreDeclare: 1, parType: { INCONNU: 1 } },
    natureInconnue: { nombreObjets: 0, nombreLineaires: 0, longueurSommeM: 0, longueurTraceFusionneM: 0 },
    libelles: {
      nombreInfrastructuresDeclarees: "nombre d'infrastructures physiques déclarées (objets déclarés, sans dédoublonnage géométrique)",
      longueurTraceFusionneM: "longueur de trace fusionnée (union des tracés : un tracé superposé ne compte qu'une fois)",
      nombreCircuitsDeclares: "nombre de circuits logiques déclarés (ce n'est pas un nombre de câbles physiques)",
      sommeLongueursCircuitsM: "somme des longueurs de circuits (un tracé partagé par N circuits y compte N fois : ce n'est pas une longueur de câble)",
      natureInconnue: "objets de nature inconnue : comptés ni comme infrastructures ni comme circuits",
    },
    avertissements: [
      "Le nombre de circuits logiques n'est pas un nombre de câbles physiques : plusieurs circuits peuvent suivre le même support.",
      "Les 8 circuits logiques linéaires déclarés partagent tout ou partie de leur tracé : la somme de leurs longueurs (410,05 m) dépasse la longueur de trace fusionnée (290,04 m). Ce ne sont pas 8 câbles physiques.",
    ],
    qualite: {
      objets: 12, parClasse: { A: 1, B: 0, C: 0, D: 0, E: 0, inconnue: 11 }, libelleClasse: "classe de precision declaree",
      donneesVerticales: { objetsAvecProfondeurOuAltitude: 1, sansProfondeur: 11, sansAltitude: 12, evaluables: 0, mention: "Aucune évaluation verticale n'est implémentée : aucune conclusion 3D, même quand des données sont fournies." },
    },
    limites: ["Conflit vertical non évalué : profondeur et altitude absentes ou non évaluées ; aucune conclusion 3D n'est produite.", "La connectivité du réseau (nœuds, continuité, traces amont et aval) n'est pas évaluée : le cahier la reporte."],
    ...over,
  };
}

export interface SurchargesReseau extends SurchargesApi {
  objets?: unknown | ((params: Params) => unknown);
  fichesObjets?: Record<string, unknown>;
  relations?: unknown | ((params: Params) => unknown);
  comptage?: unknown | ((params: Params) => unknown);
  carte?: unknown;
}

const estErreur = (v: unknown) => v instanceof Error || (!!v && typeof v === "object" && "response" in (v as object));
const rendu = (v: unknown) => { if (estErreur(v)) throw v; return { data: v }; };

/** API SIMULEE de la page projet avec l'onglet Reseaux : les routes `reseau/...` d'abord, le reste par la simulation des conflits. */
export function reponseApiReseau(url: string, params: Params, over: SurchargesReseau = {}): { data: unknown } {
  if (url === `${BASE_RESEAU}/objets`) {
    const o = over.objets;
    return rendu(typeof o === "function" ? (o as (p: Params) => unknown)(params) : o !== undefined ? o : pageObjetsServeur([objetServeur(), objetQualifie(), objetInfrastructure(), objetEquipement()]));
  }
  if (url.startsWith(`${BASE_RESEAU}/objets/`)) {
    const id = decodeURIComponent(url.slice(`${BASE_RESEAU}/objets/`.length));
    const f = over.fichesObjets?.[id];
    if (f !== undefined) return rendu(f);
    const base = id === "4" ? objetQualifie() : id === "20" ? objetInfrastructure() : id === "30" ? objetEquipement() : objetServeur({ id });
    return rendu(ficheObjetServeur(base, id === "10" ? [relationProposee()] : [], id === "10" ? TRACE_PARTAGEE : null));
  }
  if (url === `${BASE_RESEAU}/relations`) {
    const r = over.relations;
    return rendu(typeof r === "function" ? (r as (p: Params) => unknown)(params) : r !== undefined ? r : pageRelationsServeur([relationProposee(), relationValidee()]));
  }
  if (url === "/v2/projets-voirie/p1/carte" && over.carte !== undefined) return rendu(over.carte);
  if (url === `${BASE_RESEAU}/comptage`) {
    const c = over.comptage;
    return rendu(typeof c === "function" ? (c as (p: Params) => unknown)(params) : c !== undefined ? c : comptageServeur());
  }
  return reponseApi(url, params, over);
}

/** Le projet de test : un plan d'axes, un reseau autorise (identifiant UUID, comme en production) et un jeu en quarantaine. */
export const JEU_RESEAU_PROJET = jeu({ id: JEU_RESEAU, version: 1, nomFichier: "circuits-synthetiques.geojson", nbObjets: 8 });
export const projetFicheReseau = () => projetFiche({ jeux: [JEU_AXES, JEU_RESEAU_PROJET, JEU_GAZ_CONTROLE] });

/** Ce que la carte a charge : l'objet 10 (circuit) et l'objet 20 (infrastructure), avec leur identifiant d'objet comme id de Feature. */
export const carteAvecObjets = () => [{
  jeuId: JEU_RESEAU, role: "RESEAU_TIERS", typeReseau: "TELECOM", concessionnaire: { id: "c1", nom: "Operateur synthetique A", typeReseau: "TELECOM" }, tronque: false, nonAutorise: false,
  features: [
    { type: "Feature", id: "10", geometry: { type: "LineString", coordinates: [[O, S], [O + 0.001, S]] }, properties: { objetId: "10", jeuId: JEU_RESEAU, nom: "Fibre FO-01", typeGeom: "LIGNE", longueurM: 60.01 } },
    { type: "Feature", id: "20", geometry: { type: "LineString", coordinates: [[O, S + 0.001], [O + 0.001, S + 0.001]] }, properties: { objetId: "20", jeuId: JEU_RESEAU, nom: "Gaine G-01", typeGeom: "LIGNE", longueurM: 120.5 } },
  ],
}];
