export type Role = "ADMIN" | "GESTIONNAIRE" | "INSPECTEUR" | "LECTEUR";
export type EtatPatrimoine = "BON" | "MOYEN" | "MAUVAIS" | "CRITIQUE" | "NON_EVALUE";
/**
 * Ces deux types doivent suivre les enums Prisma.
 *
 * NON_CLASSEE et NON_RENSEIGNE ont ete ajoutes cote base les 03 et 04/09/2026 sans
 * l'etre ici. `Record<ClasseRoute, …>` restait donc satisfait, `tsc` passait — et la
 * page Troncons est tombee en production sur « Cannot read properties of undefined
 * (reading pill) » des qu'un troncon NON_CLASSEE est arrive.
 *
 * Le type n'est pas une formalite : c'est lui qui transforme cette panne en erreur de
 * compilation.
 */
export type ClasseRoute = "RN" | "RR" | "RU" | "PISTE" | "NON_CLASSEE";
export type Revetement = "BITUME" | "TERRE" | "LATERITE" | "PAVE" | "NON_RENSEIGNE";
export type TypeOuvrage =
  | "PONT" | "DALOT" | "BUSE" | "RADIER" | "PONCEAU" | "MUR_SOUTENEMENT" | "TUNNEL" | "PASSERELLE" | "VIADUC";
export type Gravite = "FAIBLE" | "MOYENNE" | "FORTE";
export type TypePoste = "PEAGE" | "PESAGE";
export type StatutPoste = "EN_SERVICE" | "HORS_SERVICE" | "EN_CONSTRUCTION";
export type StatutChantier = "PLANIFIE" | "EN_COURS" | "SUSPENDU" | "TERMINE";
export type DocumentType = "ARRETE" | "CAHIER_CHARGES" | "CAHIER_ENGAGEMENT" | "AUTRE";

export interface Region {
  id: number;
  nom: string;
}

export interface User {
  id: string;
  email: string;
  nomComplet: string;
  role: Role;
  actif: boolean;
  derniereConnexion?: string | null;
  totpEnabled?: boolean;
  modulesAutorises?: string[];
  createdAt: string;
}

export interface Troncon {
  id: string;
  code: string;
  nom: string;
  classe: ClasseRoute;
  regionId: number;
  region?: Region;
  longueurKm: number;
  revetement: Revetement;
  etat: EtatPatrimoine;
  pkDebut: number;
  pkFin: number;
  traficMoyenJma?: number | null;
}

export interface Ouvrage {
  id: string;
  nom: string;
  type: TypeOuvrage;
  etat: EtatPatrimoine;
  regionId: number;
  region?: Region;
  tronconId?: string | null;
  troncon?: { code: string; nom: string } | null;
  pk?: number | null;
  longueurM?: number | null;
  gabaritT?: number | null;
  anneeConstruction?: number | null;
  materiau?: string | null;
  ficheNumero?: string | null;
  code?: string | null;
  largeurM?: number | null;
  hauteurM?: number | null;
  nbTravees?: number | null;
  longueurTravee?: number | null;
  materiauAppuis?: string | null;
  materiauTablier?: string | null;
  materiauPiles?: string | null;
  materiauAutre?: string | null;
  remarques?: string | null;
  travauxAPrevoir?: string | null;
  derniereInspectionDate?: string | null;
  lat?: number | null;
  lon?: number | null;
  photos?: string[];
}

export interface PointNoir {
  id: string;
  description: string;
  regionId: number;
  region?: Region;
  tronconId?: string | null;
  troncon?: { code: string; nom: string } | null;
  pk?: number | null;
  gravite: Gravite;
  nbAccidents: number;
  causes?: string | null;
  mesuresCorrectives?: string | null;
  lat?: number | null;
  lon?: number | null;
}

export interface Poste {
  id: string;
  nom: string;
  type: TypePoste;
  regionId: number;
  region?: Region;
  tronconId?: string | null;
  troncon?: { code: string; nom: string } | null;
  pk?: number | null;
  statut: StatutPoste;
  traficJma?: number | null;
  recettesMensuellesGnf?: string | null;
  lat?: number | null;
  lon?: number | null;
}

export interface Chantier {
  id: string;
  intitule: string;
  entreprise: string;
  bailleur?: string | null;
  regionId: number;
  region?: Region;
  tronconId?: string | null;
  troncon?: Troncon | null;
  pkDebut?: number | null;
  pkFin?: number | null;
  statut: StatutChantier;
  avancementPct: number;
  dateDebutPrevue?: string | null;
  dateFinPrevue?: string | null;
  dateDebutReelle?: string | null;
  dateFinReelle?: string | null;
  montantGnf?: string | null;
  numContrat?: string | null;
  observations?: string | null;
}

