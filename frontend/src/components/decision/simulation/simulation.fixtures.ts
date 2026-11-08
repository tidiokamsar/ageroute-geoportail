import type {
  BilanBudgetaire, Comparaison, ColonneComparaison, DetailScenario, LigneSim, OptionsSimulateur, ResultatSimulation, ResumeScenarioSim, ScenarioSim,
} from "../../../lib/aideDecisionScenarios";
import { MENTION_SIMULATION } from "../../../lib/aideDecisionScenarios";

/**
 * Jeux de donnees de TEST du simulateur (frontend). Valeurs SYNTHETIQUES posees a la main sur les trois troncons du noyau backend
 * (RN-C 800 M GNF, RN-A 4 400 M, RN-B 3 500 M, besoin 8 700 M GNF) pour une enveloppe de 5 Md : retenues C et B, A ecartee
 * pour budget, consomme 4,3 Md, reste 0,7 Md, deficit 3,7 Md. Aucun fichier de production n'importe ce module.
 */

const facteurs = ["ETAT", "TRAFIC_IMPORTANCE", "SECURITE", "CLIMAT", "POPULATION"].map((f) => ({
  facteur: f, poids: 10, disponible: ["ETAT", "TRAFIC_IMPORTANCE", "SECURITE"].includes(f), valeur: ["ETAT", "TRAFIC_IMPORTANCE", "SECURITE"].includes(f) ? 65 : null,
  brut: 1, origine: "synthetique", note: `${f} lu`,
}));

const base = (code: string, id: string, region: number, o: Partial<LigneSim> = {}): LigneSim => ({
  troncon: { id, code, nom: null, regionId: region, classe: "RN", revetement: "BITUME", etat: "MAUVAIS", longueurM: 4000, longueurOrigine: "LONGUEUR_KM" },
  decision: "RETENUE", rangPriorite: 1, rangRetenu: 1, motifExclusion: null,
  risque: { ok: true, score: 60.625, couverture: 0.8, facteursDisponibles: 3, facteursPonderes: 5, formule: "risque = somme(poids x valeur) / somme(poids)", facteurs },
  projection: null, risqueAttendu: { score: 60.625, scoreMicro: 606250, formule: "risque attendu = risque courant" },
  traitement: { ok: true, traitement: { code: "rehabilitation", libelle: "Réhabilitation", famille: "REHABILITATION", version: 1, approuve: false }, condition: { portee: "generale", classeTrafic: null }, attributsNonRenseignes: [] },
  cout: {
    ok: true, montantGnf: "800000000", devise: "GNF", classePrecision: "RESEAU_30", margePct: 30, provisoire: true, hypothesesManquantes: ["millesime"],
    bareme: { id: 4, code: null, typeIntervention: "entretien_periodique", coutKmGnf: "80000000", anneeReference: null, largeurChausseeM: null, approuve: false }, calcul: "10000 m x 80000000 GNF/km = 800000000 GNF",
  },
  priorite: { ratioPointsParMilliardGnf: "37.0312", formule: "priorite = risque attendu / cout en milliards de GNF" },
  budget: { resteAvantGnf: "5000000000", resteApresGnf: "4200000000" }, etiquette: "PROVISOIRE, non approuvé",
  justification: `Retenue (arbitrage 1/3) : ${code}.`,
  simulation: {
    ordreArbitrage: 1, examen: 1, phase: "ORDRE", prioriteTechnique: { rang: 3, source: "moteur_v2_risque_courant" }, obligatoire: false, groupe: null, coutFiable: true,
    coutSource: { baremeId: 4, baremeCode: null, version: 1, uniteCout: "KM", devise: "GNF", validDe: null, validA: null, approuve: false, anneeReference: null },
  },
  ...o,
});

