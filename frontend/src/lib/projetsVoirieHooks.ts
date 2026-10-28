import { useEffect, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  autoriserJeu, rejeterJeu, chargerAnalyse, chargerCarte, creerConcessionnaire, creerProjet, deposerJeu, listerConcessionnaires, listerProjets, lireProjet, modifierProjet, retirerJeu,
  type CorpsProjet, type DonneesDepot, type ParamsCarte,
} from "./projetsVoirieApi";
import type { Largeurs } from "./projetsVoirie";

/**
 * Requetes React Query du module « Projets de voirie ». Les donnees de concessionnaires sont sensibles : AUCUNE persistance
 * (pas de `persistQueryClient`, pas de stockage local). Tout vit dans la memoire de la page, et `gcTime` borne sa duree.
 *
 * `networkMode: "always"` : hors ligne, la requete echoue et la page le DIT (bandeau « ce module a besoin du reseau »), au lieu de rester
 * en pause sans explication.
 */

export const CLE = ["projets-voirie"] as const;
const OPTIONS = { networkMode: "always" as const, retry: false, refetchOnWindowFocus: false };

export function useProjets(q: string) {
  return useInfiniteQuery({
    queryKey: [...CLE, "liste", q],
    queryFn: ({ pageParam }) => listerProjets({ q, curseur: pageParam, limite: 25 }),
    initialPageParam: null as string | null,
    getNextPageParam: (derniere) => derniere.suivant,
    ...OPTIONS,
  });
}

export function useProjet(id: string | undefined) {
  return useQuery({ queryKey: [...CLE, "projet", id], queryFn: () => lireProjet(id as string), enabled: !!id, ...OPTIONS });
}

export function useConcessionnaires(actif = true) {
  return useQuery({ queryKey: [...CLE, "concessionnaires"], queryFn: listerConcessionnaires, enabled: actif, ...OPTIONS });
}

/** Analyse : `largeurs` non nul = previsualisation (non enregistree). La cle porte les largeurs : un autre apercu est une autre requete. */
export function useAnalyse(id: string | undefined, largeurs: Largeurs | null, inclureNonAutorises = false) {
  return useQuery({
    queryKey: [...CLE, "analyse", id, largeurs?.largeurEmpriseM ?? null, largeurs?.largeurChausseeM ?? null, inclureNonAutorises],
    queryFn: () => chargerAnalyse(id as string, largeurs, inclureNonAutorises),
    enabled: !!id,
    placeholderData: keepPreviousData,
    ...OPTIONS,
  });
}

/** Carte : une requete par jeu coche, emprise et zoom. L'ancienne vue reste affichee pendant le chargement de la suivante. */
export function useCarte(id: string | undefined, p: ParamsCarte, actif: boolean) {
  return useQuery({
    queryKey: [...CLE, "carte", id, [...p.jeux].sort().join(","), p.bbox?.join(",") ?? null, p.zoom, p.inclureNonAutorises === true],
    queryFn: ({ signal }) => chargerCarte(id as string, p, signal),
    enabled: !!id && actif && p.jeux.length > 0,
    placeholderData: keepPreviousData,
    gcTime: 60_000,
    ...OPTIONS,
  });
}

/** Invalide tout ce qui depend des jeux d'un projet (fiche, carte, analyse). */
export function useInvalidationProjet() {
  const qc = useQueryClient();
  return (id: string) => Promise.all([
    qc.invalidateQueries({ queryKey: [...CLE, "projet", id] }),
    qc.invalidateQueries({ queryKey: [...CLE, "carte", id] }),
    qc.invalidateQueries({ queryKey: [...CLE, "analyse", id] }),
    qc.invalidateQueries({ queryKey: [...CLE, "liste"] }),
  ]);
}

export function useCreerProjet() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (c: CorpsProjet) => creerProjet(c), onSuccess: () => qc.invalidateQueries({ queryKey: [...CLE, "liste"] }) });
}

export function useModifierProjet(id: string) {
  const invalider = useInvalidationProjet();
  return useMutation({
    mutationFn: (c: Parameters<typeof modifierProjet>[1]) => modifierProjet(id, c),
    onSuccess: () => invalider(id),
  });
}

export function useCreerConcessionnaire() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (c: Parameters<typeof creerConcessionnaire>[0]) => creerConcessionnaire(c),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...CLE, "concessionnaires"] }),
  });
}

/** Simulation : ne change rien cote serveur, donc n'invalide rien. */
export function useSimulerDepot(id: string) {
  return useMutation({
    mutationFn: ({ donnees, onProgression }: { donnees: DonneesDepot; onProgression?: (e: number, t: number | null) => void }) =>
      deposerJeu(id, donnees, { simuler: true, onProgression }),
  });
}

export function useEcrireDepot(id: string) {
  const invalider = useInvalidationProjet();
  return useMutation({
    mutationFn: ({ donnees, onProgression }: { donnees: DonneesDepot; onProgression?: (e: number, t: number | null) => void }) =>
      deposerJeu(id, donnees, { simuler: false, onProgression }),
    onSuccess: () => invalider(id),
  });
}

/** Autorisation ou rejet d'un jeu en quarantaine : justification obligatoire (10 caracteres minimum), consignee par le serveur. */
export function useDecisionJeu(id: string) {
  const invalider = useInvalidationProjet();
  return useMutation({
    mutationFn: ({ jeuId, decision, justification }: { jeuId: string; decision: "autoriser" | "rejeter"; justification: string }) =>
      (decision === "autoriser" ? autoriserJeu : rejeterJeu)(id, jeuId, justification),
    onSuccess: () => invalider(id),
  });
}

export function useRetirerJeu(id: string) {
  const invalider = useInvalidationProjet();
  return useMutation({ mutationFn: (jeuId: string) => retirerJeu(id, jeuId), onSuccess: () => invalider(id) });
}

/** Vrai tant que le navigateur se dit en ligne. Hors ligne : ce module (donnees sensibles, jamais en cache) ne peut rien afficher de nouveau. */
export function useEnLigne(): boolean {
  const [enLigne, setEnLigne] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
  useEffect(() => {
    const on = () => setEnLigne(true);
    const off = () => setEnLigne(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  return enLigne;
}

/** Valeur differee (saisie, deplacement de carte) : une requete par pause, pas une par evenement. */
export function useValeurDifferee<T>(valeur: T, delaiMs: number): T {
  const [v, setV] = useState(valeur);
  useEffect(() => {
    const t = setTimeout(() => setV(valeur), delaiMs);
    return () => clearTimeout(t);
  }, [valeur, delaiMs]);
  return v;
}
