import { api } from "./api";
import { ReponseInattendue } from "./projetsVoirieApi";
import { lireBbox, versNombre } from "./projetsVoirie";
import {
  estDomaine, estNiveau, estSource, lireObjetEmprise,
  type DomaineReferentiel, type EmpriseGeoJson, type EntreeConfiguration, type FicheTerritoire, type NiveauTerritoire, type PageTerritoires, type PersonneRef,
  type SourceConfiguration, type Territoire, type TerritoireResume, type ValeurReferentiel,
} from "./projetsVoirieTerritoires";

/**
 * Client des territoires, referentiels et de la configuration nationale (lot T1). SOURCE DES FORMES : CONTRAT-TERRITOIRES.md section 7, API.md
 * section T1, et le code reel (backend/src/projets-voirie/territoires/vues.ts, configuration.service.ts).
 *
 * Le serveur est la source : une reponse est lue par des gardes ; une reponse inattendue LEVE (`ReponseInattendue`), jamais rendue comme un vide.
 * Une ligne illisible d'une liste est ecartee ET comptee (`ignores`), jamais remplacee par une valeur inventee. Aucun stockage local.
 */

const BASE = "/v2/projets-voirie";
const id = encodeURIComponent;

type Obj = Record<string, unknown>;
const estObjet = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const texte = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const entierOuNul = (v: unknown): number | null => { const n = versNombre(v); return n !== null && Number.isInteger(n) ? n : null; };

function lirePersonne(v: unknown): PersonneRef | null {
  return estObjet(v) && texte(v.id) ? { id: String(v.id), nomComplet: texte(v.nomComplet) ?? "Compte sans nom" } : null;
}

export function lireTerritoireResume(v: unknown): TerritoireResume | null {
  if (!estObjet(v)) return null;
  const tid = texte(v.id), code = texte(v.code), nom = texte(v.nom);
  return tid && code && nom && estNiveau(v.niveau) ? { id: tid, code, nom, niveau: v.niveau as NiveauTerritoire } : null;
}

export function lireTerritoire(v: unknown): Territoire | null {
  const r = lireTerritoireResume(v);
  if (!r || !estObjet(v)) return null;
  const chemin = texte(v.chemin);
  if (!chemin) return null;
  return {
    ...r,
    parentId: texte(v.parentId),
    chemin,
    profondeur: entierOuNul(v.profondeur) ?? 0,
    regionId: entierOuNul(v.regionId),
    regionEffectiveId: entierOuNul(v.regionEffectiveId),
    crsMetriqueEpsg: entierOuNul(v.crsMetriqueEpsg),
    bbox: lireBbox(v.bbox),
    source: texte(v.source),
    actif: v.actif !== false,
    version: Math.max(1, entierOuNul(v.version) ?? 1),
    creePar: lirePersonne(v.creePar),
    updatedAt: texte(v.updatedAt),
  };
}

export function lirePageTerritoires(data: unknown): PageTerritoires & { ignores: number } {
  if (!estObjet(data) || !Array.isArray(data.territoires)) throw new ReponseInattendue(`GET ${BASE}/territoires`);
  const territoires: Territoire[] = [];
  let ignores = 0;
  for (const x of data.territoires) { const t = lireTerritoire(x); if (t) territoires.push(t); else ignores += 1; }
  return { territoires, suivant: texte(data.curseurSuivant), ignores };
}

export function lireFicheTerritoire(data: unknown): FicheTerritoire {
  const v = estObjet(data) ? data.territoire : null;
  const t = lireTerritoire(v);
  if (!t || !estObjet(v)) throw new ReponseInattendue(`GET ${BASE}/territoires/:tid`);
  const e = v.emprise ? lireObjetEmprise(v.emprise) : null;
  return {
    ...t,
    emprise: e && e.ok ? e.emprise : null,
    ancetres: (Array.isArray(v.ancetres) ? v.ancetres : []).flatMap((a) => { const r = lireTerritoireResume(a); return r ? [r] : []; }),
    nbEnfants: entierOuNul(v.nbEnfants),
  };
}

export interface AvertissementTerritoire { code: string; message: string }
export interface IssueEcritureTerritoire { territoire: Territoire; avertissements: AvertissementTerritoire[] }

function lireIssueTerritoire(data: unknown, route: string): IssueEcritureTerritoire {
  const t = estObjet(data) ? lireTerritoire(data.territoire) : null;
  if (!t || !estObjet(data)) throw new ReponseInattendue(route);
  const avertissements = (Array.isArray(data.avertissements) ? data.avertissements : []).flatMap((a): AvertissementTerritoire[] =>
    estObjet(a) && texte(a.code) ? [{ code: String(a.code), message: texte(a.message) ?? String(a.code) }] : []);
  return { territoire: t, avertissements };
}

