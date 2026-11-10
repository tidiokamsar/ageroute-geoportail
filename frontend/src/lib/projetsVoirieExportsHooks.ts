import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CLE } from "./projetsVoirieHooks";
import {
  accorderDerogation, journalExports, listerComptesBeneficiaires, listerDerogations, listerMesDerogations, tableauNational, tableauTerritoire, type CorpsDerogation,
} from "./projetsVoirieExportsApi";

/**
 * Requetes React Query du lot X1. Aucune persistance, aucune relance automatique (un export compte dans la cadence, meme en echec : il ne se
 * relance jamais seul). L'export lui-meme n'est PAS une requete React Query : l'archive ne passe jamais par le cache.
 */

const OPTIONS = { networkMode: "always" as const, retry: false, refetchOnWindowFocus: false };
const X = "exports";

export function useJournalExports(projetId: string | undefined, actif = true) {
  return useQuery({ queryKey: [...CLE, X, "journal", projetId], queryFn: ({ signal }) => journalExports(projetId as string, signal), enabled: !!projetId && actif, ...OPTIONS });
}

export function useDerogations(projetId: string | undefined, actif = true) {
  return useQuery({ queryKey: [...CLE, X, "derogations", projetId], queryFn: ({ signal }) => listerDerogations(projetId as string, signal), enabled: !!projetId && actif, ...OPTIONS });
}

export function useMesDerogations(projetId: string | undefined, actif = true) {
  return useQuery({ queryKey: [...CLE, X, "mes-derogations", projetId], queryFn: ({ signal }) => listerMesDerogations(projetId as string, signal), enabled: !!projetId && actif, ...OPTIONS });
}

export function useComptesBeneficiaires(actif: boolean) {
  return useQuery({ queryKey: [...CLE, X, "beneficiaires"], queryFn: ({ signal }) => listerComptesBeneficiaires(signal), enabled: actif, ...OPTIONS });
}

export function useAccorderDerogation(projetId: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (c: CorpsDerogation) => accorderDerogation(projetId, c), onSuccess: () => qc.invalidateQueries({ queryKey: [...CLE, X] }), networkMode: "always", retry: false });
}

export function useInvalidationExports() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: [...CLE, X] });
}

export function useTableauDeBord(territoireId: string | null, actif = true) {
  return useQuery({
    queryKey: [...CLE, "tableau-de-bord", territoireId ?? "national"],
    queryFn: ({ signal }) => (territoireId ? tableauTerritoire(territoireId, signal) : tableauNational(signal)),
    enabled: actif,
    ...OPTIONS,
  });
}
