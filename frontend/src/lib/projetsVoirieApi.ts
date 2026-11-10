import type { Feature, FeatureCollection, Geometry } from "geojson";
import { api } from "./api";
import { downloadViaApi } from "./download";
import {
  lireBbox, versNombre,
  type Bbox, type ClassePrecision, type Confidentialite, type FormatJeu, type Largeurs, type NatureObjet, type RoleJeu, type StatutJeu, type StatutParametres, type TypeGeom, type TypeReseau,
  TYPES_RESEAU, ROLES_JEU, NIVEAUX_CONFIDENTIALITE, CLASSES_PRECISION, NATURES_OBJET, bboxVersChaine,
} from "./projetsVoirie";
import { estNiveau, type TerritoireResume } from "./projetsVoirieTerritoires";

/**
 * Client du module « Projets de voirie et reseaux ». SOURCE DES FORMES : docs/projets-voirie/CONTRAT.md, section 4 (API) et section 5 (analyse).
 * Prefixe : `/api/v2/projets-voirie` (l'instance `api` porte deja `/api`).
 *
 * Le serveur est la source : rien n'est fabrique ici. Une reponse est lue par des gardes qui rendent une forme sure ; une reponse
 * inattendue LEVE (`ProjetVoirieReponseInattendue`), elle n'est jamais rendue comme un vide ni comme un zero.
 *
 * AUCUN STOCKAGE LOCAL : ni `localStorage`, ni `sessionStorage`, ni IndexedDB, ni cache de service worker. Les geometries ne vivent que
 * dans la memoire de React Query, le temps de la page.
 *
 * Le contrat ne fixe pas la forme exacte de la liste des projets ni de la fiche (« liste ... avec compteurs de jeux », « fiche du projet,
 * jeux, parametres, emprise englobante ») : les lecteurs ci-dessous acceptent la forme a plat ET la forme imbriquee (`{ projet, jeux, bbox }`),
 * une liste nue ou `{ projets | items | data }`. Voir le rapport : ecart a confirmer avec le backend.
 */

const BASE = "/v2/projets-voirie";

export class ReponseInattendue extends Error {
  constructor(route: string) {
    super(`Réponse inattendue du serveur (${route}). Aucune valeur n'a été déduite : réessayez ou signalez l'incident.`);
    this.name = "ProjetVoirieReponseInattendue";
  }
}

// ---------------------------------------------------------------------------------------------------
// Types du contrat
// ---------------------------------------------------------------------------------------------------

export interface ConcessionnaireRef {
  id: string; nom: string; typeReseau: TypeReseau | null;
  /** Lot T1 : code du referentiel TYPE_RESEAU (la famille `typeReseau` en est derivee). */
  typeReseauCode?: string | null;
}
export interface Concessionnaire extends ConcessionnaireRef { contact: string | null }

export interface Avertissement { code: string; message: string; nb: number | null }

export interface JeuProjet {
  id: string;
  projetId: string | null;
  role: RoleJeu;
  concessionnaire: ConcessionnaireRef | null;
  typeReseau: TypeReseau | null;
  /** Lot T1 : code du referentiel TYPE_RESEAU porte par le jeu (une valeur desactivee reste affichee) ; nul pour un ancien jeu sans code. */
  typeReseauCode: string | null;
  /** Lot S1 : code de la methode d'acquisition (referentiel METHODE_ACQUISITION) ; nul = non renseignee. */
  methodeAcquisition: string | null;
  nomFichier: string;
  format: FormatJeu | null;
  sha256: string | null;
  nbObjets: number;
  longueurTotaleM: number | null;
  /** Longueur du trace fusionne (circuits superposes comptes une fois). Ancien nom du contrat : `longueurPhysiqueM`. */
  longueurTraceFusionneM: number | null;
  dateDonnees: string | null;
  origineFichier: string | null;
  classePrecision: ClassePrecision;
  precisionHorizontaleM: number | null;
  precisionVerticaleM: number | null;
  methode: string | null;
  dateConstat: string | null;
  natureObjet: NatureObjet;
  confidentialite: Confidentialite;
  statut: StatutJeu;
  /** Vrai tant que le jeu n'est pas AUTORISE (quarantaine, rejet) : marquage `nonAutorise` du serveur, ou deduit du statut. */
  nonAutorise: boolean;
  /** Justification de la derniere autorisation ou du dernier rejet, si le serveur la fournit. */
  justification: string | null;
  version: number;
  avertissements: Avertissement[];
  createdAt: string | null;
}

export interface ProjetResume {
  id: string;
  code: string;
  nom: string;
  commune: string | null;
  prefecture: string | null;
  largeurEmpriseM: number;
  largeurChausseeM: number;
  statutParametres: StatutParametres;
  /** Jeux autorises, a autoriser ou recus (hors remplaces, rejetes, retires). Null si le serveur ne donne aucun compteur. */
  nbJeux: number | null;
  /** Compteurs par statut de la liste (`jeux: { CONTROLE: 1, AUTORISE: 2 }`). */
  jeuxParStatut: Partial<Record<StatutJeu, number>>;
  createdAt: string | null;
  /** Lot T1 : territoire du projet (obligatoire pour un nouveau projet), avec ses ancetres sur la fiche ; nul pour un serveur plus ancien. */
  territoireId: string | null;
  territoire: (TerritoireResume & { ancetres: TerritoireResume[] }) | null;
  /** Lot T1 : categorie (referentiel CATEGORIE_PROJET), nulle si non renseignee. */
  categorieCode: string | null;
}

export interface ProjetFiche extends ProjetResume {
  description: string | null;
  jeux: JeuProjet[];
  /** Emprise englobante WGS84 des donnees, ou null pour un projet sans donnee. */
  bbox: Bbox | null;
}

