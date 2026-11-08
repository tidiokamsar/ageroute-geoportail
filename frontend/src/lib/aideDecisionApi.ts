import { api } from "./api";
import type { EtatKpi, FiltresDecision, IdOnglet, Kpi } from "../components/decision/types";
import { estIdOnglet, normaliserFiltres, paramsApi } from "./decision";

/**
 * Types et appels du module « Aide a la decision ». SOURCE DE VERITE DES FORMES : le backend
 * (`backend/src/aide-decision/synthese.ts`, `kpi.noyau.ts`, `dictionnaire.ts`, `qualite.ts`) et
 * `docs/aide-decision/API-SYNTHESE.md`. Les tests lisent des reponses REELLES de `composerSynthese` et
 * `reponseDictionnaire` capturees dans `components/decision/reponses-reelles.testdata.json`.
 *
 * Le serveur est la source : l'interface ne fabrique AUCUNE valeur. Une reponse est lue par un garde qui rend soit une
 * forme sure, soit « reponse inattendue » ; elle ne plante jamais le rendu et ne comble aucun trou par un zero. Les
 * montants en GNF restent des CHAINES de bout en bout (un flottant perd des unites au-dela de 2^53).
 */

// ---------------------------------------------------------------------------------------------- formes du serveur

/** Etat d'un montant : celui d'un indicateur sauf PERIME et DEFINITION_NON_VALIDEE, plus NON_AUTORISE (droit financier absent). */
export type EtatMontant = "DISPONIBLE" | "PARTIEL" | "NON_DISPONIBLE" | "NON_AUTORISE";

export interface MontantEtat {
  etat: EtatMontant;
  /** Chaine decimale (ex. "20200000000000"), jamais un nombre. null quand le montant est inconnu ou non communique. */
  valeurGnf: string | null;
  source: string | null;
  avertissement: string | null;
}

/** Couverture detaillee d'un indicateur : les quatre premiers champs sont du contrat, les suivants sont additifs. */
export interface CouvertureKpi {
  evalueKm: number;
  eligibleKm: number;
  nonEvalueKm: number;
  partNonEvaluee: number;
  etatNonValideKm?: number;
  tronconsNonEvalues?: number;
  tronconsEtatNonValide?: number;
  tronconsSansLongueurMetier?: number;
}

/** Un indicateur du serveur : le contrat (types.ts) + `valeurTexte` (montants exacts) et la couverture detaillee. */
export interface KpiLu extends Kpi {
  valeurTexte?: string | null;
  couverture: CouvertureKpi | null;
}

export interface ClasseRepartition { classe: string; km: number | null; troncons: number; partPct: number | null }
export interface TrancheHorsTaux { km: number | null; troncons: number; partDuPerimetre: number | null }
export interface RepartitionEtat {
  unite: string;
  base: string;
  eligibleKm: number | null;
  perimetreKm: number | null;
  troncons: number;
  /** Classes d'etat VALIDE : BON, MOYEN, MAUVAIS, CRITIQUE ; `partPct` rapporte aux seuls etats valides. */
  classes: ClasseRepartition[];
  nonEvalue: TrancheHorsTaux;
  etatNonValide: TrancheHorsTaux;
  longueurMetierAbsente: { troncons: number };
}

export interface RegionDegradation {
  regionId: number;
  regionNom: string | null;
  regionNonRenseignee: boolean;
  /** Part du reseau a etat valide qui est degradee (%) ; null sans etat valide dans la region. */
  partDegradeePct: number | null;
  degradeKm: number | null;
  eligibleKm: number | null;
  nonEvalueKm: number | null;
  partNonEvaluee: number | null;
  troncons: number;
  tronconsNonEvalues: number;
  tronconsSansLongueurMetier: number;
  etat: string;
}
export interface DegradationSynthese { mention: string; regions: RegionDegradation[] }

