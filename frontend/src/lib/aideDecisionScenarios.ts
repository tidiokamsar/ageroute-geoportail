import { chiffresGnf, formaterGnf, type LigneScenario, type RapportRejeu, type Scenario } from "./moteurProgrammation";

/**
 * Simulateur budgetaire de l'aide a la decision : NOYAU PUR (sans reseau, sans DOM, sans horloge) de l'ecran
 * « Simulation » et « Scenarios » : types de l'API, validation de la saisie, libelles, calculs d'affichage.
 *
 * QUATRE REGLES DE PRESENTATION, ET CHACUNE EVITE UN MENSONGE
 *
 * **Un montant en GNF reste une chaine de chiffres** (il depasse 2^53) ; les proportions des barres se calculent en BigInt.
 * **Un deficit n'est jamais masque** : le solde est SIGNE (« -3 700 000 000 GNF »), le deficit est dit en toutes lettres, et
 * il est dit minorant quand des couts manquent. Un excedent s'affiche comme un excedent, jamais comme un « 0 deficit » seul.
 * **Un cout manquant ou perime n'est pas simule comme fiable** : il est compte a part, en evidence, jamais valorise.
 * **« Simulation non engageante »** est repete sur chaque resultat et dans chaque export ; l'export qui ne la porte pas est refuse.
 */

export const MENTION_SIMULATION = "SIMULATION NON ENGAGEANTE : ne constitue ni une autorisation de dépense ni un ordre de travaux.";

export const CODES_LOGIQUE = ["ratio_cout_impact", "urgence", "criticite", "equilibre_territorial", "personnalise"] as const;
export type CodeLogique = (typeof CODES_LOGIQUE)[number];

// ----------------------------------------------------------------------------- types de l'API

export interface DefinitionLogique {
  code: CodeLogique; libelle: string; explication: string; regle: string; provisoire: boolean; exige: ("ordrePersonnalise" | "equilibre")[];
}

export interface BaremeOption {
  id: number | string; code: string | null; version: number | null; familleRevetement: string; etatDepart: string; typeIntervention: string;
  coutKmGnf: string; uniteCout: string; devise: string; anneeReference: number | null; approuveLe: string | null;
  validDe: string | null; validA: string | null; statut: "PROVISOIRE" | "APPROUVE"; couvrePeriode: boolean; peremption: string | null;
}

export interface OptionsSimulateur {
  mention: string; devise: "GNF"; maxCandidats: number; logiques: DefinitionLogique[];
  parametres: { id: string; version: string; provisoire: boolean; etiquette: string; approuveeLe: string | null }[];
  baremes: BaremeOption[] | null;
  contraintes: { obligatoires: string; groupesNonDivisibles: string; plafondsRegionaux: string; reglesFinancement: string };
}

export interface CandidatApercu {
  id: string; code: string; nom: string | null; regionId: number | null; classe: string | null; revetement: string | null; etat: string | null;
  longueurMetierKm: string | null; longueurGeometriqueKm: string | null;
}
export interface ReponseCandidats { total: number; tronque: boolean; maxCandidats: number; data: CandidatApercu[] }

export interface DemandeSimulateur {
  annee: number; budgetGnf: string; periode: { debut: string; fin: string }; logique: CodeLogique;
  regionId?: number; classe?: string; parametresId?: string; selection?: string[];
  plafondsRegionauxGnf?: Record<string, string>; ordrePersonnalise?: string[]; equilibre?: { partMinimaleParRegionPct: number };
  obligatoires?: string[]; groupesNonDivisibles?: string[][]; baremeIds?: number[];
}

export interface BilanBudgetaire {
  enveloppeGnf: string; consommeGnf: string; resteGnf: string; besoinTotalGnf: string; deficitGnf: string; excedentGnf: string; soldeGnf: string;
  couvertureBesoinPct: string | null; nbCoutsFiables: number; nbCoutsNonFiables: number; deficitMinorant: boolean;
  besoinObligatoiresGnf: string; deficitObligatoiresGnf: string;
}

export interface AvertissementSimulation { code: string; niveau: "ALERTE" | "INFO"; nb: number | null; message: string }
export interface ContrainteInsatisfaite { code: string; portee: "TRONCON" | "GROUPE" | "REGION"; reference: string; detail: string }

export interface LigneSimulationInfo {
  ordreArbitrage: number | null; examen: number | null; phase: "OBLIGATOIRE" | "PLANCHER_REGIONAL" | "ORDRE" | null;
  prioriteTechnique: { rang: number | null; source: "lot3_priorite_technique" | "moteur_v2_risque_courant" };
  obligatoire: boolean; groupe: number | null; coutFiable: boolean;
  coutSource: { baremeId: number | string; baremeCode: string | null; version: number | null; uniteCout: string; devise: string; validDe: string | null; validA: string | null; approuve: boolean; anneeReference: number | null } | null;
}
export type LigneSim = LigneScenario & { simulation?: LigneSimulationInfo };

