/**
 * SCENARIO ANNUEL DE PROGRAMMATION (PAE) SOUS CONTRAINTE BUDGETAIRE (paragraphe 7.7, scenario A22).
 * Aucun acces base : des donnees en entree, un scenario en sortie.
 *
 * CE QUE LE MODULE FAIT
 *
 * Pour chaque troncon candidat : calcule le risque (engines/risque.noyau), choisit le traitement
 * (engines/traitement.noyau), le chiffre par le moteur de cout (engines/cout.noyau, qui REFUSE
 * sans bareme), projette la degradation par la matrice, puis range les troncons chiffrables par
 * « risque attendu par franc depense » et les retient dans l'ordre tant que l'enveloppe le permet.
 *
 * CE QUE LE MODULE NE FAIT JAMAIS
 *
 *   - combler un manque : un troncon dont le risque, le traitement ou le cout n'est pas calculable
 *     est ECARTE avec son motif, il n'est ni chiffre « environ » ni classe au milieu ;
 *   - presenter un resultat comme officiel : tant que les parametres, le bareme ou le catalogue
 *     ne sont pas approuves, le scenario porte l'etiquette « PROVISOIRE, non approuve » et la
 *     liste de ce qui manque ;
 *   - creer le moindre engagement : « AUCUNE estimation ni programmation ne cree de marche,
 *     contrat, ordre de travaux, chantier, decompte, certification de paiement ou engagement
 *     financier » (paragraphe 7.7), repete dans chaque resultat.
 *
 * DETERMINISME : « memes entrees, meme sortie, octet pour octet »
 *
 *   - aucune horloge, aucun hasard, aucun acces reseau ni disque ;
 *   - ordre total : (1) rapport risque attendu / cout decroissant, compare EXACTEMENT en BigInt
 *     (produit croise, jamais de division flottante), puis a egalite (2) risque courant
 *     decroissant, (3) cout croissant, (4) code du troncon croissant, (5) identifiant croissant.
 *     Les codes et identifiants sont compares par unite de code UTF-16, sans locale ;
 *   - les montants sont des BigInt, rendus en chaines ;
 *   - la sortie se serialise par `canonique()` (cles triees), donc l'ordre des tableaux d'entree
 *     n'a aucune influence : un test le prouve en melangeant les entrees.
 *
 * L'ALGORITHME EST GLOUTON, ET C'EST DIT. Il parcourt les troncons dans l'ordre de priorite et
 * retient ceux qui tiennent dans l'enveloppe restante ; un troncon trop cher est ecarte
 * (BUDGET_INSUFFISANT) mais les suivants, moins chers, restent examines. Ce n'est pas un
 * optimum (sac a dos) : c'est une regle que n'importe quel agent peut refaire a la main, ce qui
 * est le critere A22 (« justifiee »). Un PLNE pourra venir plus tard, comme option.
 *
 * LA PORTEE EST LE TRONCON ENTIER. `portions` compte zero ligne : la plage lineaire d'une fiche
 * est donc [0 ; longueur du troncon]. Ce n'est pas un choix de methode, c'est l'etat des donnees.
 *
 * EXTENSION DU SIMULATEUR (AD-LOT-4), EN ADDITIF STRICT
 *
 * `EntreesScenario.simulation` est un champ OPTIONNEL ET VERSIONNE (`OptionsSimulation.version`). Absent, rien
 * ne change : `construireScenario`, `entreesVersJson` et `entreesDepuisJson` produisent EXACTEMENT les memes
 * octets qu'avant l'extension, si bien qu'un scenario deja scelle (entrees et resultat canoniques, empreintes
 * SHA-256 verifiees par la base) se rejoue identique octet pour octet. Un test le prouve avec les empreintes
 * relevees sur le code d'avant l'extension. Present, le scenario porte en plus : une periode, une logique
 * d'arbitrage nommee, des contraintes (obligatoires, groupes non divisibles, equilibre territorial), la version des
 * baremes (empreinte + liste) et le bloc `simulation` du resultat (bilan, deficit, avertissements). Voir
 * `contraintes.noyau.ts`, `logiques.noyau.ts`, `deficit.noyau.ts`, `comparaison.baremes.noyau.ts`.
 */

import { estimer, formaterMontant, type LigneBareme } from "../engines/cout.noyau";
import { familleCoutDeTroncon } from "../engines/famille-cout";
import { calculerRisque, arrondi4, type EntreesRisque, type FacteurEvalue, type ResultatRisque } from "../engines/risque.noyau";
import {
  choisirTraitement, classeTraficDe, projeterDegradation,
  type ChoixTraitement, type ClasseTrafic, type ConditionTraitement, type LigneMatrice, type ProjectionDegradation, type Traitement,
} from "../engines/traitement.noyau";
import { etiquetteParametres, sontProvisoires, validerParametres, type ParametresProgrammation } from "./parametres.noyau";
import { motifPeremption, type BaremeRef } from "./comparaison.baremes.noyau";
import {
  optionsDepuisJson, optionsVersJson, selectionner, validerOptions,
  type ContrainteInsatisfaite, type OptionsSimulation, type PhaseSelection, type ResumeEquilibre, type ResumeGroupe,
} from "./contraintes.noyau";
import { MENTION_SIMULATION, bilanBudgetaire, pourcentage, type BilanBudgetaire } from "./deficit.noyau";
import { logiqueDe, ordonner, type ElementClassable } from "./logiques.noyau";

export const METHODE_PROGRAMMATION = { id: "programmation-glouton-explicable", version: "1" } as const;

export const AVERTISSEMENT_SANS_ENGAGEMENT =
  "Aucune estimation ni programmation ne crée de marché, contrat, ordre de travaux, chantier, décompte, certification de paiement ou engagement financier.";

/** Plafond de candidats d'un scenario : au-dela, le resultat complet (une justification par ligne) devient illisible et lourd. */
export const MAX_CANDIDATS = 3000;

export interface CandidatTroncon extends EntreesRisque {
  id: string;
  code: string;
  nom: string | null;
  regionId: number | null;
  classe: string | null;
  revetement: string | null;
  /** Longueur a traiter, en metres (le troncon entier : aucune portion n'est saisie). */
  longueurM: number | null;
  /** D'ou vient la longueur : la colonne `longueurKm`, ou la geometrie quand la colonne est vide. `null` = non precise. */
  longueurOrigine?: "LONGUEUR_KM" | "GEOMETRIE" | null;
  /**
   * La colonne `longueurKm` est-elle DERIVEE de la geometrie (`valeurs_qualite` DERIVED) et non saisie ? `null` / absent : inconnu ou
   * sans objet (pas de longueur metier). FAIT DE CHARGEMENT POUR L'AFFICHAGE (liste des candidats) : il n'entre dans aucun calcul et
   * N'EST PAS SERIALISE dans les entrees scellees (`entreesVersJson`) : les empreintes des scenarios sont inchangees.
   */
  longueurMetierDerivee?: boolean | null;
}

export interface EntreesScenario {
  annee: number;
  /** Enveloppe du PAE, en GNF entiers. */
  budgetGnf: bigint;
  /** Plafonds optionnels par region (cle = identifiant de region en chaine), en GNF. Absent = pas de plafond. */
  plafondsRegionauxGnf: Record<string, bigint>;
  parametres: ParametresProgrammation;
  candidats: CandidatTroncon[];
  baremes: LigneBareme[];
  catalogue: Traitement[];
  conditions: ConditionTraitement[];
  matrices: LigneMatrice[];
  /** OPTIONNEL ET VERSIONNE : options du simulateur (periode, logique, contraintes, version des baremes). Absent = scenario annuel herite. */
  simulation?: OptionsSimulation;
}

export type CodeExclusion =
  | "RISQUE_NON_CALCULABLE"
  | "SOUS_SEUIL_RISQUE"
  | "AUCUN_TRAITEMENT"
  | "COUT_NON_ESTIMABLE"
  /** Simulateur : la fenetre de validite du bareme ne couvre pas la periode ; le cout n'est pas simule comme fiable. */
  | "COUT_PERIME"
  | "BUDGET_INSUFFISANT"
  | "PLAFOND_REGIONAL"
  /** Simulateur : ecartee par une contrainte (groupe non divisible incomplet). */
  | "EXCLUE_CONTRAINTE";

