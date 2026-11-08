import { api } from "./api";
import { ReponseInattendue } from "./projetsVoirieApi";
import { NATURES_OBJET, versNombre, type ClassePrecision, type NatureObjet, type TypeGeom } from "./projetsVoirie";
import {
  ETATS_VERTICAUX, ACTIONS_RELATION, NIVEAUX_CONFIANCE, ORIGINES_RELATION, STATUTS_QUALITE, STATUTS_RELATION, TYPES_RELATION, paramsObjets, paramsRelations,
  type ActionRelation, type CorpsDescripteur, type EtatVertical, type FiltresObjets, type FiltresRelations, type NiveauConfiance, type OrigineRelation, type OrigineValeur,
  type StatutQualite, type StatutRelation, type TypeRelation,
} from "./projetsVoirieReseaux";

/**
 * Client des reseaux physiques et circuits logiques (lot B1). SOURCE DES FORMES : le code du backend (`api-v2/projets-voirie.reseaux.routes.ts`,
 * `projets-voirie/reseaux/vues.ts`, `descripteurs.service.ts`, `relations.service.ts`, `associations.service.ts`, `comptage.service.ts`), relu le 08/11/2026,
 * et docs/projets-voirie/API.md. AUCUNE route ne rend de geometrie : la carte ne recoit rien de ce module.
 *
 * Lecteurs TOLERANTS : un champ absent ou masque reste `null` et n'est JAMAIS remplace par zero ni par une valeur qui changerait le sens (une classe
 * absente n'est pas une classe, une profondeur absente n'est pas 0 m). Un objet ou une relation dont la nature, le type ou le statut est inconnu de cette
 * version n'est pas rendu : il est compte dans `ignores`, jamais masque en silence. Aucune route ne cree d'ordre, de deplacement ni de decision.
 *
 * AUCUN STOCKAGE LOCAL : tout vit dans la memoire de React Query, le temps de la page.
 */

const BASE = "/v2/projets-voirie";
const id = encodeURIComponent;

type Obj = Record<string, unknown>;
const estObjet = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const texte = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const tableau = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const nombre = (v: unknown): number | null => versNombre(v);
const identifiant = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : null);
function parmi<T extends string>(v: unknown, admises: readonly T[]): T | null {
  return typeof v === "string" && (admises as readonly string[]).includes(v) ? (v as T) : null;
}
const chaines = (v: unknown): string[] => tableau(v).filter((x): x is string => typeof x === "string" && x.trim() !== "");

// ---------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------

export interface SourceObjetReseau {
  jeuId: string | null;
  version: number | null;
  role: string | null;
  statut: string | null;
  nomFichier: string | null;
  typeReseau: string | null;
  concessionnaire: { id: string | null; nom: string | null } | null;
  dateDonnees: string | null;
  confidentialite: string | null;
}

export interface QualiteObjet {
  /** Lettre A a E declaree (par la source ou par une personne) ; `null` : non renseignee. Jamais deduite. */
  classePrecision: ClassePrecision | null;
  origineClasse: OrigineValeur;
  precisionHorizontaleM: number | null;
  precisionVerticaleM: number | null;
  methodeCollecte: string | null;
  dateConstat: string | null;
  niveauConfiance: NiveauConfiance | null;
  statutQualite: StatutQualite | null;
}

export interface VerticalObjet {
  /** `null` : le serveur ne l'a pas dit (on n'affirme rien). */
  etat: EtatVertical | null;
  profondeurM: number | null;
  altitudeM: number | null;
  referenceVerticale: string | null;
  motifs: string[];
  /** Toujours faux cote serveur dans ce lot ; lu pour le DIRE, jamais pour conclure. */
  evaluable: boolean | null;
}

export interface DescripteurObjet {
  justification: string | null;
  declarePar: string | null;
  declareLe: string | null;
  modifiePar: string | null;
  modifieLe: string | null;
}

export interface ObjetReseau {
  id: string;
  jeuId: string | null;
  nom: string | null;
  typeGeom: TypeGeom | null;
  longueurM: number | null;
  source: SourceObjetReseau | null;
  nature: NatureObjet;
  origineNature: OrigineValeur;
  typeObjet: string | null;
  qualite: QualiteObjet;
  vertical: VerticalObjet;
  descripteur: DescripteurObjet | null;
}

