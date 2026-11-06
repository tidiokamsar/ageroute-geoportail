import type { Geometry } from "geojson";
import { api } from "./api";
import { downloadViaApi } from "./download";
import { ReponseInattendue } from "./projetsVoirieApi";
import {
  CLASSES_PRECISION, TYPES_RESEAU, lireBbox, versNombre,
  type Bbox, type ClassePrecision, type TypeReseau,
} from "./projetsVoirie";
import {
  MOTIFS_REEXAMEN, OPTIONS_DECISION, RISQUES_CONFLIT, STATUTS_ANALYSE_CONFLIT, STATUTS_CONFLIT, STATUTS_DECISION, STATUTS_REGLE, TYPES_CONFLIT, TYPES_PREUVE,
  exigencesTransition, paramsListeConflits, transitionsDeSecours,
  type FiltresConflits, type MotifReexamen, type OptionDecision, type RisqueConflit, type StatutAnalyseConflit, type StatutConflit, type StatutDecision, type StatutRegle, type TypeConflit, type TypePreuve,
} from "./projetsVoirieConflits";

/**
 * Client des dossiers de conflit (lot RC-3). SOURCES DES FORMES : docs/projets-voirie/CONTRAT-CONFLITS.md (sections 3 et 6) pour le modele et les
 * routes ; pour l'ENVELOPPE des reponses, le code du backend du lot (`api-v2/projets-voirie.conflits.routes.ts`, `projets-voirie/conflits/*.service.ts`,
 * commit 2a5e9cb de `feat/rc3-conflits`), relu le 06/11/2026. `API.md` du lot n'etait pas encore commite : a re-verifier contre lui.
 * Prefixe : `/api/v2/projets-voirie` (l'instance `api` porte deja `/api`).
 *
 * SEUL MODULE QUI CONNAIT LES FORMES DE REPONSE DU LOT. Les lecteurs sont STRICTS sur le sens : un conflit dont le statut ou le type est inconnu n'est
 * pas rendu (il est compte dans `ignores`, jamais masque en silence), une valeur absente reste `null` et n'est JAMAIS remplacee par zero ni par un defaut
 * qui changerait le sens (un cout absent n'est pas un cout nul, une precision absente n'est pas une classe).
 *
 * AUCUN STOCKAGE LOCAL : les geometries et les dossiers ne vivent que dans la memoire de React Query, le temps de la page.
 * Aucune route ne cree d'ordre, de deplacement ni de decision automatique ; aucune route n'exporte une geometrie.
 */

const BASE = "/v2/projets-voirie";
const id = encodeURIComponent;

// ---------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------

export interface Personne { id: string | null; nom: string | null }
export interface ConcessionnaireConflit { id: string; nom: string | null }
export interface MesureConflit { longueurChausseeM: number | null; longueurEmpriseM: number | null; distanceMinM: number | null; nbCroisements: number | null; longueurPieceM: number | null }
export interface TronconProche { code: string; nom: string | null }
export interface RefAnalyse { id: string; numero: number | null }

export interface ConflitResume {
  id: string;
  /** Empreinte stable (projet, axe, objet, type, cellule). */
  cle: string | null;
  type: TypeConflit;
  axe: string | null;
  concessionnaire: ConcessionnaireConflit | null;
  typeReseau: TypeReseau | null;
  jeuReseauId: string | null;
  /** Objet de reseau concerne (nul pour une couverture insuffisante). */
  objet: { id: string | null; nom: string | null } | null;
  mesure: MesureConflit;
  /** Geometrie du conflit : rendue par la FICHE seulement (jamais par la liste), et masquee quand le jeu n'est plus lisible par le compte. */
  geom: Geometry | null;
  /** Emprise `[ouest, sud, est, nord]` rendue par la liste ; nulle si la geometrie est masquee. */
  bbox: Bbox | null;
  /** Vrai quand le serveur masque la geometrie a ce compte (jeu de reseau retire ou non autorise). */
  geometrieMasquee: boolean;
  statut: StatutConflit;
  risque: RisqueConflit | null;
  responsable: Personne | null;
  echeance: string | null;
  /** Calcule par le serveur (echeance passee, dossier encore ouvert) ; `null` s'il ne le dit pas. */
  echeanceDepassee: boolean | null;
  actionProposee: string | null;
  classePrecision: ClassePrecision;
  /** Faux tant que profondeur et altitude manquent ; `null` si le serveur ne le dit pas (alors on ne l'affirme pas). */
  verticalEvalue: boolean | null;
  aReexaminer: boolean;
  motifReexamen: MotifReexamen | null;
  premiereAnalyse: RefAnalyse | null;
  derniereAnalyse: RefAnalyse | null;
  tronconsProches: TronconProche[];
  createdAt: string | null;
  updatedAt: string | null;
}

export type Compteurs = Partial<Record<StatutConflit, number>>;

