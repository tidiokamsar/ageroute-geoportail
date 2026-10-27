import { api } from "./api";
import type { FiltresDecision } from "../components/decision/types";
import { paramsApi } from "./decision";
import type { Bbox } from "./aideDecisionCarte";

/**
 * Client des interventions du module Aide a la decision : `GET /api/v2/aide-decision/interventions`, `/interventions.geojson`,
 * `/interventions/:id`. La forme lue est CELLE DU BACKEND REEL (`backend/src/api-v2/aide-decision.interventions.routes.ts`,
 * `programmation/priorite.service.ts`, `priorite.noyau.ts` : `LigneClassee`), verifiee a la lecture du code le 26/10/2026 ; le brief du lot
 * decrivait une forme voisine mais differente (pas de niveau de priorite, pas de `statut` ni d'`actionSuivante`, un cout `montantGnf`).
 *
 * REGLE DE CE FICHIER : il ne fabrique AUCUNE valeur. Une reponse qui n'a pas la forme du contrat est une erreur typee (`ErreurAD`, genre
 * `reponse`), jamais un tableau vide ni un zero ; un champ absent reste `null` (un cout absent n'est pas 0 GNF, un score absent n'est pas 0).
 * Les lecteurs (`lireListe`, `lireFiche`) sont purs et se testent sans reseau.
 */

// ---------------------------------------------------------------- types du contrat

export interface TronconResume { id: string; code: string; nom: string | null; regionId: number | null; regionNom: string | null }
export interface Contribution {
  critere: string;
  libelle: string;
  /** Part du poids total, en pourcentage (le serveur la nomme `poidsPct`). */
  poidsPct: number | null;
  /** 0 a 100 ; `null` si le critere manque. */
  valeurNormalisee: number | null;
  points: number | null;
  brut: string | null;
  provenance: string | null;
  note: string | null;
}
export interface CritereManquant { critere: string; libelle: string; raison: string }
export type StatutScore = "CALCULE" | "INCOMPLET" | "EXCLU";
export interface Exclusion { code: string; motif: string }

export interface CoutEstime {
  /** CHAINE (milliards de GNF : jamais un `number`). */
  montantGnf: string;
  devise: string;
  unite: string;
  classePrecision: string | null;
  margePct: number | null;
  provisoire: boolean;
  hypothesesManquantes: string[];
  traitement: string | null;
  calcul: string | null;
  bareme: { source: string | null; version: number | null; approuve: boolean | null; validDe: string | null; validA: string | null } | null;
}
export interface CoutNonEstimable { code: string; motif: string }

export interface Longueur {
  metierKm: number | null;
  geometriqueKm: number | null;
  origine: string | null;
  /** Divergence calculee PAR LE SERVEUR (seuils du detecteur de qualite, PROVISOIRES) : le client ne la recalcule pas. */
  divergence: { signalee: boolean | null; ecartRelatif: number | null; seuilRelatif: number | null } | null;
}

export interface Arbitrage { rang: number | null; motifAbsence: string | null }
export type Localisation = "valide" | "invalide";

export interface Intervention {
  id: string;
  troncon: TronconResume | null;
  classe: string | null;
  rang: number | null;
  /** 0 a 100. PARTIEL quand `scoreIncomplet` : ne se lit jamais comme un score complet. `null` pour une ligne non classee. */
  score: number | null;
  scoreIncomplet: boolean;
  statutScore: StatutScore | null;
  exclusion: Exclusion | null;
  /** Part du poids couverte par des criteres disponibles, 0 a 1 (`completude` du serveur). */
  completude: number | null;
  contributions: Contribution[];
  criteresManquants: CritereManquant[];
  etatPhysique: string | null;
  dateDernierConstat: string | null;
  sourceDernierConstat: string | null;
  confiance: { niveau: string | null; statutEtat: string | null; source: string | null } | null;
  coutEstime: CoutEstime | null;
  coutNonEstimable: CoutNonEstimable | null;
  longueur: Longueur | null;
  arbitrage: Arbitrage | null;
  localisation: Localisation;
  localisationMotif: string | null;
  provisoire: boolean;
  versionModele: string | null;
  versionParametres: string | null;
}

