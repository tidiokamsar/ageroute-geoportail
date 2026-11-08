/**
 * COMPARAISON DE SCENARIOS DU SIMULATEUR : un tableau cote a cote, sans aucune ecriture. Aucun import de base,
 * aucune horloge.
 *
 * CE QUE LA COMPARAISON REFUSE
 *
 *   - moins de 2 ou plus de 5 scenarios, ou deux fois le meme ;
 *   - un scenario HERITE (calcule avant le simulateur) : il n'a ni periode, ni devise, ni deficit ; l'assimiler a une
 *     periode « annee entiere » serait inventer une donnee. Il faut le relancer depuis l'onglet Simulation ;
 *   - des scenarios de PERIODES ou de DEVISES differentes : leurs enveloppes ne se comparent pas. Le refus dit lesquelles.
 *
 * CE QU'ELLE SIGNALE SANS REFUSER : des PERIMETRES differents (region, classe de route, selection d'interventions). Comparer la
 * region 1 a la region 2 est legitime, mais un deficit, une enveloppe ou un nombre d'interventions ne portent alors pas sur les
 * memes troncons : le tableau le dit (hypotheses `region`, `classe`, `selection`, `perimetresIdentiques`, `avertissements`)
 * au lieu de laisser croire a une comparaison toutes choses egales. Un perimetre non fourni est DIT, jamais lu comme « national ».
 *
 * CE QU'ELLE MONTRE, sans moyenne ni classement qui n'existe pas : enveloppe, consomme, reste, besoin, deficit (jamais
 * masque), nombre d'interventions, kilometres (longueur METIER ; si elle manque, la colonne le dit et la longueur
 * geometrique n'est jamais substituee), risque couvert, distribution regionale, exclusions par motif, version des
 * parametres et des baremes, et les HYPOTHESES qui different d'un scenario a l'autre.
 *
 * Le calcul lit les resultats DEJA scelles : il ne recalcule rien et ne touche ni budget, ni marche, ni donnee officielle.
 */

import { MENTION_SIMULATION } from "./deficit.noyau";
import type { ResultatSimulation, Scenario } from "./scenario.noyau";

export interface ScenarioComparable {
  id: string;
  intitule: string;
  creeParId: string;
  /** Date ISO de creation (colonne `creeLe`). */
  creeLe: string;
  empreinteResultat: string;
  resultat: Scenario;
  /**
   * Perimetre du calcul (colonne `perimetre` du scenario scelle : region, classe de route, selection d'interventions). Absent ou
   * illisible : « non precise » (jamais assimile a un calcul national).
   */
  perimetre?: { regionId?: number | null; classe?: string | null; selection?: readonly string[] | null } | null;
}

export const MIN_SCENARIOS = 2;
export const MAX_SCENARIOS = 5;

export type CodeRefusComparaison = "NOMBRE_INVALIDE" | "DOUBLON" | "SCENARIO_SANS_SIMULATION" | "PERIODES_INCOMPATIBLES" | "DEVISES_INCOMPATIBLES";

export interface ColonneComparaison {
  id: string;
  intitule: string;
  creeParId: string;
  creeLe: string;
  annee: number;
  periode: { debut: string; fin: string };
  devise: string;
  logique: { code: string; libelle: string };
  etiquette: string;
  provisoire: boolean;
  enveloppeGnf: string;
  consommeGnf: string;
  resteGnf: string;
  besoinTotalGnf: string;
  deficitGnf: string;
  soldeGnf: string;
  deficitMinorant: boolean;
  nbCoutsNonFiables: number;
  nbCandidats: number;
  nbInterventions: number;
  nbEcartees: number;
  kilometres: ResultatSimulation["kilometres"];
  risqueCouvert: ResultatSimulation["risqueCouvert"];
  distributionRegionale: ResultatSimulation["distributionRegionale"];
  exclusionsParMotif: Record<string, number>;
  parametresVersion: string;
  baremes: { empreinte: string; nbLignes: number; nbApprouvees: number };
  nbContraintesInsatisfaisables: number;
  avertissements: string[];
  /** Perimetre du calcul : `null` en bloc quand il n'est pas connu. */
  perimetre: { regionId: number | null; classe: string | null; nbSelection: number | null } | null;
}

