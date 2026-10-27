/**
 * PRIORITE TECHNIQUE EXPLICABLE DES INTERVENTIONS (cahier d'aide a la decision, paragraphes 6.1 a 6.4).
 * Noyau PUR : des faits en entree, un classement en sortie. Aucune base, aucune horloge (la date de reference est un
 * PARAMETRE), aucun hasard.
 *
 * CE MODULE N'EST PAS UN SECOND MOTEUR. Il etend le moteur de programmation v2 :
 *   - la normalisation de l'etat, de l'importance de l'axe (trafic) et de la securite (points noirs) est CELLE de
 *     `engines/risque.noyau.ts` (on lit les facteurs que `calculerRisque` evalue, on ne les reecrit pas) ;
 *   - le cout vient des memes fonctions que le simulateur (`choisirTraitement`, `estimer`) ;
 *   - l'ORDRE D'ARBITRAGE est le rang meme que le simulateur donne (`construireScenario`, enveloppe illimitee), donc le
 *     simulateur et cette liste ne peuvent pas diverger.
 *
 * DEUX CLASSEMENTS, DEUX NOMS, JAMAIS CONFONDUS
 *
 *   prioriteTechnique   « qu'est-ce qui a le plus besoin d'etre examine » : etat, importance de l'axe, securite,
 *                       urgence... Le COUT n'y entre pas. Un troncon critique reste en tete, qu'il soit cher ou non.
 *   ordreArbitrage      « que retenir en premier sous contrainte budgetaire » : risque attendu par milliard de GNF, celui
 *                       du simulateur. Il peut mettre un troncon critique et cher apres un troncon moyen et bon marche ;
 *                       c'est son role, et il ne dit rien de la priorite.
 *
 * LA REGLE DES DONNEES ABSENTES (cahier 6.3 : « score incomplet ou regle documentee et testee, jamais une valeur inventee »)
 *
 *   - un critere sans donnee SORT du calcul avec sa raison (`criteresManquants`) ; il n'est jamais lu comme zero ;
 *   - le score est renormalise sur les criteres disponibles ET la couverture est dite : `scoreIncomplet: true` des qu'un
 *     critere pondere manque ;
 *   - l'etat est le seul critere ESSENTIEL : sans lui, la ligne est EXCLUE (ETAT_NON_EVALUE), jamais classee bonne ni
 *     faible ; sous la couverture minimale, EXCLUE aussi (COUVERTURE_INSUFFISANTE). Une ligne exclue reste dans la liste,
 *     avec son motif, apres les lignes classees : elle n'est pas « en bas du classement », elle n'est pas classee ;
 *   - « zero point noir » n'est une donnee que si le registre de la region est exploite (voir resoudreSecurite).
 *
 * DETERMINISME. Memes entrees, meme classement, meme empreinte SHA-256 de la sortie canonique, quel que soit l'ordre des
 * entrees : ordre total (score decroissant, puis code, puis identifiant, compares par unite de code UTF-16), arrondis a
 * 4 decimales, additions dans l'ordre fixe de `CRITERES_TECHNIQUES`.
 */

import { arrondi4, calculerRisque, type FacteurEvalue } from "../engines/risque.noyau";
import { estimer, type LigneBareme } from "../engines/cout.noyau";
import { familleCoutDeTroncon } from "../engines/famille-cout";
import { choisirTraitement, classeTraficDe, type ConditionTraitement, type LigneMatrice, type Traitement } from "../engines/traitement.noyau";
import { SEUILS_PROVISOIRES, classerLongueur } from "../qualite/detecteurs.noyau";
import { canonique, sha256Hex } from "./canonique";
import { etiquetteParametres, sontProvisoires, validerParametres, type ParametresProgrammation } from "./parametres.noyau";
import { BLOC_PRIORITE_AMORCAGE, CRITERES_TECHNIQUES, MODELE_PRIORITE, dateCalendaireValide, type BlocPriorite, type CritereTechnique } from "./priorite.parametres";
import { MAX_CANDIDATS, construireScenario, type CandidatTroncon } from "./scenario.noyau";

export const MODELE = { id: MODELE_PRIORITE, version: "1" } as const;

export const AVERTISSEMENT_CONSULTATIF = "Consultatif, non engageant : une priorité calculée n'est pas une décision, une estimation de coût n'est pas un engagement.";

/** Enveloppe qui ne limite rien : le simulateur ne sert ici qu'a fournir SON ordre, pas a retenir ou ecarter. */
const ENVELOPPE_ILLIMITEE = 10n ** 18n;

export const CRITERES_ESSENTIELS: readonly CritereTechnique[] = ["ETAT_GRAVITE"];
export const ETATS_DEGRADES: readonly string[] = ["MAUVAIS", "CRITIQUE"];
const ORDRE_ETAT: Record<string, number> = { BON: 0, MOYEN: 1, MAUVAIS: 2, CRITIQUE: 3 };

// ---------------------------------------------------------------------------------------------
// Catalogue des criteres (cahier 6.2)
// ---------------------------------------------------------------------------------------------

export interface DescriptionCritere {
  code: CritereTechnique | "COUT_EFFICACITE";
  libelle: string;
  /** Le cout n'entre pas dans la priorite technique : il fonde l'ordre d'arbitrage. */
  role: "PRIORITE_TECHNIQUE" | "ARBITRAGE";
  /** `NON_DISPONIBLE` : aucune donnee structuree n'existe pour ce critere ; il n'est pas invente. */
  disponibilite: "DISPONIBLE" | "NON_DISPONIBLE";
  source: string;
  normalisation: string;
  prudence: string;
}