export interface PageProjets { projets: ProjetResume[]; suivant: string | null }

export interface ResumeDepot {
  nbObjets: number;
  parTypeGeom: Partial<Record<TypeGeom, number>>;
  longueurTotaleM: number | null;
  longueurTraceFusionneM: number | null;
  bbox: Bbox | null;
  attributsDetectes: string[];
}

/** Controle de plausibilite du CRS (CONTRAT-IMPORT.md 5.2) : emprise du resultat contre la zone attendue. Tout hors zone n'est pas un statut : c'est l'erreur 422 HORS_GUINEE. */
export interface Plausibilite {
  zoneAttendue: { nom: string; bbox: Bbox } | null;
  empriseResultat: Bbox | null;
  nbElementsHorsZone: number;
  nbObjets: number;
  statut: "CONFORME" | "PARTIELLEMENT_HORS_ZONE" | null;
  confirmationRequise: boolean;
  confirmee: boolean;
}
/** Bloc `crs` : systeme source, cible, unites, methode, version de PROJ, justification et plausibilite. Les champs enrichis sont nuls pour un serveur plus ancien. */
export interface BlocCrs {
  source: string | null; cible: string | null; methode: string | null; justification: string | null;
  epsgSource: number | null; epsgCible: number | null; uniteSource: string | null; uniteCible: string | null;
  origine: "choisi_par_utilisateur" | "norme_du_format" | "declare_dans_le_fichier" | null; transformation: "ST_Transform" | "aucune" | null; versionProj: string | null;
  plausibilite: Plausibilite | null;
}
/** Remplacement d'un jeu : comparaison avec la version precedente. `modifies` : meme cle, contenu different (0 pour un serveur plus ancien). Aucune suppression n'est appliquee automatiquement. */
export interface Delta { ajoutes: number; modifies: number; retires: number; identiques: number }

/** Statut de la revue des suppressions d'un jeu qui remplace une version autorisee (CONTRAT-IMPORT.md 8). */
export interface BlocSuppressions { statut: "AUCUNE" | "A_REVOIR" | "ACCEPTEES" | "REFUSEES"; nb: number }
export interface ProblemeGeometrique { ordre: number; nom: string | null; typeGeom: string; code: string; message: string }
export interface ElementEcarte { element: number; nom: string | null; code: string; message: string }
export interface BlocValidationGeometrique { nbProblemes: number; problemes: ProblemeGeometrique[]; tronque: boolean; elementsEcartes: ElementEcarte[] }

/** Le jeu AUTORISE que ce depot remplacera quand il sera autorise (contrat v2, 4.2). */
export interface Remplace { jeuId: string; version: number }

export interface ReponseDepot {
  simulation: boolean; jeu: JeuProjet | null; resume: ResumeDepot; avertissements: Avertissement[]; crs: BlocCrs | null; delta: Delta | null; remplace: Remplace | null;
  suppressions: BlocSuppressions | null; validationGeometrique: BlocValidationGeometrique | null;
  /** Version du jeu, y compris en simulation (le jeu n'a alors pas d'identifiant : `jeu` est nul, la version est lue ici). */
  version: number | null;
}

export interface DonneesDepot {
  fichier: File;
  role: RoleJeu;
  concessionnaireId?: string;
  typeReseau?: TypeReseau;
  /** Lot T1 : code du referentiel TYPE_RESEAU (la famille en est derivee par le serveur ; envoye SEUL, sans `typeReseau`). */
  typeReseauCode?: string;
  /** Lot S1 : code de la methode d'acquisition (referentiel METHODE_ACQUISITION). */
  methodeAcquisition?: string;
  dateDonnees?: string;
  origineFichier?: string;
  classePrecision?: ClassePrecision;
  precisionHorizontaleM?: number;
  precisionVerticaleM?: number;
  methode?: string;
  dateConstat?: string;
  natureObjet?: NatureObjet;
  confidentialite: Confidentialite;
  /** Options d'import deja serialisees en texte (CONTRAT-IMPORT.md, section 3) : couche, CRS, colonnes CSV, mapping, empreinte attendue... Envoyees avant le fichier. */
  options?: Readonly<Record<string, string>>;
}

/** Proprietes d'un objet de la carte. Le contrat ne les detaille pas : `attributs` est le JSON d'origine du fichier, conserve tel quel. */
export interface ObjetCarte {
  jeuId: string;
  /** Identifiant de l'objet quand le serveur le fournit (`id` du Feature ou de ses proprietes). */
  id: string | null;
  nom: string | null;
  longueurM: number | null;
  typeGeom: string | null;
  attributs: Record<string, unknown>;
  nonAutorise: boolean;
  feature: Feature<Geometry>;
}

export interface CoucheCarte {
  jeuId: string;
  role: RoleJeu | null;
  concessionnaire: ConcessionnaireRef | null;
  typeReseau: TypeReseau | null;
  features: Feature<Geometry>[];
  tronque: boolean;
  nonAutorise: boolean;
}

/** Reponse de la carte : les couches, le plafond d'objets applique (5 000 sans emprise, 20 000 avec) et l'indication « tronque ». */
export interface ReponseCarte { couches: CoucheCarte[]; plafond: number | null; tronque: boolean }

export interface ParamsCarte { jeux: string[]; bbox: Bbox | null; zoom: number | null; inclureNonAutorises?: boolean }

