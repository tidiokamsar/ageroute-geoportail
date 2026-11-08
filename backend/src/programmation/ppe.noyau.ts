/**
 * PROGRAMMATION PLURIANNUELLE (PPE) MINIMALE (MAINTENANCE_PROGRAMMING_DESIGN.md, paragraphe 5.1). Aucun acces base.
 *
 * CE QUE LE MODULE FAIT
 *
 * Sur N annees consecutives (N borne : de MIN_ANNEES_PPE a MAX_ANNEES_PPE), l'utilisateur SAISIT une enveloppe
 * par annee. Le module CHAINE les scenarios annuels existants (`construireScenario`, le meme noyau que le PAE) :
 *
 *   annee 1 : scenario sur tous les candidats ;
 *   annee k : scenario sur les candidats QUI N'ONT PAS ETE RETENUS une annee precedente.
 *
 * Un troncon retenu une annee n'est donc JAMAIS reutilise une annee suivante : une seule intervention par
 * troncon sur l'horizon du plan. Un troncon ecarte pour budget en annee 1 reste candidat en annee 2 (c'est tout
 * l'interet du chainage) ; un troncon ecarte parce que son risque n'est pas calculable le reste chaque annee,
 * avec son motif, chaque annee.
 *
 * CE QUE LE MODULE NE FAIT PAS, ET C'EST DIT
 *
 *   - AUCUNE OPTIMISATION. La methode est GLOUTONNE et DETERMINISTE, annee par annee : meme regle que le PAE
 *     (rapport risque attendu / cout, comparaison exacte en BigInt). Elle n'est pas un optimum pluriannuel :
 *     retenir en annee 1 un troncon tres rentable ne tient aucun compte de ce qu'une autre repartition des
 *     enveloppes aurait permis. Aucun PLNE. Une regle qu'un agent peut refaire a la main reste le critere A22.
 *   - AUCUNE ENVELOPPE INVENTEE : chaque montant annuel est celui que l'utilisateur a saisi (0 est une saisie
 *     valide : « rien cette annee-la »). Le module ne repartit pas un budget total, ne reporte pas un reste d'une
 *     annee sur la suivante (un reste non depense n'est pas une enveloppe), n'indexe rien.
 *   - AUCUNE PROJECTION D'ETAT D'UNE ANNEE A L'AUTRE : un troncon non retenu garde son etat courant l'annee
 *     suivante. Le risque attendu de chaque annee projette sa propre degradation sur l'horizon des parametres
 *     (parametres.noyau), mais l'etat n'est pas modifie pour l'annee d'apres.
 *   - AUCUN COUT INDEXE : les baremes de chaque annee sont ceux dont la fenetre de validite couvre cette annee,
 *     tels quels (aucune inflation, aucune actualisation : aucune source).
 *   - PAS D'ENVELOPPE PAR SOURCE, pas d'equite regionale minimale, pas de continuite d'itineraire, pas de fenetre
 *     saisonniere (conception 5.1) : seuls des plafonds regionaux annuels optionnels, saisis par l'utilisateur.
 *   - AUCUN ENGAGEMENT : comme le PAE, un PPE ne cree ni marche, ni contrat, ni ordre de travaux, ni chantier.
 *
 * ETIQUETTE : le plan est « PROVISOIRE, non approuve » des qu'une annee l'est (parametres non approuves,
 * bareme provisoire, catalogue non approuve...). Chaque motif est repris, prefixe par son annee.
 *
 * DETERMINISME : « memes entrees, meme sortie, octet pour octet ». Aucune horloge ni hasard ; les entrees
 * sont serialisees dans un ordre normalise (`entreesPpeVersJson`) ; l'ordre des tableaux d'entree n'a aucune
 * influence parce que chaque scenario annuel a un ordre total (scenario.noyau).
 */

import type { LigneBareme } from "../engines/cout.noyau";
import type { ConditionTraitement, LigneMatrice, Traitement } from "../engines/traitement.noyau";
import { etiquetteParametres, sontProvisoires, validerParametres, type ParametresProgrammation } from "./parametres.noyau";
import {
  AVERTISSEMENT_SANS_ENGAGEMENT, construireScenario, entreesDepuisJson, entreesVersJson, validerEntrees,
  type CandidatTroncon, type EntreesScenario, type Scenario,
} from "./scenario.noyau";

export const METHODE_PPE = { id: "ppe-glouton-chaine-annuel", version: "1" } as const;

/** Un plan de moins de deux annees est un PAE : il se calcule par le scenario annuel. */
export const MIN_ANNEES_PPE = 2;
/** Conception 5.1 : « PPE glissant 3-5 ans ». Borne explicite, et non une mesure de capacite. */
export const MAX_ANNEES_PPE = 5;
/**
 * Plafond de candidats d'un PPE. Chaque annee porte son scenario complet (une justification par ligne) : au-dela,
 * cinq scenarios de 3000 lignes seraient illisibles et lourds. Choix de protection, non mesure sur un reseau reel.
 */