/** Ordre dans lequel les lignes ecartees avant classement sont listees. */
const ORDRE_EXCLUSION: readonly CodeExclusion[] = ["RISQUE_NON_CALCULABLE", "SOUS_SEUIL_RISQUE", "AUCUN_TRAITEMENT", "COUT_NON_ESTIMABLE", "COUT_PERIME", "BUDGET_INSUFFISANT", "PLAFOND_REGIONAL", "EXCLUE_CONTRAINTE"];

export interface FacteurTrace {
  facteur: string; poids: number; disponible: boolean; valeur: number | null; brut: number | string | null; origine: string | null; note: string;
}

export type RisqueLigne =
  | { ok: true; score: number; couverture: number; facteursDisponibles: number; facteursPonderes: number; formule: string; facteurs: FacteurTrace[] }
  | { ok: false; code: string; motif: string; facteurs: FacteurTrace[] };

export type CoutLigne =
  | {
      ok: true; montantGnf: string; devise: string; classePrecision: string; margePct: number | null; provisoire: boolean;
      hypothesesManquantes: string[];
      bareme: { id: number | string; code: string | null; typeIntervention: string; coutKmGnf: string; anneeReference: number | null; largeurChausseeM: number | null; approuve: boolean };
      calcul: string;
    }
  | { ok: false; code: string; motif: string };

export interface LigneScenario {
  troncon: { id: string; code: string; nom: string | null; regionId: number | null; classe: string | null; revetement: string | null; etat: string | null; longueurM: number | null; longueurOrigine: string | null };
  decision: "RETENUE" | "ECARTEE";
  /** Position dans l'ordre de priorite, parmi les troncons chiffrables. `null` si ecarte avant classement. */
  rangPriorite: number | null;
  /** Rang parmi les lignes retenues. `null` si ecartee. */
  rangRetenu: number | null;
  motifExclusion: { code: CodeExclusion; detail: string } | null;
  risque: RisqueLigne;
  projection: ProjectionDegradation | { ok: false; motif: string } | null;
  risqueAttendu: { score: number; scoreMicro: number; formule: string } | null;
  traitement: ChoixTraitement | null;
  cout: CoutLigne | null;
  priorite: { ratioPointsParMilliardGnf: string; formule: string } | null;
  budget: { resteAvantGnf: string; resteApresGnf: string } | null;
  etiquette: string;
  justification: string;
  /** Present dans un scenario du simulateur seulement. */
  simulation?: LigneSimulation;
}

/** Ce que le simulateur ajoute a une ligne : ordre d'arbitrage ET priorite technique, separes ; la source du cout. */
export interface LigneSimulation {
  /** Position dans l'ordre de la logique choisie (parmi les chiffrables) ; `null` si ecartee avant classement. */
  ordreArbitrage: number | null;
  /** Rang d'examen reel (obligatoires, plancher regional, puis ordre) ; `null` si ecartee avant classement. */
  examen: number | null;
  phase: PhaseSelection | null;
  /** Priorite technique, AFFICHEE a cote de l'ordre d'arbitrage et ne le remplacant jamais. */
  prioriteTechnique: { rang: number | null; source: "lot3_priorite_technique" | "moteur_v2_risque_courant" };
  obligatoire: boolean;
  groupe: number | null;
  /** D'ou vient le cout : ligne de bareme, version, unite, fenetre de validite, approbation. `null` sans cout calcule. */
  coutSource: (Pick<BaremeRef, "version" | "uniteCout" | "devise" | "validDe" | "validA" | "anneeReference"> & { baremeId: number | string; baremeCode: string | null; approuve: boolean }) | null;
  /** Vrai si le cout est utilise dans le bilan : faux pour un cout manquant, perime ou refuse. */
  coutFiable: boolean;
}

export interface AvertissementSimulation { code: string; niveau: "ALERTE" | "INFO"; nb: number | null; message: string }

export interface ResultatSimulation {
  version: 1;
  mention: string;
  periode: { debut: string; fin: string };
  devise: "GNF";
  logique: { code: string; libelle: string; explication: string; regle: string; provisoire: boolean; ordrePersonnalise: string[]; equilibre: { partMinimaleParRegionPct: number } | null };
  bilan: BilanBudgetaire;
  /** Candidats dont le cout n'est pas utilisable (manquant, perime, sans traitement, risque non calculable), par motif. */
  coutsNonFiables: { code: string; nb: number; troncons: string[] }[];
  contraintes: {
    obligatoires: { demandees: string[]; effectives: string[]; retenues: string[]; nonRetenues: string[] };
    groupesNonDivisibles: ResumeGroupe[];
    plafondsRegionauxGnf: Record<string, string>;
    equilibre: ResumeEquilibre[] | null;
    insatisfaisables: ContrainteInsatisfaite[];
  };
  kilometres: {
    /** Somme des longueurs METIER (colonne `longueurKm`) des interventions retenues, en metres ; `null` si aucune n'a de longueur metier. */
    metierM: number | null;
    metierKm: string | null;
    lignesAvecLongueurMetier: number;
    lignesSansLongueurMetier: number;
    /** Longueur calculee sur la geometrie des lignes SANS longueur metier : AFFICHEE A PART, jamais ajoutee au metier. */
    geometriqueM: number | null;
    geometriqueKm: string | null;
    note: string;
  };
  risqueCouvert: {
    retenuMicro: number; totalChiffrableMicro: number; totalCalculableMicro: number;
    partChiffrablePct: string | null; partCalculablePct: string | null; nbSansRisqueCalculable: number;
  };
  distributionRegionale: { regionId: number | null; nbRetenues: number; engageGnf: string; nbEcartees: number; besoinGnf: string }[];
  baremes: { empreinte: string; nbLignes: number; nbApprouvees: number; nbProvisoires: number; liste: BaremeRef[] };
  parametresVersion: string;
  rangsTechniquesSource: "lot3_priorite_technique" | "moteur_v2_risque_courant";
  avertissements: AvertissementSimulation[];
}

export interface Scenario {
  methode: { id: string; version: string };
  annee: number;
  budgetGnf: string;
  parametres: { version: string; source: string; approuveeLe: string | null; etiquette: string };
  provisoire: boolean;
  etiquette: string;
  /** Pourquoi le scenario est provisoire (vide si tout est approuve). */
  motifsProvisoire: string[];
  /** Ce que le scenario ne sait pas ou ne fait pas. */
  limites: string[];
  avertissement: string;
  totaux: {
    candidats: number; eligibles: number; retenues: number; ecartees: number;
    engageGnf: string; resteGnf: string;
    ecartesParMotif: Record<string, number>;
    engageParRegionGnf: Record<string, string>;
  };
  lignes: LigneScenario[];
  /** Present dans un scenario du simulateur seulement. */
  simulation?: ResultatSimulation;
}

export type ResultatConstruction = { ok: true; scenario: Scenario } | { ok: false; code: "ENTREES_INVALIDES"; erreurs: string[] };

// ---------------------------------------------------------------------------------------------
// Validation des entrees
// ---------------------------------------------------------------------------------------------

const estNul = (v: unknown) => v === null || v === undefined;
const nombreOuNul = (v: unknown) => estNul(v) || (typeof v === "number" && Number.isFinite(v));

