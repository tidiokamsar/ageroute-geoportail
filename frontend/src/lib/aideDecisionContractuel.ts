/**
 * Aide a la decision, suivi contractuel (AD-LOT-5) : types de `GET /api/v2/aide-decision/contractuel` et phrases que l'ecran doit dire.
 * Module PUR (ni DOM, ni reseau, ni horloge).
 *
 * QUATRE REGLES DE PRESENTATION, ET CHACUNE EVITE UN MENSONGE
 *
 * **Un montant GNF reste une CHAINE.** Il depasse 2^53 sur le registre complet : le convertir en nombre fausserait les derniers
 * chiffres sans le dire. `formaterGnf` groupe les chiffres de la chaine, sans jamais passer par `Number`.
 *
 * **Une grandeur indisponible dit POURQUOI, jamais 0.** `valeurGnf` vaut null hors DISPONIBLE et PARTIEL ; l'ecran affiche
 * « Non disponible » et la raison (`motif`). Un zero n'apparait que si le serveur l'a envoye.
 *
 * **Contractuel, engage, decaisse, previsionnel : quatre libelles, jamais fusionnes.** L'ecran ne calcule aucun montant : il
 * affiche ceux du serveur, chacun avec sa source.
 *
 * **« Recenses » et jamais « actifs ».** Aucune regle de statut de marche n'est validee.
 */

import type { FiltresDecision } from "../components/decision/types";

// ---------------------------------------------------------------- types du contrat

export type EtatDonnee = "DISPONIBLE" | "NON_DISPONIBLE" | "PARTIEL" | "PERIME" | "DEFINITION_NON_VALIDEE";
export type QualiteLien = "DIRECT" | "PAR_CHANTIER" | "MANQUANT" | "AMBIGU";
export type StatutMarche = "PLANIFIE" | "EN_COURS" | "SUSPENDU" | "TERMINE" | "SOLDE";
export const STATUTS_MARCHE: readonly StatutMarche[] = ["PLANIFIE", "EN_COURS", "SUSPENDU", "TERMINE", "SOLDE"];

export type MotifMontant =
  | "SOURCE_NON_VALIDEE" | "DROIT_FINANCIER" | "TERRITOIRE" | "MONTANT_ABSENT" | "DEVISE_NON_GNF"
  | "AUCUN_DECOMPTE" | "AUCUN_LIEN" | "LIEN_AMBIGU" | "AUCUN_MARCHE";

export interface MontantVue {
  etat: EtatDonnee;
  valeurGnf: string | null;
  motif: MotifMontant | null;
  source: string;
  avertissement: string | null;
  valeurOrigine?: { montant: string; devise: string };
  couverture?: { pris: number; total: number };
}

export interface ChampSource<T> {
  etat: "DISPONIBLE" | "NON_DISPONIBLE" | "PARTIEL";
  valeur: T | null;
  source: string;
  avertissement: string | null;
}

export interface Alerte { code: string; gravite: "haute" | "moyenne" | "info"; message: string }

export interface RetardVue {
  etat: "EN_RETARD" | "A_JOUR" | "NON_EVALUABLE" | "TERMINE";
  regles: ("CALENDAIRE" | "PHYSIQUE" | "RECEPTION")[];
  joursRetardCalendaire: number | null;
  ecartPhysiquePoints: number | null;
  gravite: "haute" | "moyenne" | null;
  alertes: Alerte[];
  avertissements: string[];
}

export interface TronconLieVue {
  id: string; code: string; nom: string; regionId: number; classe: string; etat: string; via: "LIEN" | "CHANTIER"; chantierId: string;
}

export interface ChantierLieVue {
  id: string; intitule: string; entreprise: string; statut: string; regionId: number; avancementDeclarePct: number;
  dateFinPrevue: string | null; bailleurTexte: string | null; partageEntreMarches: boolean;
  lienTroncon: { qualite: QualiteLien; troncon: { id: string; code: string; nom: string } | null; tronconChantier: { id: string; code: string; nom: string } | null };
}

