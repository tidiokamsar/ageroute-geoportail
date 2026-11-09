import { api } from "./api";
import { ReponseInattendue } from "./projetsVoirieApi";
import { versNombre } from "./projetsVoirie";
import {
  STATUTS_RESULTAT,
  type Comparaison, type GroupeSources, type JeuDansComparaison, type Mesure, type ObjetResultat, type OriginePrecision, type PageResultats, type PersonneRef,
  type RegleDeComparaison, type RegleEffective, type RegleRapprochement, type ResultatComparaison, type ResumeComparaison, type SourceJeu, type StatutResultat,
  type VersionCandidate, type VueRegles, type VueSources,
} from "./projetsVoirieSources";

/**
 * Client du lot S1 (sources, regles de rapprochement, comparaisons). SOURCE DES FORMES : API.md section S1 et le code reel
 * (backend/src/projets-voirie/sources/sources.service.ts, comparaison.service.ts, regles-rapprochement.service.ts).
 *
 * Lecteurs TOLERANTS a l'absence : un champ masque pour ce compte (donnees d'un jeu illisible, objet B d'un dossier de divergence, mesure)
 * est rendu `null` et l'ecran le dit, jamais zero ni une valeur deduite. Une reponse sans sa structure attendue LEVE. Aucun stockage local.
 */

const BASE = "/v2/projets-voirie";
const id = encodeURIComponent;

type Obj = Record<string, unknown>;
const estObjet = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const texte = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const nombre = (v: unknown): number | null => versNombre(v);
const tableau = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const chaines = (v: unknown): string[] => tableau(v).filter((x): x is string => typeof x === "string" && x.trim() !== "");

function personne(v: unknown): PersonneRef | null {
  return estObjet(v) && texte(v.id) ? { id: String(v.id), nomComplet: texte(v.nomComplet) ?? "Compte sans nom" } : null;
}
function tableClasse(v: unknown): Record<string, number> | null {
  if (!estObjet(v)) return null;
  const s: Record<string, number> = {};
  for (const [k, x] of Object.entries(v)) { const n = nombre(x); if (n !== null) s[k] = n; }
  return Object.keys(s).length ? s : null;
}
function totaux(v: unknown): Record<string, number> | null {
  if (!estObjet(v)) return null;
  const s: Record<string, number> = {};
  for (const [k, x] of Object.entries(v)) { const n = nombre(x); if (n !== null) s[k] = n; }
  return s;
}

function lireSource(v: unknown): SourceJeu | null {
  if (!estObjet(v) || !texte(v.jeuId)) return null;
  return {
    jeuId: String(v.jeuId), role: texte(v.role) ?? "", version: Math.max(1, nombre(v.version) ?? 1), methodeAcquisition: texte(v.methodeAcquisition),
    dateDonnees: texte(v.dateDonnees), dateDepot: texte(v.dateDepot), nomFichier: texte(v.nomFichier) ?? "Fichier sans nom",
    classePrecision: texte(v.classePrecision), precisionHorizontaleM: nombre(v.precisionHorizontaleM), nbObjets: nombre(v.nbObjets), confidentialite: texte(v.confidentialite),
  };
}

export function lireGroupeSources(v: unknown): GroupeSources | null {
  if (!estObjet(v) || (v.role !== "RESEAU_TIERS" && v.role !== "AXES_TRAVAUX")) return null;
  const statut = v.statut === "COMPARABLE" ? "COMPARABLE" : v.statut === "SOURCE_UNIQUE_COMPARAISON_INDISPONIBLE" ? "SOURCE_UNIQUE_COMPARAISON_INDISPONIBLE" : null;
  if (!statut) return null;
  const sources = tableau(v.sources).flatMap((s) => { const x = lireSource(s); return x ? [x] : []; });
  const c = estObjet(v.concessionnaire) && texte(v.concessionnaire.id) ? { id: String(v.concessionnaire.id), nom: texte(v.concessionnaire.nom) ?? "Concessionnaire sans nom" } : null;
  const d = estObjet(v.derniereComparaison) && texte(v.derniereComparaison.id) ? v.derniereComparaison : null;
  return {
    role: v.role, concessionnaire: c, typeReseau: texte(v.typeReseau), typeReseauCode: texte(v.typeReseauCode), statut,
    nbSources: nombre(v.nbSources) ?? sources.length, sources,
    derniereComparaison: d ? { id: String(d.id), numero: nombre(d.numero), createdAt: texte(d.createdAt), totaux: totaux(d.totaux) } : null,
    versionsCandidates: Array.isArray(v.versionsCandidates)
      ? v.versionsCandidates.flatMap((s): VersionCandidate[] => { const x = lireSource(s); return x && estObjet(s) ? [{ ...x, statut: texte(s.statut) ?? "", remplace: texte(s.remplace) }] : []; })
      : null,
    mention: texte(v.mention),
  };
}

