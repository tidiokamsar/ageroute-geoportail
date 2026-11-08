/**
 * EXPORT D'UN SCENARIO DU SIMULATEUR (CSV ou JSON). Aucun acces base, aucune horloge : l'appelant fournit la date,
 * l'auteur de l'export et le perimetre territorial applique.
 *
 * CE QU'UN EXPORT CONTIENT (cahier 7.1 et contrat AD §6) : la MENTION « SIMULATION NON ENGAGEANTE » en premiere ligne,
 * la date de generation, l'auteur de l'export, le perimetre (filtres du scenario et territoire applique), les unites
 * (GNF), les versions (parametres, baremes, methode), les hypotheses, les definitions des termes, les avertissements
 * (donnees partielles, couts provisoires, couts manquants ou perimes), le bilan (consomme, reste, besoin, deficit), les
 * contraintes insatisfaisables et UNE LIGNE PAR TRONCON (retenu ou ecarte, avec son motif).
 *
 * INTERFACE AVEC LE LOT 6 (export gouverne) : `construireExport` rend un objet JSON stable (`format`, `version`) que le
 * moteur d'export general peut embarquer tel quel ou rendre en PDF ; `versCsv` est la forme tableur. Le journal d'export
 * (qui, quand, filtres, nombre de lignes) est ecrit par la ROUTE, pas ici. Le droit d'exporter (module « rapports », role
 * ADMIN ou GESTIONNAIRE) est controle par la route.
 *
 * CSV : point-virgule, BOM UTF-8 (Excel francophone), et NEUTRALISATION DES FORMULES : une cellule texte qui commence par
 * = + - @ tabulation ou retour chariot recoit une apostrophe (injection CSV). Un nombre pur (« -1200 ») reste intact.
 */

import { MENTION_CONSULTATIVE } from "../aide-decision/export.noyau";
import { MENTION_SIMULATION, type BilanBudgetaire } from "./deficit.noyau";
import type { LigneScenario, ResultatSimulation, Scenario } from "./scenario.noyau";

export const FORMAT_EXPORT = "ad-simulation-export" as const;
export const VERSION_EXPORT = 1 as const;

/**
 * DROIT FINANCIER. Le meme retrait que `POST /api/v2/aide-decision/exports` : sans le droit (`droitMontantsContractuels`,
 * regle unique PROVISOIRE de `chantiers.confidentialite.ts`), AUCUN montant ne sort : ni enveloppe, ni bilan, ni cout, ni reste, ni
 * plafond, ni prix de bareme, ni texte qui cite un montant (justification, detail d'un motif ou d'une contrainte, message de
 * deficit). Le fichier dit qu'il est incomplet (`champsFinanciersRetires`). Ce qui n'est pas un montant reste : lignes, rangs,
 * codes de motif, risque, longueurs, nombres, mentions.
 */
export const CHAMPS_FINANCIERS_RETIRES: readonly string[] = [
  "hypotheses.enveloppeGnf", "hypotheses.plafondsRegionauxGnf",
  "resultats.bilan (montants)", "resultats.distributionRegionale (engageGnf, besoinGnf)",
  "resultats.contraintesInsatisfaisables[].detail", "resultats.equilibreTerritorial (plancherGnf, depenseGnf)",
  "versions.baremes.liste[].coutKmGnf", "avertissements DEFICIT (texte)",
  "lignes[].coutGnf", "lignes[].coutProvisoire", "lignes[].baremeId", "lignes[].baremeVersion",
  "lignes[].detailMotif", "lignes[].justification",
];

export interface MetaExport {
  /** Droit de lire les montants (regle unique `droitMontantsContractuels`). Obligatoire : un oubli ne doit pas ouvrir les montants. */
  droitFinancier: boolean;
  /** Date ISO de generation, fournie par l'appelant (le noyau n'a pas d'horloge). */
  genereLe: string;
  generePar: { id: string; email: string | null };
  scenario: { id: string; intitule: string; auteurId: string; creeLe: string; empreinteEntrees: string; empreinteResultat: string };
  /** Perimetre demande lors du calcul (colonne `perimetre` du scenario). */
  perimetreDemande: unknown;
  /** Territoire applique a l'export : `null` = compte national (aucune restriction), sinon les regions visibles. */
  territoireApplique: readonly number[] | null;
}

