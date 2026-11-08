/**
 * Suivi contractuel de l'aide a la decision (AD-LOT-5) : NOYAU PUR (ni base, ni horloge, ni requete).
 *
 * CE QUE CE MODULE FAIT : a partir de lignes deja lues dans la COPIE LOCALE des objets contractuels
 * (`marches`, `decomptes`, `avancement_marche`, `marches_chantiers`, `chantiers`, `programmes_budgetaires`), il
 * fabrique la vue d'un marche dont chaque grandeur est ETIQUETEE, sans jamais en confondre deux :
 *
 *   marche RECENSE      une ligne de `marches` non supprimee. Jamais « actif » : aucune regle de statut n'est validee.
 *   CONTRACTUEL         `marches.montantTotal`, dans la devise du marche.
 *   ENGAGE              NON_DISPONIBLE, toujours. Aucune source financiere n'est validee (B-08, ADR-003). Il n'est JAMAIS
 *                       derive du contractuel, des chantiers ni des decomptes.
 *   DECAISSE            somme des decomptes dont le statut SAISI est PAYE. Pas un engagement, pas un contractuel.
 *   PREVISIONNEL        programmes budgetaires RETENUS lies au marche par un troncon commun et un seul marche.
 *   avancement DECLARE  `avancement_marche.avancementPhysiqueReel` (saisi, jamais verifie).
 *   avancement CONSTATE NON_DISPONIBLE : aucune source de constat distincte n'existe. Jamais une copie du declare.
 *   avancement FINANCIER `avancement_marche.avancementFinancierReel` (declaratif), distinct du decaisse calcule.
 *
 * POURQUOI RIEN N'EST « DISPONIBLE » SANS RESERVE : DigitalRoad est la source de verite des marches, decomptes et
 * paiements (DATA_SOURCE_OF_TRUTH.md 2.5) ; il n'est pas integre (B-11) et la copie du Geoportail est GELEE (ADR-003), sans
 * cle commune ni date de synchronisation. Tout ce que ce module dit est donc « tel que saisi dans la copie gelee ».
 *
 * Les regles ci-dessous (retard, seuils, perimetre territorial) sont PROVISOIRES : choix de conduite reversibles, nommes,
 * jamais une regle officielle (contrat docs/aide-decision/CONTRAT-AD.md). Le noyau ne lit pas l'horloge : `maintenant`
 * est passe par l'appelant.
 */
import { REGION_NON_RENSEIGNEE } from "../lib/localisation";

// ================================================================================================ constantes

/** Valeurs PROVISOIRES nommees. Les deux premieres sont celles de `modules/marches/alertes.service.ts`. */
export const SEUILS_PROVISOIRES = {
  /** Ecart physique prevu moins reel, au-dela duquel un marche est signale en retard physique. */
  ecartPhysiqueMoyenPoints: 10,
  /** Au-dela : gravite haute. */
  ecartPhysiqueHautPoints: 25,
  /** Garantie de bonne execution : alerte quand elle expire dans moins de ce nombre de jours. */
  garantieProcheJours: 60,
  /** Une copie dont la derniere mise a jour date de plus de ce nombre de jours est dite PERIMEE. Seuil de fraicheur non decide (cahier 14.2). */
  peremptionJours: 90,
} as const;

export const PLAFOND_CHANTIERS_PAR_MARCHE = 20;
export const PLAFOND_TRONCONS_PAR_MARCHE = 20;
export const PLAFOND_EXEMPLES = 5;
/** Au-dela, les agregats portent sur les marches les plus recents et le disent. */
export const PLAFOND_MARCHES_ANALYSES = 2000;

export const SOURCE_COPIE_GELEE = {
  code: "COPIE_GELEE_GEOPORTAIL",
  libelle: "Copie locale gelee des objets contractuels du Geoportail (ADR-003)",
  sourceDeVerite: "DigitalRoad",
  integree: false,
  copieGelee: true,
  derniereSynchronisation: null as string | null,
  references: ["ADR-003", "B-08", "B-11", "DATA_SOURCE_OF_TRUTH.md 2.5"],
} as const;

export const MESSAGE_DONNEES_PARTIELLES =
  "Données contractuelles partielles : source de vérité externe non intégrée (DigitalRoad).";

// ================================================================================================ types d'entree

export type StatutMarche = "PLANIFIE" | "EN_COURS" | "SUSPENDU" | "TERMINE" | "SOLDE";
export type DeviseMarche = "GNF" | "USD" | "EUR";
export type StatutDecompte = "EMIS" | "PAYE" | "REJETE";
export type TypeDecompte = "AVANCE" | "DECOMPTE" | "RETENUE_GARANTIE" | "SOLDE";
export const STATUTS_MARCHE: readonly StatutMarche[] = ["PLANIFIE", "EN_COURS", "SUSPENDU", "TERMINE", "SOLDE"];

export interface TronconEntree {
  id: string; code: string; nom: string; regionId: number; classe: string; etat: string; archive: boolean;
}

export interface ChantierEntree {
  id: string; intitule: string; entreprise: string; bailleur: string | null; regionId: number;
  tronconId: string | null; troncon: TronconEntree | null;
  avancementPct: number; statut: string;
  dateDebutPrevue: Date | null; dateFinPrevue: Date | null; dateDebutReelle: Date | null; dateFinReelle: Date | null;
  numContrat: string | null; archive: boolean;
  /** Nombre de marches non supprimes qui rattachent ce chantier (tous perimetres confondus). */
  nbMarches: number;
}

/** Une ligne de `marches_chantiers` : `tronconId` y est facultatif. */
export interface LienEntree { chantier: ChantierEntree; tronconId: string | null; troncon: TronconEntree | null }

export interface DecompteEntree {
  id: string; numero: number; type: TypeDecompte; statut: StatutDecompte; montantGnf: bigint;
  dateEmission: Date | null; datePaiement: Date | null; updatedAt: Date;
}

export interface AvancementEntree {
  periode: Date; physiquePrevu: number; physiqueReel: number; financierPrevu: number; financierReel: number; createdAt: Date;
}

export interface ProgrammeEntree {
  id: string; annee: number; intitule: string; tronconId: string | null; montantPrevuGnf: bigint; statut: string;
}

export interface MarcheEntree {
  id: string; intitule: string; statut: StatutMarche; devise: DeviseMarche; montantTotal: bigint | null;
  bailleurId: number | null; bailleurNom: string | null; bailleurType: string | null;
  dateSignature: Date | null; dateDebutPrevue: Date | null; dateFinPrevue: Date | null;
  dateReceptionProvisoire: Date | null; garantieBonneExecutionExp: Date | null; tauxPenaliteRetardPct: number | null;
  createdAt: Date; updatedAt: Date;
  liens: LienEntree[];
  decomptes: DecompteEntree[];
  /** Periodes d'avancement, de la plus recente a la plus ancienne. */
  avancements: AvancementEntree[];
}

// ================================================================================================ types de sortie

export type EtatDonnee = "DISPONIBLE" | "NON_DISPONIBLE" | "PARTIEL" | "PERIME" | "DEFINITION_NON_VALIDEE";
export type QualiteLien = "DIRECT" | "PAR_CHANTIER" | "MANQUANT" | "AMBIGU";

export type MotifMontant =
  | "SOURCE_NON_VALIDEE" | "DROIT_FINANCIER" | "TERRITOIRE" | "MONTANT_ABSENT" | "DEVISE_NON_GNF"
  | "AUCUN_DECOMPTE" | "AUCUN_LIEN" | "LIEN_AMBIGU" | "AUCUN_MARCHE";

/** Grandeur financiere : valeur en chaine (GNF au franc pres, sans perte au-dela de 2^53) ou null avec la raison. */
export interface MontantVue {
  etat: EtatDonnee;
  valeurGnf: string | null;
  motif: MotifMontant | null;
  source: string;
  avertissement: string | null;
  /** Montant d'un marche en devise etrangere : rien n'est converti (aucun taux n'est documente). */
  valeurOrigine?: { montant: string; devise: string };
  /** Pour un agregat : combien de marches ont contribue, sur combien. */
  couverture?: { pris: number; total: number };
}

/** Champ non financier avec son etat et sa source. `valeur` est null quand l'etat n'est pas DISPONIBLE. */
export interface ChampSource<T> {
  etat: "DISPONIBLE" | "NON_DISPONIBLE" | "PARTIEL";
  valeur: T | null;
  source: string;
  avertissement: string | null;
}