export function lireVueSources(data: unknown): VueSources {
  if (!estObjet(data) || !Array.isArray(data.reseaux)) throw new ReponseInattendue(`GET ${BASE}/:id/sources`);
  const reseaux: GroupeSources[] = [];
  let ignores = 0;
  for (const x of data.reseaux) { const g = lireGroupeSources(x); if (g) reseaux.push(g); else ignores += 1; }
  return { reseaux, ignores, limites: chaines(data.limites) };
}

export function lireRegle(v: unknown): RegleRapprochement | null {
  if (!estObjet(v) || !texte(v.id) || !texte(v.code)) return null;
  const statut = v.statut === "APPROUVEE" || v.statut === "RETIREE" || v.statut === "BROUILLON" ? v.statut : null;
  if (!statut) return null;
  return {
    id: String(v.id), portee: v.portee === "PROJET" ? "PROJET" : "GENERALE", famille: texte(v.famille), code: String(v.code), version: nombre(v.version) ?? 0,
    margeM: nombre(v.margeM), rayonAppariementM: nombre(v.rayonAppariementM), partHorsCorridorMax: nombre(v.partHorsCorridorMax), precisionParClasseM: tableClasse(v.precisionParClasseM),
    statut, justification: texte(v.justification), systeme: v.systeme === true, creePar: personne(v.creePar), approuvePar: personne(v.approuvePar), approuveLe: texte(v.approuveLe),
    motifApprobation: texte(v.motifApprobation), derogationApprobation: texte(v.derogationApprobation), createdAt: texte(v.createdAt),
  };
}

export function lireVueRegles(data: unknown): VueRegles {
  if (!estObjet(data) || !Array.isArray(data.regles)) throw new ReponseInattendue(`GET ${BASE}/:id/regles-rapprochement`);
  return {
    regles: data.regles.flatMap((r) => { const x = lireRegle(r); return x ? [x] : []; }),
    effectives: tableau(data.effectives).flatMap((e): RegleEffective[] => estObjet(e) && texte(e.famille) ? [{
      famille: String(e.famille), regleId: texte(e.regleId), code: texte(e.code), version: nombre(e.version), portee: texte(e.portee),
      margeM: nombre(e.margeM), rayonAppariementM: nombre(e.rayonAppariementM), partHorsCorridorMax: nombre(e.partHorsCorridorMax), precisionParClasseM: tableClasse(e.precisionParClasseM),
    }] : []),
    avertissements: chaines(data.avertissements),
  };
}

function lireRegleDeComparaison(v: unknown): RegleDeComparaison | null {
  if (!estObjet(v)) return null;
  return {
    regleId: texte(v.regleId) ?? texte(v.id), code: texte(v.code), version: nombre(v.version), famille: texte(v.famille), portee: texte(v.portee),
    margeM: nombre(v.margeM), rayonAppariementM: nombre(v.rayonAppariementM), partHorsCorridorMax: nombre(v.partHorsCorridorMax), precisionParClasseM: tableClasse(v.precisionParClasseM),
  };
}

function lireJeuDansComparaison(v: unknown): JeuDansComparaison | null {
  if (!estObjet(v) || (v.role !== "A" && v.role !== "B") || !texte(v.jeuId)) return null;
  return {
    role: v.role, jeuId: String(v.jeuId), sha256: texte(v.sha256), version: nombre(v.version), methodeAcquisition: texte(v.methodeAcquisition), dateDonnees: texte(v.dateDonnees),
    classePrecision: texte(v.classePrecision), precisionHorizontaleM: nombre(v.precisionHorizontaleM), nbObjets: nombre(v.nbObjets), nomFichier: texte(v.nomFichier), confidentialite: texte(v.confidentialite),
  };
}