export interface PageConflits { conflits: ConflitResume[]; suivant: string | null; compteurs: Compteurs | null; ignores: number }

export interface RegleApplicable {
  id: string | null; code: string | null; version: number | null; famille: TypeReseau | null; portee: string | null;
  toleranceProximiteM: number | null; margeIncertitude: number | null; versionAlgorithme: string | null;
}
export interface SourceJeu {
  jeuId: string | null; nomFichier: string | null; version: number | null; sha256: string | null; role: string | null; statut: string | null; concessionnaire: string | null;
  classePrecision: ClassePrecision | null; precisionHorizontaleM: number | null; dateDonnees: string | null;
}

export interface EntreeHistorique {
  id: string;
  /** Code de l'action ; une valeur inconnue du client est conservee telle quelle. */
  action: string;
  ancienStatut: StatutConflit | null;
  nouveauStatut: StatutConflit | null;
  justification: string | null;
  /** `null` : calcul du systeme (aucun acteur humain). */
  acteur: Personne | null;
  analyse: RefAnalyse | null;
  donnees: Record<string, unknown> | null;
  createdAt: string | null;
}

export interface Preuve { id: string; type: TypePreuve; texte: string; reference: string | null; auteur: Personne | null; createdAt: string | null }

export interface DecisionConflit {
  id: string;
  option: OptionDecision;
  justification: string | null;
  contraintes: string | null;
  /** Cout ESTIME et cout REEL : deux champs distincts, saisis par une personne, jamais calcules ; `null` = non renseigne (pas zero). */
  coutEstime: number | null;
  coutReel: number | null;
  deviseCout: string | null;
  dateDebutPrevue: string | null;
  dateFinPrevue: string | null;
  statut: StatutDecision;
  proposePar: Personne | null;
  approuvePar: Personne | null;
  approuveLe: string | null;
  motifDecision: string | null;
  derogationSeparation: string | null;
  createdAt: string | null;
}

/** Transition proposee par le serveur pour le compte et l'etat ; `bloquee` dit ce qui la refuserait MAINTENANT (preuve ou decision manquante). */
export interface TransitionPossible {
  vers: StatutConflit;
  preuveRequise: boolean;
  decisionRequise: boolean;
  cloture: boolean;
  bloquee: "PREUVE_REQUISE" | "DECISION_REQUISE" | null;
}

export interface ConflitFiche extends ConflitResume {
  regle: RegleApplicable | null;
  /** Largeurs utilisees par la derniere analyse. */
  largeurs: { empriseM: number | null; chausseeM: number | null } | null;
  sources: SourceJeu[];
  historique: EntreeHistorique[];
  preuves: Preuve[];
  decisions: DecisionConflit[];
  /** Transitions renvoyees par le serveur ; `null` si la reponse n'en porte pas (affichage de secours). */
  transitions: TransitionPossible[] | null;
}

export interface RegleAppliquee { regleId: string | null; code: string | null; version: number | null; famille: TypeReseau | null; portee: string | null; toleranceProximiteM: number | null; margeIncertitude: number | null }
export interface JeuAnalyse { jeuId: string | null; nomFichier: string | null; sha256: string | null; version: number | null; role: string | null; statut: string | null; classePrecision: ClassePrecision | null }
export interface ResumeAnalyseConflit {
  /** Conflits trouves par cette analyse (`totaux.conflitsTrouves`). */
  total: number | null;
  axes: number | null;
  jeuxReseau: number | null;
  axesNonCouverts: number | null;
  parType: Record<string, number>;
  parStatut: Record<string, number>;
  nouveaux: number | null;
  retrouves: number | null;
  identiques: number | null;
  modifies: number | null;
  /** Dossiers existants que cette analyse n'a PAS retrouves (jamais fermes ni supprimes). */
  disparus: number | null;
  reapparus: number | null;
  marquesAReexaminer: number | null;
  limites: string[];
}
export interface AnalyseConflit {
  id: string;
  numero: number | null;
  statut: StatutAnalyseConflit;
  largeurEmpriseM: number | null;
  largeurChausseeM: number | null;
  regles: RegleAppliquee[];
  jeux: JeuAnalyse[];
  versionAlgorithme: string | null;
  resume: ResumeAnalyseConflit;
  /** Cause d'un echec (`resume.erreur`). */
  erreur: { code: string | null; message: string | null } | null;
  declenchePar: Personne | null;
  dureeMs: number | null;
  createdAt: string | null;
}
export interface PageAnalyses { analyses: AnalyseConflit[]; suivant: string | null }

export interface ConflitComparaison { id: string; cle: string | null; type: TypeConflit; axe: string | null; statut: StatutConflit; aReexaminer: boolean }
export interface CategorieComparaison { nb: number; cles: string[]; conflits: ConflitComparaison[]; detailsTronques: boolean }
export interface ComparaisonAnalyses {
  /** Analyse de reference (`avec`) et analyse comparee : `apparus` = presents dans la comparee, absents de la reference. */
  reference: RefAnalyse | null;
  comparee: RefAnalyse | null;
  apparus: CategorieComparaison;
  disparus: CategorieComparaison;
  modifies: CategorieComparaison;
  identiques: CategorieComparaison;
}

