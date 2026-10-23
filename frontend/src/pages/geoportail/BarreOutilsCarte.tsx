import { ChevronDown, Maximize, Minimize, Navigation, PenLine, Ruler, Share2, Square, X } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { ExportControl } from "./ExportControl";
import type { MeasureMode } from "./MeasureLayer";

/**
 * Barre d'outils de la carte : UNE rangee, trois groupes.
 *
 * AVANT : six boutons repartis sur deux rangees decalees, qui recouvraient la commande de zoom et les
 * panneaux de mesure poses dessous. APRES : creer, mesurer (un menu qui range distance, surface et
 * distance entre deux troncons), puis la vue (partager, exporter, plein ecran). Les boutons
 * secondaires n'ont que leur icone en dessous de 1280 px : leur nom reste donne par `aria-label` et
 * `title`. La rangee ne passe jamais a la ligne : un panneau pose dessous ne risque plus de la chevaucher.
 */

export interface PropsBarreOutils {
  peutEcrire: boolean;
  modeDessin: boolean;
  onBasculerDessin: () => void;
  modeMesure: MeasureMode;
  onMesure: (mode: Exclude<MeasureMode, "off">) => void;
  onEffacerMesure: () => void;
  itineraireOuvert: boolean;
  onBasculerItineraire: () => void;
  onPartager: () => void;
  copie: boolean;
  pleinEcran: boolean;
  onBasculerPleinEcran: () => void;
  cibleExport: React.RefObject<HTMLElement>;
}

const BOUTON = "flex h-9 items-center justify-center gap-1.5 px-2.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60";
const GROUPE = "flex items-center overflow-hidden rounded-lg border border-gray-200 bg-white shadow-md";

export function BarreOutilsCarte(p: PropsBarreOutils) {
  const mesureActive = p.modeMesure !== "off" || p.itineraireOuvert;
  return (
    <div role="toolbar" aria-label="Outils de la carte" className="pointer-events-auto flex shrink-0 flex-nowrap items-center justify-end gap-1.5">
      {p.peutEcrire && (
        <button
          type="button"
          onClick={p.onBasculerDessin}
          aria-label={p.modeDessin ? "Annuler le tracé" : "Créer un tronçon"}
          title={p.modeDessin ? "Annuler le tracé" : "Créer un tronçon"}
          className={`flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-sm font-medium shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 ${
            p.modeDessin ? "border-red-400 bg-red-500 text-white hover:bg-red-600" : "border-gray-200 bg-white text-navy hover:bg-gray-50"
          }`}
        >
          <PenLine className="h-4 w-4" aria-hidden="true" />
          <span className="hidden xl:inline">{p.modeDessin ? "Annuler" : "Créer tronçon"}</span>
        </button>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Mesures"
            title="Mesures : distance, surface, distance entre deux tronçons"
            className={`flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-sm shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 ${
              mesureActive ? "border-navy bg-navy text-white" : "border-gray-200 bg-white text-navy hover:bg-gray-50"
            }`}
          >
            <Ruler className="h-4 w-4" aria-hidden="true" />
            <span className="hidden xl:inline">Mesures</span>
            <ChevronDown className="h-3 w-3" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="z-[1200] w-72">
          <DropdownMenuItem onSelect={() => p.onMesure("distance")} aria-checked={p.modeMesure === "distance"} role="menuitemradio">
            <Ruler className="mr-2 h-4 w-4" aria-hidden="true" />
            <span className="flex-1">Mesurer une distance sur la carte</span>
            {p.modeMesure === "distance" && <span className="text-xs text-gray-500">actif</span>}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => p.onMesure("area")} aria-checked={p.modeMesure === "area"} role="menuitemradio">
            <Square className="mr-2 h-4 w-4" aria-hidden="true" />
            <span className="flex-1">Mesurer une surface</span>
            {p.modeMesure === "area" && <span className="text-xs text-gray-500">actif</span>}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={p.onBasculerItineraire} aria-checked={p.itineraireOuvert} role="menuitemradio">
            <Navigation className="mr-2 h-4 w-4" aria-hidden="true" />
            <span className="flex-1">Distance à vol d'oiseau entre deux tronçons</span>
            {p.itineraireOuvert && <span className="text-xs text-gray-500">actif</span>}
          </DropdownMenuItem>
          {p.modeMesure !== "off" && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={p.onEffacerMesure}>
                <X className="mr-2 h-4 w-4" aria-hidden="true" />Effacer la mesure
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <div className={GROUPE}>
        <button type="button" onClick={p.onPartager} aria-label={p.copie ? "Lien copié" : "Partager la vue"} title="Partager la vue (copie un lien)" className={BOUTON}>
          <Share2 className="h-4 w-4" aria-hidden="true" />
          {p.copie && <span className="text-xs">Copié</span>}
        </button>
        <div className="border-l border-gray-200"><ExportControl targetRef={p.cibleExport} /></div>
        <button
          type="button"
          onClick={p.onBasculerPleinEcran}
          aria-label={p.pleinEcran ? "Quitter le plein écran" : "Plein écran"}
          title={p.pleinEcran ? "Quitter le plein écran" : "Plein écran"}
          className={`${BOUTON} border-l border-gray-200`}
        >
          {p.pleinEcran ? <Minimize className="h-4 w-4" aria-hidden="true" /> : <Maximize className="h-4 w-4" aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}