export function lireValeurReferentiel(v: unknown): ValeurReferentiel | null {
  if (!estObjet(v)) return null;
  const vid = texte(v.id), code = texte(v.code), libelle = texte(v.libelle);
  if (!vid || !code || !libelle || !estDomaine(v.domaine)) return null;
  return {
    id: vid, domaine: v.domaine as DomaineReferentiel, code, libelle,
    ordre: entierOuNul(v.ordre) ?? 0,
    actif: v.actif !== false,
    parametres: estObjet(v.parametres) ? v.parametres : {},
    version: Math.max(1, entierOuNul(v.version) ?? 1),
    systeme: v.systeme === true,
    approuvePar: lirePersonne(v.approuvePar),
    approuveLe: texte(v.approuveLe),
  };
}

export function lireValeursReferentiel(data: unknown, domaine: string): { valeurs: ValeurReferentiel[]; ignores: number } {
  if (!estObjet(data) || !Array.isArray(data.valeurs)) throw new ReponseInattendue(`GET ${BASE}/referentiels/${domaine}`);
  const valeurs: ValeurReferentiel[] = [];
  let ignores = 0;
  for (const x of data.valeurs) { const r = lireValeurReferentiel(x); if (r) valeurs.push(r); else ignores += 1; }
  return { valeurs, ignores };
}

export function lireEntreeConfiguration(v: unknown): EntreeConfiguration | null {
  if (!estObjet(v) || !texte(v.cle)) return null;
  let source: EntreeConfiguration["source"];
  if (estSource(v.source)) source = v.source;
  else if (estObjet(v.source)) {
    const s: Record<string, SourceConfiguration> = {};
    for (const [k, x] of Object.entries(v.source)) if (estSource(x)) s[k] = x;
    source = s;
  } else return null;
  const env = typeof v.variableEnvironnement === "string" ? v.variableEnvironnement
    : Array.isArray(v.variableEnvironnement) ? v.variableEnvironnement.filter((x): x is string => typeof x === "string") : null;
  return {
    cle: String(v.cle), valeur: v.valeur, source, valeurBase: v.valeurBase ?? null, valeurDefaut: v.valeurDefaut ?? null, variableEnvironnement: env,
    version: entierOuNul(v.version) ?? 0, approuvePar: lirePersonne(v.approuvePar), approuveLe: texte(v.approuveLe), justification: texte(v.justification), updatedAt: texte(v.updatedAt),
  };
}

export function lireConfiguration(data: unknown): { configuration: EntreeConfiguration[]; ignores: number } {
  if (!estObjet(data) || !Array.isArray(data.configuration)) throw new ReponseInattendue(`GET ${BASE}/configuration`);
  const configuration: EntreeConfiguration[] = [];
  let ignores = 0;
  for (const x of data.configuration) { const e = lireEntreeConfiguration(x); if (e) configuration.push(e); else ignores += 1; }
  return { configuration, ignores };
}

// ---------------------------------------------------------------------------------------------------
// Appels
// ---------------------------------------------------------------------------------------------------

export interface FiltresTerritoires { q?: string; niveau?: NiveauTerritoire | ""; parentId?: string; actifs?: boolean; limite?: number; curseur?: string | null }

export async function listerTerritoires(f: FiltresTerritoires = {}, signal?: AbortSignal): Promise<PageTerritoires & { ignores: number }> {
  const params: Record<string, string | number> = { limite: f.limite ?? 500 };
  if (f.q?.trim()) params.q = f.q.trim();
  if (f.niveau) params.niveau = f.niveau;
  if (f.parentId) params.parentId = f.parentId;
  if (f.actifs !== undefined) params.actifs = String(f.actifs);
  if (f.curseur) params.curseur = f.curseur;
  const { data } = await api.get(`${BASE}/territoires`, { params, signal });
  return lirePageTerritoires(data);
}

/** Pages successives de la liste (ordre de l'arbre), bornees : au-dela, `tronque` le dit et la recherche passe par le serveur. */
export async function chargerArbreTerritoires(signal?: AbortSignal, pagesMax = 4): Promise<{ territoires: Territoire[]; tronque: boolean; ignores: number }> {
  const territoires: Territoire[] = [];
  let curseur: string | null = null;
  let ignores = 0;
  for (let i = 0; i < pagesMax; i += 1) {
    const p = await listerTerritoires({ curseur, limite: 500 }, signal);
    territoires.push(...p.territoires);
    ignores += p.ignores;
    curseur = p.suivant;
    if (!curseur) return { territoires, tronque: false, ignores };
  }
  return { territoires, tronque: true, ignores };
}

