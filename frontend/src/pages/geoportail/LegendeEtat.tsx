import { ETAT_COLORS, ETAT_LABELS } from "./types";
import { TRAIT_ETAT_DECLARE } from "./affichageTroncon";
import type { EtatPatrimoine } from "../../types";

/**
 * Legende « État de la chaussée » de la carte interne.
 *
 * Elle porte une ligne de plus que les cinq etats : le trait POINTILLE, qui marque un etat
 * seulement declare par un gestionnaire, sans releve de terrain. Sans cette ligne, un tron-
 * con pointille serait lisible comme un defaut d'affichage plutot que comme une information.
 */
export function LegendeEtat() {
  return (
    <div className="rounded-lg border border-gray-100 bg-white shadow-sm p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">État de la chaussée</h3>
      <div className="space-y-1">
        {Object.entries(ETAT_LABELS).map(([etat, label]) => (
          <div key={etat} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: ETAT_COLORS[etat as EtatPatrimoine] }} />
            <span className="text-gray-600">{label}</span>
          </div>
        ))}
        <div className="flex items-start gap-2 border-t border-gray-100 pt-1.5 mt-1.5">
          <svg width="22" height="10" viewBox="0 0 22 10" aria-hidden="true" className="mt-1 shrink-0">
            <line x1="0" y1="5" x2="22" y2="5" stroke="#6b7280" strokeWidth="3" strokeDasharray={TRAIT_ETAT_DECLARE} />
          </svg>
          <span className="text-gray-600 leading-snug">
            Trait pointillé : état déclaré, non constaté sur le terrain
          </span>
        </div>
      </div>
    </div>
  );
}
