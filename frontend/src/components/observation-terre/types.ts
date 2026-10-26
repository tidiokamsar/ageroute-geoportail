/**
 * Contrat d'interface entre l'ecran Observation de la Terre (EO-UI) et la carte (EO-CARTE).
 * Ce fichier est la propriete d'EO-UI ; l'agent de la carte l'importe sans le modifier.
 * Voir docs/observation-terre/CONTRAT-API-UI.md.
 */

import type { Troncature } from "../../lib/teledetectionCarte";

export type { Troncature };

export interface FiltresCarte { statut?: string; type?: string; priorite?: string }

export type CouchesCarte = {
  reseau: boolean;
  limites: boolean;
  propositions: boolean;
  observationsTerrain: boolean;
  chantiers: boolean;
  ouvrages: boolean;
};

export interface CarteObservationTerreProps {
  propositions: GeoJSON.FeatureCollection | null;
  /**
   * `tronque` et `total` rendus par `GET /propositions.geojson` (contrat §5) : quand la reponse est tronquee, la carte le
   * dit (« N au total, seules les M plus prioritaires... : zoomez ») et redemande l'emprise a chaque zoom. Absent ou null :
   * le serveur n'a rien dit, la carte ne suppose rien.
   */
  troncature?: Troncature | null;
  chargement: boolean;
  erreur: string | null;
  zoomSuffisant: boolean;
  selectionId: string | null;
  onSelect: (id: string | null) => void;
  onEmpriseChange: (bbox: [number, number, number, number], zoom: number) => void;
  couches: CouchesCarte;
  onCouchesChange: (c: CouchesCarte) => void;
  focus?: { bbox: [number, number, number, number] } | null;
  /**
   * Classes de HAUTEUR de la zone de carte (hors legende et liste alternative, qui se placent dessous). Defaut : le
   * geoportail (`h-[min(70vh,600px)] min-h-[340px]`). L'ecran, qui range la carte dans une colonne, en donne une plus basse.
   */
  hauteur?: string;
  /** Replie le panneau des couches a l'ouverture, meme sur grand ecran : dans une colonne etroite il masquerait la carte. */
  couchesRepliees?: boolean;
  className?: string;
}

/**
 * Un cote de la comparaison. `panne` dit POURQUOI `url` est nul alors qu'une image etait attendue : `indisponible` = le serveur a repondu
 * 404 APERCU_INDISPONIBLE (« indisponible chez le fournisseur »), `echec` = l'image n'a pas pu etre chargee. Absent : pas d'image prevue.
 */
export interface CoteComparaison { url: string | null; date: string | null; panne?: "indisponible" | "echec" }

export interface ComparaisonProps {
  avant: CoteComparaison;
  apres: CoteComparaison;
  libelleZone?: string;
}