export interface DifferenceHypothese {
  champ: string;
  libelle: string;
  /** Une valeur lisible par scenario, dans l'ordre des colonnes. */
  valeurs: string[];
  identiques: boolean;
}

export interface Comparaison {
  mention: string;
  periode: { debut: string; fin: string };
  devise: string;
  scenarios: ColonneComparaison[];
  hypotheses: DifferenceHypothese[];
  /** Vrai si tous les scenarios portent sur le MEME perimetre (region, classe, selection) et que ce perimetre est connu pour tous. */
  perimetresIdentiques: boolean;
  /** Avertissements de comparabilite (perimetres differents). Vide quand rien n'est a signaler. */
  avertissements: string[];
  /** Interventions retenues : communes a tous, et propres a chaque scenario (comptes, jamais des pourcentages inventes). */
  interventions: { communes: number; propres: { id: string; nb: number }[] };
}

export type ResultatComparaison = { ok: true; comparaison: Comparaison } | { ok: false; code: CodeRefusComparaison; message: string };

const gnf = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, " ");

/** Perimetre normalise d'un scenario ; `null` si non fourni. La selection est triee : l'ordre ne fait pas un autre perimetre. */
interface PerimetreNormalise { regionId: number | null; classe: string | null; selection: string[] | null }
function perimetreDe(s: ScenarioComparable): PerimetreNormalise | null {
  const p = s.perimetre;
  if (p === null || p === undefined || typeof p !== "object") return null;
  const regionId = typeof p.regionId === "number" ? p.regionId : null;
  const classe = typeof p.classe === "string" && p.classe !== "" ? p.classe : null;
  const selection = Array.isArray(p.selection) && p.selection.length > 0 ? [...new Set(p.selection as string[])].sort() : null;
  return { regionId, classe, selection };
}
const NON_PRECISE = "périmètre non précisé";
const libelleRegion = (p: PerimetreNormalise | null) => (p === null ? NON_PRECISE : p.regionId === null ? "toutes les régions" : `région ${p.regionId}`);
const libelleClasse = (p: PerimetreNormalise | null) => (p === null ? NON_PRECISE : p.classe === null ? "toutes les classes" : p.classe);
const libelleSelection = (p: PerimetreNormalise | null) => (p === null ? NON_PRECISE : p.selection === null ? "tous les candidats du périmètre" : `${p.selection.length} intervention${p.selection.length > 1 ? "s" : ""} sélectionnée${p.selection.length > 1 ? "s" : ""}`);
const cleSelection = (p: PerimetreNormalise | null) => (p === null ? NON_PRECISE : p.selection === null ? "tous" : p.selection.join("|"));

function colonne(s: ScenarioComparable, sim: ResultatSimulation): ColonneComparaison {
  const r = s.resultat;
  return {
    id: s.id, intitule: s.intitule, creeParId: s.creeParId, creeLe: s.creeLe, annee: r.annee, periode: { ...sim.periode }, devise: sim.devise,
    logique: { code: sim.logique.code, libelle: sim.logique.libelle }, etiquette: r.etiquette, provisoire: r.provisoire,
    enveloppeGnf: sim.bilan.enveloppeGnf, consommeGnf: sim.bilan.consommeGnf, resteGnf: sim.bilan.resteGnf, besoinTotalGnf: sim.bilan.besoinTotalGnf,
    deficitGnf: sim.bilan.deficitGnf, soldeGnf: sim.bilan.soldeGnf, deficitMinorant: sim.bilan.deficitMinorant, nbCoutsNonFiables: sim.bilan.nbCoutsNonFiables,
    nbCandidats: r.totaux.candidats, nbInterventions: r.totaux.retenues, nbEcartees: r.totaux.ecartees,
    kilometres: sim.kilometres, risqueCouvert: sim.risqueCouvert, distributionRegionale: sim.distributionRegionale,
    exclusionsParMotif: r.totaux.ecartesParMotif, parametresVersion: sim.parametresVersion,
    baremes: { empreinte: sim.baremes.empreinte, nbLignes: sim.baremes.nbLignes, nbApprouvees: sim.baremes.nbApprouvees },
    nbContraintesInsatisfaisables: sim.contraintes.insatisfaisables.length, avertissements: sim.avertissements.map((a) => a.code),
    perimetre: (() => { const p = perimetreDe(s); return p === null ? null : { regionId: p.regionId, classe: p.classe, nbSelection: p.selection === null ? null : p.selection.length }; })(),
  };
}

