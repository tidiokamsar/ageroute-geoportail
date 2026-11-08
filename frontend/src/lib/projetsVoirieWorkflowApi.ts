import { api } from "./api";
import { ReponseInattendue } from "./projetsVoirieApi";
import { lirePersonne, type Personne } from "./projetsVoirieConflitsApi";
import {
  ACTIONS_WORKFLOW, PRIORITES_TACHE, PROFILS, STATUTS_DEMANDE, STATUTS_RECOLEMENT, STATUTS_TACHE, TYPES_PREUVE_WORKFLOW, paramsDemandes, paramsRecolements, paramsTaches,
  type ActionWorkflow, type CorpsPreuveWorkflow, type FiltresDemandes, type FiltresRecolements, type FiltresTaches, type ObjetWorkflow, type PrioriteTache, type ProfilEffectif,
  type StatutDemande, type StatutRecolement, type StatutTache, type TypePreuveWorkflow,
} from "./projetsVoirieWorkflow";
import { STATUTS_CONFLIT, TYPES_CONFLIT, type OptionDecision, type StatutConflit, type TypeConflit, OPTIONS_DECISION } from "./projetsVoirieConflits";
import { versNombre } from "./projetsVoirie";

/**
 * Client du workflow concessionnaire, des referents et du recolement (lot B3). SOURCE DES FORMES : le code du backend (`api-v2/projets-voirie.workflow.routes.ts`,
 * `projets-voirie/workflow/*.service.ts`), relu le 08/11/2026, et docs/projets-voirie/API.md.
 *
 * L'APPLICATION N'ENVOIE AUCUN MESSAGE : aucune route d'envoi n'existe, `statut ENVOYEE` enregistre un envoi fait hors application. Une preuve est une reference
 * et une empreinte : aucun fichier n'est transmis. Aucune route ne cree d'ordre, de deplacement ni de decision.
 *
 * Lecteurs TOLERANTS : un champ absent ou masque (le serveur retire interlocuteur, auteurs, motifs, historique selon le profil) reste `null` et n'est JAMAIS rendu comme
 * « aucun » ni comme zero. Un element dont le statut est inconnu de cette version n'est pas rendu : il est compte dans `ignores`.
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
const concessionnaire = (v: unknown): { id: string; nom: string | null } | null => (estObjet(v) && identifiant(v.id) ? { id: identifiant(v.id) as string, nom: texte(v.nom) } : null);

// ---------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------

export interface Rattachement { id: string; projet: { id: string; code: string | null; nom: string | null }; concessionnaire: { id: string; nom: string | null } }

export interface ProfilWorkflow {
  role: string | null;
  profil: ProfilEffectif | null;
  referent: boolean;
  rattachements: Rattachement[];
  /** Droits RENVOYES par le serveur : les seuls dont l'interface propose l'action. */
  droits: ActionWorkflow[];
  matrice: Record<string, string[]> | null;
  socle: { acte: string; roles: string[]; separation: string | null }[];
  correspondance: { roleCahier: string; compte: string | null; attribut: string | null; resume: string | null }[];
  provisoire: boolean;
  avertissements: string[];
}

export interface EnvoiDemande { dateEnvoi: string | null; canal: string | null; reference: string | null; interlocuteur: string | null; enregistrePar: Personne | null; enregistreLe: string | null }
export interface ReceptionDemande { dateReception: string | null; enregistrePar: Personne | null; enregistreLe: string | null; jeu: { id: string; version: number | null; nomFichier: string | null; statut: string | null } | null; jeuMasque: boolean }
export interface Demande {
  id: string;
  concessionnaire: { id: string; nom: string | null } | null;
  objet: string;
  description: string | null;
  echeance: string | null;
  statut: StatutDemande;
  echeanceDepassee: boolean | null;
  envoi: EnvoiDemande | null;
  reception: ReceptionDemande | null;
  fin: { type: string | null; le: string | null; par: Personne | null; motif: string | null } | null;
  creePar: Personne | null;
  createdAt: string | null;
  updatedAt: string | null;
}
export interface PageDemandes { demandes: Demande[]; compteurs: Partial<Record<StatutDemande, number>> | null; suivant: string | null; ignores: number }