export function validerEntrees(e: EntreesScenario): string[] {
  const err: string[] = [];
  if (!Number.isInteger(e.annee) || e.annee < 2000 || e.annee > 2100) err.push("annee : entier entre 2000 et 2100 attendu");
  if (typeof e.budgetGnf !== "bigint" || e.budgetGnf < 0n) err.push("budgetGnf : bigint >= 0 attendu");
  for (const [k, v] of Object.entries(e.plafondsRegionauxGnf ?? {})) {
    if (typeof v !== "bigint" || v < 0n) err.push(`plafondsRegionauxGnf.${k} : bigint >= 0 attendu`);
  }
  const p = validerParametres(e.parametres);
  if (!p.ok) err.push(...p.erreurs.map((x) => `parametres : ${x}`));
  if (!Array.isArray(e.candidats)) err.push("candidats : tableau attendu");
  else {
    if (e.candidats.length > MAX_CANDIDATS) err.push(`candidats : ${e.candidats.length} depasse le plafond de ${MAX_CANDIDATS} (restreindre le perimetre)`);
    const vus = new Set<string>();
    for (const c of e.candidats) {
      if (typeof c.id !== "string" || c.id.length === 0) { err.push("candidat sans identifiant"); continue; }
      if (vus.has(c.id)) err.push(`candidat en double : ${c.id}`);
      vus.add(c.id);
      if (typeof c.code !== "string" || c.code.length === 0) err.push(`candidat ${c.id} : code manquant`);
      for (const champ of ["traficMoyenJma", "criticiteStrategique", "nbPointsNoirs", "vulnerabiliteClimatique", "populationDesservie", "longueurM"] as const) {
        if (!nombreOuNul(c[champ])) err.push(`candidat ${c.id} : ${champ} doit etre un nombre fini ou null`);
      }
    }
  }
  for (const [nom, tab] of [["baremes", e.baremes], ["catalogue", e.catalogue], ["conditions", e.conditions], ["matrices", e.matrices]] as const) {
    if (!Array.isArray(tab)) err.push(`${nom} : tableau attendu`);
  }
  // Options du simulateur : jugees seulement si elles sont presentes (un scenario herite n'est jamais touche).
  if (e.simulation !== undefined && Array.isArray(e.candidats) && Array.isArray(e.baremes)) {
    const regions = [...new Set(e.candidats.map((c) => c.regionId).filter((r): r is number => typeof r === "number"))];
    err.push(...validerOptions(e.simulation, { annee: e.annee, candidatIds: new Set(e.candidats.map((c) => c.id)), regionsCandidates: regions, baremes: e.baremes }));
  }
  return err;
}

// ---------------------------------------------------------------------------------------------
// Evaluation d'un candidat
// ---------------------------------------------------------------------------------------------

interface Evalue {
  c: CandidatTroncon;
  risque: RisqueLigne;
  risqueCalc: ResultatRisque;
  exclusion: { code: CodeExclusion; detail: string } | null;
  traitement: ChoixTraitement | null;
  cout: CoutLigne | null;
  coutMontant: bigint | null;
  projection: LigneScenario["projection"];
  attendu: { score: number; scoreMicro: number; formule: string } | null;
  provisoireCout: boolean;
  matriceApprouvee: boolean | null;
}

function tracerFacteurs(fs: FacteurEvalue[]): FacteurTrace[] {
  return fs.map((f) => ({ facteur: f.facteur, poids: f.poids, disponible: f.disponible, valeur: f.valeur, brut: f.brut, origine: f.origine, note: f.note }));
}

const FORMULE_ATTENDU = "risque attendu = risque courant + p(horizon) x (risque a l'etat suivant - risque courant) ; sans projection, risque attendu = risque courant";
const FORMULE_PRIORITE = "priorite = risque attendu / cout en milliards de GNF (points de risque par milliard) ; comparaison exacte en entiers";

function evaluer(c: CandidatTroncon, e: EntreesScenario): Evalue {
  const p = e.parametres;
  const rc = calculerRisque(c, p);
  const base: Evalue = {
    c, risqueCalc: rc, exclusion: null, traitement: null, cout: null, coutMontant: null, projection: null, attendu: null, provisoireCout: false, matriceApprouvee: null,
    risque: rc.ok
      ? { ok: true, score: rc.score, couverture: rc.couverture, facteursDisponibles: rc.facteursDisponibles, facteursPonderes: rc.facteursPonderes, formule: rc.formule, facteurs: tracerFacteurs(rc.facteurs) }
      : { ok: false, code: rc.code, motif: rc.motif, facteurs: tracerFacteurs(rc.facteurs) },
  };
  if (!rc.ok) {
    return { ...base, exclusion: { code: "RISQUE_NON_CALCULABLE", detail: `${rc.code} : ${rc.motif}` } };
  }
  const seuil = p.valeurs.seuilRisqueMinimal;
  if (seuil !== null && rc.score < seuil) {
    return { ...base, exclusion: { code: "SOUS_SEUIL_RISQUE", detail: `risque ${rc.score} sous le seuil ${seuil}` } };
  }

  const famille = familleCoutDeTroncon(c.revetement);
  const classe: ClasseTrafic | null = classeTraficDe(c.traficMoyenJma, p.valeurs.seuilsClasseTrafic);
  const etat = c.etat as string; // non nul : le risque est calcule, donc l'etat est evaluable
  const ch = choisirTraitement({ familleRevetement: famille, etat, classeTrafic: classe }, e.catalogue, e.conditions);
  if (!ch.ok) {
    return { ...base, traitement: ch, exclusion: { code: "AUCUN_TRAITEMENT", detail: `${ch.code} : ${ch.motif}` } };
  }

  const est = estimer(
    { familleRevetement: famille as string, etatDepart: etat, longueurM: c.longueurM ?? Number.NaN, niveauMesure: "REFERENTIEL", typeIntervention: ch.traitement.code },
    e.baremes,
  );
  if (!est.ok) {
    return { ...base, traitement: ch, cout: { ok: false, code: est.code, motif: est.motif }, exclusion: { code: "COUT_NON_ESTIMABLE", detail: `${est.code} : ${est.motif}` } };
  }
  if (e.simulation) {
    // AD-09 : un cout dont la fenetre de validite ne couvre pas la periode n'est PAS simule comme s'il etait fiable.
    const ref = e.simulation.baremes.liste.find((r) => String(r.id) === String(est.bareme.id));
    const peremption = ref ? motifPeremption(ref, e.simulation.periode) : `la ligne de barème ${String(est.bareme.id)} n'est pas dans la version enregistrée`;
    if (peremption !== null) {
      const motif = `le coût n'est pas fiable pour la période : ${peremption}`;
      return { ...base, traitement: ch, cout: { ok: false, code: "COUT_PERIME", motif }, exclusion: { code: "COUT_PERIME", detail: `COUT_PERIME : ${motif}` } };
    }
  }
  if (est.montant <= 0n) {
    const motif = "le montant estime est nul : la longueur est inferieure a un demi-metre";
    return { ...base, traitement: ch, cout: { ok: false, code: "MONTANT_NUL", motif }, exclusion: { code: "COUT_NON_ESTIMABLE", detail: `MONTANT_NUL : ${motif}` } };
  }
  const cout: CoutLigne = {
    ok: true, montantGnf: est.montant.toString(), devise: est.devise, classePrecision: est.classePrecision, margePct: est.margePct,
    provisoire: est.provisoire, hypothesesManquantes: est.hypothesesManquantes,
    bareme: {
      id: est.bareme.id, code: est.bareme.code, typeIntervention: est.bareme.typeIntervention, coutKmGnf: est.bareme.coutKm.toString(),
      anneeReference: est.bareme.anneeReference, largeurChausseeM: est.bareme.largeurChausseeM, approuve: est.bareme.approuve,
    },
    calcul: est.calcul,
  };

  const proj = projeterDegradation({ familleRevetement: famille, etat, classeTrafic: classe, horizonAnnees: p.valeurs.horizonAnnees }, e.matrices);
  let attendu = rc.score;
  let matriceApprouvee: boolean | null = null;
  if (proj.ok) {
    matriceApprouvee = proj.matrice.approuvee;
    if (proj.etatSuivant !== null) {
      const suivant = calculerRisque({ ...c, etat: proj.etatSuivant }, p);
      if (suivant.ok) attendu = arrondi4(rc.score + proj.pHorizon * (suivant.score - rc.score));
    }
  }
  return {
    ...base, traitement: ch, cout, coutMontant: est.montant, projection: proj, provisoireCout: est.provisoire, matriceApprouvee,
    attendu: { score: attendu, scoreMicro: Math.round(attendu * 10000), formule: FORMULE_ATTENDU },
  };
}

// ---------------------------------------------------------------------------------------------
// Ordre total et ratio exact
// ---------------------------------------------------------------------------------------------

function comparerPriorite(a: Evalue, b: Evalue): number {
  const ca = a.coutMontant as bigint, cb = b.coutMontant as bigint;
  const g = BigInt((a.attendu as { scoreMicro: number }).scoreMicro) * cb;
  const d = BigInt((b.attendu as { scoreMicro: number }).scoreMicro) * ca;
  if (g !== d) return g > d ? -1 : 1;
  const ra = (a.risqueCalc as { scoreMicro: number }).scoreMicro, rb = (b.risqueCalc as { scoreMicro: number }).scoreMicro;
  if (ra !== rb) return ra > rb ? -1 : 1;
  if (ca !== cb) return ca < cb ? -1 : 1;
  if (a.c.code !== b.c.code) return a.c.code < b.c.code ? -1 : 1;
  return a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0;
}

