import { grouperChiffres } from "./tableauDeBord";

/**
 * Moteur de risque et de programmation (paragraphe 7.7, A22) : types de l'API v2 et phrases que l'ecran doit dire.
 *
 * QUATRE REGLES DE PRESENTATION, ET CHACUNE EVITE UN MENSONGE
 *
 * **« PROVISOIRE, non approuvé » reste visible** tant que les parametres du moteur ne sont pas approuves : ni les
 * ponderations du risque, ni la correspondance etat vers risque, ni les seuils n'ont de source. L'etiquette vient du
 * serveur (jamais redigee ici) et elle est reprise sur chaque resultat.
 *
 * **Un resultat vide s'explique.** Quand tous les troncons sont ecartes (seul l'etat est renseigne aujourd'hui), l'ecran
 * dit le motif, le nombre de facteurs disponibles, le minimum et ce qui manque : jamais une liste vide muette.
 *
 * **Un montant en GNF reste une chaine de chiffres** : il depasse 2^53 sur un reseau reel.
 *
 * **Aucune enveloppe n'est inventee** : l'utilisateur saisit chaque montant, le plan ne repartit rien.
 */

// ----------------------------------------------------------------------------- types de l'API

export type Decision = "RETENUE" | "ECARTEE";
export type CodeExclusion = "RISQUE_NON_CALCULABLE" | "SOUS_SEUIL_RISQUE" | "AUCUN_TRAITEMENT" | "COUT_NON_ESTIMABLE" | "BUDGET_INSUFFISANT" | "PLAFOND_REGIONAL";

export interface FacteurTrace {
  facteur: string; poids: number; disponible: boolean; valeur: number | null; brut: number | string | null; origine: string | null; note: string;
}

export type RisqueLigne =
  | { ok: true; score: number; couverture: number; facteursDisponibles: number; facteursPonderes: number; formule: string; facteurs: FacteurTrace[] }
  | { ok: false; code: string; motif: string; facteurs: FacteurTrace[] };

export type TraitementLigne =
  | { ok: true; traitement: { code: string; libelle: string; famille: string; version: number | null; approuve: boolean }; condition: { portee: string; classeTrafic: string | null }; attributsNonRenseignes: string[] }
  | { ok: false; code: string; motif: string };

export type CoutLigne =
  | {
      ok: true; montantGnf: string; devise: string; classePrecision: string; margePct: number | null; provisoire: boolean; hypothesesManquantes: string[];
      bareme: { id: number | string; code: string | null; typeIntervention: string; coutKmGnf: string; anneeReference: number | null; largeurChausseeM: number | null; approuve: boolean };
      calcul: string;
    }
  | { ok: false; code: string; motif: string };

export type ProjectionLigne =
  | { ok: true; etatCourant: string; etatSuivant: string | null; pAnnuelle: number; horizonAnnees: number; pHorizon: number; matrice: { familleRevetement: string; classeTrafic: string; version: number | null; approuvee: boolean } }
  | { ok: false; motif: string };

export interface LigneScenario {
  troncon: { id: string; code: string; nom: string | null; regionId: number | null; classe: string | null; revetement: string | null; etat: string | null; longueurM: number | null; longueurOrigine: string | null };
  decision: Decision;
  rangPriorite: number | null;
  rangRetenu: number | null;
  motifExclusion: { code: CodeExclusion; detail: string } | null;
  risque: RisqueLigne;
  projection: ProjectionLigne | null;
  risqueAttendu: { score: number; scoreMicro: number; formule: string } | null;
  traitement: TraitementLigne | null;
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
  motifsProvisoire: string[];
  limites: string[];
  avertissement: string;
  totaux: {
    candidats: number; eligibles: number; retenues: number; ecartees: number; engageGnf: string; resteGnf: string;
    ecartesParMotif: Record<string, number>; engageParRegionGnf: Record<string, string>;
  };
  lignes: LigneScenario[];
}