export interface ResultatSimulation {
  version: 1; mention: string; periode: { debut: string; fin: string }; devise: string;
  logique: { code: CodeLogique; libelle: string; explication: string; regle: string; provisoire: boolean; ordrePersonnalise: string[]; equilibre: { partMinimaleParRegionPct: number } | null };
  bilan: BilanBudgetaire;
  coutsNonFiables: { code: string; nb: number; troncons: string[] }[];
  contraintes: {
    obligatoires: { demandees: string[]; effectives: string[]; retenues: string[]; nonRetenues: string[] };
    groupesNonDivisibles: { numero: number; membres: string[]; retenu: boolean; coutGnf: string | null; motif: { code: string; detail: string } | null }[];
    plafondsRegionauxGnf: Record<string, string>;
    equilibre: { regionId: number; plancherGnf: string; depenseGnf: string; atteint: boolean }[] | null;
    insatisfaisables: ContrainteInsatisfaite[];
  };
  kilometres: { metierM: number | null; metierKm: string | null; lignesAvecLongueurMetier: number; lignesSansLongueurMetier: number; geometriqueM: number | null; geometriqueKm: string | null; note: string };
  risqueCouvert: { retenuMicro: number; totalChiffrableMicro: number; totalCalculableMicro: number; partChiffrablePct: string | null; partCalculablePct: string | null; nbSansRisqueCalculable: number };
  distributionRegionale: { regionId: number | null; nbRetenues: number; engageGnf: string; nbEcartees: number; besoinGnf: string }[];
  baremes: { empreinte: string; nbLignes: number; nbApprouvees: number; nbProvisoires: number; liste: { id: number | string; code: string | null; version: number | null; typeIntervention: string; approuveLe: string | null; validDe: string | null; validA: string | null }[] };
  parametresVersion: string; rangsTechniquesSource: string; avertissements: AvertissementSimulation[];
}

export type ScenarioSim = Omit<Scenario, "lignes"> & { lignes: LigneSim[]; simulation?: ResultatSimulation };

export interface ResultatCalcul { resultat: ScenarioSim; empreinteEntrees: string; empreinteResultat: string; enregistre: false }

export interface ResumeScenarioSim {
  id: string; annee: number; intitule: string; parametresVersion: string; parametresId: string; budgetGnf: string; perimetre: { regionId?: number | null; classe?: string | null } | null;
  nbRetenues: number; nbEcartees: number; montantEngageGnf: string; provisoire: boolean; etiquette: string; empreinteEntrees: string; empreinteResultat: string;
  creeParId: string; auteurNom: string | null; creeLe: string; simulateur: boolean; logique: CodeLogique | null;
  periode: { debut: string; fin: string } | null; deficitGnf: string | null; deficitMinorant: boolean | null;
}
export interface ListeScenarios { data: ResumeScenarioSim[]; total: number; page: number; pageSize: number }

export interface DetailScenario {
  scenario: Omit<ResumeScenarioSim, "simulateur" | "logique" | "periode" | "deficitGnf" | "deficitMinorant">;
  resultat: ScenarioSim;
  entrees: { simulation: null | { logique: CodeLogique; periode: { debut: string; fin: string }; obligatoires: string[]; groupesNonDivisibles: string[][]; equilibre: { partMinimaleParRegionPct: number } | null; ordrePersonnalise: string[]; baremes: { empreinte: string }; perimetre: { regionId: number | null; classe: string | null; selection: string[] | null } }; nbCandidats: number };
  simulateur: boolean;
}

export interface ColonneComparaison {
  id: string; intitule: string; creeParId: string; creeLe: string; annee: number; periode: { debut: string; fin: string }; devise: string;
  logique: { code: string; libelle: string }; etiquette: string; provisoire: boolean;
  enveloppeGnf: string; consommeGnf: string; resteGnf: string; besoinTotalGnf: string; deficitGnf: string; soldeGnf: string; deficitMinorant: boolean; nbCoutsNonFiables: number;
  nbCandidats: number; nbInterventions: number; nbEcartees: number; kilometres: ResultatSimulation["kilometres"]; risqueCouvert: ResultatSimulation["risqueCouvert"];
  distributionRegionale: ResultatSimulation["distributionRegionale"]; exclusionsParMotif: Record<string, number>; parametresVersion: string;
  baremes: { empreinte: string; nbLignes: number; nbApprouvees: number }; nbContraintesInsatisfaisables: number; avertissements: string[];
}
export interface Comparaison {
  mention: string; periode: { debut: string; fin: string }; devise: string; scenarios: ColonneComparaison[];
  hypotheses: { champ: string; libelle: string; valeurs: string[]; identiques: boolean }[];
  interventions: { communes: number; propres: { id: string; nb: number }[] };
}

// ----------------------------------------------------------------------------- libelles

export const LIBELLE_LOGIQUE: Record<CodeLogique, string> = {
  ratio_cout_impact: "Ratio coût / impact", urgence: "Urgence", criticite: "Criticité", equilibre_territorial: "Équilibre territorial", personnalise: "Ordre personnalisé",
};

