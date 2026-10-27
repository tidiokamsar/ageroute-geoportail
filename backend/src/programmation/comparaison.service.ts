/**
 * SERVICE DU SIMULATEUR BUDGETAIRE (AD-LOT-4) : preparer les entrees, simuler, enregistrer, comparer, exporter.
 *
 * Il lit la base (depots), fait calculer les noyaux (`scenario.noyau`, `comparaison.noyau`, `export-scenario.noyau`) et
 * n'ecrit QU'UNE chose : un scenario dans `scenarios_programmation` (audite dans la meme transaction). Simuler sans
 * enregistrer, comparer et exporter n'ecrivent rien dans les tables du moteur ; l'export est journalise dans l'audit.
 *
 * AUCUNE ECRITURE DANS LES DONNEES OFFICIELLES (cahier AD-08) : ni `programmes_budgetaires`, ni `chantiers`, ni `marches`,
 * ni `decomptes`, ni `baremes_intervention`. Ce service n'a d'ailleurs aucun acces ecriture a ces tables : le seul INSERT
 * est `moteur.depot.insererScenario`.
 *
 * Le rejeu et la suppression logique d'un scenario du simulateur passent par `moteur.service` (`rejouer`,
 * `supprimerScenario`) : `construireScenario` relit le bloc `simulation` des entrees stockees, le rejeu est donc identique.
 */

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { logAuditTransactionnelle } from "../utils/audit";
import { canonique, sha256Hex } from "./canonique";
import { versionBaremes, motifPeremption } from "./comparaison.baremes.noyau";
import * as dep from "./comparaison.depot";
import { comparerScenarios, MAX_SCENARIOS, MIN_SCENARIOS, type ScenarioComparable } from "./comparaison.noyau";
import { VERSION_OPTIONS, type OptionsSimulation } from "./contraintes.noyau";
import { construireExport, versCsv, type MetaExport } from "./export-scenario.noyau";
import type { CodeLogique } from "./logiques.noyau";
import * as depot from "./moteur.depot";
import { RefusMoteur, choisirParametres, type Client, type Contexte } from "./moteur.service";
import { validerParametres } from "./parametres.noyau";
import { MAX_CANDIDATS, construireScenario, entreesVersJson, type EntreesScenario, type Scenario } from "./scenario.noyau";
import { blocEffectif } from "./priorite.noyau";

const ISOLATION = { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000, maxWait: 10_000 } as const;

export interface DemandeSimulateur {
  annee: number;
  budgetGnf: bigint;
  periode: { debut: string; fin: string };
  regionId?: number | null;
  classe?: string | null;
  /** Sous-ensemble des candidats du perimetre ; absent = tous. */
  selection?: string[] | null;
  plafondsRegionauxGnf?: Record<string, bigint>;
  parametresId?: string | null;
  logique: CodeLogique;
  ordrePersonnalise?: string[];
  equilibre?: { partMinimaleParRegionPct: number } | null;
  obligatoires?: string[];
  groupesNonDivisibles?: string[][];
  /** Lignes de bareme designees ; absent = les baremes applicables de chaque cle. */
  baremeIds?: number[] | null;
}

/**
 * Lit tout ce que le calcul consomme, dans la transaction appelante (un seul instantane), et construit les entrees avec le
 * bloc `simulation` versionne.
 */
