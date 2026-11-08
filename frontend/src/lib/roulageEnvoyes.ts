import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "./api";

/**
 * Releves en roulant ENVOYES au serveur : le client des routes de consultation (`GET /api/v2/roulage/sessions`
 * et `GET /api/v2/roulage/sessions/:id`).
 *
 * POURQUOI CE MODULE EXISTE. Le serveur enregistrait deja la session (tables `sessions_roulage`, `marqueurs_roulage`,
 * `evenements_roulage`, `evenements_roulage_portions`), mais rien ne la relisait : l'agent qui avait envoye un releve ne
 * le voyait nulle part. Ces types suivent le CONTRAT REEL de l'API de consultation (docs/roulage/CONSULTATION.md, §3 a §5,
 * verifie contre le serveur lance sur une base PostGIS : voir la section « Integration » de ce document) ; la mise en forme
 * (duree, distance, taux, nom des liens) est dans `roulageEnvoyesVue.ts`, pure et testee.
 *
 * L'identifiant serveur d'un releve est celui de la session locale envoyee (`entityId` du push) : la page d'envoi peut
 * donc pointer directement vers le detail.
 *
 * AUCUNE DONNEE N'EST INVENTEE ICI. Une reponse qui n'a pas la forme du contrat est une ERREUR (jamais une liste vide) :
 * un ecran qui montrerait « aucun releve » parce que la reponse est illisible ferait croire que l'envoi a ete perdu.
 * Les champs ADDITIFS du contrat (`sourcePosition`, `motif`, `tronconId`, `portionId`...) sont facultatifs a la lecture :
 * un serveur qui ne les envoie pas encore donne `null`, jamais une erreur.
 */

export interface AgentReleve { id: string; nom: string }

export interface ResumeReleveEnvoye {
  id: string;
  debutA: string;
  finA: string;
  dureeS: number;
  nbPoints: number;
  nbMarqueurs: number;
  nbEvenements: number;
  /**
   * Part des positions RETENUES par l'analyse qui sont rattachees au reseau, entre 0 et 1 (echelle confirmee sur le serveur
   * reel : 0, 1 et des valeurs intermediaires, jamais 0 a 100). `null` = NON EVALUE (aucun point retenu), jamais a lire comme 0 %.
   */
  tauxRattachement: number | null;
  /**
   * DISTANCE PARCOURUE, telle que l'analyse du serveur l'a enregistree a l'envoi (somme des distances entre positions retenues,
   * en metres). Ce n'est PAS la longueur de la polyligne dessinee sur la carte, qui peut etre simplifiee.
   */
  longueurM: number | null;
  missionId: string | null;
  agent: AgentReleve;
  /** Troncons DISTINCTS auxquels le releve se rattache (portions creees et reperes rattaches), pas ceux que la trace a longes. */
  nbTronconsTraverses: number;
  creeLe: string;
}

export interface PageReleves {
  items: ResumeReleveEnvoye[];
  suivant: string | null;
  total: number;
}

export interface FiltresReleves {
  /** Debut de la periode, au format `AAAA-MM-JJ` saisi par l'agent (jour local). Vide = pas de borne. Converti en instant ISO avant l'envoi. */
  depuis: string;
  /** Fin de la periode (jour inclus), au format `AAAA-MM-JJ`. Vide = pas de borne. */
  jusqua: string;
  /** Identifiant de l'agent, ou vide pour tous ceux que le serveur laisse voir. */
  userId: string;
}

export const FILTRES_VIDES: FiltresReleves = { depuis: "", jusqua: "", userId: "" };