export const LIBELLE_EXCLUSION_SIM: Record<string, string> = {
  RISQUE_NON_CALCULABLE: "Risque non calculable (facteurs manquants)",
  SOUS_SEUIL_RISQUE: "Sous le seuil de risque",
  AUCUN_TRAITEMENT: "Aucun traitement prévu",
  COUT_NON_ESTIMABLE: "Coût manquant ou non estimable",
  COUT_PERIME: "Coût périmé pour la période",
  BUDGET_INSUFFISANT: "Budget insuffisant",
  PLAFOND_REGIONAL: "Plafond régional atteint",
  EXCLUE_CONTRAINTE: "Écartée par une contrainte",
};

export const LIBELLE_CONTRAINTE: Record<string, string> = {
  OBLIGATOIRE_HORS_CANDIDATS: "Obligatoire absente des candidats",
  OBLIGATOIRE_NON_CHIFFRABLE: "Obligatoire sans coût fiable",
  OBLIGATOIRE_NON_FINANCEE: "Obligatoire non financée",
  GROUPE_OBLIGATOIRE_IMPOSSIBLE: "Groupe obligatoire impossible",
  EQUILIBRE_NON_ATTEINT: "Plancher régional non atteint",
  EQUILIBRE_REGION_SANS_CANDIDAT_CHIFFRABLE: "Région sans candidat chiffrable",
};

export const LIBELLE_PHASE: Record<string, string> = { OBLIGATOIRE: "obligatoire", PLANCHER_REGIONAL: "plancher régional", ORDRE: "ordre d'arbitrage" };

/** Motifs dont le cout n'est pas utilisable : mis en evidence, jamais valorises. */
export const CODES_COUT_NON_FIABLE = ["COUT_NON_ESTIMABLE", "COUT_PERIME", "AUCUN_TRAITEMENT", "RISQUE_NON_CALCULABLE"] as const;

// ----------------------------------------------------------------------------- saisie : enveloppe, periode

export type ResultatEnveloppe = { ok: true; chiffres: string } | { ok: false; erreur: string };

/**
 * Enveloppe saisie : numerique, NON NEGATIVE, en GNF entiers. Les espaces de groupement sont acceptes ; la virgule, le point,
 * le signe moins et toute lettre sont refuses avec la raison. 0 est valide (enveloppe nulle : tout est ecarte). Aucune
 * conversion en nombre flottant : le resultat est une chaine de chiffres.
 */
export function validerEnveloppe(saisie: string): ResultatEnveloppe {
  const brut = saisie.trim();
  if (brut === "") return { ok: false, erreur: "Saisissez l'enveloppe en GNF : aucune valeur n'est proposée." };
  if (/^[-−–]/.test(brut)) return { ok: false, erreur: "Une enveloppe ne peut pas être négative." };
  if (/[.,]/.test(brut)) return { ok: false, erreur: "Le GNF s'exprime en francs entiers : ni virgule ni point décimal." };
  const c = chiffresGnf(brut);
  if (c === null) {
    const sansEspaces = brut.replace(/[\s\u202f\u00a0]/g, "");
    if (/^\d+$/.test(sansEspaces)) return { ok: false, erreur: "Enveloppe trop grande : 18 chiffres au plus." };
    return { ok: false, erreur: "Saisie non numérique : des chiffres seulement, en GNF." };
  }
  return { ok: true, chiffres: c };
}

const JOUR = /^\d{4}-\d{2}-\d{2}$/;
export function jourValide(s: string): boolean {
  if (!JOUR.test(s)) return false;
  const [a, m, j] = s.split("-").map(Number);
  const d = new Date(Date.UTC(a, m - 1, j));
  return d.getUTCFullYear() === a && d.getUTCMonth() === m - 1 && d.getUTCDate() === j;
}

export type ResultatPeriode = { ok: true; annee: number } | { ok: false; erreur: string };

/** Periode du programme : deux dates reelles, la fin ne precede pas le debut, au plus 10 ans apres l'annee du debut. */
export function validerPeriode(debut: string, fin: string): ResultatPeriode {
  if (!jourValide(debut)) return { ok: false, erreur: "Date de début invalide (jour réel attendu)." };
  if (!jourValide(fin)) return { ok: false, erreur: "Date de fin invalide (jour réel attendu)." };
  if (debut > fin) return { ok: false, erreur: "La fin de période précède le début." };
  const annee = Number(debut.slice(0, 4));
  if (annee < 2000 || annee > 2100) return { ok: false, erreur: "Année du début hors de 2000 à 2100." };
  if (Number(fin.slice(0, 4)) > annee + 10) return { ok: false, erreur: "La période ne peut pas dépasser 10 ans après son début." };
  return { ok: true, annee };
}

export const periodeDeLAnnee = (annee: number) => ({ debut: `${annee}-01-01`, fin: `${annee}-12-31` });

// ----------------------------------------------------------------------------- formulaire -> demande

export interface PlafondSaisi { regionId: string; montant: string }

