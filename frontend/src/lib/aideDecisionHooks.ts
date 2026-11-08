import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { FiltresDecision } from "../components/decision/types";
import type { Region } from "../types";
import { api } from "./api";
import { lireDictionnaire, lireSynthese, politiqueRetry } from "./aideDecisionApi";
import { erreurPeriode, serialiserFiltres } from "./decision";

/**
 * Delai avant la relance d'une panne (5xx, reseau). Une constante nommee : les tests de relance la lisent.
 */
export const DELAI_RETRY_MS = 1000;

/**
 * Hooks de lecture du module « Aide a la decision ». La cle de cache porte les filtres SERIALISES : deux vues au meme
 * perimetre partagent une lecture, deux perimetres ne se melangent jamais.
 */

export function useSynthese(filtres: FiltresDecision) {
  return useQuery({
    queryKey: ["aide-decision", "synthese", serialiserFiltres(filtres).toString()],
    queryFn: () => lireSynthese(filtres),
    // Une periode incoherente n'est pas envoyee : le serveur repondrait sur un intervalle vide, lu comme « aucune donnee ».
    enabled: erreurPeriode(filtres) === null,
    staleTime: 60_000,
    // Pas de relance sur un refus (400 filtre invalide, 401, 403, 404) : la rejouer ne change rien et retarde le message.
    retry: politiqueRetry,
    retryDelay: DELAI_RETRY_MS,
  });
}

/** Le dictionnaire change rarement : lu une fois, il complete la definition portee par chaque indicateur. */
export function useDictionnaire(actif: boolean) {
  return useQuery({
    queryKey: ["aide-decision", "dictionnaire"],
    queryFn: lireDictionnaire,
    enabled: actif,
    staleTime: 10 * 60_000,
    retry: politiqueRetry,
    retryDelay: DELAI_RETRY_MS,
  });
}

/** Regions du filtre. Un echec laisse le filtre indisponible (dit a l'ecran) sans empecher le reste de la page. */
export function useRegionsDecision() {
  return useQuery({
    queryKey: ["regions"],
    queryFn: async () => (await api.get<Region[]>("/regions")).data,
    staleTime: 10 * 60_000,
    retry: politiqueRetry,
    retryDelay: DELAI_RETRY_MS,
  });
}

/**
 * Vrai quand `actif` dure plus de `delaiMs` : le squelette de chargement est borne dans le temps. Au-dela, la page dit
 * que la reponse tarde et propose de reessayer, au lieu de laisser croire a un chargement sans fin.
 */
export function useDelaiDepasse(actif: boolean, delaiMs = 10_000): boolean {
  const [depasse, setDepasse] = useState(false);
  useEffect(() => {
    if (!actif) {
      setDepasse(false);
      return;
    }
    const t = setTimeout(() => setDepasse(true), delaiMs);
    return () => clearTimeout(t);
  }, [actif, delaiMs]);
  return actif && depasse;
}