export interface LigneBailleur {
  bailleurId: number | null;
  bailleur: string;
  marches: number;
  /** null = AUCUN marche du bailleur n'a de montant GNF : montant inconnu, pas zero (les marches restent comptes). */
  contractuelGnf: string | null;
  /** Marches GNF avec montant saisi : explique un `contractuelGnf` nul ou partiel. */
  marchesAvecMontantGnf: number | null;
  decaisseGnf: string | null;
  marchesSansMontant: number;
  marchesHorsGnf: number;
}
export interface ParBailleur {
  etat: EtatMontant;
  critere: string;
  limite: number;
  totalBailleurs: number;
  tronque: boolean;
  message: string | null;
  lignes: LigneBailleur[];
  /** Les bailleurs au-dela de la limite, agreges : sans eux, une part se calculerait sur les seules lignes affichees. */
  autres: { bailleurs: number; marches: number; contractuelGnf: string | null } | null;
  avertissement: string | null;
}
export interface BudgetSynthese {
  mention: string;
  contractuel: MontantEtat;
  engage: MontantEtat;
  decaisse: MontantEtat;
  previsionnel: MontantEtat;
  parBailleur: ParBailleur;
}

export interface QualiteSynthese {
  etat: string;
  /** Troncons examines. */
  population: number | null;
  /** Anomalies. */
  total: number | null;
  /** BLOQUANTE, A_TRAITER, A_SURVEILLER. */
  parGravite: Record<string, number> | null;
  tronconsNonEvalues: number;
  donneesAConfirmer: number | null;
  famillesNonExecutees: string[];
  avertissements: string[];
  lien: string;
}

export interface FraicheurSynthese {
  calculeLe: string;
  derniereEvaluationLe: string | null;
  plusAncienneEvaluationLe: string | null;
  ageJours: number | null;
  note: string;
}

export interface CouvertureSynthese {
  evalueKm: number | null;
  eligibleKm: number | null;
  nonEvalueKm: number | null;
  partNonEvaluee: number | null;
  etatNonValideKm: number | null;
  tronconsTotal: number | null;
  tronconsNonEvalues: number | null;
  tronconsEtatNonValide: number | null;
  tronconsSansLongueurMetier: number | null;
}

export interface PerimetreSynthese { national: boolean; libelle: string; regionId: number | null }

/** Une section est lue seule : une section mal formee n'invalide pas les autres panneaux. */
export type Section<T> = { ok: true; valeur: T } | { ok: false };

export interface SyntheseLue {
  kpis: KpiLu[];
  /** Indicateurs de la reponse dont la forme est inexploitable (ecartes, comptes, signales a l'ecran). */
  kpisIgnores: number;
  perimetre: PerimetreSynthese | null;
  /** Filtres valides mais NON appliques par le serveur, avec leur raison. */
  filtresNonAppliques: { nom: string; raison: string }[];
  repartitionEtat: Section<RepartitionEtat>;
  degradationParRegion: Section<DegradationSynthese>;
  budget: Section<BudgetSynthese>;
  qualite: Section<QualiteSynthese>;
  fraicheur: Section<FraicheurSynthese>;
  couverture: CouvertureSynthese | null;
  avertissements: string[];
  consultatif: string | null;
}

// ---------------------------------------------------------------------------------------------- gardes

const INVALIDE = Symbol("invalide");
type Lu<T> = T | typeof INVALIDE;

const ETATS_KPI: readonly string[] = ["DISPONIBLE", "NON_DISPONIBLE", "PARTIEL", "PERIME", "DEFINITION_NON_VALIDEE"];
const ETATS_MONTANT: readonly string[] = ["DISPONIBLE", "PARTIEL", "NON_DISPONIBLE", "NON_AUTORISE"];