export interface FormulaireSimulation {
  enveloppe: string; debut: string; fin: string;
  regionId: string; classe: string; parametresId: string;
  logique: CodeLogique | "";
  partMinimalePct: string;
  ordrePersonnalise: string[];
  /** `null` = tous les candidats du perimetre (aucune selection envoyee). */
  selection: string[] | null;
  obligatoires: string[];
  groupes: string[][];
  plafonds: PlafondSaisi[];
  /** `null` = tous les baremes applicables. */
  baremeIds: number[] | null;
}

export function formulaireVide(annee: number): FormulaireSimulation {
  const p = periodeDeLAnnee(annee);
  return { enveloppe: "", debut: p.debut, fin: p.fin, regionId: "", classe: "", parametresId: "", logique: "", partMinimalePct: "", ordrePersonnalise: [], selection: null, obligatoires: [], groupes: [], plafonds: [], baremeIds: null };
}

export type ResultatDemande = { ok: true; demande: DemandeSimulateur } | { ok: false; erreurs: Record<string, string> };

/**
 * Valide la saisie et construit le corps de requete. Une saisie vide n'est pas envoyee (aucun filtre) ; elle n'est jamais
 * convertie en 0. Les contraintes qui ne concernent pas la logique choisie ne sont pas envoyees (le serveur les refuserait).
 */
export function construireDemande(f: FormulaireSimulation): ResultatDemande {
  const erreurs: Record<string, string> = {};
  const env = validerEnveloppe(f.enveloppe);
  if (!env.ok) erreurs.enveloppe = env.erreur;
  const per = validerPeriode(f.debut, f.fin);
  if (!per.ok) erreurs.periode = per.erreur;
  if (f.logique === "") erreurs.logique = "Choisissez une logique de priorité.";
  let equilibre: DemandeSimulateur["equilibre"];
  if (f.logique === "equilibre_territorial") {
    const n = Number(f.partMinimalePct);
    if (f.partMinimalePct.trim() === "" || !Number.isInteger(n) || n < 1 || n > 100) erreurs.partMinimale = "Part minimale par région : un entier de 1 à 100 (%).";
    else equilibre = { partMinimaleParRegionPct: n };
  }
  let ordre: string[] | undefined;
  if (f.logique === "personnalise") {
    if (f.ordrePersonnalise.length === 0) erreurs.ordre = "Ordre personnalisé : sélectionnez au moins une intervention et ordonnez-la.";
    else ordre = f.ordrePersonnalise;
  }
  const plafonds: Record<string, string> = {};
  f.plafonds.forEach((p, i) => {
    const r = Number(p.regionId);
    const m = validerEnveloppe(p.montant);
    if (!p.regionId || !Number.isInteger(r) || r <= 0) erreurs[`plafond${i}`] = "Plafond : choisissez une région.";
    else if (!m.ok) erreurs[`plafond${i}`] = `Plafond de la région ${r} : ${m.erreur}`;
    else if (plafonds[String(r)] !== undefined) erreurs[`plafond${i}`] = `Plafond : la région ${r} figure deux fois.`;
    else plafonds[String(r)] = m.chiffres;
  });
  const groupes = f.groupes.filter((g) => g.length > 0);
  groupes.forEach((g, i) => { if (g.length < 2) erreurs[`groupe${i}`] = `Groupe n°${i + 1} : au moins deux interventions.`; });
  const vus = new Set<string>();
  for (const g of groupes) for (const id of g) { if (vus.has(id)) erreurs.groupes = "Une intervention ne peut figurer que dans un seul groupe."; vus.add(id); }
  if (f.selection !== null && f.selection.length === 0) erreurs.selection = "Aucune intervention sélectionnée : cochez-en au moins une, ou revenez à « toutes ».";
  if (f.baremeIds !== null && f.baremeIds.length === 0) erreurs.baremes = "Aucun barème retenu : le simulateur ne chiffrerait rien.";
  if (Object.keys(erreurs).length > 0 || !env.ok || !per.ok || f.logique === "") return { ok: false, erreurs };
  return {
    ok: true,
    demande: {
      annee: per.annee, budgetGnf: env.chiffres, periode: { debut: f.debut, fin: f.fin }, logique: f.logique,
      ...(f.regionId ? { regionId: Number(f.regionId) } : {}),
      ...(f.classe ? { classe: f.classe } : {}),
      ...(f.parametresId ? { parametresId: f.parametresId } : {}),
      ...(f.selection !== null ? { selection: f.selection } : {}),
      ...(Object.keys(plafonds).length > 0 ? { plafondsRegionauxGnf: plafonds } : {}),
      ...(ordre ? { ordrePersonnalise: ordre } : {}),
      ...(equilibre ? { equilibre } : {}),
      ...(f.obligatoires.length > 0 ? { obligatoires: f.obligatoires } : {}),
      ...(groupes.length > 0 ? { groupesNonDivisibles: groupes } : {}),
      ...(f.baremeIds !== null ? { baremeIds: f.baremeIds } : {}),
    },
  };
}

// ----------------------------------------------------------------------------- listes

/** Ajoute ou retire un identifiant, sans doublon et sans effet de bord. */
export function basculer(liste: readonly string[], id: string): string[] {
  return liste.includes(id) ? liste.filter((x) => x !== id) : [...liste, id];
}