export interface ResumeClassement {
  candidats: number;
  classes: number;
  complets: number;
  incomplets: number;
  exclus: number;
  parMotifExclusion: Record<string, number>;
}
export interface FiltreNonApplique { filtre: string; valeurs: string[]; raison: string }

export interface ListeInterventions {
  items: Intervention[];
  suivant: string | null;
  aSuivant: boolean;
  /** Total de la SELECTION du compte (perimetre et filtres compris), jamais un total national pour un compte regional ; `null` s'il manque. */
  total: number | null;
  /** Total apres le filtre d'affichage `statutScore` (les rangs ne changent pas). */
  totalAffiche: number | null;
  /** Decompte exact du perimetre, calcule par le serveur : `null` s'il manque. */
  resume: ResumeClassement | null;
  filtresNonAppliques: FiltreNonApplique[];
  provisoire: boolean;
  motifsProvisoire: string[];
  versionParametres: string | null;
  etiquetteParametres: string | null;
  /** Lignes recues mais illisibles (sans identifiant) ou en double, ecartees et comptees. */
  ignorees: number;
}

export interface ActionsFiche { disponibles: string[]; nonDisponibles: string[]; raison: string | null }
export interface DecisionHistorique { ficheId: string | null; de: string | null; vers: string | null; motif: string | null; enregistreLe: string | null }
export interface VersionParametres { version: string; creeLe: string | null; approuveeLe: string | null; utilisee: boolean }
export interface FicheFigee { id: string; reference: string | null; statut: string | null; annee: number | null }

export interface FicheIntervention extends Intervention {
  motif: string | null;
  limites: string[] | null;
  actions: ActionsFiche | null;
  /** `null` : le serveur n'en dit rien. */
  historique: {
    recalculs: { disponible: boolean; raison: string | null } | null;
    decisions: DecisionHistorique[];
    parametres: VersionParametres[];
  } | null;
  fichesFigees: FicheFigee[];
  motifsProvisoire: string[];
  avertissement: string | null;
}

// ---------------------------------------------------------------- erreurs

export type GenreErreurAD = "permission" | "session" | "introuvable" | "entree" | "limite" | "reseau" | "serveur" | "reponse";
export interface ErreurAD { genre: GenreErreurAD; status: number | null; message: string }

const MESSAGES: Record<GenreErreurAD, string> = {
  permission: "Votre rôle, vos modules ou votre périmètre territorial ne permettent pas de voir cette partie.",
  session: "Votre session a expiré. Reconnectez-vous.",
  introuvable: "Intervention introuvable ou hors de votre périmètre.",
  entree: "La demande est invalide.",
  limite: "Trop de demandes. Réessayez dans un instant.",
  reseau: "Le serveur ne répond pas. Vérifiez votre connexion.",
  serveur: "Erreur du serveur.",
  reponse: "Réponse inattendue du serveur : elle n'a pas la forme du contrat.",
};

/** Erreur de FORME : la reponse existe mais n'est pas celle du contrat. Rendue par `classerErreur` en genre `reponse`. */
export class ReponseInvalide extends Error {}

export function classerErreur(e: unknown): ErreurAD {
  if (e instanceof ReponseInvalide) return { genre: "reponse", status: null, message: e.message || MESSAGES.reponse };
  const r = (e as { response?: { status?: number; data?: { error?: unknown } } } | null | undefined)?.response;
  const status = typeof r?.status === "number" ? r.status : null;
  const serveur = typeof r?.data?.error === "string" && r.data.error.trim() ? r.data.error : null;
  let genre: GenreErreurAD;
  if (status === null) genre = "reseau";
  else if (status === 401) genre = "session";
  else if (status === 403) genre = "permission";
  else if (status === 404) genre = "introuvable";
  else if (status === 429) genre = "limite";
  else if (status >= 400 && status < 500) genre = "entree";
  else genre = "serveur";
  return { genre, status, message: serveur ?? MESSAGES[genre] };
}

/** Un refus d'autorisation ne se retente pas : le rejouer ne change rien et retarde l'affichage du refus. */
export function estErreurAutorisation(e: unknown): boolean {
  const g = classerErreur(e).genre;
  return g === "permission" || g === "session";
}

// ---------------------------------------------------------------- lecteurs purs

const nombre = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const texte = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const objet = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const listeTextes = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);