/** Points de risque par milliard de GNF, 4 decimales, calcule en entiers (aucun flottant). */
export function ratioPointsParMilliard(scoreMicro: number, coutGnf: bigint): string {
  const q = (BigInt(scoreMicro) * 1_000_000_000n) / coutGnf;
  return `${(q / 10000n).toString()}.${(q % 10000n).toString().padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------------------------
// Construction du scenario
// ---------------------------------------------------------------------------------------------

function ligneDe(ev: Evalue, extra: Partial<LigneScenario> & Pick<LigneScenario, "decision" | "justification">, etiquette: string): LigneScenario {
  return {
    troncon: { id: ev.c.id, code: ev.c.code, nom: ev.c.nom, regionId: ev.c.regionId, classe: ev.c.classe, revetement: ev.c.revetement, etat: ev.c.etat, longueurM: ev.c.longueurM, longueurOrigine: ev.c.longueurOrigine ?? null },
    rangPriorite: null, rangRetenu: null, motifExclusion: null,
    risque: ev.risque, projection: ev.projection, risqueAttendu: ev.attendu, traitement: ev.traitement, cout: ev.cout,
    priorite: null, budget: null, etiquette,
    ...extra,
  };
}

const LIMITES: readonly string[] = [
  "Le risque est une somme pondérée renormalisée sur les facteurs disponibles, et non le produit état x trafic x sécurité x climat x population du mandat : un produit n'a pas de sens quand un facteur manque.",
  "L'effet des traitements n'est pas modélisé (effetSurIndice, dureeVieAttendueAns et fenetreRealisation du catalogue sont nuls) : un traitement est supposé lever le risque qu'il traite.",
  "La portée est le tronçon entier : aucune portion n'est saisie, la plage linéaire d'une intervention est donc [0 ; longueur du tronçon].",
  "Le classement est glouton, non optimal : il retient dans l'ordre de priorité ce qui tient dans l'enveloppe restante.",
  "Les montants sont des estimations réseau (classe RESEAU_30, plus ou moins 30 %) sur un barème sans millésime ni largeur de chaussée tant que D-07 n'est pas tranchée.",
];

/**
 * Ce qui rend le scenario provisoire : chaque cause est nommee, rien n'est suppose approuve. `retenues` : les lignes
 * RETENUES seulement (un cout, un traitement ou une matrice non approuves d'une ligne ecartee ne rendent pas le resultat provisoire).
 */
function motifsProvisoireDe(p: ParametresProgrammation, retenues: readonly LigneScenario[]): string[] {
  const motifs: string[] = [];
  if (sontProvisoires(p)) motifs.push(`paramètres de programmation non approuvés (version ${p.version}, source ${p.source})`);
  const coutsProv = retenues.filter((l) => l.cout && l.cout.ok && l.cout.provisoire);
  if (coutsProv.length > 0) {
    const hyp = [...new Set(coutsProv.flatMap((l) => (l.cout as { hypothesesManquantes: string[] }).hypothesesManquantes))].sort();
    motifs.push(`${coutsProv.length} ligne(s) retenue(s) chiffrée(s) sur un barème provisoire : ${hyp.join(", ")}`);
  }
  const traitNonAppr = [...new Set(retenues.filter((l) => l.traitement && l.traitement.ok && !l.traitement.traitement.approuve).map((l) => (l.traitement as { ok: true; traitement: { code: string } }).traitement.code))].sort();
  if (traitNonAppr.length > 0) motifs.push(`traitement(s) du catalogue non approuvé(s) : ${traitNonAppr.join(", ")}`);
  const longueursCalculees = retenues.filter((l) => l.troncon.longueurOrigine === "GEOMETRIE").length;
  if (longueursCalculees > 0) motifs.push(`${longueursCalculees} ligne(s) retenue(s) chiffrée(s) sur une longueur calculée sur la géométrie, non saisie`);
  const matNonAppr = retenues.filter((l) => l.projection && l.projection.ok && !l.projection.matrice.approuvee).length;
  if (matNonAppr > 0) motifs.push(`${matNonAppr} ligne(s) retenue(s) projetée(s) par une matrice de dégradation non approuvée`);
  return motifs;
}

/**
 * Construit le scenario. Fonction pure : appelee deux fois avec les memes entrees, elle rend deux
 * objets dont `canonique()` est identique octet pour octet.
 */
export function construireScenario(entrees: EntreesScenario): ResultatConstruction {
  const erreurs = validerEntrees(entrees);
  if (erreurs.length > 0) return { ok: false, code: "ENTREES_INVALIDES", erreurs };
  if (entrees.simulation !== undefined) return { ok: true, scenario: construireSimulation(entrees, entrees.simulation) };

  const p = entrees.parametres;
  const etiquette = etiquetteParametres(p);
  const evalues = entrees.candidats.map((c) => evaluer(c, entrees));

  const eligibles = evalues.filter((x) => x.exclusion === null).sort(comparerPriorite);
  const exclus = evalues.filter((x) => x.exclusion !== null);

  let reste = entrees.budgetGnf;
  const engageRegion = new Map<string, bigint>();
  const lignesClassees: LigneScenario[] = [];
  let rangRetenu = 0;
  let engage = 0n;

  eligibles.forEach((ev, i) => {
    const cout = ev.coutMontant as bigint;
    const regionCle = ev.c.regionId === null ? "" : String(ev.c.regionId);
    const plafond = regionCle === "" ? undefined : entrees.plafondsRegionauxGnf[regionCle];
    const dejaRegion = engageRegion.get(regionCle) ?? 0n;
    const att = ev.attendu as { score: number; scoreMicro: number; formule: string };
    const ratio = ratioPointsParMilliard(att.scoreMicro, cout);
    const rangPriorite = i + 1;
    const risque = (ev.risqueCalc as { score: number }).score;
    const longueurNote = ev.c.longueurOrigine === "GEOMETRIE" ? ` sur ${ev.c.longueurM} m calculés sur la géométrie` : ev.c.longueurM !== null ? ` sur ${ev.c.longueurM} m` : "";
    const resume = `risque ${risque} (attendu ${att.score}), traitement ${(ev.traitement as { ok: true; traitement: { code: string } }).traitement.code}, coût ${formaterMontant(cout, "GNF")}${longueurNote} (${(ev.cout as { classePrecision: string }).classePrecision}${ev.provisoireCout ? ", provisoire" : ""}), ${ratio} point(s) de risque par milliard de GNF`;
    const budgetAvant = reste;

    let motif: { code: CodeExclusion; detail: string } | null = null;
    if (cout > reste) {
      motif = { code: "BUDGET_INSUFFISANT", detail: `coût ${cout.toString()} supérieur au reste de l'enveloppe ${reste.toString()}` };
    } else if (plafond !== undefined && dejaRegion + cout > plafond) {
      motif = { code: "PLAFOND_REGIONAL", detail: `région ${regionCle} : engagé ${dejaRegion.toString()} + ${cout.toString()} dépasse le plafond ${plafond.toString()}` };
    }

    if (motif) {
      lignesClassees.push(ligneDe(ev, {
        decision: "ECARTEE", rangPriorite, motifExclusion: motif,
        priorite: { ratioPointsParMilliardGnf: ratio, formule: FORMULE_PRIORITE },
        budget: { resteAvantGnf: budgetAvant.toString(), resteApresGnf: budgetAvant.toString() },
        justification: `Écartée au rang de priorité ${rangPriorite}/${eligibles.length} (${motif.code}) : ${motif.detail}. ${resume}.`,
      }, etiquette));
      return;
    }
    reste -= cout;
    engage += cout;
    engageRegion.set(regionCle, dejaRegion + cout);
    rangRetenu += 1;
    lignesClassees.push(ligneDe(ev, {
      decision: "RETENUE", rangPriorite, rangRetenu,
      priorite: { ratioPointsParMilliardGnf: ratio, formule: FORMULE_PRIORITE },
      budget: { resteAvantGnf: budgetAvant.toString(), resteApresGnf: reste.toString() },
      justification: `Retenue (rang ${rangRetenu}, priorité ${rangPriorite}/${eligibles.length}) : ${resume} ; reste de l'enveloppe ${budgetAvant.toString()} puis ${reste.toString()} GNF.`,
    }, etiquette));
  });

  const lignesExclues: LigneScenario[] = exclus
    .sort((a, b) => {
      const ia = ORDRE_EXCLUSION.indexOf((a.exclusion as { code: CodeExclusion }).code), ib = ORDRE_EXCLUSION.indexOf((b.exclusion as { code: CodeExclusion }).code);
      if (ia !== ib) return ia - ib;
      if (a.c.code !== b.c.code) return a.c.code < b.c.code ? -1 : 1;
      return a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0;
    })
    .map((ev) => ligneDe(ev, {
      decision: "ECARTEE", motifExclusion: ev.exclusion,
      justification: `Écartée avant classement (${(ev.exclusion as { code: string }).code}) : ${(ev.exclusion as { detail: string }).detail}.`,
    }, etiquette));

  const lignes = [...lignesClassees, ...lignesExclues];
  const retenues = lignes.filter((l) => l.decision === "RETENUE");

  const motifsProvisoire = motifsProvisoireDe(p, retenues);

  const ecartesParMotif: Record<string, number> = {};
  for (const l of lignes) if (l.motifExclusion) ecartesParMotif[l.motifExclusion.code] = (ecartesParMotif[l.motifExclusion.code] ?? 0) + 1;
  const engageParRegionGnf: Record<string, string> = {};
  for (const [k, v] of engageRegion) engageParRegionGnf[k === "" ? "(sans region)" : k] = v.toString();

  const provisoire = motifsProvisoire.length > 0;
  const scenario: Scenario = {
    methode: { ...METHODE_PROGRAMMATION },
    annee: entrees.annee,
    budgetGnf: entrees.budgetGnf.toString(),
    parametres: { version: p.version, source: p.source, approuveeLe: p.approuveeLe, etiquette },
    provisoire,
    etiquette: provisoire ? "PROVISOIRE, non approuvé" : "paramètres et barèmes approuvés",
    motifsProvisoire,
    limites: [...LIMITES],
    avertissement: AVERTISSEMENT_SANS_ENGAGEMENT,
    totaux: {
      candidats: entrees.candidats.length, eligibles: eligibles.length, retenues: retenues.length,
      ecartees: lignes.length - retenues.length,
      engageGnf: engage.toString(), resteGnf: reste.toString(), ecartesParMotif, engageParRegionGnf,
    },
    lignes,
  };
  return { ok: true, scenario };
}