export interface RegleConflit {
  id: string;
  projetId: string | null;
  portee: "PROJET" | "GENERALE" | null;
  famille: TypeReseau | null;
  code: string;
  version: number;
  toleranceProximiteM: number | null;
  margeIncertitude: number | null;
  statut: StatutRegle;
  justification: string | null;
  /** Vrai pour la regle par defaut du socle (creee par le systeme, sans auteur). */
  systeme: boolean;
  creePar: Personne | null;
  approuvePar: Personne | null;
  approuveLe: string | null;
  motifApprobation: string | null;
  derogationApprobation: string | null;
  createdAt: string | null;
}
/** Regle EFFECTIVE d'une famille aujourd'hui (la plus recente version approuvee, sinon la generale, sinon la regle par defaut). */
export interface RegleEffective { famille: TypeReseau; regleId: string | null; code: string | null; version: number | null; portee: string | null; toleranceProximiteM: number | null; margeIncertitude: number | null }
export interface ListeRegles { regles: RegleConflit[]; effectives: RegleEffective[]; ignores: number }

// ---------------------------------------------------------------------------------------------------
// Lecteurs (gardes)
// ---------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const estObjet = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const texte = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const tableau = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const nombreOuNull = (v: unknown): number | null => versNombre(v);
const identifiant = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : null);
function parmi<T extends string>(v: unknown, admises: readonly T[]): T | null {
  return typeof v === "string" && (admises as readonly string[]).includes(v) ? (v as T) : null;
}
const typeReseau = (v: unknown): TypeReseau | null => parmi(v, TYPES_RESEAU);
const chaines = (v: unknown): string[] => tableau(v).filter((x): x is string => typeof x === "string" && x.trim() !== "");

/** Une personne : `{ id, nomComplet }` (forme du serveur), `{ id, nom }`, ou un identifiant seul. */
export function lirePersonne(v: unknown, idPlat?: unknown, nomPlat?: unknown): Personne | null {
  if (estObjet(v)) {
    const pid = identifiant(v.id);
    const nom = texte(v.nomComplet) ?? texte(v.nom);
    return pid || nom ? { id: pid, nom } : null;
  }
  const pid = identifiant(typeof v === "string" ? v : idPlat);
  const nom = texte(nomPlat);
  return pid || nom ? { id: pid, nom } : null;
}

function lireRefAnalyse(v: unknown, idPlat?: unknown, numeroPlat?: unknown): RefAnalyse | null {
  if (estObjet(v)) { const i = identifiant(v.id); return i ? { id: i, numero: nombreOuNull(v.numero) } : null; }
  const i = identifiant(v ?? idPlat);
  return i ? { id: i, numero: nombreOuNull(numeroPlat) } : null;
}

function lireMesure(v: unknown): MesureConflit {
  const m = estObjet(v) ? v : {};
  return {
    longueurChausseeM: nombreOuNull(m.longueurChausseeM), longueurEmpriseM: nombreOuNull(m.longueurEmpriseM), distanceMinM: nombreOuNull(m.distanceMinM),
    nbCroisements: nombreOuNull(m.nbCroisements), longueurPieceM: nombreOuNull(m.longueurPieceM),
  };
}

/** Geometrie GeoJSON : acceptee nue ou dans un Feature. Une valeur qui n'en est pas une est ecartee (`null`), jamais interpretee. */
export function lireGeom(v: unknown): Geometry | null {
  if (estObjet(v) && v.type === "Feature") return lireGeom(v.geometry);
  if (estObjet(v) && typeof v.type === "string" && (("coordinates" in v && Array.isArray(v.coordinates)) || (v.type === "GeometryCollection" && Array.isArray(v.geometries)))) return v as unknown as Geometry;
  return null;
}

function lireTroncons(v: unknown): TronconProche[] {
  return tableau(v).flatMap((t): TronconProche[] => {
    if (typeof t === "string") return t.trim() ? [{ code: t, nom: null }] : [];
    if (!estObjet(t)) return [];
    const code = texte(t.code);
    return code ? [{ code, nom: texte(t.nom) }] : [];
  });
}