export type CodeControle =
  | "MARCHE_SANS_CHANTIER" | "CHANTIER_SANS_TRONCON" | "ASSOCIATION_AMBIGUE" | "BAILLEUR_INCOHERENT"
  | "DECOMPTE_SUPERIEUR_MARCHE" | "DATES_INCOHERENTES" | "AVANCEMENT_HORS_BORNES" | "CHANTIER_SANS_MARCHE" | "REFERENCES_DIVERGENTES";

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
  devise: "GNF" | "USD" | "EUR";
  montants: { contractuel: MontantVue; engage: MontantVue; decaisse: MontantVue; previsionnel: MontantVue };
  decomptes: { total: number; parStatut: { EMIS: number; PAYE: number; REJETE: number }; payes: { numero: number; type: string; datePaiement: string | null }[] };
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

export interface TotalBailleur {
  bailleurId: number | null; nom: string | null; nombreMarches: number; contractuel: MontantVue;
  autresDevises: { devise: string; montant: string; nombre: number }[]; sansMontant: number; masques: number;
}

export interface SyntheseVue {
  marchesRecenses: { nombre: number; libelle: string; definition: string; source: string };
  parStatut: Record<StatutMarche, number>;
  retard: { enRetard: number; aJour: number; nonEvaluables: number; termines: number; regle: string; statutDefinition: "PROVISOIRE" };
  financier: { contractuel: MontantVue; engage: MontantVue; decaisse: MontantVue; previsionnel: MontantVue };
  totauxParBailleur: TotalBailleur[];
}

export interface ControleVue {
  code: CodeControle; libelle: string; definition: string; unite: "marches" | "chantiers"; nombre: number; surTotal: number; nonVerifiables: number;
  exemples: { type: "marche" | "chantier"; id: string; marcheId: string | null; intitule: string; detail: string }[];
  statutDefinition: "PROVISOIRE";
}

export interface FraicheurVue {
  calculeLe: string; derniereMiseAJour: string | null; ageJours: number | null; perime: boolean; seuilPeremptionJours: number;
  statutSeuil: "PROVISOIRE"; gelee: true; derniereSynchronisation: null;
}

export interface DonneesPartielles { partiel: true; message: string; raisons: string[] }

export interface SourceContractuelle {
  code: string; libelle: string; sourceDeVerite: string; integree: boolean; copieGelee: boolean; derniereSynchronisation: string | null; references: string[];
}

export interface DefinitionContractuelle { code: string; libelle: string; definition: string; statutDefinition: "PROVISOIRE" }

export interface ReponseContractuel {
  genereLe: string;
  source: SourceContractuelle;
  droitFinancier: boolean;
  perimetre: { national: boolean; regionIds: number[] | null; libelle: string; totalNationalFourni: boolean; filtres: Record<string, unknown>; exclusParFiltre?: { sansDate: number } };
  donneesPartielles: DonneesPartielles;
  fraicheur: FraicheurVue;
  plafond: { marchesAnalyses: number; plafond: number; tronque: boolean };
  synthese: SyntheseVue;
  controles: ControleVue[];
  marches: MarcheVue[];
  page: { limite: number; total: number; curseurSuivant: string | null };
  definitions: DefinitionContractuelle[];
}

export interface DecompteVue {
  numero: number; type: string; statut: string; montantGnf: string | null; dateEmission: string | null; datePaiement: string | null; compteDansDecaisse: boolean;
}

export interface ReponseMarche {
  genereLe: string; source: SourceContractuelle; droitFinancier: boolean; donneesPartielles: DonneesPartielles;
  marche: MarcheVue; decomptes: { liste: DecompteVue[]; tronque: boolean }; definitions: DefinitionContractuelle[];
}

// ---------------------------------------------------------------- libelles stricts

/** Libelles que l'ecran emploie, figes ici pour qu'un test les garde (« recenses » et jamais « actifs »). */
export const LIBELLES = {
  recenses: "Marchés recensés",
  contractuel: "Contractuel",
  engage: "Engagé",
  decaisse: "Décaissé",
  previsionnel: "Prévisionnel",
  declare: "Avancement déclaré",
  constate: "Avancement constaté",
  financier: "Avancement financier déclaré",
} as const;

export const BANDEAU_PARTIEL = "Données contractuelles partielles : source de vérité externe non intégrée (DigitalRoad)";

const LIBELLE_STATUT: Record<StatutMarche, string> = { PLANIFIE: "Planifié", EN_COURS: "En cours", SUSPENDU: "Suspendu", TERMINE: "Terminé", SOLDE: "Soldé" };
export function libelleStatutMarche(s: StatutMarche): string { return LIBELLE_STATUT[s]; }

