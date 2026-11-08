import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Info } from "lucide-react";

/**
 * Definition accessible : un bouton (clavier, tactile, souris) qui ouvre un texte. Le texte reste dans le DOM, masque,
 * et le bouton le reference par `aria-describedby` : un lecteur d'ecran le lit sans l'ouvrir. Echap le ferme. Une
 * info-bulle au survol seul serait inaccessible au clavier et au toucher (WCAG 1.4.13).
 * Copie adaptee du composant du module Observation de la Terre (lecture seule, non importe de l'autre branche).
 */
export function InfoBulle({ libelle, children, className = "", alignement = "gauche" }: { libelle: string; children: ReactNode; className?: string; alignement?: "gauche" | "droite" }) {
  const [ouverte, setOuverte] = useState(false);
  const id = useId();
  const racine = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!ouverte) return;
    const surTouche = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOuverte(false);
    };
    const surClic = (e: MouseEvent) => {
      if (racine.current && !racine.current.contains(e.target as Node)) setOuverte(false);
    };
    document.addEventListener("keydown", surTouche);
    document.addEventListener("mousedown", surClic);
    return () => {
      document.removeEventListener("keydown", surTouche);
      document.removeEventListener("mousedown", surClic);
    };
  }, [ouverte]);

  return (
    <span ref={racine} className={`relative inline-flex ${className}`}>
      <button
        type="button"
        aria-label={`Définition : ${libelle}`}
        aria-expanded={ouverte}
        aria-describedby={id}
        onClick={() => setOuverte((o) => !o)}
        className="inline-flex h-11 w-11 items-center justify-center rounded-full text-gray-600 hover:bg-gray-100 hover:text-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-navy xl:h-7 xl:w-7"
      >
        <Info aria-hidden="true" className="h-4 w-4" />
      </button>
      <span
        id={id}
        role="note"
        className={`${ouverte ? "block" : "hidden"} absolute ${alignement === "droite" ? "right-0" : "left-0"} top-full z-panneau mt-1 w-64 max-w-[80vw] rounded-md border border-gray-200 bg-white p-3 text-xs font-normal leading-relaxed text-gray-700 shadow-n2`}
      >
        {children}
      </span>
    </span>
  );
}