export async function preparerEntrees(db: depot.Db, d: DemandeSimulateur, parametres: EntreesScenario["parametres"]): Promise<EntreesScenario> {
  // Meme regle que la liste priorisee (lot 3) : le minimum de points noirs vient de la version de parametres choisie.
  const lus = await depot.chargerCandidats(db, {
    regionId: d.regionId ?? null, classe: d.classe ?? null, limite: MAX_CANDIDATS + 1,
    registrePointsNoirsMinimum: blocEffectif(parametres).bloc.registrePointsNoirsMinimum,
  });
  if (lus.length > MAX_CANDIDATS) {
    throw new RefusMoteur("PERIMETRE_TROP_LARGE", `plus de ${MAX_CANDIDATS} tronçons candidats : restreignez le périmètre (région, classe de route) ou sélectionnez des interventions`, 422);
  }
  let candidats = lus;
  const selection = d.selection && d.selection.length > 0 ? [...new Set(d.selection)] : null;
  if (selection !== null) {
    const connus = new Set(lus.map((c) => c.id));
    const inconnus = selection.filter((id) => !connus.has(id));
    // Meme message pour un identifiant inexistant et pour un troncon d'une autre region : aucun oracle d'existence.
    if (inconnus.length > 0) throw new RefusMoteur("SELECTION_INVALIDE", `${inconnus.length} intervention(s) sélectionnée(s) ne sont pas des candidats du périmètre choisi`, 422);
    const voulus = new Set(selection);
    candidats = lus.filter((c) => voulus.has(c.id));
  }

  const { baremes, refs } = await dep.chargerBaremesSimulation(db, d.periode, d.baremeIds ?? null);
  if (d.baremeIds && d.baremeIds.length > 0) {
    const trouves = new Set(baremes.map((b) => Number(b.id)));
    const manquants = [...new Set(d.baremeIds)].filter((id) => !trouves.has(id));
    if (manquants.length > 0) throw new RefusMoteur("BAREMES_INTROUVABLES", `barème(s) ${manquants.join(", ")} introuvable(s), inactif(s) ou en double pour une même famille, un même état et un même type`, 422);
  }

  const simulation: OptionsSimulation = {
    version: VERSION_OPTIONS,
    periode: { debut: d.periode.debut, fin: d.periode.fin },
    devise: "GNF",
    logique: d.logique,
    ordrePersonnalise: d.ordrePersonnalise ?? [],
    equilibre: d.equilibre ?? null,
    obligatoires: d.obligatoires ?? [],
    groupesNonDivisibles: d.groupesNonDivisibles ?? [],
    baremes: versionBaremes(refs),
    rangsTechniques: null,
    perimetre: { regionId: d.regionId ?? null, classe: d.classe ?? null, selection },
  };
  return {
    annee: d.annee, budgetGnf: d.budgetGnf, plafondsRegionauxGnf: d.plafondsRegionauxGnf ?? {}, parametres, candidats, baremes,
    catalogue: await depot.chargerCatalogue(db), conditions: await depot.chargerConditions(db), matrices: await depot.chargerMatrices(db), simulation,
  };
}

async function calculer(tx: depot.Db, d: DemandeSimulateur) {
  const ligne = await choisirParametres(tx, d.parametresId ?? null);
  const parametres = depot.parametresDeLigne(ligne);
  const valides = validerParametres(parametres);
  if (!valides.ok) throw new RefusMoteur("PARAMETRES_INVALIDES", valides.erreurs.join(" ; "), 422);
  const entrees = await preparerEntrees(tx, d, parametres);
  const r = construireScenario(entrees);
  if (!r.ok) throw new RefusMoteur(r.code, r.erreurs.join(" ; "), 422);
  const entreesCanoniques = canonique(entreesVersJson(entrees));
  const resultatCanonique = canonique(r.scenario);
  return { ligne, parametres, entrees, scenario: r.scenario, entreesCanoniques, resultatCanonique };
}

/** Calcule SANS rien ecrire : l'utilisateur voit le resultat avant de decider de l'enregistrer. */
export async function simulerSansEnregistrer(client: Client, d: DemandeSimulateur): Promise<{ resultat: Scenario; empreinteEntrees: string; empreinteResultat: string; enregistre: false }> {
  return client.$transaction(async (tx) => {
    const c = await calculer(tx, d);
    return { resultat: c.scenario, empreinteEntrees: sha256Hex(c.entreesCanoniques), empreinteResultat: sha256Hex(c.resultatCanonique), enregistre: false as const };
  }, ISOLATION);
}

/** Calcule et ENREGISTRE le scenario (immuable, audite dans la meme transaction). Aucune autre table n'est ecrite. */
export async function enregistrer(client: Client, d: DemandeSimulateur & { intitule: string }, ctx: Contexte) {
  return client.$transaction(async (tx) => {
    const c = await calculer(tx, d);
    const perimetre = canonique({
      regionId: d.regionId ?? null, classe: d.classe ?? null,
      plafondsRegionauxGnf: Object.fromEntries(Object.entries(d.plafondsRegionauxGnf ?? {}).map(([k, v]) => [k, v.toString()])),
      selection: c.entrees.simulation?.perimetre.selection ?? null, simulateur: VERSION_OPTIONS,
    });
    const id = randomUUID();
    const resume = await depot.insererScenario(tx, {
      id, annee: d.annee, intitule: d.intitule, parametresId: c.ligne.id, parametresVersion: c.parametres.version, budgetGnf: d.budgetGnf,
      perimetreJson: perimetre, entreesCanoniques: c.entreesCanoniques, empreinteEntrees: sha256Hex(c.entreesCanoniques),
      resultatCanonique: c.resultatCanonique, empreinteResultat: sha256Hex(c.resultatCanonique),
      nbRetenues: c.scenario.totaux.retenues, nbEcartees: c.scenario.totaux.ecartees, montantEngageGnf: BigInt(c.scenario.totaux.engageGnf),
      provisoire: c.scenario.provisoire, creeParId: ctx.userId,
    });
    const sim = c.scenario.simulation!;
    await logAuditTransactionnelle(tx, {
      userId: ctx.userId, action: "CREATE", entityType: "ScenarioProgrammation", entityId: id,
      after: {
        origine: "simulateur", annee: d.annee, intitule: d.intitule, budgetGnf: d.budgetGnf.toString(), periode: sim.periode, logique: sim.logique.code,
        parametresVersion: c.parametres.version, baremesEmpreinte: sim.baremes.empreinte, provisoire: c.scenario.provisoire,
        candidats: c.scenario.totaux.candidats, retenues: c.scenario.totaux.retenues, engageGnf: c.scenario.totaux.engageGnf, deficitGnf: sim.bilan.deficitGnf,
        contraintesInsatisfaisables: sim.contraintes.insatisfaisables.length, empreinteResultat: resume.empreinteResultat,
      },
      ipAddress: ctx.ipAddress,
    });
    return { scenario: resume, resultat: c.scenario };
  }, ISOLATION);
}

