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
 */

import { estimer, formaterMontant, type LigneBareme } from "../engines/cout.noyau";
import { familleCoutDeTroncon } from "../engines/famille-cout";
import { calculerRisque, arrondi4, type EntreesRisque, type FacteurEvalue, type ResultatRisque } from "../engines/risque.noyau";
import {
  choisirTraitement, classeTraficDe, projeterDegradation,
  type ChoixTraitement, type ClasseTrafic, type ConditionTraitement, type LigneMatrice, type ProjectionDegradation, type Traitement,
} from "../engines/traitement.noyau";
import { etiquetteParametres, sontProvisoires, validerParametres, type ParametresProgrammation } from "./parametres.noyau";

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
}

export type CodeExclusion =
  | "RISQUE_NON_CALCULABLE"
  | "SOUS_SEUIL_RISQUE"
  | "AUCUN_TRAITEMENT"
  | "COUT_NON_ESTIMABLE"
  | "BUDGET_INSUFFISANT"
  | "PLAFOND_REGIONAL";

/** Ordre dans lequel les lignes ecartees avant classement sont listees. */
const ORDRE_EXCLUSION: readonly CodeExclusion[] = ["RISQUE_NON_CALCULABLE", "SOUS_SEUIL_RISQUE", "AUCUN_TRAITEMENT", "COUT_NON_ESTIMABLE", "BUDGET_INSUFFISANT", "PLAFOND_REGIONAL"];

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
 * Construit le scenario. Fonction pure : appelee deux fois avec les memes entrees, elle rend deux
 * objets dont `canonique()` est identique octet pour octet.
 */
export function construireScenario(entrees: EntreesScenario): ResultatConstruction {
  const erreurs = validerEntrees(entrees);
  if (erreurs.length > 0) return { ok: false, code: "ENTREES_INVALIDES", erreurs };

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

  // Ce qui rend le scenario provisoire : chaque cause est nommee, rien n'est suppose approuve.
  const motifsProvisoire: string[] = [];
  if (sontProvisoires(p)) motifsProvisoire.push(`paramètres de programmation non approuvés (version ${p.version}, source ${p.source})`);
  const coutsProv = lignesClassees.filter((l) => l.decision === "RETENUE" && l.cout && l.cout.ok && l.cout.provisoire);
  if (coutsProv.length > 0) {
    const hyp = [...new Set(coutsProv.flatMap((l) => (l.cout as { hypothesesManquantes: string[] }).hypothesesManquantes))].sort();
    motifsProvisoire.push(`${coutsProv.length} ligne(s) retenue(s) chiffrée(s) sur un barème provisoire : ${hyp.join(", ")}`);
  }
  const traitNonAppr = [...new Set(retenues.filter((l) => l.traitement && l.traitement.ok && !l.traitement.traitement.approuve).map((l) => (l.traitement as { ok: true; traitement: { code: string } }).traitement.code))].sort();
  if (traitNonAppr.length > 0) motifsProvisoire.push(`traitement(s) du catalogue non approuvé(s) : ${traitNonAppr.join(", ")}`);
  const longueursCalculees = retenues.filter((l) => l.troncon.longueurOrigine === "GEOMETRIE").length;
  if (longueursCalculees > 0) motifsProvisoire.push(`${longueursCalculees} ligne(s) retenue(s) chiffrée(s) sur une longueur calculée sur la géométrie, non saisie`);
  const matNonAppr = retenues.filter((l) => l.projection && l.projection.ok && !l.projection.matrice.approuvee).length;
  if (matNonAppr > 0) motifsProvisoire.push(`${matNonAppr} ligne(s) retenue(s) projetée(s) par une matrice de dégradation non approuvée`);

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
  return {
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
  if (erreurs.length > 0) return { ok: false, erreurs };
  const invalides = validerEntrees(entrees);
  if (invalides.length > 0) return { ok: false, erreurs: invalides };
  return { ok: true, entrees };
}