export const CRITERES: readonly DescriptionCritere[] = [
  {
    code: "ETAT_GRAVITE", libelle: "État / gravité", role: "PRIORITE_TECHNIQUE", disponibilite: "DISPONIBLE",
    source: "troncons.etat (statut de la valeur : valeurs_qualite)",
    normalisation: "correspondance etat vers risque 0 a 100 des parametres (etatVersRisque), la meme que le moteur de risque",
    prudence: "un etat NON_EVALUE n'est ni bon ni mauvais : la ligne est exclue (ETAT_NON_EVALUE). La gravite des defauts n'est pas modelisee.",
  },
  {
    code: "IMPORTANCE_AXE", libelle: "Importance de l'axe", role: "PRIORITE_TECHNIQUE", disponibilite: "DISPONIBLE",
    source: "troncons.traficMoyenJma (date du comptage affichee), a defaut troncons.criticiteStrategique (provenance non documentee)",
    normalisation: "trafic / plafond (traficPlafondJma) x 100 borne a 100 ; a defaut criticite strategique prise telle quelle sur 0 a 100",
    prudence: "la classe de route n'est PAS convertie en importance (cette conversion a deja ete retiree comme estimation presentee en donnee). Absent si ni comptage ni criticite.",
  },
  {
    code: "SECURITE_CRITICITE", libelle: "Sécurité / criticité", role: "PRIORITE_TECHNIQUE", disponibilite: "DISPONIBLE",
    source: "points_noirs rattaches au troncon, CONFIRMES (statut de validation VALIDE ou non renseigne)",
    normalisation: "nombre de points noirs confirmes / plafond (pointsNoirsPlafond) x 100 borne a 100",
    prudence: "une alerte non confirmee (A_VALIDER, A_CORRIGER) reste distincte et ne compte pas ; zero n'est une donnee que si le registre de la region est exploite (registrePointsNoirsMinimum).",
  },
  {
    code: "ACCESSIBILITE_SERVICE", libelle: "Accessibilité / service", role: "PRIORITE_TECHNIQUE", disponibilite: "NON_DISPONIBLE",
    source: "aucune",
    normalisation: "sans objet : aucune donnee structuree de rupture d'acces, de saisonnalite ou de desserte strategique",
    prudence: "critere declare non disponible, jamais invente. Poids d'amorcage nul ; un poids non nul le rend manquant sur toutes les lignes.",
  },
  {
    code: "URGENCE_TEMPORELLE", libelle: "Urgence temporelle", role: "PRIORITE_TECHNIQUE", disponibilite: "DISPONIBLE",
    source: "inspections (dateInspection, etatObserve) : historique des constats du troncon",
    normalisation: "anciennete de la degradation connue : jours entre la premiere inspection de la serie courante d'inspections a l'etat MAUVAIS ou CRITIQUE et la date de reference, / plafond (urgenceAnciennetePlafondJours) x 100 borne a 100 ; 0 si la derniere inspection n'est pas degradee",
    prudence: "absent sans inspection datee exploitable. L'anciennete du DERNIER constat n'est pas l'urgence (elle mesure la fraicheur de l'information, affichee a part : dernierConstat).",
  },
  {
    code: "COUT_EFFICACITE", libelle: "Coût / efficacité", role: "ARBITRAGE", disponibilite: "DISPONIBLE",
    source: "baremes_intervention via le moteur de cout ; risque attendu via la matrice de degradation",
    normalisation: "ratio risque attendu / cout en milliards de GNF (ordre d'arbitrage du simulateur)",
    prudence: "ne fait pas partie de la priorite technique. Cout et base de cout affiches avec leur unite, leur source et leur validite.",
  },
  {
    code: "MATURITE_FAISABILITE", libelle: "Maturité / faisabilité", role: "PRIORITE_TECHNIQUE", disponibilite: "NON_DISPONIBLE",
    source: "aucune",
    normalisation: "sans objet : aucune donnee d'etudes, de disponibilite du marche ou d'acces chantier",
    prudence: "critere declare non disponible, jamais invente. Preparation technique et approbation financiere ne se confondent pas.",
  },
];

const LIBELLE: Record<string, string> = Object.fromEntries(CRITERES.map((c) => [c.code, c.libelle]));

export const FORMULE_PRIORITE_TECHNIQUE =
  "score = somme(poids x valeur) / somme(poids) sur les criteres ponderes ET disponibles ; valeurs normalisees sur 0 a 100 et arrondies a 4 decimales AVANT agregation ; points d'un critere = poids x valeur / somme des poids disponibles ; scoreIncomplet des qu'un critere pondere manque";

export const DEFINITION_ARBITRAGE =
  "Ordre d'arbitrage : rang du ratio risque attendu / cout (en milliards de GNF) que le simulateur utilise pour retenir des interventions sous une enveloppe. Il depend du cout ; il ne mesure PAS la priorite technique.";

export const LIMITES_MODELE: readonly string[] = [
  "Les poids et seuils sont PROVISOIRES et sans source (D-01) tant que la version de parametres n'est pas approuvee ; la formule finale doit etre confirmee par le metier avant exploitation reelle.",
  "L'objet classe est le troncon entier ; les ouvrages d'art ne sont pas classes (aucun moteur de traitement ni de cout n'existe pour eux).",
  "Deux criteres du cahier n'ont aucune donnee structuree : accessibilite / service et maturite / faisabilite. Ils sont declares non disponibles, jamais inventes.",
  "La gravite des defauts (severite des inspections) n'est pas modelisee ; l'etat est celui du troncon.",
  "L'urgence lit l'historique des inspections ; sans inspection datee, elle est absente (la plupart des troncons, tant que les constats de terrain ne sont pas saisis).",
  "Il n'y a pas d'axe routier en base : aucun regroupement par axe n'est propose.",
  "Le classement est calcule a la volee et n'est pas enregistre : l'historique des recalculs n'existe pas (voir la fiche).",
  "Un score renormalise sur une couverture partielle classe sur ce qui est connu : il est signale incomplet avec ses criteres manquants, il n'est pas comparable terme a terme a un score complet.",
];

// ---------------------------------------------------------------------------------------------
// Entrees
// ---------------------------------------------------------------------------------------------

export interface ConstatDate {
  /** AAAA-MM-JJ. */
  date: string;
  /** Etat observe (BON, MOYEN, MAUVAIS, CRITIQUE, NON_EVALUE). */
  etat: string;
}

export interface PointsNoirsRegistre {
  /** Points noirs du troncon CONFIRMES (validation VALIDE ou non renseignee), non supprimes. */
  confirmes: number;
  /** Points noirs du troncon non confirmes (A_VALIDER, A_CORRIGER) : jamais comptes dans le score. */
  nonConfirmes: number;
  /** Points noirs confirmes de TOUT le registre de la region du troncon (rattaches ou non a un troncon). */
  registreRegion: number;
}

export interface FaitsIntervention {
  id: string;
  code: string;
  nom: string | null;
  regionId: number | null;
  regionNom: string | null;
  classe: string | null;
  revetement: string | null;
  prefecture: string | null;
  etat: string | null;
  traficMoyenJma: number | null;
  /** AAAA-MM-JJ. */
  traficDateComptage: string | null;
  criticiteStrategique: number | null;
  /** `null` : la source des points noirs n'a pas pu etre lue. */
  pointsNoirs: PointsNoirsRegistre | null;
  constats: ConstatDate[];
  /** AAAA-MM-JJ : colonne troncons.dateDerniereEvaluation (ecrite par la propagation d'une inspection). */
  dateDerniereEvaluation: string | null;
  longueurKm: number | null;
  /** La longueur metier est-elle derivee de la geometrie (valeurs_qualite DERIVED) ? `null` : inconnu. */
  longueurMetierDerivee: boolean | null;
  longueurGeometriqueM: number | null;
  localisation: { valide: boolean; motif: string | null };
  qualiteEtat: { statut: string; source: string | null; observeLe: string | null; confiance: string | null } | null;
  sourceTroncon: { type: string | null; confiance: string | null };
}