export const MAX_CANDIDATS_PPE = 500;

export interface EnveloppeAnnuelle {
  annee: number;
  /** Enveloppe SAISIE de l'annee, en GNF entiers. 0 est une saisie valide. */
  budgetGnf: bigint;
  /** Plafonds regionaux optionnels de CETTE annee (cle = identifiant de region), saisis par l'utilisateur. */
  plafondsRegionauxGnf: Record<string, bigint>;
  /** Lignes de bareme applicables a cette annee (fenetre de validite), choisies par le depot. */
  baremes: LigneBareme[];
}

export interface EntreesPpe {
  anneeDebut: number;
  /** Une enveloppe par annee, consecutives a partir de `anneeDebut`. */
  enveloppes: EnveloppeAnnuelle[];
  parametres: ParametresProgrammation;
  candidats: CandidatTroncon[];
  catalogue: Traitement[];
  conditions: ConditionTraitement[];
  matrices: LigneMatrice[];
}

export interface AnneePpe {
  annee: number;
  enveloppeGnf: string;
  /** Candidats examines cette annee : ceux qui n'ont pas ete retenus avant. */
  candidatsEntrants: number;
  /** Troncons retenus les annees precedentes, donc non reexamines. */
  dejaRetenusAvant: number;
  scenario: Scenario;
}

export interface TronconRetenuPpe {
  tronconId: string;
  code: string;
  regionId: number | null;
  anneeRetenue: number;
  rangRetenu: number;
  montantGnf: string;
  traitement: string;
}

export interface SynthesePpe {
  enveloppeTotaleGnf: string;
  engageTotalGnf: string;
  resteTotalGnf: string;
  candidats: number;
  retenus: number;
  nonRetenus: number;
  /** Motif d'exclusion de la DERNIERE annee, pour les troncons jamais retenus. */
  nonRetenusParMotif: Record<string, number>;
  parAnnee: { annee: number; enveloppeGnf: string; engageGnf: string; resteGnf: string; retenues: number; ecartees: number; candidatsEntrants: number }[];
  tronconsRetenus: TronconRetenuPpe[];
}

export interface PlanPluriannuel {
  methode: { id: string; version: string };
  anneeDebut: number;
  nbAnnees: number;
  parametres: { version: string; source: string; approuveeLe: string | null; etiquette: string };
  provisoire: boolean;
  etiquette: string;
  motifsProvisoire: string[];
  limites: string[];
  avertissement: string;
  synthese: SynthesePpe;
  annees: AnneePpe[];
}

export type ResultatPpe = { ok: true; plan: PlanPluriannuel } | { ok: false; code: "ENTREES_INVALIDES"; erreurs: string[] };

const LIMITES_PPE: readonly string[] = [
  "Méthode gloutonne et déterministe, année par année : ce n'est pas un optimum pluriannuel, aucune optimisation (PLNE) n'est faite.",
  "Chaque enveloppe annuelle est celle saisie par l'utilisateur : le plan ne répartit aucun budget total, ne reporte aucun reste d'une année sur l'autre et n'indexe aucun montant.",
  "Un tronçon retenu une année n'est plus candidat les années suivantes : une seule intervention par tronçon sur l'horizon du plan.",
  "L'état d'un tronçon non retenu n'est pas projeté d'une année à l'autre : il garde son état courant l'année suivante.",
  "Les barèmes de chaque année sont ceux dont la fenêtre de validité couvre cette année, sans indexation ni actualisation.",
  "Pas d'enveloppe par source de financement, pas d'équité régionale minimale, pas de continuité d'itinéraire, pas de fenêtre saisonnière : seuls des plafonds régionaux annuels saisis.",
];

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

