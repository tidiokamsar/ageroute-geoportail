import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  declarerDescripteurObjet, declarerRelationReseau, lireComptage, lireFicheObjet, listerObjetsReseau, listerRelationsReseau, proposerAssociationsReseau, transitionRelationReseau,
  type CorpsRelation,
} from "./projetsVoirieReseauxApi";
import type { ActionRelation, CorpsDescripteur, FiltresObjets, FiltresRelations } from "./projetsVoirieReseaux";
import { CLE } from "./projetsVoirieHooks";

/**
 * Requetes React Query des reseaux physiques et circuits logiques. Memes regles que le socle : AUCUNE persistance (les donnees de concessionnaires sont
 * sensibles), `networkMode: "always"` pour qu'une coupure soit DITE, aucune relance automatique. Le serveur est la source : apres chaque ecriture on
 * invalide et on relit, on ne devine aucun nouvel etat.
 */

const OPTIONS = { networkMode: "always" as const, retry: false, refetchOnWindowFocus: false };
const R = "reseau";
/** Une ecriture ne se met jamais en pause en silence hors ligne : elle part ou elle echoue, et l'ecran dit « vous etes hors ligne ». */
const OPTIONS_ECRITURE = { networkMode: "always" as const, retry: false };

export function useObjetsReseau(projetId: string | undefined, filtres: FiltresObjets, actif = true) {
  return useInfiniteQuery({
    queryKey: [...CLE, R, "objets", projetId, filtres.jeuId, filtres.nature, filtres.typeObjet, filtres.q.trim()],
    queryFn: ({ pageParam, signal }) => listerObjetsReseau(projetId as string, filtres, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (derniere) => derniere.suivant,
    enabled: !!projetId && actif,
    staleTime: 15_000,
    gcTime: 60_000,
    ...OPTIONS,
  });
}

export function useFicheObjetReseau(projetId: string | undefined, objetId: string | null) {
  return useQuery({
    queryKey: [...CLE, R, "fiche", projetId, objetId],
    queryFn: ({ signal }) => lireFicheObjet(projetId as string, objetId as string, signal),
    enabled: !!projetId && !!objetId,
    gcTime: 60_000,
    ...OPTIONS,
  });
}

export function useRelationsReseau(projetId: string | undefined, filtres: FiltresRelations, actif = true) {
  return useInfiniteQuery({
    queryKey: [...CLE, R, "relations", projetId, filtres.statut, filtres.type, filtres.origine, filtres.objetId],
    queryFn: ({ pageParam, signal }) => listerRelationsReseau(projetId as string, filtres, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (derniere) => derniere.suivant,
    enabled: !!projetId && actif,
    staleTime: 15_000,
    gcTime: 60_000,
    ...OPTIONS,
  });
}

/** Comptage : declenche par l'utilisateur (la vue est ouverte), jamais au rendu de la page. */
export function useComptageReseau(projetId: string | undefined, jeuId: string | null, inclureNonAutorises: boolean, actif: boolean) {
  return useQuery({
    queryKey: [...CLE, R, "comptage", projetId, jeuId, inclureNonAutorises],
    queryFn: ({ signal }) => lireComptage(projetId as string, { jeuId, inclureNonAutorises }, signal),
    enabled: !!projetId && actif,
    staleTime: 15_000,
    gcTime: 60_000,
    ...OPTIONS,
  });
}

/** Une ecriture sur les reseaux touche les objets, les relations, le comptage, les dossiers de conflit (nature de la cible) et la carte (nature, classe). */
export function useInvalidationReseau(projetId: string) {
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: [...CLE, R, "objets", projetId] }),
    qc.invalidateQueries({ queryKey: [...CLE, R, "fiche", projetId] }),
    qc.invalidateQueries({ queryKey: [...CLE, R, "relations", projetId] }),
    qc.invalidateQueries({ queryKey: [...CLE, R, "comptage", projetId] }),
    qc.invalidateQueries({ queryKey: [...CLE, "conflits", projetId] }),
    qc.invalidateQueries({ queryKey: [...CLE, "conflit", projetId] }),
    qc.invalidateQueries({ queryKey: [...CLE, "carte", projetId] }),
  ]);
}

export function useDeclarerDescripteur(projetId: string, objetId: string) {
  const invalider = useInvalidationReseau(projetId);
  return useMutation({ ...OPTIONS_ECRITURE, mutationFn: (c: CorpsDescripteur) => declarerDescripteurObjet(projetId, objetId, c), onSuccess: () => invalider() });
}

export function useTransitionRelation(projetId: string) {
  const invalider = useInvalidationReseau(projetId);
  return useMutation({
    ...OPTIONS_ECRITURE,
    mutationFn: ({ relationId, action, justification }: { relationId: string; action: ActionRelation; justification: string }) => transitionRelationReseau(projetId, relationId, action, justification),
    onSuccess: () => invalider(),
  });
}

export function useDeclarerRelation(projetId: string) {
  const invalider = useInvalidationReseau(projetId);
  return useMutation({ ...OPTIONS_ECRITURE, mutationFn: (c: CorpsRelation) => declarerRelationReseau(projetId, c), onSuccess: () => invalider() });
}

/** Propose des associations : le serveur n'en admet qu'une a la fois par projet (503, 429). Les relations creees sont PROPOSEES et n'ont aucun effet. */
export function useProposerAssociations(projetId: string) {
  const invalider = useInvalidationReseau(projetId);
  return useMutation({ ...OPTIONS_ECRITURE, mutationFn: (jeuId: string | null) => proposerAssociationsReseau(projetId, jeuId), onSuccess: () => invalider() });
}
