import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ajouterPreuveWorkflow, changerStatutDemande, changerStatutRecolement, changerStatutTache, creerDemande, creerRattachement, creerRecolement, creerTache, lireDemandeFiche, lireMonProfil,
  lireRecolementFiche, lireTacheFiche, listerConflitsVue, listerDemandes, listerJeuxVue, listerRecolements, listerReferents, listerTaches, modifierDemande, modifierRecolement, modifierTache,
  rechercherComptes, revoquerRattachement,
  type CorpsCreationDemande, type CorpsCreationRecolement, type CorpsCreationTache, type CorpsModifDemande, type CorpsModifRecolement, type CorpsModifTache, type CorpsStatutDemande,
  type CorpsStatutRecolement, type CorpsStatutTache,
} from "./projetsVoirieWorkflowApi";
import type { CorpsPreuveWorkflow, FiltresDemandes, FiltresRecolements, FiltresTaches, ObjetWorkflow } from "./projetsVoirieWorkflow";
import type { StatutConflit } from "./projetsVoirieConflits";
import { CLE } from "./projetsVoirieHooks";

/**
 * Requetes React Query du workflow concessionnaire. Memes regles que le socle : AUCUNE persistance (les echanges avec les concessionnaires sont sensibles),
 * `networkMode: "always"` pour qu'une coupure soit DITE, aucune relance automatique. Le serveur est la source : apres chaque ecriture on invalide et on relit.
 */

const OPTIONS = { networkMode: "always" as const, retry: false, refetchOnWindowFocus: false };
const W = "workflow";

/** Profil de workflow du compte : une seule fois par session de page, relu a la demande (les droits viennent du serveur). */
export function useMonProfil() {
  return useQuery({ queryKey: [...CLE, W, "profil"], queryFn: ({ signal }) => lireMonProfil(signal), staleTime: 30_000, gcTime: 60_000, ...OPTIONS });
}

export function useDemandes(projetId: string | undefined, f: FiltresDemandes, actif = true) {
  return useInfiniteQuery({
    queryKey: [...CLE, W, "demandes", projetId, f.statut, f.concessionnaireId, f.echeanceDepassee],
    queryFn: ({ pageParam, signal }) => listerDemandes(projetId as string, f, pageParam, signal),
    initialPageParam: null as string | null, getNextPageParam: (d) => d.suivant, enabled: !!projetId && actif, staleTime: 15_000, gcTime: 60_000, ...OPTIONS,
  });
}
export function useFicheDemande(projetId: string | undefined, demandeId: string | null) {
  return useQuery({ queryKey: [...CLE, W, "demande", projetId, demandeId], queryFn: ({ signal }) => lireDemandeFiche(projetId as string, demandeId as string, signal), enabled: !!projetId && !!demandeId, gcTime: 60_000, ...OPTIONS });
}

export function useTaches(projetId: string | undefined, f: FiltresTaches, actif = true) {
  return useInfiniteQuery({
    queryKey: [...CLE, W, "taches", projetId, f.statut, f.responsableId, f.echeanceDepassee],
    queryFn: ({ pageParam, signal }) => listerTaches(projetId as string, f, pageParam, signal),
    initialPageParam: null as string | null, getNextPageParam: (d) => d.suivant, enabled: !!projetId && actif, staleTime: 15_000, gcTime: 60_000, ...OPTIONS,
  });
}
export function useFicheTache(projetId: string | undefined, tacheId: string | null) {
  return useQuery({ queryKey: [...CLE, W, "tache", projetId, tacheId], queryFn: ({ signal }) => lireTacheFiche(projetId as string, tacheId as string, signal), enabled: !!projetId && !!tacheId, gcTime: 60_000, ...OPTIONS });
}

export function useRecolements(projetId: string | undefined, f: FiltresRecolements, actif = true) {
  return useInfiniteQuery({
    queryKey: [...CLE, W, "recolements", projetId, f.statut],
    queryFn: ({ pageParam, signal }) => listerRecolements(projetId as string, f, pageParam, signal),
    initialPageParam: null as string | null, getNextPageParam: (d) => d.suivant, enabled: !!projetId && actif, staleTime: 15_000, gcTime: 60_000, ...OPTIONS,
  });
}
export function useFicheRecolement(projetId: string | undefined, recolementId: string | null) {
  return useQuery({ queryKey: [...CLE, W, "recolement", projetId, recolementId], queryFn: ({ signal }) => lireRecolementFiche(projetId as string, recolementId as string, signal), enabled: !!projetId && !!recolementId, gcTime: 60_000, ...OPTIONS });
}