export interface ResumeScenario {
  id: string; annee: number; intitule: string; parametresVersion: string; parametresId: string; budgetGnf: string;
  perimetre: { regionId?: number | null; classe?: string | null } | null; nbRetenues: number; nbEcartees: number; montantEngageGnf: string;
  provisoire: boolean; etiquette: string; empreinteEntrees: string; empreinteResultat: string; creeParId: string; creeLe: string;
}

export interface ReponseScenario { scenario: ResumeScenario; resultat: Scenario }

export interface ParametresVersion {
  id: string; version: string; source: string; valeurs: { facteursMinimum?: number } & Record<string, unknown>; motif: string | null;
  provisoire: boolean; etiquette: string; approuveeLe: string | null;
}

export interface RapportRejeu { identique: boolean; empreinteStockee: string; empreinteRecalculee: string; entreesIntegres: boolean; explication: string }

export interface AnneePpe { annee: number; enveloppeGnf: string; candidatsEntrants: number; dejaRetenusAvant: number; scenario: Scenario }

export interface PlanPluriannuel {
  methode: { id: string; version: string };
  anneeDebut: number; nbAnnees: number;
  parametres: { version: string; source: string; approuveeLe: string | null; etiquette: string };
  provisoire: boolean; etiquette: string; motifsProvisoire: string[]; limites: string[]; avertissement: string;
  synthese: {
    enveloppeTotaleGnf: string; engageTotalGnf: string; resteTotalGnf: string; candidats: number; retenus: number; nonRetenus: number;
    nonRetenusParMotif: Record<string, number>;
    parAnnee: { annee: number; enveloppeGnf: string; engageGnf: string; resteGnf: string; retenues: number; ecartees: number; candidatsEntrants: number }[];
    tronconsRetenus: { tronconId: string; code: string; regionId: number | null; anneeRetenue: number; rangRetenu: number; montantGnf: string; traitement: string }[];
  };
  annees: AnneePpe[];
}

export interface ResumePlan {
  id: string; intitule: string; anneeDebut: number; nbAnnees: number; anneeFin: number; parametresVersion: string; parametresId: string;
  enveloppeTotaleGnf: string; montantEngageGnf: string; nbRetenus: number; nbNonRetenus: number; provisoire: boolean; etiquette: string;
  empreinteEntrees: string; empreinteResultat: string; creeParId: string; creeLe: string;
}

export interface ReponsePlan { plan: ResumePlan; resultat: PlanPluriannuel }

export interface FicheCourante {
  id: string; reference: string; scenarioId: string; tronconId: string; tronconCode: string | null; annee: number; parametresVersion: string;
  empreinteSha256: string; figeLe: string; figeParId: string; statut: string; rangStatut: number; statutDepuis: string;
}

export interface StatutHistorique { rang: number; de: string | null; vers: string; origine: string; motif: string | null; auteurId: string | null; enregistreLe: string }

export interface FicheComplete {
  fiche: FicheCourante;
  contenu: { justification?: string; etiquette?: string; provisoire?: boolean; cout?: { montantGnf?: string }; traitement?: { traitement?: { code?: string } }; patrimoine?: { code?: string; nom?: string | null } } & Record<string, unknown>;
  historique: StatutHistorique[];
}

export interface VerificationFiche {
  id: string; reference: string; empreinteStockee: string; verdict: { ok: true } | { ok: false; code: string; motif: string };
}

export interface StatutPraticabilite { branchee: boolean; valeursDeclarees: number; valeursApprouvees: number; libelle: string; motif: string; effet: string }
export interface AlertePraticabilite { tronconId: string; code: string; niveau: string; libelle: string; franchissable: boolean; saisonniere: boolean; debutM: number; finM: number }
export interface ReponsePraticabilite { statut: StatutPraticabilite; alertes: AlertePraticabilite[] }

export interface ReponseFigeage { fiches: { id: string; reference: string; empreinteSha256: string; tronconId: string; code: string }[]; etiquette: string; provisoire: boolean }

// ----------------------------------------------------------------------------- libelles