export interface TransitionTache { vers: StatutTache; justificationRequise: boolean; separation: boolean }
export interface Tache {
  id: string;
  titre: string;
  description: string | null;
  conflitId: string | null;
  demandeId: string | null;
  concessionnaire: { id: string; nom: string | null } | null;
  partagee: boolean;
  responsable: Personne | null;
  responsableEstMoi: boolean;
  echeance: string | null;
  echeanceDepassee: boolean | null;
  statut: StatutTache;
  priorite: PrioriteTache | null;
  validationRequise: boolean;
  termineLe: string | null;
  creePar: Personne | null;
  createdAt: string | null;
  /** Transitions que le serveur offre a ce compte ; `null` si la reponse n'en porte pas (alors aucune action n'est proposee). */
  transitions: TransitionTache[] | null;
}
export interface PageTaches { taches: Tache[]; compteurs: Partial<Record<StatutTache, number>> | null; suivant: string | null; ignores: number }

export interface TransitionRecolement { vers: StatutRecolement; droit: string | null }
export interface Recolement {
  id: string;
  conflit: { id: string; type: TypeConflit | null; axe: string | null; statut: StatutConflit | null } | null;
  jeu: { id: string; version: number | null; nomFichier: string | null; statut: string | null; role: string | null } | null;
  jeuMasque: boolean;
  concessionnaire: { id: string; nom: string | null } | null;
  objet: string;
  constat: string | null;
  ecarts: string | null;
  dateRecolement: string | null;
  statut: StatutRecolement;
  revision: number | null;
  soumission: { le: string | null; par: Personne | null } | null;
  decision: { le: string | null; par: Personne | null; motif: string | null; derogationSeparation: string | null } | null;
  creePar: Personne | null;
  createdAt: string | null;
  transitions: TransitionRecolement[] | null;
}
export interface PageRecolements { recolements: Recolement[]; compteurs: Partial<Record<StatutRecolement, number>> | null; suivant: string | null; ignores: number }

export interface PreuveWorkflow {
  id: string;
  type: TypePreuveWorkflow;
  texte: string;
  reference: string | null;
  nomFichier: string | null;
  sha256: string | null;
  tailleOctets: number | null;
  partagee: boolean;
  auteur: Personne | null;
  auteurProfil: string | null;
  createdAt: string | null;
}
export interface EntreeHistoriqueWorkflow {
  id: string;
  action: string;
  ancienStatut: string | null;
  nouveauStatut: string | null;
  justification: string | null;
  acteur: Personne | null;
  acteurProfil: string | null;
  avant: Record<string, unknown> | null;
  apres: Record<string, unknown> | null;
  autres: Record<string, unknown> | null;
  createdAt: string | null;
}

export interface FicheDemande { demande: Demande; preuves: PreuveWorkflow[]; historique: EntreeHistoriqueWorkflow[] | null; transitions: StatutDemande[] | null }
export interface FicheTache { tache: Tache; preuves: PreuveWorkflow[]; historique: EntreeHistoriqueWorkflow[] | null }
export interface FicheRecolement { recolement: Recolement; preuves: PreuveWorkflow[]; historique: EntreeHistoriqueWorkflow[] | null }

export interface RattachementReferent {
  id: string;
  compte: Personne | null;
  concessionnaire: { id: string; nom: string | null } | null;
  motif: string | null;
  creePar: Personne | null;
  createdAt: string | null;
  actif: boolean;
  revocation: { le: string | null; par: Personne | null; motif: string | null } | null;
}

export interface JeuVue { id: string; role: string | null; concessionnaire: { id: string; nom: string | null } | null; version: number | null; nomFichier: string | null; format: string | null; dateDonnees: string | null; nbObjets: number | null; classePrecision: string | null; statut: string | null }
export interface ConflitVue {
  id: string; type: TypeConflit; axe: string | null; statut: StatutConflit;
  concessionnaire: { id: string; nom: string | null } | null; objet: string | null;
  decisionRetenue: { option: OptionDecision | null; dateDebutPrevue: string | null; dateFinPrevue: string | null } | null;
  risque: string | null; echeance: string | null; responsable: Personne | null;
}
export interface PageConflitsVue { conflits: ConflitVue[]; suivant: string | null; ignores: number }