/** Detail d'un scenario : resume, resultat complet, options du simulateur relues du texte scelle (`null` pour un scenario herite). */
export async function lireDetail(client: Client, id: string) {
  const s = await depot.lireScenario(client, id);
  if (!s) throw new RefusMoteur("INTROUVABLE", "scénario introuvable ou supprimé", 404);
  const entrees = JSON.parse(s.entreesCanoniques) as { simulation?: unknown; candidats?: unknown[] };
  const noms = await dep.nomsAuteurs(client, [s.creeParId]);
  return {
    scenario: {
      id: s.id, annee: s.annee, intitule: s.intitule, parametresVersion: s.parametresVersion, parametresId: s.parametresId, budgetGnf: s.budgetGnf.toString(),
      perimetre: s.perimetre, nbRetenues: s.nbRetenues, nbEcartees: s.nbEcartees, montantEngageGnf: s.montantEngageGnf.toString(), provisoire: s.provisoire,
      etiquette: s.provisoire ? "PROVISOIRE, non approuvé" : "paramètres et barèmes approuvés", empreinteEntrees: s.empreinteEntrees, empreinteResultat: s.empreinteResultat,
      creeParId: s.creeParId, auteurNom: noms.get(s.creeParId) ?? null, creeLe: s.creeLe,
    },
    resultat: JSON.parse(s.resultatCanonique) as Scenario,
    entrees: { simulation: entrees.simulation ?? null, nbCandidats: Array.isArray(entrees.candidats) ? entrees.candidats.length : 0 },
    simulateur: entrees.simulation !== undefined,
  };
}

export function resumeSimulateurApi(r: dep.ResumeSimulateur) {
  return {
    id: r.id, annee: r.annee, intitule: r.intitule, parametresVersion: r.parametresVersion, parametresId: r.parametresId, budgetGnf: r.budgetGnf.toString(),
    perimetre: r.perimetre, nbRetenues: r.nbRetenues, nbEcartees: r.nbEcartees, montantEngageGnf: r.montantEngageGnf.toString(), provisoire: r.provisoire,
    etiquette: r.provisoire ? "PROVISOIRE, non approuvé" : "paramètres et barèmes approuvés", empreinteEntrees: r.empreinteEntrees, empreinteResultat: r.empreinteResultat,
    creeParId: r.creeParId, auteurNom: r.auteurNom, creeLe: r.creeLe,
    simulateur: r.logique !== null, logique: r.logique,
    periode: r.periodeDebut !== null && r.periodeFin !== null ? { debut: r.periodeDebut, fin: r.periodeFin } : null,
    deficitGnf: r.deficitGnf, deficitMinorant: r.deficitMinorant,
  };
}

/**
 * Comparaison : lit 2 a 5 scenarios (ceux que le compte voit, `regions` = `null` pour un compte national) et les compare.
 * N'ECRIT RIEN. Un identifiant inconnu, supprime ou hors perimetre repond la meme chose : INTROUVABLE (404).
 */
export async function comparer(client: Client, ids: readonly string[], regions: readonly number[] | null) {
  if (ids.length < MIN_SCENARIOS || ids.length > MAX_SCENARIOS) {
    throw new RefusMoteur("NOMBRE_INVALIDE", `la comparaison porte sur ${MIN_SCENARIOS} à ${MAX_SCENARIOS} scénarios (${ids.length} fournis)`, 400);
  }
  const lus: ScenarioComparable[] = [];
  for (const id of ids) {
    const s = await depot.lireScenario(client, id);
    if (!s) throw new RefusMoteur("INTROUVABLE", "scénario introuvable ou supprimé", 404);
    if (regions !== null) {
      const r = (s.perimetre as { regionId?: number | null } | null)?.regionId;
      if (typeof r !== "number" || !regions.includes(r)) throw new RefusMoteur("INTROUVABLE", "scénario introuvable ou supprimé", 404);
    }
    lus.push({
      id: s.id, intitule: s.intitule, creeParId: s.creeParId, creeLe: s.creeLe.toISOString(), empreinteResultat: s.empreinteResultat, resultat: JSON.parse(s.resultatCanonique) as Scenario,
      // Le perimetre du calcul (region, classe, selection) : compare et signale quand il differe.
      perimetre: s.perimetre as ScenarioComparable["perimetre"],
    });
  }
  const r = comparerScenarios(lus);
  if (!r.ok) throw new RefusMoteur(r.code, r.message, r.code === "NOMBRE_INVALIDE" || r.code === "DOUBLON" ? 400 : 422);
  return r.comparaison;
}