// ---------------------------------------------------------------------------------------------
// Simulateur (AD-LOT-4) : meme evaluation des candidats, autre selection
// ---------------------------------------------------------------------------------------------

const LIMITES_SIMULATION: readonly string[] = [
  "Règles de financement : aucune n'existe dans le modèle de données (source de financement en texte libre sur le chantier, clé étrangère sur le marché) ; elles ne sont pas modélisées.",
  "« Coûts non divisibles » : lu comme un groupe de tronçons financé en entier ou pas du tout, une intervention n'étant jamais fractionnée ; faute de définition métier, c'est une convention provisoire.",
  "Une intervention obligatoire dont le risque, le traitement ou le coût n'est pas calculable n'est pas financée : le simulateur n'invente aucun coût pour la retenir.",
  "Le déficit est un minorant lorsque des coûts sont manquants ou périmés : ces interventions ne sont pas comptées dans le besoin.",
  "La priorité technique affichée est celle du moteur v2 (risque courant décroissant) tant que le lot de priorisation ne fournit pas ses rangs ; l'ordre d'arbitrage ne la remplace jamais.",
  "L'enveloppe couvre toute la période simulée : aucune répartition entre les années d'une période pluriannuelle n'est faite ici (voir le plan pluriannuel).",
];

/** Motifs dont le cout n'est pas utilisable : l'intervention n'entre pas dans le besoin, le deficit est alors un minorant. */
const CODES_COUT_NON_FIABLE: readonly CodeExclusion[] = ["RISQUE_NON_CALCULABLE", "AUCUN_TRAITEMENT", "COUT_NON_ESTIMABLE", "COUT_PERIME"];

const LIBELLE_PHASE: Record<PhaseSelection, string> = { OBLIGATOIRE: "intervention obligatoire", PLANCHER_REGIONAL: "plancher régional", ORDRE: "ordre d'arbitrage" };

const kmDe = (m: number): string => `${Math.floor(m / 1000)}.${String(m % 1000).padStart(3, "0")}`;