export interface CompteRecherche { id: string; nom: string | null; email: string | null }

// ---------------------------------------------------------------------------------------------------
// Lecteurs
// ---------------------------------------------------------------------------------------------------

export function lireProfilWorkflow(data: unknown): ProfilWorkflow {
  const r = estObjet(data) ? data : null;
  if (!r || !Array.isArray(r.droits)) throw new ReponseInattendue(`GET ${BASE}/workflow/mon-profil`);
  const rattachements = tableau(r.rattachements).flatMap((x): Rattachement[] => {
    if (!estObjet(x) || !estObjet(x.projet)) return [];
    const rid = identifiant(x.id);
    const pid = identifiant(x.projet.id);
    const c = concessionnaire(x.concessionnaire);
    return rid && pid && c ? [{ id: rid, projet: { id: pid, code: texte(x.projet.code), nom: texte(x.projet.nom) }, concessionnaire: c }] : [];
  });
  return {
    role: texte(r.role), profil: parmi(r.profil, PROFILS), referent: r.referent === true, rattachements,
    droits: r.droits.flatMap((d) => { const a = parmi(d, ACTIONS_WORKFLOW); return a ? [a] : []; }),
    matrice: estObjet(r.matrice) ? Object.fromEntries(Object.entries(r.matrice).map(([k, v]) => [k, chaines(v)])) : null,
    socle: tableau(r.socle).flatMap((s) => estObjet(s) && texte(s.acte) ? [{ acte: texte(s.acte) as string, roles: chaines(s.roles), separation: texte(s.separation) }] : []),
    correspondance: tableau(r.correspondanceCahier).flatMap((s) => estObjet(s) && texte(s.roleCahier) ? [{ roleCahier: texte(s.roleCahier) as string, compte: texte(s.compte), attribut: texte(s.attribut), resume: texte(s.resume) }] : []),
    provisoire: r.provisoire === true, avertissements: chaines(r.avertissements),
  };
}

function lireJeuLie(v: unknown): { id: string; version: number | null; nomFichier: string | null; statut: string | null; role: string | null } | null {
  if (!estObjet(v)) return null;
  const jid = identifiant(v.id);
  return jid ? { id: jid, version: nombre(v.version), nomFichier: texte(v.nomFichier), statut: texte(v.statut), role: texte(v.role) } : null;
}

export function lireDemande(v: unknown): Demande | null {
  if (!estObjet(v)) return null;
  const did = identifiant(v.id);
  const statut = parmi(v.statut, STATUTS_DEMANDE);
  const objet = texte(v.objet);
  if (!did || !statut || !objet) return null;
  const e = estObjet(v.envoi) ? v.envoi : null;
  const rc = estObjet(v.reception) ? v.reception : null;
  const f = estObjet(v.fin) ? v.fin : null;
  return {
    id: did, concessionnaire: concessionnaire(v.concessionnaire), objet, description: texte(v.description), echeance: texte(v.echeance), statut,
    echeanceDepassee: typeof v.echeanceDepassee === "boolean" ? v.echeanceDepassee : null,
    envoi: e ? { dateEnvoi: texte(e.dateEnvoi), canal: texte(e.canal), reference: texte(e.reference), interlocuteur: texte(e.interlocuteur), enregistrePar: lirePersonne(e.enregistrePar), enregistreLe: texte(e.enregistreLe) } : null,
    reception: rc ? {
      dateReception: texte(rc.dateReception), enregistrePar: lirePersonne(rc.enregistrePar), enregistreLe: texte(rc.enregistreLe),
      jeu: lireJeuLie(rc.jeu), jeuMasque: rc.jeuMasque === true,
    } : null,
    fin: f ? { type: texte(f.type), le: texte(f.le), par: lirePersonne(f.par), motif: texte(f.motif) } : null,
    creePar: lirePersonne(v.creePar), createdAt: texte(v.createdAt), updatedAt: texte(v.updatedAt),
  };
}