export interface PageObjetsReseau { objets: ObjetReseau[]; suivant: string | null; ignores: number }

export interface ExtremiteRelation { objetId: string; nom: string | null; nature: NatureObjet | null; typeObjet: string | null; typeGeom: TypeGeom | null; jeuId: string | null }

/** Ce que l'association automatique a calcule (sans geometrie, immuable) ; absent pour une relation declaree par une personne. */
export interface PropositionAuto {
  methode: string | null;
  version: string | null;
  toleranceM: number | null;
  couverture: number | null;
  couvertureMin: number | null;
  longueurCircuitM: number | null;
  longueurDansToleranceM: number | null;
  projection: string | null;
  provisoire: boolean;
}

export interface RelationReseau {
  id: string;
  typeRelation: TypeRelation;
  statut: StatutRelation;
  origine: OrigineRelation | null;
  proposition: PropositionAuto | null;
  source: ExtremiteRelation | null;
  cible: ExtremiteRelation | null;
  decision: { par: string | null; le: string | null; justification: string | null } | null;
  creePar: string | null;
  createdAt: string | null;
  /** Actions que le SERVEUR offre a ce compte (vide pour un lecteur) : aucune autre n'est proposee. */
  actionsPossibles: ActionRelation[];
  /** Role de l'objet ouvert dans la relation (fiche d'un objet seulement). */
  role: "SOURCE" | "CIBLE" | null;
}

export interface PageRelationsReseau { relations: RelationReseau[]; suivant: string | null; ignores: number }

export interface FicheObjetReseau {
  objet: ObjetReseau;
  relations: RelationReseau[];
  ignoresRelations: number;
  /** Autres objets du meme jeu a la trace strictement identique (circuits superposes) ; `null` si non calcule (pas une ligne) ou non fourni. */
  tracePartagee: { nbAutresObjets: number | null; libelle: string | null } | null;
}

export interface BilanProposition {
  circuitsExamines: number | null;
  infrastructuresExaminees: number | null;
  classeEExclusCircuits: number | null;
  classeEExclusInfrastructures: number | null;
  propositionsCalculees: number | null;
  creees: number | null;
  dejaConnues: number | null;
  tronque: boolean;
}
export interface ResultatProposition {
  statut: string | null;
  parametres: {
    version: string | null; provisoire: boolean; couvertureMin: number | null; parCircuitMax: number | null; projection: string | null;
    tolerancesParClasseM: Record<string, number>; jeuId: string | null;
  };
  bilan: BilanProposition;
  nbIdsCrees: number | null;
  avertissements: string[];
}

export interface MesuresGroupeComptage { nombreDeclare: number | null; longueurSommeM: number | null; longueurTraceFusionneM: number | null; parType: Record<string, number> }
export interface ComptageReseau {
  infrastructures: MesuresGroupeComptage & { nombreLineaires: number | null };
  circuits: {
    nombreDeclare: number | null; nombreLineaires: number | null; sommeLongueursCircuitsM: number | null; longueurTraceFusionneM: number | null; parType: Record<string, number>;
    tracesPartagees: { groupes: number | null; circuitsConcernes: number | null };
    supportPhysique: { avecSupportValide: number | null; avecPropositionSeulement: number | null; sansSupportConnu: number | null };
  };
  equipements: { nombreDeclare: number | null; parType: Record<string, number> };
  natureInconnue: { nombreObjets: number | null; longueurSommeM: number | null };
  libelles: Record<string, string>;
  avertissements: string[];
  jeux: { jeuId: string | null; nomFichier: string | null; version: number | null; statut: string | null; nonAutorise: boolean; nbObjets: number | null; longueurTotaleM: number | null; longueurTraceFusionneM: number | null; concessionnaire: string | null }[];
  qualite: {
    objets: number | null; parClasse: Record<string, number>; sansProfondeur: number | null; sansAltitude: number | null; objetsAvecDonneesVerticales: number | null; evaluables: number | null; mentionVerticale: string | null;
  } | null;
  limites: string[];
  inclureNonAutorises: boolean;
}