export interface ValiditeBareme { validDe: string | null; validA: string | null; version: number | null; source: string | null }

export interface EntreesPriorite {
  /** AAAA-MM-JJ : « aujourd'hui » pour le calcul, fourni par l'appelant (le noyau n'a pas d'horloge). */
  dateReference: string;
  parametres: ParametresProgrammation;
  candidats: FaitsIntervention[];
  baremes: LigneBareme[];
  catalogue: Traitement[];
  conditions: ConditionTraitement[];
  matrices: LigneMatrice[];
  /** Fenetre de validite des lignes de bareme, par identifiant (pour afficher la validite du cout). */
  validitesBaremes?: Record<string, ValiditeBareme>;
}

// ---------------------------------------------------------------------------------------------
// Sorties
// ---------------------------------------------------------------------------------------------

export type CodeExclusionPriorite = "ETAT_NON_EVALUE" | "COUVERTURE_INSUFFISANTE" | "AUCUN_CRITERE_PONDERE";
export const ORDRE_EXCLUSIONS: readonly CodeExclusionPriorite[] = ["ETAT_NON_EVALUE", "COUVERTURE_INSUFFISANTE", "AUCUN_CRITERE_PONDERE"];

export interface Contribution {
  critere: CritereTechnique;
  libelle: string;
  poids: number;
  /** Part du poids total, en pourcentage (4 decimales). */
  poidsPct: number;
  /** Valeur normalisee 0 a 100, `null` si le critere manque. */
  valeurNormalisee: number | null;
  /** Points apportes au score (poids x valeur / somme des poids disponibles), `null` si le critere manque. */
  points: number | null;
  brut: number | string | null;
  provenance: string | null;
  note: string;
}

export interface CritereManquant { critere: CritereTechnique; libelle: string; poids: number; raison: string }

export interface PrioriteTechnique {
  statut: "CALCULE" | "INCOMPLET" | "EXCLU";
  /** Rang 1..n parmi les lignes classees ; `null` pour une ligne exclue (elle n'est pas classee). */
  rang: number | null;
  /** Score 0 a 100 (4 decimales) ; `null` pour une ligne exclue. JAMAIS 0 par defaut. */
  score: number | null;
  scoreIncomplet: boolean;
  /** Part du poids total couverte par des criteres disponibles, 0 a 1 (4 decimales). */
  couverture: number;
  contributions: Contribution[];
  criteresManquants: CritereManquant[];
  exclusion: { code: CodeExclusionPriorite; motif: string } | null;
}

export interface OrdreArbitrage {
  /** Rang du simulateur parmi les interventions chiffrables ; `null` si le simulateur ne peut pas classer cette ligne. */
  rang: number | null;
  ratioPointsParMilliardGnf: string | null;
  risqueCourant: number | null;
  risqueAttendu: number | null;
  /** Pourquoi le simulateur ne classe pas cette ligne (code et detail du simulateur). */
  motifAbsence: { code: string; detail: string } | null;
}

export interface CoutEstime {
  montantGnf: string;
  devise: string;
  unite: string;
  classePrecision: string;
  margePct: number | null;
  provisoire: boolean;
  hypothesesManquantes: string[];
  traitement: { code: string; libelle: string };
  bareme: {
    id: number | string; code: string | null; typeIntervention: string; coutKmGnf: string; anneeReference: number | null;
    largeurChausseeM: number | null; approuve: boolean; version: number | null; source: string | null; validDe: string | null; validA: string | null;
  };
  longueurM: number;
  calcul: string;
}

export interface Longueur {
  metierKm: number | null;
  metierDerivee: boolean | null;
  geometriqueM: number | null;
  utiliseeM: number | null;
  /** D'ou vient la longueur du cout : la colonne metier, ou la geometrie quand la colonne est vide. */
  longueurOrigine: "LONGUEUR_KM" | "GEOMETRIE" | null;
  divergence: { signalee: boolean; ecartRelatif: number | null; seuilRelatif: number; seuilAbsoluMinKm: number; statutSeuil: "PROVISOIRE" };
}

export interface LigneClassee {
  id: string;
  objet: { type: "TRONCON"; id: string; code: string; nom: string | null };
  regionId: number | null;
  regionNom: string | null;
  classe: string | null;
  prefecture: string | null;
  etatPhysique: string | null;
  dernierConstat: { date: string | null; source: "inspections.dateInspection" | "troncons.dateDerniereEvaluation" | null; ageJours: number | null };
  prioriteTechnique: PrioriteTechnique;
  ordreArbitrage: OrdreArbitrage;
  /** Confiance de la donnee d'etat (valeurs_qualite), distincte de la completude du score. */
  confiance: { niveau: string | null; statutEtat: string | null; source: string | null; observeLe: string | null };
  /** Part du poids couverte (meme valeur que `prioriteTechnique.couverture`, exposee sous le nom du cahier). */
  completude: number;
  sources: { troncon: { type: string | null; confiance: string | null }; etat: string | null };
  coutEstime: CoutEstime | null;
  coutNonEstimable: { code: string; motif: string } | null;
  longueur: Longueur;
  localisation: "valide" | "invalide";
  localisationMotif: string | null;
  /** Vrai tant que les parametres (poids et regles) ne sont pas approuves, ou hors de leur validite. */
  provisoire: boolean;
  modeleVersion: string;
  parametresVersion: string;
}

export interface ResumeClassement {
  candidats: number;
  classes: number;
  complets: number;
  incomplets: number;
  exclus: number;
  parMotifExclusion: Record<string, number>;
}

export interface ResultatPriorite {
  modele: { id: string; version: string };
  dateReference: string;
  parametres: {
    version: string; source: string; approuveeLe: string | null; approuveeParId: string | null; etiquette: string;
    bloc: BlocPriorite; blocOrigine: "VERSION" | "AMORCAGE_CODE";
    validite: { de: string | null; a: string | null; horsValidite: boolean };
  };
  provisoire: boolean;
  motifsProvisoire: string[];
  avertissement: string;
  resume: ResumeClassement;
  /** Les lignes, dans l'ordre total : classees (rang croissant), puis exclues. */
  lignes: LigneClassee[];
  /** Empreinte SHA-256 de la projection canonique de decision (voir projectionEmpreinte) : modele, parametres, date de reference, lignes. */
  empreinte: string;
}

export type ResultatClassement =
  | { ok: true; resultat: ResultatPriorite }
  | { ok: false; code: "ENTREES_INVALIDES" | "PERIMETRE_TROP_LARGE" | "PARAMETRES_INVALIDES"; erreurs: string[] };

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