function lireContributions(v: unknown): Contribution[] {
  if (!Array.isArray(v)) return [];
  const sortie: Contribution[] = [];
  for (const c of v) {
    const o = objet(c);
    const critere = o && texte(o.critere);
    if (!o || !critere) continue;
    const brut = typeof o.brut === "number" && Number.isFinite(o.brut) ? String(o.brut) : texte(o.brut);
    sortie.push({
      critere, libelle: texte(o.libelle) ?? critere, poidsPct: nombre(o.poidsPct) ? o.poidsPct : null,
      valeurNormalisee: nombre(o.valeurNormalisee) ? o.valeurNormalisee : null, points: nombre(o.points) ? o.points : null,
      brut, provenance: texte(o.provenance), note: texte(o.note),
    });
  }
  return sortie;
}

function lireManquants(v: unknown): CritereManquant[] {
  if (!Array.isArray(v)) return [];
  const sortie: CritereManquant[] = [];
  for (const c of v) {
    const o = objet(c);
    const critere = o && texte(o.critere);
    if (!o || !critere) continue;
    sortie.push({ critere, libelle: texte(o.libelle) ?? critere, raison: texte(o.raison) ?? "raison non précisée" });
  }
  return sortie;
}

function lireCout(v: unknown): CoutEstime | null {
  const o = objet(v);
  if (!o) return null;
  // Une valeur non textuelle n'est pas un montant : on ne la convertit pas (un `number` perdrait des chiffres sur des milliards).
  const montantGnf = typeof o.montantGnf === "string" && /^-?\d+(\.\d+)?$/.test(o.montantGnf.trim()) ? o.montantGnf.trim() : null;
  if (montantGnf === null) return null;
  const b = objet(o.bareme);
  return {
    montantGnf,
    devise: texte(o.devise) ?? "GNF",
    unite: texte(o.unite) ?? "unité non précisée",
    classePrecision: texte(o.classePrecision),
    margePct: nombre(o.margePct) ? o.margePct : null,
    provisoire: o.provisoire === true,
    hypothesesManquantes: listeTextes(o.hypothesesManquantes),
    traitement: texte(objet(o.traitement)?.libelle),
    calcul: texte(o.calcul),
    bareme: b ? { source: texte(b.source), version: nombre(b.version) ? b.version : null, approuve: typeof b.approuve === "boolean" ? b.approuve : null, validDe: texte(b.validDe), validA: texte(b.validA) } : null,
  };
}

function lireLongueur(v: unknown): Longueur | null {
  const o = objet(v);
  if (!o) return null;
  const d = objet(o.divergence);
  return {
    metierKm: nombre(o.metierKm) ? o.metierKm : null,
    // Le serveur donne la longueur geometrique en METRES (`geometriqueM`) : on ne l'arrondit pas, on la convertit.
    geometriqueKm: nombre(o.geometriqueM) ? o.geometriqueM / 1000 : null,
    origine: texte(o.longueurOrigine),
    divergence: d ? { signalee: typeof d.signalee === "boolean" ? d.signalee : null, ecartRelatif: nombre(d.ecartRelatif) ? d.ecartRelatif : null, seuilRelatif: nombre(d.seuilRelatif) ? d.seuilRelatif : null } : null,
  };
}