/** Deplace l'element `i` de `delta` rang (-1 vers le haut, 1 vers le bas) ; hors bornes, la liste est rendue telle quelle. */
export function deplacer(liste: readonly string[], i: number, delta: -1 | 1): string[] {
  const j = i + delta;
  if (i < 0 || i >= liste.length || j < 0 || j >= liste.length) return [...liste];
  const c = [...liste];
  [c[i], c[j]] = [c[j], c[i]];
  return c;
}

/** Retire de toutes les listes les identifiants qui ne sont plus selectionnes (une intervention decochee n'est plus obligatoire, ni dans un groupe, ni dans l'ordre). */
export function purgerSelection(f: FormulaireSimulation, selection: string[] | null): FormulaireSimulation {
  if (selection === null) return { ...f, selection };
  const garde = new Set(selection);
  return {
    ...f, selection,
    obligatoires: f.obligatoires.filter((id) => garde.has(id)),
    ordrePersonnalise: f.ordrePersonnalise.filter((id) => garde.has(id)),
    groupes: f.groupes.map((g) => g.filter((id) => garde.has(id))),
  };
}

// ----------------------------------------------------------------------------- affichage : montants, deficit, kilometres

const FINE = String.fromCharCode(0x202f);

/** « -3 700 000 000 GNF » : le signe est conserve, jamais masque par un maximum avec zero. */
export function formaterSolde(soldeGnf: string): string {
  if (!/^-?\d+$/.test(soldeGnf)) return "non calculable";
  return soldeGnf.startsWith("-") ? `-${FINE}${formaterGnf(soldeGnf.slice(1))}` : formaterGnf(soldeGnf);
}

export interface LectureDeficit { niveau: "deficit" | "excedent" | "equilibre"; titre: string; detail: string }

/**
 * Ce que dit le bilan du deficit. Un deficit est dit en toutes lettres avec son montant, et minorant si des couts manquent ;
 * un excedent est dit comme tel ; une enveloppe egale au besoin est dite egale. Jamais un « 0 » nu.
 */
export function lireDeficit(b: BilanBudgetaire): LectureDeficit {
  const minorant = b.deficitMinorant ? ` Ce déficit est un minimum : ${b.nbCoutsNonFiables} candidat(s) sans coût fiable ne sont pas comptés dans le besoin.` : "";
  if (b.deficitGnf !== "0") {
    return { niveau: "deficit", titre: `Déficit de ${formaterGnf(b.deficitGnf)}`, detail: `L'enveloppe de ${formaterGnf(b.enveloppeGnf)} ne couvre pas le besoin chiffré de ${formaterGnf(b.besoinTotalGnf)}.${minorant}` };
  }
  if (b.excedentGnf !== "0") {
    return { niveau: "excedent", titre: `Aucun déficit : excédent de ${formaterGnf(b.excedentGnf)}`, detail: `L'enveloppe couvre le besoin chiffré de ${formaterGnf(b.besoinTotalGnf)}.${minorant}` };
  }
  return { niveau: "equilibre", titre: "Aucun déficit : l'enveloppe égale le besoin chiffré", detail: `Besoin chiffré : ${formaterGnf(b.besoinTotalGnf)}.${minorant}` };
}

/** « 12,345 km » ; une longueur metier absente se dit, elle n'est ni 0 ni remplacee par la geometrique. */
export function formaterKm(km: string | null): string {
  return km === null ? "longueur métier absente" : `${km.replace(".", ",")}${FINE}km`;
}

export function formaterPct(pct: string | null): string {
  return pct === null ? "non calculable" : `${pct.replace(".", ",")}${FINE}%`;
}

/**
 * Part de `valeur` dans `max`, en pourcent a une decimale, calculee en BigInt (aucun flottant sur un montant), bornee a 100.
 * `null` quand le ratio est INDEFINI (denominateur nul ou valeur invalide) : jamais 0, qui se lirait « rien n'est consomme ».
 */
export function partDe(valeur: string, max: string): number | null {
  if (!/^\d+$/.test(valeur) || !/^\d+$/.test(max)) return null;
  const m = BigInt(max);
  if (m === 0n) return null;
  const dixiemes = (BigInt(valeur) * 1000n) / m;
  return Number(dixiemes > 1000n ? 1000n : dixiemes) / 10;
}

/** « 86 % » ou « non calculable » : un ratio indefini ne s'affiche jamais « 0 % ». */
export function formaterPart(part: number | null): string {
  return part === null ? "non calculable" : `${part.toLocaleString("fr-FR")}${FINE}%`;
}

/** Nombre de GNF a ecrire en milliards pour une lecture rapide, sans conversion flottante. */
export function enMilliardsTexte(chiffres: string): string {
  if (!/^\d+$/.test(chiffres)) return "non calculable";
  if (chiffres.length <= 9) return formaterGnf(chiffres);
  const entier = chiffres.slice(0, -9);
  const dec = chiffres.slice(-9, -7);
  return `${entier.replace(/\B(?=(\d{3})+(?!\d))/g, FINE)}${dec !== "00" ? `,${dec}` : ""}${FINE}Md GNF`;
}