/** Chaque ligne de resultat est « A VERIFIER » (cahier des charges v2) : statut du serveur et version de la regle de calcul. */
export interface Verification { statut: string; versionRegle: string | null }
export interface LigneParType { typeReseau: TypeReseau; longueurTraceFusionneM: number; nbObjets: number }
export interface LigneParConcessionnaire {
  concessionnaireId: string | null;
  nom: string;
  typeReseau: TypeReseau | null;
  longueurTraceFusionneM: number;
  longueurSommeM: number;
  nbObjets: number;
  jeuxIds: string[];
}
/** Objet de reseau touchant un axe. Le serveur donne `objetId`, la qualification et les croisements ; `jeuId` n'est pas toujours fourni. */
export interface ObjetAxe { jeuId: string | null; objetId: string | null; nom: string | null; qualification: string | null; chausseeM: number; empriseM: number; croisements: number | null }
export interface LigneParAxe {
  axe: string;
  longueurM: number;
  chausseeM: number;
  empriseM: number;
  croisements: number;
  concessionnaires: string[];
  objets: ObjetAxe[];
  verification: Verification;
}
export interface ConflitParConcessionnaire { concessionnaireId: string | null; nom: string; chausseeM: number; empriseM: number; croisements: number; verification: Verification; qualification: string | null; classePrecision: ClassePrecision | null }
export interface TotauxConflits { chausseeM: number; empriseM: number; croisements: number; axesTouches: number; objetsTouches: number; empriseHorsChausseeM: number | null; horsEmpriseM: number | null }

export interface Analyse {
  projet: { id: string; code: string; nom: string };
  parametres: { largeurEmpriseM: number; largeurChausseeM: number; statut: StatutParametres; projection: string | null };
  axes: { nb: number; longueurM: number };
  reseaux: { parType: LigneParType[]; parConcessionnaire: LigneParConcessionnaire[] };
  conflits: {
    total: TotauxConflits;
    parAxe: LigneParAxe[];
    parConcessionnaire: ConflitParConcessionnaire[];
    croisements: FeatureCollection | null;
    zones: { chaussee: Geometry | null; emprise: Geometry | null; hors: Geometry | null };
  };
  hypotheses: string[];
  limites: string[];
  /** Version de l'algorithme de calcul, si le serveur la fournit. */
  versionAlgorithme: string | null;
}

// ---------------------------------------------------------------------------------------------------
// Lecteurs (gardes)
// ---------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const estObjet = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const texte = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const entier = (v: unknown): number => { const n = versNombre(v); return n === null ? 0 : n; };
const typeReseau = (v: unknown): TypeReseau | null => (typeof v === "string" && (TYPES_RESEAU as readonly string[]).includes(v) ? (v as TypeReseau) : null);
const roleJeu = (v: unknown): RoleJeu | null => (typeof v === "string" && (ROLES_JEU as readonly string[]).includes(v) ? (v as RoleJeu) : null);
const statutParam = (v: unknown): StatutParametres => (v === "VALIDE" ? "VALIDE" : "THEORIQUE");
const tableau = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
function enumOu<T extends string>(v: unknown, admises: readonly T[], defaut: T): T {
  return typeof v === "string" && (admises as readonly string[]).includes(v) ? (v as T) : defaut;
}
function lireVerification(l: Obj, versionRacine: string | null = null): Verification {
  const regle = estObjet(l.regle) ? l.regle : {};
  return { statut: texte(l.statut) ?? "A_VERIFIER", versionRegle: texte(regle.version) ?? (typeof regle.version === "number" ? String(regle.version) : versionRacine) };
}

function lireConcessionnaireRef(v: unknown): ConcessionnaireRef | null {
  if (!estObjet(v)) return null;
  const id = texte(v.id);
  const nom = texte(v.nom);
  return id && nom ? { id, nom, typeReseau: typeReseau(v.typeReseau), typeReseauCode: texte(v.typeReseauCode) } : null;
}

function lireResumeTerritoire(v: unknown): TerritoireResume | null {
  if (!estObjet(v)) return null;
  const id = texte(v.id), code = texte(v.code), nom = texte(v.nom);
  return id && code && nom && estNiveau(v.niveau) ? { id, code, nom, niveau: v.niveau } : null;
}

export function lireAvertissements(v: unknown): Avertissement[] {
  return tableau(v).flatMap((a): Avertissement[] => {
    if (!estObjet(a)) return typeof a === "string" ? [{ code: "AVERTISSEMENT", message: a, nb: null }] : [];
    const message = texte(a.message);
    if (!message) return [];
    return [{ code: texte(a.code) ?? "AVERTISSEMENT", message, nb: versNombre(a.nb) }];
  });
}

export function lireJeu(v: unknown): JeuProjet | null {
  if (!estObjet(v)) return null;
  const id = texte(v.id);
  const role = roleJeu(v.role);
  if (!id || !role) return null;
  const conc = lireConcessionnaireRef(v.concessionnaire)
    ?? (texte(v.concessionnaireId) && texte(v.concessionnaireNom) ? { id: String(v.concessionnaireId), nom: String(v.concessionnaireNom), typeReseau: typeReseau(v.typeReseau) } : null);
  // Ancien contrat : « ACTIF » (sans quarantaine) = autorise.
  const brut = v.statut === "ACTIF" ? "AUTORISE" : v.statut;
  const statut: StatutJeu = brut === "RECU" || brut === "CONTROLE" || brut === "REJETE" || brut === "REMPLACE" || brut === "RETIRE" ? brut : "AUTORISE";
  return {
    id, role,
    projetId: texte(v.projetId),
    concessionnaire: conc,
    typeReseau: typeReseau(v.typeReseau),
    typeReseauCode: texte(v.typeReseauCode),
    methodeAcquisition: texte(v.methodeAcquisition),
    nomFichier: texte(v.nomFichier) ?? "Fichier sans nom",
    format: v.format === "KML" || v.format === "KMZ" || v.format === "GEOJSON" || v.format === "GPX" || v.format === "CSV" ? v.format : null,
    sha256: texte(v.sha256),
    nbObjets: entier(v.nbObjets),
    longueurTotaleM: versNombre(v.longueurTotaleM),
    longueurTraceFusionneM: versNombre(v.longueurTraceFusionneM) ?? versNombre(v.longueurPhysiqueM),
    dateDonnees: texte(v.dateDonnees),
    origineFichier: texte(v.origineFichier),
    classePrecision: enumOu(v.classePrecision, CLASSES_PRECISION, "INCONNUE"),
    precisionHorizontaleM: versNombre(v.precisionHorizontaleM) ?? versNombre(v.precisionDeclareeM),
    precisionVerticaleM: versNombre(v.precisionVerticaleM),
    methode: texte(v.methode),
    dateConstat: texte(v.dateConstat),
    natureObjet: enumOu(v.natureObjets ?? v.natureObjet, NATURES_OBJET, "INCONNUE"),
    confidentialite: enumOu(v.confidentialite === "RESTREINT" ? "RESTREINT_PROJET" : v.confidentialite, NIVEAUX_CONFIDENTIALITE, "RESTREINT_PROJET"),
    statut,
    nonAutorise: typeof v.nonAutorise === "boolean" ? v.nonAutorise : statut !== "AUTORISE",
    justification: (estObjet(v.decision) ? texte(v.decision.justification) : null) ?? texte(v.justificationDecision) ?? texte(v.justification),
    version: Math.max(1, entier(v.version)),
    avertissements: lireAvertissements(v.avertissements),
    createdAt: texte(v.createdAt),
  };
}

