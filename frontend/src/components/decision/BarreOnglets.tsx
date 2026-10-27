import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { FileCheck2, FileText, GitCompare, List, Map as IconeCarte, Wallet } from "lucide-react";
import type { IdOnglet } from "./types";
import { ONGLETS } from "../../lib/decision";

/**
 * Barre d'onglets accessible (modele WAI-ARIA « tabs », activation MANUELLE).
 *
 * - `role="tablist"`, un `role="tab"` par onglet, `aria-selected`, `aria-controls` vers l'unique panneau ;
 * - un seul onglet dans l'ordre de tabulation (tabindex roulant) ; fleches gauche/droite, Debut, Fin deplacent le
 *   FOCUS (avec retour a la boucle) ; Entree ou Espace active. L'activation manuelle evite de charger un onglet
 *   lourd (carte) a chaque pression de fleche et d'empiler des entrees d'historique ;
 * - les libelles restent TOUJOURS visibles : sous 768 px les onglets passent a la ligne (deux par ligne), ils ne
 *   deviennent pas des icones seules et ne se cachent pas dans un defilement horizontal ;
 * - cibles d'au moins 44 px de haut.
 */

const ICONES: Record<IdOnglet, typeof IconeCarte> = {
  carte: IconeCarte,
  liste: List,
  simulation: Wallet,
  contractuel: FileCheck2,
  scenarios: GitCompare,
  rapports: FileText,
};

export const idOnglet = (prefixe: string, id: IdOnglet) => `${prefixe}-onglet-${id}`;
export const idPanneauOnglets = (prefixe: string) => `${prefixe}-panneau`;

export function BarreOnglets({ actif, onChoisir, prefixe }: { actif: IdOnglet; onChoisir: (id: IdOnglet) => void; prefixe: string }) {
  const index = Math.max(0, ONGLETS.findIndex((o) => o.id === actif));
  const [indexFocus, setIndexFocus] = useState(index);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  // L'onglet tabulable suit l'onglet actif quand il change par un autre chemin (clic, KPI, URL, retour arriere).
  useEffect(() => setIndexFocus(index), [index]);

  const deplacer = (i: number) => {
    const n = (i + ONGLETS.length) % ONGLETS.length;
    setIndexFocus(n);
    refs.current[n]?.focus();
  };

  const surTouche = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === "ArrowRight") deplacer(i + 1);
    else if (e.key === "ArrowLeft") deplacer(i - 1);
    else if (e.key === "Home") deplacer(0);
    else if (e.key === "End") deplacer(ONGLETS.length - 1);
    else return;
    e.preventDefault();
  };

  return (
    <div role="tablist" aria-label="Sections de l'aide à la décision" className="flex flex-wrap gap-1 rounded-lg border border-gray-200 bg-white p-1">
      {ONGLETS.map((o, i) => {
        const Icone = ICONES[o.id];
        const selectionne = o.id === actif;
        return (
          <button
            key={o.id}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="tab"
            id={idOnglet(prefixe, o.id)}
            aria-selected={selectionne}
            aria-controls={idPanneauOnglets(prefixe)}
            tabIndex={i === indexFocus ? 0 : -1}
            onClick={() => onChoisir(o.id)}
            onKeyDown={(e) => surTouche(e, i)}
            className={`flex min-h-[44px] basis-[calc(50%-0.125rem)] items-center justify-center gap-2 rounded-md px-3 py-1.5 text-center text-sm font-medium leading-tight focus:outline-none focus-visible:ring-2 focus-visible:ring-navy focus-visible:ring-offset-1 md:flex-1 md:basis-auto ${
              selectionne ? "bg-navy text-white shadow-sm" : "text-gray-800 hover:bg-gray-100"
            }`}
          >
            <Icone aria-hidden="true" className="h-4 w-4 shrink-0" />
            <span>{o.libelle}</span>
          </button>
        );
      })}
    </div>
  );
}