export interface MarqueurReleve {
  id: string;
  code: string;
  note: string | null;
  poseA: string;
  /**
   * Position du repere. `sourcePosition` vaut `TRACE` : position SUR LA TRACE a l'instant de pose (celle qui a servi au
   * rattachement) ; `APPAREIL` : position brute du telephone, a defaut ; `null` : aucune position connue.
   */
  lat: number | null;
  lon: number | null;
  sourcePosition: string | null;
  precisionM: number | null;
  /** Vrai : le dernier point GPS de l'APPAREIL etait trop ancien (ou absent) quand le repere a ete pose. */
  positionPerimee: boolean;
  statut: string;
  /** Pourquoi le repere n'est pas rattache (code du serveur), ou `null`. */
  motif: string | null;
  /** Troncon du repere (celui auquel il est rattache ; pour un repere non rattache, celui que le serveur avait retenu), si connu. */
  tronconId: string | null;
  tronconCode: string | null;
  /** Distance depuis le debut du troncon, en metres ; `null` quand le repere n'est pas rattache. */
  abscisseM: number | null;
}

export interface PortionEvenement {
  rang: number;
  portionId: string | null;
  tronconId: string;
  tronconCode: string | null;
  tronconNom: string | null;
  debutM: number | null;
  finM: number | null;
  sens: string | null;
}

export interface EvenementReleve {
  id: string;
  code: string;
  note: string | null;
  statutAppareil: string;
  /** Choix de l'agent (revetement, etat, praticabilite...), jamais une mesure. */
  qualification: Record<string, unknown> | null;
  debutA: string;
  finA: string | null;
  statutRattachement: string;
  /** Pourquoi le segment n'a pas abouti en portions (code du serveur), ou le motif ecrit par l'agent s'il l'a abandonne. */
  motif: string | null;
  /** Les portions CREEES seulement : les troncons refuses par le serveur ne sont pas listes. */
  portions: PortionEvenement[];
}

/** Multi-ligne GeoJSON : `coordinates[ligne][point] = [longitude, latitude]`. */
export interface GeometrieReleve {
  type: "MultiLineString";
  coordinates: number[][][];
}

export interface DetailReleveEnvoye extends ResumeReleveEnvoye {
  geometrie: GeometrieReleve | null;
  /** Vrai : la geometrie renvoyee a ete reduite pour l'affichage (moins de sommets que la trace enregistree). */
  simplifiee: boolean;
  marqueurs: MarqueurReleve[];
  evenements: EvenementReleve[];
  /**
   * `compteurs`, `trous`, `interruptions`, `pauses` : colonnes de l'APPAREIL, telles qu'ecrites. `serveur` : l'analyse du serveur
   * (parametres, `indicateurs`, `avertissements`), telle qu'ecrite. Aucun bloc n'a de forme figee par le contrat : ils sont lus par
   * `lireCompte` et `lireAnalyseServeur` (vue), jamais supposes.
   */
  analyse: { compteurs: unknown; trous: unknown; interruptions: unknown; pauses: unknown; serveur: unknown };
  parametres: {
    provenance: string | null;
    versionContrat: number | null;
    /** Seuils appliques par l'appareil, tels qu'ecrits. Avec la provenance `PROVISOIRE_NON_CALIBRE`, ils ne sont pas calibres. */
    seuils: Record<string, unknown> | null;
  };
  /** `pointsDisponibles` : le serveur garde-t-il les positions detaillees de la trace ? (booleen du serveur reel) */
  trace: { nbPoints: number; pointsDisponibles: boolean };
}

// ------------------------------------------------------------------ validation de la forme des reponses

const estObjet = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const estChaine = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const estNombre = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** Facultatif a la lecture : absent ou `null` = pas de valeur ; present, il doit avoir le bon type. */
const chaineOuNulle = (v: unknown): boolean => v === undefined || v === null || typeof v === "string";
const nombreOuNul = (v: unknown): boolean => v === undefined || v === null || estNombre(v);

function resumeValide(v: unknown): v is ResumeReleveEnvoye {
  if (!estObjet(v)) return false;
  return estChaine(v.id) && estChaine(v.debutA) && estChaine(v.finA)
    && estNombre(v.dureeS) && estNombre(v.nbPoints) && estNombre(v.nbMarqueurs) && estNombre(v.nbEvenements)
    && (v.tauxRattachement === null || estNombre(v.tauxRattachement))
    && (v.longueurM === null || estNombre(v.longueurM))
    && estObjet(v.agent) && estChaine(v.agent.id) && typeof v.agent.nom === "string"
    && estNombre(v.nbTronconsTraverses);
}