const JOUR_MS = 86_400_000;
const msDe = (d: string): number => { const [a, m, j] = d.split("-").map(Number); return Date.UTC(a, m - 1, j); };
/** Jours entiers entre deux dates AAAA-MM-JJ (b - a). */
export const joursEntre = (a: string, b: string): number => Math.round((msDe(b) - msDe(a)) / JOUR_MS);

// ---------------------------------------------------------------------------------------------
// Regle des points noirs : « zero » ou « inconnu »
// ---------------------------------------------------------------------------------------------

export type CodeSecurite = "POINTS_NOIRS_CONFIRMES" | "ZERO_REGISTRE_EXPLOITE" | "REGISTRE_NON_EXPLOITE" | "SOURCE_ILLISIBLE";

export interface ResolutionSecurite {
  code: CodeSecurite;
  /** Nombre de points noirs confirmes a prendre en compte, `null` quand la donnee n'est pas fiable pour CE troncon. */
  nb: number | null;
  raison: string;
}

/**
 * REGLE DOCUMENTEE (audit AD-3 : l'ancienne lecture donnait 0 a tout troncon sans point noir des que le registre
 * national n'etait pas vide, de sorte qu'un troncon dont personne n'a jamais releve les points noirs descendait
 * silencieusement).
 *
 *   1. au moins un point noir confirme rattache au troncon  -> valeur = ce nombre (c'est une donnee) ;
 *   2. aucun, ET le registre de la region contient au moins `minimum` points noirs confirmes -> valeur ZERO : le registre
 *      est exploite dans la region, l'absence de point noir y est un constat (le registre n'est pas prouve exhaustif : le
 *      libelle le dit) ;
 *   3. aucun, et le registre de la region est plus petit -> critere ABSENT (REGISTRE_NON_EXPLOITE), pas zero ;
 *   4. source non lisible -> ABSENT (SOURCE_ILLISIBLE).
 *
 * La granularite est la region : c'est la plus fine que la base permette (un point noir porte une region, un troncon
 * seulement quand il a ete rattache). Le minimum est un parametre provisoire de la version.
 */