export type DeviseMarche = "GNF" | "USD" | "EUR";
export type StatutMarche = "PLANIFIE" | "EN_COURS" | "SUSPENDU" | "TERMINE" | "SOLDE";

export interface Bailleur {
  id: number;
  nom: string;
  type: string;
  _count?: { marches: number };
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  from: string;
  hasPassword: boolean;
}

export interface MarcheChantierLink {
  marcheId: string;
  chantierId: string;
  tronconId?: string | null;
  chantier?: { id: string; intitule: string; statut: StatutChantier } | null;
  troncon?: { id: string; code: string; nom: string } | null;
}

export interface Marche {
  id: string;
  intitule: string;
  bailleurId?: number | null;
  bailleur?: Bailleur | null;
  montantTotal?: string | null;
  devise: DeviseMarche;
  dateSignature?: string | null;
  dateDebutPrevue?: string | null;
  dateFinPrevue?: string | null;
  dateReceptionProvisoire?: string | null;
  garantieBonneExecutionExp?: string | null;
  tauxPenaliteRetardPct?: number | null;
  statut: StatutMarche;
  chantiers?: MarcheChantierLink[];
  avancements?: AvancementMarche[];
  _count?: { avancements: number };
  montantDecaisse?: string;
  createdAt: string;
  updatedAt: string;
}

export type DecompteType = "AVANCE" | "DECOMPTE" | "RETENUE_GARANTIE" | "SOLDE";
export type DecompteStatut = "EMIS" | "PAYE" | "REJETE";

export interface Decompte {
  id: string;
  marcheId: string;
  numero: number;
  type: DecompteType;
  montantGnf: string;
  dateEmission?: string | null;
  datePaiement?: string | null;
  statut: DecompteStatut;
  observations?: string | null;
}

export interface DecaissementBailleur {
  bailleurId: number | null;
  bailleur: string;
  engage: string;
  decaisse: string;
  tauxDecaissementPct: number;
}

export interface AvancementMarche {
  id: number;
  marcheId: string;
  periode: string;
  avancementPhysiquePrevu: number;
  avancementPhysiqueReel: number;
  avancementFinancierPrevu: number;
  avancementFinancierReel: number;
}

export interface Inspection {
  id: string;
  tronconId?: string | null;
  troncon?: { code: string; nom: string } | null;
  ouvrageId?: string | null;
  ouvrage?: { nom: string; type: string } | null;
  inspecteurId: string;
  inspecteur?: { nomComplet: string };
  dateInspection: string;
  etatObserve: EtatPatrimoine;
  defautsConstates?: string | null;
  recommandations?: string | null;
  photos?: string[];
}