export type FormatExport = "csv" | "json";

/**
 * Export d'un scenario. Journalise dans l'audit (qui, quand, quel scenario, quel format, combien de lignes, quel territoire,
 * droit financier et champs retires) ; l'ecriture d'audit est transactionnelle : sans trace, pas d'export.
 *
 * `droitFinancier` (obligatoire, sans valeur par defaut) : le resultat de la regle unique `droitMontantsContractuels`, la MEME que
 * celle de `POST /api/v2/aide-decision/exports`. Faux : le noyau retire tout montant et tout texte qui en cite un.
 */
export async function exporter(client: Client, id: string, format: FormatExport, ctx: Contexte, territoire: readonly number[] | null, maintenant: Date, droitFinancier: boolean) {
  return client.$transaction(async (tx) => {
    const s = await depot.lireScenario(tx, id);
    if (!s) throw new RefusMoteur("INTROUVABLE", "scénario introuvable ou supprimé", 404);
    const resultat = JSON.parse(s.resultatCanonique) as Scenario;
    if (!resultat.simulation) throw new RefusMoteur("SCENARIO_SANS_SIMULATION", "ce scénario a été calculé avant le simulateur : il n'a pas de période ni de déficit et ne s'exporte pas comme une simulation. Relancez-le depuis l'onglet Simulation.", 422);
    const meta: MetaExport = {
      genereLe: maintenant.toISOString(), generePar: { id: ctx.userId, email: ctx.email ?? null },
      scenario: { id: s.id, intitule: s.intitule, auteurId: s.creeParId, creeLe: s.creeLe.toISOString(), empreinteEntrees: s.empreinteEntrees, empreinteResultat: s.empreinteResultat },
      perimetreDemande: s.perimetre, territoireApplique: territoire, droitFinancier,
    };
    const exp = construireExport(resultat, meta);
    await logAuditTransactionnelle(tx, {
      userId: ctx.userId, action: "CREATE", entityType: "ExportScenario", entityId: s.id,
      after: {
        format, genereLe: meta.genereLe, scenario: s.intitule, periode: resultat.simulation.periode, perimetre: s.perimetre,
        territoire: territoire === null ? "national" : [...territoire], nbLignes: exp.lignes.length, provisoire: resultat.provisoire,
        droitFinancier: exp.droitFinancier, nbChampsRetires: exp.champsFinanciersRetires.length,
      },
      ipAddress: ctx.ipAddress,
    });
    const base = `simulation-${s.id.slice(0, 8)}-${meta.genereLe.slice(0, 10)}`;
    return format === "csv"
      ? { contentType: "text/csv; charset=utf-8", nom: `${base}.csv`, corps: versCsv(exp) }
      : { contentType: "application/json; charset=utf-8", nom: `${base}.json`, corps: JSON.stringify(exp, null, 2) };
  }, ISOLATION);
}

/**
 * Baremes proposes a l'ecran pour une periode : statut d'approbation, fenetre de validite et couverture de la periode.
 * Un bareme non approuve est « provisoire » ; un bareme dont la fenetre ne couvre pas la periode donnera des couts perimes.
 */
export async function baremesPourPeriode(db: depot.Db, periode: { debut: string; fin: string }) {
  const { refs } = await dep.chargerBaremesSimulation(db, periode, null);
  return refs.map((r) => {
    const peremption = motifPeremption(r, periode);
    return {
      id: r.id, code: r.code, version: r.version, familleRevetement: r.familleRevetement, etatDepart: r.etatDepart, typeIntervention: r.typeIntervention,
      coutKmGnf: r.coutKmGnf, uniteCout: r.uniteCout, devise: r.devise, anneeReference: r.anneeReference, approuveLe: r.approuveLe, validDe: r.validDe, validA: r.validA,
      statut: r.approuveLe === null ? "PROVISOIRE" as const : "APPROUVE" as const, couvrePeriode: peremption === null, peremption,
    };
  });
}