function lireResume(v: unknown): ResumeComparaison | null {
  if (!estObjet(v)) return null;
  const c = estObjet(v.corridor) ? v.corridor : null;
  const err = estObjet(v.erreur) ? v.erreur : null;
  return {
    totaux: totaux(v.totaux) ?? {},
    corridor: c ? { minM: nombre(c.minM), maxM: nombre(c.maxM), couplesSansCorridor: nombre(c.couplesSansCorridor), margeM: nombre(c.margeM), rayonAppariementM: nombre(c.rayonAppariementM) } : null,
    limites: chaines(v.limites),
    erreur: err ? { code: texte(err.code), message: texte(err.message) } : texte(v.code) ? { code: texte(v.code), message: texte(v.message) } : null,
  };
}

export function lireComparaison(v: unknown, resumeHorsVue?: unknown): Comparaison | null {
  if (!estObjet(v) || !texte(v.id) || (v.statut !== "TERMINEE" && v.statut !== "ECHEC")) return null;
  return {
    id: String(v.id), numero: nombre(v.numero), statut: v.statut, mode: v.mode === "SOURCES" || v.mode === "VERSION_CANDIDATE" ? v.mode : null, role: texte(v.role),
    jeuAId: texte(v.jeuAId), jeuBId: texte(v.jeuBId), concessionnaireId: texte(v.concessionnaireId), typeReseau: texte(v.typeReseau),
    regle: lireRegleDeComparaison(v.regle), versionAlgorithme: texte(v.versionAlgorithme), epsg: nombre(v.epsg),
    jeux: tableau(v.jeux).flatMap((j) => { const x = lireJeuDansComparaison(j); return x ? [x] : []; }),
    donneesMasquees: v.donneesMasquees === true, declenchePar: personne(v.declenchePar), duree: nombre(v.duree), createdAt: texte(v.createdAt),
    limites: chaines(v.limites), resume: lireResume(resumeHorsVue ?? v.resume),
  };
}

const ORIGINES: readonly OriginePrecision[] = ["OBJET", "JEU", "CLASSE", "INCONNUE"];
function lireObjetResultat(v: unknown): ObjetResultat | null {
  if (!estObjet(v)) return null;
  const oid = texte(v.id) ?? (typeof v.id === "number" ? String(v.id) : null);
  if (!oid) return null;
  return { id: oid, nom: texte(v.nom), precisionM: nombre(v.precisionM), originePrecision: (ORIGINES as readonly string[]).includes(String(v.originePrecision)) ? (v.originePrecision as OriginePrecision) : "INCONNUE" };
}
function lireMesure(v: unknown): Mesure | null {
  if (!estObjet(v)) return null;
  return {
    hausdorffM: nombre(v.hausdorffM), longueurAM: nombre(v.longueurAM), longueurBM: nombre(v.longueurBM), longueurRecouvrementM: nombre(v.longueurRecouvrementM),
    longueurHorsCorridorM: nombre(v.longueurHorsCorridorM), partHorsCorridor: nombre(v.partHorsCorridor), distanceMinM: nombre(v.distanceMinM),
  };
}

export function lireResultat(v: unknown): ResultatComparaison | null {
  if (!estObjet(v) || !texte(v.id) || !(STATUTS_RESULTAT as readonly string[]).includes(String(v.statut))) return null;
  const statut = v.statut as StatutResultat;
  return {
    id: String(v.id), ordre: nombre(v.ordre) ?? 0, cle: texte(v.cle), statut,
    objetA: lireObjetResultat(v.objetA), objetB: lireObjetResultat(v.objetB), corridorM: nombre(v.corridorM),
    // Un rapprochement incertain n'a JAMAIS de mesure, meme si le serveur en rendait une : rien n'est affiche qui ressemblerait a une distance.
    mesure: statut === "RAPPROCHEMENT_INCERTAIN" ? null : lireMesure(v.mesure),
    conflitId: texte(v.conflitId),
  };
}

export function lirePageResultats(data: unknown): PageResultats {
  if (!estObjet(data) || !Array.isArray(data.resultats)) throw new ReponseInattendue(`GET ${BASE}/:id/comparaisons/:cmpId/objets`);
  const resultats: ResultatComparaison[] = [];
  let ignores = 0;
  for (const x of data.resultats) { const r = lireResultat(x); if (r) resultats.push(r); else ignores += 1; }
  return { resultats, masque: data.masque === true, suivant: texte(data.curseurSuivant), ignores };
}

// ---------------------------------------------------------------------------------------------------
// Appels
// ---------------------------------------------------------------------------------------------------

export async function lireSources(projetId: string, signal?: AbortSignal): Promise<VueSources> {
  const { data } = await api.get(`${BASE}/${id(projetId)}/sources`, { signal });
  return lireVueSources(data);
}