export function lireProjetResume(v: unknown): ProjetResume | null {
  if (!estObjet(v)) return null;
  const id = texte(v.id);
  const code = texte(v.code);
  const nom = texte(v.nom);
  if (!id || !code || !nom) return null;
  const compteurs = estObjet(v._count) ? versNombre(v._count.jeux) : null;
  const jeuxParStatut: Partial<Record<StatutJeu, number>> = {};
  if (estObjet(v.jeux)) for (const k of ["RECU", "CONTROLE", "AUTORISE", "REJETE", "REMPLACE", "RETIRE"] as const) { const n = versNombre(v.jeux[k]); if (n !== null) jeuxParStatut[k] = n; }
  const vivants = estObjet(v.jeux) ? (jeuxParStatut.AUTORISE ?? 0) + (jeuxParStatut.CONTROLE ?? 0) + (jeuxParStatut.RECU ?? 0) : null;
  return {
    id, code, nom,
    commune: texte(v.commune),
    prefecture: texte(v.prefecture),
    largeurEmpriseM: versNombre(v.largeurEmpriseM) ?? 15,
    largeurChausseeM: versNombre(v.largeurChausseeM) ?? 7,
    statutParametres: statutParam(v.statutParametres),
    nbJeux: vivants ?? versNombre(v.nbJeux) ?? versNombre(v.nbJeuxActifs) ?? compteurs,
    jeuxParStatut,
    createdAt: texte(v.createdAt),
    territoireId: texte(v.territoireId) ?? (estObjet(v.territoire) ? texte(v.territoire.id) : null),
    territoire: (() => {
      const t = lireResumeTerritoire(v.territoire);
      if (!t || !estObjet(v.territoire)) return null;
      const a = Array.isArray(v.territoire.ancetres) ? v.territoire.ancetres : [];
      return { ...t, ancetres: a.flatMap((x) => { const r = lireResumeTerritoire(x); return r ? [r] : []; }) };
    })(),
    categorieCode: texte(v.categorieCode),
  };
}

export function lireFicheProjet(data: unknown): ProjetFiche {
  const racine = estObjet(data) ? data : null;
  const interne = racine && estObjet(racine.projet) ? racine.projet : null;
  const param = estObjet(interne?.parametres) ? interne.parametres : estObjet(racine?.parametres) ? racine.parametres : {};
  const projet = interne
    ? { ...interne, ...param, jeux: undefined, statutParametres: param.statut ?? param.statutParametres ?? interne.statutParametres }
    : racine;
  const base = projet ? lireProjetResume(projet) : null;
  if (!racine || !base) throw new ReponseInattendue(`GET ${BASE}/:id`);
  const jeux = tableau(racine.jeux ?? (estObjet(racine.projet) ? racine.projet.jeux : undefined)).flatMap((j) => { const x = lireJeu(j); return x ? [x] : []; });
  return {
    ...base,
    description: texte(projet?.description),
    jeux,
    bbox: lireBbox(racine.bbox ?? (estObjet(racine.projet) ? racine.projet.bbox : undefined)),
    nbJeux: base.nbJeux ?? jeux.filter((j) => j.statut === "AUTORISE").length,
  };
}

export function lirePageProjets(data: unknown): PageProjets {
  const liste = Array.isArray(data) ? data
    : estObjet(data) ? (Array.isArray(data.projets) ? data.projets : Array.isArray(data.items) ? data.items : Array.isArray(data.data) ? data.data : null)
    : null;
  if (!liste) throw new ReponseInattendue(`GET ${BASE}`);
  const suivantBrut = estObjet(data) ? (data.suivant ?? data.curseurSuivant ?? data.nextCursor) : null;
  return {
    projets: liste.flatMap((p) => { const x = lireProjetResume(p); return x ? [x] : []; }),
    suivant: texte(suivantBrut),
  };
}

export function lireConcessionnaires(data: unknown): Concessionnaire[] {
  const liste = Array.isArray(data) ? data : estObjet(data) && Array.isArray(data.concessionnaires) ? data.concessionnaires : null;
  if (!liste) throw new ReponseInattendue(`GET ${BASE}/concessionnaires`);
  return liste.flatMap((c) => {
    const r = lireConcessionnaireRef(c);
    return r ? [{ ...r, contact: estObjet(c) ? texte(c.contact) : null }] : [];
  });
}

