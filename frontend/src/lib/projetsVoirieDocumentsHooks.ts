import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CLE } from "./projetsVoirieHooks";
import {
  changerStatutDocument, creerDocument, deposerPieceDocument, lireCompletudeProjet, lireDocumentFiche, listerDocuments, nouvelleVersionDocument, retirerDocument,
  type CreationDocument, type FiltresDocuments, type PieceSaisie,
} from "./projetsVoirieDocumentsApi";
import type { StatutDocument } from "./projetsVoirieDocuments";

/**
 * Requetes React Query du lot D1. Memes regles que le socle : aucune persistance, `networkMode: "always"`, aucune relance automatique ; apres
 * chaque ecriture on relit le serveur (liste, fiche, complétude, tableaux de bord) : aucun etat devine.
 */

const OPTIONS = { networkMode: "always" as const, retry: false, refetchOnWindowFocus: false };
const OPTIONS_ECRITURE = { networkMode: "always" as const, retry: false };
const D = "documents";

export function useDocuments(projetId: string | undefined, f: FiltresDocuments, actif = true) {
  return useInfiniteQuery({
    queryKey: [...CLE, D, "liste", projetId, f.versions, [...f.statuts].sort().join(","), f.typeCode ?? ""],
    queryFn: ({ pageParam, signal }) => listerDocuments(projetId as string, f, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (d) => d.suivant,
    enabled: !!projetId && actif,
    ...OPTIONS,
  });
}

export function useFicheDocument(projetId: string | undefined, docId: string | null) {
  return useQuery({ queryKey: [...CLE, D, "fiche", projetId, docId], queryFn: ({ signal }) => lireDocumentFiche(projetId as string, docId as string, signal), enabled: !!projetId && !!docId, ...OPTIONS });
}

export function useCompletude(projetId: string | undefined, actif = true) {
  return useQuery({ queryKey: [...CLE, D, "completude", projetId], queryFn: ({ signal }) => lireCompletudeProjet(projetId as string, signal), enabled: !!projetId && actif, ...OPTIONS });
}

function useInvalidationDocuments() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: [...CLE, D] }).then(() => qc.invalidateQueries({ queryKey: [...CLE, "tableau-de-bord"] }));
}

export function useCreerDocument(projetId: string) {
  const inv = useInvalidationDocuments();
  return useMutation({ mutationFn: ({ d, piece }: { d: CreationDocument; piece: PieceSaisie }) => creerDocument(projetId, d, piece), onSuccess: () => inv(), ...OPTIONS_ECRITURE });
}

export function useDeposerPiece(projetId: string) {
  const inv = useInvalidationDocuments();
  return useMutation({ mutationFn: ({ docId, piece }: { docId: string; piece: PieceSaisie }) => deposerPieceDocument(projetId, docId, piece), onSuccess: () => inv(), ...OPTIONS_ECRITURE });
}

export function useNouvelleVersion(projetId: string) {
  const inv = useInvalidationDocuments();
  return useMutation({ mutationFn: ({ docId, piece }: { docId: string; piece: PieceSaisie }) => nouvelleVersionDocument(projetId, docId, piece), onSuccess: () => inv(), ...OPTIONS_ECRITURE });
}

export function useChangerStatutDocument(projetId: string) {
  const inv = useInvalidationDocuments();
  return useMutation({
    mutationFn: ({ docId, statut, justification }: { docId: string; statut: StatutDocument; justification: string | null }) => changerStatutDocument(projetId, docId, statut, justification),
    onSuccess: () => inv(),
    ...OPTIONS_ECRITURE,
  });
}

export function useRetirerDocument(projetId: string) {
  const inv = useInvalidationDocuments();
  return useMutation({ mutationFn: ({ docId, justification }: { docId: string; justification: string }) => retirerDocument(projetId, docId, justification), onSuccess: () => inv(), ...OPTIONS_ECRITURE });
}
