import type { EtatPatrimoine, StatutChantier } from "../../types";

// Formes reduites renvoyees par /api/public/carte/geo : volontairement plus pauvres
// que les types authentifies de ../geoportail/types (ni entreprise, ni bailleur, ni
// montant, ni PK, ni trafic). Les redeclarer ici evite de laisser croire que la vue
// publique dispose des memes champs que le geoportail complet.
export interface PublicTroncon {
  id: string;
  code: string;
  nom: string;
  classe: string;
  etat: EtatPatrimoine;
  longueurKm: number;
  region: string | null;
  geometry: string | null;
  /**
   * L'etat a ete declare, jamais constate sur le terrain. La carte peint la meme
   * pastille verte dans les deux cas : sans cette distinction, la fiche publique
   * ferait passer une declaration pour une inspection.
   */
  etatDeclare?: boolean;
}

export interface PublicPointNoir {
  id: string;
  gravite: string;
  region: string | null;
  lat: number;
  lon: number;
}

export interface PublicChantier {
  id: string;
  statut: StatutChantier;
  avancementPct: number;
  region: string | null;
  geometry: string | null;
  approximate: boolean;
  lat: number | null;
  lon: number | null;
}

export interface PublicOuvrage {
  id: string;
  nom: string;
  type: string;
  etat: string;
  lat: number;
  lon: number;
}

export interface PublicCarteData {
  troncons: PublicTroncon[];
  pointsNoirs: PublicPointNoir[];
  chantiers: PublicChantier[];
  ouvrages?: PublicOuvrage[];
}

export type SelectedFeature =
  | { kind: "troncon"; data: PublicTroncon }
  | { kind: "chantier"; data: PublicChantier }
  | { kind: "pointNoir"; data: PublicPointNoir }
  | { kind: "ouvrage"; data: PublicOuvrage };

export const STATUT_LABELS: Record<StatutChantier, string> = {
  PLANIFIE: "Planifié",
  EN_COURS: "En cours",
  SUSPENDU: "Suspendu",
  TERMINE: "Terminé",
};

// Libelles des classes tels qu'un citoyen les comprend : le code brut (RN/RR/RU)
// ne dit rien a qui n'est pas du metier.
export const CLASSE_LABELS: Record<string, string> = {
  RN: "Route nationale",
  RR: "Route régionale",
  RU: "Voirie urbaine",
  PISTE: "Piste rurale",
  // Une voie entree au registre dont le rang dans la hierarchie routiere
  // nationale reste a decider. Absence de decision, pas decision negative.
  NON_CLASSEE: "Non classée",
};

export function geoJsonToLatLngs(geometry: string | null): [number, number][] {
  if (!geometry) return [];
  try {
    const g = JSON.parse(geometry) as { type: string; coordinates: number[][] };
    if (g.type !== "LineString") return [];
    return g.coordinates.map(([lon, lat]) => [lat, lon]);
  } catch {
    return [];
  }
}