// ---------------------------------------------------------------------------------------------------
// Lecteurs
// ---------------------------------------------------------------------------------------------------

const natureObjet = (v: unknown): NatureObjet | null => parmi(v, NATURES_OBJET);
const origineValeur = (v: unknown): OrigineValeur => parmi(v, ["OBJET", "JEU", "INCONNUE"] as const) ?? "INCONNUE";
const typeGeom = (v: unknown): TypeGeom | null => parmi(v, ["LIGNE", "POINT", "POLYGONE"] as const);
/** Une classe est une lettre A a E ; tout le reste (nul, « INCONNUE », valeur inattendue) est « non renseignee ». */
const classe = (v: unknown): ClassePrecision | null => parmi(v, ["A", "B", "C", "D", "E"] as const);

function lireSource(v: unknown): SourceObjetReseau | null {
  if (!estObjet(v)) return null;
  const c = estObjet(v.concessionnaire) ? { id: identifiant(v.concessionnaire.id), nom: texte(v.concessionnaire.nom) } : null;
  return {
    jeuId: identifiant(v.jeuId), version: nombre(v.version), role: texte(v.role), statut: texte(v.statut), nomFichier: texte(v.nomFichier), typeReseau: texte(v.typeReseau),
    concessionnaire: c && (c.id || c.nom) ? c : null, dateDonnees: texte(v.dateDonnees), confidentialite: texte(v.confidentialite),
  };
}

function lireQualite(v: unknown): QualiteObjet {
  const q = estObjet(v) ? v : {};
  return {
    classePrecision: classe(q.classePrecision), origineClasse: origineValeur(q.origineClasse),
    precisionHorizontaleM: nombre(q.precisionHorizontaleM), precisionVerticaleM: nombre(q.precisionVerticaleM),
    methodeCollecte: texte(q.methodeCollecte), dateConstat: texte(q.dateConstat),
    niveauConfiance: parmi(q.niveauConfiance, NIVEAUX_CONFIANCE), statutQualite: parmi(q.statutQualite, STATUTS_QUALITE),
  };
}

function lireVertical(v: unknown): VerticalObjet {
  const x = estObjet(v) ? v : {};
  return {
    etat: parmi(x.etat, ETATS_VERTICAUX), profondeurM: nombre(x.profondeurM), altitudeM: nombre(x.altitudeM), referenceVerticale: texte(x.referenceVerticale),
    motifs: chaines(x.motifs), evaluable: typeof x.evaluable === "boolean" ? x.evaluable : null,
  };
}

export function lireObjetReseau(v: unknown): ObjetReseau | null {
  if (!estObjet(v)) return null;
  const oid = identifiant(v.id);
  const nature = natureObjet(v.nature);
  if (!oid || !nature) return null;
  const d = estObjet(v.descripteur) ? v.descripteur : null;
  return {
    id: oid, jeuId: identifiant(v.jeuId), nom: texte(v.nom), typeGeom: typeGeom(v.typeGeom), longueurM: nombre(v.longueurM),
    source: lireSource(v.source), nature, origineNature: origineValeur(v.origineNature), typeObjet: texte(v.typeObjet),
    qualite: lireQualite(v.qualite), vertical: lireVertical(v.vertical),
    descripteur: d ? { justification: texte(d.justification), declarePar: texte(d.declarePar), declareLe: texte(d.declareLe), modifiePar: texte(d.modifiePar), modifieLe: texte(d.modifieLe) } : null,
  };
}

export function lirePageObjetsReseau(data: unknown): PageObjetsReseau {
  const liste = estObjet(data) && Array.isArray(data.objets) ? data.objets : null;
  if (!liste) throw new ReponseInattendue(`GET ${BASE}/:id/reseau/objets`);
  const objets: ObjetReseau[] = [];
  let ignores = 0;
  for (const x of liste) { const o = lireObjetReseau(x); if (o) objets.push(o); else ignores += 1; }
  return { objets, ignores, suivant: texte((data as Obj).curseurSuivant) };
}