const estObjet = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Nombre fini ou null (absent = inconnu). Une chaine ou un NaN sont des formes inattendues, pas des zeros. */
function nbNul(v: unknown): Lu<number | null> {
  if (v === null || v === undefined) return null;
  return typeof v === "number" && Number.isFinite(v) ? v : INVALIDE;
}
function nb(v: unknown): Lu<number> {
  return typeof v === "number" && Number.isFinite(v) ? v : INVALIDE;
}
function texteNul(v: unknown): Lu<string | null> {
  if (v === null || v === undefined) return null;
  return typeof v === "string" ? v : INVALIDE;
}
const ok = (...vs: unknown[]): boolean => vs.every((v) => v !== INVALIDE);

function lireCouvertureSynthese(v: unknown): Lu<CouvertureSynthese | null> {
  if (v === null || v === undefined) return null;
  if (!estObjet(v)) return INVALIDE;
  const c = {
    evalueKm: nbNul(v.evalueKm), eligibleKm: nbNul(v.eligibleKm), nonEvalueKm: nbNul(v.nonEvalueKm), partNonEvaluee: nbNul(v.partNonEvaluee),
    etatNonValideKm: nbNul(v.etatNonValideKm), tronconsTotal: nbNul(v.tronconsTotal), tronconsNonEvalues: nbNul(v.tronconsNonEvalues),
    tronconsEtatNonValide: nbNul(v.tronconsEtatNonValide), tronconsSansLongueurMetier: nbNul(v.tronconsSansLongueurMetier),
  };
  return Object.values(c).some((x) => x === INVALIDE) ? INVALIDE : (c as CouvertureSynthese);
}

/**
 * Couverture d'un indicateur. Les quatre champs du contrat sont exiges (types.ts n'a pas de champ nul) ; les champs
 * additifs sont gardes quand ils sont des nombres. Incomplete ou mal formee : ecartee, jamais completee par des zeros.
 */
function lireCouvertureKpi(v: unknown): CouvertureKpi | null {
  if (!estObjet(v)) return null;
  const quatre = [v.evalueKm, v.eligibleKm, v.nonEvalueKm, v.partNonEvaluee];
  if (!quatre.every((x) => typeof x === "number" && Number.isFinite(x))) return null;
  const c: CouvertureKpi = { evalueKm: v.evalueKm as number, eligibleKm: v.eligibleKm as number, nonEvalueKm: v.nonEvalueKm as number, partNonEvaluee: v.partNonEvaluee as number };
  for (const k of ["etatNonValideKm", "tronconsNonEvalues", "tronconsEtatNonValide", "tronconsSansLongueurMetier"] as const) {
    const x = v[k];
    if (typeof x === "number" && Number.isFinite(x)) c[k] = x;
  }
  return c;
}

/**
 * Lit un indicateur. Strict sur l'identite et l'etat (code, libelle, unite, etat, onglet cible : sans eux la vignette
 * ne peut ni se nommer ni s'ouvrir) ; tolerant sur le reste, avec des repli PRUDENTS : une definition sans statut est
 * PROVISOIRE (jamais VALIDEE), une source absente est dite non precisee a l'affichage. Un montant `valeurTexte` qui
 * n'est pas une chaine est refuse (un nombre a deja perdu sa precision).
 */