export const DEFINITIONS: readonly { terme: string; definition: string }[] = [
  { terme: "Simulation", definition: "Calcul non engageant d'une répartition d'enveloppe sous hypothèses. Aucun marché, ordre de travaux, chantier, décompte ni engagement financier n'est créé." },
  { terme: "Enveloppe", definition: "Montant disponible saisi pour la période, en GNF entiers." },
  { terme: "Consommé", definition: "Somme des coûts estimés des interventions retenues." },
  { terme: "Reste", definition: "Enveloppe moins consommé. Jamais négatif." },
  { terme: "Besoin", definition: "Somme des coûts FIABLES de tous les candidats chiffrables, retenus ou non. Les candidats sans coût fiable n'y sont pas comptés." },
  { terme: "Déficit", definition: "Besoin moins enveloppe lorsqu'il est positif, sinon 0. Minorant si des coûts sont manquants ou périmés." },
  { terme: "Coût périmé", definition: "Coût dont la fenêtre de validité du barème ne couvre pas toute la période simulée : l'intervention n'est pas simulée avec ce coût." },
  { terme: "Ordre d'arbitrage", definition: "Ordre dans lequel la logique choisie distribue l'enveloppe. Distinct de la priorité technique, qui reste affichée à part." },
  { terme: "Priorité technique", definition: "Rang de l'intervention selon son risque propre, indépendamment de son coût (rang du moteur v2 tant que le lot de priorisation ne le fournit pas)." },
  { terme: "Longueur métier", definition: "Longueur saisie du tronçon (colonne longueurKm). La longueur géométrique est donnée à part et ne la remplace jamais." },
  { terme: "Groupe non divisible", definition: "Ensemble de tronçons financés ensemble ou pas du tout (convention provisoire)." },
  { terme: "Provisoire", definition: "Valeur ou règle non approuvée par le métier : paramètres, barèmes, logique d'arbitrage." },
];

/**
 * Une ligne de l'export. Sans le droit financier, tout ce qui est un montant OU un texte qui cite un montant (le detail d'un
 * motif d'ecart et la justification disent « cout X superieur au reste de l'enveloppe Y ») vaut `null`.
 */
function ligneExport(l: LigneScenario, droitFinancier: boolean) {
  return {
    code: l.troncon.code, nom: l.troncon.nom, regionId: l.troncon.regionId, classe: l.troncon.classe, etat: l.troncon.etat,
    decision: l.decision, rangRetenu: l.rangRetenu,
    ordreArbitrage: l.simulation?.ordreArbitrage ?? null,
    prioriteTechnique: l.simulation?.prioriteTechnique.rang ?? null,
    obligatoire: l.simulation?.obligatoire ?? false,
    groupeNonDivisible: l.simulation?.groupe ?? null,
    motif: l.motifExclusion?.code ?? null,
    detailMotif: droitFinancier ? (l.motifExclusion?.detail ?? null) : null,
    traitement: l.traitement && l.traitement.ok ? l.traitement.traitement.code : null,
    coutGnf: droitFinancier && l.cout && l.cout.ok ? l.cout.montantGnf : null,
    coutFiable: l.simulation?.coutFiable ?? false,
    coutProvisoire: droitFinancier && l.cout && l.cout.ok ? l.cout.provisoire : null,
    baremeId: droitFinancier && l.simulation?.coutSource ? String(l.simulation.coutSource.baremeId) : null,
    baremeVersion: droitFinancier ? (l.simulation?.coutSource?.version ?? null) : null,
    longueurM: l.troncon.longueurM,
    longueurOrigine: l.troncon.longueurOrigine,
    risque: l.risque.ok ? l.risque.score : null,
    justification: droitFinancier ? l.justification : null,
  };
}

/** Bilan sans montant : seuls les nombres et le drapeau « minorant » restent (aucune valeur en GNF, aucun ratio qui en derive). */
type BilanSansMontants = Pick<BilanBudgetaire, "nbCoutsFiables" | "nbCoutsNonFiables" | "deficitMinorant">;
type ContrainteExport = Omit<ResultatSimulation["contraintes"]["insatisfaisables"][number], "detail"> & { detail: string | null };
type EquilibreExport = { regionId: number; atteint: boolean; plancherGnf?: string; depenseGnf?: string };
type DistributionExport = { regionId: number | null; nbRetenues: number; nbEcartees: number; engageGnf?: string; besoinGnf?: string };
type BaremeListeExport = Omit<ResultatSimulation["baremes"]["liste"][number], "coutKmGnf"> & { coutKmGnf?: string };