/** Lit UNE ligne classee (`LigneClassee`). Sans identifiant : null (ecartee et comptee par l'appelant). */
export function lireIntervention(raw: unknown): Intervention | null {
  const o = objet(raw);
  if (!o) return null;
  const id = texte(o.id) ?? (nombre(o.id) ? String(o.id) : null);
  if (!id) return null;
  const objetTroncon = objet(o.objet);
  const p = objet(o.prioriteTechnique);
  const statut = p && (p.statut === "CALCULE" || p.statut === "INCOMPLET" || p.statut === "EXCLU") ? p.statut : null;
  const excl = objet(p?.exclusion);
  const constat = objet(o.dernierConstat);
  const conf = objet(o.confiance);
  const cne = objet(o.coutNonEstimable);
  const arb = objet(o.ordreArbitrage);
  const absence = objet(arb?.motifAbsence);
  const troncId = objetTroncon && (texte(objetTroncon.id) ?? null);
  return {
    id,
    troncon: troncId
      ? { id: troncId, code: texte(objetTroncon!.code) ?? "", nom: texte(objetTroncon!.nom), regionId: nombre(o.regionId) ? o.regionId : null, regionNom: texte(o.regionNom) }
      : null,
    classe: texte(o.classe),
    rang: p && nombre(p.rang) ? p.rang : null,
    score: p && nombre(p.score) ? p.score : null,
    scoreIncomplet: p?.scoreIncomplet === true,
    statutScore: statut,
    exclusion: excl && texte(excl.code) ? { code: texte(excl.code)!, motif: texte(excl.motif) ?? "motif non précisé" } : null,
    completude: nombre(o.completude) ? o.completude : p && nombre(p.couverture) ? p.couverture : null,
    contributions: lireContributions(p?.contributions),
    criteresManquants: lireManquants(p?.criteresManquants),
    etatPhysique: texte(o.etatPhysique),
    dateDernierConstat: texte(constat?.date),
    sourceDernierConstat: texte(constat?.source),
    confiance: conf ? { niveau: texte(conf.niveau), statutEtat: texte(conf.statutEtat), source: texte(conf.source) } : null,
    coutEstime: lireCout(o.coutEstime),
    coutNonEstimable: cne && texte(cne.code) ? { code: texte(cne.code)!, motif: texte(cne.motif) ?? "motif non précisé" } : null,
    longueur: lireLongueur(o.longueur),
    arbitrage: arb ? { rang: nombre(arb.rang) ? arb.rang : null, motifAbsence: absence ? (texte(absence.detail) ?? texte(absence.code)) : null } : null,
    // Une localisation que le serveur ne dit pas « valide » n'est JAMAIS tenue pour valide (pas de bouton « voir sur la carte »).
    localisation: o.localisation === "valide" ? "valide" : "invalide",
    localisationMotif: texte(o.localisationMotif),
    provisoire: o.provisoire === true,
    versionModele: texte(o.modeleVersion),
    versionParametres: texte(o.parametresVersion),
  };
}

function lireResume(v: unknown): ResumeClassement | null {
  const o = objet(v);
  if (!o || !nombre(o.candidats) || !nombre(o.classes) || !nombre(o.complets) || !nombre(o.incomplets) || !nombre(o.exclus)) return null;
  const parMotif: Record<string, number> = {};
  for (const [k, n] of Object.entries(objet(o.parMotifExclusion) ?? {})) if (nombre(n)) parMotif[k] = n;
  return { candidats: o.candidats, classes: o.classes, complets: o.complets, incomplets: o.incomplets, exclus: o.exclus, parMotifExclusion: parMotif };
}

export function lireFiltresNonAppliques(v: unknown): FiltreNonApplique[] {
  const o = objet(v);
  const l = o && Array.isArray(o.nonAppliques) ? o.nonAppliques : [];
  const sortie: FiltreNonApplique[] = [];
  for (const x of l) {
    const f = objet(x);
    const nom = f && texte(f.filtre);
    if (f && nom) sortie.push({ filtre: nom, valeurs: listeTextes(f.valeurs), raison: texte(f.raison) ?? "raison non précisée" });
  }
  return sortie;
}

/** Lit la page de la liste. Un corps sans tableau `data` est une erreur de forme, pas une liste vide. */
export function lireListe(raw: unknown): ListeInterventions {
  const o = objet(raw);
  if (!o || !Array.isArray(o.data)) throw new ReponseInvalide("Réponse inattendue du serveur : la liste des interventions n'a pas la forme du contrat.");
  const items: Intervention[] = [];
  const vus = new Set<string>();
  let ignorees = 0;
  for (const x of o.data) {
    const i = lireIntervention(x);
    // Un identifiant en double rendrait la selection ambigue : la deuxieme ligne est ecartee ET comptee.
    if (!i || vus.has(i.id)) { ignorees += 1; continue; }
    vus.add(i.id);
    items.push(i);
  }
  const page = objet(o.page);
  const suivant = texte(page?.prochainCurseur);
  return {
    items,
    suivant,
    aSuivant: page?.aSuivant === true && suivant !== null,
    total: nombre(o.total) && o.total >= 0 ? o.total : null,
    totalAffiche: nombre(o.totalAffiche) && o.totalAffiche >= 0 ? o.totalAffiche : null,
    resume: lireResume(o.resume),
    filtresNonAppliques: lireFiltresNonAppliques(o.filtres),
    provisoire: o.provisoire === true,
    motifsProvisoire: listeTextes(o.motifsProvisoire),
    versionParametres: texte(objet(o.parametres)?.version),
    etiquetteParametres: texte(objet(o.parametres)?.etiquette),
    ignorees,
  };
}