/** Avertissements de comparabilite : un par critere de perimetre qui differe, ou un seul si un perimetre n'est pas connu. */
function avertissementsPerimetre(perimetres: readonly (PerimetreNormalise | null)[]): string[] {
  if (perimetres.some((p) => p === null)) {
    return ["Périmètre non précisé pour au moins un scénario : on ne peut pas dire s'ils portent sur les mêmes tronçons. Ne comparez pas leurs déficits comme s'ils étaient comparables."];
  }
  const ps = perimetres as PerimetreNormalise[];
  const criteres: string[] = [];
  if (new Set(ps.map((p) => p.regionId)).size > 1) criteres.push("région");
  if (new Set(ps.map((p) => p.classe)).size > 1) criteres.push("classe de route");
  if (new Set(ps.map((p) => cleSelection(p))).size > 1) criteres.push("sélection d'interventions");
  if (criteres.length === 0) return [];
  return [`Périmètres différents (${criteres.join(", ")}) : ces scénarios ne portent pas sur les mêmes tronçons. Leurs enveloppes, déficits et nombres d'interventions ne sont pas comparables toutes choses égales ; voir les hypothèses région, classe et sélection.`];
}

function hypotheses(cols: readonly ColonneComparaison[], sims: readonly ResultatSimulation[], res: readonly Scenario[], perimetres: readonly (PerimetreNormalise | null)[]): DifferenceHypothese[] {
  const ligne = (champ: string, libelle: string, valeurs: string[]): DifferenceHypothese => ({ champ, libelle, valeurs, identiques: valeurs.every((v) => v === valeurs[0]) });
  const liste = (l: readonly string[]) => (l.length === 0 ? "aucun" : l.join(", "));
  return [
    ligne("logique", "Logique de priorité", sims.map((s) => s.logique.libelle)),
    ligne("enveloppe", "Enveloppe (GNF)", cols.map((c) => gnf(c.enveloppeGnf))),
    ligne("parametres", "Version des paramètres", cols.map((c) => c.parametresVersion)),
    ligne("baremes", "Version des barèmes (empreinte)", cols.map((c) => c.baremes.empreinte.slice(0, 12))),
    ligne("plafonds", "Plafonds régionaux (GNF)", sims.map((s) => { const e = Object.entries(s.contraintes.plafondsRegionauxGnf).sort(([a], [b]) => (a < b ? -1 : 1)); return e.length === 0 ? "aucun" : e.map(([k, v]) => `région ${k} : ${gnf(v)}`).join(" ; "); })),
    ligne("obligatoires", "Interventions obligatoires", sims.map((s) => liste(s.contraintes.obligatoires.demandees))),
    ligne("groupes", "Groupes non divisibles", sims.map((s) => (s.contraintes.groupesNonDivisibles.length === 0 ? "aucun" : s.contraintes.groupesNonDivisibles.map((g) => `[${g.membres.join(", ")}]`).join(" ")))),
    ligne("equilibre", "Part minimale par région", sims.map((s) => (s.logique.equilibre === null ? "aucune" : `${s.logique.equilibre.partMinimaleParRegionPct} %`))),
    ligne("ordre", "Ordre personnalisé", sims.map((s) => liste(s.logique.ordrePersonnalise))),
    ligne("candidats", "Candidats examinés", res.map((r) => String(r.totaux.candidats))),
    // Le perimetre : un scenario de la region 1 et un de la region 2 ne se comparent pas toutes choses egales.
    { champ: "region", libelle: "Région", valeurs: perimetres.map(libelleRegion), identiques: perimetres.every((p) => p !== null) && new Set(perimetres.map((p) => (p as PerimetreNormalise).regionId)).size === 1 },
    { champ: "classe", libelle: "Classe de route", valeurs: perimetres.map(libelleClasse), identiques: perimetres.every((p) => p !== null) && new Set(perimetres.map((p) => (p as PerimetreNormalise).classe)).size === 1 },
    { champ: "selection", libelle: "Sélection d'interventions", valeurs: perimetres.map(libelleSelection), identiques: perimetres.every((p) => p !== null) && new Set(perimetres.map(cleSelection)).size === 1 },
  ];
}

