import type { Geometry } from "geojson";
import { api } from "./api";
import { downloadViaApi } from "./download";
import { ReponseInattendue } from "./projetsVoirieApi";
import {
  CLASSES_PRECISION, TYPES_RESEAU, versNombre,
  type ClassePrecision, type TypeReseau,
} from "./projetsVoirie";
import {
  MOTIFS_REEXAMEN, OPTIONS_DECISION, RISQUES_CONFLIT, STATUTS_ANALYSE_CONFLIT, STATUTS_CONFLIT, STATUTS_DECISION, STATUTS_REGLE, TYPES_CONFLIT, TYPES_PREUVE,
  paramsListeConflits, transitionsDeSecours,
  type FiltresConflits, type MotifReexamen, type OptionDecision, type RisqueConflit, type StatutAnalyseConflit, type StatutConflit, type StatutDecision, type StatutRegle, type TypeConflit, type TypePreuve,
} from "./projetsVoirieConflits";

/**
 * Client des dossiers de conflit (lot RC-3). SOURCE DES FORMES : docs/projets-voirie/CONTRAT-CONFLITS.md, sections 3 (modele) et 6 (API).
 * Prefixe : `/api/v2/projets-voirie` (l'instance `api` porte deja `/api`).
 *
 * SEUL MODULE QUI CONNAIT LES FORMES DE REPONSE DU LOT : le contrat nomme les routes et les champs du modele, pas l'enveloppe exacte des reponses.
 * Les lecteurs ci-dessous sont donc TOLERANTS (variantes de noms, objet ou identifiant a plat) et STRICTS sur le sens : un conflit dont le statut ou
 * le type est inconnu n'est pas rendu (il est compte dans `ignores`, jamais masque en silence), une valeur absente reste `null` et n'est JAMAIS
 * remplacee par zero ni par un defaut qui changerait le sens (un cout absent n'est pas un cout nul, une precision absente n'est pas une classe).
 * A re-synchroniser avec docs/projets-voirie/API.md du backend du lot quand il aura ete commite.
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
export interface MesureConflit { longueurChausseeM: number | null; longueurEmpriseM: number | null; distanceMinM: number | null; nbCroisements: number | null }
export interface TronconProche { code: string; nom: string | null }
export interface RefAnalyse { id: string; numero: number | null }

export interface ConflitResume {
  id: string;
  /** Empreinte stable (projet, axe, objet, type, cellule) : sert a la comparaison de deux analyses. */
  cle: string | null;
  type: TypeConflit;
  axe: string | null;
  concessionnaire: ConcessionnaireConflit | null;
  jeuReseauId: string | null;
  objetId: string | null;
  mesure: MesureConflit;
  /** Geometrie du conflit (troncon de reseau ou points de croisement), si le serveur la rend. Jamais stockee hors de la memoire de la page. */
  geom: Geometry | null;
  statut: StatutConflit;
  risque: RisqueConflit | null;
  responsable: Personne | null;
  echeance: string | null;
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

export interface RegleApplicable { id: string | null; code: string | null; version: number | null; famille: TypeReseau | null; toleranceProximiteM: number | null; margeIncertitude: number | null; statut: StatutRegle | null }
export interface SourceJeu { jeuId: string | null; nomFichier: string | null; version: number | null; sha256: string | null; role: string | null; statut: string | null; concessionnaire: string | null; classePrecision: ClassePrecision | null }