export function lireConflitResume(v: unknown): ConflitResume | null {
  if (!estObjet(v)) return null;
  const cid = identifiant(v.id);
  const statut = parmi(v.statut, STATUTS_CONFLIT);
  const type = parmi(v.type, TYPES_CONFLIT);
  if (!cid || !statut || !type) return null;
  const conc = estObjet(v.concessionnaire) ? v.concessionnaire : null;
  const concId = identifiant(conc?.id ?? v.concessionnaireId);
  const objet = estObjet(v.objet) ? { id: identifiant(v.objet.id), nom: texte(v.objet.nom) } : null;
  const classe = v.classePrecision === undefined || v.classePrecision === null ? "INCONNUE" : parmi(v.classePrecision, CLASSES_PRECISION) ?? "INCONNUE";
  return {
    id: cid,
    cle: texte(v.cle),
    type,
    axe: texte(v.axe),
    concessionnaire: concId ? { id: concId, nom: texte(conc?.nom) } : null,
    typeReseau: typeReseau(v.typeReseau),
    jeuReseauId: identifiant(v.jeuReseauId),
    objet: objet && (objet.id || objet.nom) ? objet : null,
    mesure: lireMesure(v.mesure),
    geom: lireGeom(v.geometrie ?? v.geom),
    bbox: lireBbox(v.bbox),
    geometrieMasquee: v.geometrieMasquee === true,
    statut,
    risque: parmi(v.risque, RISQUES_CONFLIT),
    responsable: lirePersonne(v.responsable, v.responsableId),
    echeance: texte(v.echeance),
    echeanceDepassee: typeof v.echeanceDepassee === "boolean" ? v.echeanceDepassee : null,
    actionProposee: texte(v.actionProposee),
    classePrecision: classe,
    verticalEvalue: typeof v.verticalEvalue === "boolean" ? v.verticalEvalue : null,
    aReexaminer: v.aReexaminer === true,
    motifReexamen: parmi(v.motifReexamen, MOTIFS_REEXAMEN),
    premiereAnalyse: lireRefAnalyse(v.premiereAnalyse, v.premiereAnalyseId),
    derniereAnalyse: lireRefAnalyse(v.derniereAnalyse, v.derniereAnalyseId),
    tronconsProches: lireTroncons(v.tronconsProches),
    createdAt: texte(v.createdAt),
    updatedAt: texte(v.updatedAt),
  };
}

export function lireCompteurs(v: unknown): Compteurs | null {
  if (!estObjet(v)) return null;
  const c: Compteurs = {};
  for (const s of STATUTS_CONFLIT) { const n = nombreOuNull(v[s]); if (n !== null) c[s] = n; }
  return Object.keys(c).length > 0 ? c : null;
}

export function lirePageConflits(data: unknown): PageConflits {
  const liste = Array.isArray(data) ? data : estObjet(data) && Array.isArray(data.conflits) ? data.conflits : null;
  if (!liste) throw new ReponseInattendue(`GET ${BASE}/:id/conflits`);
  const racine = estObjet(data) ? data : {};
  const conflits: ConflitResume[] = [];
  let ignores = 0;
  for (const x of liste) { const c = lireConflitResume(x); if (c) conflits.push(c); else ignores += 1; }
  return { conflits, ignores, suivant: texte(racine.curseurSuivant), compteurs: lireCompteurs(racine.compteurs) };
}

function lireRegleApplicable(v: unknown): RegleApplicable | null {
  if (!estObjet(v)) return null;
  const r: RegleApplicable = {
    id: identifiant(v.regleId ?? v.id), code: texte(v.code), version: nombreOuNull(v.version), famille: typeReseau(v.famille), portee: texte(v.portee),
    toleranceProximiteM: nombreOuNull(v.toleranceProximiteM), margeIncertitude: nombreOuNull(v.margeIncertitude), versionAlgorithme: texte(v.versionAlgorithme),
  };
  return r.id || r.code || r.version !== null ? r : null;
}

function lireSources(v: unknown): SourceJeu[] {
  return tableau(v).flatMap((j): SourceJeu[] => {
    if (!estObjet(j)) return [];
    const conc = estObjet(j.concessionnaire) ? texte(j.concessionnaire.nom) : texte(j.concessionnaire);
    const s: SourceJeu = {
      jeuId: identifiant(j.jeuId ?? j.id), nomFichier: texte(j.nomFichier), version: nombreOuNull(j.version), sha256: texte(j.sha256),
      role: texte(j.role), statut: texte(j.statut), concessionnaire: conc,
      classePrecision: j.classePrecision === undefined || j.classePrecision === null ? null : parmi(j.classePrecision, CLASSES_PRECISION),
      precisionHorizontaleM: nombreOuNull(j.precisionHorizontaleM), dateDonnees: texte(j.dateDonnees),
    };
    return s.jeuId || s.sha256 ? [s] : [];
  });
}

function lireHistorique(v: unknown): EntreeHistorique[] {
  return tableau(v).flatMap((h): EntreeHistorique[] => {
    if (!estObjet(h)) return [];
    const hid = identifiant(h.id);
    const action = texte(h.action);
    if (!hid || !action) return [];
    return [{
      id: hid, action,
      ancienStatut: parmi(h.ancienStatut, STATUTS_CONFLIT), nouveauStatut: parmi(h.nouveauStatut, STATUTS_CONFLIT),
      justification: texte(h.justification),
      acteur: lirePersonne(h.acteur, h.acteurId),
      analyse: lireRefAnalyse(undefined, h.analyseId, h.analyseNumero),
      donnees: estObjet(h.donnees) ? h.donnees : null,
      createdAt: texte(h.createdAt),
    }];
  }).sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}