export function lireKpi(v: unknown): KpiLu | null {
  if (!estObjet(v)) return null;
  const { code, libelle, unite } = v;
  if (typeof code !== "string" || !code || typeof libelle !== "string" || !libelle || typeof unite !== "string") return null;
  if (typeof v.etat !== "string" || !ETATS_KPI.includes(v.etat)) return null;
  const valeur = nbNul(v.valeur);
  if (valeur === INVALIDE) return null;
  const valeurTexte = texteNul(v.valeurTexte);
  if (valeurTexte === INVALIDE) return null;
  const ouvre = v.ouvre;
  if (!estObjet(ouvre) || !estIdOnglet(ouvre.onglet)) return null;
  const perimetre = estObjet(v.perimetre) ? v.perimetre : {};
  const periode = estObjet(v.periode)
    ? { depuis: typeof v.periode.depuis === "string" ? v.periode.depuis : null, jusqua: typeof v.periode.jusqua === "string" ? v.periode.jusqua : null }
    : null;
  return {
    code,
    libelle,
    valeur,
    valeurTexte,
    unite,
    etat: v.etat as EtatKpi,
    statutDefinition: v.statutDefinition === "VALIDEE" ? "VALIDEE" : "PROVISOIRE",
    periode,
    perimetre: {
      libelle: typeof perimetre.libelle === "string" ? perimetre.libelle : "",
      regionId: typeof perimetre.regionId === "number" ? perimetre.regionId : null,
    },
    source: typeof v.source === "string" ? v.source : "",
    calculeLe: typeof v.calculeLe === "string" ? v.calculeLe : "",
    couverture: lireCouvertureKpi(v.couverture),
    definition: typeof v.definition === "string" ? v.definition : "",
    formule: typeof v.formule === "string" ? v.formule : "",
    avertissements: Array.isArray(v.avertissements) ? v.avertissements.filter((a): a is string => typeof a === "string") : [],
    ouvre: { onglet: ouvre.onglet as IdOnglet, filtres: normaliserFiltres(ouvre.filtres) },
  };
}

function lireMontant(v: unknown): MontantEtat | null {
  if (!estObjet(v) || typeof v.etat !== "string" || !ETATS_MONTANT.includes(v.etat)) return null;
  // Un montant arrive en CHAINE : un nombre a deja perdu sa precision, on le refuse plutot que de l'afficher.
  const valeurGnf = texteNul(v.valeurGnf);
  const source = texteNul(v.source);
  const avertissement = texteNul(v.avertissement);
  if (!ok(valeurGnf, source, avertissement)) return null;
  return { etat: v.etat as EtatMontant, valeurGnf: valeurGnf as string | null, source: source as string | null, avertissement: avertissement as string | null };
}

function lireTranche(v: unknown): TrancheHorsTaux | null {
  if (!estObjet(v)) return null;
  const km = nbNul(v.km);
  const troncons = nb(v.troncons);
  const partDuPerimetre = nbNul(v.partDuPerimetre);
  if (!ok(km, troncons, partDuPerimetre)) return null;
  return { km: km as number | null, troncons: troncons as number, partDuPerimetre: partDuPerimetre as number | null };
}

function lireRepartition(v: unknown): RepartitionEtat | null {
  if (!estObjet(v) || !Array.isArray(v.classes)) return null;
  const classes: ClasseRepartition[] = [];
  for (const c of v.classes) {
    if (!estObjet(c) || typeof c.classe !== "string") return null;
    const km = nbNul(c.km);
    const troncons = nb(c.troncons);
    const partPct = nbNul(c.partPct);
    if (!ok(km, troncons, partPct)) return null;
    classes.push({ classe: c.classe, km: km as number | null, troncons: troncons as number, partPct: partPct as number | null });
  }
  const nonEvalue = lireTranche(v.nonEvalue);
  const etatNonValide = lireTranche(v.etatNonValide);
  const eligibleKm = nbNul(v.eligibleKm);
  const perimetreKm = nbNul(v.perimetreKm);
  const troncons = nb(v.troncons);
  const absent = estObjet(v.longueurMetierAbsente) ? nb(v.longueurMetierAbsente.troncons) : INVALIDE;
  if (!nonEvalue || !etatNonValide || !ok(eligibleKm, perimetreKm, troncons, absent)) return null;
  return {
    unite: typeof v.unite === "string" ? v.unite : "km", base: typeof v.base === "string" ? v.base : "",
    eligibleKm: eligibleKm as number | null, perimetreKm: perimetreKm as number | null, troncons: troncons as number,
    classes, nonEvalue, etatNonValide, longueurMetierAbsente: { troncons: absent as number },
  };
}