export interface TronconLieVue {
  id: string; code: string; nom: string; regionId: number; classe: string; etat: string;
  via: "LIEN" | "CHANTIER"; chantierId: string;
}

export interface ChantierLieVue {
  id: string; intitule: string; entreprise: string; statut: string; regionId: number;
  /** Avancement DECLARE sur le chantier (`chantiers.avancementPct`), jamais un constat. */
  avancementDeclarePct: number;
  dateFinPrevue: string | null;
  bailleurTexte: string | null;
  partageEntreMarches: boolean;
  lienTroncon: { qualite: QualiteLien; troncon: { id: string; code: string; nom: string } | null; tronconChantier: { id: string; code: string; nom: string } | null };
}

export type CodeControle =
  | "MARCHE_SANS_CHANTIER" | "CHANTIER_SANS_TRONCON" | "ASSOCIATION_AMBIGUE" | "BAILLEUR_INCOHERENT"
  | "DECOMPTE_SUPERIEUR_MARCHE" | "DATES_INCOHERENTES" | "AVANCEMENT_HORS_BORNES" | "CHANTIER_SANS_MARCHE"
  | "REFERENCES_DIVERGENTES";

export interface Alerte { code: string; gravite: "haute" | "moyenne" | "info"; message: string }

export interface RetardVue {
  etat: "EN_RETARD" | "A_JOUR" | "NON_EVALUABLE" | "TERMINE";
  /** Regles effectivement evaluees pour ce marche. */
  regles: ("CALENDAIRE" | "PHYSIQUE" | "RECEPTION")[];
  joursRetardCalendaire: number | null;
  ecartPhysiquePoints: number | null;
  gravite: "haute" | "moyenne" | null;
  alertes: Alerte[];
  avertissements: string[];
}

export interface Constat { code: CodeControle; detail: string; chantierId?: string }

export interface MarcheVue {
  id: string;
  intitule: string;
  reference: ChampSource<string[]>;
  lots: ChampSource<string[]>;
  entreprises: ChampSource<string[]>;
  bailleur: { id: number | null; nom: string | null; type: string | null; source: string };
  dates: { signature: string | null; debutPrevu: string | null; finPrevue: string | null; receptionProvisoire: string | null; garantieBonneExecution: string | null };
  delais: { dureePrevueJours: number | null; avenants: ChampSource<unknown[]>; suspensions: ChampSource<unknown[]> };
  statut: { code: StatutMarche; libelle: string; source: string; usageRetard: "OUVERT" | "CLOS" };
  devise: DeviseMarche;
  montants: { contractuel: MontantVue; engage: MontantVue; decaisse: MontantVue; previsionnel: MontantVue };
  decomptes: {
    total: number; parStatut: Record<StatutDecompte, number>;
    /** Les decomptes comptes dans le decaisse : leur numero, type et statut saisi. */
    payes: { numero: number; type: TypeDecompte; datePaiement: string | null }[];
  };
  programmes: { retenusLies: { id: string; annee: number; intitule: string; montantPrevuGnf: string }[]; ambigus: number };
  avancement: {
    declare: { etat: "DISPONIBLE" | "NON_DISPONIBLE"; physiqueReelPct: number | null; physiquePrevuPct: number | null; periode: string | null; source: string; avertissement: string | null };
    constate: { etat: "NON_DISPONIBLE"; valeurPct: null; motif: "AUCUNE_SOURCE_DE_CONSTAT"; source: string; avertissement: string };
    financier: { etat: "DISPONIBLE" | "NON_DISPONIBLE"; reelPct: number | null; prevuPct: number | null; periode: string | null; source: string; avertissement: string };
  };
  retard: RetardVue;
  pieces: { etat: "NON_DISPONIBLE"; liens: []; raison: string };
  liens: {
    chantiers: { qualite: QualiteLien; total: number; archivesIgnores: number; tronque: boolean; autresRegionsMasquees: boolean; liste: ChantierLieVue[] };
    troncons: { qualite: QualiteLien; comptes: Record<QualiteLien, number>; total: number; tronque: boolean; autresRegionsMasquees: boolean; liste: TronconLieVue[] };
  };
  territoire: { etabli: boolean; regionIds: number[]; multiRegions: boolean; incertain: boolean; montantsMasques: boolean };
  anomalies: CodeControle[];
  avertissements: string[];
  miseAJourLe: string;
}

// ================================================================================================ utilitaires

const JOUR_MS = 86_400_000;