function lirePreuves(v: unknown): Preuve[] {
  return tableau(v).flatMap((p): Preuve[] => {
    if (!estObjet(p)) return [];
    const pid = identifiant(p.id);
    const type = parmi(p.type, TYPES_PREUVE);
    const t = texte(p.texte);
    return pid && type && t ? [{ id: pid, type, texte: t, reference: texte(p.reference), auteur: lirePersonne(p.auteur, p.auteurId), createdAt: texte(p.createdAt) }] : [];
  }).sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}

export function lireDecision(d: unknown): DecisionConflit | null {
  if (!estObjet(d)) return null;
  const did = identifiant(d.id);
  const option = parmi(d.option, OPTIONS_DECISION);
  const statut = parmi(d.statut, STATUTS_DECISION);
  if (!did || !option || !statut) return null;
  return {
    id: did, option, statut,
    justification: texte(d.justification), contraintes: texte(d.contraintes),
    coutEstime: nombreOuNull(d.coutEstime), coutReel: nombreOuNull(d.coutReel), deviseCout: texte(d.deviseCout),
    dateDebutPrevue: texte(d.dateDebutPrevue), dateFinPrevue: texte(d.dateFinPrevue),
    proposePar: lirePersonne(d.proposePar, d.proposeParId), approuvePar: lirePersonne(d.approuvePar, d.approuveParId),
    approuveLe: texte(d.approuveLe), motifDecision: texte(d.motifDecision), derogationSeparation: texte(d.derogationSeparation),
    createdAt: texte(d.createdAt),
  };
}

function lireDecisions(v: unknown): DecisionConflit[] {
  return tableau(v).flatMap((d) => { const x = lireDecision(d); return x ? [x] : []; }).sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}

/** Transitions du serveur : `{ vers, preuveRequise, decisionRequise, cloture, bloquee }`, ou une chaine seule. `null` si le champ est absent. */
export function lireTransitions(v: unknown): TransitionPossible[] | null {
  if (!Array.isArray(v)) return null;
  return v.flatMap((t): TransitionPossible[] => {
    if (typeof t === "string") { const vers = parmi(t, STATUTS_CONFLIT); return vers ? [{ vers, preuveRequise: false, decisionRequise: false, cloture: false, bloquee: null }] : []; }
    if (!estObjet(t)) return [];
    const vers = parmi(t.vers, STATUTS_CONFLIT);
    return vers ? [{
      vers, preuveRequise: t.preuveRequise === true, decisionRequise: t.decisionRequise === true, cloture: t.cloture === true,
      bloquee: t.bloquee === "PREUVE_REQUISE" || t.bloquee === "DECISION_REQUISE" ? t.bloquee : null,
    }] : [];
  });
}

export function lireFicheConflit(data: unknown): ConflitFiche {
  const racine = estObjet(data) ? data : null;
  const interne = racine && estObjet(racine.conflit) ? racine.conflit : null;
  const base = lireConflitResume(interne);
  if (!racine || !interne || !base) throw new ReponseInattendue(`GET ${BASE}/:id/conflits/:cid`);
  const analyses = estObjet(racine.analyses) ? racine.analyses : {};
  const l = estObjet(racine.largeurs) ? racine.largeurs : null;
  return {
    ...base,
    premiereAnalyse: lireRefAnalyse(analyses.premiere) ?? base.premiereAnalyse,
    derniereAnalyse: lireRefAnalyse(analyses.derniere) ?? base.derniereAnalyse,
    tronconsProches: lireTroncons(racine.tronconsProches),
    regle: lireRegleApplicable(racine.regle),
    largeurs: l ? { empriseM: nombreOuNull(l.empriseM), chausseeM: nombreOuNull(l.chausseeM) } : null,
    sources: lireSources(racine.sources),
    historique: lireHistorique(racine.historique),
    preuves: lirePreuves(racine.preuves),
    decisions: lireDecisions(racine.decisions),
    transitions: lireTransitions(racine.transitionsPossibles),
  };
}

function lireNombresParCle(v: unknown): Record<string, number> {
  const sortie: Record<string, number> = {};
  if (estObjet(v)) for (const [k, x] of Object.entries(v)) { const n = nombreOuNull(x); if (n !== null) sortie[k] = n; }
  return sortie;
}