const comparerTexte = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function construireSimulation(entrees: EntreesScenario, optionsBrutes: OptionsSimulation): Scenario {
  // Les options sont normalisees (tableaux sans ordre propre tries) : le rejeu, qui relit le texte stocke deja normalise, doit voir les memes numeros de groupe.
  const opts = optionsDepuisJson(optionsVersJson(optionsBrutes));
  if (!opts.ok) throw new Error(`options illisibles apres normalisation : ${opts.erreurs.join(" ; ")}`);
  const o = opts.options;
  const p = entrees.parametres;
  const etiquette = etiquetteParametres(p);
  const logique = logiqueDe(o.logique);

  const evalues = entrees.candidats.map((c) => evaluer(c, entrees));
  const eligibles = evalues.filter((x) => x.exclusion === null);
  const exclus = evalues.filter((x) => x.exclusion !== null);
  const parId = new Map(evalues.map((ev) => [ev.c.id, ev] as const));
  const micro = (ev: Evalue): number => (ev.risqueCalc as { scoreMicro: number }).scoreMicro;

  const elements: ElementClassable[] = eligibles.map((ev) => ({
    id: ev.c.id, code: ev.c.code, regionId: ev.c.regionId, coutGnf: ev.coutMontant as bigint,
    risqueMicro: micro(ev), attenduMicro: (ev.attendu as { scoreMicro: number }).scoreMicro, etat: ev.c.etat,
  }));
  const ordre = ordonner(elements, o.logique, o.ordrePersonnalise);
  const rangArbitrage = new Map(ordre.map((x, i) => [x.id, i + 1] as const));
  const regionsCandidates = [...new Set(entrees.candidats.map((c) => c.regionId).filter((r): r is number => r !== null))].sort((a, b) => a - b);

  const sel = selectionner({
    ordre, enveloppeGnf: entrees.budgetGnf, plafondsRegionauxGnf: entrees.plafondsRegionauxGnf,
    obligatoires: o.obligatoires, groupes: o.groupesNonDivisibles, equilibre: o.equilibre, regionsCandidates,
    exclus: new Map(exclus.map((ev) => [ev.c.id, ev.exclusion as { code: string; detail: string }] as const)),
    idsCandidats: new Set(entrees.candidats.map((c) => c.id)),
    codeDe: (id) => parId.get(id)?.c.code ?? id,
  });
  const obligatoires = new Set(sel.obligatoires.effectives);
  const groupeDe = (id: string): number | null => { const i = o.groupesNonDivisibles.findIndex((g) => g.includes(id)); return i < 0 ? null : i + 1; };

  // Priorite technique : les rangs du lot 3 s'ils sont fournis, sinon le risque courant du moteur v2. Affichee, jamais substituee a l'ordre d'arbitrage.
  const sourceRang = o.rangsTechniques !== null ? "lot3_priorite_technique" as const : "moteur_v2_risque_courant" as const;
  const rangV2 = new Map<string, number>();
  if (o.rangsTechniques === null) {
    evalues.filter((ev) => ev.risqueCalc.ok)
      .sort((a, b) => micro(b) - micro(a) || comparerTexte(a.c.code, b.c.code) || comparerTexte(a.c.id, b.c.id))
      .forEach((ev, i) => rangV2.set(ev.c.id, i + 1));
  }
  const prioriteTechnique = (id: string) => ({ rang: o.rangsTechniques !== null ? (o.rangsTechniques[id] ?? null) : (rangV2.get(id) ?? null), source: sourceRang });

  const coutSourceDe = (ev: Evalue): LigneSimulation["coutSource"] => {
    const c = ev.cout;
    if (!c || !c.ok) return null;
    const ref = o.baremes.liste.find((r) => String(r.id) === String(c.bareme.id));
    return {
      baremeId: c.bareme.id, baremeCode: c.bareme.code, approuve: c.bareme.approuve, version: ref?.version ?? null, uniteCout: ref?.uniteCout ?? "KM",
      devise: c.devise, validDe: ref?.validDe ?? null, validA: ref?.validA ?? null, anneeReference: c.bareme.anneeReference,
    };
  };

  const retenuesEnOrdre = ordre.filter((x) => sel.decisions.get(x.id)?.retenue === true);
  const rangRetenuDe = new Map(retenuesEnOrdre.map((x, i) => [x.id, i + 1] as const));

  const lignesClassees: LigneScenario[] = ordre.map((x) => {
    const ev = parId.get(x.id) as Evalue;
    const d = sel.decisions.get(x.id);
    if (!d) throw new Error(`selection incomplete : aucune decision pour ${x.id}`);
    const att = ev.attendu as { score: number; scoreMicro: number };
    const ratio = ratioPointsParMilliard(att.scoreMicro, x.coutGnf);
    const risque = (ev.risqueCalc as { score: number }).score;
    const longueurNote = ev.c.longueurOrigine === "GEOMETRIE" ? ` sur ${ev.c.longueurM} m calculés sur la géométrie` : ev.c.longueurM !== null ? ` sur ${ev.c.longueurM} m` : "";
    const resume = `risque ${risque} (attendu ${att.score}), traitement ${(ev.traitement as { ok: true; traitement: { code: string } }).traitement.code}, coût ${formaterMontant(x.coutGnf, "GNF")}${longueurNote} (${(ev.cout as { classePrecision: string }).classePrecision}${ev.provisoireCout ? ", provisoire" : ""}), ${ratio} point(s) de risque par milliard de GNF`;
    const rangA = rangArbitrage.get(x.id) as number;
    const simulation: LigneSimulation = {
      ordreArbitrage: rangA, examen: d.examen, phase: d.phase, prioriteTechnique: prioriteTechnique(x.id),
      obligatoire: obligatoires.has(x.id), groupe: d.groupe, coutSource: coutSourceDe(ev), coutFiable: true,
    };
    const base = {
      rangPriorite: rangA, priorite: { ratioPointsParMilliardGnf: ratio, formule: FORMULE_PRIORITE },
      budget: { resteAvantGnf: d.resteAvantGnf.toString(), resteApresGnf: d.resteApresGnf.toString() }, simulation,
    };
    if (d.retenue) {
      const rr = rangRetenuDe.get(x.id) as number;
      return ligneDe(ev, {
        ...base, decision: "RETENUE", rangRetenu: rr,
        justification: `Retenue (rang ${rr}, arbitrage ${rangA}/${ordre.length}, logique ${logique.libelle}, ${LIBELLE_PHASE[d.phase as PhaseSelection]}) : ${resume} ; reste de l'enveloppe ${d.resteAvantGnf.toString()} puis ${d.resteApresGnf.toString()} GNF.`,
      }, etiquette);
    }
    const motif = d.motif as { code: CodeExclusion; detail: string };
    return ligneDe(ev, {
      ...base, decision: "ECARTEE", motifExclusion: motif,
      justification: `Écartée (arbitrage ${rangA}/${ordre.length}, logique ${logique.libelle}, ${motif.code}) : ${motif.detail}. ${resume}.`,
    }, etiquette);
  });

  const lignesExclues: LigneScenario[] = [...exclus]
    .sort((a, b) => {
      const ia = ORDRE_EXCLUSION.indexOf((a.exclusion as { code: CodeExclusion }).code), ib = ORDRE_EXCLUSION.indexOf((b.exclusion as { code: CodeExclusion }).code);
      if (ia !== ib) return ia - ib;
      return comparerTexte(a.c.code, b.c.code) || comparerTexte(a.c.id, b.c.id);
    })
    .map((ev) => ligneDe(ev, {
      decision: "ECARTEE", motifExclusion: ev.exclusion,
      simulation: { ordreArbitrage: null, examen: null, phase: null, prioriteTechnique: prioriteTechnique(ev.c.id), obligatoire: obligatoires.has(ev.c.id), groupe: groupeDe(ev.c.id), coutSource: null, coutFiable: false },
      justification: `Écartée avant classement (${(ev.exclusion as { code: string }).code}) : ${(ev.exclusion as { detail: string }).detail}.`,
    }, etiquette));

  const lignes = [...lignesClassees, ...lignesExclues];
  const retenues = lignes.filter((l) => l.decision === "RETENUE");

  const motifsProvisoire = motifsProvisoireDe(p, retenues);
  if (logique.provisoire) motifsProvisoire.push(`logique d'arbitrage « ${logique.libelle} » : définition provisoire, non validée par le métier`);

  const ecartesParMotif: Record<string, number> = {};
  for (const l of lignes) if (l.motifExclusion) ecartesParMotif[l.motifExclusion.code] = (ecartesParMotif[l.motifExclusion.code] ?? 0) + 1;
  const engageParRegionGnf: Record<string, string> = {};
  for (const [k, v] of sel.engageParRegion) engageParRegionGnf[k === "" ? "(sans region)" : k] = v.toString();

  // Bilan : le besoin ne compte que des couts FIABLES ; les autres sont nommes, jamais valorises.
  const nonFiables = exclus.filter((ev) => CODES_COUT_NON_FIABLE.includes((ev.exclusion as { code: CodeExclusion }).code));
  const bilan = bilanBudgetaire({
    enveloppeGnf: entrees.budgetGnf, consommeGnf: sel.engageGnf, coutsFiablesGnf: ordre.map((x) => x.coutGnf),
    nbCoutsNonFiables: nonFiables.length, coutsObligatoiresGnf: ordre.filter((x) => obligatoires.has(x.id)).map((x) => x.coutGnf),
  });
  const coutsNonFiables = CODES_COUT_NON_FIABLE
    .map((code) => {
      const l = nonFiables.filter((ev) => (ev.exclusion as { code: string }).code === code);
      return { code, nb: l.length, troncons: l.map((ev) => ev.c.code).sort(comparerTexte).slice(0, 50) };
    })
    .filter((x) => x.nb > 0);

  // Kilometres : longueur METIER (colonne longueurKm) seule ; la geometrique est rendue a part, jamais ajoutee.
  let metierM = 0, nbAvec = 0, geoM = 0, nbSans = 0, nbGeo = 0;
  for (const l of retenues) {
    const m = l.troncon.longueurM;
    if (l.troncon.longueurOrigine === "LONGUEUR_KM" && m !== null) { metierM += m; nbAvec += 1; continue; }
    nbSans += 1;
    if (l.troncon.longueurOrigine === "GEOMETRIE" && m !== null) { geoM += m; nbGeo += 1; }
  }
  const kilometres: ResultatSimulation["kilometres"] = {
    metierM: nbAvec > 0 ? metierM : null, metierKm: nbAvec > 0 ? kmDe(metierM) : null,
    lignesAvecLongueurMetier: nbAvec, lignesSansLongueurMetier: nbSans,
    geometriqueM: nbGeo > 0 ? geoM : null, geometriqueKm: nbGeo > 0 ? kmDe(geoM) : null,
    note: nbSans > 0
      ? `Longueur métier absente pour ${nbSans} intervention(s) retenue(s) : leurs kilomètres ne sont pas comptés dans le total métier${nbGeo > 0 ? " ; la longueur géométrique de certaines est donnée à part et n'est pas ajoutée" : ""}.`
      : "Longueur métier (colonne longueurKm) renseignée pour toutes les interventions retenues.",
  };

  const calculables = evalues.filter((ev) => ev.risqueCalc.ok);
  const sommeMicro = (l: readonly Evalue[]): bigint => l.reduce((s, ev) => s + BigInt(micro(ev)), 0n);
  const retenuMicro = sommeMicro(retenues.map((l) => parId.get(l.troncon.id) as Evalue));
  const totalCalculable = sommeMicro(calculables);
  const totalChiffrable = sommeMicro(eligibles);
  const risqueCouvert: ResultatSimulation["risqueCouvert"] = {
    retenuMicro: Number(retenuMicro), totalChiffrableMicro: Number(totalChiffrable), totalCalculableMicro: Number(totalCalculable),
    partChiffrablePct: pourcentage(retenuMicro, totalChiffrable), partCalculablePct: pourcentage(retenuMicro, totalCalculable),
    nbSansRisqueCalculable: evalues.length - calculables.length,
  };

  const regions = new Map<number | null, { nbRetenues: number; engage: bigint; nbEcartees: number; besoin: bigint }>();
  for (const ev of evalues) {
    const k = ev.c.regionId;
    const r = regions.get(k) ?? { nbRetenues: 0, engage: 0n, nbEcartees: 0, besoin: 0n };
    const d = sel.decisions.get(ev.c.id);
    if (d?.retenue) { r.nbRetenues += 1; r.engage += ev.coutMontant as bigint; } else r.nbEcartees += 1;
    if (ev.exclusion === null) r.besoin += ev.coutMontant as bigint;
    regions.set(k, r);
  }
  const distributionRegionale = [...regions.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a - b))
    .map(([regionId, r]) => ({ regionId, nbRetenues: r.nbRetenues, engageGnf: r.engage.toString(), nbEcartees: r.nbEcartees, besoinGnf: r.besoin.toString() }));

  const nbApprouvees = o.baremes.liste.filter((b) => b.approuveLe !== null).length;
  const avertissements: AvertissementSimulation[] = [];
  const motifNb = (code: CodeExclusion) => exclus.filter((ev) => (ev.exclusion as { code: string }).code === code).length;
  const coutPerime = motifNb("COUT_PERIME");
  if (coutPerime > 0) avertissements.push({ code: "COUT_PERIME", niveau: "ALERTE", nb: coutPerime, message: `${coutPerime} intervention(s) écartée(s) : la fenêtre de validité du barème ne couvre pas la période ${o.periode.debut} à ${o.periode.fin}. Elles ne sont pas simulées comme si leur coût était fiable.` });
  const coutManquant = motifNb("COUT_NON_ESTIMABLE");
  if (coutManquant > 0) avertissements.push({ code: "COUT_NON_ESTIMABLE", niveau: "ALERTE", nb: coutManquant, message: `${coutManquant} intervention(s) écartée(s) faute de coût estimable (barème absent ou refus du moteur de coût). Aucun coût n'est inventé.` });
  const sansTraitement = motifNb("AUCUN_TRAITEMENT");
  if (sansTraitement > 0) avertissements.push({ code: "AUCUN_TRAITEMENT", niveau: "ALERTE", nb: sansTraitement, message: `${sansTraitement} intervention(s) écartée(s) faute de traitement applicable : leur besoin n'est pas chiffré.` });
  const sansRisque = motifNb("RISQUE_NON_CALCULABLE");
  if (sansRisque > 0) avertissements.push({ code: "DONNEES_PARTIELLES", niveau: "ALERTE", nb: sansRisque, message: `${sansRisque} tronçon(s) sans risque calculable (facteurs manquants) : ils ne sont ni classés ni chiffrés, et ne sont pas assimilés à un risque faible.` });
  if (bilan.deficitGnf !== "0") avertissements.push({ code: "DEFICIT", niveau: "ALERTE", nb: null, message: `Déficit de ${formaterMontant(BigInt(bilan.deficitGnf), "GNF")} : l'enveloppe de ${formaterMontant(entrees.budgetGnf, "GNF")} ne couvre pas le besoin chiffré de ${formaterMontant(BigInt(bilan.besoinTotalGnf), "GNF")}.` });
  if (bilan.deficitMinorant) avertissements.push({ code: "DEFICIT_MINORANT", niveau: "ALERTE", nb: bilan.nbCoutsNonFiables, message: `${bilan.nbCoutsNonFiables} candidat(s) sans coût fiable ne sont pas comptés dans le besoin : le besoin réel et le déficit sont au moins ceux affichés.` });
  if (sel.insatisfaisables.length > 0) avertissements.push({ code: "CONTRAINTES_INSATISFAISABLES", niveau: "ALERTE", nb: sel.insatisfaisables.length, message: `${sel.insatisfaisables.length} contrainte(s) ne peuvent pas être satisfaites : elles ne sont pas comblées en silence, voir le détail.` });
  const coutsProvisoires = retenues.filter((l) => l.cout && l.cout.ok && l.cout.provisoire).length;
  if (coutsProvisoires > 0) avertissements.push({ code: "COUTS_PROVISOIRES", niveau: "ALERTE", nb: coutsProvisoires, message: `${coutsProvisoires} intervention(s) retenue(s) chiffrée(s) sur un barème provisoire (non approuvé, sans millésime ou sans largeur de chaussée) : estimation réseau, non officielle.` });
  if (nbSans > 0) avertissements.push({ code: "LONGUEUR_METIER_ABSENTE", niveau: "INFO", nb: nbSans, message: kilometres.note });
  if (logique.provisoire) avertissements.push({ code: "LOGIQUE_PROVISOIRE", niveau: "INFO", nb: null, message: `La logique « ${logique.libelle} » repose sur une convention provisoire : ${logique.regle}` });
  if (sontProvisoires(p)) avertissements.push({ code: "PARAMETRES_PROVISOIRES", niveau: "INFO", nb: null, message: `Paramètres ${p.version} non approuvés : poids du risque et seuils sans source officielle.` });
  if (entrees.budgetGnf === 0n) avertissements.push({ code: "ENVELOPPE_NULLE", niveau: "INFO", nb: null, message: "Enveloppe nulle : aucune intervention ne peut être retenue." });

  const provisoire = motifsProvisoire.length > 0;
  const simulation: ResultatSimulation = {
    version: 1, mention: MENTION_SIMULATION, periode: { ...o.periode }, devise: o.devise,
    logique: { code: logique.code, libelle: logique.libelle, explication: logique.explication, regle: logique.regle, provisoire: logique.provisoire, ordrePersonnalise: [...o.ordrePersonnalise], equilibre: o.equilibre === null ? null : { ...o.equilibre } },
    bilan, coutsNonFiables,
    contraintes: {
      obligatoires: sel.obligatoires, groupesNonDivisibles: sel.groupes,
      plafondsRegionauxGnf: Object.fromEntries(Object.entries(entrees.plafondsRegionauxGnf).map(([k, v]) => [k, v.toString()])),
      equilibre: sel.equilibre, insatisfaisables: sel.insatisfaisables,
    },
    kilometres, risqueCouvert, distributionRegionale,
    baremes: { empreinte: o.baremes.empreinte, nbLignes: o.baremes.liste.length, nbApprouvees, nbProvisoires: o.baremes.liste.length - nbApprouvees, liste: o.baremes.liste },
    parametresVersion: p.version, rangsTechniquesSource: sourceRang, avertissements,
  };
  return {
    methode: { ...METHODE_PROGRAMMATION },
    annee: entrees.annee,
    budgetGnf: entrees.budgetGnf.toString(),
    parametres: { version: p.version, source: p.source, approuveeLe: p.approuveeLe, etiquette },
    provisoire,
    etiquette: provisoire ? "PROVISOIRE, non approuvé" : "paramètres et barèmes approuvés",
    motifsProvisoire,
    limites: [...LIMITES, ...LIMITES_SIMULATION],
    avertissement: AVERTISSEMENT_SANS_ENGAGEMENT,
    totaux: {
      candidats: entrees.candidats.length, eligibles: eligibles.length, retenues: retenues.length, ecartees: lignes.length - retenues.length,
      engageGnf: sel.engageGnf.toString(), resteGnf: sel.resteGnf.toString(), ecartesParMotif, engageParRegionGnf,
    },
    lignes,
    simulation,
  };
}

