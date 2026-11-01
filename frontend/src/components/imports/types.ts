/**
 * Types du module « Lots d'import » (contrat : docs/imports/CONTRAT-API-LOTS-IMPORT.md).
 *
 * Règle de fond : le serveur décide du statut, des étapes et des actions permises ; le client les affiche. Aucun type
 * ici ne permet d'exprimer « validé » ou « autorisé » à partir d'un geste de l'utilisateur.
 */

export type StatutLot = "RECU" | "VALIDE_SCHEMA" | "IMPORTE_TEST" | "IMPORTE" | "REJETE";

export type FormatLot = "csv" | "geojson";

export type IdEtape = "reception" | "controle_schema" | "echantillon" | "import_autorise";

export type EtatEtape =
  | "TERMINEE"
  | "TERMINEE_AVEC_RESERVES"
  | "ECHEC"
  | "EN_COURS"
  | "NON_DISPONIBLE"
  | "NON_COMMENCEE";

export interface Etape {
  id: IdEtape;
  titre: string;
  etat: EtatEtape;
  /** Pourquoi l'étape est dans cet état (affiché, jamais deviné par le client). */
  raison: string;
}

export interface Personne { id: string; nomComplet: string }

export interface LotListe {
  id: string;
  reference: string;
  systemeSource: string;
  format: string;
  nomFichier: string;
  /** Chaîne : le serveur sérialise un BigInt. Ne jamais la passer à Number sans garde. */
  tailleOctets: string;
  statut: StatutLot;
  importeLe: string;
  importePar: Personne | null;
  versionMapping: string;
  autorisationRef: string;
  lignesLues: number;
  lignesValidees: number;
  lignesImportees: number;
  lignesRejetees: number;
  lignesEnConflit: number;
  lignesIgnorees: number;
  motifRejetLot: string | null;
}

export interface ReponseListe { lots: LotListe[]; suivant: string | null; total: number }

export interface PremierRejet { numeroLigne: number; statut: string; motif: string | null }

export interface ControleLot {
  motifRejetLot: string | null;
  compteurs: { lues: number; validees: number; rejetees: number; enConflit: number; ignorees: number; importees: number };
  premiersRejets: PremierRejet[];
  /** `null` : non calculable pour ce lot (jamais une liste vide pour dire « inconnu »). */
  colonnes: { reconnues: string[]; inconnues: string[] } | null;
  avertissements: string[];
}

export type CodeAction = "TELECHARGER_ERREURS" | "VOIR_APERCU";

export interface ActionPermise { code: CodeAction; permise: boolean; raison: string | null }

export interface EvenementHistorique { date: string; action: string; acteur: string | null; details: string | null }

export interface LotDetail extends Omit<LotListe, "motifRejetLot"> {
  methodeSource: string;
  auteurSource: string | null;
  dateSource: string | null;
  empreinte: { algorithme: "sha256"; valeur: string };
  controle: ControleLot;
  etapes: Etape[];
  actionsPermises: ActionPermise[];
  historique: EvenementHistorique[];
}

export type StatutLigne = "VALIDEE" | "IMPORTEE" | "REJETEE" | "EN_CONFLIT" | "IGNOREE";

export interface LigneApercu {
  numeroLigne: number;
  statut: StatutLigne;
  motifRejet: string | null;
  identifiantSource: string | null;
  /** Valeurs en texte, tronquées par le serveur : à afficher échappées (React le fait), jamais en HTML. */
  charge: Record<string, string>;
}

export interface ReponseApercu { lignes: LigneApercu[]; suivant: number | null; tronque: boolean }

export interface FormatPropose { code: FormatLot; libelle: string; aide: string }

export interface MetaImport {
  formats: FormatPropose[];
  tailleMaxOctets: number;
  limiteLignes: number;
  statuts: string[];
}

export interface SourceConnue { valeur: string; nombreLots: number }

export interface AvertissementMetadonnees { champ: string; recu: string; conserve: string }

export interface ReceptionReponse {
  id: string;
  reference: string;
  statut: StatutLot;
  dejaRecu: boolean;
  motifRejetLot: string | null;
  compteurs: { lues: number; validees: number; rejetees: number; ignorees: number };
  avertissements?: string[];
  metadonneesDifferentes?: AvertissementMetadonnees[];
  memeEmpreinteAutresSources?: { reference: string; systemeSource: string }[];
}

/** Filtres de la liste, portés par l'URL pour survivre à la sélection d'un lot. */
export interface FiltresLots { statut: StatutLot | ""; source: string; q: string }