function lireRegions(v: unknown): DegradationSynthese | null {
  if (!estObjet(v) || !Array.isArray(v.regions)) return null;
  const regions: RegionDegradation[] = [];
  for (const r of v.regions) {
    if (!estObjet(r) || typeof r.regionId !== "number") return null;
    const regionNom = texteNul(r.regionNom);
    const partDegradeePct = nbNul(r.partDegradeePct);
    const degradeKm = nbNul(r.degradeKm);
    const eligibleKm = nbNul(r.eligibleKm);
    const nonEvalueKm = nbNul(r.nonEvalueKm);
    const partNonEvaluee = nbNul(r.partNonEvaluee);
    const troncons = nb(r.troncons);
    const tronconsNonEvalues = nb(r.tronconsNonEvalues);
    const sansLongueur = nb(r.tronconsSansLongueurMetier);
    if (!ok(regionNom, partDegradeePct, degradeKm, eligibleKm, nonEvalueKm, partNonEvaluee, troncons, tronconsNonEvalues, sansLongueur)) return null;
    regions.push({
      regionId: r.regionId, regionNom: regionNom as string | null, regionNonRenseignee: r.regionNonRenseignee === true,
      partDegradeePct: partDegradeePct as number | null, degradeKm: degradeKm as number | null, eligibleKm: eligibleKm as number | null,
      nonEvalueKm: nonEvalueKm as number | null, partNonEvaluee: partNonEvaluee as number | null, troncons: troncons as number,
      tronconsNonEvalues: tronconsNonEvalues as number, tronconsSansLongueurMetier: sansLongueur as number, etat: typeof r.etat === "string" ? r.etat : "",
    });
  }
  return { mention: typeof v.mention === "string" ? v.mention : "", regions };
}

function lireParBailleur(v: unknown): ParBailleur | null {
  if (!estObjet(v) || typeof v.etat !== "string" || !ETATS_MONTANT.includes(v.etat) || !Array.isArray(v.lignes)) return null;
  const lignes: LigneBailleur[] = [];
  for (const l of v.lignes) {
    if (!estObjet(l) || typeof l.bailleur !== "string") return null;
    // contractuelGnf : chaine, ou null (aucun marche avec montant GNF). Un NOMBRE a deja perdu sa precision : refuse.
    const contractuelGnf = texteNul(l.contractuelGnf);
    const avecMontant = nbNul(l.marchesAvecMontantGnf);
    const bailleurId = nbNul(l.bailleurId);
    const marches = nb(l.marches);
    const decaisseGnf = texteNul(l.decaisseGnf);
    const sansMontant = nb(l.marchesSansMontant);
    const horsGnf = nb(l.marchesHorsGnf);
    if (!ok(contractuelGnf, avecMontant, bailleurId, marches, decaisseGnf, sansMontant, horsGnf)) return null;
    lignes.push({
      bailleurId: bailleurId as number | null, bailleur: l.bailleur, marches: marches as number, contractuelGnf: contractuelGnf as string | null,
      marchesAvecMontantGnf: avecMontant as number | null, decaisseGnf: decaisseGnf as string | null, marchesSansMontant: sansMontant as number, marchesHorsGnf: horsGnf as number,
    });
  }
  let autres: ParBailleur["autres"] = null;
  if (v.autres !== null && v.autres !== undefined) {
    if (!estObjet(v.autres)) return null;
    const contractuelAutres = texteNul(v.autres.contractuelGnf);
    const bailleurs = nb(v.autres.bailleurs);
    const marches = nb(v.autres.marches);
    if (!ok(contractuelAutres, bailleurs, marches)) return null;
    autres = { bailleurs: bailleurs as number, marches: marches as number, contractuelGnf: contractuelAutres as string | null };
  }
  const limite = nb(v.limite);
  const totalBailleurs = nb(v.totalBailleurs);
  const message = texteNul(v.message);
  const avertissement = texteNul(v.avertissement);
  if (!ok(limite, totalBailleurs, message, avertissement)) return null;
  return {
    etat: v.etat as EtatMontant, critere: typeof v.critere === "string" ? v.critere : "", limite: limite as number, totalBailleurs: totalBailleurs as number,
    tronque: v.tronque === true, message: message as string | null, lignes, autres, avertissement: avertissement as string | null,
  };
}