const LIBELLE_MOTIF: Record<MotifMontant, string> = {
  SOURCE_NON_VALIDEE: "source financière non validée",
  DROIT_FINANCIER: "droit financier requis",
  TERRITOIRE: "marché plus large que votre périmètre",
  MONTANT_ABSENT: "aucun montant saisi",
  DEVISE_NON_GNF: "devise étrangère, non convertie",
  AUCUN_DECOMPTE: "aucun décompte saisi",
  AUCUN_LIEN: "aucun lien établi",
  LIEN_AMBIGU: "lien ambigu",
  AUCUN_MARCHE: "aucun marché dans ce périmètre",
};
export function libelleMotif(m: MotifMontant | null): string { return m ? LIBELLE_MOTIF[m] : "non disponible"; }

const LIBELLE_LIEN: Record<QualiteLien, string> = { DIRECT: "Direct", PAR_CHANTIER: "Par le chantier", MANQUANT: "Manquant", AMBIGU: "Ambigu" };
export function libelleQualiteLien(q: QualiteLien): string { return LIBELLE_LIEN[q]; }

export const AIDE_QUALITE_LIEN: Record<QualiteLien, string> = {
  DIRECT: "Le tronçon est porté par le lien marché-chantier.",
  PAR_CHANTIER: "Le tronçon n'est porté que par le chantier.",
  MANQUANT: "Aucun tronçon (ou aucun chantier) n'est relié : relation manquante.",
  AMBIGU: "Deux tronçons différents, ou un chantier rattaché à plusieurs marchés : relation ambiguë.",
};

const LIBELLE_RETARD: Record<RetardVue["etat"], string> = { EN_RETARD: "En retard", A_JOUR: "Pas de retard détecté", NON_EVALUABLE: "Retard non évaluable", TERMINE: "Terminé (non évalué)" };
export function libelleRetard(e: RetardVue["etat"]): string { return LIBELLE_RETARD[e]; }

const LIBELLE_CODE_CONTROLE: Record<CodeControle, string> = {
  MARCHE_SANS_CHANTIER: "Marché sans chantier lié", CHANTIER_SANS_TRONCON: "Chantier lié sans tronçon", ASSOCIATION_AMBIGUE: "Association ambiguë",
  BAILLEUR_INCOHERENT: "Bailleur incohérent", DECOMPTE_SUPERIEUR_MARCHE: "Décomptes supérieurs au marché", DATES_INCOHERENTES: "Dates incohérentes",
  AVANCEMENT_HORS_BORNES: "Avancement hors de 0 à 100 %", CHANTIER_SANS_MARCHE: "Chantier sans marché", REFERENCES_DIVERGENTES: "Références divergentes",
};
export function libelleCodeControle(c: CodeControle): string { return LIBELLE_CODE_CONTROLE[c]; }

// ---------------------------------------------------------------- formatage

/** Groupe les chiffres d'une chaine entiere par trois (espace fine insecable), sans passer par `Number`. */
export function formaterGnf(chaine: string): string {
  if (!/^-?\d+$/.test(chaine)) return chaine;
  const negatif = chaine.startsWith("-");
  const chiffres = negatif ? chaine.slice(1) : chaine;
  return `${negatif ? "-" : ""}${chiffres.replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f")}\u00a0GNF`;
}

export function formaterMontantOrigine(o: { montant: string; devise: string }): string {
  return `${formaterGnf(o.montant).replace(/\u00a0GNF$/, "")}\u00a0${o.devise}`;
}

export function formaterPourcent(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n.toLocaleString("fr-FR", { maximumFractionDigits: 1 })}\u00a0%`;
}

/** AAAA-MM-JJ vers « 26 oct. 2026 », en UTC (une date de marche n'a pas d'heure ni de fuseau). */
export function formaterDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00.000Z` : iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

export function formaterDateHeure(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
}

/** Texte d'un montant : la valeur, ou « Non disponible » (la raison est dite a part, par `libelleMotif`). */
export function texteMontant(m: MontantVue): string {
  if (m.valeurGnf !== null) return formaterGnf(m.valeurGnf);
  return "Non disponible";
}

// ---------------------------------------------------------------- requete

export interface ParametresContractuel {
  statutMarche?: StatutMarche[];
  limite?: number;
  curseur?: string | null;
}