export function libelleRegion(regionId: number | null, regions: readonly { id: number; nom: string }[]): string {
  if (regionId === null) return "Région non renseignée";
  return regions.find((r) => r.id === regionId)?.nom ?? `Région ${regionId}`;
}

/** Motifs d'exclusion tries du plus frequent au plus rare, avec leur libelle. */
export function listerExclusions(parMotif: Record<string, number>): { code: string; libelle: string; nb: number; coutNonFiable: boolean }[] {
  return Object.entries(parMotif)
    .map(([code, nb]) => ({ code, libelle: LIBELLE_EXCLUSION_SIM[code] ?? code, nb, coutNonFiable: (CODES_COUT_NON_FIABLE as readonly string[]).includes(code) }))
    .sort((a, b) => b.nb - a.nb || (a.code < b.code ? -1 : 1));
}

/** Alertes d'abord, puis informations : l'ordre du serveur est conserve a l'interieur de chaque niveau. */
export function classerAvertissements(l: readonly AvertissementSimulation[]): AvertissementSimulation[] {
  return [...l.filter((a) => a.niveau === "ALERTE"), ...l.filter((a) => a.niveau !== "ALERTE")];
}

export function libelleValiditeBareme(b: Pick<BaremeOption, "validDe" | "validA">): string {
  if (b.validDe === null && b.validA === null) return "sans fenêtre de validité";
  return `valide ${b.validDe ? `du ${b.validDe}` : "sans début"} ${b.validA ? `au ${b.validA}` : "sans fin"}`;
}

export const libelleStatutBareme = (statut: "PROVISOIRE" | "APPROUVE") => (statut === "APPROUVE" ? "approuvé" : "provisoire (non approuvé)");

// ----------------------------------------------------------------------------- export

/** Un export qui ne porte pas la mention « simulation non engageante » n'est jamais remis a l'utilisateur. */
export function exportPorteLaMention(texte: string): boolean {
  return texte.replace(/^\uFEFF/, "").includes("SIMULATION NON ENGAGEANTE");
}