/** Message d'un avertissement ; celui du deficit cite l'enveloppe et le besoin : il est remplace sans le droit financier. */
const MESSAGE_DEFICIT_SANS_MONTANT = "Déficit budgétaire constaté : l'enveloppe ne couvre pas le besoin chiffré. Les montants ne sont pas communiqués à ce compte (droit financier absent).";

export type ExportScenario = ReturnType<typeof construireExport>;

export function construireExport(s: Scenario, m: MetaExport) {
  const sim = s.simulation;
  if (!sim) throw new Error("export : ce scenario n'a pas ete calcule par le simulateur (pas de bloc simulation)");
  const droit = m.droitFinancier === true;
  const bilan: BilanBudgetaire | BilanSansMontants = droit
    ? sim.bilan
    : { nbCoutsFiables: sim.bilan.nbCoutsFiables, nbCoutsNonFiables: sim.bilan.nbCoutsNonFiables, deficitMinorant: sim.bilan.deficitMinorant };
  const insatisfaisables: ContrainteExport[] = sim.contraintes.insatisfaisables.map((c) => (droit ? c : { ...c, detail: null }));
  const equilibre: EquilibreExport[] | null = sim.contraintes.equilibre === null
    ? null
    : sim.contraintes.equilibre.map((q) => (droit ? q : { regionId: q.regionId, atteint: q.atteint }));
  const distribution: DistributionExport[] = sim.distributionRegionale.map((d) => (droit ? d : { regionId: d.regionId, nbRetenues: d.nbRetenues, nbEcartees: d.nbEcartees }));
  const listeBaremes: BaremeListeExport[] = sim.baremes.liste.map((b) => {
    if (droit) return b;
    const { coutKmGnf: _prix, ...sansPrix } = b;
    return sansPrix;
  });
  const avertissements = sim.avertissements.map((a) => (droit || a.code !== "DEFICIT" ? a : { ...a, message: MESSAGE_DEFICIT_SANS_MONTANT }));
  return {
    mention: MENTION_SIMULATION,
    // Mention commune a tous les exports du module (constante unique) : ce fichier est consultatif comme les autres.
    mentionConsultative: MENTION_CONSULTATIVE,
    droitFinancier: droit,
    champsFinanciersRetires: droit ? [] : [...CHAMPS_FINANCIERS_RETIRES],
    avertissementSansEngagement: s.avertissement,
    format: FORMAT_EXPORT,
    version: VERSION_EXPORT,
    genereLe: m.genereLe,
    generePar: m.generePar,
    scenario: {
      id: m.scenario.id, intitule: m.scenario.intitule, auteurId: m.scenario.auteurId, creeLe: m.scenario.creeLe, annee: s.annee,
      periode: sim.periode, devise: sim.devise, etiquette: s.etiquette, provisoire: s.provisoire, motifsProvisoire: s.motifsProvisoire,
      empreinteEntrees: m.scenario.empreinteEntrees, empreinteResultat: m.scenario.empreinteResultat,
    },
    perimetre: { demande: m.perimetreDemande, territoireApplique: m.territoireApplique === null ? "national" : [...m.territoireApplique] },
    unites: {
      montants: "GNF (francs guinéens), entiers, sans décimale",
      longueurs: "kilomètres (longueur métier) ; mètres dans les lignes",
      risque: "indice de risque du moteur, de 0 à 100 (provisoire)",
    },
    versions: {
      methode: s.methode,
      parametres: { version: sim.parametresVersion, source: s.parametres.source, approuveeLe: s.parametres.approuveeLe, etiquette: s.parametres.etiquette },
      baremes: { empreinte: sim.baremes.empreinte, nbLignes: sim.baremes.nbLignes, nbApprouvees: sim.baremes.nbApprouvees, liste: listeBaremes },
    },
    hypotheses: {
      logique: { code: sim.logique.code, libelle: sim.logique.libelle, explication: sim.logique.explication, regle: sim.logique.regle, provisoire: sim.logique.provisoire },
      enveloppeGnf: droit ? sim.bilan.enveloppeGnf : null,
      plafondsRegionauxGnf: droit ? sim.contraintes.plafondsRegionauxGnf : null,
      obligatoires: sim.contraintes.obligatoires.demandees,
      groupesNonDivisibles: sim.contraintes.groupesNonDivisibles.map((g) => g.membres),
      equilibre: sim.logique.equilibre,
      ordrePersonnalise: sim.logique.ordrePersonnalise,
    },
    definitions: DEFINITIONS,
    resultats: {
      bilan,
      nbCandidats: s.totaux.candidats, nbInterventionsRetenues: s.totaux.retenues, nbEcartees: s.totaux.ecartees,
      exclusionsParMotif: s.totaux.ecartesParMotif,
      kilometres: sim.kilometres,
      risqueCouvert: sim.risqueCouvert,
      distributionRegionale: distribution,
      coutsNonFiables: sim.coutsNonFiables,
      contraintesInsatisfaisables: insatisfaisables,
      equilibreTerritorial: equilibre,
    },
    avertissements,
    limites: s.limites,
    lignes: s.lignes.map((l) => ligneExport(l, droit)),
  };
}