function lireTransitionsTache(v: unknown): TransitionTache[] | null {
  if (!Array.isArray(v)) return null;
  return v.flatMap((t): TransitionTache[] => {
    if (typeof t === "string") { const vers = parmi(t, STATUTS_TACHE); return vers ? [{ vers, justificationRequise: true, separation: false }] : []; }
    if (!estObjet(t)) return [];
    const vers = parmi(t.vers, STATUTS_TACHE);
    // Sans precision du serveur, la justification est exigee : c'est le cas le plus prudent.
    return vers ? [{ vers, justificationRequise: t.justificationRequise !== false, separation: t.separation === true }] : [];
  });
}

export function lireTache(v: unknown): Tache | null {
  if (!estObjet(v)) return null;
  const tid = identifiant(v.id);
  const statut = parmi(v.statut, STATUTS_TACHE);
  const titre = texte(v.titre);
  if (!tid || !statut || !titre) return null;
  return {
    id: tid, titre, description: texte(v.description), conflitId: identifiant(v.conflitId), demandeId: identifiant(v.demandeId), concessionnaire: concessionnaire(v.concessionnaire),
    partagee: v.partagee === true, responsable: lirePersonne(v.responsable), responsableEstMoi: v.responsableEstMoi === true, echeance: texte(v.echeance),
    echeanceDepassee: typeof v.echeanceDepassee === "boolean" ? v.echeanceDepassee : null, statut, priorite: parmi(v.priorite, PRIORITES_TACHE), validationRequise: v.validationRequise === true,
    termineLe: texte(v.termineLe), creePar: lirePersonne(v.creePar), createdAt: texte(v.createdAt), transitions: lireTransitionsTache(v.transitionsPossibles),
  };
}

function lireTransitionsRecolement(v: unknown): TransitionRecolement[] | null {
  if (!Array.isArray(v)) return null;
  return v.flatMap((t): TransitionRecolement[] => {
    if (typeof t === "string") { const vers = parmi(t, STATUTS_RECOLEMENT); return vers ? [{ vers, droit: null }] : []; }
    if (!estObjet(t)) return [];
    const vers = parmi(t.vers, STATUTS_RECOLEMENT);
    return vers ? [{ vers, droit: texte(t.droit) }] : [];
  });
}

export function lireRecolement(v: unknown): Recolement | null {
  if (!estObjet(v)) return null;
  const rid = identifiant(v.id);
  const statut = parmi(v.statut, STATUTS_RECOLEMENT);
  const objet = texte(v.objet);
  if (!rid || !statut || !objet) return null;
  const c = estObjet(v.conflit) && identifiant(v.conflit.id) ? { id: identifiant(v.conflit.id) as string, type: parmi(v.conflit.type, TYPES_CONFLIT), axe: texte(v.conflit.axe), statut: parmi(v.conflit.statut, STATUTS_CONFLIT) } : null;
  const s = estObjet(v.soumission) ? v.soumission : null;
  const d = estObjet(v.decision) ? v.decision : null;
  return {
    id: rid, conflit: c, jeu: lireJeuLie(v.jeu), jeuMasque: v.jeuMasque === true, concessionnaire: concessionnaire(v.concessionnaire), objet,
    constat: texte(v.constat), ecarts: texte(v.ecarts), dateRecolement: texte(v.dateRecolement), statut, revision: nombre(v.revision),
    soumission: s ? { le: texte(s.le), par: lirePersonne(s.par) } : null,
    decision: d ? { le: texte(d.le), par: lirePersonne(d.par), motif: texte(d.motif), derogationSeparation: texte(d.derogationSeparation) } : null,
    creePar: lirePersonne(v.creePar), createdAt: texte(v.createdAt), transitions: lireTransitionsRecolement(v.transitionsPossibles),
  };
}

export function lirePreuveWorkflow(v: unknown): PreuveWorkflow | null {
  if (!estObjet(v)) return null;
  const pid = identifiant(v.id);
  const type = parmi(v.type, TYPES_PREUVE_WORKFLOW);
  const t = texte(v.texte);
  return pid && type && t ? {
    id: pid, type, texte: t, reference: texte(v.reference), nomFichier: texte(v.nomFichier), sha256: texte(v.sha256), tailleOctets: nombre(v.tailleOctets),
    partagee: v.partagee === true, auteur: lirePersonne(v.auteur), auteurProfil: texte(v.auteurProfil), createdAt: texte(v.createdAt),
  } : null;
}

