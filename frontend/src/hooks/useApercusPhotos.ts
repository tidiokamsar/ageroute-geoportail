import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { abonnerCompte, etatCompte } from "../lib/compteCourant";
import { abonnerRevocationApercus, creerUrlApercu, revoquerUrlApercu } from "../session/urlsApercu";

/**
 * Cycle de vie des apercus (URL `blob:`) des photos d'une saisie en cours, pour une page qui les garde dans son etat
 * (contrat : session/urlsApercu.ts). La page cree et retire chaque apercu elle-meme avec `creerUrlApercu` /
 * `revoquerUrlApercu` ; ce hook fait le reste :
 *
 *   - AU VERROU : le registre revoque toutes les URL et previent. Les photos restent dans l'etat (le `Blob` est la photo, il n'est
 *     pas touche) mais leur `previewUrl` devient `""` : plus aucune URL vivante ne subsiste le temps du verrou, et la page montre un
 *     emplacement masque (`previewUrl === ""`) au lieu d'une image cassee ;
 *   - AU DEVERROUILLAGE (le compte courant redevient « OUVERT ») : un apercu neuf est recree pour chaque photo masquee ;
 *   - AU DEMONTAGE : toutes les URL encore vivantes de la page sont revoquees. Une page qui ne fait que demonter sans retirer ses
 *     photos (navigation, deconnexion) ne laisse donc aucune URL dans le registre.
 *
 * Les URL ne sont JAMAIS creees dans une fonction de mise a jour d'etat (React peut l'appeler deux fois : la seconde URL fuirait).
 */
export function useApercusPhotos<T extends { blob: Blob; previewUrl: string }>(photos: T[], setPhotos: Dispatch<SetStateAction<T[]>>): void {
  const courantes = useRef(photos);
  courantes.current = photos;
  // Vrai entre le verrou (URL revoquees) et le deverrouillage (apercus recrees).
  const [masques, setMasques] = useState(false);

  // Verrou : le registre vient de revoquer les URL, la page oublie les siennes.
  useEffect(() => abonnerRevocationApercus(() => {
    setMasques(true);
    setPhotos((actuelles) => (actuelles.some((p) => p.previewUrl !== "") ? actuelles.map((p) => (p.previewUrl === "" ? p : { ...p, previewUrl: "" })) : actuelles));
  }), [setPhotos]);

  // Deverrouillage : recreer les apercus des photos masquees, des que le compte est ouvert.
  useEffect(() => {
    if (!masques) return undefined;
    const recreer = () => {
      if (etatCompte() !== "OUVERT") return;
      const neufs = new Map<Blob, string>();
      for (const p of courantes.current) if (p.previewUrl === "" && !neufs.has(p.blob)) neufs.set(p.blob, creerUrlApercu(p.blob));
      setMasques(false);
      if (neufs.size === 0) return;
      setPhotos((actuelles) => actuelles.map((p) => {
        const url = neufs.get(p.blob);
        return url !== undefined && p.previewUrl === "" ? { ...p, previewUrl: url } : p;
      }));
    };
    recreer();
    return abonnerCompte(recreer);
  }, [masques, setPhotos]);

  // Demontage : plus rien de cette page ne doit rester dans le registre.
  useEffect(() => () => {
    for (const p of courantes.current) if (p.previewUrl !== "") revoquerUrlApercu(p.previewUrl);
  }, []);
}