export function useReferents(projetId: string | undefined, actif: boolean) {
  return useQuery({ queryKey: [...CLE, W, "referents", projetId], queryFn: ({ signal }) => listerReferents(projetId as string, signal), enabled: !!projetId && actif, gcTime: 60_000, ...OPTIONS });
}
export function useJeuxVue(projetId: string | undefined, actif: boolean) {
  return useQuery({ queryKey: [...CLE, W, "jeux", projetId], queryFn: ({ signal }) => listerJeuxVue(projetId as string, signal), enabled: !!projetId && actif, gcTime: 60_000, ...OPTIONS });
}
/** Dossiers de conflit (vue concessionnaire) : une page, pour les listes de choix et la section « Dossiers et jeux ». */
export function useConflitsVue(projetId: string | undefined, statuts: StatutConflit[], actif: boolean) {
  return useInfiniteQuery({
    queryKey: [...CLE, W, "conflits", projetId, statuts.join(",")],
    queryFn: ({ pageParam, signal }) => listerConflitsVue(projetId as string, statuts, pageParam, signal),
    initialPageParam: null as string | null, getNextPageParam: (d) => d.suivant, enabled: !!projetId && actif, staleTime: 15_000, gcTime: 60_000, ...OPTIONS,
  });
}
export function useRechercheComptes(q: string, actif: boolean) {
  return useQuery({ queryKey: [...CLE, W, "comptes", q.trim()], queryFn: ({ signal }) => rechercherComptes(q, signal), enabled: actif, gcTime: 30_000, ...OPTIONS });
}

/** Une ecriture du workflow touche les listes, les fiches, les compteurs et les listes de choix (pas le profil, ni la recherche de comptes). */
function useEcriture<V>(ecrire: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    networkMode: "always",
    retry: false,
    mutationFn: ecrire,
    onSuccess: () => qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === CLE[0] && q.queryKey[1] === W && q.queryKey[2] !== "profil" && q.queryKey[2] !== "comptes" }),
  });
}

export const useCreerDemande = (projetId: string) => useEcriture((c: CorpsCreationDemande) => creerDemande(projetId, c));
export const useModifierDemande = (projetId: string, demandeId: string) => useEcriture((c: CorpsModifDemande) => modifierDemande(projetId, demandeId, c));
export const useStatutDemande = (projetId: string, demandeId: string) => useEcriture((c: CorpsStatutDemande) => changerStatutDemande(projetId, demandeId, c));
export const useCreerTache = (projetId: string) => useEcriture((c: CorpsCreationTache) => creerTache(projetId, c));
export const useModifierTache = (projetId: string, tacheId: string) => useEcriture((c: CorpsModifTache) => modifierTache(projetId, tacheId, c));
export const useStatutTache = (projetId: string, tacheId: string) => useEcriture((c: CorpsStatutTache) => changerStatutTache(projetId, tacheId, c));
export const useCreerRecolement = (projetId: string) => useEcriture((c: CorpsCreationRecolement) => creerRecolement(projetId, c));
export const useModifierRecolement = (projetId: string, recolementId: string) => useEcriture((c: CorpsModifRecolement) => modifierRecolement(projetId, recolementId, c));
export const useStatutRecolement = (projetId: string, recolementId: string) => useEcriture((c: CorpsStatutRecolement) => changerStatutRecolement(projetId, recolementId, c));
export const useAjouterPreuveWorkflow = (projetId: string) => useEcriture((v: { objet: ObjetWorkflow; objetId: string; corps: CorpsPreuveWorkflow }) => ajouterPreuveWorkflow(projetId, v.objet, v.objetId, v.corps));
export const useCreerRattachement = (projetId: string) => useEcriture((c: { userId: string; concessionnaireId: string; motif: string }) => creerRattachement(projetId, c));
export const useRevoquerRattachement = (projetId: string) => useEcriture((v: { rattachementId: string; motif: string }) => revoquerRattachement(projetId, v.rattachementId, v.motif));