function lireResume(v: unknown): ResumeDepot {
  if (!estObjet(v)) throw new ReponseInattendue(`POST ${BASE}/:id/jeux`);
  const pt: Partial<Record<TypeGeom, number>> = {};
  if (estObjet(v.parTypeGeom)) for (const k of ["LIGNE", "POINT", "POLYGONE"] as const) { const n = versNombre(v.parTypeGeom[k]); if (n !== null) pt[k] = n; }
  return {
    nbObjets: entier(v.nbObjets),
    parTypeGeom: pt,
    longueurTotaleM: versNombre(v.longueurTotaleM),
    longueurTraceFusionneM: versNombre(v.longueurTraceFusionneM) ?? versNombre(v.longueurPhysiqueM),
    bbox: lireBbox(v.bbox),
    attributsDetectes: tableau(v.attributsDetectes).flatMap((a): string[] => (typeof a === "string" ? [a] : estObjet(a) && typeof a.nom === "string" ? [a.nom] : [])),
  };
}

export function lireReponseDepot(data: unknown): ReponseDepot {
  if (!estObjet(data) || !estObjet(data.resume)) throw new ReponseInattendue(`POST ${BASE}/:id/jeux`);
  const avertissements = lireAvertissements(data.avertissements);
  const crsBrut = estObjet(data.crs) ? data.crs : estObjet(data.resume.crs) ? data.resume.crs : null;
  const deltaBrut = estObjet(data.delta) ? data.delta : estObjet(data.resume.delta) ? data.resume.delta : null;
  return {
    simulation: data.simulation === true,
    remplace: estObjet(data.remplace) && texte(data.remplace.jeuId) ? { jeuId: String(data.remplace.jeuId), version: Math.max(1, entier(data.remplace.version)) } : null,
    jeu: lireJeu(data.jeu), resume: lireResume(data.resume), avertissements,
    crs: crsBrut ? lireBlocCrs(crsBrut) : null,
    delta: deltaBrut ? lireDelta(deltaBrut) : null,
    version: estObjet(data.jeu) && versNombre(data.jeu.version) !== null ? Math.max(1, entier(data.jeu.version)) : null,
    suppressions: lireSuppressions(data.suppressions ?? data.resume.suppressions),
    validationGeometrique: lireValidationGeometrique(data.validationGeometrique),
  };
}

export function lireDelta(d: Record<string, unknown>): Delta {
  return { ajoutes: entier(d.ajoutes), modifies: entier(d.modifies), retires: entier(d.retires), identiques: entier(d.identiques) };
}

const STATUTS_SUPPRESSIONS = ["AUCUNE", "A_REVOIR", "ACCEPTEES", "REFUSEES"] as const;
export function lireSuppressions(v: unknown): BlocSuppressions | null {
  if (!estObjet(v) || typeof v.statut !== "string" || !(STATUTS_SUPPRESSIONS as readonly string[]).includes(v.statut)) return null;
  return { statut: v.statut as BlocSuppressions["statut"], nb: entier(v.nb) };
}

export function lireValidationGeometrique(v: unknown): BlocValidationGeometrique | null {
  if (!estObjet(v)) return null;
  return {
    nbProblemes: entier(v.nbProblemes),
    tronque: v.tronque === true,
    problemes: tableau(v.problemes).flatMap((p): ProblemeGeometrique[] => estObjet(p) && texte(p.code)
      ? [{ ordre: entier(p.ordre), nom: texte(p.nom), typeGeom: texte(p.typeGeom) ?? "", code: String(p.code), message: texte(p.message) ?? String(p.code) }] : []),
    elementsEcartes: tableau(v.elementsEcartes).flatMap((p): ElementEcarte[] => estObjet(p) && texte(p.code)
      ? [{ element: entier(p.element), nom: texte(p.nom), code: String(p.code), message: texte(p.message) ?? String(p.code) }] : []),
  };
}

export function lireBlocCrs(b: Record<string, unknown>): BlocCrs {
  const p = estObjet(b.plausibilite) ? b.plausibilite : null;
  const z = p && estObjet(p.zoneAttendue) ? p.zoneAttendue : null;
  const zbbox = z ? lireBbox(z.bbox) : null;
  return {
    source: texte(b.source), cible: texte(b.cible), methode: texte(b.methode), justification: texte(b.justification),
    epsgSource: versNombre(b.epsgSource), epsgCible: versNombre(b.epsgCible), uniteSource: texte(b.uniteSource), uniteCible: texte(b.uniteCible),
    origine: b.origine === "choisi_par_utilisateur" || b.origine === "norme_du_format" || b.origine === "declare_dans_le_fichier" ? b.origine : null,
    transformation: b.transformation === "ST_Transform" || b.transformation === "aucune" ? b.transformation : null,
    versionProj: texte(b.versionProj),
    plausibilite: p ? {
      zoneAttendue: z && zbbox ? { nom: texte(z.nom) ?? "Zone attendue", bbox: zbbox } : null,
      empriseResultat: lireBbox(p.empriseResultat), nbElementsHorsZone: entier(p.nbElementsHorsZone), nbObjets: entier(p.nbObjets),
      statut: p.statut === "CONFORME" || p.statut === "PARTIELLEMENT_HORS_ZONE" ? p.statut : null,
      confirmationRequise: p.confirmationRequise === true, confirmee: p.confirmee === true,
    } : null,
  };
}

export function lireReponseCarte(data: unknown): ReponseCarte {
  const couches = lireCarte(data);
  const racine = estObjet(data) ? data : {};
  return { couches, plafond: versNombre(racine.plafond), tronque: racine.tronque === true || couches.some((c) => c.tronque) };
}

