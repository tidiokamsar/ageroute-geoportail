import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * Plein ecran ACCESSIBLE d'un bloc de page : le bloc devient une couche FIXE posee sur la page, pas une fenetre. Sans precaution, Tab en
 * sort (mesure dans Observation de la Terre : 18 arrets sur 25 hors de la couche) et le fond reste atteignable au clavier et au lecteur
 * d'ecran. Tout ce qui entoure le bloc, a chaque niveau de l'arbre, devient `inert` (ni focalisable ni lu) ; l'attribut est retire a la
 * sortie, y compris au demontage. Echap quitte le plein ecran. Au retour, le focus revient sur le bouton qui l'a ouvert, jamais sur le
 * corps de la page. Mecanique copiee de CarteObservationTerre (lecture seule), isolee ici pour se tester seule.
 */
export function usePleinEcran(racine: RefObject<HTMLElement>, bouton: RefObject<HTMLElement>, apresChangement?: () => void) {
  const [pleinEcran, setPleinEcran] = useState(false);
  const etaitPleinEcran = useRef(false);
  const rappel = useRef(apresChangement);
  rappel.current = apresChangement;

  useEffect(() => {
    if (!pleinEcran) return;
    const surTouche = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) setPleinEcran(false); };
    window.addEventListener("keydown", surTouche);
    return () => window.removeEventListener("keydown", surTouche);
  }, [pleinEcran]);

  useEffect(() => {
    if (!pleinEcran) return;
    const rendus: Element[] = [];
    for (let n: Element | null = racine.current; n && n.parentElement; n = n.parentElement) {
      for (const frere of Array.from(n.parentElement.children)) {
        if (frere !== n && !frere.hasAttribute("inert")) { frere.setAttribute("inert", ""); rendus.push(frere); }
      }
    }
    return () => { for (const e of rendus) e.removeAttribute("inert"); };
  }, [pleinEcran, racine]);

  useEffect(() => {
    if (etaitPleinEcran.current && !pleinEcran) bouton.current?.focus();
    etaitPleinEcran.current = pleinEcran;
    rappel.current?.();
  }, [pleinEcran, bouton]);

  return { pleinEcran, basculer: () => setPleinEcran((v) => !v) };
}
