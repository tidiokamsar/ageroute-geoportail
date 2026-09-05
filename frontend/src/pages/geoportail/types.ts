import type { EtatPatrimoine, StatutChantier } from "../../types";

/**
 * Attribution des DONNEES, distincte de celle du fond de plan.
 *
 * Les couches de voirie et de franchissements sont derivees d'OpenStreetMap, sous
 * licence ODbL, qui impose l'attribution. La mention du fond de plan ne suffit pas :
 * elle disparait quand on bascule sur le satellite, et elle ne couvre de toute facon
 * que les tuiles.
 *
 * Les libelles de navigation ne portent plus « OSM » — un utilisateur n'a pas a lire
 * un nom de source dans un menu — mais le credit reste, ici et sur la fiche de chaque
 * objet. Effacer l'origine d'une donnee la rendrait indefendable devant un auditeur,
 * et violerait la licence.
 */
export const CREDIT_DONNEES =
  'Données de voirie : &copy; les contributeurs '
  + '<a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> (ODbL)';


export interface TronconGeoFeature {
  id: string;
  code: string;
  nom: string;
  classe: string;
  etat: EtatPatrimoine;
  longueurKm: number;
  region: string | null;
  revetement?: string | null;
  pkDebut?: number | null;
  pkFin?: number | null;
  traficMoyenJma?: number | null;
  geometry: string; // GeoJSON (string brut renvoye par ST_AsGeoJSON)
}

export interface OuvrageGeoPoint {
  id: string;
  nom: string;
  type: string;
  etat: EtatPatrimoine;
  region: string | null;
  lat: number;
  lon: number;
  pk?: number | null;
  ficheNumero?: string | null;
  code?: string | null;
  tronconCode?: string | null;
  tronconNom?: string | null;
  longueurM?: number | null;
  largeurM?: number | null;
  hauteurM?: number | null;
  nbTravees?: number | null;
  longueurTravee?: number | null;
  materiauAppuis?: string | null;
  materiauTablier?: string | null;
  materiauPiles?: string | null;
  materiauAutre?: string | null;
  anneeConstruction?: number | null;
  gabaritT?: number | null;
  remarques?: string | null;
  travauxAPrevoir?: string | null;
  derniereInspectionDate?: string | null;
}

export interface PointNoirGeoPoint {
  id: string;
  description: string;
  gravite: string;
  region: string | null;
  lat: number;
  lon: number;
}

export interface PosteGeoPoint {
  id: string;
  nom: string;
  type: string;
  statut: string;
  region: string | null;
  lat: number;
  lon: number;
}

export interface ChantierGeoFeature {
  id: string;
  intitule: string;
  statut: StatutChantier;
  avancementPct: number;
  region: string | null;
  entreprise?: string | null;
  bailleur?: string | null;
  montantGnf?: string | null;
  numContrat?: string | null;
  observations?: string | null;
  geometry: string | null;
  /** true si pas de troncon/PK precis en source : positionne au centre approximatif de la region. */
  approximate: boolean;
  lat: number | null;
  lon: number | null;
}

export const CHANTIER_COLORS: Record<StatutChantier, string> = {
  PLANIFIE: "#9ca3af",
  EN_COURS: "#f5a623",
  SUSPENDU: "#dc2626",
  TERMINE: "#16a34a",
};

export type SelectedFeature =
  | { kind: "troncon"; data: TronconGeoFeature }
  | { kind: "ouvrage"; data: OuvrageGeoPoint }
  | { kind: "pointNoir"; data: PointNoirGeoPoint }
  | { kind: "poste"; data: PosteGeoPoint }
  | { kind: "chantier"; data: ChantierGeoFeature }
  | { kind: "toponyme"; data: { nom: string; nature: string; lat: number; lon: number } };

export const ETAT_COLORS: Record<EtatPatrimoine, string> = {
  BON: "#16a34a",
  MOYEN: "#84cc16",
  MAUVAIS: "#f97316",
  CRITIQUE: "#dc2626",
  NON_EVALUE: "#9ca3af",
};

export const ETAT_LABELS: Record<EtatPatrimoine, string> = {
  BON: "Bon état général",
  MOYEN: "Alternance Bon / Moyen",
  MAUVAIS: "Moyen état général",
  CRITIQUE: "Mauvais état général",
  NON_EVALUE: "Non observé",
};