function marqueurValide(v: unknown): boolean {
  return estObjet(v) && estChaine(v.id) && estChaine(v.code) && estChaine(v.poseA) && estChaine(v.statut)
    && typeof v.positionPerimee === "boolean"
    && nombreOuNul(v.lat) && nombreOuNul(v.lon) && nombreOuNul(v.precisionM) && nombreOuNul(v.abscisseM)
    && chaineOuNulle(v.note) && chaineOuNulle(v.sourcePosition) && chaineOuNulle(v.motif) && chaineOuNulle(v.tronconId) && chaineOuNulle(v.tronconCode);
}

function portionValide(v: unknown): boolean {
  return estObjet(v) && estNombre(v.rang) && estChaine(v.tronconId)
    && chaineOuNulle(v.portionId) && chaineOuNulle(v.tronconCode) && chaineOuNulle(v.tronconNom) && chaineOuNulle(v.sens)
    && nombreOuNul(v.debutM) && nombreOuNul(v.finM);
}

function evenementValide(v: unknown): boolean {
  return estObjet(v) && estChaine(v.id) && estChaine(v.code) && estChaine(v.statutAppareil) && estChaine(v.debutA) && estChaine(v.statutRattachement)
    && chaineOuNulle(v.finA) && chaineOuNulle(v.note) && chaineOuNulle(v.motif)
    && (v.qualification === undefined || v.qualification === null || estObjet(v.qualification))
    && Array.isArray(v.portions) && v.portions.every(portionValide);
}

/** Erreur de forme : distincte d'une panne reseau, elle dit que le serveur n'a pas repondu selon le contrat. */
export class ReponseIllisible extends Error {
  constructor(message: string) { super(message); this.name = "ReponseIllisible"; }
}

export function lirePageReleves(brut: unknown): PageReleves {
  if (!estObjet(brut) || !Array.isArray(brut.items) || !estNombre(brut.total) || !(brut.suivant === null || typeof brut.suivant === "string")) {
    throw new ReponseIllisible("La liste des relevés envoyés n'a pas la forme attendue.");
  }
  if (!brut.items.every(resumeValide)) throw new ReponseIllisible("Un relevé de la liste n'a pas la forme attendue.");
  return { items: brut.items as ResumeReleveEnvoye[], suivant: brut.suivant as string | null, total: brut.total };
}

const ou = <T>(v: T | undefined | null): T | null => (v === undefined ? null : v);