function lirePreuves(v: unknown): PreuveWorkflow[] {
  return tableau(v).flatMap((p) => { const x = lirePreuveWorkflow(p); return x ? [x] : []; }).sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}

/** L'historique n'est rendu qu'aux decideurs : `null` quand le serveur ne l'envoie pas (jamais « aucun historique »). */
function lireHistoriqueWorkflow(v: unknown): EntreeHistoriqueWorkflow[] | null {
  if (!Array.isArray(v)) return null;
  return v.flatMap((h): EntreeHistoriqueWorkflow[] => {
    if (!estObjet(h)) return [];
    const hid = identifiant(h.id);
    const action = texte(h.action);
    if (!hid || !action) return [];
    const d = estObjet(h.donnees) ? h.donnees : null;
    const { avant, apres, ...autres } = d ?? {};
    return [{
      id: hid, action, ancienStatut: texte(h.ancienStatut), nouveauStatut: texte(h.nouveauStatut), justification: texte(h.justification), acteur: lirePersonne(h.acteur), acteurProfil: texte(h.acteurProfil),
      avant: estObjet(avant) ? avant : null, apres: estObjet(apres) ? apres : null, autres: Object.keys(autres).length > 0 ? autres : null, createdAt: texte(h.createdAt),
    }];
  }).sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}

function page<T>(data: unknown, cle: string, route: string, lire: (v: unknown) => T | null): { elements: T[]; ignores: number; suivant: string | null; racine: Obj } {
  const liste = estObjet(data) && Array.isArray(data[cle]) ? (data[cle] as unknown[]) : null;
  if (!liste) throw new ReponseInattendue(route);
  const elements: T[] = [];
  let ignores = 0;
  for (const x of liste) { const e = lire(x); if (e) elements.push(e); else ignores += 1; }
  return { elements, ignores, suivant: texte((data as Obj).curseurSuivant), racine: data as Obj };
}

function compteursParStatut<S extends string>(v: unknown, statuts: readonly S[]): Partial<Record<S, number>> | null {
  if (!estObjet(v)) return null;
  const c: Partial<Record<S, number>> = {};
  for (const s of statuts) { const n = nombre(v[s]); if (n !== null) c[s] = n; }
  return Object.keys(c).length > 0 ? c : null;
}

export function lirePageDemandes(data: unknown): PageDemandes {
  const p = page(data, "demandes", `GET ${BASE}/:id/workflow/demandes`, lireDemande);
  return { demandes: p.elements, ignores: p.ignores, suivant: p.suivant, compteurs: compteursParStatut(p.racine.compteurs, STATUTS_DEMANDE) };
}
export function lirePageTaches(data: unknown): PageTaches {
  const p = page(data, "taches", `GET ${BASE}/:id/workflow/taches`, lireTache);
  return { taches: p.elements, ignores: p.ignores, suivant: p.suivant, compteurs: compteursParStatut(p.racine.compteurs, STATUTS_TACHE) };
}
export function lirePageRecolements(data: unknown): PageRecolements {
  const p = page(data, "recolements", `GET ${BASE}/:id/workflow/recolements`, lireRecolement);
  return { recolements: p.elements, ignores: p.ignores, suivant: p.suivant, compteurs: compteursParStatut(p.racine.compteurs, STATUTS_RECOLEMENT) };
}

