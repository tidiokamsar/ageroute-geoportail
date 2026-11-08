import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CLE } from "./projetsVoirieHooks";
import { classerErreur, type ErreurPv } from "./projetsVoirie";
import { chargerOptionsImport, type OptionsEnvoi } from "./projetsVoirieImportApi";

/**
 * Crochets de l'assistant d'import.
 *
 * Les options de l'API (formats, limites, CRS autorises) sont lues UNE fois par ouverture de l'assistant et vivent dans la memoire de React Query
 * (pas de persistance, `gcTime` court). Les envois de fichier, eux, ne passent PAS par React Query : un envoi est unique, annulable, et ne doit
 * jamais etre rejoue ni mis en cache automatiquement.
 */

export function useOptionsImport(projetId: string, actif: boolean) {
  return useQuery({
    queryKey: [...CLE, "import-options", projetId],
    queryFn: ({ signal }) => chargerOptionsImport(projetId, signal),
    enabled: actif,
    networkMode: "always",
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
    gcTime: 60_000,
  });
}

export interface EtatEnvoi {
  /** Nom de l'operation en cours (`null` : rien en cours). */
  nom: string | null;
  /** Avancement de l'envoi du fichier, 0 a 100 ; `null` : taille inconnue. */
  progression: number | null;
  /** Vrai quand tout le fichier est parti : le serveur lit, controle et repond. */
  envoye: boolean;
}

export type IssueEnvoi<T> =
  | { statut: "ok"; valeur: T }
  | { statut: "erreur"; erreur: ErreurPv }
  | { statut: "annule" }
  /** Un envoi etait deja en cours : celui-ci n'est pas parti (jamais de double envoi). */
  | { statut: "ignore" };

/**
 * Un seul envoi a la fois, annulable par AbortController. `lancer` rend l'issue sans jamais lever. Le verrou est une reference (synchrone) :
 * deux clics rapproches ne partent pas deux fois, meme avant le rendu qui desactive le bouton. A la fermeture de l'assistant, l'envoi en
 * cours est annule.
 */
export function useEnvoi() {
  const controleur = useRef<AbortController | null>(null);
  const [etat, setEtat] = useState<EtatEnvoi>({ nom: null, progression: null, envoye: false });

  // Demontage (et double montage de StrictMode en developpement) : l'envoi en cours est annule et le verrou rendu tout de suite.
  useEffect(() => () => { controleur.current?.abort(); controleur.current = null; }, []);

  const lancer = useCallback(async <T,>(nom: string, f: (o: OptionsEnvoi) => Promise<T>): Promise<IssueEnvoi<T>> => {
    if (controleur.current) return { statut: "ignore" };
    const c = new AbortController();
    controleur.current = c;
    setEtat({ nom, progression: 0, envoye: false });
    try {
      const valeur = await f({
        signal: c.signal,
        onProgression: (envoye, total) => {
          const p = total ? Math.min(100, Math.round((envoye / total) * 100)) : null;
          setEtat({ nom, progression: p, envoye: p !== null && p >= 100 });
        },
      });
      return { statut: "ok", valeur };
    } catch (e) {
      const erreur = classerErreur(e);
      return erreur.genre === "annule" ? { statut: "annule" } : { statut: "erreur", erreur };
    } finally {
      // Seule la requete qui tient encore le verrou le rend : une requete annulee ne doit pas liberer celle qui l'a remplacee.
      if (controleur.current === c || controleur.current === null) {
        controleur.current = null;
        setEtat({ nom: null, progression: null, envoye: false });
      }
    }
  }, []);

  const annuler = useCallback(() => { controleur.current?.abort(); }, []);

  return { etat, occupe: etat.nom !== null, lancer, annuler };
}