function lireResumeAnalyse(v: unknown, nbConflitsTrouves: unknown): ResumeAnalyseConflit {
  const r = estObjet(v) ? v : {};
  const t = estObjet(r.totaux) ? r.totaux : {};
  return {
    total: nombreOuNull(t.conflitsTrouves) ?? nombreOuNull(nbConflitsTrouves),
    axes: nombreOuNull(t.axes), jeuxReseau: nombreOuNull(t.jeuxReseau), axesNonCouverts: nombreOuNull(t.axesNonCouverts),
    parType: lireNombresParCle(r.parType), parStatut: lireNombresParCle(r.parStatut),
    nouveaux: nombreOuNull(r.nouveaux), retrouves: nombreOuNull(r.retrouves), identiques: nombreOuNull(r.identiques), modifies: nombreOuNull(r.modifies),
    disparus: nombreOuNull(r.disparus), reapparus: nombreOuNull(r.reapparus), marquesAReexaminer: nombreOuNull(r.marquesAReexaminer),
    limites: chaines(r.limites),
  };
}

export function lireAnalyseConflit(v: unknown): AnalyseConflit | null {
  const racine = estObjet(v) ? v : null;
  const a = racine && estObjet(racine.analyse) ? racine.analyse : racine;
  if (!racine || !a) return null;
  const aid = identifiant(a.id);
  const statut = parmi(a.statut, STATUTS_ANALYSE_CONFLIT);
  if (!aid || !statut) return null;
  const brutResume = a.resume ?? racine.resume;
  const err = estObjet(brutResume) && estObjet(brutResume.erreur) ? brutResume.erreur : null;
  return {
    id: aid, statut,
    numero: nombreOuNull(a.numero),
    largeurEmpriseM: nombreOuNull(a.largeurEmpriseM), largeurChausseeM: nombreOuNull(a.largeurChausseeM),
    regles: tableau(a.regles).flatMap((r): RegleAppliquee[] => estObjet(r) ? [{
      regleId: identifiant(r.regleId ?? r.id), code: texte(r.code), version: nombreOuNull(r.version), famille: typeReseau(r.famille), portee: texte(r.portee),
      toleranceProximiteM: nombreOuNull(r.toleranceProximiteM), margeIncertitude: nombreOuNull(r.margeIncertitude),
    }] : []),
    jeux: tableau(a.jeux).flatMap((j): JeuAnalyse[] => estObjet(j) ? [{
      jeuId: identifiant(j.jeuId ?? j.id), nomFichier: texte(j.nomFichier), sha256: texte(j.sha256), version: nombreOuNull(j.version), role: texte(j.role), statut: texte(j.statut),
      classePrecision: j.classePrecision === undefined || j.classePrecision === null ? null : parmi(j.classePrecision, CLASSES_PRECISION),
    }] : []),
    versionAlgorithme: texte(a.versionAlgorithme),
    resume: lireResumeAnalyse(brutResume, a.nbConflitsTrouves),
    erreur: err ? { code: texte(err.code), message: texte(err.message) } : null,
    declenchePar: lirePersonne(a.declenchePar, a.declencheParId),
    // `duree` est la duree du calcul en MILLISECONDES (backend : Math.round(performance.now() - debut)).
    dureeMs: nombreOuNull(a.duree),
    createdAt: texte(a.createdAt),
  };
}

export function lirePageAnalyses(data: unknown): PageAnalyses {
  const liste = Array.isArray(data) ? data : estObjet(data) && Array.isArray(data.analyses) ? data.analyses : null;
  if (!liste) throw new ReponseInattendue(`GET ${BASE}/:id/analyses`);
  return {
    analyses: liste.flatMap((x) => { const a = lireAnalyseConflit(x); return a ? [a] : []; }),
    suivant: estObjet(data) ? texte(data.curseurSuivant) : null,
  };
}

function lireCategorie(v: unknown): CategorieComparaison | null {
  if (Array.isArray(v)) { const c = v.filter((x): x is string => typeof x === "string"); return { nb: c.length, cles: c, conflits: [], detailsTronques: false }; }
  if (!estObjet(v)) return null;
  const cles = chaines(v.cles);
  const conflits = tableau(v.conflits).flatMap((x): ConflitComparaison[] => {
    if (!estObjet(x)) return [];
    const cid = identifiant(x.id);
    const type = parmi(x.type, TYPES_CONFLIT);
    const statut = parmi(x.statut, STATUTS_CONFLIT);
    return cid && type && statut ? [{ id: cid, cle: texte(x.cle), type, axe: texte(x.axe), statut, aReexaminer: x.aReexaminer === true }] : [];
  });
  return { nb: nombreOuNull(v.nb) ?? cles.length, cles, conflits, detailsTronques: v.detailsTronques === true };
}

export function lireComparaison(data: unknown): ComparaisonAnalyses {
  const d = estObjet(data) ? data : null;
  const cats = d ? (["apparus", "disparus", "modifies", "identiques"] as const).map((k) => lireCategorie(d[k])) : [];
  if (!d || cats.some((c) => c === null)) throw new ReponseInattendue(`GET ${BASE}/:id/analyses/:aid/comparaison`);
  const [apparus, disparus, modifies, identiques] = cats as CategorieComparaison[];
  return { reference: lireRefAnalyse(d.reference), comparee: lireRefAnalyse(d.comparee), apparus, disparus, modifies, identiques };
}