export function lireCarte(data: unknown): CoucheCarte[] {
  const liste = Array.isArray(data) ? data : estObjet(data) && Array.isArray(data.jeux) ? data.jeux : estObjet(data) && Array.isArray(data.couches) ? data.couches : null;
  if (!liste) throw new ReponseInattendue(`GET ${BASE}/:id/carte`);
  return liste.flatMap((c): CoucheCarte[] => {
    if (!estObjet(c)) return [];
    const jeuId = texte(c.jeuId);
    if (!jeuId) return [];
    const fc = estObjet(c.features) ? c.features.features : c.features;
    const features = tableau(fc).filter((f): f is Feature<Geometry> => estObjet(f) && f.type === "Feature" && estObjet(f.geometry));
    return [{
      jeuId, role: roleJeu(c.role),
      concessionnaire: lireConcessionnaireRef(c.concessionnaire),
      typeReseau: typeReseau(c.typeReseau),
      features, tronque: c.tronque === true, nonAutorise: c.nonAutorise === true,
    }];
  });
}

/**
 * Lit un Feature de la carte comme un objet de projet. Les proprietes peuvent porter les champs d'origine soit a plat, soit sous `attributs` :
 * on accepte les deux, et on ne montre JAMAIS de propriete technique (identifiant interne) comme attribut d'origine.
 */
export function lireObjetCarte(jeuId: string, f: Feature<Geometry>): ObjetCarte {
  const p = estObjet(f.properties) ? f.properties : {};
  const attrs = estObjet(p.attributs) ? p.attributs : (() => {
    const { id: _id, jeuId: _j, nom: _n, longueurM: _l, typeGeom: _t, nonAutorise: _na, ...reste } = p;
    return reste;
  })();
  return {
    jeuId,
    id: texte(f.id) ?? texte(p.objetId) ?? texte(p.id) ?? (typeof f.id === "number" ? String(f.id) : typeof p.id === "number" ? String(p.id) : null),
    nom: texte(p.nom) ?? texte(p.name) ?? null,
    longueurM: versNombre(p.longueurM),
    typeGeom: texte(p.typeGeom),
    attributs: attrs,
    nonAutorise: p.nonAutorise === true,
    feature: f,
  };
}

function lireLigneType(v: unknown): LigneParType[] {
  return tableau(v).flatMap((l) => {
    if (!estObjet(l)) return [];
    const t = typeReseau(l.typeReseau);
    return t ? [{ typeReseau: t, longueurTraceFusionneM: entier(l.longueurTraceFusionneM ?? l.longueurPhysiqueM), nbObjets: entier(l.nbObjets) }] : [];
  });
}

function lireGeometrie(v: unknown): Geometry | null {
  return estObjet(v) && typeof v.type === "string" && "coordinates" in v ? (v as unknown as Geometry) : null;
}

export function lireAnalyse(data: unknown): Analyse {
  if (!estObjet(data) || !estObjet(data.parametres) || !estObjet(data.reseaux) || !estObjet(data.conflits) || !estObjet(data.axes)) {
    throw new ReponseInattendue(`GET ${BASE}/:id/analyse`);
  }
  const c = data.conflits;
  const t = estObjet(c.total) ? c.total : {};
  const zones = estObjet(c.zones) ? c.zones : {};
  const projet = estObjet(data.projet) ? data.projet : {};
  const versionRegle = estObjet(data.regle) ? (texte(data.regle.version) ?? null) : null;
  const nomsDe = (v: unknown) => tableau(v).filter((x): x is string => typeof x === "string");
  return {
    projet: { id: texte(projet.id) ?? "", code: texte(projet.code) ?? "", nom: texte(projet.nom) ?? "" },
    parametres: {
      largeurEmpriseM: versNombre(data.parametres.largeurEmpriseM) ?? 0,
      largeurChausseeM: versNombre(data.parametres.largeurChausseeM) ?? 0,
      statut: statutParam(data.parametres.statut),
      projection: texte(data.parametres.projection),
    },
    axes: { nb: entier(data.axes.nb), longueurM: entier(data.axes.longueurM) },
    reseaux: {
      parType: lireLigneType(data.reseaux.parType),
      parConcessionnaire: tableau(data.reseaux.parConcessionnaire).flatMap((l): LigneParConcessionnaire[] => {
        if (!estObjet(l)) return [];
        return [{
          concessionnaireId: texte(l.concessionnaireId), nom: texte(l.nom) ?? "Concessionnaire sans nom", typeReseau: typeReseau(l.typeReseau),
          longueurTraceFusionneM: entier(l.longueurTraceFusionneM ?? l.longueurPhysiqueM), longueurSommeM: entier(l.longueurSommeM), nbObjets: entier(l.nbObjets), jeuxIds: nomsDe(l.jeuxIds),
        }];
      }),
    },
    conflits: {
      total: {
        chausseeM: entier(t.chausseeM), empriseM: entier(t.empriseM), croisements: entier(t.croisements),
        axesTouches: entier(t.axesTouches), objetsTouches: entier(t.objetsTouches),
        empriseHorsChausseeM: versNombre(t.empriseHorsChausseeM), horsEmpriseM: versNombre(t.horsEmpriseM),
      },
      parAxe: tableau(c.parAxe).flatMap((l): LigneParAxe[] => {
        if (!estObjet(l)) return [];
        return [{
          axe: texte(l.axe) ?? "Axe sans nom", longueurM: entier(l.longueurM), chausseeM: entier(l.chausseeM), empriseM: entier(l.empriseM),
          croisements: entier(l.croisements), concessionnaires: nomsDe(l.concessionnaires), verification: lireVerification(l, versionRegle),
          objets: tableau(l.objets).flatMap((o): ObjetAxe[] => estObjet(o) ? [{ jeuId: texte(o.jeuId), objetId: texte(o.objetId) ?? (typeof o.objetId === "number" ? String(o.objetId) : null), nom: texte(o.nom), qualification: texte(o.qualification), chausseeM: entier(o.chausseeM), empriseM: entier(o.empriseM), croisements: versNombre(o.croisements) }] : []),
        }];
      }),
      parConcessionnaire: tableau(c.parConcessionnaire).flatMap((l): ConflitParConcessionnaire[] => {
        if (!estObjet(l)) return [];
        return [{ concessionnaireId: texte(l.concessionnaireId), nom: texte(l.nom) ?? "Concessionnaire sans nom", chausseeM: entier(l.chausseeM), empriseM: entier(l.empriseM), croisements: entier(l.croisements), verification: lireVerification(l, versionRegle), qualification: texte(l.qualification), classePrecision: l.classePrecision === undefined || l.classePrecision === null ? null : enumOu(l.classePrecision, CLASSES_PRECISION, "INCONNUE") }];
      }),
      croisements: estObjet(c.croisements) && c.croisements.type === "FeatureCollection" && Array.isArray(c.croisements.features) ? (c.croisements as unknown as FeatureCollection) : null,
      zones: { chaussee: lireGeometrie(zones.chaussee), emprise: lireGeometrie(zones.emprise), hors: lireGeometrie(zones.hors) },
    },
    hypotheses: nomsDe(data.hypotheses),
    limites: nomsDe(data.limites),
    versionAlgorithme: texte(data.versionAlgorithme) ?? texte(data.parametres.versionAlgorithme),
  };
}

