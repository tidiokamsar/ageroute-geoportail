import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "react-router-dom";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { FiltresDecision, IdOnglet } from "../components/decision/types";
import { paramsApi, ONGLET_PAR_DEFAUT } from "./decision";
import { statutScoreServeur, type Bbox, type VueListe } from "./aideDecisionCarte";
import {
  chargerInterventionsGeo, classerErreur, estErreurAutorisation, lireFicheIntervention, listerInterventions,
} from "./aideDecisionInterventions";

/**
 * Hooks du module Aide a la decision (carte et liste des interventions) : React Query pour les lectures, et un PETIT MAGASIN
 * partage pour la selection, que la carte et la liste lisent toutes deux (cohérence entre onglets : un clic sur la carte surligne la
 * ligne, un clic sur une ligne centre la carte).
 *
 * MEME REQUETE POUR LA CARTE ET LA LISTE (AD-11) : la cle de cache est la serialisation unique des filtres (`serialiserFiltres`).
 * Deux onglets qui lisent les memes filtres partagent donc la meme lecture, et un changement de filtre les rafraichit ensemble.
 */

export const CLE = "aide-decision";

/** Un refus d'autorisation ne se retente jamais ; le reste une seule fois (une 404 ou une erreur de forme non plus). */
function retenter(nb: number, e: unknown): boolean {
  if (estErreurAutorisation(e)) return false;
  const g = classerErreur(e).genre;
  if (g === "introuvable" || g === "entree" || g === "reponse") return false;
  return nb < 1;
}
const OPTIONS_LECTURE = { retry: retenter, retryDelay: 400, staleTime: 30_000, refetchOnWindowFocus: false } as const;

export function useListeInterventions(filtres: FiltresDecision, vue: VueListe = "toutes") {
  const statutScore = statutScoreServeur(vue);
  return useInfiniteQuery({
    queryKey: [CLE, "interventions", paramsApi(filtres), statutScore ?? null],
    queryFn: ({ pageParam }) => listerInterventions(filtres, pageParam, statutScore),
    initialPageParam: null as string | null,
    getNextPageParam: (derniere) => (derniere.aSuivant ? derniere.suivant : null) ?? undefined,
    ...OPTIONS_LECTURE,
  });
}

export function useInterventionsGeo(filtres: FiltresDecision, bbox: Bbox | null, actif: boolean) {
  return useQuery({
    queryKey: [CLE, "geojson", paramsApi(filtres), bbox],
    queryFn: () => chargerInterventionsGeo(filtres, bbox as Bbox),
    enabled: actif && bbox !== null,
    // La carte garde les marqueurs de l'emprise precedente pendant le chargement de la suivante, au lieu de clignoter.
    placeholderData: keepPreviousData,
    ...OPTIONS_LECTURE,
  });
}

export function useFicheIntervention(id: string | null) {
  return useQuery({
    queryKey: [CLE, "fiche", id],
    queryFn: () => lireFicheIntervention(id as string),
    enabled: id !== null,
    ...OPTIONS_LECTURE,
  });
}

/** Liste des regions pour le filtre et pour lire `regionId` : meme source que le geoportail (`/regions`). */
export function useRegions() {
  return useQuery({
    queryKey: ["regions"],
    queryFn: async () => (await api.get<{ id: number; nom: string }[]>("/regions")).data,
    staleTime: 10 * 60_000,
    retry: retenter,
  });
}

/** Valeur retardee de `ms` : une frappe ou un deplacement de carte ne declenche pas une requete a chaque evenement. */
export function useValeurDifferee<T>(valeur: T, ms: number): T {
  const [v, setV] = useState(valeur);
  useEffect(() => {
    const t = setTimeout(() => setV(valeur), ms);
    return () => clearTimeout(t);
  }, [valeur, ms]);
  return v;
}

// ---------------------------------------------------------------- selection partagee carte / liste

export interface EtatSelection {
  /** Intervention choisie (marqueur, ligne, constat), ou null. */
  id: string | null;
  /**
   * Vrai quand la carte doit se RECENTRER sur `id` (clic sur une ligne de liste, « voir sur la carte »). La carte l'acquitte des qu'elle l'a fait
   * (`acquitterCentrage`) ; si elle n'est pas montee (onglet Liste), la demande attend son ouverture. Un clic sur un marqueur ne la leve jamais :
   * c'est ce qui evite la boucle carte -> selection -> recentrage -> carte.
   */
  centrageEnAttente: boolean;
  /** Filtre local de la liste, pose par un constat. */
  vue: VueListe;
}

const ETAT_INITIAL: EtatSelection = { id: null, centrageEnAttente: false, vue: "toutes" };
let etat: EtatSelection = ETAT_INITIAL;
const ecouteurs = new Set<() => void>();

function poser(suivant: EtatSelection) {
  if (suivant.id === etat.id && suivant.centrageEnAttente === etat.centrageEnAttente && suivant.vue === etat.vue) return;
  etat = suivant;
  for (const f of [...ecouteurs]) f();
}

/** Choisit une intervention. `centrer` demande a la carte de se recentrer dessus (ligne de liste) ; un marqueur n'en a pas besoin. */
export function selectionner(id: string | null, opts: { centrer?: boolean } = {}) {
  poser({ ...etat, id, centrageEnAttente: id !== null && opts.centrer === true });
}

export function acquitterCentrage() {
  poser({ ...etat, centrageEnAttente: false });
}

export function definirVueListe(vue: VueListe) {
  poser({ ...etat, vue });
}

/** Test uniquement : remet le magasin a son etat initial. */
export function _reinitialiserSelection() {
  etat = ETAT_INITIAL;
  ecouteurs.clear();
}

const abonner = (f: () => void) => { ecouteurs.add(f); return () => { ecouteurs.delete(f); }; };
const lire = () => etat;

export function useSelection(): EtatSelection {
  return useSyncExternalStore(abonner, lire, lire);
}

// ---------------------------------------------------------------- changement d'onglet demande par un composant d'onglet

/**
 * Les onglets ne connaissent pas le shell (contrat paragraphe 8), mais le shell tient l'onglet courant dans l'URL (`?onglet=`, le defaut
 * « carte » n'etant pas ecrit : `ecrireUrl` de `lib/decision.ts`). Pour « voir sur la carte » depuis la liste, ou « voir dans la liste » depuis
 * un constat, un onglet n'a donc qu'a ecrire ce parametre : le shell relit l'URL et change d'onglet, filtres conserves.
 */
export function useChangerOnglet(): (onglet: IdOnglet) => void {
  const [, setParams] = useSearchParams();
  return useCallback((onglet: IdOnglet) => {
    setParams((courants) => {
      const suite = new URLSearchParams(courants);
      if (onglet === ONGLET_PAR_DEFAUT) suite.delete("onglet"); else suite.set("onglet", onglet);
      return suite;
    });
  }, [setParams]);
}