// ---------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------

const NOMBRE_PUR = /^-?\d+(\.\d+)?$/;

/** Echappe une cellule et neutralise l'injection de formule. */
export function celluleCsv(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !NOMBRE_PUR.test(s)) s = `'${s}`;
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const rangee = (...c: unknown[]) => c.map(celluleCsv).join(";");

/** Forme tableur : un bloc « Section;Cle;Valeur » (mention en tete), puis le tableau des lignes. */
export function versCsv(e: ExportScenario): string {
  const kv: string[] = [rangee("Section", "Clé", "Valeur")];
  const ajoute = (section: string, cle: string, valeur: unknown) => kv.push(rangee(section, cle, valeur));
  ajoute("Mention", "Statut", e.mention);
  ajoute("Mention", "Précision", e.avertissementSansEngagement);
  ajoute("Mention", "Consultatif", e.mentionConsultative);
  ajoute("Export", "Généré le", e.genereLe);
  ajoute("Export", "Généré par", e.generePar.email ?? e.generePar.id);
  ajoute("Export", "Format", `${e.format} v${e.version}`);
  ajoute("Scénario", "Identifiant", e.scenario.id);
  ajoute("Scénario", "Intitulé", e.scenario.intitule);
  ajoute("Scénario", "Auteur (identifiant)", e.scenario.auteurId);
  ajoute("Scénario", "Créé le", e.scenario.creeLe);
  ajoute("Scénario", "Période", `${e.scenario.periode.debut} à ${e.scenario.periode.fin}`);
  ajoute("Scénario", "Devise", e.scenario.devise);
  ajoute("Scénario", "Statut des paramètres et barèmes", e.scenario.etiquette);
  for (const m of e.scenario.motifsProvisoire) ajoute("Scénario", "Motif provisoire", m);
  ajoute("Scénario", "Empreinte des entrées (SHA-256)", e.scenario.empreinteEntrees);
  ajoute("Scénario", "Empreinte du résultat (SHA-256)", e.scenario.empreinteResultat);
  ajoute("Périmètre", "Filtres du scénario", e.perimetre.demande);
  ajoute("Périmètre", "Territoire appliqué", e.perimetre.territoireApplique === "national" ? "national (aucune restriction)" : `régions ${(e.perimetre.territoireApplique as number[]).join(", ")}`);
  for (const [k, v] of Object.entries(e.unites)) ajoute("Unités", k, v);
  ajoute("Versions", "Méthode", `${e.versions.methode.id} v${e.versions.methode.version}`);
  ajoute("Versions", "Paramètres", `${e.versions.parametres.version} (${e.versions.parametres.etiquette})`);
  ajoute("Versions", "Barèmes (empreinte)", e.versions.baremes.empreinte);
  ajoute("Versions", "Barèmes (lignes, approuvées)", `${e.versions.baremes.nbLignes} lignes, ${e.versions.baremes.nbApprouvees} approuvée(s)`);
  ajoute("Hypothèses", "Logique", `${e.hypotheses.logique.libelle} : ${e.hypotheses.logique.regle}`);
  if (e.droitFinancier) {
    ajoute("Hypothèses", "Enveloppe (GNF)", e.hypotheses.enveloppeGnf);
    ajoute("Hypothèses", "Plafonds régionaux (GNF)", e.hypotheses.plafondsRegionauxGnf);
  } else {
    ajoute("Droit financier", "Montants", "retirés : ce compte n'a pas le droit de lire les montants, ce fichier est incomplet par construction");
    ajoute("Droit financier", "Champs retirés", e.champsFinanciersRetires.join(", "));
  }
  ajoute("Hypothèses", "Obligatoires", e.hypotheses.obligatoires);
  ajoute("Hypothèses", "Groupes non divisibles", e.hypotheses.groupesNonDivisibles);
  ajoute("Hypothèses", "Part minimale par région", e.hypotheses.equilibre);
  const b = e.resultats.bilan;
  if ("enveloppeGnf" in b) {
    ajoute("Bilan", "Enveloppe (GNF)", b.enveloppeGnf);
    ajoute("Bilan", "Consommé (GNF)", b.consommeGnf);
    ajoute("Bilan", "Reste (GNF)", b.resteGnf);
    ajoute("Bilan", "Besoin chiffré (GNF)", b.besoinTotalGnf);
    ajoute("Bilan", "Déficit (GNF)", b.deficitGnf);
    ajoute("Bilan", "Solde signé (GNF)", b.soldeGnf);
  }
  ajoute("Bilan", "Déficit minorant", b.deficitMinorant ? "oui : des coûts manquants ou périmés ne sont pas comptés" : "non");
  ajoute("Résultats", "Interventions retenues", e.resultats.nbInterventionsRetenues);
  ajoute("Résultats", "Interventions écartées", e.resultats.nbEcartees);
  ajoute("Résultats", "Kilomètres (longueur métier)", e.resultats.kilometres.metierKm ?? "longueur métier absente");
  ajoute("Résultats", "Kilomètres (longueur géométrique, à part)", e.resultats.kilometres.geometriqueKm ?? "");
  ajoute("Résultats", "Note kilomètres", e.resultats.kilometres.note);
  ajoute("Résultats", "Part du risque chiffrable couverte (%)", e.resultats.risqueCouvert.partChiffrablePct ?? "non calculable");
  for (const [k, v] of Object.entries(e.resultats.exclusionsParMotif)) ajoute("Exclusions", k, v);
  for (const r of e.resultats.distributionRegionale) ajoute("Distribution régionale", r.regionId === null ? "sans région" : `région ${r.regionId}`, r.engageGnf === undefined ? `${r.nbRetenues} retenue(s), ${r.nbEcartees} écartée(s)` : `${r.nbRetenues} retenue(s), ${r.engageGnf} GNF, ${r.nbEcartees} écartée(s)`);
  for (const c of e.resultats.contraintesInsatisfaisables) ajoute("Contrainte insatisfaisable", c.code, c.detail ?? "détail non communiqué (droit financier absent)");
  for (const a of e.avertissements) ajoute("Avertissement", `${a.niveau} ${a.code}`, a.message);
  for (const d of e.definitions) ajoute("Définition", d.terme, d.definition);
  for (const l of e.limites) ajoute("Limite", "", l);

  const entete = ["Code", "Nom", "Région", "Classe", "État", "Décision", "Rang retenu", "Ordre d'arbitrage", "Priorité technique", "Obligatoire", "Groupe non divisible", "Motif", "Traitement", "Coût estimé (GNF)", "Coût fiable", "Coût provisoire", "Barème", "Version du barème", "Longueur (m)", "Origine de la longueur", "Risque", "Justification"];
  const tableau = e.lignes.map((l) => rangee(
    l.code, l.nom, l.regionId, l.classe, l.etat, l.decision, l.rangRetenu, l.ordreArbitrage, l.prioriteTechnique, l.obligatoire ? "oui" : "non", l.groupeNonDivisible, l.motif, l.traitement,
    l.coutGnf, l.coutFiable ? "oui" : "non", l.coutProvisoire === null ? "" : l.coutProvisoire ? "oui" : "non", l.baremeId, l.baremeVersion, l.longueurM, l.longueurOrigine, l.risque, l.justification,
  ));
  return `﻿${e.mention}\n${kv.join("\n")}\n\n${rangee(...entete)}\n${tableau.join("\n")}\n`;
}