export function normaliser(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** AAAA-MM-JJ en UTC, ou null. */
export function jourIso(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function jourUtc(d: Date): number {
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / JOUR_MS);
}

export function joursEntre(debut: Date, fin: Date): number {
  return jourUtc(fin) - jourUtc(debut);
}

const LIBELLE_STATUT: Record<StatutMarche, string> = {
  PLANIFIE: "Planifié", EN_COURS: "En cours", SUSPENDU: "Suspendu", TERMINE: "Terminé", SOLDE: "Soldé",
};

export function libelleStatutMarche(s: StatutMarche): string { return LIBELLE_STATUT[s]; }

const STATUTS_OUVERTS: ReadonlySet<StatutMarche> = new Set<StatutMarche>(["PLANIFIE", "EN_COURS", "SUSPENDU"]);

// ================================================================================================ montants

const SRC = {
  contractuel: "marches.montantTotal, copie gelee (DigitalRoad fait foi)",
  decaisse: "decomptes dont le statut saisi est PAYE, copie gelee (DigitalRoad fait foi)",
  engage: "aucune source financiere validee (B-08, ADR-003)",
  previsionnel: "programmes_budgetaires retenus, lies par un troncon commun a un seul marche",
} as const;

export const AVERTISSEMENT_ENGAGE =
  "Montant engage non disponible : la source financiere et sa definition ne sont pas validees (B-08, ADR-003). "
  + "Il n'est jamais deduit du montant contractuel, des chantiers ni des decomptes.";

export function montantNonDisponible(source: string, motif: MotifMontant, avertissement: string): MontantVue {
  return { etat: "NON_DISPONIBLE", valeurGnf: null, motif, source, avertissement };
}

export function montantEngage(): MontantVue {
  return montantNonDisponible(SRC.engage, "SOURCE_NON_VALIDEE", AVERTISSEMENT_ENGAGE);
}

/** Retire toute valeur d'un montant : compte sans droit financier, ou marche multi-regional pour un compte regional. */
export function montantMasque(source: string, motif: "DROIT_FINANCIER" | "TERRITOIRE"): MontantVue {
  return montantNonDisponible(
    source,
    motif,
    motif === "DROIT_FINANCIER"
      ? "Montant masque : votre compte n'a pas le droit de consulter les donnees financieres."
      : "Montant masque : ce marche couvre un territoire plus large que votre perimetre (ou un lien territorial est inconnu) et son montant ne se ventile pas par region.",
  );
}

function montantContractuel(m: MarcheEntree): MontantVue {
  if (m.montantTotal === null) {
    return montantNonDisponible(SRC.contractuel, "MONTANT_ABSENT", "Aucun montant contractuel saisi pour ce marche : ce n'est pas un montant nul.");
  }
  if (m.devise !== "GNF") {
    return {
      etat: "NON_DISPONIBLE", valeurGnf: null, motif: "DEVISE_NON_GNF", source: SRC.contractuel,
      avertissement: `Marche en ${m.devise} : aucun taux de change n'est documente, le montant n'est pas converti en GNF.`,
      valeurOrigine: { montant: m.montantTotal.toString(), devise: m.devise },
    };
  }
  return {
    etat: "DISPONIBLE", valeurGnf: m.montantTotal.toString(), motif: null, source: SRC.contractuel,
    avertissement: "Copie gelee : le montant fait foi dans DigitalRoad ; avenants non modelises.",
  };
}

function montantDecaisse(m: MarcheEntree): { vue: MontantVue; payes: DecompteEntree[]; sansDate: number } {
  const vivants = m.decomptes;
  if (vivants.length === 0) {
    return {
      vue: montantNonDisponible(SRC.decaisse, "AUCUN_DECOMPTE", "Aucun decompte saisi : un paiement non saisi n'est pas un paiement nul."),
      payes: [], sansDate: 0,
    };
  }
  const payes = vivants.filter((d) => d.statut === "PAYE");
  const somme = payes.reduce((s, d) => s + d.montantGnf, BigInt(0));
  const retenues = payes.filter((d) => d.type === "RETENUE_GARANTIE").length;
  const sansDate = payes.filter((d) => d.datePaiement === null).length;
  const avert: string[] = ["Statut saisi dans la copie gelee, non rapproche des paiements de DigitalRoad."];
  if (retenues > 0) avert.push(`Inclut ${retenues} decompte(s) de type RETENUE_GARANTIE paye(s) : la nature de ce type (retenue ou restitution) n'est pas tranchee.`);
  if (sansDate > 0) avert.push(`${sansDate} decompte(s) paye(s) sans date de paiement.`);
  if (m.devise !== "GNF") avert.push(`Marche en ${m.devise} alors que les decomptes sont saisis en GNF : conversion non documentee.`);
  return {
    vue: { etat: "DISPONIBLE", valeurGnf: somme.toString(), motif: null, source: SRC.decaisse, avertissement: avert.join(" ") },
    payes, sansDate,
  };
}

// ================================================================================================ territoire

export interface Territoire { regions: Set<number>; incertain: boolean }

function chantierActifs(m: MarcheEntree): LienEntree[] { return m.liens.filter((l) => !l.chantier.archive); }

/**
 * Regions qu'un marche touche, deduites de ses chantiers et de ses troncons (le marche n'a AUCUNE region propre).
 * `incertain` : un chantier est rattache a l'entree « Non renseigne » (qui n'est pas une region) : une partie du marche n'est localisee nulle part.
 */
export function territoireDuMarche(m: MarcheEntree, regionsNonRenseignees: ReadonlySet<number>): Territoire {
  const regions = new Set<number>();
  let incertain = false;
  for (const l of chantierActifs(m)) {
    if (regionsNonRenseignees.has(l.chantier.regionId)) incertain = true; else regions.add(l.chantier.regionId);
    for (const t of [l.troncon, l.chantier.troncon]) if (t && !t.archive) regions.add(t.regionId);
  }
  return { regions, incertain };
}

/** Un compte national voit tout ; un compte regional ne voit un marche que si une de ses regions est dans son perimetre. */
export function visibleDuPerimetre(t: Territoire, perimetre: ReadonlySet<number> | null): boolean {
  if (perimetre === null) return true;
  for (const r of t.regions) if (perimetre.has(r)) return true;
  return false;
}

/** Pour un compte regional, le montant d'un marche qui deborde du perimetre (ou incertain) n'est pas ventilable : masque. */
export function montantsMasquesPourPerimetre(t: Territoire, perimetre: ReadonlySet<number> | null): boolean {
  if (perimetre === null) return false;
  if (t.incertain) return true;
  for (const r of t.regions) if (!perimetre.has(r)) return true;
  return false;
}

// ================================================================================================ liens

const RANG_QUALITE: Record<QualiteLien, number> = { DIRECT: 0, PAR_CHANTIER: 1, MANQUANT: 2, AMBIGU: 3 };

export function qualiteLienTroncon(l: LienEntree): QualiteLien {
  const tLien = l.tronconId && l.troncon && !l.troncon.archive ? l.tronconId : null;
  const tCh = l.chantier.tronconId && l.chantier.troncon && !l.chantier.troncon.archive ? l.chantier.tronconId : null;
  if (tLien && tCh && tLien !== tCh) return "AMBIGU";
  if (tLien) return "DIRECT";
  if (tCh) return "PAR_CHANTIER";
  return "MANQUANT";
}

/** La plus faible des qualites : AMBIGU, puis MANQUANT, puis PAR_CHANTIER, puis DIRECT. Sans lien du tout : MANQUANT. */
export function pireQualite(qualites: readonly QualiteLien[]): QualiteLien {
  if (qualites.length === 0) return "MANQUANT";
  return qualites.reduce((a, b) => (RANG_QUALITE[b] > RANG_QUALITE[a] ? b : a));
}

// ================================================================================================ retard

export const REGLE_RETARD =
  "PROVISOIRE. Un marche dont le statut saisi est PLANIFIE, EN_COURS ou SUSPENDU est en retard calendaire quand sa date de fin prevue est passee, "
  + `et en retard physique quand le dernier avancement saisi montre un ecart prevu moins reel superieur a ${SEUILS_PROVISOIRES.ecartPhysiqueMoyenPoints} points `
  + `(gravite haute au-dela de ${SEUILS_PROVISOIRES.ecartPhysiqueHautPoints}). La reception provisoire depassee est signalee a part. `
  + "Les avenants et les suspensions ne sont pas modelises : les dates sont celles du marche initial, un marche suspendu ou prolonge est donc compte en retard a tort.";

export function evaluerRetard(m: MarcheEntree, maintenant: Date): RetardVue {
  const avertissements = [
    "Avenants et suspensions ignorés : le retard est calculé sur les dates prévues saisies, sans décalage contractuel.",
  ];
  if (m.statut === "SUSPENDU") avertissements.push("Marché suspendu : la durée de la suspension est inconnue, le retard calendaire est surestimé.");
  const alertes: Alerte[] = [];
  if (!STATUTS_OUVERTS.has(m.statut)) {
    return { etat: "TERMINE", regles: [], joursRetardCalendaire: null, ecartPhysiquePoints: null, gravite: null, alertes, avertissements: [...avertissements, "Marché terminé ou soldé : aucune date de fin réelle n'existe sur la copie, le retard passé n'est pas évalué."] };
  }
  const regles: RetardVue["regles"] = [];
  let jours: number | null = null;
  if (m.dateFinPrevue) {
    regles.push("CALENDAIRE");
    const j = joursEntre(m.dateFinPrevue, maintenant);
    if (j > 0) {
      jours = j;
      alertes.push({ code: "RETARD_CALENDAIRE", gravite: "moyenne", message: `Date de fin prévue dépassée de ${j} jour(s).` });
    }
  } else {
    avertissements.push("Date de fin prévue absente : le retard calendaire n'est pas évaluable.");
  }
  let ecart: number | null = null;
  let gravite: "haute" | "moyenne" | null = null;
  const dernier = m.avancements[0];
  if (dernier) {
    regles.push("PHYSIQUE");
    const e = dernier.physiquePrevu - dernier.physiqueReel;
    ecart = Math.round(e * 100) / 100;
    if (e > SEUILS_PROVISOIRES.ecartPhysiqueMoyenPoints) {
      gravite = e > SEUILS_PROVISOIRES.ecartPhysiqueHautPoints ? "haute" : "moyenne";
      alertes.push({ code: "RETARD_PHYSIQUE", gravite, message: `Retard physique de ${Math.round(e)} points (prévu ${dernier.physiquePrevu} %, déclaré ${dernier.physiqueReel} %, période du ${jourIso(dernier.periode)}).` });
    }
  } else {
    avertissements.push("Aucun avancement saisi : le retard physique n'est pas évaluable.");
  }
  if (m.dateReceptionProvisoire) {
    regles.push("RECEPTION");
    const j = joursEntre(m.dateReceptionProvisoire, maintenant);
    if (j > 0) alertes.push({ code: "RECEPTION_DEPASSEE", gravite: "haute", message: `Réception provisoire dépassée de ${j} jour(s) (pénalité non estimée : aucun barème contractuel validé).` });
  }
  if (m.garantieBonneExecutionExp) {
    const j = joursEntre(maintenant, m.garantieBonneExecutionExp);
    if (j >= 0 && j < SEUILS_PROVISOIRES.garantieProcheJours) {
      alertes.push({ code: "GARANTIE_PROCHE_EXPIRATION", gravite: j < 30 ? "haute" : "moyenne", message: `Garantie de bonne exécution expire dans ${j} jour(s).` });
    }
  }
  const enRetard = jours !== null || gravite !== null || alertes.some((a) => a.code === "RECEPTION_DEPASSEE");
  const evalue = regles.includes("CALENDAIRE") || regles.includes("PHYSIQUE") || regles.includes("RECEPTION");
  return {
    etat: enRetard ? "EN_RETARD" : evalue ? "A_JOUR" : "NON_EVALUABLE",
    regles, joursRetardCalendaire: jours, ecartPhysiquePoints: ecart, gravite, alertes, avertissements,
  };
}

// ================================================================================================ constats de coherence

function bornesAvancement(m: MarcheEntree, liens: readonly LienEntree[]): string[] {
  const hors: string[] = [];
  const bad = (v: number) => !Number.isFinite(v) || v < 0 || v > 100;
  for (const a of m.avancements) {
    const champs: [string, number][] = [["physique prévu", a.physiquePrevu], ["physique déclaré", a.physiqueReel], ["financier prévu", a.financierPrevu], ["financier déclaré", a.financierReel]];
    for (const [nom, v] of champs) if (bad(v)) hors.push(`Avancement ${nom} de ${v} % hors de 0 à 100 (période du ${jourIso(a.periode)}).`);
  }
  for (const l of liens) if (bad(l.chantier.avancementPct)) hors.push(`Chantier « ${l.chantier.intitule} » : avancement déclaré de ${l.chantier.avancementPct} % hors de 0 à 100.`);
  return hors;
}

function datesIncoherentes(m: MarcheEntree, liens: readonly LienEntree[]): string[] {
  const out: string[] = [];
  const avant = (a: Date | null, b: Date | null) => a !== null && b !== null && a.getTime() > b.getTime();
  if (avant(m.dateDebutPrevue, m.dateFinPrevue)) out.push("La date de fin prévue précède la date de début prévue.");
  if (avant(m.dateSignature, m.dateFinPrevue)) out.push("La date de signature est postérieure à la date de fin prévue.");
  if (avant(m.dateDebutPrevue, m.dateReceptionProvisoire) ) out.push("La réception provisoire précède le début prévu.");
  for (const l of liens) {
    const c = l.chantier;
    if (avant(c.dateDebutPrevue, c.dateFinPrevue)) out.push(`Chantier « ${c.intitule} » : fin prévue avant le début prévu.`);
    if (avant(c.dateDebutReelle, c.dateFinReelle)) out.push(`Chantier « ${c.intitule} » : fin réelle avant le début réel.`);
  }
  for (const d of m.decomptes) {
    if (avant(d.dateEmission, d.datePaiement)) out.push(`Décompte n° ${d.numero} : paiement antérieur à l'émission.`);
  }
  return out;
}

interface ConstatsCalcules { constats: Constat[]; nonVerifiables: CodeControle[] }

function calculerConstats(m: MarcheEntree, liensVisibles: readonly LienEntree[], qualites: Map<string, QualiteLien>): ConstatsCalcules {
  const constats: Constat[] = [];
  const nonVerifiables: CodeControle[] = [];
  const actifs = liensVisibles.filter((l) => !l.chantier.archive);

  if (chantierActifs(m).length === 0) {
    const arch = m.liens.length;
    constats.push({ code: "MARCHE_SANS_CHANTIER", detail: arch > 0 ? `Aucun chantier actif lié (${arch} chantier(s) archivé(s) lié(s)).` : "Aucun chantier lié." });
  }
  for (const l of actifs) {
    const q = qualites.get(l.chantier.id) ?? qualiteLienTroncon(l);
    if (q === "MANQUANT") constats.push({ code: "CHANTIER_SANS_TRONCON", chantierId: l.chantier.id, detail: `Chantier « ${l.chantier.intitule} » sans tronçon (ni sur le lien, ni sur le chantier, ou tronçon archivé).` });
    if (q === "AMBIGU") constats.push({ code: "ASSOCIATION_AMBIGUE", chantierId: l.chantier.id, detail: `Chantier « ${l.chantier.intitule} » : le tronçon du lien (${l.troncon?.code ?? l.tronconId}) diffère de celui du chantier (${l.chantier.troncon?.code ?? l.chantier.tronconId}).` });
    if (l.chantier.nbMarches > 1) constats.push({ code: "ASSOCIATION_AMBIGUE", chantierId: l.chantier.id, detail: `Chantier « ${l.chantier.intitule} » rattaché à plusieurs marchés.` });
  }

  // Bailleur : texte libre du chantier contre la fiche du marche. Un sigle et son developpe sont signales a tort.
  if (m.bailleurNom) {
    const nom = normaliser(m.bailleurNom);
    for (const l of actifs) {
      const b = l.chantier.bailleur?.trim();
      if (b && normaliser(b) !== nom) constats.push({ code: "BAILLEUR_INCOHERENT", chantierId: l.chantier.id, detail: `Bailleur du marché « ${m.bailleurNom} » ; bailleur saisi sur le chantier « ${l.chantier.intitule} » : « ${b} ».` });
    }
  } else if (actifs.some((l) => (l.chantier.bailleur ?? "").trim() !== "")) {
    nonVerifiables.push("BAILLEUR_INCOHERENT");
  }

  // Decomptes contre montant du marche : comparables seulement en GNF.
  const vivants = m.decomptes.filter((d) => d.statut !== "REJETE");
  if (vivants.length > 0) {
    if (m.montantTotal === null || m.devise !== "GNF") {
      nonVerifiables.push("DECOMPTE_SUPERIEUR_MARCHE");
    } else {
      for (const d of vivants) if (d.montantGnf > m.montantTotal) constats.push({ code: "DECOMPTE_SUPERIEUR_MARCHE", detail: `Le décompte n° ${d.numero} (${d.statut}) dépasse à lui seul le montant contractuel.` });
      const cumul = vivants.reduce((s, d) => s + d.montantGnf, BigInt(0));
      if (cumul > m.montantTotal) constats.push({ code: "DECOMPTE_SUPERIEUR_MARCHE", detail: "Le cumul des décomptes non rejetés dépasse le montant contractuel (les avenants ne sont pas modélisés ; les retenues de garantie peuvent compter deux fois)." });
    }
  }

  for (const detail of datesIncoherentes(m, actifs)) constats.push({ code: "DATES_INCOHERENTES", detail });
  for (const detail of bornesAvancement(m, actifs)) constats.push({ code: "AVANCEMENT_HORS_BORNES", detail });

  const refs = new Set(actifs.map((l) => (l.chantier.numContrat ?? "").trim()).filter((x) => x !== "").map(normaliser));
  if (refs.size > 1) constats.push({ code: "REFERENCES_DIVERGENTES", detail: `${refs.size} numéros de contrat différents sur les chantiers de ce marché.` });
  return { constats, nonVerifiables };
}

// ================================================================================================ analyse d'un marche

export interface ContexteAnalyse {
  maintenant: Date;
  /** Faux : aucun montant n'est rendu (D-C1-1 ouverte : aujourd'hui vrai pour tout compte qui passe la garde du module `marches`). */
  droitFinancier: boolean;
  /** null : compte national. */
  perimetre: ReadonlySet<number> | null;
  regionsNonRenseignees: ReadonlySet<number>;
  /** Programmes retenus lies au marche (calcules par `rattacherProgrammes`). */
  programmes: { uniques: ProgrammeEntree[]; ambigus: number };
  /** Plafond de chantiers et de troncons listes (la fiche detaillee releve le plafond). */
  plafondListes: number;
}

export interface Analyse {
  vue: MarcheVue;
  constats: Constat[];
  nonVerifiables: CodeControle[];
  territoire: Territoire;
  /** Pour l'agregation : contribution brute, avant mise en chaine. */
  contribution: { contractuel: bigint | null; autreDevise: { devise: string; montant: bigint } | null; decaisse: bigint | null; previsionnel: bigint | null; masque: boolean };
}

function chantierVisible(l: LienEntree, perimetre: ReadonlySet<number> | null): boolean {
  if (perimetre === null) return true;
  if (perimetre.has(l.chantier.regionId)) return true;
  for (const t of [l.troncon, l.chantier.troncon]) if (t && !t.archive && perimetre.has(t.regionId)) return true;
  return false;
}

function raccourcir(t: TronconEntree | null): { id: string; code: string; nom: string } | null {
  return t ? { id: t.id, code: t.code, nom: t.nom } : null;
}

export function analyserMarche(m: MarcheEntree, ctx: ContexteAnalyse): Analyse {
  const territoire = territoireDuMarche(m, ctx.regionsNonRenseignees);
  const masqueTerritoire = montantsMasquesPourPerimetre(territoire, ctx.perimetre);
  const masque = !ctx.droitFinancier || masqueTerritoire;
  const motifMasque: "DROIT_FINANCIER" | "TERRITOIRE" = !ctx.droitFinancier ? "DROIT_FINANCIER" : "TERRITOIRE";

  const liensActifs = chantierActifs(m);
  const archivesIgnores = m.liens.length - liensActifs.length;
  const liensVisibles = liensActifs.filter((l) => chantierVisible(l, ctx.perimetre));
  const autresRegionsMasquees = liensVisibles.length < liensActifs.length;

  const qualitesParChantier = new Map<string, QualiteLien>();
  for (const l of liensActifs) qualitesParChantier.set(l.chantier.id, qualiteLienTroncon(l));
  const comptes: Record<QualiteLien, number> = { DIRECT: 0, PAR_CHANTIER: 0, MANQUANT: 0, AMBIGU: 0 };
  for (const l of liensVisibles) comptes[qualitesParChantier.get(l.chantier.id)!] += 1;
  const qualiteTroncons = pireQualite(liensVisibles.map((l) => qualitesParChantier.get(l.chantier.id)!));
  const partages = liensVisibles.some((l) => l.chantier.nbMarches > 1);
  const qualiteChantiers: QualiteLien = liensActifs.length === 0 ? "MANQUANT" : partages ? "AMBIGU" : "DIRECT";

  // troncons lies, dedoublonnes (le lien direct prime sur le chantier)
  const parId = new Map<string, TronconLieVue>();
  for (const l of liensVisibles) {
    for (const [t, via] of [[l.troncon, "LIEN"], [l.chantier.troncon, "CHANTIER"]] as const) {
      if (!t || t.archive) continue;
      if (ctx.perimetre !== null && !ctx.perimetre.has(t.regionId)) continue;
      const deja = parId.get(t.id);
      if (!deja || (deja.via === "CHANTIER" && via === "LIEN")) parId.set(t.id, { id: t.id, code: t.code, nom: t.nom, regionId: t.regionId, classe: t.classe, etat: t.etat, via, chantierId: l.chantier.id });
    }
  }
  const tronconsListe = [...parId.values()].sort((a, b) => a.code.localeCompare(b.code));
  const autresTronconsMasques = ctx.perimetre !== null && liensActifs.some((l) => [l.troncon, l.chantier.troncon].some((t) => t && !t.archive && !ctx.perimetre!.has(t.regionId)));

  const chantiersListe: ChantierLieVue[] = liensVisibles
    .slice().sort((a, b) => a.chantier.intitule.localeCompare(b.chantier.intitule))
    .map((l) => ({
      id: l.chantier.id, intitule: l.chantier.intitule, entreprise: l.chantier.entreprise, statut: l.chantier.statut, regionId: l.chantier.regionId,
      avancementDeclarePct: l.chantier.avancementPct, dateFinPrevue: jourIso(l.chantier.dateFinPrevue),
      bailleurTexte: l.chantier.bailleur, partageEntreMarches: l.chantier.nbMarches > 1,
      lienTroncon: { qualite: qualitesParChantier.get(l.chantier.id)!, troncon: raccourcir(l.troncon), tronconChantier: raccourcir(l.chantier.troncon) },
    }));

  // entreprise et reference : portees par les chantiers, pas par le marche
  const distincts = (valeurs: (string | null)[]): string[] => {
    const vus = new Map<string, string>();
    for (const v of valeurs) { const t = (v ?? "").trim(); if (t && !vus.has(normaliser(t))) vus.set(normaliser(t), t); }
    return [...vus.values()];
  };
  const entreprises = distincts(liensVisibles.map((l) => l.chantier.entreprise));
  const references = distincts(liensVisibles.map((l) => l.chantier.numContrat));
  const champ = (valeurs: string[], source: string, absent: string, plusieurs?: string): ChampSource<string[]> =>
    valeurs.length === 0
      ? { etat: "NON_DISPONIBLE", valeur: null, source, avertissement: absent }
      : { etat: valeurs.length > 1 && plusieurs ? "PARTIEL" : "DISPONIBLE", valeur: valeurs, source, avertissement: valeurs.length > 1 ? plusieurs ?? null : null };

  // ---- montants
  const contract = montantContractuel(m);
  const dec = montantDecaisse(m);
  let previsionnel: MontantVue;
  let previsionnelBrut: bigint | null = null;
  if (ctx.programmes.uniques.length > 0) {
    previsionnelBrut = ctx.programmes.uniques.reduce((s, p) => s + p.montantPrevuGnf, BigInt(0));
    previsionnel = {
      etat: "PARTIEL", valeurGnf: previsionnelBrut.toString(), motif: null, source: SRC.previsionnel,
      avertissement: "Lien INDIRECT : un troncon commun, sans cle de marche ni annee de marche. Intentions de programmation, ni engagement ni contrat.",
    };
  } else if (ctx.programmes.ambigus > 0) {
    previsionnel = montantNonDisponible(SRC.previsionnel, "LIEN_AMBIGU", `${ctx.programmes.ambigus} programme(s) retenu(s) partagent un tronçon avec plusieurs marchés : le rattachement est ambigu, aucun montant n'est imputé.`);
  } else {
    previsionnel = montantNonDisponible(SRC.previsionnel, "AUCUN_LIEN", "Aucun programme budgétaire retenu n'est lié à ce marché par un tronçon commun.");
  }
  const montants = masque
    ? { contractuel: montantMasque(SRC.contractuel, motifMasque), engage: montantMasque(SRC.engage, motifMasque), decaisse: montantMasque(SRC.decaisse, motifMasque), previsionnel: montantMasque(SRC.previsionnel, motifMasque) }
    : { contractuel: contract, engage: montantEngage(), decaisse: dec.vue, previsionnel };

  // ---- avancement
  const dern = m.avancements[0];
  const avancement: MarcheVue["avancement"] = {
    declare: dern
      ? { etat: "DISPONIBLE", physiqueReelPct: dern.physiqueReel, physiquePrevuPct: dern.physiquePrevu, periode: jourIso(dern.periode), source: "avancement_marche.avancementPhysiqueReel (dernière période saisie)", avertissement: "Avancement saisi dans la copie gelée : déclaratif, non vérifié sur le terrain." }
      : { etat: "NON_DISPONIBLE", physiqueReelPct: null, physiquePrevuPct: null, periode: null, source: "avancement_marche", avertissement: "Aucune période d'avancement saisie : ce n'est pas un avancement nul." },
    constate: {
      etat: "NON_DISPONIBLE", valeurPct: null, motif: "AUCUNE_SOURCE_DE_CONSTAT", source: "aucune",
      avertissement: "Aucune source de constat distincte du déclaré n'existe (une inspection post-travaux n'est pas rattachée aux marchés) : le constaté n'est jamais recopié depuis le déclaré.",
    },
    financier: dern
      ? { etat: "DISPONIBLE", reelPct: dern.financierReel, prevuPct: dern.financierPrevu, periode: jourIso(dern.periode), source: "avancement_marche.avancementFinancierReel", avertissement: "Avancement financier déclaré : distinct de l'avancement physique, et du décaissé calculé sur les décomptes." }
      : { etat: "NON_DISPONIBLE", reelPct: null, prevuPct: null, periode: null, source: "avancement_marche", avertissement: "Aucune période d'avancement saisie." },
  };

  const { constats, nonVerifiables } = calculerConstats(m, liensVisibles, qualitesParChantier);
  const anomalies = [...new Set(constats.map((c) => c.code))];

  const avertissements: string[] = [MESSAGE_DONNEES_PARTIELLES];
  if (archivesIgnores > 0) avertissements.push(`${archivesIgnores} chantier(s) archivé(s) lié(s), ignoré(s).`);
  if (entreprises.length > 1) avertissements.push("Plusieurs entreprises sur les chantiers de ce marché (groupement, sous-traitance ou saisie incohérente : non tranché).");
  if (m.devise !== "GNF") avertissements.push(`Marché en ${m.devise} : les totaux en GNF ne l'incluent pas.`);
  if (territoire.regions.size === 0) avertissements.push("Territoire du marché impossible à établir (aucun chantier ni tronçon localisé) : visible des seuls comptes nationaux.");

  const vue: MarcheVue = {
    id: m.id,
    intitule: m.intitule,
    reference: champ(references, "chantiers.numContrat des chantiers liés (la table marches ne porte pas de référence)", "Aucune référence de marché : la table `marches` n'en porte pas et aucun chantier lié ne porte de numéro de contrat.", "Plusieurs numéros de contrat sur les chantiers liés : référence ambiguë."),
    lots: { etat: "NON_DISPONIBLE", valeur: null, source: "aucun champ lot dans la copie gelée", avertissement: "Les lots ne sont pas modélisés : un chantier lié n'est pas un lot." },
    entreprises: champ(entreprises, "chantiers.entreprise des chantiers liés (la table marches ne porte pas l'entreprise)", "Aucune entreprise : aucun chantier visible n'est lié à ce marché."),
    bailleur: { id: m.bailleurId, nom: m.bailleurNom, type: m.bailleurType, source: "marches.bailleurId (référentiel des bailleurs)" },
    dates: { signature: jourIso(m.dateSignature), debutPrevu: jourIso(m.dateDebutPrevue), finPrevue: jourIso(m.dateFinPrevue), receptionProvisoire: jourIso(m.dateReceptionProvisoire), garantieBonneExecution: jourIso(m.garantieBonneExecutionExp) },
    delais: {
      dureePrevueJours: m.dateDebutPrevue && m.dateFinPrevue && m.dateFinPrevue >= m.dateDebutPrevue ? joursEntre(m.dateDebutPrevue, m.dateFinPrevue) : null,
      avenants: { etat: "NON_DISPONIBLE", valeur: null, source: "aucune table d'avenants", avertissement: "Les avenants ne sont pas modélisés : délais et montants sont ceux du marché initial." },
      suspensions: { etat: "NON_DISPONIBLE", valeur: null, source: "aucun historique de suspension", avertissement: "Seul le statut saisi (SUSPENDU) existe : ni dates ni durée de suspension." },
    },
    statut: { code: m.statut, libelle: libelleStatutMarche(m.statut), source: "marches.statut, tel que saisi (non rapproché de DigitalRoad)", usageRetard: STATUTS_OUVERTS.has(m.statut) ? "OUVERT" : "CLOS" },
    devise: m.devise,
    montants,
    decomptes: {
      total: m.decomptes.length,
      parStatut: { EMIS: m.decomptes.filter((d) => d.statut === "EMIS").length, PAYE: dec.payes.length, REJETE: m.decomptes.filter((d) => d.statut === "REJETE").length },
      payes: masque ? [] : dec.payes.map((d) => ({ numero: d.numero, type: d.type, datePaiement: jourIso(d.datePaiement) })),
    },
    programmes: {
      retenusLies: masque ? [] : ctx.programmes.uniques.map((p) => ({ id: p.id, annee: p.annee, intitule: p.intitule, montantPrevuGnf: p.montantPrevuGnf.toString() })),
      ambigus: masque ? 0 : ctx.programmes.ambigus,
    },
    avancement,
    retard: evaluerRetard(m, ctx.maintenant),
    pieces: { etat: "NON_DISPONIBLE", liens: [], raison: "Aucune pièce ni lien source n'est rattaché aux marchés dans la copie gelée (les documents ne portent qu'un tronçon)." },
    liens: {
      chantiers: { qualite: qualiteChantiers, total: liensVisibles.length, archivesIgnores, tronque: chantiersListe.length > ctx.plafondListes, autresRegionsMasquees, liste: chantiersListe.slice(0, ctx.plafondListes) },
      troncons: { qualite: qualiteTroncons, comptes, total: tronconsListe.length, tronque: tronconsListe.length > ctx.plafondListes, autresRegionsMasquees: autresRegionsMasquees || autresTronconsMasques, liste: tronconsListe.slice(0, ctx.plafondListes) },
    },
    territoire: { etabli: territoire.regions.size > 0, regionIds: [...territoire.regions].filter((r) => ctx.perimetre === null || ctx.perimetre.has(r)).sort((a, b) => a - b), multiRegions: territoire.regions.size > 1, incertain: territoire.incertain, montantsMasques: masque },
    anomalies,
    avertissements,
    miseAJourLe: new Date(Math.max(m.updatedAt.getTime(), ...m.decomptes.map((d) => d.updatedAt.getTime()), ...m.avancements.map((a) => a.createdAt.getTime()))).toISOString(),
  };

  return {
    vue, constats, nonVerifiables, territoire,
    contribution: {
      contractuel: !masque && contract.etat === "DISPONIBLE" ? m.montantTotal : null,
      autreDevise: !masque && m.devise !== "GNF" && m.montantTotal !== null ? { devise: m.devise, montant: m.montantTotal } : null,
      decaisse: !masque && m.decomptes.length > 0 ? dec.payes.reduce((s, d) => s + d.montantGnf, BigInt(0)) : null,
      previsionnel: !masque ? previsionnelBrut : null,
      masque,
    },
  };
}

// ================================================================================================ programmes

/**
 * Programmes budgetaires RETENUS rattaches a un marche : un programme est lie a un marche quand son troncon figure parmi
 * ceux du marche (lien ou chantier). Si ce troncon figure dans plusieurs marches, le programme est AMBIGU : il n'est
 * impute a aucun, et chaque marche concerne le sait. `marchesParTroncon` couvre TOUS les marches non supprimes, pas
 * seulement ceux du perimetre : l'ambiguite ne depend pas de qui regarde.
 */
export function rattacherProgrammes(
  tronconsDuMarche: ReadonlySet<string>, programmes: readonly ProgrammeEntree[],
  marchesParTroncon: ReadonlyMap<string, ReadonlySet<string>>,
): { uniques: ProgrammeEntree[]; ambigus: number } {
  const uniques: ProgrammeEntree[] = [];
  let ambigus = 0;
  for (const p of programmes) {
    if (p.statut !== "RETENU" || !p.tronconId || !tronconsDuMarche.has(p.tronconId)) continue;
    const marches = marchesParTroncon.get(p.tronconId);
    if (!marches || marches.size <= 1) uniques.push(p);
    else ambigus += 1;
  }
  return { uniques, ambigus };
}

export function tronconsDuMarche(m: MarcheEntree): Set<string> {
  const s = new Set<string>();
  for (const l of chantierActifs(m)) {
    if (l.tronconId && l.troncon && !l.troncon.archive) s.add(l.tronconId);
    if (l.chantier.tronconId && l.chantier.troncon && !l.chantier.troncon.archive) s.add(l.chantier.tronconId);
  }
  return s;
}

// ================================================================================================ filtres

export interface FiltresContractuel {
  regionId?: number; classe?: string[]; etat?: string[]; statutChantier?: string[]; statutMarche?: StatutMarche[];
  bailleurId?: number; depuis?: string; jusqua?: string;
}

/**
 * Un marche correspond aux filtres quand CHAQUE filtre actif est satisfait. Les filtres de chantier et de troncon
 * (statutChantier, classe, etat) se lisent « au moins un chantier ou troncon lie ». La periode (depuis, jusqua) se lit
 * « la periode contractuelle [debut prevu ou signature, fin prevue] chevauche la fenetre » ; un marche sans aucune date
 * est EXCLU quand une fenetre est demandee (on ne le range pas dans une periode a laquelle rien ne le rattache).
 */
export function correspondAuxFiltres(m: MarcheEntree, t: Territoire, f: FiltresContractuel): boolean {
  if (f.statutMarche?.length && !f.statutMarche.includes(m.statut)) return false;
  if (f.bailleurId !== undefined && m.bailleurId !== f.bailleurId) return false;
  if (f.regionId !== undefined && !t.regions.has(f.regionId)) return false;
  const actifs = chantierActifs(m);
  if (f.statutChantier?.length && !actifs.some((l) => f.statutChantier!.includes(l.chantier.statut))) return false;
  const troncons = actifs.flatMap((l) => [l.troncon, l.chantier.troncon]).filter((x): x is TronconEntree => x !== null && !x.archive);
  if (f.classe?.length && !troncons.some((x) => f.classe!.includes(x.classe))) return false;
  if (f.etat?.length && !troncons.some((x) => f.etat!.includes(x.etat))) return false;
  if (f.depuis || f.jusqua) {
    const debut = m.dateDebutPrevue ?? m.dateSignature ?? m.dateFinPrevue;
    const fin = m.dateFinPrevue ?? m.dateDebutPrevue ?? m.dateSignature;
    if (!debut || !fin) return false;
    if (f.jusqua && jourIso(debut)! > f.jusqua) return false;
    if (f.depuis && jourIso(fin)! < f.depuis) return false;
  }
  return true;
}

// ================================================================================================ controles de coherence

export interface ControleVue {
  code: CodeControle;
  libelle: string;
  definition: string;
  unite: "marches" | "chantiers";
  nombre: number;
  /** Population examinee, meme unite : sans elle, un compte ne se juge pas. */
  surTotal: number;
  /** Marches ou la verification n'a pas pu se faire (donnee manquante) : ni conformes ni en anomalie. */
  nonVerifiables: number;
  exemples: { type: "marche" | "chantier"; id: string; marcheId: string | null; intitule: string; detail: string }[];
  statutDefinition: "PROVISOIRE";
}

const DEFINITIONS_CONTROLES: Record<CodeControle, { libelle: string; definition: string; unite: "marches" | "chantiers" }> = {
  MARCHE_SANS_CHANTIER: { libelle: "Marché sans chantier lié", definition: "Marché recensé dont aucun chantier non archivé n'est rattaché dans `marches_chantiers`.", unite: "marches" },
  CHANTIER_SANS_TRONCON: { libelle: "Chantier lié sans tronçon", definition: "Chantier rattaché à un marché dont ni le lien, ni le chantier ne désigne un tronçon non archivé.", unite: "chantiers" },
  ASSOCIATION_AMBIGUE: { libelle: "Association ambiguë marché, chantier, tronçon", definition: "Tronçon du lien différent du tronçon du chantier, ou chantier rattaché à plusieurs marchés.", unite: "marches" },
  BAILLEUR_INCOHERENT: { libelle: "Bailleur incohérent entre marché et chantier", definition: "Bailleur de la fiche du marché différent (après normalisation de la casse, des accents et des espaces) du texte libre saisi sur un chantier lié. Un sigle et son développé sont signalés à tort.", unite: "marches" },
  DECOMPTE_SUPERIEUR_MARCHE: { libelle: "Décomptes supérieurs au montant du marché", definition: "Un décompte non rejeté, ou le cumul des décomptes non rejetés, dépasse le montant contractuel d'un marché en GNF. Les avenants ne sont pas modélisés.", unite: "marches" },
  DATES_INCOHERENTES: { libelle: "Dates incohérentes", definition: "Fin avant début (marché ou chantier), signature après la fin, réception avant le début, paiement avant l'émission d'un décompte.", unite: "marches" },
  AVANCEMENT_HORS_BORNES: { libelle: "Avancement hors de 0 à 100 %", definition: "Avancement physique ou financier d'une période, ou avancement déclaré d'un chantier, inférieur à 0 ou supérieur à 100.", unite: "marches" },
  CHANTIER_SANS_MARCHE: { libelle: "Chantier sans marché", definition: "Chantier non archivé qu'aucun marché non supprimé ne rattache.", unite: "chantiers" },
  REFERENCES_DIVERGENTES: { libelle: "Références de contrat divergentes", definition: "Plusieurs numéros de contrat différents sur les chantiers d'un même marché.", unite: "marches" },
};

export const ORDRE_CONTROLES: readonly CodeControle[] = [
  "MARCHE_SANS_CHANTIER", "CHANTIER_SANS_MARCHE", "CHANTIER_SANS_TRONCON", "ASSOCIATION_AMBIGUE", "BAILLEUR_INCOHERENT",
  "DECOMPTE_SUPERIEUR_MARCHE", "DATES_INCOHERENTES", "AVANCEMENT_HORS_BORNES", "REFERENCES_DIVERGENTES",
];

export interface ChantiersSansMarche { nombre: number; surTotal: number; exemples: { id: string; intitule: string }[] }

/**
 * Compte chaque controle sur les marches analyses (donc sur le perimetre et les filtres du compte), avec des exemples
 * bornes. Les controles a zero sont CONSERVES : « zero anomalie » est une information, a condition de dire sur quoi.
 */
export function agregerControles(analyses: readonly Analyse[], chantiersSansMarche: ChantiersSansMarche | null): ControleVue[] {
  const sortie: ControleVue[] = [];
  for (const code of ORDRE_CONTROLES) {
    const def = DEFINITIONS_CONTROLES[code];
    if (code === "CHANTIER_SANS_MARCHE") {
      sortie.push({
        code, ...def, nombre: chantiersSansMarche?.nombre ?? 0, surTotal: chantiersSansMarche?.surTotal ?? 0,
        nonVerifiables: 0, statutDefinition: "PROVISOIRE",
        exemples: (chantiersSansMarche?.exemples ?? []).slice(0, PLAFOND_EXEMPLES).map((e) => ({ type: "chantier" as const, id: e.id, marcheId: null, intitule: e.intitule, detail: "Aucun marché ne rattache ce chantier." })),
      });
      continue;
    }
    let nombre = 0;
    let nonVerifiables = 0;
    const exemples: ControleVue["exemples"] = [];
    const chantiersVus = new Set<string>();
    for (const a of analyses) {
      const siens = a.constats.filter((c) => c.code === code);
      if (a.nonVerifiables.includes(code)) nonVerifiables += 1;
      if (siens.length === 0) continue;
      if (def.unite === "chantiers") {
        for (const c of siens) {
          if (c.chantierId && chantiersVus.has(c.chantierId)) continue;
          if (c.chantierId) chantiersVus.add(c.chantierId);
          nombre += 1;
          if (exemples.length < PLAFOND_EXEMPLES) exemples.push({ type: "chantier", id: c.chantierId ?? a.vue.id, marcheId: a.vue.id, intitule: a.vue.intitule, detail: c.detail });
        }
      } else {
        nombre += 1;
        if (exemples.length < PLAFOND_EXEMPLES) exemples.push({ type: "marche", id: a.vue.id, marcheId: a.vue.id, intitule: a.vue.intitule, detail: siens.map((c) => c.detail).slice(0, 3).join(" ") });
      }
    }
    const surTotal = def.unite === "marches"
      ? analyses.length
      : new Set(analyses.flatMap((a) => a.vue.liens.chantiers.liste.map((c) => c.id))).size;
    sortie.push({ code, ...def, nombre, surTotal, nonVerifiables, exemples, statutDefinition: "PROVISOIRE" });
  }
  return sortie;
}

// ================================================================================================ synthese

export interface TotalBailleur {
  bailleurId: number | null;
  /** null : marches sans bailleur renseigne, regroupes sous « Bailleur non renseigne » par l'affichage. */
  nom: string | null;
  nombreMarches: number;
  contractuel: MontantVue;
  autresDevises: { devise: string; montant: string; nombre: number }[];
  sansMontant: number;
  masques: number;
}

export interface SyntheseVue {
  marchesRecenses: { nombre: number; libelle: string; definition: string; source: string };
  parStatut: Record<StatutMarche, number>;
  retard: { enRetard: number; aJour: number; nonEvaluables: number; termines: number; regle: string; statutDefinition: "PROVISOIRE" };
  financier: { contractuel: MontantVue; engage: MontantVue; decaisse: MontantVue; previsionnel: MontantVue };
  totauxParBailleur: TotalBailleur[];
}

function agregat(
  analyses: readonly Analyse[], choisir: (a: Analyse) => bigint | null, source: string, droitFinancier: boolean, avertissementBase: string,
): MontantVue {
  if (!droitFinancier) return montantMasque(source, "DROIT_FINANCIER");
  if (analyses.length === 0) return montantNonDisponible(source, "AUCUN_MARCHE", "Aucun marché dans ce périmètre.");
  let somme = BigInt(0);
  let pris = 0;
  for (const a of analyses) { const v = choisir(a); if (v !== null) { somme += v; pris += 1; } }
  if (pris === 0) {
    return { ...montantNonDisponible(source, "MONTANT_ABSENT", `${avertissementBase} Aucun des ${analyses.length} marché(s) du périmètre n'a de valeur exploitable.`), couverture: { pris: 0, total: analyses.length } };
  }
  const exclus = analyses.length - pris;
  return {
    etat: exclus === 0 ? "DISPONIBLE" : "PARTIEL", valeurGnf: somme.toString(), motif: null, source,
    avertissement: exclus === 0 ? avertissementBase : `${avertissementBase} Total partiel : ${exclus} marché(s) sur ${analyses.length} exclu(s) (montant absent, devise étrangère, aucun décompte ou montant masqué), non comptés comme nuls.`,
    couverture: { pris, total: analyses.length },
  };
}

export function synthetiser(analyses: readonly Analyse[], droitFinancier: boolean): SyntheseVue {
  const parStatut: Record<StatutMarche, number> = { PLANIFIE: 0, EN_COURS: 0, SUSPENDU: 0, TERMINE: 0, SOLDE: 0 };
  const retard = { enRetard: 0, aJour: 0, nonEvaluables: 0, termines: 0 };
  for (const a of analyses) {
    parStatut[a.vue.statut.code] += 1;
    const e = a.vue.retard.etat;
    if (e === "EN_RETARD") retard.enRetard += 1; else if (e === "A_JOUR") retard.aJour += 1; else if (e === "TERMINE") retard.termines += 1; else retard.nonEvaluables += 1;
  }

  const groupes = new Map<string, { id: number | null; nom: string | null; analyses: Analyse[] }>();
  for (const a of analyses) {
    const cle = a.vue.bailleur.id === null ? "aucun" : String(a.vue.bailleur.id);
    const g = groupes.get(cle) ?? { id: a.vue.bailleur.id, nom: a.vue.bailleur.nom, analyses: [] };
    g.analyses.push(a);
    groupes.set(cle, g);
  }
  const totauxParBailleur: TotalBailleur[] = [...groupes.values()].map((g) => {
    const autres = new Map<string, { montant: bigint; nombre: number }>();
    for (const a of g.analyses) if (a.contribution.autreDevise) {
      const x = autres.get(a.contribution.autreDevise.devise) ?? { montant: BigInt(0), nombre: 0 };
      x.montant += a.contribution.autreDevise.montant; x.nombre += 1; autres.set(a.contribution.autreDevise.devise, x);
    }
    return {
      bailleurId: g.id, nom: g.nom, nombreMarches: g.analyses.length,
      contractuel: agregat(g.analyses, (a) => a.contribution.contractuel, SRC.contractuel, droitFinancier, "Somme des montants contractuels en GNF de ce bailleur (étiquetée contractuel : ni engagé, ni décaissé)."),
      autresDevises: droitFinancier ? [...autres.entries()].map(([devise, x]) => ({ devise, montant: x.montant.toString(), nombre: x.nombre })) : [],
      sansMontant: g.analyses.filter((a) => a.vue.montants.contractuel.motif === "MONTANT_ABSENT").length,
      masques: g.analyses.filter((a) => a.contribution.masque).length,
    };
  }).sort((a, b) => (a.nom === null ? 1 : b.nom === null ? -1 : a.nom.localeCompare(b.nom)));

  return {
    marchesRecenses: {
      nombre: analyses.length, libelle: "Marchés recensés",
      definition: "Nombre de lignes de `marches` non supprimées dans le périmètre et les filtres. Ce n'est pas un nombre de marchés actifs : aucune règle de statut n'est validée, et ce n'est pas un nombre de chantiers.",
      source: "marches (copie gelée)",
    },
    parStatut,
    retard: { ...retard, regle: REGLE_RETARD, statutDefinition: "PROVISOIRE" },
    financier: {
      contractuel: agregat(analyses, (a) => a.contribution.contractuel, SRC.contractuel, droitFinancier, "Somme des montants contractuels en GNF."),
      engage: droitFinancier ? montantEngage() : montantMasque(SRC.engage, "DROIT_FINANCIER"),
      decaisse: agregat(analyses, (a) => a.contribution.decaisse, SRC.decaisse, droitFinancier, "Somme des décomptes dont le statut saisi est PAYE."),
      previsionnel: agregat(analyses, (a) => a.contribution.previsionnel, SRC.previsionnel, droitFinancier, "Somme des programmes retenus liés sans ambiguïté, comptés une fois."),
    },
    totauxParBailleur,
  };
}

// ================================================================================================ fraicheur et donnees partielles

export interface FraicheurVue {
  calculeLe: string;
  derniereMiseAJour: string | null;
  ageJours: number | null;
  perime: boolean;
  seuilPeremptionJours: number;
  statutSeuil: "PROVISOIRE";
  gelee: true;
  derniereSynchronisation: null;
}

export function evaluerFraicheur(analyses: readonly Analyse[], maintenant: Date): FraicheurVue {
  const dates = analyses.map((a) => new Date(a.vue.miseAJourLe).getTime());
  const max = dates.length ? Math.max(...dates) : null;
  const age = max === null ? null : Math.max(0, joursEntre(new Date(max), maintenant));
  return {
    calculeLe: maintenant.toISOString(),
    derniereMiseAJour: max === null ? null : new Date(max).toISOString(),
    ageJours: age,
    perime: age !== null && age > SEUILS_PROVISOIRES.peremptionJours,
    seuilPeremptionJours: SEUILS_PROVISOIRES.peremptionJours,
    statutSeuil: "PROVISOIRE", gelee: true, derniereSynchronisation: null,
  };
}

export interface DonneesPartielles { partiel: true; message: string; raisons: string[] }

/** La source externe n'etant pas integree, les donnees sont TOUJOURS partielles ; les raisons mesurees s'y ajoutent. */
export function raisonsPartielles(analyses: readonly Analyse[], options: { tronque: boolean; plafond: number }): DonneesPartielles {
  const n = (f: (a: Analyse) => boolean) => analyses.filter(f).length;
  const raisons = [
    "DigitalRoad, source de vérité des marchés, décomptes et paiements, n'est pas intégré (B-11) : la copie locale est gelée (ADR-003), sans date de synchronisation.",
    "Le montant engagé, les avenants, les suspensions, les lots et les pièces n'existent pas dans la copie.",
    "L'avancement constaté n'a aucune source distincte de l'avancement déclaré.",
  ];
  const push = (k: number, texte: string) => { if (k > 0) raisons.push(`${k} marché(s) ${texte}`); };
  push(n((a) => a.vue.montants.contractuel.motif === "MONTANT_ABSENT"), "sans montant contractuel saisi.");
  push(n((a) => a.vue.montants.contractuel.motif === "DEVISE_NON_GNF"), "en devise étrangère, exclus des totaux en GNF.");
  push(n((a) => a.vue.liens.chantiers.qualite === "MANQUANT"), "sans chantier lié.");
  push(n((a) => !a.territoire.regions.size), "dont le territoire est impossible à établir.");
  push(n((a) => a.contribution.masque && a.vue.montants.contractuel.motif === "TERRITOIRE"), "dont les montants sont masqués (territoire plus large que votre périmètre).");
  push(n((a) => a.vue.retard.regles.length === 0 && a.vue.retard.etat === "NON_EVALUABLE"), "dont le retard n'est pas évaluable (ni date de fin prévue, ni avancement).");
  if (options.tronque) raisons.push(`Plus de ${options.plafond} marchés : les agrégats portent sur les ${options.plafond} plus récents.`);
  return { partiel: true, message: MESSAGE_DONNEES_PARTIELLES, raisons };
}

// ================================================================================================ definitions publiees

export const DEFINITIONS_CONTRACTUEL: readonly { code: string; libelle: string; definition: string; statutDefinition: "PROVISOIRE" }[] = [
  { code: "marches_recenses", libelle: "Marchés recensés", definition: "Lignes de `marches` non supprimées. Jamais « actifs » : aucune règle de statut n'est validée.", statutDefinition: "PROVISOIRE" },
  { code: "contractuel", libelle: "Contractuel", definition: "Montant total du marché saisi (`marches.montantTotal`), dans sa devise, avenants non modélisés. Ni engagé, ni décaissé.", statutDefinition: "PROVISOIRE" },
  { code: "engage", libelle: "Engagé", definition: "Non disponible : aucune source financière n'est validée (B-08, ADR-003). Jamais déduit d'un autre montant.", statutDefinition: "PROVISOIRE" },
  { code: "decaisse", libelle: "Décaissé", definition: "Somme des décomptes dont le statut saisi est PAYE, tous types confondus, en GNF. Non rapproché des paiements de DigitalRoad.", statutDefinition: "PROVISOIRE" },
  { code: "previsionnel", libelle: "Prévisionnel", definition: "Programmes budgétaires retenus (statut RETENU) liés au marché par un tronçon commun, à condition que ce tronçon n'appartienne qu'à ce marché. Lien indirect : indicatif.", statutDefinition: "PROVISOIRE" },
  { code: "avancement_declare", libelle: "Avancement déclaré", definition: "Dernière période de `avancement_marche` (physique réel) et `chantiers.avancementPct` : saisis, non vérifiés.", statutDefinition: "PROVISOIRE" },
  { code: "avancement_constate", libelle: "Avancement constaté", definition: "Non disponible : aucune source de constat distincte du déclaré.", statutDefinition: "PROVISOIRE" },
  { code: "retard", libelle: "Retard", definition: REGLE_RETARD, statutDefinition: "PROVISOIRE" },
  { code: "qualite_lien", libelle: "Qualité du lien", definition: "DIRECT : tronçon porté par le lien marché-chantier. PAR_CHANTIER : tronçon porté par le seul chantier. MANQUANT : aucun tronçon. AMBIGU : deux tronçons différents, ou chantier rattaché à plusieurs marchés. La qualité d'un marché est la plus faible de ses liens.", statutDefinition: "PROVISOIRE" },
  { code: "perimetre_territorial", libelle: "Périmètre territorial", definition: "Un marché n'a pas de région : elle se déduit de ses chantiers et tronçons. Un compte régional ne voit que les marchés dont une région est dans son périmètre, sans montant si le marché déborde de ce périmètre ; un marché sans territoire établi n'est visible que d'un compte national.", statutDefinition: "PROVISOIRE" },
];

// ================================================================================================ region non renseignee

/** Identifiants des entrees de `regions` qui tiennent lieu d'absence de region. */
export function regionsNonRenseignees(regions: readonly { id: number; nom: string }[]): Set<number> {
  const cible = normaliser(REGION_NON_RENSEIGNEE);
  return new Set(regions.filter((r) => normaliser(r.nom) === cible).map((r) => r.id));
}