function lireExtremite(v: unknown): ExtremiteRelation | null {
  if (!estObjet(v)) return null;
  const oid = identifiant(v.objetId);
  return oid ? { objetId: oid, nom: texte(v.nom), nature: natureObjet(v.nature), typeObjet: texte(v.typeObjet), typeGeom: typeGeom(v.typeGeom), jeuId: identifiant(v.jeuId) } : null;
}

function lireProposition(v: unknown): PropositionAuto | null {
  if (!estObjet(v) || Object.keys(v).length === 0) return null;
  return {
    methode: texte(v.methode), version: texte(v.version), toleranceM: nombre(v.toleranceM), couverture: nombre(v.couverture), couvertureMin: nombre(v.couvertureMin),
    longueurCircuitM: nombre(v.longueurCircuitM), longueurDansToleranceM: nombre(v.longueurDansToleranceM), projection: texte(v.projection),
    provisoire: v.statutParametres === "PROVISOIRE_A_VALIDER",
  };
}

export function lireRelationReseau(v: unknown): RelationReseau | null {
  if (!estObjet(v)) return null;
  const rid = identifiant(v.id);
  const typeRelation = parmi(v.typeRelation, TYPES_RELATION);
  const statut = parmi(v.statut, STATUTS_RELATION);
  if (!rid || !typeRelation || !statut) return null;
  const dec = estObjet(v.decision) ? v.decision : null;
  return {
    id: rid, typeRelation, statut, origine: parmi(v.origine, ORIGINES_RELATION), proposition: lireProposition(v.proposition),
    source: lireExtremite(v.source), cible: lireExtremite(v.cible),
    decision: dec ? { par: texte(dec.par), le: texte(dec.le), justification: texte(dec.justification) } : null,
    creePar: texte(v.creePar), createdAt: texte(v.createdAt),
    actionsPossibles: tableau(v.actionsPossibles).flatMap((a) => { const x = parmi(a, ACTIONS_RELATION); return x ? [x] : []; }),
    role: v.role === "SOURCE" || v.role === "CIBLE" ? v.role : null,
  };
}

export function lirePageRelationsReseau(data: unknown): PageRelationsReseau {
  const liste = estObjet(data) && Array.isArray(data.relations) ? data.relations : null;
  if (!liste) throw new ReponseInattendue(`GET ${BASE}/:id/reseau/relations`);
  const relations: RelationReseau[] = [];
  let ignores = 0;
  for (const x of liste) { const r = lireRelationReseau(x); if (r) relations.push(r); else ignores += 1; }
  return { relations, ignores, suivant: texte((data as Obj).curseurSuivant) };
}

export function lireFicheObjetReseau(data: unknown): FicheObjetReseau {
  const racine = estObjet(data) ? data : null;
  const objet = racine ? lireObjetReseau(racine.objet) : null;
  if (!racine || !objet) throw new ReponseInattendue(`GET ${BASE}/:id/reseau/objets/:objetId`);
  const liste = tableau(racine.relations);
  const relations = liste.flatMap((x) => { const r = lireRelationReseau(x); return r ? [r] : []; });
  const tp = estObjet(racine.tracePartagee) ? racine.tracePartagee : null;
  return {
    objet, relations, ignoresRelations: liste.length - relations.length,
    tracePartagee: tp ? { nbAutresObjets: nombre(tp.nbAutresObjets), libelle: texte(tp.libelle) } : null,
  };
}