export async function lireTerritoireFiche(tid: string, signal?: AbortSignal): Promise<FicheTerritoire> {
  const { data } = await api.get(`${BASE}/territoires/${id(tid)}`, { signal });
  return lireFicheTerritoire(data);
}

export interface CorpsTerritoire {
  code: string; nom: string; niveau: NiveauTerritoire; parentId?: string | null; regionId?: number | null; crsMetriqueEpsg?: number | null; emprise?: EmpriseGeoJson | null; source?: string | null;
}
export type CorpsModifTerritoire = Partial<Pick<CorpsTerritoire, "nom" | "regionId" | "crsMetriqueEpsg" | "emprise" | "source">> & { actif?: boolean };

export async function creerTerritoire(corps: CorpsTerritoire): Promise<IssueEcritureTerritoire> {
  const { data } = await api.post(`${BASE}/territoires`, corps);
  return lireIssueTerritoire(data, `POST ${BASE}/territoires`);
}

export async function modifierTerritoire(tid: string, corps: CorpsModifTerritoire): Promise<IssueEcritureTerritoire> {
  const { data } = await api.patch(`${BASE}/territoires/${id(tid)}`, corps);
  return lireIssueTerritoire(data, `PATCH ${BASE}/territoires/:tid`);
}

/** Retrait LOGIQUE (le territoire reste en base, historise) ; 409 TERRITOIRE_UTILISE tant qu'il porte des enfants ou des projets. */
export async function retirerTerritoire(tid: string): Promise<void> {
  await api.delete(`${BASE}/territoires/${id(tid)}`);
}

export async function listerValeurs(domaine: DomaineReferentiel, tous: boolean, signal?: AbortSignal): Promise<{ valeurs: ValeurReferentiel[]; ignores: number }> {
  const { data } = await api.get(`${BASE}/referentiels/${id(domaine)}`, { params: tous ? { tous: "true" } : undefined, signal });
  return lireValeursReferentiel(data, domaine);
}

export interface CorpsValeur { code: string; libelle: string; ordre?: number; actif?: boolean; parametres: Record<string, unknown> }

export async function creerValeur(domaine: DomaineReferentiel, corps: CorpsValeur): Promise<ValeurReferentiel> {
  const { data } = await api.post(`${BASE}/referentiels/${id(domaine)}`, corps);
  const v = estObjet(data) ? lireValeurReferentiel(data.valeur) : null;
  if (!v) throw new ReponseInattendue(`POST ${BASE}/referentiels/:domaine`);
  return v;
}

export async function modifierValeur(domaine: DomaineReferentiel, code: string, corps: Partial<Omit<CorpsValeur, "code">>): Promise<ValeurReferentiel> {
  const { data } = await api.patch(`${BASE}/referentiels/${id(domaine)}/${id(code)}`, corps);
  const v = estObjet(data) ? lireValeurReferentiel(data.valeur) : null;
  if (!v) throw new ReponseInattendue(`PATCH ${BASE}/referentiels/:domaine/:code`);
  return v;
}

/** Retrait LOGIQUE ; 409 VALEUR_UTILISEE si un objet non retire la porte (la desactiver plutot). */
export async function retirerValeur(domaine: DomaineReferentiel, code: string): Promise<void> {
  await api.delete(`${BASE}/referentiels/${id(domaine)}/${id(code)}`);
}

export async function chargerConfiguration(signal?: AbortSignal): Promise<{ configuration: EntreeConfiguration[]; ignores: number }> {
  const { data } = await api.get(`${BASE}/configuration`, { signal });
  return lireConfiguration(data);
}

export async function ecrireConfiguration(cle: string, valeur: Record<string, unknown>, justification: string): Promise<EntreeConfiguration> {
  const { data } = await api.put(`${BASE}/configuration/${id(cle)}`, { valeur, justification });
  const e = estObjet(data) ? lireEntreeConfiguration(data.configuration) : null;
  if (!e) throw new ReponseInattendue(`PUT ${BASE}/configuration/:cle`);
  return e;
}

export interface Region { id: number; nom: string }
/** Regions du referentiel administratif (perimetre des comptes) : meme source que les autres ecrans (`/regions`). */
export async function listerRegions(signal?: AbortSignal): Promise<Region[]> {
  const { data } = await api.get("/regions", { signal });
  if (!Array.isArray(data)) throw new ReponseInattendue("GET /regions");
  return data.flatMap((r): Region[] => (estObjet(r) && entierOuNul(r.id) !== null && texte(r.nom) ? [{ id: entierOuNul(r.id) as number, nom: String(r.nom) }] : []));
}
