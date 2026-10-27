import { useEffect, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import {
  affecterAUneInspection, ApercuIllisible, classerErreur, estErreurAutorisation, lirePropositionsGeo, lireProposition, lirePropositions,
  lireApercu, lireQualiteMethodes, lireSources, lireSynthese, poserTransition, verifierSource,
  type CorpsTransition, type Emprise, type ErreurTd, type FiltresPropositions, type FiltresSynthese,
} from "./teledetectionApi";

/**
 * Un hook React Query par ressource. Cles stables sous `["teledetection", ...]` : une ecriture
 * invalide la famille entiere et chaque panneau se rafraichit, sans qu'un compteur garde une
 * valeur d'avant le verdict.
 *
 * `retry` : un refus d'autorisation (401, 403) ne se retente JAMAIS (rejouer ne change rien et
 * retarde l'affichage du refus) ; le reste est retente une seule fois.
 */

export const CLE = "teledetection";

function retenter(nb: number, e: unknown): boolean {
  if (estErreurAutorisation(e)) return false;
  const g = classerErreur(e).genre;
  if (g === "introuvable" || g === "entree" || g === "conflit") return false;
  return nb < 1;
}
const OPTIONS_LECTURE = { retry: retenter, retryDelay: 400, staleTime: 30_000, refetchOnWindowFocus: false } as const;

export function useSynthese(f: FiltresSynthese) {
  return useQuery({ queryKey: [CLE, "synthese", f], queryFn: () => lireSynthese(f), ...OPTIONS_LECTURE });
}

export function usePropositionsListe(f: FiltresPropositions) {
  return useInfiniteQuery({
    queryKey: [CLE, "propositions", f],
    queryFn: ({ pageParam }) => lirePropositions(f, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (derniere) => derniere.suivant ?? undefined,
    ...OPTIONS_LECTURE,
  });
}

export function usePropositionsGeo(bbox: Emprise | null, f: { statut?: string; type?: string; priorite?: string }, actif: boolean) {
  return useQuery({
    queryKey: [CLE, "geojson", bbox, f],
    queryFn: () => lirePropositionsGeo(bbox as Emprise, f),
    enabled: actif && bbox !== null,
    placeholderData: keepPreviousData,
    ...OPTIONS_LECTURE,
  });
}

export function usePropositionDetail(id: string | null) {
  return useQuery({
    queryKey: [CLE, "detail", id],
    queryFn: () => lireProposition(id as string),
    enabled: id !== null,
    ...OPTIONS_LECTURE,
  });
}

/** Verdicts par methode : agregat NATIONAL (403 HORS_PERIMETRE pour un compte regional, jamais retente : c'est un etat, pas une panne). */
export function useQualiteMethodes() {
  return useQuery({ queryKey: [CLE, "qualite-methodes"], queryFn: lireQualiteMethodes, ...OPTIONS_LECTURE });
}

export function useSources() {
  return useQuery({ queryKey: [CLE, "sources"], queryFn: lireSources, ...OPTIONS_LECTURE });
}

/** Liste des regions pour le filtre : meme source que les formulaires du depot (`/regions`). */
export function useRegions() {
  return useQuery({
    queryKey: ["regions"],
    queryFn: async () => (await api.get<{ id: number; nom: string }[]>("/regions")).data,
    staleTime: 10 * 60_000,
    retry: retenter,
  });
}

export function useTransition(id: string) {
  const qc = useQueryClient();
  return useMutation<unknown, ErreurTd, CorpsTransition>({
    mutationFn: async (corps) => {
      try { return await poserTransition(id, corps); } catch (e) { throw classerErreur(e); }
    },
    // Succes OU refus : dans les deux cas l'etat serveur a pu changer (409 = quelqu'un a juge avant nous).
    onSettled: () => qc.invalidateQueries({ queryKey: [CLE] }),
  });
}

export function useAffectation(id: string) {
  const qc = useQueryClient();
  return useMutation<{ code?: string }, ErreurTd, void>({
    mutationFn: async () => {
      try { return await affecterAUneInspection(id); } catch (e) { throw classerErreur(e); }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: [CLE] }),
  });
}

export function useVerificationSource() {
  const qc = useQueryClient();
  return useMutation<unknown, ErreurTd, string>({
    mutationFn: async (code) => {
      try { return await verifierSource(code); } catch (e) { throw classerErreur(e); }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: [CLE, "sources"] }).then(() => qc.invalidateQueries({ queryKey: [CLE, "synthese"] })),
  });
}

/**
 * `indisponible` : l'URL existe mais le serveur dit 404 APERCU_INDISPONIBLE (le fournisseur n'a pas rendu d'image) ;
 * `illisible` : le serveur a repondu 200 mais le contenu n'est pas une image ; `erreur` : tout autre echec.
 */
export type EtatApercu = "aucun" | "chargement" | "pret" | "indisponible" | "illisible" | "erreur";

/**
 * Charge un apercu servi derriere l'authentification et le rend en URL de blob. `url` nul = pas
 * d'apercu : l'etat est « aucun », jamais une image de remplacement (contrat, principe 7). Un 404
 * `APERCU_INDISPONIBLE` est un etat a part (« indisponible chez le fournisseur »), pas l'erreur generique.
 */
export function useApercu(url: string | null | undefined): { src: string | null; etat: EtatApercu } {
  const [resultat, setResultat] = useState<{ pour: string; src: string } | { pour: string; erreur: "indisponible" | "illisible" | "autre" } | null>(null);
  useEffect(() => {
    if (!url) return;
    let annule = false;
    let objet: string | null = null;
    lireApercu(url).then(
      (blob) => {
        objet = URL.createObjectURL(blob);
        if (annule) { URL.revokeObjectURL(objet); return; }
        setResultat({ pour: url, src: objet });
      },
      (e: unknown) => {
        if (annule) return;
        if (e instanceof ApercuIllisible) { setResultat({ pour: url, erreur: "illisible" }); return; }
        const t = classerErreur(e);
        setResultat({ pour: url, erreur: t.status === 404 && t.code === "APERCU_INDISPONIBLE" ? "indisponible" : "autre" });
      },
    );
    return () => { annule = true; if (objet) URL.revokeObjectURL(objet); };
  }, [url]);
  if (!url) return { src: null, etat: "aucun" };
  if (!resultat || resultat.pour !== url) return { src: null, etat: "chargement" };
  if ("erreur" in resultat) return { src: null, etat: resultat.erreur === "autre" ? "erreur" : resultat.erreur };
  return { src: resultat.src, etat: "pret" };
}

/** Valeur differee : evite une requete a chaque frappe ou a chaque deplacement de la carte. */
export function useValeurDifferee<T>(valeur: T, delaiMs: number): T {
  const [v, setV] = useState(valeur);
  useEffect(() => {
    const t = setTimeout(() => setV(valeur), delaiMs);
    return () => clearTimeout(t);
  }, [valeur, delaiMs]);
  return v;
}