export interface Document {
  id: string;
  titre: string;
  type: DocumentType;
  annee?: number | null;
  tronconId?: string | null;
  troncon?: { code: string; nom: string } | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * Longueur du reseau, en distinguant ce qui est SAISI de ce qui est CALCULE.
 *
 * Le tableau de bord annoncait « 7 933 km — Reseau total ». C'etait la somme des
 * longueurs saisies : le champ n'est renseigne que sur les nationales et les urbaines,
 * et pas sur les 1 029 regionales. La geometrie de ces regionales represente
 * 13 296 km de plus. L'indicateur sous-estimait le reseau de 63 %.
 */
export interface LongueurReseau {
  metier: {
    totalKm: number;
    tronconsRenseignes: number;
    tronconsTotal: number;
    /** Longueurs portees mais CALCULEES sur la geometrie, jamais saisies. */
    tronconsDerives?: number;
    couverturePct: number;
  };
  geometrique: {
    totalKm: number;
    /** A citer dans l'interface : un chiffre calcule doit dire comment. */
    methode: string;
  };
  parClasse: {
    classe: string;
    troncons: number;
    tronconsAvecLongueurMetier: number;
    kmMetier: number;
    kmGeometrique: number;
  }[];
}

export interface DashboardKpis {
  /** Le RESEAU CLASSE seul : 261 386 troncons au registre, mais 1 691 classes. */
  tronconsCount: number;
  /** Troncons issus de la promotion de voirie. Comptes a part, jamais fondus. */
  voirieRattachee?: { troncons: number; ouvrages?: number };
  ouvragesCount: number;
  pointsNoirsCount: number;
  postesCount: number;
  documentsCount: number;
  chantiersEnCours: number;
  /** Longueur SAISIE uniquement. Ne pas presenter comme la longueur du reseau. */
  longueurTotaleKm: number;
  reseau: LongueurReseau;
  alertesCount: number;
  tronconsParEtat: { etat: EtatPatrimoine; total: number }[];
  ouvragesParEtat: { etat: EtatPatrimoine; total: number }[];
  chantiersParStatut: { statut: StatutChantier; total: number }[];
}

export interface ActivityEntry {
  id: string;
  action: string;
  entityType: string;
  auteur: string;
  createdAt: string;
}

export interface AlertesData {
  ouvragesCritiques: { id: string; code: string | null; nom: string; etat: EtatPatrimoine; region: string | null; troncon: string | null; derniereInspection: string | null }[];
  chantiersEnRetard: { id: string; intitule: string; dateFinPrevue: string | null; avancementPct: number; entreprise: string; region: string | null }[];
  tronconsCritiquesNonInspectes: { id: string; code: string; nom: string; etat: EtatPatrimoine; classe: string; longueurKm: number; region: string | null }[];
  tronconsJamaisInspectes: { id: string; code: string; nom: string; etat: EtatPatrimoine; classe: string; longueurKm: number; region: string | null }[];
}

export interface ProgrammationData {
  parAnnee: { annee: number; nb: number; montant: string; enCours: number; termine: number }[];
  parBailleur: { bailleur: string; nb: number; montant: string }[];
  total: { nb: number; montant: string };
}

export interface RapportRegionLigne {
  region: string;
  troncons: number;
  longueurKm: number;
  ouvrages: number;
  chantiersEnCours: number;
  kmBon: number;
  kmMoyen: number;
  kmMauvais: number;
  kmCritique: number;
  kmNonEvalue: number;
}

export type TypeInterventionOT =
  | "REPARATION_CHAUSSEE" | "CURAGE_ASSAINISSEMENT" | "SIGNALISATION"
  | "DEBROUSSAILLAGE" | "OUVRAGE_ART_MINEUR" | "URGENCE_SECURITE" | "AUTRE";
export type PrioriteOT = "URGENTE" | "HAUTE" | "NORMALE" | "BASSE";
export type StatutOT = "BROUILLON" | "ASSIGNE" | "EN_COURS" | "SUSPENDU" | "TERMINE" | "ANNULE" | "CONVERTI_CHANTIER";
export type TypePhotoOT = "AVANT" | "PENDANT" | "APRES";

export interface OtPhoto {
  id: string;
  fileName: string;
  type: TypePhotoOT;
  lat?: number | null;
  lon?: number | null;
  priseLe: string;
}

export interface OtHistoriqueLigne {
  id: number;
  action: string;
  ancienStatut?: StatutOT | null;
  nouveauStatut?: StatutOT | null;
  commentaire?: string | null;
  createdAt: string;
  user?: { nomComplet: string } | null;
}

export interface OrdreTravaux {
  id: string;
  numero: string;
  titre: string;
  description?: string | null;
  typeIntervention: TypeInterventionOT;
  priorite: PrioriteOT;
  statut: StatutOT;
  region?: { nom: string } | null;
  troncon?: { id: string; code: string; nom: string } | null;
  ouvrage?: { id: string; nom: string; type: string } | null;
  pointNoir?: { id: string; description: string } | null;
  signalement?: { id: string; numeroPublic: string; typeProbleme: string } | null;
  chantierId?: string | null;
  coutEstimeGnf?: string | null;
  coutReelGnf?: string | null;
  assigneA?: { id: string; nomComplet: string } | null;
  creePar?: { id: string; nomComplet: string } | null;
  entreprise?: string | null;
  dateEcheance?: string | null;
  dateDebutReel?: string | null;
  dateFinReelle?: string | null;
  photos?: OtPhoto[];
  historique?: OtHistoriqueLigne[];
  _count?: { photos: number };
  suggestionConversion?: boolean;
  createdAt: string;
}

export interface OtStats {
  ouverts: number;
  termines: number;
  delaiMoyenJours: number | null;
  deriveCoutMoyenPct: number | null;
  tauxPreuvePhotoPct: number | null;
  backlogParPriorite: { priorite: PrioriteOT; nb: number }[];
  backlogParRegion: { region: string; nb: number }[];
}