export function lireRegle(v: unknown): RegleConflit | null {
  const racine = estObjet(v) ? v : null;
  const r = racine && estObjet(racine.regle) ? racine.regle : racine;
  if (!r) return null;
  const rid = identifiant(r.id);
  const code = texte(r.code);
  const statut = parmi(r.statut, STATUTS_REGLE);
  if (!rid || !code || !statut) return null;
  return {
    id: rid, code, statut, projetId: identifiant(r.projetId), portee: r.portee === "PROJET" || r.portee === "GENERALE" ? r.portee : null,
    famille: typeReseau(r.famille), version: Math.max(0, nombreOuNull(r.version) ?? 0),
    toleranceProximiteM: nombreOuNull(r.toleranceProximiteM), margeIncertitude: nombreOuNull(r.margeIncertitude), justification: texte(r.justification),
    systeme: r.systeme === true, creePar: lirePersonne(r.creePar, r.creeParId), approuvePar: lirePersonne(r.approuvePar, r.approuveParId),
    approuveLe: texte(r.approuveLe), motifApprobation: texte(r.motifApprobation), derogationApprobation: texte(r.derogationApprobation), createdAt: texte(r.createdAt),
  };
}

export function lireListeRegles(data: unknown): ListeRegles {
  const liste = Array.isArray(data) ? data : estObjet(data) && Array.isArray(data.regles) ? data.regles : null;
  if (!liste) throw new ReponseInattendue(`GET ${BASE}/:id/regles`);
  const regles: RegleConflit[] = [];
  let ignores = 0;
  for (const x of liste) { const r = lireRegle(x); if (r) regles.push(r); else ignores += 1; }
  const effectives = estObjet(data) ? tableau(data.effectives).flatMap((e): RegleEffective[] => {
    if (!estObjet(e)) return [];
    const famille = typeReseau(e.famille);
    return famille ? [{
      famille, regleId: identifiant(e.regleId), code: texte(e.code), version: nombreOuNull(e.version), portee: texte(e.portee),
      toleranceProximiteM: nombreOuNull(e.toleranceProximiteM), margeIncertitude: nombreOuNull(e.margeIncertitude),
    }] : [];
  }) : [];
  return { regles, effectives, ignores };
}

/**
 * Transitions a afficher : celles du serveur si la reponse en porte (meme vides : un lecteur n'en a aucune), sinon la table de secours du contrat,
 * donnee a titre indicatif (le serveur refuse toute transition interdite).
 */
export function transitionsAffichees(f: Pick<ConflitFiche, "statut" | "transitions">, role: string | undefined): { liste: TransitionPossible[]; deSecours: boolean } {
  if (f.transitions) return { liste: f.transitions, deSecours: false };
  return {
    liste: transitionsDeSecours(f.statut, role).map((vers) => {
      const e = exigencesTransition(f.statut, vers);
      return { vers, preuveRequise: e.preuveRequise, decisionRequise: e.decisionApprouveeRequise, cloture: e.cloture, bloquee: null };
    }),
    deSecours: true,
  };
}

// ---------------------------------------------------------------------------------------------------
// Appels
// ---------------------------------------------------------------------------------------------------

export async function listerConflits(projetId: string, filtres: FiltresConflits, curseur: string | null, signal?: AbortSignal): Promise<PageConflits> {
  const { data } = await api.get(`${BASE}/${id(projetId)}/conflits`, { params: paramsListeConflits(filtres, curseur), signal });
  return lirePageConflits(data);
}

export async function lireConflit(projetId: string, conflitId: string, signal?: AbortSignal): Promise<ConflitFiche> {
  const { data } = await api.get(`${BASE}/${id(projetId)}/conflits/${id(conflitId)}`, { signal });
  return lireFicheConflit(data);
}

/** Attribution : seuls les champs fournis partent. `null` efface la valeur (responsable, echeance, risque, action). */
export interface CorpsAttribution { responsableId?: string | null; echeance?: string | null; risque?: RisqueConflit | null; actionProposee?: string | null }
export async function attribuerConflit(projetId: string, conflitId: string, corps: CorpsAttribution): Promise<void> {
  await api.patch(`${BASE}/${id(projetId)}/conflits/${id(conflitId)}`, corps);
}

/** Une personne a re-examine un dossier marque « a reexaminer » : le drapeau est acquitte, avec sa justification (10 caracteres au moins), dans l'historique. */
export async function acquitterReexamen(projetId: string, conflitId: string, justification: string): Promise<void> {
  await api.patch(`${BASE}/${id(projetId)}/conflits/${id(conflitId)}`, { aReexaminer: false, justification });
}

export interface CorpsStatut { vers: StatutConflit; justification: string; derogation?: string; recolementAValider?: boolean }
export async function changerStatutConflit(projetId: string, conflitId: string, corps: CorpsStatut): Promise<void> {
  await api.post(`${BASE}/${id(projetId)}/conflits/${id(conflitId)}/statut`, corps);
}