export function resoudreSecurite(p: PointsNoirsRegistre | null, minimum: number): ResolutionSecurite {
  const ok = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0;
  if (p === null || !ok(p.confirmes) || !ok(p.nonConfirmes) || !ok(p.registreRegion)) {
    return { code: "SOURCE_ILLISIBLE", nb: null, raison: "source des points noirs non exploitable : un zero ne serait pas une donnee" };
  }
  const nonConf = p.nonConfirmes > 0 ? ` ; ${p.nonConfirmes} alerte(s) non confirmee(s) ne comptent pas (distinctes d'un risque valide)` : "";
  if (p.confirmes > 0) {
    return { code: "POINTS_NOIRS_CONFIRMES", nb: p.confirmes, raison: `${p.confirmes} point(s) noir(s) confirme(s) rattache(s) au troncon${nonConf}` };
  }
  if (p.registreRegion >= minimum) {
    return {
      code: "ZERO_REGISTRE_EXPLOITE", nb: 0,
      raison: `aucun point noir confirme enregistre sur ce troncon, dans une region dont le registre en compte ${p.registreRegion} (minimum ${minimum}) : le registre n'est pas prouve exhaustif, zero signifie aucun point noir enregistre${nonConf}`,
    };
  }
  return {
    code: "REGISTRE_NON_EXPLOITE", nb: null,
    raison: `aucun point noir enregistre sur ce troncon et le registre de la region n'en compte que ${p.registreRegion} (minimum ${minimum} pour qu'un zero soit une donnee) : critere absent, pas zero${nonConf}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Urgence temporelle
// ---------------------------------------------------------------------------------------------

export type EvaluationUrgence =
  | { disponible: true; valeur: number; brut: number; note: string; debutDegradation: string | null; constatsIgnores: number }
  | { disponible: false; note: string; constatsIgnores: number };

/**
 * Anciennete de la degradation connue, depuis l'historique des inspections.
 *
 * On ne retient que les constats DATES au calendrier, ni futurs (apres la date de reference) ni sans etat (NON_EVALUE),
 * et on compte ceux qu'on ecarte. A date egale, le pire etat de la journee est le dernier (ordre total, independant de
 * l'ordre des entrees). La « serie courante » est la suite ininterrompue, jusqu'au dernier constat, d'inspections a l'etat
 * MAUVAIS ou CRITIQUE ; son debut est la date de la premiere. Si la derniere inspection n'est pas degradee, aucune
 * degradation n'est en cours : la valeur est 0, et c'est un constat (derniere inspection citee), pas une absence.
 */
export function evaluerUrgence(constats: readonly ConstatDate[], dateReference: string, plafondJours: number): EvaluationUrgence {
  let ignores = 0;
  const utiles: ConstatDate[] = [];
  for (const c of constats) {
    if (!c || !dateCalendaireValide(c.date) || c.date > dateReference || !(c.etat in ORDRE_ETAT)) { ignores += 1; continue; }
    utiles.push(c);
  }
  if (utiles.length === 0) {
    return { disponible: false, constatsIgnores: ignores, note: `aucune inspection datee et exploitable${ignores > 0 ? ` (${ignores} constat(s) ecarte(s) : date invalide, posterieure a la reference ou sans etat)` : ""}` };
  }
  utiles.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : ORDRE_ETAT[a.etat] - ORDRE_ETAT[b.etat]));
  const dernier = utiles[utiles.length - 1];
  const reste = ignores > 0 ? ` (${ignores} constat(s) ecarte(s))` : "";
  if (!ETATS_DEGRADES.includes(dernier.etat)) {
    return { disponible: true, valeur: 0, brut: 0, debutDegradation: null, constatsIgnores: ignores, note: `derniere inspection le ${dernier.date} : etat ${dernier.etat}, aucune degradation en cours constatee${reste}` };
  }
  let debut = utiles.length - 1;
  while (debut > 0 && ETATS_DEGRADES.includes(utiles[debut - 1].etat)) debut -= 1;
  const depuis = utiles[debut].date;
  const jours = Math.max(0, joursEntre(depuis, dateReference));
  const valeur = arrondi4(Math.min(jours / plafondJours, 1) * 100);
  return {
    disponible: true, valeur, brut: jours, debutDegradation: depuis, constatsIgnores: ignores,
    note: `degradation constatee depuis le ${depuis} (${jours} jours au ${dateReference}), plafond ${plafondJours} jours${reste}`,
  };
}

/** Date du dernier constat : la plus recente entre les inspections datees et `dateDerniereEvaluation`. */
export function dernierConstatDe(f: Pick<FaitsIntervention, "constats" | "dateDerniereEvaluation">, dateReference: string): LigneClassee["dernierConstat"] {
  let date: string | null = null;
  let source: LigneClassee["dernierConstat"]["source"] = null;
  for (const c of f.constats) {
    if (dateCalendaireValide(c.date) && c.date <= dateReference && (date === null || c.date > date)) { date = c.date; source = "inspections.dateInspection"; }
  }
  if (f.dateDerniereEvaluation && dateCalendaireValide(f.dateDerniereEvaluation) && f.dateDerniereEvaluation <= dateReference && (date === null || f.dateDerniereEvaluation > date)) {
    date = f.dateDerniereEvaluation; source = "troncons.dateDerniereEvaluation";
  }
  return { date, source, ageJours: date === null ? null : joursEntre(date, dateReference) };
}

// ---------------------------------------------------------------------------------------------
// Evaluation d'un troncon
// ---------------------------------------------------------------------------------------------

interface CritereEvalue {
  critere: CritereTechnique;
  poids: number;
  disponible: boolean;
  valeur: number | null;
  brut: number | string | null;
  provenance: string | null;
  note: string;
}

/** Ce qu'il faut mesurer sur un troncon pour en faire un candidat du moteur (risque, cout) : sous-ensemble de `FaitsIntervention`. */
export interface MesuresTroncon {
  id: string; code: string; nom: string | null; regionId: number | null; classe: string | null; revetement: string | null; etat: string | null;
  longueurKm: number | null; longueurGeometriqueM: number | null; traficMoyenJma: number | null; criticiteStrategique: number | null;
}

/**
 * LA regle qui fait d'un troncon un candidat du moteur, UNE SEULE FOIS : la liste priorisee (lot 3) ET le simulateur / le moteur v2
 * (`moteur.depot.chargerCandidats`) l'appellent, avec `resoudreSecurite` pour les points noirs. Longueur : la colonne metier
 * `longueurKm` si elle est positive, sinon la longueur de la geometrie, AVEC SON ORIGINE ; le nombre de points noirs vient de
 * `resoudreSecurite` (zero seulement si le registre de la region est exploite, sinon absent).
 */
export function candidatDepuisMesures(f: MesuresTroncon, nbPointsNoirs: number | null): CandidatTroncon {
  const saisie = f.longueurKm !== null && f.longueurKm > 0;
  const geo = f.longueurGeometriqueM !== null && f.longueurGeometriqueM > 0;
  return {
    id: f.id, code: f.code, nom: f.nom, regionId: f.regionId, classe: f.classe, revetement: f.revetement, etat: f.etat,
    longueurM: saisie ? Math.round((f.longueurKm as number) * 1000) : geo ? Math.round(f.longueurGeometriqueM as number) : null,
    longueurOrigine: saisie ? "LONGUEUR_KM" : geo ? "GEOMETRIE" : null,
    traficMoyenJma: f.traficMoyenJma, criticiteStrategique: f.criticiteStrategique, nbPointsNoirs,
    vulnerabiliteClimatique: null, populationDesservie: null,
  };
}

function candidatMoteur(f: FaitsIntervention, nbPointsNoirs: number | null): CandidatTroncon {
  return candidatDepuisMesures(f, nbPointsNoirs);
}

const facteur = (fs: FacteurEvalue[], nom: string): FacteurEvalue => fs.find((x) => x.facteur === nom) as FacteurEvalue;

function evaluerCriteres(f: FaitsIntervention, p: ParametresProgrammation, bloc: BlocPriorite, dateReference: string, nbPointsNoirs: ResolutionSecurite): CritereEvalue[] {
  // Les trois criteres communs au moteur de risque : on lit les facteurs qu'il evalue (une seule normalisation dans le depot).
  const risque = calculerRisque(candidatMoteur(f, nbPointsNoirs.nb), p);
  const fs = risque.facteurs;
  const sortie: CritereEvalue[] = [];
  for (const c of CRITERES_TECHNIQUES) {
    const poids = bloc.poids[c];
    const absent = (note: string): CritereEvalue => ({ critere: c, poids, disponible: false, valeur: null, brut: null, provenance: null, note });
    switch (c) {
      case "ETAT_GRAVITE": {
        const x = facteur(fs, "ETAT");
        const q = f.qualiteEtat;
        const prov = `troncons.etat${q ? ` ; statut de la valeur ${q.statut}${q.observeLe ? `, constate le ${q.observeLe}` : ""}` : ""}`;
        sortie.push(x.disponible ? { critere: c, poids, disponible: true, valeur: x.valeur, brut: x.brut, provenance: prov, note: x.note } : absent(x.note));
        break;
      }
      case "IMPORTANCE_AXE": {
        const x = facteur(fs, "TRAFIC_IMPORTANCE");
        if (!x.disponible) { sortie.push(absent(x.note)); break; }
        const parTrafic = x.origine === "troncons.traficMoyenJma";
        const prov = parTrafic
          ? `troncons.traficMoyenJma (comptage du ${f.traficDateComptage ?? "date inconnue : a documenter"})`
          : "troncons.criticiteStrategique (provenance non documentee)";
        sortie.push({ critere: c, poids, disponible: true, valeur: x.valeur, brut: x.brut, provenance: prov, note: x.note });
        break;
      }
      case "SECURITE_CRITICITE": {
        const x = facteur(fs, "SECURITE");
        if (nbPointsNoirs.nb === null || !x.disponible) { sortie.push(absent(nbPointsNoirs.raison)); break; }
        sortie.push({
          critere: c, poids, disponible: true, valeur: x.valeur, brut: x.brut,
          provenance: "points_noirs confirmes rattaches au troncon", note: `${nbPointsNoirs.raison} ; normalise sur un plafond de ${p.valeurs.pointsNoirsPlafond}, borne a 100`,
        });
        break;
      }
      case "ACCESSIBILITE_SERVICE":
        sortie.push(absent("critere non disponible : aucune donnee structuree de rupture d'acces, de saisonnalite ou de desserte"));
        break;
      case "URGENCE_TEMPORELLE": {
        const u = evaluerUrgence(f.constats, dateReference, bloc.urgenceAnciennetePlafondJours);
        sortie.push(u.disponible
          ? { critere: c, poids, disponible: true, valeur: u.valeur, brut: u.brut, provenance: "inspections (historique des constats)", note: u.note }
          : absent(u.note));
        break;
      }
      case "MATURITE_FAISABILITE":
        sortie.push(absent("critere non disponible : aucune donnee d'etudes, de disponibilite du marche ou d'acces chantier"));
        break;
    }
  }
  return sortie;
}

function sansEtat(c: CritereEvalue[]): string | null {
  const e = c.find((x) => x.critere === "ETAT_GRAVITE") as CritereEvalue;
  return e.disponible ? null : e.note;
}

function priorite(criteres: CritereEvalue[], bloc: BlocPriorite): PrioriteTechnique {
  const ponderes = criteres.filter((c) => c.poids > 0);
  const poidsTotal = ponderes.reduce((s, c) => s + c.poids, 0);
  const dispo = ponderes.filter((c) => c.disponible);
  const poidsDispo = dispo.reduce((s, c) => s + c.poids, 0);
  const couverture = poidsTotal > 0 ? arrondi4(poidsDispo / poidsTotal) : 0;

  const contributions: Contribution[] = ponderes.map((c) => ({
    critere: c.critere, libelle: LIBELLE[c.critere], poids: c.poids, poidsPct: poidsTotal > 0 ? arrondi4((c.poids / poidsTotal) * 100) : 0,
    valeurNormalisee: c.valeur, points: c.disponible && poidsDispo > 0 ? arrondi4((c.poids * (c.valeur as number)) / poidsDispo) : null,
    brut: c.brut, provenance: c.provenance, note: c.note,
  }));
  const criteresManquants: CritereManquant[] = ponderes.filter((c) => !c.disponible).map((c) => ({ critere: c.critere, libelle: LIBELLE[c.critere], poids: c.poids, raison: c.note }));

  const exclu = (code: CodeExclusionPriorite, motif: string): PrioriteTechnique => ({
    statut: "EXCLU", rang: null, score: null, scoreIncomplet: false, couverture, contributions, criteresManquants, exclusion: { code, motif },
  });
  const manqueEtat = sansEtat(criteres);
  if (manqueEtat !== null) return exclu("ETAT_NON_EVALUE", `l'etat est le critere essentiel : ${manqueEtat}. La ligne n'est ni classee bonne ni classee faible, elle n'est pas classee.`);
  if (ponderes.length === 0 || poidsTotal <= 0) return exclu("AUCUN_CRITERE_PONDERE", "tous les poids sont nuls : il n'y a rien a calculer");
  if (couverture < bloc.couvertureMinimale) {
    return exclu("COUVERTURE_INSUFFISANTE", `les criteres disponibles couvrent ${couverture} du poids total, minimum ${bloc.couvertureMinimale} : ${criteresManquants.map((m) => m.critere).join(", ")} manquent`);
  }
  let somme = 0;
  for (const c of dispo) somme += c.poids * (c.valeur as number);
  const score = arrondi4(somme / poidsDispo);
  const incomplet = couverture < 1;
  return { statut: incomplet ? "INCOMPLET" : "CALCULE", rang: null, score, scoreIncomplet: incomplet, couverture, contributions, criteresManquants, exclusion: null };
}

// ---------------------------------------------------------------------------------------------
// Cout
// ---------------------------------------------------------------------------------------------

function coutDe(f: FaitsIntervention, c: CandidatTroncon, p: ParametresProgrammation, e: EntreesPriorite): { cout: CoutEstime | null; non: { code: string; motif: string } | null } {
  if (f.etat === null || !(f.etat in ORDRE_ETAT)) return { cout: null, non: { code: "ETAT_NON_EVALUE", motif: "etat non evalue : aucun traitement ni cout ne se deduit d'une absence d'information" } };
  const famille = familleCoutDeTroncon(c.revetement);
  const classe = classeTraficDe(c.traficMoyenJma, p.valeurs.seuilsClasseTrafic);
  const ch = choisirTraitement({ familleRevetement: famille, etat: f.etat, classeTrafic: classe }, e.catalogue, e.conditions);
  if (!ch.ok) return { cout: null, non: { code: ch.code, motif: ch.motif } };
  const est = estimer({ familleRevetement: famille as string, etatDepart: f.etat, longueurM: c.longueurM ?? Number.NaN, niveauMesure: "REFERENTIEL", typeIntervention: ch.traitement.code }, e.baremes);
  if (!est.ok) return { cout: null, non: { code: est.code, motif: est.motif } };
  if (est.montant <= 0n) return { cout: null, non: { code: "MONTANT_NUL", motif: "le montant estime est nul : la longueur est inferieure a un demi-metre" } };
  const unite = e.baremes.find((b) => String(b.id) === String(est.bareme.id))?.uniteCout ?? "KM";
  const v = e.validitesBaremes?.[String(est.bareme.id)];
  return {
    non: null,
    cout: {
      montantGnf: est.montant.toString(), devise: est.devise, unite, classePrecision: est.classePrecision, margePct: est.margePct,
      provisoire: est.provisoire, hypothesesManquantes: est.hypothesesManquantes,
      traitement: { code: ch.traitement.code, libelle: ch.traitement.libelle },
      bareme: {
        id: est.bareme.id, code: est.bareme.code, typeIntervention: est.bareme.typeIntervention, coutKmGnf: est.bareme.coutKm.toString(),
        anneeReference: est.bareme.anneeReference, largeurChausseeM: est.bareme.largeurChausseeM, approuve: est.bareme.approuve,
        version: v?.version ?? null, source: v?.source ?? null, validDe: v?.validDe ?? null, validA: v?.validA ?? null,
      },
      longueurM: est.longueurM, calcul: est.calcul,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Longueur
// ---------------------------------------------------------------------------------------------

function longueurDe(f: FaitsIntervention, c: CandidatTroncon): Longueur {
  const km = f.longueurKm !== null && f.longueurKm > 0 ? f.longueurKm : null;
  const geo = f.longueurGeometriqueM !== null && f.longueurGeometriqueM > 0 ? f.longueurGeometriqueM : null;
  // Le MEME detecteur que le module de qualite (LONGUEUR_ECART_GEOMETRIE), avec ses seuils provisoires : on signale, on ne corrige pas.
  const anomalies = classerLongueur({
    id: f.id, code: f.code, regionId: f.regionId, regionNom: null, longueurKm: f.longueurKm, pkDebut: null, pkFin: null, etat: null,
    dateDerniereEvaluation: null, geomPresente: true, geomVide: false, geomValide: true, raisonInvalide: null, geomType: "ST_LineString", geomSrid: 4326,
    longueurGeomM: f.longueurGeometriqueM,
  }, SEUILS_PROVISOIRES);
  const signalee = anomalies.some((a) => a.code === "LONGUEUR_ECART_GEOMETRIE");
  const ecart = km !== null && geo !== null ? arrondi4(Math.abs(km - geo / 1000) / (geo / 1000)) : null;
  return {
    metierKm: km, metierDerivee: f.longueurMetierDerivee, geometriqueM: geo === null ? null : Math.round(geo * 10) / 10,
    utiliseeM: c.longueurM, longueurOrigine: c.longueurOrigine ?? null,
    divergence: { signalee, ecartRelatif: ecart, seuilRelatif: SEUILS_PROVISOIRES.LONGUEUR_ECART_RELATIF, seuilAbsoluMinKm: SEUILS_PROVISOIRES.LONGUEUR_ECART_ABSOLU_MIN_KM, statutSeuil: "PROVISOIRE" },
  };
}

// ---------------------------------------------------------------------------------------------
// Parametres effectifs
// ---------------------------------------------------------------------------------------------

export function blocEffectif(p: ParametresProgrammation): { bloc: BlocPriorite; origine: "VERSION" | "AMORCAGE_CODE" } {
  return p.valeurs.priorite ? { bloc: p.valeurs.priorite, origine: "VERSION" } : { bloc: structuredClone(BLOC_PRIORITE_AMORCAGE), origine: "AMORCAGE_CODE" };
}

// ---------------------------------------------------------------------------------------------
// Ordre total et classement
// ---------------------------------------------------------------------------------------------

/** Cle de tri d'une ligne : `g` 0 = classee (s = -scoreMicro), 1 = exclue (s = rang du motif), puis code, puis identifiant. */
export interface CleTri { g: 0 | 1; s: number; c: string; i: string }

export function cleTri(l: Pick<LigneClassee, "id" | "objet" | "prioriteTechnique">): CleTri {
  const p = l.prioriteTechnique;
  if (p.score !== null) return { g: 0, s: -Math.round(p.score * 10000), c: l.objet.code, i: l.id };
  return { g: 1, s: ORDRE_EXCLUSIONS.indexOf((p.exclusion as { code: CodeExclusionPriorite }).code), c: l.objet.code, i: l.id };
}

export function comparerCles(a: CleTri, b: CleTri): number {
  if (a.g !== b.g) return a.g < b.g ? -1 : 1;
  if (a.s !== b.s) return a.s < b.s ? -1 : 1;
  if (a.c !== b.c) return a.c < b.c ? -1 : 1;
  return a.i < b.i ? -1 : a.i > b.i ? 1 : 0;
}

function validerFaits(e: EntreesPriorite): string[] {
  const err: string[] = [];
  if (!dateCalendaireValide(e.dateReference)) err.push("dateReference : date AAAA-MM-JJ existante attendue");
  if (!Array.isArray(e.candidats)) { err.push("candidats : tableau attendu"); return err; }
  const vus = new Set<string>();
  for (const c of e.candidats) {
    if (typeof c.id !== "string" || c.id.length === 0) { err.push("candidat sans identifiant"); continue; }
    if (vus.has(c.id)) err.push(`candidat en double : ${c.id}`);
    vus.add(c.id);
    if (typeof c.code !== "string" || c.code.length === 0) err.push(`candidat ${c.id} : code manquant`);
  }
  return err;
}

/**
 * PROJECTION CANONIQUE QUE L'EMPREINTE HACHE. Toutes les VALEURS de decision d'une ligne (identifiant, rang, score, couverture,
 * contributions, criteres manquants, motif d'exclusion, ordre d'arbitrage, cout et son bareme, longueurs, localisation, version
 * du modele et des parametres), en tableaux positionnels ; les PHRASES explicatives (notes, motifs, justifications) n'y entrent
 * pas : elles sont des fonctions de ces valeurs. Hacher les 8 Mo de texte d'un classement de 3 000 lignes coutait plus que le
 * classement lui-meme ; la projection garde la garantie utile (un seul fait, un seul poids, une seule date qui change et
 * l'empreinte change, testes) pour une fraction du cout. Un test compare en plus la sortie ENTIERE (texte canonique complet) de
 * deux calculs sur des entrees melangees.
 */
export function projectionEmpreinte(s: {
  modele: { id: string; version: string }; dateReference: string;
  parametres: { version: string; source: string; approuveeLe: string | null; approuveeParId: string | null; bloc: BlocPriorite; blocOrigine: string };
  lignes: readonly LigneClassee[];
}) {
  return {
    modele: s.modele, dateReference: s.dateReference, parametres: s.parametres,
    lignes: s.lignes.map((l) => {
      const p = l.prioriteTechnique, a = l.ordreArbitrage, c = l.coutEstime, g = l.longueur;
      return [
        l.id, l.objet.code, l.regionId, l.classe, l.prefecture, l.etatPhysique, l.dernierConstat.date, l.dernierConstat.source,
        p.statut, p.rang, p.score, p.couverture,
        p.contributions.map((x) => [x.critere, x.poids, x.valeurNormalisee, x.points, x.brut, x.provenance]),
        p.criteresManquants.map((m) => m.critere),
        p.exclusion ? p.exclusion.code : null,
        a.rang, a.ratioPointsParMilliardGnf, a.risqueCourant, a.risqueAttendu, a.motifAbsence ? a.motifAbsence.code : null,
        c ? [c.montantGnf, c.devise, c.unite, c.classePrecision, c.provisoire, c.traitement.code, c.bareme.id, c.bareme.version, c.bareme.validDe, c.bareme.validA, c.longueurM] : null,
        l.coutNonEstimable ? l.coutNonEstimable.code : null,
        [g.metierKm, g.metierDerivee, g.geometriqueM, g.utiliseeM, g.longueurOrigine, g.divergence.signalee, g.divergence.ecartRelatif],
        l.localisation, l.localisationMotif, l.confiance.niveau, l.confiance.statutEtat, l.confiance.observeLe,
        l.provisoire, l.modeleVersion, l.parametresVersion,
      ];
    }),
  };
}

/**
 * Classe les interventions candidates. Fonction pure : appelee deux fois avec les memes entrees (dans n'importe quel
 * ordre), elle rend deux resultats dont l'empreinte est identique.
 */
export function classerInterventions(e: EntreesPriorite): ResultatClassement {
  const erreurs = validerFaits(e);
  if (erreurs.length > 0) return { ok: false, code: "ENTREES_INVALIDES", erreurs };
  if (e.candidats.length > MAX_CANDIDATS) {
    return { ok: false, code: "PERIMETRE_TROP_LARGE", erreurs: [`${e.candidats.length} troncons candidats depassent le plafond de ${MAX_CANDIDATS} : restreignez le perimetre (region ou classe de route)`] };
  }
  const valides = validerParametres(e.parametres);
  if (!valides.ok) return { ok: false, code: "PARAMETRES_INVALIDES", erreurs: valides.erreurs };

  const p = e.parametres;
  const { bloc, origine } = blocEffectif(p);
  const modeleVersion = `${MODELE.id}.${MODELE.version}`;

  // Motifs de provisoire : chaque cause est nommee, rien n'est suppose approuve.
  const motifsProvisoire: string[] = [];
  if (sontProvisoires(p)) motifsProvisoire.push(`parametres non approuves (version ${p.version}) : poids et regles sans source (D-01)`);
  if (origine === "AMORCAGE_CODE") motifsProvisoire.push(`la version ${p.version} ne porte pas de bloc de priorite : valeurs d'amorcage du code utilisees`);
  const horsValidite = (bloc.validiteDe !== null && e.dateReference < bloc.validiteDe) || (bloc.validiteA !== null && e.dateReference > bloc.validiteA);
  if (horsValidite) motifsProvisoire.push(`date de reference ${e.dateReference} hors de la periode de validite des parametres (${bloc.validiteDe ?? "..."} a ${bloc.validiteA ?? "..."})`);
  const provisoire = motifsProvisoire.length > 0;

  // 1. Priorite technique et cout, troncon par troncon.
  const candidatsMoteur: CandidatTroncon[] = [];
  const intermediaires = e.candidats.map((f) => {
    const secu = resoudreSecurite(f.pointsNoirs, bloc.registrePointsNoirsMinimum);
    const cm = candidatMoteur(f, secu.nb);
    candidatsMoteur.push(cm);
    const criteres = evaluerCriteres(f, p, bloc, e.dateReference, secu);
    const prio = priorite(criteres, bloc);
    const { cout, non } = coutDe(f, cm, p, e);
    return { f, cm, prio, cout, non };
  });

  // 2. Ordre d'arbitrage : celui du simulateur, sur les memes candidats et les memes parametres.
  const sc = construireScenario({
    annee: Number(e.dateReference.slice(0, 4)), budgetGnf: ENVELOPPE_ILLIMITEE, plafondsRegionauxGnf: {}, parametres: p,
    candidats: candidatsMoteur, baremes: e.baremes, catalogue: e.catalogue, conditions: e.conditions, matrices: e.matrices,
  });
  if (!sc.ok) return { ok: false, code: "ENTREES_INVALIDES", erreurs: sc.erreurs };
  const parId = new Map(sc.scenario.lignes.map((l) => [l.troncon.id, l]));

  const lignes: LigneClassee[] = intermediaires.map(({ f, cm, prio, cout, non }) => {
    const ls = parId.get(f.id);
    const arbitrage: OrdreArbitrage = ls && ls.rangPriorite !== null && ls.priorite
      ? { rang: ls.rangPriorite, ratioPointsParMilliardGnf: ls.priorite.ratioPointsParMilliardGnf, risqueCourant: ls.risque.ok ? ls.risque.score : null, risqueAttendu: ls.risqueAttendu ? ls.risqueAttendu.score : null, motifAbsence: null }
      : { rang: null, ratioPointsParMilliardGnf: null, risqueCourant: ls && ls.risque.ok ? ls.risque.score : null, risqueAttendu: null, motifAbsence: ls && ls.motifExclusion ? { code: ls.motifExclusion.code, detail: ls.motifExclusion.detail } : { code: "NON_EVALUE_PAR_LE_SIMULATEUR", detail: "le simulateur n'a pas rendu de ligne pour ce troncon" } };
    const q = f.qualiteEtat;
    return {
      id: f.id,
      objet: { type: "TRONCON" as const, id: f.id, code: f.code, nom: f.nom },
      regionId: f.regionId, regionNom: f.regionNom, classe: f.classe, prefecture: f.prefecture,
      etatPhysique: f.etat,
      dernierConstat: dernierConstatDe(f, e.dateReference),
      prioriteTechnique: prio,
      ordreArbitrage: arbitrage,
      confiance: { niveau: q?.confiance ?? null, statutEtat: q?.statut ?? null, source: q?.source ?? null, observeLe: q?.observeLe ?? null },
      completude: prio.couverture,
      sources: { troncon: { type: f.sourceTroncon.type, confiance: f.sourceTroncon.confiance }, etat: q ? q.statut : null },
      coutEstime: cout, coutNonEstimable: non,
      longueur: longueurDe(f, cm),
      localisation: f.localisation.valide ? "valide" as const : "invalide" as const,
      localisationMotif: f.localisation.valide ? null : f.localisation.motif ?? "geometrie inexploitable",
      provisoire,
      modeleVersion, parametresVersion: p.version,
    };
  });

  lignes.sort((a, b) => comparerCles(cleTri(a), cleTri(b)));
  let rang = 0;
  for (const l of lignes) {
    if (l.prioriteTechnique.score !== null) { rang += 1; l.prioriteTechnique.rang = rang; }
  }

  const parMotifExclusion: Record<string, number> = {};
  let complets = 0, incomplets = 0;
  for (const l of lignes) {
    const pt = l.prioriteTechnique;
    if (pt.exclusion) parMotifExclusion[pt.exclusion.code] = (parMotifExclusion[pt.exclusion.code] ?? 0) + 1;
    else if (pt.scoreIncomplet) incomplets += 1;
    else complets += 1;
  }
  const resume: ResumeClassement = { candidats: lignes.length, classes: complets + incomplets, complets, incomplets, exclus: lignes.length - complets - incomplets, parMotifExclusion };

  const empreinte = sha256Hex(canonique(projectionEmpreinte({
    modele: { ...MODELE },
    dateReference: e.dateReference,
    parametres: { version: p.version, source: p.source, approuveeLe: p.approuveeLe, approuveeParId: p.approuveeParId, bloc, blocOrigine: origine },
    lignes,
  })));

  return {
    ok: true,
    resultat: {
      modele: { ...MODELE }, dateReference: e.dateReference,
      parametres: {
        version: p.version, source: p.source, approuveeLe: p.approuveeLe, approuveeParId: p.approuveeParId, etiquette: etiquetteParametres(p),
        bloc, blocOrigine: origine, validite: { de: bloc.validiteDe, a: bloc.validiteA, horsValidite },
      },
      provisoire, motifsProvisoire, avertissement: AVERTISSEMENT_CONSULTATIF, resume, lignes, empreinte,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Texte du motif (fiche, paragraphe 6.4)
// ---------------------------------------------------------------------------------------------

/** Phrase de motif : rang, score, contributions principales et criteres manquants. Reconstruite depuis la ligne, sans rien ajouter. */
export function motifDeLaLigne(l: LigneClassee, total: number): string {
  const p = l.prioriteTechnique;
  if (p.exclusion) return `Non classee (${p.exclusion.code}) : ${p.exclusion.motif}`;
  const principales = [...p.contributions].filter((c) => c.points !== null).sort((a, b) => (b.points as number) - (a.points as number) || (a.critere < b.critere ? -1 : 1)).slice(0, 3)
    .map((c) => `${c.libelle} ${c.points} pt (valeur ${c.valeurNormalisee}, poids ${c.poidsPct} %)`).join(" ; ");
  const manquants = p.criteresManquants.length > 0 ? ` Criteres manquants : ${p.criteresManquants.map((m) => m.libelle).join(", ")}.` : "";
  const incomplet = p.scoreIncomplet ? ` Score incomplet (couverture ${p.couverture}) : il classe sur ce qui est connu.` : "";
  return `Priorite technique ${p.rang}/${total}, score ${p.score} sur 100. Contributions principales : ${principales}.${incomplet}${manquants}`;
}