export async function listerReglesRapprochement(projetId: string, signal?: AbortSignal): Promise<VueRegles> {
  const { data } = await api.get(`${BASE}/${id(projetId)}/regles-rapprochement`, { signal });
  return lireVueRegles(data);
}

export interface CorpsRegleRapprochement {
  famille?: string | null; code: string; margeM?: number; rayonAppariementM?: number; partHorsCorridorMax?: number; precisionParClasseM?: Record<string, number>; justification: string;
}

export async function creerRegleRapprochement(projetId: string, corps: CorpsRegleRapprochement): Promise<RegleRapprochement> {
  const { data } = await api.post(`${BASE}/${id(projetId)}/regles-rapprochement`, corps);
  const r = estObjet(data) ? lireRegle(data.regle) : null;
  if (!r) throw new ReponseInattendue(`POST ${BASE}/:id/regles-rapprochement`);
  return r;
}

/** Approbation ADMIN, par une autre personne que l'auteur : aucune derogation n'est proposee par cette interface (409 SEPARATION_DES_TACHES). */
export async function approuverRegleRapprochement(projetId: string, regleId: string, justification: string): Promise<RegleRapprochement> {
  const { data } = await api.post(`${BASE}/${id(projetId)}/regles-rapprochement/${id(regleId)}/approuver`, { justification });
  const r = estObjet(data) ? lireRegle(data.regle) : null;
  if (!r) throw new ReponseInattendue(`POST ${BASE}/:id/regles-rapprochement/:regleRapId/approuver`);
  return r;
}

export async function lancerComparaison(projetId: string, jeuAId: string, jeuBId: string): Promise<Comparaison> {
  const { data } = await api.post(`${BASE}/${id(projetId)}/comparaisons`, { jeuAId, jeuBId });
  const c = estObjet(data) ? lireComparaison(data.comparaison, data.resume) : null;
  if (!c) throw new ReponseInattendue(`POST ${BASE}/:id/comparaisons`);
  return c;
}

export async function listerComparaisons(projetId: string, curseur: string | null, signal?: AbortSignal): Promise<{ comparaisons: Comparaison[]; suivant: string | null }> {
  const params: Record<string, string | number> = { limite: 25 };
  if (curseur) params.curseur = curseur;
  const { data } = await api.get(`${BASE}/${id(projetId)}/comparaisons`, { params, signal });
  if (!estObjet(data) || !Array.isArray(data.comparaisons)) throw new ReponseInattendue(`GET ${BASE}/:id/comparaisons`);
  return { comparaisons: data.comparaisons.flatMap((c) => { const x = lireComparaison(c); return x ? [x] : []; }), suivant: texte(data.curseurSuivant) };
}

export async function lireComparaisonDetail(projetId: string, cmpId: string, signal?: AbortSignal): Promise<Comparaison> {
  const { data } = await api.get(`${BASE}/${id(projetId)}/comparaisons/${id(cmpId)}`, { signal });
  const c = estObjet(data) ? lireComparaison(data.comparaison) : null;
  if (!c) throw new ReponseInattendue(`GET ${BASE}/:id/comparaisons/:cmpId`);
  return c;
}

export async function listerResultats(projetId: string, cmpId: string, statuts: readonly StatutResultat[], curseur: string | null, signal?: AbortSignal): Promise<PageResultats> {
  const params: Record<string, string | number> = { limite: 50 };
  if (statuts.length) params.statut = statuts.join(",");
  if (curseur) params.curseur = curseur;
  const { data } = await api.get(`${BASE}/${id(projetId)}/comparaisons/${id(cmpId)}/objets`, { params, signal });
  return lirePageResultats(data);
}

/** Ouverture d'un dossier RC-3 DIVERGENCE_SOURCES (A_INVESTIGUER) depuis un resultat DIVERGENCE : action HUMAINE justifiee. Rien d'autre ne change. */
export async function ouvrirDossierDivergence(projetId: string, cmpId: string, resultatId: string, justification: string): Promise<{ conflitId: string }> {
  const { data } = await api.post(`${BASE}/${id(projetId)}/comparaisons/${id(cmpId)}/dossiers-conflit`, { resultatId, justification });
  const c = estObjet(data) && estObjet(data.conflit) ? texte(data.conflit.id) : null;
  if (!c) throw new ReponseInattendue(`POST ${BASE}/:id/comparaisons/:cmpId/dossiers-conflit`);
  return { conflitId: c };
}