/**
 * Filtres du module vers parametres de requete du serveur : listes separees par des virgules (le serveur accepte aussi les
 * parametres repetes). A remplacer par `serialiserFiltres` du noyau du shell (lot 1) a l'integration : meme sortie attendue.
 * Une cle absente n'est pas envoyee ; une liste vide non plus.
 */
export function parametresContractuel(filtres: FiltresDecision, extras: ParametresContractuel = {}): Record<string, string> {
  const p: Record<string, string> = {};
  if (filtres.regionId !== undefined) p.regionId = String(filtres.regionId);
  if (filtres.classe?.length) p.classe = filtres.classe.join(",");
  if (filtres.etat?.length) p.etat = filtres.etat.join(",");
  if (filtres.statutChantier?.length) p.statutChantier = filtres.statutChantier.join(",");
  if (extras.statutMarche?.length) p.statutMarche = extras.statutMarche.join(",");
  if (filtres.depuis) p.depuis = filtres.depuis;
  if (filtres.jusqua) p.jusqua = filtres.jusqua;
  if (extras.limite !== undefined) p.limite = String(extras.limite);
  if (extras.curseur) p.curseur = extras.curseur;
  return p;
}

// ---------------------------------------------------------------- erreurs

export type GenreErreur = "permission" | "session" | "introuvable" | "entree" | "limite" | "indisponible" | "reseau" | "serveur";
export interface ErreurContractuel { genre: GenreErreur; status: number | null; code: string | null; message: string }

const MESSAGES_PAR_GENRE: Record<GenreErreur, string> = {
  permission: "Votre rôle, vos modules ou votre périmètre territorial ne permettent pas de voir le suivi contractuel.",
  session: "Votre session a expiré. Reconnectez-vous.",
  introuvable: "Marché introuvable ou hors de votre périmètre.",
  entree: "La demande est invalide.",
  limite: "Trop de demandes. Réessayez dans un instant.",
  indisponible: "Le serveur est momentanément indisponible.",
  reseau: "Le serveur ne répond pas. Vérifiez votre connexion.",
  serveur: "Erreur du serveur.",
};

/** Classe une erreur axios en genre stable : un refus de droit (403) n'est ni une panne ni un vide. */
export function classerErreur(e: unknown): ErreurContractuel {
  const r = (e as { response?: { status?: number; data?: { error?: unknown; code?: unknown } } } | null | undefined)?.response;
  const status = typeof r?.status === "number" ? r.status : null;
  const code = typeof r?.data?.code === "string" ? r.data.code : null;
  const msg = typeof r?.data?.error === "string" && r.data.error.trim() ? r.data.error : null;
  let genre: GenreErreur;
  if (status === null) genre = "reseau";
  else if (status === 401) genre = "session";
  else if (status === 403) genre = "permission";
  else if (status === 404) genre = "introuvable";
  else if (status === 429) genre = "limite";
  else if (status === 503) genre = "indisponible";
  else if (status >= 400 && status < 500) genre = "entree";
  else genre = "serveur";
  return { genre, status, code, message: genre === "permission" ? MESSAGES_PAR_GENRE.permission : msg ?? MESSAGES_PAR_GENRE[genre] };
}

/** Un refus d'autorisation ne se retente pas : la rejouer ne change rien. */
export function estErreurAutorisation(e: unknown): boolean {
  const g = classerErreur(e).genre;
  return g === "permission" || g === "session";
}

// ---------------------------------------------------------------- lecture de la reponse

/** Marches en retard selon la regle serveur, parmi ceux dont le retard est evaluable : denominateur dit, jamais cache. */
export function phraseRetard(r: SyntheseVue["retard"]): string {
  const evalues = r.enRetard + r.aJour;
  if (evalues === 0) return "Aucun marché dont le retard soit évaluable";
  return `${r.enRetard} en retard sur ${evalues} évalués (${r.nonEvaluables} non évaluables, ${r.termines} terminés non évalués)`;
}

/** Vrai quand AU MOINS un montant du marche est masque ou indisponible faute de droit : l'ecran n'affiche alors aucune valeur. */
export function montantsMasques(m: MarcheVue): boolean { return m.territoire.montantsMasques; }

/** Le panneau d'un marche absent de la liste (changement de filtre) doit se fermer. */
export function marchePresent(marches: readonly MarcheVue[], id: string | null): boolean {
  return id !== null && marches.some((m) => m.id === id);
}