export function lireResultatProposition(data: unknown): ResultatProposition {
  const r = estObjet(data) ? data : null;
  if (!r || !estObjet(r.bilan)) throw new ReponseInattendue(`POST ${BASE}/:id/reseau/associations/proposer`);
  const p = estObjet(r.parametres) ? r.parametres : {};
  const b = r.bilan;
  const e = estObjet(b.classeEExclus) ? b.classeEExclus : {};
  const tol: Record<string, number> = {};
  if (estObjet(p.tolerancesParClasseM)) for (const [k, x] of Object.entries(p.tolerancesParClasseM)) { const n = nombre(x); if (n !== null) tol[k] = n; }
  return {
    statut: texte(r.statut),
    parametres: {
      version: texte(p.version), provisoire: p.statut === "PROVISOIRE_A_VALIDER", couvertureMin: nombre(p.couvertureMin), parCircuitMax: nombre(p.parCircuitMax),
      projection: texte(p.projection), tolerancesParClasseM: tol, jeuId: identifiant(p.jeuId),
    },
    bilan: {
      circuitsExamines: nombre(b.circuitsExamines), infrastructuresExaminees: nombre(b.infrastructuresExaminees),
      classeEExclusCircuits: nombre(e.circuits), classeEExclusInfrastructures: nombre(e.infrastructures),
      propositionsCalculees: nombre(b.propositionsCalculees), creees: nombre(b.creees), dejaConnues: nombre(b.dejaConnues), tronque: b.tronque === true,
    },
    nbIdsCrees: Array.isArray(r.idsCrees) ? r.idsCrees.length : null,
    avertissements: chaines(r.avertissements),
  };
}

function nombresParCle(v: unknown): Record<string, number> {
  const s: Record<string, number> = {};
  if (estObjet(v)) for (const [k, x] of Object.entries(v)) { const n = nombre(x); if (n !== null) s[k] = n; }
  return s;
}

export function lireComptageReseau(data: unknown): ComptageReseau {
  const r = estObjet(data) ? data : null;
  if (!r || !estObjet(r.infrastructuresPhysiques) || !estObjet(r.circuitsLogiques)) throw new ReponseInattendue(`GET ${BASE}/:id/reseau/comptage`);
  const i = r.infrastructuresPhysiques;
  const c = r.circuitsLogiques;
  const tp = estObjet(c.tracesPartagees) ? c.tracesPartagees : {};
  const sp = estObjet(c.supportPhysique) ? c.supportPhysique : {};
  const eq = estObjet(r.equipements) ? r.equipements : {};
  const ni = estObjet(r.natureInconnue) ? r.natureInconnue : {};
  const q = estObjet(r.qualite) ? r.qualite : null;
  const dv = q && estObjet(q.donneesVerticales) ? q.donneesVerticales : {};
  const libelles: Record<string, string> = {};
  if (estObjet(r.libelles)) for (const [k, x] of Object.entries(r.libelles)) { const t = texte(x); if (t) libelles[k] = t; }
  return {
    infrastructures: {
      nombreDeclare: nombre(i.nombreDeclare), nombreLineaires: nombre(i.nombreLineaires), longueurSommeM: nombre(i.longueurSommeM), longueurTraceFusionneM: nombre(i.longueurTraceFusionneM), parType: nombresParCle(i.parType),
    },
    circuits: {
      nombreDeclare: nombre(c.nombreDeclare), nombreLineaires: nombre(c.nombreLineaires), sommeLongueursCircuitsM: nombre(c.sommeLongueursCircuitsM), longueurTraceFusionneM: nombre(c.longueurTraceFusionneM),
      parType: nombresParCle(c.parType), tracesPartagees: { groupes: nombre(tp.groupes), circuitsConcernes: nombre(tp.circuitsConcernes) },
      supportPhysique: { avecSupportValide: nombre(sp.avecSupportValide), avecPropositionSeulement: nombre(sp.avecPropositionSeulement), sansSupportConnu: nombre(sp.sansSupportConnu) },
    },
    equipements: { nombreDeclare: nombre(eq.nombreDeclare), parType: nombresParCle(eq.parType) },
    natureInconnue: { nombreObjets: nombre(ni.nombreObjets), longueurSommeM: nombre(ni.longueurSommeM) },
    libelles, avertissements: chaines(r.avertissements),
    jeux: tableau(r.jeux).flatMap((j) => estObjet(j) ? [{
      jeuId: identifiant(j.jeuId), nomFichier: texte(j.nomFichier), version: nombre(j.version), statut: texte(j.statut), nonAutorise: j.nonAutorise === true,
      nbObjets: nombre(j.nbObjets), longueurTotaleM: nombre(j.longueurTotaleM), longueurTraceFusionneM: nombre(j.longueurTraceFusionneM),
      concessionnaire: estObjet(j.concessionnaire) ? texte(j.concessionnaire.nom) : null,
    }] : []),
    qualite: q ? {
      objets: nombre(q.objets), parClasse: nombresParCle(q.parClasse), sansProfondeur: nombre(dv.sansProfondeur), sansAltitude: nombre(dv.sansAltitude), objetsAvecDonneesVerticales: nombre(dv.objetsAvecProfondeurOuAltitude),
      evaluables: nombre(dv.evaluables), mentionVerticale: texte(dv.mention),
    } : null,
    limites: chaines(r.limites),
    inclureNonAutorises: r.inclureNonAutorises === true,
  };
}