function lireBudget(v: unknown): BudgetSynthese | null {
  if (!estObjet(v)) return null;
  const contractuel = lireMontant(v.contractuel);
  const engage = lireMontant(v.engage);
  const decaisse = lireMontant(v.decaisse);
  const previsionnel = lireMontant(v.previsionnel);
  const parBailleur = lireParBailleur(v.parBailleur);
  if (!contractuel || !engage || !decaisse || !previsionnel || !parBailleur) return null;
  return { mention: typeof v.mention === "string" ? v.mention : "", contractuel, engage, decaisse, previsionnel, parBailleur };
}

function lireQualiteSynthese(v: unknown): QualiteSynthese | null {
  if (!estObjet(v)) return null;
  const total = nbNul(v.total);
  const population = nbNul(v.population);
  const donneesAConfirmer = nbNul(v.donneesAConfirmer);
  const tronconsNonEvalues = nb(v.tronconsNonEvalues);
  if (!ok(total, population, donneesAConfirmer, tronconsNonEvalues)) return null;
  let parGravite: Record<string, number> | null = null;
  if (v.parGravite !== null && v.parGravite !== undefined) {
    if (!estObjet(v.parGravite)) return null;
    parGravite = {};
    for (const [k, n] of Object.entries(v.parGravite)) {
      if (typeof n !== "number" || !Number.isFinite(n)) return null;
      parGravite[k] = n;
    }
  }
  const chaines = (x: unknown): string[] => (Array.isArray(x) ? x.filter((e): e is string => typeof e === "string") : []);
  return {
    etat: typeof v.etat === "string" ? v.etat : "", population: population as number | null, total: total as number | null, parGravite,
    tronconsNonEvalues: tronconsNonEvalues as number, donneesAConfirmer: donneesAConfirmer as number | null,
    famillesNonExecutees: chaines(v.famillesNonExecutees), avertissements: chaines(v.avertissements), lien: typeof v.lien === "string" ? v.lien : "",
  };
}

function lireFraicheur(v: unknown): FraicheurSynthese | null {
  if (!estObjet(v) || typeof v.calculeLe !== "string") return null;
  const ageJours = nbNul(v.ageJours);
  const derniere = texteNul(v.derniereEvaluationLe);
  const ancienne = texteNul(v.plusAncienneEvaluationLe);
  if (!ok(ageJours, derniere, ancienne)) return null;
  return { calculeLe: v.calculeLe, derniereEvaluationLe: derniere as string | null, plusAncienneEvaluationLe: ancienne as string | null, ageJours: ageJours as number | null, note: typeof v.note === "string" ? v.note : "" };
}

function lirePerimetre(v: unknown): PerimetreSynthese | null {
  if (!estObjet(v) || typeof v.libelle !== "string") return null;
  return { national: v.national === true, libelle: v.libelle, regionId: typeof v.regionId === "number" ? v.regionId : null };
}

function section<T>(v: T | null): Section<T> {
  return v === null ? { ok: false } : { ok: true, valeur: v };
}

/**
 * Garde de la reponse de `GET /synthese`. Rend null (« reponse inattendue ») quand le corps n'est pas un objet ou n'a
 * pas de liste `kpis` : sans elle, la page n'a rien a montrer. Chaque autre section est lue separement.
 */