export function validerEntreesPpe(e: EntreesPpe): string[] {
  const err: string[] = [];
  if (!Number.isInteger(e.anneeDebut) || e.anneeDebut < 2000 || e.anneeDebut > 2100) err.push("anneeDebut : entier entre 2000 et 2100 attendu");
  if (!Array.isArray(e.enveloppes)) { err.push("enveloppes : tableau attendu"); return err; }
  if (e.enveloppes.length < MIN_ANNEES_PPE || e.enveloppes.length > MAX_ANNEES_PPE) {
    err.push(`enveloppes : ${MIN_ANNEES_PPE} à ${MAX_ANNEES_PPE} années attendues, ${e.enveloppes.length} reçue(s) (un plan d'une seule année est un PAE)`);
  }
  e.enveloppes.forEach((env, i) => {
    if (env.annee !== e.anneeDebut + i) err.push(`enveloppes[${i}] : année ${env.annee} attendue ${e.anneeDebut + i} (années consécutives à partir du début)`);
    if (typeof env.budgetGnf !== "bigint" || env.budgetGnf < 0n) err.push(`enveloppes[${i}].budgetGnf : bigint >= 0 attendu`);
    if (!Array.isArray(env.baremes)) err.push(`enveloppes[${i}].baremes : tableau attendu`);
    for (const [k, v] of Object.entries(env.plafondsRegionauxGnf ?? {})) {
      if (typeof v !== "bigint" || v < 0n) err.push(`enveloppes[${i}].plafondsRegionauxGnf.${k} : bigint >= 0 attendu`);
    }
  });
  if (e.anneeDebut + e.enveloppes.length - 1 > 2100) err.push("la dernière année du plan dépasse 2100");
  const p = validerParametres(e.parametres);
  if (!p.ok) err.push(...p.erreurs.map((x) => `parametres : ${x}`));
  if (Array.isArray(e.candidats) && e.candidats.length > MAX_CANDIDATS_PPE) {
    err.push(`candidats : ${e.candidats.length} dépasse le plafond de ${MAX_CANDIDATS_PPE} d'un plan pluriannuel (restreindre le périmètre)`);
  }
  // Le reste (candidats, catalogue...) est valide par le scenario annuel lui-meme, avec son propre message.
  if (err.length === 0 && e.enveloppes.length > 0) {
    err.push(...validerEntrees(entreesAnnee(e, 0, e.candidats)));
  }
  return err;
}

function entreesAnnee(e: EntreesPpe, i: number, candidats: CandidatTroncon[]): EntreesScenario {
  const env = e.enveloppes[i];
  return {
    annee: env.annee,
    budgetGnf: env.budgetGnf,
    plafondsRegionauxGnf: env.plafondsRegionauxGnf ?? {},
    parametres: e.parametres,
    candidats,
    baremes: env.baremes,
    catalogue: e.catalogue,
    conditions: e.conditions,
    matrices: e.matrices,
  };
}

// ---------------------------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------------------------

/**
 * Chaine les scenarios annuels. Fonction pure : deux appels avec les memes entrees rendent deux plans dont
 * `canonique()` est identique octet pour octet.
 */
export function construirePlan(entrees: EntreesPpe): ResultatPpe {
  const erreurs = validerEntreesPpe(entrees);
  if (erreurs.length > 0) return { ok: false, code: "ENTREES_INVALIDES", erreurs };

  const retenusAvant = new Map<string, true>();
  const tronconsRetenus: TronconRetenuPpe[] = [];
  const annees: AnneePpe[] = [];
  let engageTotal = 0n;
  let enveloppeTotale = 0n;

  for (let i = 0; i < entrees.enveloppes.length; i++) {
    const env = entrees.enveloppes[i];
    const restants = entrees.candidats.filter((c) => !retenusAvant.has(c.id));
    const r = construireScenario(entreesAnnee(entrees, i, restants));
    if (!r.ok) return { ok: false, code: "ENTREES_INVALIDES", erreurs: r.erreurs.map((x) => `année ${env.annee} : ${x}`) };

    for (const l of r.scenario.lignes) {
      if (l.decision !== "RETENUE") continue;
      retenusAvant.set(l.troncon.id, true);
      tronconsRetenus.push({
        tronconId: l.troncon.id, code: l.troncon.code, regionId: l.troncon.regionId, anneeRetenue: env.annee,
        rangRetenu: l.rangRetenu as number,
        montantGnf: (l.cout as { montantGnf: string }).montantGnf,
        traitement: (l.traitement as { ok: true; traitement: { code: string } }).traitement.code,
      });
    }
    engageTotal += BigInt(r.scenario.totaux.engageGnf);
    enveloppeTotale += env.budgetGnf;
    annees.push({
      annee: env.annee,
      enveloppeGnf: env.budgetGnf.toString(),
      candidatsEntrants: restants.length,
      dejaRetenusAvant: entrees.candidats.length - restants.length,
      scenario: r.scenario,
    });
  }

  // Les troncons jamais retenus, avec le motif de la DERNIERE annee (celui qui les a laisses de cote en fin de plan).
  const derniere = annees[annees.length - 1].scenario;
  const nonRetenusParMotif: Record<string, number> = {};
  for (const l of derniere.lignes) {
    if (l.decision === "ECARTEE" && l.motifExclusion) nonRetenusParMotif[l.motifExclusion.code] = (nonRetenusParMotif[l.motifExclusion.code] ?? 0) + 1;
  }

  const motifsProvisoire: string[] = [];
  for (const a of annees) for (const m of a.scenario.motifsProvisoire) motifsProvisoire.push(`${a.annee} : ${m}`);
  const provisoire = annees.some((a) => a.scenario.provisoire) || sontProvisoires(entrees.parametres);
  if (provisoire && motifsProvisoire.length === 0) motifsProvisoire.push(`paramètres de programmation non approuvés (version ${entrees.parametres.version}, source ${entrees.parametres.source})`);

  const p = entrees.parametres;
  const plan: PlanPluriannuel = {
    methode: { ...METHODE_PPE },
    anneeDebut: entrees.anneeDebut,
    nbAnnees: entrees.enveloppes.length,
    parametres: { version: p.version, source: p.source, approuveeLe: p.approuveeLe, etiquette: etiquetteParametres(p) },
    provisoire,
    etiquette: provisoire ? "PROVISOIRE, non approuvé" : "paramètres et barèmes approuvés",
    motifsProvisoire,
    limites: [...LIMITES_PPE],
    avertissement: AVERTISSEMENT_SANS_ENGAGEMENT,
    synthese: {
      enveloppeTotaleGnf: enveloppeTotale.toString(),
      engageTotalGnf: engageTotal.toString(),
      resteTotalGnf: (enveloppeTotale - engageTotal).toString(),
      candidats: entrees.candidats.length,
      retenus: tronconsRetenus.length,
      nonRetenus: entrees.candidats.length - tronconsRetenus.length,
      nonRetenusParMotif,
      parAnnee: annees.map((a) => ({
        annee: a.annee, enveloppeGnf: a.enveloppeGnf, engageGnf: a.scenario.totaux.engageGnf, resteGnf: a.scenario.totaux.resteGnf,
        retenues: a.scenario.totaux.retenues, ecartees: a.scenario.totaux.ecartees, candidatsEntrants: a.candidatsEntrants,
      })),
      tronconsRetenus,
    },
    annees,
  };
  return { ok: true, plan };
}