export function comparerScenarios(scenarios: readonly ScenarioComparable[]): ResultatComparaison {
  if (scenarios.length < MIN_SCENARIOS || scenarios.length > MAX_SCENARIOS) {
    return { ok: false, code: "NOMBRE_INVALIDE", message: `la comparaison porte sur ${MIN_SCENARIOS} à ${MAX_SCENARIOS} scénarios (${scenarios.length} fournis)` };
  }
  if (new Set(scenarios.map((s) => s.id)).size !== scenarios.length) return { ok: false, code: "DOUBLON", message: "un scénario ne se compare pas à lui-même : identifiant en double" };
  const sims: ResultatSimulation[] = [];
  for (const s of scenarios) {
    const sim = s.resultat.simulation;
    if (!sim) {
      return { ok: false, code: "SCENARIO_SANS_SIMULATION", message: `le scénario « ${s.intitule} » a été calculé avant le simulateur : il n'a ni période, ni devise, ni déficit et ne peut pas être comparé. Relancez-le depuis l'onglet Simulation.` };
    }
    sims.push(sim);
  }
  const devises = [...new Set(sims.map((s) => s.devise))];
  if (devises.length > 1) return { ok: false, code: "DEVISES_INCOMPATIBLES", message: `devises différentes (${devises.join(", ")}) : les enveloppes ne se comparent pas` };
  const periodes = [...new Set(sims.map((s) => `${s.periode.debut} à ${s.periode.fin}`))];
  if (periodes.length > 1) {
    return { ok: false, code: "PERIODES_INCOMPATIBLES", message: `périodes différentes (${periodes.join(" ; ")}) : une enveloppe de période courte et une de période longue ne se comparent pas. Choisissez des scénarios de même période.` };
  }
  const cols = scenarios.map((s, i) => colonne(s, sims[i]));
  const perimetres = scenarios.map(perimetreDe);
  const avertissements = avertissementsPerimetre(perimetres);
  const retenues = scenarios.map((s) => new Set(s.resultat.lignes.filter((l) => l.decision === "RETENUE").map((l) => l.troncon.id)));
  const communes = [...retenues[0]].filter((id) => retenues.every((r) => r.has(id)));
  const propres = scenarios.map((s, i) => ({ id: s.id, nb: [...retenues[i]].filter((id) => retenues.every((r, j) => j === i || !r.has(id))).length }));
  return {
    ok: true,
    comparaison: {
      mention: MENTION_SIMULATION, periode: { ...sims[0].periode }, devise: sims[0].devise, scenarios: cols,
      hypotheses: hypotheses(cols, sims, scenarios.map((s) => s.resultat), perimetres), perimetresIdentiques: avertissements.length === 0, avertissements,
      interventions: { communes: communes.length, propres },
    },
  };
}