export function analyserSynthese(brut: unknown): SyntheseLue | null {
  if (!estObjet(brut) || !Array.isArray(brut.kpis)) return null;
  const kpis: KpiLu[] = [];
  let kpisIgnores = 0;
  for (const e of brut.kpis) {
    const k = lireKpi(e);
    if (k) kpis.push(k);
    else kpisIgnores += 1;
  }
  const couverture = lireCouvertureSynthese(brut.couverture);
  const nonAppliques = estObjet(brut.filtres) && Array.isArray(brut.filtres.nonAppliques)
    ? brut.filtres.nonAppliques.filter((f): f is { nom: string; raison: string } => estObjet(f) && typeof f.nom === "string" && typeof f.raison === "string")
    : [];
  return {
    kpis,
    kpisIgnores,
    perimetre: lirePerimetre(brut.perimetre),
    filtresNonAppliques: nonAppliques,
    repartitionEtat: section(lireRepartition(brut.repartitionEtat)),
    degradationParRegion: section(lireRegions(brut.degradationParRegion)),
    budget: section(lireBudget(brut.budget)),
    qualite: section(lireQualiteSynthese(brut.qualite)),
    fraicheur: section(lireFraicheur(brut.fraicheur)),
    couverture: couverture === INVALIDE ? null : couverture,
    avertissements: Array.isArray(brut.avertissements) ? brut.avertissements.filter((a): a is string => typeof a === "string") : [],
    consultatif: typeof brut.consultatif === "string" ? brut.consultatif : null,
  };
}

// ---------------------------------------------------------------------------------------------- dictionnaire

export interface EntreeDictionnaire {
  code: string;
  libelle: string;
  definition: string;
  formule: string;
  unite: string;
  perimetre: { code: string; libelle: string; definition: string };
  source: string;
  dateDefinition: string;
  miseAJour: string;
  conditionsCalcul: string[];
  limites: string[];
  reglesExclusion: string[];
  /** Ce que le metier n'a PAS tranche : a montrer, jamais a deviner. */
  decisionsOuvertes: string[];
  /** Responsable metier A CONFIRMER (le dictionnaire ne nomme personne). */
  responsableMetier: string;
  statutDefinition: "PROVISOIRE" | "VALIDEE";
}

const chaine = (v: unknown): string => (typeof v === "string" ? v : "");
const liste = (v: unknown): string[] => (Array.isArray(v) ? v.filter((e): e is string => typeof e === "string") : typeof v === "string" && v ? [v] : []);