// ---------------------------------------------------------------------------------------------
// Serialisation des entrees (pour stocker un plan et le rejouer)
// ---------------------------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const tab = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Entrees en JSON pur, ordre normalise : deux jeux identiques a l'ordre pres donnent le meme texte. */
export function entreesPpeVersJson(e: EntreesPpe): Json {
  const commun = obj(entreesVersJson(entreesAnnee(e, 0, e.candidats)));
  return {
    anneeDebut: e.anneeDebut,
    nbAnnees: e.enveloppes.length,
    enveloppes: e.enveloppes.map((env, i) => {
      const a = obj(entreesVersJson(entreesAnnee(e, i, [])));
      return { annee: env.annee, budgetGnf: a.budgetGnf as string, plafondsRegionauxGnf: a.plafondsRegionauxGnf as Json, baremes: a.baremes as Json };
    }),
    parametres: commun.parametres as Json,
    candidats: commun.candidats as Json,
    catalogue: commun.catalogue as Json,
    conditions: commun.conditions as Json,
    matrices: commun.matrices as Json,
  };
}

/** Relit des entrees stockees ; tout contenu inattendu est refuse (les bigint sont des chaines de chiffres). */
export function entreesPpeDepuisJson(j: unknown): { ok: true; entrees: EntreesPpe } | { ok: false; erreurs: string[] } {
  const o = obj(j);
  const enveloppesBrutes = tab(o.enveloppes).map(obj);
  if (enveloppesBrutes.length === 0) return { ok: false, erreurs: ["enveloppes : tableau non vide attendu"] };
  const erreurs: string[] = [];
  const enveloppes: EnveloppeAnnuelle[] = [];
  let base: EntreesScenario | null = null;
  enveloppesBrutes.forEach((eb, i) => {
    const r = entreesDepuisJson({
      annee: eb.annee, budgetGnf: eb.budgetGnf, plafondsRegionauxGnf: eb.plafondsRegionauxGnf, baremes: eb.baremes,
      parametres: o.parametres, candidats: o.candidats, catalogue: o.catalogue, conditions: o.conditions, matrices: o.matrices,
    });
    if (!r.ok) { erreurs.push(...r.erreurs.map((x) => `enveloppes[${i}] : ${x}`)); return; }
    if (base === null) base = r.entrees;
    enveloppes.push({ annee: r.entrees.annee, budgetGnf: r.entrees.budgetGnf, plafondsRegionauxGnf: r.entrees.plafondsRegionauxGnf, baremes: r.entrees.baremes });
  });
  if (erreurs.length > 0 || base === null) return { ok: false, erreurs };
  const b: EntreesScenario = base;
  const entrees: EntreesPpe = {
    anneeDebut: o.anneeDebut as number, enveloppes, parametres: b.parametres, candidats: b.candidats,
    catalogue: b.catalogue, conditions: b.conditions, matrices: b.matrices,
  };
  const invalides = validerEntreesPpe(entrees);
  if (invalides.length > 0) return { ok: false, erreurs: invalides };
  return { ok: true, entrees };
}