export function lireFicheDemande(data: unknown): FicheDemande {
  const r = estObjet(data) ? data : null;
  const demande = r ? lireDemande(r.demande) : null;
  if (!r || !demande) throw new ReponseInattendue(`GET ${BASE}/:id/workflow/demandes/:demandeId`);
  const t = Array.isArray(r.transitionsPossibles) ? r.transitionsPossibles.flatMap((x) => { const s = parmi(x, STATUTS_DEMANDE); return s ? [s] : []; }) : null;
  return { demande, preuves: lirePreuves(r.preuves), historique: lireHistoriqueWorkflow(r.historique), transitions: t };
}
export function lireFicheTache(data: unknown): FicheTache {
  const r = estObjet(data) ? data : null;
  const tache = r ? lireTache(r.tache) : null;
  if (!r || !tache) throw new ReponseInattendue(`GET ${BASE}/:id/workflow/taches/:tacheId`);
  return { tache, preuves: lirePreuves(r.preuves), historique: lireHistoriqueWorkflow(r.historique) };
}
export function lireFicheRecolement(data: unknown): FicheRecolement {
  const r = estObjet(data) ? data : null;
  const recolement = r ? lireRecolement(r.recolement) : null;
  if (!r || !recolement) throw new ReponseInattendue(`GET ${BASE}/:id/workflow/recolements/:recolementId`);
  return { recolement, preuves: lirePreuves(r.preuves), historique: lireHistoriqueWorkflow(r.historique) };
}

export function lireRattachementReferent(v: unknown): RattachementReferent | null {
  if (!estObjet(v)) return null;
  const rid = identifiant(v.id);
  if (!rid) return null;
  const rev = estObjet(v.revocation) ? v.revocation : null;
  return {
    id: rid, compte: lirePersonne(v.compte), concessionnaire: concessionnaire(v.concessionnaire), motif: texte(v.motif), creePar: lirePersonne(v.creePar), createdAt: texte(v.createdAt),
    actif: v.actif !== false && !rev, revocation: rev ? { le: texte(rev.le), par: lirePersonne(rev.par), motif: texte(rev.motif) } : null,
  };
}
export function lireListeReferents(data: unknown): { rattachements: RattachementReferent[]; ignores: number } {
  const p = page(data, "rattachements", `GET ${BASE}/:id/workflow/referents`, lireRattachementReferent);
  return { rattachements: p.elements, ignores: p.ignores };
}

export function lireJeuxVue(data: unknown): JeuVue[] {
  const p = page(data, "jeux", `GET ${BASE}/:id/workflow/jeux`, (v): JeuVue | null => {
    if (!estObjet(v)) return null;
    const jid = identifiant(v.id);
    return jid ? { id: jid, role: texte(v.role), concessionnaire: concessionnaire(v.concessionnaire), version: nombre(v.version), nomFichier: texte(v.nomFichier), format: texte(v.format), dateDonnees: texte(v.dateDonnees), nbObjets: nombre(v.nbObjets), classePrecision: texte(v.classePrecision), statut: texte(v.statut) } : null;
  });
  return p.elements;
}

export function lirePageConflitsVue(data: unknown): PageConflitsVue {
  const p = page(data, "conflits", `GET ${BASE}/:id/workflow/conflits`, (v): ConflitVue | null => {
    if (!estObjet(v)) return null;
    const cid = identifiant(v.id);
    const type = parmi(v.type, TYPES_CONFLIT);
    const statut = parmi(v.statut, STATUTS_CONFLIT);
    if (!cid || !type || !statut) return null;
    const d = estObjet(v.decisionRetenue) ? v.decisionRetenue : null;
    return {
      id: cid, type, axe: texte(v.axe), statut, concessionnaire: concessionnaire(v.concessionnaire), objet: estObjet(v.objet) ? texte(v.objet.nom) : null,
      decisionRetenue: d ? { option: parmi(d.option, OPTIONS_DECISION), dateDebutPrevue: texte(d.dateDebutPrevue), dateFinPrevue: texte(d.dateFinPrevue) } : null,
      risque: texte(v.risque), echeance: texte(v.echeance), responsable: lirePersonne(v.responsable),
    };
  });
  return { conflits: p.elements, ignores: p.ignores, suivant: p.suivant };
}

export function lireComptes(data: unknown): CompteRecherche[] {
  const liste = estObjet(data) && Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : null;
  if (!liste) throw new ReponseInattendue("GET /users");
  return liste.flatMap((u): CompteRecherche[] => { const uid = estObjet(u) ? identifiant(u.id) : null; return uid && estObjet(u) ? [{ id: uid, nom: texte(u.nomComplet), email: texte(u.email) }] : []; });
}