export function lireDetailReleve(brut: unknown): DetailReleveEnvoye {
  if (!resumeValide(brut)) throw new ReponseIllisible("Le relevé n'a pas la forme attendue.");
  const o = brut as unknown as Record<string, unknown>;
  const geo = o.geometrie;
  const geometrieOk = geo === null || (estObjet(geo) && Array.isArray(geo.coordinates));
  const trace = o.trace;
  const parametres = o.parametres;
  if (
    !geometrieOk || typeof o.simplifiee !== "boolean" || !Array.isArray(o.marqueurs) || !Array.isArray(o.evenements)
    || !estObjet(o.analyse) || !estObjet(parametres)
    || !estObjet(trace) || !estNombre(trace.nbPoints) || typeof trace.pointsDisponibles !== "boolean"
  ) {
    throw new ReponseIllisible("Le détail du relevé n'a pas la forme attendue.");
  }
  if (!o.marqueurs.every(marqueurValide) || !o.evenements.every(evenementValide)) {
    throw new ReponseIllisible("Un repère ou un segment du relevé n'a pas la forme attendue.");
  }
  // Les champs additifs absents deviennent `null` : le reste de l'ecran n'a pas a distinguer « absent » de « sans valeur ».
  const marqueurs = (o.marqueurs as Record<string, unknown>[]).map((m) => ({
    ...m, note: ou(m.note), lat: ou(m.lat), lon: ou(m.lon), precisionM: ou(m.precisionM), sourcePosition: ou(m.sourcePosition), motif: ou(m.motif),
    tronconId: ou(m.tronconId), tronconCode: ou(m.tronconCode), abscisseM: ou(m.abscisseM),
  }));
  const evenements = (o.evenements as Record<string, unknown>[]).map((e) => ({
    ...e, note: ou(e.note), finA: ou(e.finA), qualification: ou(e.qualification), motif: ou(e.motif),
    portions: (e.portions as Record<string, unknown>[]).map((p) => ({
      ...p, portionId: ou(p.portionId), tronconCode: ou(p.tronconCode), tronconNom: ou(p.tronconNom), debutM: ou(p.debutM), finM: ou(p.finM), sens: ou(p.sens),
    })),
  }));
  const analyse = o.analyse as Record<string, unknown>;
  return {
    ...(o as unknown as DetailReleveEnvoye),
    marqueurs, evenements,
    analyse: { compteurs: ou(analyse.compteurs), trous: ou(analyse.trous), interruptions: ou(analyse.interruptions), pauses: ou(analyse.pauses), serveur: ou(analyse.serveur) },
    parametres: {
      provenance: typeof parametres.provenance === "string" ? parametres.provenance : null,
      versionContrat: estNombre(parametres.versionContrat) ? parametres.versionContrat : null,
      seuils: estObjet(parametres.seuils) ? parametres.seuils : null,
    },
    trace: { nbPoints: trace.nbPoints, pointsDisponibles: trace.pointsDisponibles },
  } as DetailReleveEnvoye;
}

// ------------------------------------------------------------------ appels

export const TAILLE_PAGE = 25;

/** Les parametres de requete : un filtre vide n'est pas envoye. `depuis` et `jusqua` sont des INSTANTS ISO avec fuseau (voir `periodeVersParametres`). */
export function parametresListe(filtres: { depuis?: string | null; jusqua?: string | null; userId?: string }, curseur: string | null, limite: number = TAILLE_PAGE): Record<string, string | number> {
  const p: Record<string, string | number> = { limite };
  if (curseur) p.curseur = curseur;
  if (filtres.userId) p.userId = filtres.userId;
  if (filtres.depuis) p.depuis = filtres.depuis;
  if (filtres.jusqua) p.jusqua = filtres.jusqua;
  return p;
}

export async function chargerPageReleves(params: Record<string, string | number>): Promise<PageReleves> {
  const { data } = await api.get<unknown>("/v2/roulage/sessions", { params });
  return lirePageReleves(data);
}

export async function chargerDetailReleve(id: string): Promise<DetailReleveEnvoye> {
  const { data } = await api.get<unknown>(`/v2/roulage/sessions/${encodeURIComponent(id)}`);
  return lireDetailReleve(data);
}

// ------------------------------------------------------------------ hooks

/**
 * `periode` est deja convertie en instants (voir `periodeVersParametres`) : la cle de requete suit ce que le serveur recoit.
 * Pas de nouvel essai automatique : une erreur est montree avec « Reessayer », pas masquee par une relance silencieuse.
 */
export function useReleveEnvoyes(periode: { depuis: string | null; jusqua: string | null }, userId: string) {
  return useInfiniteQuery({
    queryKey: ["roulage", "sessions", periode.depuis, periode.jusqua, userId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => chargerPageReleves(parametresListe({ ...periode, userId }, pageParam)),
    getNextPageParam: (derniere) => derniere.suivant,
    retry: false,
  });
}

export function useReleveEnvoye(id: string | undefined) {
  return useQuery({
    queryKey: ["roulage", "session", id],
    queryFn: () => chargerDetailReleve(id as string),
    enabled: !!id,
    retry: false,
  });
}
