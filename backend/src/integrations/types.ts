/**
 * TYPES COMMUNS DES INTEGRATIONS SORTANTES (A13, paragraphes 7.10 et 7.15). AUCUN IMPORT DE BASE.
 *
 * CE QUE CE MODULE EST, ET CE QU'IL N'EST PAS
 *
 * C'est le socle COTE AGEROUTE d'une emission vers DigitalRoad, SharePoint et la BDR / L2R :
 * une outbox transactionnelle, des adaptateurs derriere une interface, des contrats d'echange.
 * Il a ete teste contre des SIMULATEURS ECRITS PAR AGEROUTE. Aucun de ces trois systemes n'a ete
 * atteint : B-11 (DigitalRoad) et B-12 (SharePoint / Entra ID) sont ouverts, et aucun format
 * L2R n'est publie. Un test vert ici prouve que NOTRE code tient NOTRE hypothese de contrat,
 * jamais que le systeme reel l'accepte.
 */

/** Les trois destinations que les documents du depot nomment. Rien d'autre n'est emis. */
export const DESTINATIONS = ["DIGITALROAD", "SHAREPOINT", "BDR_L2R"] as const;
export type Destination = (typeof DESTINATIONS)[number];

/** Ce que chaque destination recoit. Un type par destination : pas de fourre-tout. */
export const TYPES_EVENEMENT = [
  "FICHE_INTERVENTION_PROGRAMMEE",
  "DEPOT_BULLETIN_ROUTIER",
  "PIVOT_OBJET_VALIDE",
] as const;
export type TypeEvenement = (typeof TYPES_EVENEMENT)[number];

/** Les sources dont un evenement peut etre tire. */
export const TYPES_SOURCE = ["FicheIntervention", "BulletinRoutier", "Troncon", "Ouvrage", "Portion"] as const;
export type TypeSource = (typeof TYPES_SOURCE)[number];

/**
 * La table de routage : pour chaque destination, le type d'evenement et les sources admises.
 * Elle reprend la contrainte `outbox_route_coherente` de la base.
 *
 * DigitalRoad : la fiche d'intervention (MAINTENANCE_PROGRAMMING_DESIGN.md, 5.3). Aucune table
 * de fiches n'existe : la route est decrite, aucun evenement ne peut y entrer (D-07).
 * SharePoint : le bulletin routier archive et fige (empreinte SHA-256 verifiee en base).
 * BDR / L2R : le format pivot ouvert (ROAD_SURVEY_IMPORT_SPEC.md) pour les objets du referentiel.
 */
export const ROUTES: Record<Destination, { typeEvenement: TypeEvenement; sources: readonly TypeSource[] }> = {
  DIGITALROAD: { typeEvenement: "FICHE_INTERVENTION_PROGRAMMEE", sources: ["FicheIntervention"] },
  SHAREPOINT: { typeEvenement: "DEPOT_BULLETIN_ROUTIER", sources: ["BulletinRoutier"] },
  BDR_L2R: { typeEvenement: "PIVOT_OBJET_VALIDE", sources: ["Troncon", "Ouvrage", "Portion"] },
};

export function estDestination(v: unknown): v is Destination {
  return typeof v === "string" && (DESTINATIONS as readonly string[]).includes(v);
}

/** Etats de la machine : voir etat.noyau.ts. */
export const STATUTS_OUTBOX = ["EN_ATTENTE", "EN_COURS", "ENVOYE", "ECHEC", "ABANDONNE"] as const;
export type StatutOutbox = (typeof STATUTS_OUTBOX)[number];

/** Une ligne de `outbox_evenements`, telle que la base la rend. */
export interface EvenementOutbox {
  id: string;
  destination: Destination;
  typeEvenement: TypeEvenement;
  sourceType: TypeSource;
  sourceId: string;
  version: number;
  cleIdempotence: string;
  /** JSON canonique, exactement ce qui est emis. */
  chargeCanonique: string;
  empreinteCharge: string;
  statut: StatutOutbox;
  tentatives: number;
  tentativesMax: number;
  relances: number;
  prochaineTentativeLe: Date;
  verrouPar: string | null;
  verrouJusqua: Date | null;
  dernierCode: string | null;
  dernierMessage: string | null;
  accuseReference: string | null;
  envoyeLe: Date | null;
  abandonneLe: Date | null;
  motifAbandon: string | null;
  creeParId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Issue d'une tentative d'emission, telle que l'adaptateur la rapporte. */
export type IssueEmission =
  | "ACCEPTE"
  | "DOUBLON_RECONNU"
  | "ECHEC_TEMPORAIRE"
  | "ECHEC_DEFINITIF"
  | "ACCUSE_INVALIDE";

export type ResultatEmission =
  | { issue: "ACCEPTE"; accuseReference: string; codeHttp: number }
  | { issue: "DOUBLON_RECONNU"; accuseReference: string; codeHttp: number }
  | { issue: "ECHEC_TEMPORAIRE"; codeErreur: string; message: string; codeHttp?: number }
  | { issue: "ECHEC_DEFINITIF"; codeErreur: string; message: string; codeHttp?: number }
  | { issue: "ACCUSE_INVALIDE"; codeErreur: string; message: string; codeHttp?: number };

/** Ce que l'adaptateur recoit : l'evenement tel qu'il est fige, rien de plus. */
export interface DemandeEmission {
  evenementId: string;
  destination: Destination;
  typeEvenement: TypeEvenement;
  version: number;
  cleIdempotence: string;
  empreinteCharge: string;
  /** La charge, deja parsee depuis `chargeCanonique`. */
  charge: unknown;
}

export interface Adaptateur {
  readonly destination: Destination;
  /** Verifie la charge contre le contrat de cette destination, AVANT toute emission. */
  verifierCharge(charge: unknown): { ok: true } | { ok: false; motif: string };
  /** N'emet que si la verification passe. Ne leve jamais : toute panne devient un ResultatEmission. */
  emettre(demande: DemandeEmission): Promise<ResultatEmission>;
}