// ---------------------------------------------------------------------------------------------------
// Appels
// ---------------------------------------------------------------------------------------------------

export async function lireMonProfil(signal?: AbortSignal): Promise<ProfilWorkflow> {
  const { data } = await api.get(`${BASE}/workflow/mon-profil`, { signal });
  return lireProfilWorkflow(data);
}

const W = (projetId: string) => `${BASE}/${id(projetId)}/workflow`;

export async function listerDemandes(projetId: string, f: FiltresDemandes, curseur: string | null, signal?: AbortSignal): Promise<PageDemandes> {
  const { data } = await api.get(`${W(projetId)}/demandes`, { params: paramsDemandes(f, curseur), signal });
  return lirePageDemandes(data);
}
export async function lireDemandeFiche(projetId: string, demandeId: string, signal?: AbortSignal): Promise<FicheDemande> {
  const { data } = await api.get(`${W(projetId)}/demandes/${id(demandeId)}`, { signal });
  return lireFicheDemande(data);
}
export interface CorpsCreationDemande { concessionnaireId: string; objet: string; description: string | null; echeance: string | null }
export async function creerDemande(projetId: string, c: CorpsCreationDemande): Promise<void> {
  await api.post(`${W(projetId)}/demandes`, c);
}
export interface CorpsModifDemande { objet?: string; description?: string | null; echeance?: string | null; jeuRecuId?: string | null; justification?: string }
export async function modifierDemande(projetId: string, demandeId: string, c: CorpsModifDemande): Promise<void> {
  await api.patch(`${W(projetId)}/demandes/${id(demandeId)}`, c);
}
export type CorpsStatutDemande =
  | { vers: "ENVOYEE"; canalEnvoi: string; dateEnvoi: string; referenceEnvoi?: string | null; interlocuteur?: string | null }
  | { vers: "RECUE"; dateReception: string; jeuRecuId?: string | null; note?: string | null }
  | { vers: "CLOTUREE" | "ANNULEE"; justification: string };
/** ENREGISTRE un envoi fait HORS application (canal, date, reference, interlocuteur) : aucun message n'est emis par cette route ni par l'application. */
export async function changerStatutDemande(projetId: string, demandeId: string, c: CorpsStatutDemande): Promise<void> {
  await api.post(`${W(projetId)}/demandes/${id(demandeId)}/statut`, c);
}

export async function listerTaches(projetId: string, f: FiltresTaches, curseur: string | null, signal?: AbortSignal): Promise<PageTaches> {
  const { data } = await api.get(`${W(projetId)}/taches`, { params: paramsTaches(f, curseur), signal });
  return lirePageTaches(data);
}
export async function lireTacheFiche(projetId: string, tacheId: string, signal?: AbortSignal): Promise<FicheTache> {
  const { data } = await api.get(`${W(projetId)}/taches/${id(tacheId)}`, { signal });
  return lireFicheTache(data);
}
export interface CorpsCreationTache {
  titre: string; description: string | null; responsableId: string; echeance: string | null; priorite: PrioriteTache; validationRequise: boolean;
  conflitId: string | null; demandeId: string | null; partagee: boolean;
}
export async function creerTache(projetId: string, c: CorpsCreationTache): Promise<void> {
  await api.post(`${W(projetId)}/taches`, c);
}
export interface CorpsModifTache { titre?: string; description?: string | null; echeance?: string | null; priorite?: PrioriteTache; responsableId?: string; partagee?: boolean; justification?: string }
export async function modifierTache(projetId: string, tacheId: string, c: CorpsModifTache): Promise<void> {
  await api.patch(`${W(projetId)}/taches/${id(tacheId)}`, c);
}
export interface CorpsStatutTache { vers: StatutTache; justification?: string; derogation?: string }
export async function changerStatutTache(projetId: string, tacheId: string, c: CorpsStatutTache): Promise<void> {
  await api.post(`${W(projetId)}/taches/${id(tacheId)}/statut`, c);
}