// ---------------------------------------------------------------------------------------------------
// Appels
// ---------------------------------------------------------------------------------------------------

const id = encodeURIComponent;

export async function listerProjets(p: { q?: string; curseur?: string | null; limite?: number; territoireId?: string | null } = {}): Promise<PageProjets> {
  const params: Record<string, string | number> = {};
  if (p.q?.trim()) params.q = p.q.trim();
  // Lot T1 : le territoire ET ses descendants (filtre du serveur).
  if (p.territoireId) params.territoireId = p.territoireId;
  if (p.curseur) params.curseur = p.curseur;
  if (p.limite) params.limite = p.limite;
  const { data } = await api.get(BASE, { params });
  return lirePageProjets(data);
}

export interface CorpsProjet {
  code: string; nom: string; commune?: string; prefecture?: string; description?: string; largeurEmpriseM?: number; largeurChausseeM?: number;
  /** Lot T1 : OBLIGATOIRE (400 TERRITOIRE_REQUIS sinon). */
  territoireId: string;
  /** Lot T1 : categorie ; sans largeurs envoyees, le serveur applique celles de la categorie. */
  categorieCode?: string;
}

export async function creerProjet(corps: CorpsProjet): Promise<ProjetFiche> {
  const { data } = await api.post(BASE, corps);
  return lireFicheProjet(data);
}

export async function lireProjet(projetId: string): Promise<ProjetFiche> {
  const { data } = await api.get(`${BASE}/${id(projetId)}`);
  return lireFicheProjet(data);
}

/** `statutParametres: "VALIDE"` n'est admis par le serveur que pour un ADMIN ; sans lui, toute modification des largeurs remet « theorique ». */
export async function modifierProjet(projetId: string, corps: Partial<Pick<CorpsProjet, "nom" | "description" | "territoireId">> & Partial<Largeurs> & { statutParametres?: "VALIDE"; categorieCode?: string | null }): Promise<ProjetFiche> {
  const { data } = await api.patch(`${BASE}/${id(projetId)}`, corps);
  return lireFicheProjet(data);
}

/** Retrait logique du projet (ADMIN). */
export async function retirerProjet(projetId: string): Promise<void> {
  await api.delete(`${BASE}/${id(projetId)}`);
}

export async function listerConcessionnaires(): Promise<Concessionnaire[]> {
  const { data } = await api.get(`${BASE}/concessionnaires`);
  return lireConcessionnaires(data);
}

/** Lot T1 : `typeReseauCode` (code du referentiel, la famille en est derivee) ou, a defaut, la famille `typeReseau`. */
export async function creerConcessionnaire(corps: { nom: string; typeReseau?: TypeReseau; typeReseauCode?: string; contact?: string }): Promise<Concessionnaire> {
  const { data } = await api.post(`${BASE}/concessionnaires`, corps);
  const r = lireConcessionnaireRef(data) ?? (estObjet(data) ? lireConcessionnaireRef(data.concessionnaire) : null);
  if (!r) throw new ReponseInattendue(`POST ${BASE}/concessionnaires`);
  return { ...r, contact: estObjet(data) ? texte(data.contact) : null };
}

export async function listerJeux(projetId: string): Promise<JeuProjet[]> {
  const { data } = await api.get(`${BASE}/${id(projetId)}/jeux`);
  const liste = Array.isArray(data) ? data : estObjet(data) && Array.isArray(data.jeux) ? data.jeux : null;
  if (!liste) throw new ReponseInattendue(`GET ${BASE}/:id/jeux`);
  return liste.flatMap((j) => { const x = lireJeu(j); return x ? [x] : []; });
}

/**
 * Depot d'un fichier. `simuler: true` : le serveur lit, valide et rend le resume SANS RIEN ECRIRE. Les champs viennent AVANT le fichier
 * (un serveur qui lit le flux voit les metadonnees avant les octets). Le fichier n'est lu par le navigateur que pour l'envoi.
 */