export const LIGNE_C: LigneSim = base("RN-C", "c", 1);
export const LIGNE_A: LigneSim = base("RN-A", "a", 1, {
  decision: "ECARTEE", rangRetenu: null, rangPriorite: 2,
  motifExclusion: { code: "BUDGET_INSUFFISANT", detail: "coût 4400000000 supérieur au reste de l'enveloppe 4200000000" },
  cout: { ok: true, montantGnf: "4400000000", devise: "GNF", classePrecision: "RESEAU_30", margePct: 30, provisoire: true, hypothesesManquantes: [], bareme: { id: 2, code: null, typeIntervention: "rehabilitation", coutKmGnf: "1100000000", anneeReference: null, largeurChausseeM: null, approuve: false }, calcul: "4000 m x 1100000000 GNF/km" },
  simulation: { ordreArbitrage: 2, examen: 2, phase: null, prioriteTechnique: { rang: 1, source: "moteur_v2_risque_courant" }, obligatoire: false, groupe: null, coutFiable: true, coutSource: null },
  justification: "Écartée (arbitrage 2/3, BUDGET_INSUFFISANT).",
});
export const LIGNE_B: LigneSim = base("RN-B", "b", 2, {
  rangPriorite: 3, rangRetenu: 2,
  simulation: { ordreArbitrage: 3, examen: 3, phase: "ORDRE", prioriteTechnique: { rang: 2, source: "moteur_v2_risque_courant" }, obligatoire: false, groupe: null, coutFiable: true, coutSource: null },
  cout: { ok: true, montantGnf: "3500000000", devise: "GNF", classePrecision: "RESEAU_30", margePct: 30, provisoire: true, hypothesesManquantes: [], bareme: { id: 3, code: null, typeIntervention: "reconstruction", coutKmGnf: "3500000000", anneeReference: null, largeurChausseeM: null, approuve: false }, calcul: "1000 m x 3500000000 GNF/km" },
  justification: "Retenue (arbitrage 3/3) : RN-B.",
});
export const LIGNE_PERIMEE: LigneSim = base("RN-P", "p", 1, {
  decision: "ECARTEE", rangRetenu: null, rangPriorite: null, priorite: null, budget: null,
  motifExclusion: { code: "COUT_PERIME" as never, detail: "COUT_PERIME : le coût n'est pas fiable pour la période : la fenêtre de validité du barème 2 [sans début ; 2026-12-31] ne couvre pas la période 2027-01-01 à 2027-12-31" },
  cout: { ok: false, code: "COUT_PERIME", motif: "le coût n'est pas fiable pour la période" },
  simulation: { ordreArbitrage: null, examen: null, phase: null, prioriteTechnique: { rang: 4, source: "moteur_v2_risque_courant" }, obligatoire: false, groupe: null, coutFiable: false, coutSource: null },
  justification: "Écartée avant classement (COUT_PERIME).",
});

export const BILAN_DEFICIT: BilanBudgetaire = {
  enveloppeGnf: "5000000000", consommeGnf: "4300000000", resteGnf: "700000000", besoinTotalGnf: "8700000000", deficitGnf: "3700000000", excedentGnf: "0", soldeGnf: "-3700000000",
  couvertureBesoinPct: "57.4", nbCoutsFiables: 3, nbCoutsNonFiables: 0, deficitMinorant: false, besoinObligatoiresGnf: "0", deficitObligatoiresGnf: "0",
};

export function simulationBase(o: Partial<ResultatSimulation> = {}): ResultatSimulation {
  return {
    version: 1, mention: MENTION_SIMULATION, periode: { debut: "2027-01-01", fin: "2027-12-31" }, devise: "GNF",
    logique: { code: "ratio_cout_impact", libelle: "Ratio coût / impact", explication: "Retient d'abord les interventions qui réduisent le plus de risque par franc dépensé.", regle: "risque attendu / coût décroissant", provisoire: false, ordrePersonnalise: [], equilibre: null },
    bilan: BILAN_DEFICIT, coutsNonFiables: [],
    contraintes: { obligatoires: { demandees: [], effectives: [], retenues: [], nonRetenues: [] }, groupesNonDivisibles: [], plafondsRegionauxGnf: {}, equilibre: null, insatisfaisables: [] },
    kilometres: { metierM: 11000, metierKm: "11.000", lignesAvecLongueurMetier: 2, lignesSansLongueurMetier: 0, geometriqueM: null, geometriqueKm: null, note: "Longueur métier renseignée pour toutes les interventions retenues." },
    risqueCouvert: { retenuMicro: 731250, totalChiffrableMicro: 1337500, totalCalculableMicro: 1337500, partChiffrablePct: "54.6", partCalculablePct: "54.6", nbSansRisqueCalculable: 0 },
    distributionRegionale: [
      { regionId: 1, nbRetenues: 1, engageGnf: "800000000", nbEcartees: 1, besoinGnf: "5200000000" },
      { regionId: 2, nbRetenues: 1, engageGnf: "3500000000", nbEcartees: 0, besoinGnf: "3500000000" },
    ],
    baremes: { empreinte: "a".repeat(64), nbLignes: 9, nbApprouvees: 0, nbProvisoires: 9, liste: [] },
    parametresVersion: "prog-provisoire-1", rangsTechniquesSource: "moteur_v2_risque_courant",
    avertissements: [
      { code: "DEFICIT", niveau: "ALERTE", nb: null, message: "Déficit de 3 700 000 000 GNF : l'enveloppe de 5 000 000 000 GNF ne couvre pas le besoin chiffré de 8 700 000 000 GNF." },
      { code: "COUTS_PROVISOIRES", niveau: "ALERTE", nb: 2, message: "2 intervention(s) retenue(s) chiffrée(s) sur un barème provisoire." },
      { code: "PARAMETRES_PROVISOIRES", niveau: "INFO", nb: null, message: "Paramètres prog-provisoire-1 non approuvés." },
    ],
    ...o,
  };
}

