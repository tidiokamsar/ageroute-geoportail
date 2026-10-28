import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import {
  bboxDeGeometrie, chantierLisible, lireGeoJsonCouche, lireReseau, lireTableauCouche, messageCoucheInvalide, pointLatLonLisible,
  type Bbox, type CouchesCarte, type LectureCouche, type TronconReseau,
} from "../../../lib/aideDecisionCarte";
import { classerErreur } from "../../../lib/aideDecisionInterventions";
import type { ChantierGeoFeature, OuvrageGeoPoint, PointNoirGeoPoint } from "../../../pages/geoportail/types";

/**
 * Couches de CONTEXTE de la carte de decision (reseau classe, chantiers, ouvrages, points noirs, contour du pays) : memes sources que le
 * geoportail (`/troncons/geo`, `/chantiers/geo`, `/ouvrages/geo`, `/points-noirs/geo`, `/v2/geo/contour`), memes cles de cache que lui
 * (une couche deja ouverte dans le geoportail ne se recharge pas ici). Chargees a la PREMIERE activation seulement.
 *
 * CHAQUE REPONSE EST VALIDEE avant d'atteindre Leaflet (`lireReseau`, `lireGeoJsonCouche`, `lireTableauCouche`) : une couche invalide est
 * ecartee avec son message et son compteur, la page continue. Une couche en erreur ou en chargement n'est jamais rendue comme une couche
 * vide : son etat est dit dans le panneau.
 */

export interface EtatCouche<T> {
  statut: "inactif" | "chargement" | "pret" | "erreur";
  donnees: T | null;
  message: string | null;
  /** Elements recus mais illisibles, ecartes (compteur d'anomalie). */
  ignores: number;
  /** Vrai si la REPONSE est invalide (couche ecartee), faux pour une panne de reseau ou un refus. */
  invalide: boolean;
  /** Relance du chargement apres une erreur. */
  reessayer: () => void;
}

export const LIBELLE_COUCHE = {
  reseau: "Réseau routier",
  chantiers: "Chantiers",
  ouvrages: "Ouvrages d'art",
  pointsNoirs: "Points noirs",
  limites: "Contour du pays",
} as const;

/** Le texte d'une erreur de chargement de couche : celui du serveur s'il en a donne un ; jamais le texte anglais d'axios. */
/** Erreur DITE par ce module (par exemple « aucune limite en base ») : son texte est deja en francais et se rend tel quel. */
class CoucheSansDonnees extends Error {}

function texteErreurCouche(e: unknown): string {
  if (e instanceof CoucheSansDonnees && e.message) return e.message;
  const c = classerErreur(e);
  if (c.genre === "permission" || c.genre === "session") return "Accès refusé : cette couche demande le module Géoportail.";
  if (c.genre === "reseau") return "Réseau indisponible : chargement impossible.";
  return c.message === "Erreur du serveur." ? "Chargement impossible." : c.message;
}

function useCoucheLue<T>(actif: boolean, cle: readonly unknown[], charger: () => Promise<unknown>, lire: (donnees: unknown) => LectureCouche<T>, libelle: string): EtatCouche<T> {
  const q = useQuery({ queryKey: cle, queryFn: charger, enabled: actif, staleTime: 10 * 60_000, retry: false, refetchOnWindowFocus: false });
  const lecture = useMemo(() => (q.data === undefined ? null : lire(q.data)), [q.data, lire]);
  const reessayer = useCallback(() => { void q.refetch(); }, [q]);
  const base = { donnees: null, message: null, ignores: 0, invalide: false, reessayer } as const;
  if (q.isError) return { ...base, statut: "erreur", message: texteErreurCouche(q.error) };
  if (lecture && !lecture.ok) return { ...base, statut: "erreur", message: messageCoucheInvalide(libelle, lecture.raison), invalide: true };
  if (lecture && lecture.ok) return { ...base, statut: "pret", donnees: lecture.donnees, ignores: lecture.ignores };
  if (actif && q.isFetching) return { ...base, statut: "chargement" };
  return { ...base, statut: "inactif" };
}

const chargerReseauBrut = async (): Promise<unknown> => (await api.get<unknown>("/troncons/geo")).data;
const chargerOuvrages = async (): Promise<unknown> => (await api.get<unknown>("/ouvrages/geo")).data;
const chargerChantiers = async (): Promise<unknown> => (await api.get<unknown>("/chantiers/geo")).data;
const chargerPointsNoirs = async (): Promise<unknown> => (await api.get<unknown>("/points-noirs/geo")).data;
const chargerContour = async (): Promise<unknown> => {
  try {
    return (await api.get<unknown>("/v2/geo/contour")).data;
  } catch (e) {
    // 404 : la base ne porte aucune limite. On ne trace rien et on le dit ; on n'invente pas un contour.
    if ((e as { response?: { status?: number } })?.response?.status === 404) throw new CoucheSansDonnees("Aucune limite administrative en base : rien n'est tracé.");
    throw e;
  }
};

const lireOuvrages = (d: unknown) => lireTableauCouche<OuvrageGeoPoint>(d, pointLatLonLisible);
const lireChantiers = (d: unknown) => lireTableauCouche<ChantierGeoFeature>(d, chantierLisible);
const lirePointsNoirs = (d: unknown) => lireTableauCouche<PointNoirGeoPoint>(d, pointLatLonLisible);

const CLE_RESEAU = ["troncons", "geo"] as const;

export interface CouchesContexte {
  reseau: EtatCouche<TronconReseau[]>;
  chantiers: EtatCouche<ChantierGeoFeature[]>;
  ouvrages: EtatCouche<OuvrageGeoPoint[]>;
  pointsNoirs: EtatCouche<PointNoirGeoPoint[]>;
  limites: EtatCouche<GeoJSON.GeoJsonObject>;
}

export function useCouchesContexte(couches: CouchesCarte): CouchesContexte {
  return {
    reseau: useCoucheLue(couches.reseau, CLE_RESEAU, chargerReseauBrut, lireReseau, LIBELLE_COUCHE.reseau),
    chantiers: useCoucheLue(couches.chantiers, ["chantiers", "geo"], chargerChantiers, lireChantiers, LIBELLE_COUCHE.chantiers),
    ouvrages: useCoucheLue(couches.ouvrages, ["ouvrages", "geo"], chargerOuvrages, lireOuvrages, LIBELLE_COUCHE.ouvrages),
    pointsNoirs: useCoucheLue(couches.pointsNoirs, ["points-noirs", "geo"], chargerPointsNoirs, lirePointsNoirs, LIBELLE_COUCHE.pointsNoirs),
    limites: useCoucheLue(couches.limites, ["decision", "contour"], chargerContour, lireGeoJsonCouche, LIBELLE_COUCHE.limites),
  };
}

/**
 * Emprise du trace d'un troncon, lue dans le reseau de reference (`/troncons/geo`, partage avec le geoportail par la cle de cache).
 * Sert a la recherche et au centrage sur une intervention depuis la liste. Troncon absent du reseau : null (la carte ne se recadre pas
 * « a cote ») ; reseau impossible a charger : l'erreur remonte.
 */
export function useBboxTroncon(): (id: string) => Promise<Bbox | null> {
  const qc = useQueryClient();
  return useCallback(async (id: string) => {
    const brut = await qc.fetchQuery({ queryKey: CLE_RESEAU, queryFn: chargerReseauBrut, staleTime: 10 * 60_000 });
    const lecture = lireReseau(brut);
    if (!lecture.ok) return null;
    const t = lecture.donnees.find((x) => x.id === id);
    return t ? bboxDeGeometrie(t.geometrie) : null;
  }, [qc]);
}
