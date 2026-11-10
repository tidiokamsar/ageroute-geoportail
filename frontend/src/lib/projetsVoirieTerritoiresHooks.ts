import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CLE } from "./projetsVoirieHooks";
import {
  chargerArbreTerritoires, chargerConfiguration, creerTerritoire, creerValeur, ecrireConfiguration, listerRegions, listerTerritoires, listerValeurs, lireTerritoireFiche,
  modifierTerritoire, modifierValeur, retirerTerritoire, retirerValeur,
  type CorpsModifTerritoire, type CorpsTerritoire, type CorpsValeur,
} from "./projetsVoirieTerritoiresApi";
import type { DomaineReferentiel, Territoire } from "./projetsVoirieTerritoires";

/**
 * Requetes React Query du lot T1. Memes regles que le socle : AUCUNE persistance, `networkMode: "always"` (hors ligne, la requete echoue et la
 * page le dit), aucune relance automatique. Apres chaque ecriture, on invalide et on relit : aucun etat n'est devine.
 */

const OPTIONS = { networkMode: "always" as const, retry: false, refetchOnWindowFocus: false };
const OPTIONS_ECRITURE = { networkMode: "always" as const, retry: false };
const T = "territoires";

/** Arbre des territoires du perimetre du compte (pages successives, bornees). `actif` : chargement a la demande (selecteur ouvert). */
export function useArbreTerritoires(actif = true) {
  const q = useQuery({ queryKey: [...CLE, T, "arbre"], queryFn: ({ signal }) => chargerArbreTerritoires(signal), enabled: actif, staleTime: 60_000, ...OPTIONS });
  const parId = useMemo(() => new Map<string, Territoire>((q.data?.territoires ?? []).map((t) => [t.id, t])), [q.data]);
  return { ...q, parId };
}

/** Recherche serveur (`q`) : utilisee quand l'arbre charge est tronque. */
export function useRechercheTerritoires(q: string, actif: boolean) {
  return useQuery({
    queryKey: [...CLE, T, "recherche", q],
    queryFn: ({ signal }) => listerTerritoires({ q, limite: 100 }, signal),
    enabled: actif && q.trim().length >= 2,
    staleTime: 30_000,
    ...OPTIONS,
  });
}

export function useFicheTerritoire(tid: string | null | undefined) {
  return useQuery({ queryKey: [...CLE, T, "fiche", tid], queryFn: ({ signal }) => lireTerritoireFiche(tid as string, signal), enabled: !!tid, ...OPTIONS });
}

function useInvalidationT1() {
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: [...CLE, T] }),
    qc.invalidateQueries({ queryKey: [...CLE, "liste"] }),
  ]);
}

export function useCreerTerritoire() {
  const inv = useInvalidationT1();
  return useMutation({ mutationFn: (c: CorpsTerritoire) => creerTerritoire(c), onSuccess: () => inv(), ...OPTIONS_ECRITURE });
}

export function useModifierTerritoire() {
  const inv = useInvalidationT1();
  return useMutation({ mutationFn: ({ tid, corps }: { tid: string; corps: CorpsModifTerritoire }) => modifierTerritoire(tid, corps), onSuccess: () => inv(), ...OPTIONS_ECRITURE });
}

export function useRetirerTerritoire() {
  const inv = useInvalidationT1();
  return useMutation({ mutationFn: (tid: string) => retirerTerritoire(tid), onSuccess: () => inv(), ...OPTIONS_ECRITURE });
}

/**
 * Valeurs d'un domaine de referentiel. `tous` : actives ET desactivees (necessaire pour AFFICHER une valeur desactivee portee par un objet, et pour
 * l'administration) ; les listes de choix ne proposent que les actives (`optionsDeChoix`).
 */
export function useReferentiel(domaine: DomaineReferentiel, actif = true, tous = true) {
  return useQuery({
    queryKey: [...CLE, "referentiels", domaine, tous],
    queryFn: ({ signal }) => listerValeurs(domaine, tous, signal),
    enabled: actif,
    staleTime: 60_000,
    ...OPTIONS,
  });
}

function useInvalidationReferentiel() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: [...CLE, "referentiels"] });
}

export function useCreerValeur(domaine: DomaineReferentiel) {
  const inv = useInvalidationReferentiel();
  return useMutation({ mutationFn: (c: CorpsValeur) => creerValeur(domaine, c), onSuccess: () => inv(), ...OPTIONS_ECRITURE });
}

export function useModifierValeur(domaine: DomaineReferentiel) {
  const inv = useInvalidationReferentiel();
  return useMutation({ mutationFn: ({ code, corps }: { code: string; corps: Partial<Omit<CorpsValeur, "code">> }) => modifierValeur(domaine, code, corps), onSuccess: () => inv(), ...OPTIONS_ECRITURE });
}

export function useRetirerValeur(domaine: DomaineReferentiel) {
  const inv = useInvalidationReferentiel();
  return useMutation({ mutationFn: (code: string) => retirerValeur(domaine, code), onSuccess: () => inv(), ...OPTIONS_ECRITURE });
}

export function useConfiguration(actif = true) {
  return useQuery({ queryKey: [...CLE, "configuration"], queryFn: ({ signal }) => chargerConfiguration(signal), enabled: actif, ...OPTIONS });
}

export function useEcrireConfiguration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ cle, valeur, justification }: { cle: string; valeur: Record<string, unknown>; justification: string }) => ecrireConfiguration(cle, valeur, justification),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...CLE, "configuration"] }),
    ...OPTIONS_ECRITURE,
  });
}

export function useRegions(actif = true) {
  return useQuery({ queryKey: ["regions", "projets-voirie"], queryFn: ({ signal }) => listerRegions(signal), enabled: actif, staleTime: 300_000, ...OPTIONS });
}