// ---------------------------------------------------------------------------------------------
// Serialisation des entrees (pour stocker un scenario et le rejouer)
// ---------------------------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const dateIso = (d: Date | string | null | undefined): string | null => (d === null || d === undefined ? null : d instanceof Date ? d.toISOString() : d);

function cmp<T>(...cles: ((x: T) => string | number)[]): (a: T, b: T) => number {
  return (a, b) => {
    for (const f of cles) {
      const x = f(a), y = f(b);
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  };
}

/**
 * Entrees en JSON pur : montants en chaines, dates en ISO, tableaux dans un ordre normalise (deux
 * jeux identiques a l'ordre pres donnent le meme texte, donc la meme empreinte).
 */
export function entreesVersJson(e: EntreesScenario): Json {
  const base: { [k: string]: Json } = {
    annee: e.annee,
    budgetGnf: e.budgetGnf.toString(),
    plafondsRegionauxGnf: Object.fromEntries(Object.entries(e.plafondsRegionauxGnf).map(([k, v]) => [k, v.toString()])),
    parametres: {
      version: e.parametres.version, source: e.parametres.source,
      approuveeLe: dateIso(e.parametres.approuveeLe), approuveeParId: e.parametres.approuveeParId,
      valeurs: e.parametres.valeurs as unknown as Json,
    },
    candidats: [...e.candidats].sort(cmp<CandidatTroncon>((c) => c.id)).map((c) => ({
      id: c.id, code: c.code, nom: c.nom, regionId: c.regionId, classe: c.classe, revetement: c.revetement, longueurM: c.longueurM, longueurOrigine: c.longueurOrigine ?? null,
      etat: c.etat, traficMoyenJma: c.traficMoyenJma, criticiteStrategique: c.criticiteStrategique, nbPointsNoirs: c.nbPointsNoirs,
      vulnerabiliteClimatique: c.vulnerabiliteClimatique, populationDesservie: c.populationDesservie,
    })),
    baremes: [...e.baremes].sort(cmp<LigneBareme>((b) => String(b.id))).map((b) => ({
      id: b.id, code: b.code ?? null, familleRevetement: b.familleRevetement, etatDepart: b.etatDepart, typeIntervention: b.typeIntervention,
      coutKmGnf: b.coutKmGnf.toString(), uniteCout: b.uniteCout, devise: b.devise, anneeReference: b.anneeReference ?? null,
      largeurChausseeM: b.largeurChausseeM ?? null, approuveLe: dateIso(b.approuveLe), actif: b.actif !== false,
    })),
    catalogue: [...e.catalogue].sort(cmp<Traitement>((t) => t.code)).map((t) => ({
      code: t.code, libelle: t.libelle, famille: t.famille, dureeVieAttendueAns: t.dureeVieAttendueAns ?? null,
      effetSurIndice: t.effetSurIndice === undefined || t.effetSurIndice === null ? null : String(t.effetSurIndice),
      fenetreRealisation: t.fenetreRealisation ?? null, version: t.version ?? null, approuveLe: dateIso(t.approuveLe), actif: t.actif !== false,
    })),
    conditions: [...e.conditions].sort(cmp<ConditionTraitement>((c) => c.familleRevetement, (c) => c.etatDepart, (c) => c.classeTrafic ?? "", (c) => c.traitementCode)).map((c) => ({
      traitementCode: c.traitementCode, familleRevetement: c.familleRevetement, etatDepart: c.etatDepart, classeTrafic: c.classeTrafic ?? null, actif: c.actif !== false,
    })),
    matrices: [...e.matrices].sort(cmp<LigneMatrice>((m) => m.familleRevetement, (m) => m.classeTrafic)).map((m) => ({
      familleRevetement: m.familleRevetement, classeTrafic: m.classeTrafic, pBonVersMoyen: m.pBonVersMoyen, pMoyenVersMauvais: m.pMoyenVersMauvais,
      pMauvaisVersCritique: m.pMauvaisVersCritique, version: m.version ?? null, approuveLe: dateIso(m.approuveLe), actif: m.actif !== false,
    })),
  };
  // Champ OPTIONNEL : absent d'un scenario herite, dont le texte canonique reste donc identique octet pour octet.
  if (e.simulation !== undefined) base.simulation = optionsVersJson(e.simulation);
  return base;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const tab = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);
const chaineOuNul = (v: unknown): string | null => (typeof v === "string" ? v : null);
const nombreOuNull = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** Relit des entrees stockees. Les bigint doivent etre des chaines de chiffres : tout autre contenu est refuse. */
export function entreesDepuisJson(j: unknown): { ok: true; entrees: EntreesScenario } | { ok: false; erreurs: string[] } {
  const o = obj(j);
  const erreurs: string[] = [];
  const grand = (v: unknown, chemin: string): bigint => {
    if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
    erreurs.push(`${chemin} : chaine de chiffres attendue`);
    return 0n;
  };
  const par = obj(o.parametres);
  const entrees: EntreesScenario = {
    annee: o.annee as number,
    budgetGnf: grand(o.budgetGnf, "budgetGnf"),
    plafondsRegionauxGnf: Object.fromEntries(Object.entries(obj(o.plafondsRegionauxGnf)).map(([k, v]) => [k, grand(v, `plafondsRegionauxGnf.${k}`)])),
    parametres: {
      version: par.version as string, source: par.source as ParametresProgrammation["source"],
      approuveeLe: chaineOuNul(par.approuveeLe), approuveeParId: chaineOuNul(par.approuveeParId),
      valeurs: par.valeurs as ParametresProgrammation["valeurs"],
    },
    candidats: tab(o.candidats).map((c) => ({
      id: c.id as string, code: c.code as string, nom: chaineOuNul(c.nom), regionId: nombreOuNull(c.regionId), classe: chaineOuNul(c.classe),
      revetement: chaineOuNul(c.revetement), longueurM: nombreOuNull(c.longueurM), etat: chaineOuNul(c.etat),
      longueurOrigine: c.longueurOrigine === "LONGUEUR_KM" || c.longueurOrigine === "GEOMETRIE" ? c.longueurOrigine : null,
      traficMoyenJma: nombreOuNull(c.traficMoyenJma), criticiteStrategique: nombreOuNull(c.criticiteStrategique), nbPointsNoirs: nombreOuNull(c.nbPointsNoirs),
      vulnerabiliteClimatique: nombreOuNull(c.vulnerabiliteClimatique), populationDesservie: nombreOuNull(c.populationDesservie),
    })),
    baremes: tab(o.baremes).map((b, i) => ({
      id: b.id as number | string, code: chaineOuNul(b.code), familleRevetement: b.familleRevetement as string, etatDepart: b.etatDepart as string,
      typeIntervention: b.typeIntervention as string, coutKmGnf: grand(b.coutKmGnf, `baremes[${i}].coutKmGnf`), uniteCout: b.uniteCout as string,
      devise: b.devise as string, anneeReference: nombreOuNull(b.anneeReference), largeurChausseeM: nombreOuNull(b.largeurChausseeM),
      approuveLe: chaineOuNul(b.approuveLe), actif: b.actif !== false,
    })),
    catalogue: tab(o.catalogue).map((t) => ({
      code: t.code as string, libelle: t.libelle as string, famille: t.famille as string, dureeVieAttendueAns: nombreOuNull(t.dureeVieAttendueAns),
      effetSurIndice: chaineOuNul(t.effetSurIndice), fenetreRealisation: chaineOuNul(t.fenetreRealisation), version: nombreOuNull(t.version),
      approuveLe: chaineOuNul(t.approuveLe), actif: t.actif !== false,
    })),
    conditions: tab(o.conditions).map((c) => ({
      traitementCode: c.traitementCode as string, familleRevetement: c.familleRevetement as string, etatDepart: c.etatDepart as string,
      classeTrafic: chaineOuNul(c.classeTrafic), actif: c.actif !== false,
    })),
    matrices: tab(o.matrices).map((m) => ({
      familleRevetement: m.familleRevetement as string, classeTrafic: m.classeTrafic as string, pBonVersMoyen: m.pBonVersMoyen as number,
      pMoyenVersMauvais: m.pMoyenVersMauvais as number, pMauvaisVersCritique: m.pMauvaisVersCritique as number, version: nombreOuNull(m.version),
      approuveLe: chaineOuNul(m.approuveLe), actif: m.actif !== false,
    })),
  };
  if (o.simulation !== undefined && o.simulation !== null) {
    const sim = optionsDepuisJson(o.simulation);
    if (sim.ok) entrees.simulation = sim.options; else erreurs.push(...sim.erreurs);
  }
  if (erreurs.length > 0) return { ok: false, erreurs };
  const invalides = validerEntrees(entrees);
  if (invalides.length > 0) return { ok: false, erreurs: invalides };
  return { ok: true, entrees };
}