export const LIBELLE_EXCLUSION: Record<string, string> = {
  RISQUE_NON_CALCULABLE: "Risque non calculable (facteurs manquants)",
  SOUS_SEUIL_RISQUE: "Sous le seuil de risque",
  AUCUN_TRAITEMENT: "Aucun traitement prévu",
  COUT_NON_ESTIMABLE: "Coût non estimable",
  BUDGET_INSUFFISANT: "Budget insuffisant",
  PLAFOND_REGIONAL: "Plafond régional atteint",
};

export const LIBELLE_FACTEUR: Record<string, string> = {
  ETAT: "État du tronçon", TRAFIC_IMPORTANCE: "Trafic ou importance", SECURITE: "Sécurité (points noirs)", CLIMAT: "Vulnérabilité climatique", POPULATION: "Population desservie",
};

export const LIBELLE_STATUT_FICHE: Record<string, string> = {
  BROUILLON: "Brouillon", PROPOSE: "Proposée", ARBITRE: "Arbitrée", APPROUVE: "Approuvée", TRANSMIS: "Transmise", EN_EXECUTION: "En exécution", ACHEVE: "Achevée", EVALUE: "Évaluée",
};

export const LIBELLE_ORIGINE: Record<string, string> = {
  GEOPORTAIL: "Géoportail", DIGITALROAD: "DigitalRoad", INSPECTION_POST_TRAVAUX: "Inspection post-travaux",
};

// ----------------------------------------------------------------------------- saisie et affichage des montants

/** Espaces d'une saisie : blancs usuels, espace fine insecable (typographie francaise) et espace insecable. */
const ESPACES = new RegExp(`[\\s${String.fromCharCode(0x202f, 0xa0)}]`, "g");

/** Chiffres d'une saisie « 5 000 000 000 » ; `null` si ce n'est pas un entier de 1 a 18 chiffres. Aucune conversion en nombre. */
export function chiffresGnf(saisie: string): string | null {
  const s = saisie.replace(ESPACES, "");
  if (!/^\d{1,18}$/.test(s)) return null;
  return s.replace(/^0+(?=\d)/, "");
}

const FINE = String.fromCharCode(0x202f);

/** « 5 000 000 000 GNF » depuis une chaine de chiffres ; une valeur absente se dit, elle n'est pas un zero. */
export function formaterGnf(chiffres: string | null | undefined): string {
  if (chiffres === null || chiffres === undefined || chiffres === "") return "non renseigné";
  return `${grouperChiffres(chiffres)}${FINE}GNF`;
}

/** Commentaire de l'enveloppe en milliards pour la lecture, sans conversion en nombre flottant. */
export function enMilliards(chiffres: string): string {
  if (chiffres.length <= 9) return `${grouperChiffres(chiffres)}${FINE}GNF`;
  const entier = chiffres.slice(0, -9);
  const dec = chiffres.slice(-9, -7);
  return `${grouperChiffres(entier)}${dec !== "00" ? `,${dec}` : ""}${FINE}Md GNF`;
}

// ----------------------------------------------------------------------------- diagnostic d'un resultat sans retenue

export interface DiagnosticVide {
  /** Vrai si aucune ligne n'est retenue. */
  vide: boolean;
  candidats: number;
  parMotif: { code: string; libelle: string; nb: number }[];
  /** Presente quand au moins un troncon est ecarte faute de facteurs. */
  facteurs: null | {
    troncons: number;
    minimumRequis: number | null;
    disponiblesMin: number;
    disponiblesMax: number;
    ponderes: number;
    /** Nombre minimal de facteurs manquants par troncon pour atteindre le minimum requis (null si le minimum est inconnu). */
    manquantAuMoins: number | null;
    absents: { facteur: string; libelle: string; troncons: number; note: string }[];
  };
  phrase: string;
}

/**
 * Explique un resultat sans aucune ligne retenue. N'invente rien : les nombres viennent des lignes (facteurs
 * disponibles par troncon) et du minimum requis lu dans les parametres (ou, a defaut, dans la phrase du moteur).
 */