export async function listerRecolements(projetId: string, f: FiltresRecolements, curseur: string | null, signal?: AbortSignal): Promise<PageRecolements> {
  const { data } = await api.get(`${W(projetId)}/recolements`, { params: paramsRecolements(f, curseur), signal });
  return lirePageRecolements(data);
}
export async function lireRecolementFiche(projetId: string, recolementId: string, signal?: AbortSignal): Promise<FicheRecolement> {
  const { data } = await api.get(`${W(projetId)}/recolements/${id(recolementId)}`, { signal });
  return lireFicheRecolement(data);
}
export interface CorpsCreationRecolement { conflitId: string | null; jeuId: string | null; objet: string; constat: string | null; ecarts: string | null; dateRecolement: string | null }
export async function creerRecolement(projetId: string, c: CorpsCreationRecolement): Promise<void> {
  await api.post(`${W(projetId)}/recolements`, c);
}
export interface CorpsModifRecolement { objet?: string; constat?: string | null; ecarts?: string | null; dateRecolement?: string | null; justification: string }
export async function modifierRecolement(projetId: string, recolementId: string, c: CorpsModifRecolement): Promise<void> {
  await api.patch(`${W(projetId)}/recolements/${id(recolementId)}`, c);
}
export interface CorpsStatutRecolement { vers: StatutRecolement; justification: string; derogation?: string }
export async function changerStatutRecolement(projetId: string, recolementId: string, c: CorpsStatutRecolement): Promise<void> {
  await api.post(`${W(projetId)}/recolements/${id(recolementId)}/statut`, c);
}

const SEGMENT: Readonly<Record<ObjetWorkflow, string>> = { DEMANDE: "demandes", TACHE: "taches", RECOLEMENT: "recolements" };
/** Ajoute une preuve : une REFERENCE et une EMPREINTE (texte, nom, SHA-256, taille declaree). Aucun fichier n'est transmis. */
export async function ajouterPreuveWorkflow(projetId: string, objet: ObjetWorkflow, objetId: string, c: CorpsPreuveWorkflow): Promise<void> {
  await api.post(`${W(projetId)}/${SEGMENT[objet]}/${id(objetId)}/preuves`, c);
}

export async function listerReferents(projetId: string, signal?: AbortSignal): Promise<{ rattachements: RattachementReferent[]; ignores: number }> {
  const { data } = await api.get(`${W(projetId)}/referents`, { signal });
  return lireListeReferents(data);
}
export async function creerRattachement(projetId: string, c: { userId: string; concessionnaireId: string; motif: string }): Promise<void> {
  await api.post(`${W(projetId)}/referents`, c);
}
/** Revoque un rattachement (il ne se supprime pas). Rend les avertissements du serveur (la cle de module reste sur le compte). */
export async function revoquerRattachement(projetId: string, rattachementId: string, motif: string): Promise<string[]> {
  const { data } = await api.post(`${W(projetId)}/referents/${id(rattachementId)}/revoquer`, { motif });
  return estObjet(data) ? chaines(data.avertissements) : [];
}

export async function listerJeuxVue(projetId: string, signal?: AbortSignal): Promise<JeuVue[]> {
  const { data } = await api.get(`${W(projetId)}/jeux`, { signal });
  return lireJeuxVue(data);
}
export async function listerConflitsVue(projetId: string, statuts: StatutConflit[], curseur: string | null, signal?: AbortSignal): Promise<PageConflitsVue> {
  const params: Record<string, string | number> = { limite: 25 };
  if (statuts.length) params.statut = statuts.join(",");
  if (curseur) params.curseur = curseur;
  const { data } = await api.get(`${W(projetId)}/conflits`, { params, signal });
  return lirePageConflitsVue(data);
}

/** Recherche de comptes pour poser un rattachement : page Utilisateurs, ADMIN seulement (le seul profil qui rattache). Lecteurs actifs, par nom ou courriel. */
export async function rechercherComptes(q: string, signal?: AbortSignal): Promise<CompteRecherche[]> {
  const { data } = await api.get("/users", { params: { role: "LECTEUR", actif: "true", pageSize: 20, ...(q.trim() ? { search: q.trim() } : {}) }, signal });
  return lireComptes(data);
}