export async function deposerJeu(projetId: string, d: DonneesDepot, opts: { simuler: boolean; onProgression?: (envoye: number, total: number | null) => void; signal?: AbortSignal }): Promise<ReponseDepot> {
  const corps = new FormData();
  corps.append("role", d.role);
  if (d.concessionnaireId) corps.append("concessionnaireId", d.concessionnaireId);
  // Lot T1 : le code du referentiel prime ; la famille n'est envoyee qu'en son absence (les deux ensemble doivent concorder : 400 TYPE_RESEAU_INCOHERENT).
  if (d.typeReseauCode) corps.append("typeReseauCode", d.typeReseauCode);
  else if (d.typeReseau) corps.append("typeReseau", d.typeReseau);
  if (d.methodeAcquisition) corps.append("methodeAcquisition", d.methodeAcquisition);
  if (d.dateDonnees) corps.append("dateDonnees", d.dateDonnees);
  if (d.origineFichier) corps.append("origineFichier", d.origineFichier);
  // Classe inconnue = champ ABSENT (le serveur n'accepte que A a E et laisse la classe nulle sinon) : envoyer « INCONNUE »
  // faisait refuser tout depot par defaut (400 CHAMPS_INVALIDES, pilote local du 09/11/2026, defaut D1).
  if (d.classePrecision && d.classePrecision !== "INCONNUE") corps.append("classePrecision", d.classePrecision);
  if (typeof d.precisionHorizontaleM === "number") corps.append("precisionHorizontaleM", String(d.precisionHorizontaleM));
  if (typeof d.precisionVerticaleM === "number") corps.append("precisionVerticaleM", String(d.precisionVerticaleM));
  if (d.methode) corps.append("methode", d.methode);
  if (d.dateConstat) corps.append("dateConstat", d.dateConstat);
  if (d.natureObjet) corps.append("natureObjets", d.natureObjet);
  corps.append("confidentialite", d.confidentialite);
  for (const [k, v] of Object.entries(d.options ?? {})) corps.append(k, v);
  corps.append("fichier", d.fichier);
  const { data } = await api.post(`${BASE}/${id(projetId)}/jeux`, corps, {
    params: opts.simuler ? { simuler: "true" } : undefined,
    signal: opts.signal,
    onUploadProgress: (e) => opts.onProgression?.(e.loaded, typeof e.total === "number" && e.total > 0 ? e.total : null),
  });
  return lireReponseDepot(data);
}

/** Autorise un jeu CONTROLE (ADMIN, GESTIONNAIRE) : il alimente alors la carte et l'analyse. `justification` : 10 caracteres minimum, consignee. */
export async function autoriserJeu(projetId: string, jeuId: string, justification: string): Promise<JeuProjet | null> {
  const { data } = await api.post(`${BASE}/${id(projetId)}/jeux/${id(jeuId)}/autoriser`, { justification });
  return lireJeu(estObjet(data) && estObjet(data.jeu) ? data.jeu : data);
}

/** Rejette un jeu CONTROLE : il ne rejoindra jamais la carte ni l'analyse. Meme corps que l'autorisation. */
export async function rejeterJeu(projetId: string, jeuId: string, justification: string): Promise<JeuProjet | null> {
  const { data } = await api.post(`${BASE}/${id(projetId)}/jeux/${id(jeuId)}/rejeter`, { justification });
  return lireJeu(estObjet(data) && estObjet(data.jeu) ? data.jeu : data);
}

/** Retrait logique d'un jeu : il reste en base, il disparait de la carte et de l'analyse. */
export async function retirerJeu(projetId: string, jeuId: string): Promise<void> {
  await api.delete(`${BASE}/${id(projetId)}/jeux/${id(jeuId)}`);
}

/** Carte par emprise et zoom : `jeux`, `bbox` (ouest,sud,est,nord) et `zoom` en parametres de requete. */
export async function chargerCarte(projetId: string, p: ParamsCarte, signal?: AbortSignal): Promise<ReponseCarte> {
  const params: Record<string, string | number> = {};
  if (p.jeux.length > 0) params.jeux = p.jeux.join(",");
  if (p.bbox) params.bbox = bboxVersChaine(p.bbox);
  if (p.zoom !== null) params.zoom = Math.round(p.zoom);
  if (p.inclureNonAutorises) params.inclureNonAutorises = "true";
  const { data } = await api.get(`${BASE}/${id(projetId)}/carte`, { params, signal });
  return lireReponseCarte(data);
}

/** Analyse ; `largeurs` surcharge les parametres SANS les enregistrer (previsualisation). */
export async function chargerAnalyse(projetId: string, largeurs?: Largeurs | null, inclureNonAutorises = false, signal?: AbortSignal): Promise<Analyse> {
  const params: Record<string, string | number> = {};
  if (largeurs) { params.largeurEmpriseM = largeurs.largeurEmpriseM; params.largeurChausseeM = largeurs.largeurChausseeM; }
  if (inclureNonAutorises) params.inclureNonAutorises = "true";
  const { data } = await api.get(`${BASE}/${id(projetId)}/analyse`, { params, signal });
  return lireAnalyse(data);
}

/** Adresse de l'export CSV D'AGREGATS de l'analyse (jamais de geometrie), avec les memes largeurs que l'analyse affichee. */
export function urlExportCsv(projetId: string, largeurs?: Largeurs | null, inclureNonAutorises = false): string {
  const base = `${BASE}/${id(projetId)}/analyse/export.csv`;
  const q = new URLSearchParams();
  if (largeurs) { q.set("largeurEmpriseM", String(largeurs.largeurEmpriseM)); q.set("largeurChausseeM", String(largeurs.largeurChausseeM)); }
  if (inclureNonAutorises) q.set("inclureNonAutorises", "true");
  const qs = q.toString();
  return qs ? `${base}?${qs}` : base;
}

/** Export CSV par l'API authentifiee (un lien nu n'emporterait pas le jeton). L'export est audite par le serveur. */
export function exporterCsv(projetId: string, code: string, largeurs?: Largeurs | null, inclureNonAutorises = false): Promise<void> {
  const nom = `${code.replace(/[^\w.-]+/g, "_")}-conflits.csv`;
  return downloadViaApi(urlExportCsv(projetId, largeurs, inclureNonAutorises), nom);
}