export interface CorpsPreuve { type: TypePreuve; texte: string; reference?: string }
export async function ajouterPreuve(projetId: string, conflitId: string, corps: CorpsPreuve): Promise<void> {
  await api.post(`${BASE}/${id(projetId)}/conflits/${id(conflitId)}/preuves`, corps);
}

export interface CorpsDecision {
  option: OptionDecision; justification: string; contraintes?: string;
  coutEstime?: number; deviseCout?: string; coutReel?: number; dateDebutPrevue?: string; dateFinPrevue?: string;
}
/** PROPOSE une decision : rien n'est execute, rien n'est ordonne. Elle devra etre approuvee par un humain. */
export async function proposerDecision(projetId: string, conflitId: string, corps: CorpsDecision): Promise<void> {
  await api.post(`${BASE}/${id(projetId)}/conflits/${id(conflitId)}/decisions`, corps);
}

export interface CorpsApprobation { motif: string; derogation?: string }
export async function approuverDecision(projetId: string, conflitId: string, decisionId: string, corps: CorpsApprobation): Promise<void> {
  await api.post(`${BASE}/${id(projetId)}/conflits/${id(conflitId)}/decisions/${id(decisionId)}/approuver`, corps);
}
export async function refuserDecision(projetId: string, conflitId: string, decisionId: string, corps: CorpsApprobation): Promise<void> {
  await api.post(`${BASE}/${id(projetId)}/conflits/${id(conflitId)}/decisions/${id(decisionId)}/refuser`, corps);
}

export interface ResultatLancement { analyse: AnalyseConflit | null }
/** Lance et persiste une analyse (ADMIN, GESTIONNAIRE). Corps vide : les entrees sont celles du projet (jeux autorises, largeurs, regles approuvees). */
export async function lancerAnalyseConflits(projetId: string): Promise<ResultatLancement> {
  const { data } = await api.post(`${BASE}/${id(projetId)}/analyses`, {});
  return { analyse: lireAnalyseConflit(data) };
}

export async function listerAnalyses(projetId: string, curseur: string | null, signal?: AbortSignal): Promise<PageAnalyses> {
  const { data } = await api.get(`${BASE}/${id(projetId)}/analyses`, { params: curseur ? { curseur } : undefined, signal });
  return lirePageAnalyses(data);
}

export async function lireDetailAnalyse(projetId: string, analyseId: string, signal?: AbortSignal): Promise<AnalyseConflit> {
  const { data } = await api.get(`${BASE}/${id(projetId)}/analyses/${id(analyseId)}`, { signal });
  const a = lireAnalyseConflit(data);
  if (!a) throw new ReponseInattendue(`GET ${BASE}/:id/analyses/:aid`);
  return a;
}

/** `analyseId` = l'analyse COMPAREE (la plus recente), `avecId` = la reference : apparus = presents dans `analyseId`, absents de `avecId` (backend, `comparerAnalyses`). */
export async function comparerAnalyses(projetId: string, analyseId: string, avecId: string, signal?: AbortSignal): Promise<ComparaisonAnalyses> {
  const { data } = await api.get(`${BASE}/${id(projetId)}/analyses/${id(analyseId)}/comparaison`, { params: { avec: avecId }, signal });
  return lireComparaison(data);
}

export async function listerRegles(projetId: string, signal?: AbortSignal): Promise<ListeRegles> {
  const { data } = await api.get(`${BASE}/${id(projetId)}/regles`, { signal });
  return lireListeRegles(data);
}

export interface CorpsRegle { famille?: TypeReseau; code: string; toleranceProximiteM: number; margeIncertitude: number; justification: string }
export async function creerRegle(projetId: string, corps: CorpsRegle): Promise<void> {
  await api.post(`${BASE}/${id(projetId)}/regles`, corps);
}

export async function approuverRegle(projetId: string, regleId: string, corps: { justification: string; derogation?: string }): Promise<void> {
  await api.post(`${BASE}/${id(projetId)}/regles/${id(regleId)}/approuver`, corps);
}

/** Export CSV des conflits : agregats, jamais de geometrie. ADMIN et GESTIONNAIRE (audite par le serveur). Accepte les memes filtres que la liste. */
export function urlExportConflits(projetId: string, filtres?: FiltresConflits): string {
  const base = `${BASE}/${id(projetId)}/conflits/export.csv`;
  const q = new URLSearchParams(filtres ? paramsListeConflits(filtres, null) : {}).toString();
  return q ? `${base}?${q}` : base;
}
export function exporterConflitsCsv(projetId: string, code: string, filtres?: FiltresConflits): Promise<void> {
  return downloadViaApi(urlExportConflits(projetId, filtres), `${code.replace(/[^\w.-]+/g, "_")}-dossiers-de-conflit.csv`);
}