export function diagnostiquerSansRetenue(lignes: LigneScenario[], minimumRequis: number | null): DiagnosticVide {
  const retenues = lignes.filter((l) => l.decision === "RETENUE").length;
  const compte = new Map<string, number>();
  for (const l of lignes) if (l.motifExclusion) compte.set(l.motifExclusion.code, (compte.get(l.motifExclusion.code) ?? 0) + 1);
  const parMotif = [...compte.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([code, nb]) => ({ code, libelle: LIBELLE_EXCLUSION[code] ?? code, nb }));

  const insuffisantes = lignes.filter((l) => !l.risque.ok && l.risque.code === "FACTEURS_INSUFFISANTS");
  let facteurs: DiagnosticVide["facteurs"] = null;
  if (insuffisantes.length > 0) {
    const nbDispo = insuffisantes.map((l) => l.risque.facteurs.filter((f) => f.disponible && f.poids > 0).length);
    const ponderes = Math.max(...insuffisantes.map((l) => l.risque.facteurs.filter((f) => f.poids > 0).length));
    let min = minimumRequis;
    if (min === null) {
      const m = /minimum (\d+)/.exec((insuffisantes[0].risque as { motif: string }).motif);
      min = m ? Number(m[1]) : null;
    }
    const absents = new Map<string, { troncons: number; note: string }>();
    for (const l of insuffisantes) {
      for (const f of l.risque.facteurs) {
        if (f.poids > 0 && !f.disponible) {
          const e = absents.get(f.facteur) ?? { troncons: 0, note: f.note };
          e.troncons += 1;
          absents.set(f.facteur, e);
        }
      }
    }
    facteurs = {
      troncons: insuffisantes.length, minimumRequis: min, disponiblesMin: Math.min(...nbDispo), disponiblesMax: Math.max(...nbDispo), ponderes,
      manquantAuMoins: min === null ? null : Math.max(0, min - Math.max(...nbDispo)),
      absents: [...absents.entries()].sort((a, b) => b[1].troncons - a[1].troncons || (a[0] < b[0] ? -1 : 1))
        .map(([facteur, e]) => ({ facteur, libelle: LIBELLE_FACTEUR[facteur] ?? facteur, troncons: e.troncons, note: e.note })),
    };
  }

  let phrase: string;
  if (retenues > 0) phrase = "";
  else if (lignes.length === 0) phrase = "Aucun tronçon candidat dans ce périmètre : le réseau classé de référence ne contient aucun tronçon actif, validé et conforme au filtre choisi.";
  else {
    const principal = parMotif[0];
    phrase = `Aucun tronçon retenu : les ${lignes.length} tronçon(s) candidat(s) sont tous écartés. Motif principal : ${principal.libelle} (${principal.nb}).`;
    if (facteurs) {
      const dispo = facteurs.disponiblesMin === facteurs.disponiblesMax ? `${facteurs.disponiblesMax}` : `${facteurs.disponiblesMin} à ${facteurs.disponiblesMax}`;
      phrase += ` Faute de facteurs : ${facteurs.troncons} tronçon(s) disposent de ${dispo} facteur(s) sur ${facteurs.ponderes} pondérés`;
      phrase += facteurs.minimumRequis !== null ? `, le minimum requis est ${facteurs.minimumRequis}` : "";
      phrase += facteurs.manquantAuMoins !== null && facteurs.manquantAuMoins > 0 ? ` : il manque au moins ${facteurs.manquantAuMoins} facteur(s) par tronçon.` : ".";
    }
  }
  return { vide: retenues === 0, candidats: lignes.length, parMotif, facteurs, phrase };
}

// ----------------------------------------------------------------------------- fiches

/** Les raccourcis de la table sont de l'affichage ; l'empreinte complete reste lisible dans le detail. */
export function empreinteCourte(h: string): string {
  return h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-8)}` : h;
}