export function scenarioSim(o: { simulation?: Partial<ResultatSimulation>; lignes?: LigneSim[]; budgetGnf?: string } = {}): ScenarioSim {
  const lignes = o.lignes ?? [LIGNE_C, LIGNE_A, LIGNE_B];
  const retenues = lignes.filter((l) => l.decision === "RETENUE").length;
  const ecartesParMotif: Record<string, number> = {};
  for (const l of lignes) if (l.motifExclusion) ecartesParMotif[l.motifExclusion.code] = (ecartesParMotif[l.motifExclusion.code] ?? 0) + 1;
  return {
    methode: { id: "programmation-glouton-explicable", version: "1" }, annee: 2027, budgetGnf: o.budgetGnf ?? "5000000000",
    parametres: { version: "prog-provisoire-1", source: "amorcage_provisoire", approuveeLe: null, etiquette: "PROVISOIRE, non approuvé" },
    provisoire: true, etiquette: "PROVISOIRE, non approuvé", motifsProvisoire: ["paramètres de programmation non approuvés (version prog-provisoire-1, source amorcage_provisoire)"],
    limites: ["Le classement est glouton, non optimal."], avertissement: "Aucune estimation ni programmation ne crée de marché, contrat, ordre de travaux, chantier, décompte, certification de paiement ou engagement financier.",
    totaux: { candidats: lignes.length, eligibles: lignes.filter((l) => l.rangPriorite !== null).length, retenues, ecartees: lignes.length - retenues, engageGnf: "4300000000", resteGnf: "700000000", ecartesParMotif, engageParRegionGnf: { "1": "800000000", "2": "3500000000" } },
    lignes, simulation: simulationBase(o.simulation),
  };
}

export const OPTIONS: OptionsSimulateur = {
  mention: MENTION_SIMULATION, devise: "GNF", maxCandidats: 3000,
  logiques: [
    { code: "ratio_cout_impact", libelle: "Ratio coût / impact", explication: "Retient d'abord les interventions qui réduisent le plus de risque par franc dépensé.", regle: "r", provisoire: false, exige: [] },
    { code: "urgence", libelle: "Urgence", explication: "Retient d'abord les tronçons les plus dégradés.", regle: "r", provisoire: true, exige: [] },
    { code: "criticite", libelle: "Criticité", explication: "Retient d'abord les tronçons au risque courant le plus élevé.", regle: "r", provisoire: false, exige: [] },
    { code: "equilibre_territorial", libelle: "Équilibre territorial", explication: "Garantit à chaque région une part minimale de l'enveloppe.", regle: "r", provisoire: true, exige: ["equilibre"] },
    { code: "personnalise", libelle: "Ordre personnalisé", explication: "Suit l'ordre fourni.", regle: "r", provisoire: false, exige: ["ordrePersonnalise"] },
  ],
  parametres: [{ id: "p-seed", version: "prog-provisoire-1", provisoire: true, etiquette: "PROVISOIRE, non approuvé", approuveeLe: null }],
  baremes: [
    { id: 2, code: null, version: 1, familleRevetement: "bitume", etatDepart: "MAUVAIS", typeIntervention: "rehabilitation", coutKmGnf: "1100000000", uniteCout: "KM", devise: "GNF", anneeReference: null, approuveLe: null, validDe: null, validA: null, statut: "PROVISOIRE", couvrePeriode: true, peremption: null },
    { id: 3, code: "BAR-3", version: 2, familleRevetement: "bitume", etatDepart: "CRITIQUE", typeIntervention: "reconstruction", coutKmGnf: "3500000000", uniteCout: "KM", devise: "GNF", anneeReference: 2025, approuveLe: "2026-01-01T00:00:00.000Z", validDe: null, validA: "2027-06-30", statut: "APPROUVE", couvrePeriode: false, peremption: "fenêtre" },
  ],
  contraintes: { obligatoires: "o", groupesNonDivisibles: "g", plafondsRegionaux: "p", reglesFinancement: "Règles de financement : aucune n'existe dans le modèle de données ; elles ne sont pas modélisées" },
};

export const CANDIDATS = {
  total: 3, tronque: false, maxCandidats: 3000,
  data: [
    { id: "c", code: "RN-C", nom: "Conakry Coyah", regionId: 1, classe: "RN", revetement: "TERRE", etat: "MOYEN", longueurMetierKm: "10.000", longueurGeometriqueKm: null },
    { id: "a", code: "RN-A", nom: null, regionId: 1, classe: "RN", revetement: "BITUME", etat: "MAUVAIS", longueurMetierKm: null, longueurGeometriqueKm: "4.100" },
    { id: "b", code: "RN-B", nom: "Kindia Mamou", regionId: 2, classe: "RN", revetement: "BITUME", etat: "CRITIQUE", longueurMetierKm: "1.000", longueurGeometriqueKm: null },
  ],
};