// ---------------------------------------------------------------------------------------------------
// Appels
// ---------------------------------------------------------------------------------------------------

export async function listerObjetsReseau(projetId: string, filtres: FiltresObjets, curseur: string | null, signal?: AbortSignal): Promise<PageObjetsReseau> {
  const { data } = await api.get(`${BASE}/${id(projetId)}/reseau/objets`, { params: paramsObjets(filtres, curseur), signal });
  return lirePageObjetsReseau(data);
}

export async function lireFicheObjet(projetId: string, objetId: string, signal?: AbortSignal): Promise<FicheObjetReseau> {
  const { data } = await api.get(`${BASE}/${id(projetId)}/reseau/objets/${id(objetId)}`, { signal });
  return lireFicheObjetReseau(data);
}

/** REMPLACE le descripteur de l'objet : une valeur omise devient inconnue. Rend l'objet a jour. */
export async function declarerDescripteurObjet(projetId: string, objetId: string, corps: CorpsDescripteur): Promise<ObjetReseau> {
  const { data } = await api.put(`${BASE}/${id(projetId)}/reseau/objets/${id(objetId)}/descripteur`, corps);
  const o = estObjet(data) ? lireObjetReseau(data.objet) : null;
  if (!o) throw new ReponseInattendue(`PUT ${BASE}/:id/reseau/objets/:objetId/descripteur`);
  return o;
}

export async function listerRelationsReseau(projetId: string, filtres: FiltresRelations, curseur: string | null, signal?: AbortSignal): Promise<PageRelationsReseau> {
  const { data } = await api.get(`${BASE}/${id(projetId)}/reseau/relations`, { params: paramsRelations(filtres, curseur), signal });
  return lirePageRelationsReseau(data);
}

export interface CorpsRelation { type: TypeRelation; sourceObjetId: string; cibleObjetId: string; justification: string }
/** Declaration MANUELLE : une personne affirme la relation, elle est creee validee (c'est une decision humaine, avec son auteur et sa justification). */
export async function declarerRelationReseau(projetId: string, corps: CorpsRelation): Promise<void> {
  await api.post(`${BASE}/${id(projetId)}/reseau/relations`, corps);
}

export async function transitionRelationReseau(projetId: string, relationId: string, action: ActionRelation, justification: string): Promise<void> {
  await api.post(`${BASE}/${id(projetId)}/reseau/relations/${id(relationId)}/${action}`, { justification });
}

/** Corps facultatif : `{ jeuId }` restreint a un jeu ; les tolerances et le seuil sont ceux du serveur (provisoires), jamais fixes par l'interface. */
export async function proposerAssociationsReseau(projetId: string, jeuId: string | null): Promise<ResultatProposition> {
  const { data } = await api.post(`${BASE}/${id(projetId)}/reseau/associations/proposer`, jeuId ? { jeuId } : {});
  return lireResultatProposition(data);
}

export async function lireComptage(projetId: string, p: { jeuId: string | null; inclureNonAutorises: boolean }, signal?: AbortSignal): Promise<ComptageReseau> {
  const params: Record<string, string> = {};
  if (p.jeuId) params.jeuId = p.jeuId;
  if (p.inclureNonAutorises) params.inclureNonAutorises = "true";
  const { data } = await api.get(`${BASE}/${id(projetId)}/reseau/comptage`, { params, signal });
  return lireComptageReseau(data);
}