function lireActions(v: unknown): ActionsFiche | null {
  const o = objet(v);
  if (!o) return null;
  return { disponibles: listeTextes(o.disponibles), nonDisponibles: listeTextes(o.nonDisponibles), raison: texte(o.raison) };
}

function lireHistorique(v: unknown): FicheIntervention["historique"] {
  const o = objet(v);
  if (!o) return null;
  const rec = objet(o.recalculs);
  const decisions: DecisionHistorique[] = [];
  for (const d of Array.isArray(o.decisions) ? o.decisions : []) {
    const x = objet(d);
    if (x) decisions.push({ ficheId: texte(x.ficheId), de: texte(x.de), vers: texte(x.vers), motif: texte(x.motif), enregistreLe: texte(x.enregistreLe) });
  }
  const parametres: VersionParametres[] = [];
  for (const p of Array.isArray(o.parametres) ? o.parametres : []) {
    const x = objet(p);
    const version = x && texte(x.version);
    if (x && version) parametres.push({ version, creeLe: texte(x.creeLe), approuveeLe: texte(x.approuveeLe), utilisee: x.utilisee === true });
  }
  return { recalculs: rec ? { disponible: rec.disponible === true, raison: texte(rec.raison) } : null, decisions, parametres };
}

/** Lit la fiche (`GET /interventions/:id`) : la ligne classee imbriquee dans `intervention`, plus motif, limites, historique, actions. */
export function lireFiche(raw: unknown): FicheIntervention {
  const o = objet(raw);
  const base = o ? lireIntervention(o.intervention) : null;
  if (!o || !base) throw new ReponseInvalide("Réponse inattendue du serveur : la fiche d'intervention n'a pas la forme du contrat.");
  const fiches: FicheFigee[] = [];
  for (const f of Array.isArray(o.fiches) ? o.fiches : []) {
    const x = objet(f);
    const id = x && texte(x.id);
    if (x && id) fiches.push({ id, reference: texte(x.reference), statut: texte(x.statut), annee: nombre(x.annee) ? x.annee : null });
  }
  return {
    ...base,
    motif: texte(o.motif),
    limites: Array.isArray(o.limites) ? listeTextes(o.limites) : null,
    actions: lireActions(o.actions),
    historique: lireHistorique(o.historique),
    fichesFigees: fiches,
    motifsProvisoire: listeTextes(o.motifsProvisoire),
    avertissement: texte(o.avertissement),
    // La fiche porte le meme drapeau que la ligne ; s'il manque sur la ligne, celui de l'enveloppe fait foi.
    provisoire: base.provisoire || o.provisoire === true,
  };
}

// ---------------------------------------------------------------- appels

const BASE = "/v2/aide-decision";

/**
 * Une page de la liste. `curseur` null = premiere page. Les MEMES filtres serialises que la carte (AD-11). `statutScore` est le filtre
 * d'AFFICHAGE du serveur (CALCULE, INCOMPLET, EXCLU) : les rangs ne changent pas.
 */
export async function listerInterventions(filtres: FiltresDecision, curseur: string | null, statutScore?: StatutScore): Promise<ListeInterventions> {
  const params: Record<string, string> = { ...paramsApi(filtres) };
  if (curseur) params.curseur = curseur;
  if (statutScore) params.statutScore = statutScore;
  return lireListe((await api.get<unknown>(`${BASE}/interventions`, { params })).data);
}

/** FeatureCollection de l'emprise, brute : la carte la lit et la valide (`lireInterventionsGeo` et `lireTroncature` du noyau). */
export async function chargerInterventionsGeo(filtres: FiltresDecision, bbox: Bbox): Promise<unknown> {
  return (await api.get<unknown>(`${BASE}/interventions.geojson`, { params: { ...paramsApi(filtres), bbox: bbox.join(",") } })).data;
}

export async function lireFicheIntervention(id: string): Promise<FicheIntervention> {
  return lireFiche((await api.get<unknown>(`${BASE}/interventions/${encodeURIComponent(id)}`)).data);
}