export function resumeSim(id: string, o: Partial<ResumeScenarioSim> = {}): ResumeScenarioSim {
  return {
    id, annee: 2027, intitule: `Scénario ${id}`, parametresVersion: "prog-provisoire-1", parametresId: "p-seed", budgetGnf: "5000000000", perimetre: { regionId: null }, nbRetenues: 2, nbEcartees: 1,
    montantEngageGnf: "4300000000", provisoire: true, etiquette: "PROVISOIRE, non approuvé", empreinteEntrees: "e".repeat(64), empreinteResultat: "r".repeat(64), creeParId: "u1", auteurNom: "Awa Camara",
    creeLe: "2026-10-26T09:00:00.000Z", simulateur: true, logique: "ratio_cout_impact", periode: { debut: "2027-01-01", fin: "2027-12-31" }, deficitGnf: "3700000000", deficitMinorant: false, ...o,
  };
}

export function detailSim(id: string, o: { simulateur?: boolean; resultat?: ScenarioSim } = {}): DetailScenario {
  const { simulateur: _s, logique: _l, periode: _p, deficitGnf: _d, deficitMinorant: _m, ...scenario } = resumeSim(id);
  const simulateur = o.simulateur ?? true;
  return {
    scenario,
    resultat: o.resultat ?? (simulateur ? scenarioSim() : { ...scenarioSim(), simulation: undefined }),
    entrees: simulateur
      ? { simulation: { logique: "ratio_cout_impact", periode: { debut: "2027-01-01", fin: "2027-12-31" }, obligatoires: [], groupesNonDivisibles: [], equilibre: null, ordrePersonnalise: [], baremes: { empreinte: "a".repeat(64) }, perimetre: { regionId: null, classe: null, selection: null } }, nbCandidats: 3 }
      : { simulation: null, nbCandidats: 3 },
    simulateur,
  };
}

const colonne = (id: string, o: Partial<ColonneComparaison> = {}): ColonneComparaison => ({
  id, intitule: `Scénario ${id}`, creeParId: "u1", creeLe: "2026-10-26T09:00:00.000Z", annee: 2027, periode: { debut: "2027-01-01", fin: "2027-12-31" }, devise: "GNF",
  logique: { code: "ratio_cout_impact", libelle: "Ratio coût / impact" }, etiquette: "PROVISOIRE, non approuvé", provisoire: true,
  enveloppeGnf: "5000000000", consommeGnf: "4300000000", resteGnf: "700000000", besoinTotalGnf: "8700000000", deficitGnf: "3700000000", soldeGnf: "-3700000000", deficitMinorant: false, nbCoutsNonFiables: 0,
  nbCandidats: 3, nbInterventions: 2, nbEcartees: 1, kilometres: simulationBase().kilometres, risqueCouvert: simulationBase().risqueCouvert, distributionRegionale: simulationBase().distributionRegionale,
  exclusionsParMotif: { BUDGET_INSUFFISANT: 1 }, parametresVersion: "prog-provisoire-1", baremes: { empreinte: "a".repeat(64), nbLignes: 9, nbApprouvees: 0 }, nbContraintesInsatisfaisables: 0, avertissements: ["DEFICIT"], ...o,
});

export function comparaisonSim(): Comparaison {
  const a = colonne("s-a");
  const b = colonne("s-b", {
    enveloppeGnf: "8000000000", consommeGnf: "7900000000", resteGnf: "100000000", deficitGnf: "700000000", soldeGnf: "-700000000", deficitMinorant: true, nbCoutsNonFiables: 1,
    logique: { code: "urgence", libelle: "Urgence" }, nbContraintesInsatisfaisables: 1, kilometres: { ...simulationBase().kilometres, metierKm: null, metierM: null, lignesAvecLongueurMetier: 0, lignesSansLongueurMetier: 2, geometriqueKm: "5.000", geometriqueM: 5000, note: "Longueur métier absente pour 2 intervention(s)" },
  });
  return {
    mention: MENTION_SIMULATION, periode: { debut: "2027-01-01", fin: "2027-12-31" }, devise: "GNF", scenarios: [a, b],
    hypotheses: [
      { champ: "logique", libelle: "Logique de priorité", valeurs: ["Ratio coût / impact", "Urgence"], identiques: false },
      { champ: "enveloppe", libelle: "Enveloppe (GNF)", valeurs: ["5 000 000 000", "8 000 000 000"], identiques: false },
      { champ: "parametres", libelle: "Version des paramètres", valeurs: ["prog-provisoire-1", "prog-provisoire-1"], identiques: true },
    ],
    interventions: { communes: 1, propres: [{ id: "s-a", nb: 1 }, { id: "s-b", nb: 1 }] },
  };
}