export interface EntreeHistorique {
  id: string;
  /** Code de l'action ; une valeur inconnue du client est conservee telle quelle. */
  action: string;
  ancienStatut: StatutConflit | null;
  nouveauStatut: StatutConflit | null;
  justification: string | null;
  /** `null` : calcul du systeme (aucun acteur humain). */
  acteur: Personne | null;
  analyseId: string | null;
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

/** Transition proposee par le serveur pour le compte et l'etat. */
export interface TransitionPossible { vers: StatutConflit; derogationPossible: boolean; exigences: string[] }

export interface ConflitFiche extends ConflitResume {
  regle: RegleApplicable | null;
  sources: SourceJeu[];
  historique: EntreeHistorique[];
  preuves: Preuve[];
  decisions: DecisionConflit[];
  /** Transitions renvoyees par le serveur ; `null` si la reponse n'en porte pas (affichage de secours). */
  transitions: TransitionPossible[] | null;
}

export interface RegleAppliquee { regleId: string | null; code: string | null; version: number | null; famille: TypeReseau | null }
export interface JeuAnalyse { jeuId: string | null; sha256: string | null; version: number | null; role: string | null; statut: string | null }
export interface ResumeAnalyseConflit {
  total: number | null;
  parType: Record<string, number>;
  parStatut: Record<string, number>;
  nouveaux: number | null;
  retrouves: number | null;
  disparus: number | null;
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
  declenchePar: Personne | null;
  dureeMs: number | null;
  createdAt: string | null;
}

export interface CategorieComparaison { nb: number; cles: string[] }
export interface ComparaisonAnalyses { apparus: CategorieComparaison; disparus: CategorieComparaison; modifies: CategorieComparaison; identiques: CategorieComparaison }

export interface RegleConflit {
  id: string;
  projetId: string | null;
  famille: TypeReseau | null;
  code: string;
  version: number;
  toleranceProximiteM: number | null;
  margeIncertitude: number | null;
  statut: StatutRegle;
  justification: string | null;
  creePar: Personne | null;
  approuvePar: Personne | null;
  approuveLe: string | null;
  createdAt: string | null;
}
export interface ListeRegles { regles: RegleConflit[]; ignores: number }

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

/** Une personne : `{ id, nomComplet | nom }`, un identifiant seul, ou `fooId` + `fooNom` a plat. */
export function lirePersonne(v: unknown, idPlat?: unknown, nomPlat?: unknown): Personne | null {
  if (estObjet(v)) {
    const pid = identifiant(v.id);
    const nom = texte(v.nomComplet) ?? texte(v.nom) ?? texte(v.name);
    return pid || nom ? { id: pid, nom } : null;
  }
  const pid = identifiant(typeof v === "string" ? v : idPlat);
  const nom = texte(nomPlat);
  return pid || nom ? { id: pid, nom } : null;
}

function lireRefAnalyse(v: unknown, idPlat: unknown, numeroPlat: unknown): RefAnalyse | null {
  if (estObjet(v)) { const i = identifiant(v.id); return i ? { id: i, numero: nombreOuNull(v.numero) } : null; }
  const i = identifiant(v ?? idPlat);
  return i ? { id: i, numero: nombreOuNull(numeroPlat) } : null;
}

function lireMesure(v: unknown): MesureConflit {
  const m = estObjet(v) ? v : {};
  return { longueurChausseeM: nombreOuNull(m.longueurChausseeM), longueurEmpriseM: nombreOuNull(m.longueurEmpriseM), distanceMinM: nombreOuNull(m.distanceMinM), nbCroisements: nombreOuNull(m.nbCroisements) };
}

/** Geometrie GeoJSON : acceptee nue ou dans un Feature. Une valeur qui n'en est pas une est ecartee (`null`), jamais interpretee. */
export function lireGeom(v: unknown): Geometry | null {
  if (estObjet(v) && v.type === "Feature") return lireGeom(v.geometry);
  if (estObjet(v) && typeof v.type === "string" && (("coordinates" in v && Array.isArray(v.coordinates)) || (v.type === "GeometryCollection" && Array.isArray(v.geometries)))) return v as unknown as Geometry;
  return null;
}

export function lireConflitResume(v: unknown): ConflitResume | null {
  if (!estObjet(v)) return null;
  const cid = identifiant(v.id);
  const statut = parmi(v.statut, STATUTS_CONFLIT);
  const type = parmi(v.type, TYPES_CONFLIT);
  if (!cid || !statut || !type) return null;
  const conc = estObjet(v.concessionnaire) ? v.concessionnaire : null;
  const concId = identifiant(conc?.id ?? v.concessionnaireId);
  const classe = v.classePrecision === undefined || v.classePrecision === null ? "INCONNUE" : parmi(v.classePrecision, CLASSES_PRECISION) ?? "INCONNUE";
  return {
    id: cid,
    cle: texte(v.cle),
    type,
    axe: texte(v.axe) ?? (estObjet(v.axe) ? texte(v.axe.nom) : null),
    concessionnaire: concId ? { id: concId, nom: texte(conc?.nom) ?? texte(v.concessionnaireNom) } : null,
    jeuReseauId: identifiant(v.jeuReseauId),
    objetId: identifiant(v.objetId),
    mesure: lireMesure(v.mesure),
    geom: lireGeom(v.geom ?? v.geometrie),
    statut,
    risque: parmi(v.risque, RISQUES_CONFLIT),
    responsable: lirePersonne(v.responsable, v.responsableId, v.responsableNom),
    echeance: texte(v.echeance),
    actionProposee: texte(v.actionProposee),
    classePrecision: classe,
    verticalEvalue: typeof v.verticalEvalue === "boolean" ? v.verticalEvalue : null,
    aReexaminer: v.aReexaminer === true,
    motifReexamen: parmi(v.motifReexamen, MOTIFS_REEXAMEN),
    premiereAnalyse: lireRefAnalyse(v.premiereAnalyse, v.premiereAnalyseId, v.premiereAnalyseNumero),
    derniereAnalyse: lireRefAnalyse(v.derniereAnalyse, v.derniereAnalyseId, v.derniereAnalyseNumero),
    tronconsProches: tableau(v.tronconsProches).flatMap((t): TronconProche[] => {
      if (typeof t === "string") return t.trim() ? [{ code: t, nom: null }] : [];
      if (!estObjet(t)) return [];
      const code = texte(t.code) ?? texte(t.codeTroncon);
      return code ? [{ code, nom: texte(t.nom) ?? texte(t.nomTroncon) }] : [];
    }),
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
  const liste = Array.isArray(data) ? data
    : estObjet(data) ? (Array.isArray(data.conflits) ? data.conflits : Array.isArray(data.items) ? data.items : Array.isArray(data.data) ? data.data : null)
    : null;
  if (!liste) throw new ReponseInattendue(`GET ${BASE}/:id/conflits`);
  const racine = estObjet(data) ? data : {};
  const conflits: ConflitResume[] = [];
  let ignores = 0;
  for (const x of liste) { const c = lireConflitResume(x); if (c) conflits.push(c); else ignores += 1; }
  return {
    conflits, ignores,
    suivant: texte(racine.curseurSuivant ?? racine.suivant ?? racine.nextCursor),
    compteurs: lireCompteurs(racine.compteurs ?? racine.compteursParStatut ?? racine.parStatut),
  };
}

function lireRegleApplicable(v: unknown): RegleApplicable | null {
  if (!estObjet(v)) return null;
  const r: RegleApplicable = {
    id: identifiant(v.id ?? v.regleId), code: texte(v.code), version: nombreOuNull(v.version), famille: typeReseau(v.famille),
    toleranceProximiteM: nombreOuNull(v.toleranceProximiteM), margeIncertitude: nombreOuNull(v.margeIncertitude), statut: parmi(v.statut, STATUTS_REGLE),
  };
  return r.id || r.code || r.version !== null ? r : null;
}

function lireSources(v: unknown): SourceJeu[] {
  return tableau(v).flatMap((j): SourceJeu[] => {
    if (!estObjet(j)) return [];
    const conc = estObjet(j.concessionnaire) ? texte(j.concessionnaire.nom) : texte(j.concessionnaire) ?? texte(j.concessionnaireNom);
    const s: SourceJeu = {
      jeuId: identifiant(j.jeuId ?? j.id), nomFichier: texte(j.nomFichier), version: nombreOuNull(j.version), sha256: texte(j.sha256),
      role: texte(j.role), statut: texte(j.statut), concessionnaire: conc,
      classePrecision: j.classePrecision === undefined || j.classePrecision === null ? null : parmi(j.classePrecision, CLASSES_PRECISION),
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
      acteur: lirePersonne(h.acteur, h.acteurId, h.acteurNom),
      analyseId: identifiant(h.analyseId),
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
    return pid && type && t ? [{ id: pid, type, texte: t, reference: texte(p.reference), auteur: lirePersonne(p.auteur, p.auteurId, p.auteurNom), createdAt: texte(p.createdAt) }] : [];
  }).sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}

function lireDecisions(v: unknown): DecisionConflit[] {
  return tableau(v).flatMap((d): DecisionConflit[] => {
    if (!estObjet(d)) return [];
    const did = identifiant(d.id);
    const option = parmi(d.option, OPTIONS_DECISION);
    const statut = parmi(d.statut, STATUTS_DECISION);
    if (!did || !option || !statut) return [];
    return [{
      id: did, option, statut,
      justification: texte(d.justification), contraintes: texte(d.contraintes),
      coutEstime: nombreOuNull(d.coutEstime), coutReel: nombreOuNull(d.coutReel), deviseCout: texte(d.deviseCout),
      dateDebutPrevue: texte(d.dateDebutPrevue), dateFinPrevue: texte(d.dateFinPrevue),
      proposePar: lirePersonne(d.proposePar, d.proposeParId, d.proposeParNom),
      approuvePar: lirePersonne(d.approuvePar, d.approuveParId, d.approuveParNom),
      approuveLe: texte(d.approuveLe), motifDecision: texte(d.motifDecision), derogationSeparation: texte(d.derogationSeparation),
      createdAt: texte(d.createdAt),
    }];
  }).sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}

/** Transitions du serveur : chaines (`"POTENTIEL"`) ou objets (`{ vers, derogationPossible, exigences }`). `null` si le champ est absent. */
export function lireTransitions(v: unknown): TransitionPossible[] | null {
  if (!Array.isArray(v)) return null;
  return v.flatMap((t): TransitionPossible[] => {
    if (typeof t === "string") { const vers = parmi(t, STATUTS_CONFLIT); return vers ? [{ vers, derogationPossible: false, exigences: [] }] : []; }
    if (!estObjet(t)) return [];
    const vers = parmi(t.vers ?? t.statut ?? t.a, STATUTS_CONFLIT);
    return vers ? [{ vers, derogationPossible: t.derogationPossible === true || t.derogation === true, exigences: tableau(t.exigences).filter((x): x is string => typeof x === "string") }] : [];
  });
}

export function lireFicheConflit(data: unknown): ConflitFiche {
  const racine = estObjet(data) ? data : null;
  const interne = racine && estObjet(racine.conflit) ? racine.conflit : racine;
  const base = lireConflitResume(interne);
  if (!racine || !interne || !base) throw new ReponseInattendue(`GET ${BASE}/:id/conflits/:cid`);
  const dans = (cle: string): unknown => racine[cle] ?? interne[cle];
  return {
    ...base,
    regle: lireRegleApplicable(dans("regle") ?? dans("regleAppliquee")),
    sources: lireSources(dans("sources") ?? dans("jeux")),
    historique: lireHistorique(dans("historique")),
    preuves: lirePreuves(dans("preuves")),
    decisions: lireDecisions(dans("decisions")),
    transitions: lireTransitions(dans("transitionsPossibles") ?? dans("transitions")),
  };
}

function lireNombresParCle(v: unknown): Record<string, number> {
  const sortie: Record<string, number> = {};
  if (estObjet(v)) for (const [k, x] of Object.entries(v)) { const n = nombreOuNull(x); if (n !== null) sortie[k] = n; }
  return sortie;
}

function lireResumeAnalyse(v: unknown): ResumeAnalyseConflit {
  const r = estObjet(v) ? v : {};
  const totaux = estObjet(r.totaux) ? r.totaux : estObjet(r.total) ? r.total : {};
  return {
    total: nombreOuNull(typeof r.total === "number" || typeof r.total === "string" ? r.total : totaux.conflits ?? totaux.total ?? r.nbConflits ?? r.totalConflits),
    parType: lireNombresParCle(r.parType ?? r.conflitsParType),
    parStatut: lireNombresParCle(r.parStatut ?? r.conflitsParStatut),
    nouveaux: nombreOuNull(r.nouveaux ?? r.nbNouveaux),
    retrouves: nombreOuNull(r.retrouves ?? r.nbRetrouves),
    disparus: nombreOuNull(r.disparus ?? r.nbDisparus ?? r.nonRetrouves),
  };
}

export function lireAnalyseConflit(v: unknown): AnalyseConflit | null {
  const racine = estObjet(v) ? v : null;
  const a = racine && estObjet(racine.analyse) ? racine.analyse : racine;
  if (!racine || !a) return null;
  const aid = identifiant(a.id);
  if (!aid) return null;
  const statut = parmi(a.statut, STATUTS_ANALYSE_CONFLIT);
  if (!statut) return null;
  return {
    id: aid, statut,
    numero: nombreOuNull(a.numero),
    largeurEmpriseM: nombreOuNull(a.largeurEmpriseM), largeurChausseeM: nombreOuNull(a.largeurChausseeM),
    regles: tableau(a.regles).flatMap((r): RegleAppliquee[] => estObjet(r) ? [{ regleId: identifiant(r.regleId ?? r.id), code: texte(r.code), version: nombreOuNull(r.version), famille: typeReseau(r.famille) }] : []),
    jeux: tableau(a.jeux).flatMap((j): JeuAnalyse[] => estObjet(j) ? [{ jeuId: identifiant(j.jeuId ?? j.id), sha256: texte(j.sha256), version: nombreOuNull(j.version), role: texte(j.role), statut: texte(j.statut) }] : []),
    versionAlgorithme: texte(a.versionAlgorithme),
    resume: lireResumeAnalyse(a.resume ?? racine.resume),
    declenchePar: lirePersonne(a.declenchePar, a.declencheParId, a.declencheParNom),
    dureeMs: nombreOuNull(a.dureeMs),
    createdAt: texte(a.createdAt),
  };
}

export function lireListeAnalyses(data: unknown): AnalyseConflit[] {
  const liste = Array.isArray(data) ? data : estObjet(data) && Array.isArray(data.analyses) ? data.analyses : estObjet(data) && Array.isArray(data.items) ? data.items : null;
  if (!liste) throw new ReponseInattendue(`GET ${BASE}/:id/analyses`);
  return liste.flatMap((x) => { const a = lireAnalyseConflit(x); return a ? [a] : []; });
}

/** Une categorie de comparaison : un nombre, une liste de cles, ou `{ nb, cles }`. */
function lireCategorie(v: unknown, clesPlates: unknown): CategorieComparaison {
  const cles = (l: unknown) => tableau(l).flatMap((c): string[] => (typeof c === "string" ? [c] : estObjet(c) && typeof c.cle === "string" ? [c.cle] : []));
  if (typeof v === "number" || typeof v === "string") { const n = nombreOuNull(v) ?? 0; const c = cles(clesPlates); return { nb: Math.max(n, c.length), cles: c }; }
  if (Array.isArray(v)) { const c = cles(v); return { nb: c.length, cles: c }; }
  if (estObjet(v)) {
    const c = cles(v.cles ?? v.liste ?? v.items ?? clesPlates);
    return { nb: nombreOuNull(v.nb ?? v.total ?? v.compte ?? v.count) ?? c.length, cles: c };
  }
  const c = cles(clesPlates);
  return { nb: c.length, cles: c };
}

export function lireComparaison(data: unknown): ComparaisonAnalyses {
  const d = estObjet(data) ? (estObjet(data.comparaison) ? data.comparaison : data) : null;
  if (!d || !(["apparus", "disparus", "modifies", "identiques"] as const).every((k) => k in d || `nb${k[0].toUpperCase()}${k.slice(1)}` in d)) throw new ReponseInattendue(`GET ${BASE}/:id/analyses/:aid/comparaison`);
  return {
    apparus: lireCategorie(d.apparus ?? d.nbApparus, d.clesApparus),
    disparus: lireCategorie(d.disparus ?? d.nbDisparus, d.clesDisparus),
    modifies: lireCategorie(d.modifies ?? d.nbModifies, d.clesModifies),
    identiques: lireCategorie(d.identiques ?? d.nbIdentiques, d.clesIdentiques),
  };
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
    id: rid, code, statut, projetId: identifiant(r.projetId), famille: typeReseau(r.famille), version: Math.max(0, nombreOuNull(r.version) ?? 0),
    toleranceProximiteM: nombreOuNull(r.toleranceProximiteM), margeIncertitude: nombreOuNull(r.margeIncertitude), justification: texte(r.justification),
    creePar: lirePersonne(r.creePar, r.creeParId, r.creeParNom), approuvePar: lirePersonne(r.approuvePar, r.approuveParId, r.approuveParNom),
    approuveLe: texte(r.approuveLe), createdAt: texte(r.createdAt),
  };
}

export function lireListeRegles(data: unknown): ListeRegles {
  const liste = Array.isArray(data) ? data : estObjet(data) && Array.isArray(data.regles) ? data.regles : estObjet(data) && Array.isArray(data.items) ? data.items : null;
  if (!liste) throw new ReponseInattendue(`GET ${BASE}/:id/regles`);
  const regles: RegleConflit[] = [];
  let ignores = 0;
  for (const x of liste) { const r = lireRegle(x); if (r) regles.push(r); else ignores += 1; }
  return { regles, ignores };
}

/** Transitions a afficher : celles du serveur si la reponse en porte (meme vides : un lecteur n'en a aucune), sinon la table de secours. */
export function transitionsAffichees(f: Pick<ConflitFiche, "statut" | "transitions">, role: string | undefined): { liste: TransitionPossible[]; deSecours: boolean } {
  if (f.transitions) return { liste: f.transitions, deSecours: false };
  return { liste: transitionsDeSecours(f.statut, role).map((vers) => ({ vers, derogationPossible: false, exigences: [] })), deSecours: true };
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

/** Attribution : seuls les champs fournis partent. `null` efface la valeur (responsable, echeance, action) ; le contrat n'a pas de champ « inchange » explicite. */
export interface CorpsAttribution { responsableId?: string | null; echeance?: string | null; risque?: RisqueConflit; actionProposee?: string | null }
export async function attribuerConflit(projetId: string, conflitId: string, corps: CorpsAttribution): Promise<void> {
  await api.patch(`${BASE}/${id(projetId)}/conflits/${id(conflitId)}`, corps);
}

export interface CorpsStatut { vers: StatutConflit; justification: string; derogation?: string }
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

export async function listerAnalyses(projetId: string, signal?: AbortSignal): Promise<AnalyseConflit[]> {
  const { data } = await api.get(`${BASE}/${id(projetId)}/analyses`, { signal });
  return lireListeAnalyses(data);
}

export async function lireDetailAnalyse(projetId: string, analyseId: string, signal?: AbortSignal): Promise<AnalyseConflit> {
  const { data } = await api.get(`${BASE}/${id(projetId)}/analyses/${id(analyseId)}`, { signal });
  const a = lireAnalyseConflit(data);
  if (!a) throw new ReponseInattendue(`GET ${BASE}/:id/analyses/:aid`);
  return a;
}

/** `analyseId` = l'analyse la plus recente, `avecId` = la reference : apparus = presents dans `analyseId`, absents de `avecId` (a confirmer avec le backend). */
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

/** Export CSV des conflits : agregats, jamais de geometrie. ADMIN et GESTIONNAIRE (audite par le serveur). */
export function urlExportConflits(projetId: string): string {
  return `${BASE}/${id(projetId)}/conflits/export.csv`;
}
export function exporterConflitsCsv(projetId: string, code: string): Promise<void> {
  return downloadViaApi(urlExportConflits(projetId), `${code.replace(/[^\w.-]+/g, "_")}-dossiers-de-conflit.csv`);
}