/** Empreinte raccourcie pour l'affichage ; la complete reste lisible dans le detail. */
export function empreinteCourte(h: string): string {
  return h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-8)}` : h;
}

/**
 * Affecte une intervention au groupe `numero` (1 a groupes.length + 1 : le suivant cree un groupe) ou la retire de tout groupe
 * (`null`). Une intervention n'est que dans un seul groupe ; un groupe vide disparait.
 */
export function affecterGroupe(groupes: readonly (readonly string[])[], id: string, numero: number | null): string[][] {
  const sans = groupes.map((g) => g.filter((x) => x !== id));
  if (numero !== null) {
    if (numero === sans.length + 1) sans.push([id]);
    else if (numero >= 1 && numero <= sans.length) sans[numero - 1] = [...sans[numero - 1], id];
  }
  return sans.filter((g) => g.length > 0).map((g) => [...g]);
}

/** Numero (1-based) du groupe de l'intervention, ou `null`. */
export function groupeDe(groupes: readonly (readonly string[])[], id: string): number | null {
  const i = groupes.findIndex((g) => g.includes(id));
  return i < 0 ? null : i + 1;
}

// ----------------------------------------------------------------------------- droits d'export, politique de relance

export interface DroitsCompte { role?: string; modulesAutorises?: string[] }
export type VerdictExport = { ok: true } | { ok: false; raison: string };

/**
 * Regle du SERVEUR pour exporter un scenario : module « rapports » ET role ADMIN ou GESTIONNAIRE. ADMIN n'est jamais restreint ;
 * pour les autres, une liste de modules VIDE vaut AUCUN module (lib/access.ts du serveur). Le serveur reste juge : ce verdict
 * evite seulement de proposer un bouton qui ne peut qu'echouer, et dit pourquoi.
 */
export function droitExportScenario(c: DroitsCompte | null | undefined): VerdictExport {
  if (!c) return { ok: false, raison: "compte inconnu" };
  if (c.role !== "ADMIN" && c.role !== "GESTIONNAIRE") return { ok: false, raison: "l'export est réservé aux rôles administrateur et gestionnaire" };
  if (c.role !== "ADMIN" && !(c.modulesAutorises ?? []).includes("rapports")) return { ok: false, raison: "votre compte n'a pas accès au module Rapports" };
  return { ok: true };
}

/** Statuts qu'une relance ne peut pas corriger (requete invalide, session, droits, ressource absente). */
const STATUTS_SANS_RELANCE = [400, 401, 403, 404];

/** Politique de relance des lectures : une seule relance, et aucune sur 400, 401, 403 ou 404. */
export function relancer(nbEchecs: number, erreur: unknown): boolean {
  const statut = (erreur as { response?: { status?: number } } | null)?.response?.status;
  if (typeof statut === "number" && STATUTS_SANS_RELANCE.includes(statut)) return false;
  return nbEchecs < 1;
}

// ----------------------------------------------------------------------------- gardes d'execution des reponses
// Verification MINIMALE de la forme que l'ecran lit (comme analyserSynthese) : une reponse mal formee donne un etat d'erreur propre,
// jamais une exception de rendu. Ce n'est pas une validation complete du contrat.

const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const chaine = (v: unknown): v is string => typeof v === "string";
const gnf = (v: unknown): v is string => typeof v === "string" && /^-?\d+$/.test(v);
const tab = (v: unknown): v is unknown[] => Array.isArray(v);
const nombre = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const nonNeg = (v: unknown): v is string => gnf(v) && !(v as string).startsWith("-");

function estBilan(v: unknown): boolean {
  return obj(v) && ["enveloppeGnf", "consommeGnf", "resteGnf", "besoinTotalGnf", "deficitGnf", "excedentGnf"].every((k) => nonNeg(v[k])) && gnf(v.soldeGnf)
    && nombre(v.nbCoutsFiables) && nombre(v.nbCoutsNonFiables) && typeof v.deficitMinorant === "boolean" && nonNeg(v.besoinObligatoiresGnf) && nonNeg(v.deficitObligatoiresGnf)
    && (v.couvertureBesoinPct === null || chaine(v.couvertureBesoinPct));
}

function estSimulation(v: unknown): boolean {
  if (!obj(v)) return false;
  const c = v.contraintes, k = v.kilometres, r = v.risqueCouvert, b = v.baremes, l = v.logique, p = v.periode;
  if (!(chaine(v.mention) && obj(p) && chaine(p.debut) && chaine(p.fin) && chaine(v.devise) && estBilan(v.bilan) && tab(v.coutsNonFiables) && tab(v.avertissements) && tab(v.distributionRegionale))) return false;
  if (!(obj(l) && chaine(l.code) && chaine(l.libelle) && chaine(l.explication) && chaine(l.regle) && typeof l.provisoire === "boolean")) return false;
  if (!(obj(c) && obj(c.obligatoires) && tab(c.obligatoires.demandees) && tab(c.obligatoires.effectives) && tab(c.obligatoires.retenues) && tab(c.obligatoires.nonRetenues)
    && tab(c.groupesNonDivisibles) && obj(c.plafondsRegionauxGnf) && tab(c.insatisfaisables) && (c.equilibre === null || tab(c.equilibre)))) return false;
  if (!(obj(k) && chaine(k.note) && nombre(k.lignesSansLongueurMetier) && (k.metierKm === null || chaine(k.metierKm)))) return false;
  if (!(obj(r) && nombre(r.nbSansRisqueCalculable) && obj(b) && chaine(b.empreinte) && nombre(b.nbLignes) && nombre(b.nbApprouvees) && nombre(b.nbProvisoires) && chaine(v.parametresVersion))) return false;
  return (v.avertissements as unknown[]).every((a) => obj(a) && chaine(a.code) && chaine(a.message))
    && (v.coutsNonFiables as unknown[]).every((a) => obj(a) && chaine(a.code) && nombre(a.nb) && tab(a.troncons))
    && (v.distributionRegionale as unknown[]).every((d) => obj(d) && nonNeg(d.engageGnf) && nonNeg(d.besoinGnf) && nombre(d.nbRetenues) && nombre(d.nbEcartees));
}

function estLigne(v: unknown): boolean {
  return obj(v) && obj(v.troncon) && chaine(v.troncon.id) && chaine(v.troncon.code) && (v.decision === "RETENUE" || v.decision === "ECARTEE") && obj(v.risque) && tab(v.risque.facteurs) && chaine(v.justification)
    && (v.motifExclusion === null || (obj(v.motifExclusion) && chaine(v.motifExclusion.code))) && (v.cout === null || obj(v.cout))
    && (v.simulation === undefined || (obj(v.simulation) && obj(v.simulation.prioriteTechnique) && typeof v.simulation.coutFiable === "boolean"));
}

/** Resultat d'un scenario (avec ou sans bloc simulation : un scenario herite n'en a pas). */
export function estScenarioSim(v: unknown): v is ScenarioSim {
  if (!obj(v) || !tab(v.lignes) || !v.lignes.every(estLigne)) return false;
  const t = v.totaux, p = v.parametres;
  return obj(t) && nombre(t.candidats) && nombre(t.retenues) && nombre(t.ecartees) && gnf(t.engageGnf) && gnf(t.resteGnf) && obj(t.ecartesParMotif)
    && obj(p) && chaine(p.version) && chaine(p.etiquette) && chaine(v.etiquette) && typeof v.provisoire === "boolean" && tab(v.motifsProvisoire) && tab(v.limites) && chaine(v.avertissement)
    && obj(v.methode) && chaine(v.methode.id) && nombre(v.annee) && gnf(v.budgetGnf) && (v.simulation === undefined || estSimulation(v.simulation));
}

export function estResultatCalcul(v: unknown): v is ResultatCalcul {
  return obj(v) && estScenarioSim(v.resultat) && chaine(v.empreinteEntrees) && chaine(v.empreinteResultat);
}

function estResume(v: unknown): boolean {
  return obj(v) && chaine(v.id) && chaine(v.intitule) && nombre(v.annee) && gnf(v.budgetGnf) && gnf(v.montantEngageGnf) && nombre(v.nbRetenues) && nombre(v.nbEcartees) && chaine(v.parametresVersion)
    && chaine(v.etiquette) && typeof v.provisoire === "boolean" && chaine(v.empreinteEntrees) && chaine(v.empreinteResultat) && chaine(v.creeParId) && chaine(v.creeLe)
    && typeof v.simulateur === "boolean" && (v.deficitGnf === null || nonNeg(v.deficitGnf)) && (v.periode === null || (obj(v.periode) && chaine(v.periode.debut) && chaine(v.periode.fin)));
}

export interface ReponseEnregistrement {
  scenario: { id: string; intitule: string; creeParId: string; creeLe: string; empreinteEntrees: string; empreinteResultat: string; budgetGnf: string };
  resultat: ScenarioSim;
}

export function estEnregistrement(v: unknown): v is ReponseEnregistrement {
  return obj(v) && obj(v.scenario) && chaine(v.scenario.id) && chaine(v.scenario.intitule) && chaine(v.scenario.creeParId) && chaine(v.scenario.creeLe) && chaine(v.scenario.empreinteResultat) && estScenarioSim(v.resultat);
}

export function estListe(v: unknown): v is ListeScenarios {
  return obj(v) && tab(v.data) && v.data.every(estResume) && nombre(v.total) && nombre(v.page) && nombre(v.pageSize) && v.pageSize > 0;
}

export function estDetail(v: unknown): v is DetailScenario {
  if (!(obj(v) && obj(v.scenario) && chaine(v.scenario.id) && chaine(v.scenario.intitule) && gnf(v.scenario.budgetGnf) && chaine(v.scenario.parametresVersion) && chaine(v.scenario.empreinteEntrees) && chaine(v.scenario.empreinteResultat)
    && chaine(v.scenario.creeLe) && chaine(v.scenario.etiquette) && estScenarioSim(v.resultat) && typeof v.simulateur === "boolean" && obj(v.entrees) && nombre(v.entrees.nbCandidats))) return false;
  const s = (v.entrees as Record<string, unknown>).simulation;
  return s === null || (obj(s) && obj(s.periode) && chaine(s.logique) && tab(s.obligatoires) && tab(s.groupesNonDivisibles) && obj(s.baremes) && chaine(s.baremes.empreinte) && obj(s.perimetre));
}

export function estOptions(v: unknown): v is OptionsSimulateur {
  return obj(v) && chaine(v.mention) && v.devise === "GNF" && nombre(v.maxCandidats) && tab(v.logiques) && v.logiques.every((l) => obj(l) && chaine(l.code) && chaine(l.libelle) && chaine(l.explication) && typeof l.provisoire === "boolean")
    && tab(v.parametres) && (v.baremes === null || (tab(v.baremes) && v.baremes.every((b) => obj(b) && (nombre(b.id) || chaine(b.id)) && gnf(b.coutKmGnf) && typeof b.couvrePeriode === "boolean" && (b.statut === "PROVISOIRE" || b.statut === "APPROUVE"))))
    && obj(v.contraintes) && chaine(v.contraintes.reglesFinancement);
}

export function estCandidats(v: unknown): v is ReponseCandidats {
  return obj(v) && tab(v.data) && v.data.every((c) => obj(c) && chaine(c.id) && chaine(c.code)) && nombre(v.total) && typeof v.tronque === "boolean" && nombre(v.maxCandidats);
}

export function estComparaison(v: unknown): v is Comparaison {
  if (!(obj(v) && chaine(v.mention) && obj(v.periode) && tab(v.scenarios) && v.scenarios.length >= 2 && tab(v.hypotheses) && obj(v.interventions) && nombre(v.interventions.communes) && tab(v.interventions.propres))) return false;
  const n = (v.scenarios as unknown[]).length;
  return (v.scenarios as unknown[]).every((c) => obj(c) && chaine(c.id) && chaine(c.intitule) && obj(c.logique) && chaine(c.logique.libelle) && ["enveloppeGnf", "consommeGnf", "resteGnf", "besoinTotalGnf", "deficitGnf"].every((k) => nonNeg(c[k])) && gnf(c.soldeGnf)
      && typeof c.deficitMinorant === "boolean" && nombre(c.nbInterventions) && nombre(c.nbCandidats) && obj(c.kilometres) && obj(c.risqueCouvert) && tab(c.distributionRegionale) && obj(c.exclusionsParMotif) && obj(c.baremes) && chaine(c.baremes.empreinte))
    && (v.hypotheses as unknown[]).every((h) => obj(h) && chaine(h.champ) && chaine(h.libelle) && tab(h.valeurs) && h.valeurs.length === n && typeof h.identiques === "boolean");
}

export function estRapportRejeu(v: unknown): v is RapportRejeu {
  return obj(v) && typeof v.identique === "boolean" && typeof v.entreesIntegres === "boolean" && chaine(v.empreinteStockee) && chaine(v.empreinteRecalculee) && chaine(v.explication);
}
