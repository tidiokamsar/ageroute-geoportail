import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ajouterPreuve, approuverDecision, approuverRegle, attribuerConflit, changerStatutConflit, comparerAnalyses, creerRegle, lancerAnalyseConflits, lireConflit, lireDetailAnalyse,
  listerAnalyses, listerConflits, listerRegles, proposerDecision, refuserDecision,
  type CorpsApprobation, type CorpsAttribution, type CorpsDecision, type CorpsPreuve, type CorpsRegle, type CorpsStatut,
} from "./projetsVoirieConflitsApi";
import type { FiltresConflits } from "./projetsVoirieConflits";
import { CLE } from "./projetsVoirieHooks";

/**
 * Requetes React Query des dossiers de conflit. Memes regles que le socle : AUCUNE persistance (les geometries et les dossiers sont des donnees
 * sensibles), `networkMode: "always"` pour qu'une coupure de reseau soit DITE, pas mise en pause sans explication, aucune relance automatique.
 *
 * Le serveur est la source : apres chaque ecriture on invalide et on relit (fiche, liste, compteurs), on ne devine aucun nouvel etat.
 */

const OPTIONS = { networkMode: "always" as const, retry: false, refetchOnWindowFocus: false };

/** Le tri est cote client : il ne fait pas partie de la cle de requete. */
const cleFiltres = (f: FiltresConflits) => [f.statut, f.type, f.axe.trim(), f.concessionnaireId, f.responsableId, f.aReexaminer, f.echeanceDepassee, f.q.trim()];

export function useListeConflits(projetId: string | undefined, filtres: FiltresConflits, actif = true) {
  return useInfiniteQuery({
    queryKey: [...CLE, "conflits", projetId, ...cleFiltres(filtres)],
    queryFn: ({ pageParam, signal }) => listerConflits(projetId as string, filtres, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (derniere) => derniere.suivant,
    enabled: !!projetId && actif,
    staleTime: 15_000,
    gcTime: 60_000,
    ...OPTIONS,
  });
}

export function useFicheConflit(projetId: string | undefined, conflitId: string | null) {
  return useQuery({
    queryKey: [...CLE, "conflit", projetId, conflitId],
    queryFn: ({ signal }) => lireConflit(projetId as string, conflitId as string, signal),
    enabled: !!projetId && !!conflitId,
    gcTime: 60_000,
    ...OPTIONS,
  });
}

export function useAnalysesConflits(projetId: string | undefined, actif = true) {
  return useQuery({ queryKey: [...CLE, "analyses", projetId], queryFn: ({ signal }) => listerAnalyses(projetId as string, signal), enabled: !!projetId && actif, gcTime: 60_000, ...OPTIONS });
}

export function useDetailAnalyse(projetId: string | undefined, analyseId: string | null) {
  return useQuery({ queryKey: [...CLE, "analyse-conflit", projetId, analyseId], queryFn: ({ signal }) => lireDetailAnalyse(projetId as string, analyseId as string, signal), enabled: !!projetId && !!analyseId, gcTime: 60_000, ...OPTIONS });
}

/** Comparaison : declenchee par l'utilisateur (`actif`), jamais au rendu. */
export function useComparaison(projetId: string | undefined, recente: string | null, reference: string | null) {
  return useQuery({
    queryKey: [...CLE, "comparaison", projetId, recente, reference],
    queryFn: ({ signal }) => comparerAnalyses(projetId as string, recente as string, reference as string, signal),
    enabled: !!projetId && !!recente && !!reference,
    gcTime: 60_000,
    ...OPTIONS,
  });
}

export function useRegles(projetId: string | undefined, actif = true) {
  return useQuery({ queryKey: [...CLE, "regles", projetId], queryFn: ({ signal }) => listerRegles(projetId as string, signal), enabled: !!projetId && actif, gcTime: 60_000, ...OPTIONS });
}

/** Invalide tout ce que touche un dossier : liste, compteurs, fiche. */
export function useInvalidationConflits(projetId: string) {
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: [...CLE, "conflits", projetId] }),
    qc.invalidateQueries({ queryKey: [...CLE, "conflit", projetId] }),
  ]);
}

export function useAttribuer(projetId: string, conflitId: string) {
  const invalider = useInvalidationConflits(projetId);
  return useMutation({ mutationFn: (c: CorpsAttribution) => attribuerConflit(projetId, conflitId, c), onSuccess: () => invalider() });
}

export function useChangerStatut(projetId: string, conflitId: string) {
  const invalider = useInvalidationConflits(projetId);
  return useMutation({ mutationFn: (c: CorpsStatut) => changerStatutConflit(projetId, conflitId, c), onSuccess: () => invalider() });
}

export function useAjouterPreuve(projetId: string, conflitId: string) {
  const invalider = useInvalidationConflits(projetId);
  return useMutation({ mutationFn: (c: CorpsPreuve) => ajouterPreuve(projetId, conflitId, c), onSuccess: () => invalider() });
}

export function useProposerDecision(projetId: string, conflitId: string) {
  const invalider = useInvalidationConflits(projetId);
  return useMutation({ mutationFn: (c: CorpsDecision) => proposerDecision(projetId, conflitId, c), onSuccess: () => invalider() });
}

export function useDecider(projetId: string, conflitId: string) {
  const invalider = useInvalidationConflits(projetId);
  return useMutation({
    mutationFn: ({ decisionId, verdict, corps }: { decisionId: string; verdict: "approuver" | "refuser"; corps: CorpsApprobation }) =>
      (verdict === "approuver" ? approuverDecision : refuserDecision)(projetId, conflitId, decisionId, corps),
    onSuccess: () => invalider(),
  });
}

/** Lancement d'une analyse : le serveur n'en admet qu'une a la fois par projet (503 PROJET_OCCUPE). Rafraichit les conflits ET l'historique. */
export function useLancerAnalyse(projetId: string) {
  const qc = useQueryClient();
  const invalider = useInvalidationConflits(projetId);
  return useMutation({
    mutationFn: () => lancerAnalyseConflits(projetId),
    onSuccess: () => Promise.all([invalider(), qc.invalidateQueries({ queryKey: [...CLE, "analyses", projetId] })]),
  });
}

export function useCreerRegle(projetId: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (c: CorpsRegle) => creerRegle(projetId, c), onSuccess: () => qc.invalidateQueries({ queryKey: [...CLE, "regles", projetId] }) });
}

export function useApprouverRegle(projetId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ regleId, corps }: { regleId: string; corps: { justification: string; derogation?: string } }) => approuverRegle(projetId, regleId, corps),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...CLE, "regles", projetId] }),
  });
}
