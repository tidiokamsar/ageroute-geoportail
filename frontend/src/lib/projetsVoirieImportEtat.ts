import type { ReponseDepot } from "./projetsVoirieApi";
import {
  ETAPES, ETAPES_REPRISE, LECTURE_VIDE, SAISIE_VIDE,
  type Apercu, type DeltaDetail, type IdEtape, type Inventaire, type Lecture, type Saisie,
} from "./projetsVoirieImport";

/**
 * Etat de l'assistant d'import : EN MEMOIRE SEULEMENT (reducteur React, jamais persiste). Le fichier est un objet `File` : il n'est ni lu
 * ni copie par le navigateur, il est renvoye tel quel au serveur a chaque etape.
 *
 * REGLE D'INVALIDATION : un resultat n'est valable que pour les options qui l'ont produit. Changer le fichier repart de zero ; changer une
 * option de lecture, le CRS ou la correspondance efface l'apercu et la simulation ; changer une metadonnee du jeu efface la simulation.
 * Apres le depot (le jeu existe en quarantaine), plus rien en amont ne se modifie : seul l'etat des etapes finales evolue.
 */

export interface EtatAssistant {
  etape: IdEtape;
  etapes: readonly IdEtape[];
  saisie: Saisie;
  lecture: Lecture;
  inventaire: Inventaire | null;
  apercu: Apercu | null;
  /** Dernier apercu lu, GARDE quand la correspondance de champs ou le CRS change (il efface `apercu`) : il ne sert qu'aux exemples de valeurs des colonnes. */
  apercuPrecedent: Apercu | null;
  /** 409 CONFIRMATION_HORS_ZONE_REQUISE : des elements sortent de la zone attendue ; rien n'avance sans confirmation explicite. */
  horsZone: { nbElements: number; nbObjets: number | null } | null;
  simulation: ReponseDepot | null;
  depot: ReponseDepot | null;
  delta: DeltaDetail | null;
  /** Issue de l'approbation : jeu autorise ou rejete (le jeu reste visible, rien n'est supprime). */
  issue: "AUTORISE" | "REJETE" | null;
  /** Retour arriere effectue : la version restauree. */
  retour: { version: number } | null;
}

export type ActionAssistant =
  | { type: "FICHIER"; fichier: File | null }
  | { type: "SAISIE"; patch: Partial<Saisie> }
  | { type: "LECTURE"; patch: Partial<Lecture> }
  | { type: "LECTURE_CSV"; patch: Partial<Lecture["csv"]> }
  | { type: "MAPPING"; champ: string; colonne: string }
  | { type: "INVENTAIRE"; inventaire: Inventaire }
  | { type: "APERCU"; apercu: Apercu }
  | { type: "HORS_ZONE"; nbElements: number; nbObjets: number | null }
  | { type: "SIMULATION"; simulation: ReponseDepot }
  | { type: "DEPOT"; depot: ReponseDepot }
  | { type: "DELTA"; delta: DeltaDetail }
  | { type: "ISSUE"; issue: "AUTORISE" | "REJETE" }
  | { type: "RETOUR"; version: number }
  | { type: "ALLER"; etape: IdEtape };

export function etatInitial(reprise = false): EtatAssistant {
  const etapes = reprise ? ETAPES_REPRISE : ETAPES.map((e) => e.id);
  return { etape: etapes[0], etapes, saisie: SAISIE_VIDE, lecture: LECTURE_VIDE, inventaire: null, apercu: null, apercuPrecedent: null, horsZone: null, simulation: null, depot: null, delta: null, issue: null, retour: null };
}

const figeApresDepot = (s: EtatAssistant) => s.depot !== null;
/** Efface ce qui depend de la lecture du fichier (apercu et simulation) ; le depot n'est jamais efface. */
const sansResultats = (s: EtatAssistant): EtatAssistant => ({ ...s, apercu: null, horsZone: null, simulation: null });

export function reduire(s: EtatAssistant, a: ActionAssistant): EtatAssistant {
  switch (a.type) {
    case "FICHIER":
      if (figeApresDepot(s)) return s;
      return { ...s, saisie: { ...s.saisie, fichier: a.fichier }, lecture: LECTURE_VIDE, inventaire: null, apercu: null, apercuPrecedent: null, horsZone: null, simulation: null };
    case "SAISIE":
      if (figeApresDepot(s)) return s;
      return { ...s, saisie: { ...s.saisie, ...a.patch }, simulation: null };
    case "LECTURE": {
      if (figeApresDepot(s)) return s;
      const patch = { ...a.patch };
      // Un nouveau CRS annule la confirmation donnee pour le precedent : elle ne vaut que pour le systeme qui l'a motivee.
      if (patch.epsgSource !== undefined && patch.epsgSource !== s.lecture.epsgSource) patch.confirmerHorsZone = false;
      // Une nouvelle couche ou entree d'archive change les colonnes : la correspondance de champs ne vaut plus.
      const change = (patch.couche !== undefined && patch.couche !== s.lecture.couche) || (patch.entreeKml !== undefined && patch.entreeKml !== s.lecture.entreeKml);
      return sansResultats({ ...s, ...(change ? { apercuPrecedent: null } : {}), lecture: { ...s.lecture, ...patch, ...(change ? { mapping: {} } : {}) } });
    }
    case "LECTURE_CSV":
      if (figeApresDepot(s)) return s;
      return sansResultats({ ...s, apercuPrecedent: null, lecture: { ...s.lecture, csv: { ...s.lecture.csv, ...a.patch }, mapping: {}, confirmerHorsZone: false } });
    case "MAPPING": {
      if (figeApresDepot(s)) return s;
      const mapping = { ...s.lecture.mapping };
      if (a.colonne === "") delete mapping[a.champ]; else mapping[a.champ] = a.colonne;
      return sansResultats({ ...s, lecture: { ...s.lecture, mapping } });
    }
    case "INVENTAIRE":
      return { ...s, inventaire: a.inventaire, apercu: null, apercuPrecedent: null, horsZone: null, simulation: null };
    case "APERCU":
      return { ...s, apercu: a.apercu, apercuPrecedent: a.apercu, horsZone: null };
    case "HORS_ZONE":
      return { ...s, apercu: null, simulation: null, horsZone: { nbElements: a.nbElements, nbObjets: a.nbObjets } };
    case "SIMULATION":
      return { ...s, simulation: a.simulation };
    case "DEPOT":
      return { ...s, depot: a.depot };
    case "DELTA":
      return { ...s, delta: a.delta };
    case "ISSUE":
      return { ...s, issue: a.issue };
    case "RETOUR":
      return { ...s, retour: { version: a.version } };
    case "ALLER":
      return s.etapes.includes(a.etape) ? { ...s, etape: a.etape } : s;
  }
}

/** Etape suivante ou precedente dans la liste de l'assistant ; `null` aux extremites. */
export function etapeVoisine(s: EtatAssistant, sens: 1 | -1): IdEtape | null {
  const i = s.etapes.indexOf(s.etape);
  return s.etapes[i + sens] ?? null;
}

/** Retour arriere interdit apres le depot : le fichier est enregistre en quarantaine, les etapes en amont ne peuvent plus changer. */
export function retourPossible(s: EtatAssistant): boolean {
  if (etapeVoisine(s, -1) === null) return false;
  if (s.depot !== null && s.etape !== "approbation") return false;
  if (s.depot !== null && s.etape === "approbation") return s.issue === null;
  return true;
}
