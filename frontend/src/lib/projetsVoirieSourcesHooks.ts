import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CLE } from "./projetsVoirieHooks";
import {
  approuverRegleRapprochement, creerRegleRapprochement, lancerComparaison, lireComparaisonDetail, lireSources, listerComparaisons, listerReglesRapprochement, listerResultats,
  ouvrirDossierDivergence, type CorpsRegleRapprochement,
} from "./projetsVoirieSourcesApi";
import type { StatutResultat } from "./projetsVoirieSources";

/**
 * Requetes React Query du lot S1. Memes regles que le socle : aucune persistance, `networkMode: "always"`, aucune relance automatique ; apres
 * chaque ecriture on relit le serveur (aucun etat devine).
 */

const OPTIONS = { networkMode: "always" as const, retry: false, refetchOnWindowFocus: false };
const OPTIONS_ECRITURE = { networkMode: "always" as const, retry: false };
const S = "sources";

export function useSources(projetId: string | undefined, actif = true) {
  return useQuery({ queryKey: [...CLE, S, "vue", projetId], queryFn: ({ signal }) => lireSources(projetId as string, signal), enabled: !!projetId && actif, ...OPTIONS });
}

export function useReglesRapprochement(projetId: string | undefined, actif = true) {
  return useQuery({ queryKey: [...CLE, S, "regles", projetId], queryFn: ({ signal }) => listerReglesRapprochement(projetId as string, signal), enabled: !!projetId && actif, ...OPTIONS });
}

export function useComparaisons(projetId: string | undefined, actif = true) {
  return useInfiniteQuery({
    queryKey: [...CLE, S, "comparaisons", projetId],
    queryFn: ({ pageParam, signal }) => listerComparaisons(projetId as string, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (d) => d.suivant,
    enabled: !!projetId && actif,
    ...OPTIONS,
  });
}

export function useComparaison(projetId: string | undefined, cmpId: string | null) {
  return useQuery({ queryKey: [...CLE, S, "comparaison", projetId, cmpId], queryFn: ({ signal }) => lireComparaisonDetail(projetId as string, cmpId as string, signal), enabled: !!projetId && !!cmpId, ...OPTIONS });
}

export function useResultats(projetId: string | undefined, cmpId: string | null, statuts: readonly StatutResultat[]) {
  return useInfiniteQuery({
    queryKey: [...CLE, S, "resultats", projetId, cmpId, [...statuts].sort().join(",")],
    queryFn: ({ pageParam, signal }) => listerResultats(projetId as string, cmpId as string, statuts, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (d) => d.suivant,
    enabled: !!projetId && !!cmpId,
    ...OPTIONS,
  });
}

function useInvalidationSources(projetId: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: [...CLE, S] }).then(() => qc.invalidateQueries({ queryKey: [...CLE, "conflits", projetId] }));
}

export function useCreerRegleRapprochement(projetId: string) {
  const inv = useInvalidationSources(projetId);
  return useMutation({ mutationFn: (c: CorpsRegleRapprochement) => creerRegleRapprochement(projetId, c), onSuccess: () => inv(), ...OPTIONS_ECRITURE });
}

export function useApprouverRegleRapprochement(projetId: string) {
  const inv = useInvalidationSources(projetId);
  return useMutation({ mutationFn: ({ regleId, justification }: { regleId: string; justification: string }) => approuverRegleRapprochement(projetId, regleId, justification), onSuccess: () => inv(), ...OPTIONS_ECRITURE });
}

export function useLancerComparaison(projetId: string) {
  const inv = useInvalidationSources(projetId);
  return useMutation({ mutationFn: ({ jeuAId, jeuBId }: { jeuAId: string; jeuBId: string }) => lancerComparaison(projetId, jeuAId, jeuBId), onSuccess: () => inv(), ...OPTIONS_ECRITURE });
}

export function useOuvrirDossierDivergence(projetId: string) {
  const inv = useInvalidationSources(projetId);
  return useMutation({
    mutationFn: ({ cmpId, resultatId, justification }: { cmpId: string; resultatId: string; justification: string }) => ouvrirDossierDivergence(projetId, cmpId, resultatId, justification),
    onSuccess: () => inv(),
    ...OPTIONS_ECRITURE,
  });
}
