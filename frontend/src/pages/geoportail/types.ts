import type { EtatPatrimoine, StatutChantier } from "../../types";
import { ORDRE_ETATS, SYMBOLES } from "../../features/geoportail/map/symbology";

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
  /**
   * Vrai si l'ouvrage vient d'une source cartographique externe et n'a pas ete
   * visite. 963 des 1 089 sont dans ce cas depuis l'import du 05/09/2026.
   */
  repris?: boolean;
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

/**
 * Couleurs d'etat : reprises de l'echelle unique, plus definies ici.
 *
 * Les anciennes valeurs (#16a34a, #84cc16, #f97316, #dc2626, #9ca3af) n'avaient jamais
 * ete confrontees a un seuil de contraste. Elles vivaient par ailleurs en double avec
 * la palette des badges, si bien qu'un meme etat n'avait pas la meme couleur d'un ecran
 * a l'autre. `symbology.ts` les tient desormais, et un test recalcule chaque ratio.
 */
export const ETAT_COLORS: Record<EtatPatrimoine, string> = Object.fromEntries(
  ORDRE_ETATS.map((e) => [e, SYMBOLES[e].trait]),
) as Record<EtatPatrimoine, string>;

/**
 * FORMULATION PUBLIQUE DE L'ECHELLE — DIVERGENTE, ET EN ATTENTE D'ARBITRAGE.
 *
 * Ces libelles ne disent pas la meme chose que la valeur stockee. Constate le
 * 05/09/2026 :
 *
 *     en base     ici (carte, carte publique)   ailleurs (listes, badges)
 *     MOYEN       « Alternance Bon / Moyen »    « Moyen »
 *     MAUVAIS     « Moyen etat general »        « Mauvais »
 *     CRITIQUE    « Mauvais etat general »      « Critique »
 *
 * Le decalage joue d'un cran, systematiquement dans le sens favorable : un troncon
 * enregistre CRITIQUE se lit « Mauvais etat general » sur le site public. Ces libelles
 * viennent de l'instantane initial du depot, SANS justification ecrite, dans un code ou
 * chaque decision porte pourtant la sienne.
 *
 * Deux lectures possibles, et une seule personne peut trancher :
 *   — l'echelle interne a 4 niveaux a ete volontairement retranscrite dans un autre
 *     vocabulaire pour le public, et il faut alors l'ecrire et l'assumer ;
 *   — c'est une erreur heritee, et il faut aligner sur `SYMBOLES[...].libelle`.
 *
 * Changer le vocabulaire de l'indicateur d'etat du reseau routier national n'est pas
 * une correction technique. En attendant l'arbitrage de l'agence, la formulation
 * publique est CONSERVEE telle quelle — mais elle n'est plus subie : elle est ici,
 * nommee, et le present commentaire est ce qui la separe d'un bug silencieux.
 */
export const ETAT_LABELS: Record<EtatPatrimoine, string> = {
  BON: "Bon état général",
  MOYEN: "Alternance Bon / Moyen",
  MAUVAIS: "Moyen état général",
  CRITIQUE: "Mauvais état général",
  NON_EVALUE: "Non observé",
};