/** `GET /dictionnaire` rend `{ version, genereLe, ..., indicateurs: EntreeDictionnaire[] }` ; un tableau nu est aussi accepte. */
export function analyserDictionnaire(brut: unknown): EntreeDictionnaire[] | null {
  const tableau = Array.isArray(brut) ? brut : estObjet(brut) ? brut.indicateurs : undefined;
  if (!Array.isArray(tableau)) return null;
  const out: EntreeDictionnaire[] = [];
  for (const e of tableau) {
    if (!estObjet(e) || typeof e.code !== "string" || !e.code) return null;
    const p = estObjet(e.perimetre) ? e.perimetre : null;
    out.push({
      code: e.code,
      libelle: chaine(e.libelle),
      definition: chaine(e.definition),
      formule: chaine(e.formule),
      unite: chaine(e.unite),
      perimetre: { code: p ? chaine(p.code) : "", libelle: p ? chaine(p.libelle) : chaine(e.perimetre), definition: p ? chaine(p.definition) : "" },
      source: chaine(e.source),
      dateDefinition: chaine(e.dateDefinition),
      miseAJour: chaine(e.miseAJour),
      conditionsCalcul: liste(e.conditionsCalcul),
      limites: liste(e.limites),
      reglesExclusion: liste(e.reglesExclusion),
      decisionsOuvertes: liste(e.decisionsOuvertes),
      responsableMetier: chaine(e.responsableMetier),
      statutDefinition: e.statutDefinition === "VALIDEE" ? "VALIDEE" : "PROVISOIRE",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- erreurs

export type GenreErreurDecision = "permission" | "session" | "reseau" | "serveur" | "inattendue" | "autre";
export interface ErreurDecision { genre: GenreErreurDecision; status: number | null; message: string }

/** Reponse 2xx dont la forme n'est pas celle du serveur. */
export class ReponseInattendue extends Error {
  constructor(public readonly ressource: string) {
    super(`Réponse inattendue pour ${ressource}`);
    this.name = "ReponseInattendue";
  }
}

const MESSAGES: Record<GenreErreurDecision, string> = {
  permission: "Votre rôle, vos modules ou votre périmètre territorial ne permettent pas de voir cette partie.",
  session: "Votre session a expiré. Reconnectez-vous.",
  reseau: "Le serveur ne répond pas. Vérifiez votre connexion.",
  serveur: "Le serveur a rencontré une erreur.",
  inattendue: "Réponse inattendue du serveur : sa forme ne correspond pas au contrat. Aucune valeur n'est affichée.",
  autre: "La demande n'a pas abouti.",
};

function statutDe(e: unknown): number | null {
  const s = (e as { response?: { status?: number } } | null | undefined)?.response?.status;
  return typeof s === "number" ? s : null;
}

/** Classe une erreur axios ou une reponse mal formee en genre stable ; le message du serveur prime quand il existe. */
export function classerErreurDecision(e: unknown): ErreurDecision {
  if (e instanceof ReponseInattendue) return { genre: "inattendue", status: null, message: MESSAGES.inattendue };
  const r = (e as { response?: { data?: { error?: unknown } } } | null | undefined)?.response;
  const status = statutDe(e);
  const msgServeur = typeof r?.data?.error === "string" && r.data.error.trim() ? r.data.error : null;
  let genre: GenreErreurDecision;
  if (status === null) genre = "reseau";
  else if (status === 401) genre = "session";
  else if (status === 403) genre = "permission";
  else if (status >= 500) genre = "serveur";
  else genre = "autre";
  return { genre, status, message: msgServeur ?? MESSAGES[genre] };
}

/** Un refus de droit ou de session ne se retente pas : le rejouer ne change rien et masque le refus. */
export function estErreurAutorisation(e: unknown): boolean {
  const g = classerErreurDecision(e).genre;
  return g === "permission" || g === "session";
}

/**
 * Faut-il retenter ? Une seule fois, et jamais sur un refus que le rejouer ne change pas : 400 (filtre invalide),
 * 401, 403 (droit), 404 (region hors perimetre ou inexistante, meme reponse), ni sur une reponse mal formee. Les
 * pannes (5xx, reseau) se retentent.
 */
export function politiqueRetry(echecs: number, e: unknown): boolean {
  if (echecs >= 1) return false;
  if (estErreurAutorisation(e)) return false;
  if (e instanceof ReponseInattendue) return false;
  const s = statutDe(e);
  return !(s === 400 || s === 404);
}

// ---------------------------------------------------------------------------------------------- appels

const BASE = "/v2/aide-decision";

export async function lireSynthese(filtres: FiltresDecision): Promise<SyntheseLue> {
  const r = await api.get<unknown>(`${BASE}/synthese`, { params: paramsApi(filtres) });
  const lu = analyserSynthese(r.data);
  if (!lu) throw new ReponseInattendue("la synthèse");
  return lu;
}

export async function lireDictionnaire(): Promise<EntreeDictionnaire[]> {
  const r = await api.get<unknown>(`${BASE}/dictionnaire`);
  const lu = analyserDictionnaire(r.data);
  if (!lu) throw new ReponseInattendue("le dictionnaire des indicateurs");
  return lu;
}

/**
 * Detail de la qualite du perimetre (`GET /qualite`, voir API-SYNTHESE.md) : forme riche (detecteurs, couverture par
 * region, ce qui n'est pas couvert). Le shell n'en lit rien (il consomme `synthese.qualite`) : la reponse est rendue
 * telle quelle, sans typage, pour l'ecran de qualite qui la lira.
 */
export async function lireQualite(filtres: FiltresDecision): Promise<Record<string, unknown>> {
  const r = await api.get<unknown>(`${BASE}/qualite`, { params: paramsApi(filtres) });
  if (!estObjet(r.data)) throw new ReponseInattendue("la qualité des données");
  return r.data;
}
