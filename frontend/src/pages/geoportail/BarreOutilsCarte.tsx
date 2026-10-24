import { useEffect, useRef, useState } from "react";
import { ChevronDown, Maximize, Minimize, Navigation, PenLine, Ruler, Share2, Smartphone, Square, X } from "lucide-react";
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
            p.modeDessin ? "border-red-400 bg-red-600 text-white hover:bg-red-700" : "border-gray-200 bg-white text-navy hover:bg-gray-50"
          }`}
        >
          <PenLine className="h-4 w-4" aria-hidden="true" />
          <span className="hidden xl:inline">{p.modeDessin ? "Annuler" : "Créer tronçon"}</span>
        </button>
      )}

      <MenuMesures {...p} mesureActive={mesureActive} />

      {/* L'application mobile terrain est a portee de clic : APK natif en telechargement
          direct (fichier porte par nginx, voir docker-compose.yml), et la PWA reste la
          voie recommendee — le title le dit. Visible de tous, y compris LECTEUR : un
          agent de terrain qui n'ecrit pas a autant besoin de la carte dans sa poche. */}
      <a
        href="/mobile/bdri-console-terrain.apk"
        download
        aria-label="Télécharger l'application mobile (Android)"
        title="Application mobile terrain (Android) — télécharger l'APK. Sur téléphone, la voie la plus simple reste « Ajouter à l'écran d'accueil » (PWA, toujours à jour)."
        className={BOUTON}
      >
        <Smartphone className="h-4 w-4" aria-hidden="true" />
      </a>

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

/**
 * Menu « Mesures » : un panneau deroulant, pas un composant modal. Il n'ouvre pas de portail (l'export
 * d'image de la carte photographie le conteneur), ne verrouille pas le defilement et ne masque pas le reste
 * de la page : les autres commandes de la carte restent utilisables. Clavier : Entree ou Bas ouvre et place le
 * focus sur le premier choix, Haut et Bas se deplacent, Echap ferme et rend le focus au bouton, Tab ferme.
 */
function MenuMesures(p: PropsBarreOutils & { mesureActive: boolean }) {
  const [ouvert, setOuvert] = useState(false);
  const racine = useRef<HTMLDivElement>(null);
  const declencheur = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!ouvert) return;
    items.current[0]?.focus();
    const dehors = (e: MouseEvent) => { if (racine.current && !racine.current.contains(e.target as Node)) setOuvert(false); };
    document.addEventListener("mousedown", dehors);
    return () => document.removeEventListener("mousedown", dehors);
  }, [ouvert]);

  const choisir = (f: () => void) => { f(); setOuvert(false); declencheur.current?.focus(); };
  const aller = (delta: number) => {
    const liste = items.current.filter((x): x is HTMLButtonElement => x !== null);
    const i = liste.indexOf(document.activeElement as HTMLButtonElement);
    liste[(i + delta + liste.length) % liste.length]?.focus();
  };
  const auClavier = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); setOuvert(false); declencheur.current?.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); aller(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); aller(-1); }
    else if (e.key === "Tab") setOuvert(false);
  };

  const choix: { cle: string; icone: React.ReactNode; texte: string; actif: boolean; action: () => void }[] = [
    { cle: "distance", icone: <Ruler className="mr-2 h-4 w-4" aria-hidden="true" />, texte: "Mesurer une distance sur la carte", actif: p.modeMesure === "distance", action: () => p.onMesure("distance") },
    { cle: "surface", icone: <Square className="mr-2 h-4 w-4" aria-hidden="true" />, texte: "Mesurer une surface", actif: p.modeMesure === "area", action: () => p.onMesure("area") },
    { cle: "ab", icone: <Navigation className="mr-2 h-4 w-4" aria-hidden="true" />, texte: "Distance à vol d'oiseau entre deux tronçons", actif: p.itineraireOuvert, action: p.onBasculerItineraire },
  ];

  return (
    <div ref={racine} className="relative">
      <button
        ref={declencheur}
        type="button"
        aria-label="Mesures"
        aria-haspopup="menu"
        aria-expanded={ouvert}
        title="Mesures : distance, surface, distance entre deux tronçons"
        onClick={() => setOuvert((o) => !o)}
        onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); setOuvert(true); } else if (e.key === "Escape" && ouvert) { setOuvert(false); } }}
        className={`flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-sm shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 ${
          p.mesureActive ? "border-navy bg-navy text-white" : "border-gray-200 bg-white text-navy hover:bg-gray-50"
        }`}
      >
        <Ruler className="h-4 w-4" aria-hidden="true" />
        <span className="hidden xl:inline">Mesures</span>
        <ChevronDown className="h-3 w-3" aria-hidden="true" />
      </button>
      {ouvert && (
        <div role="menu" aria-label="Mesures" tabIndex={-1} onKeyDown={auClavier} className="absolute right-0 top-full z-30 mt-1 w-72 overflow-hidden rounded-lg border border-gray-100 bg-white py-1 shadow-lg">
          {choix.map((c, i) => (
            <button
              key={c.cle}
              ref={(el) => { items.current[i] = el; }}
              type="button"
              role="menuitemradio"
              aria-checked={c.actif}
              onClick={() => choisir(c.action)}
              className="flex w-full items-center px-3 py-2 text-left text-sm hover:bg-gray-50 focus:bg-gray-50 focus:outline-none"
            >
              {c.icone}
              <span className="flex-1">{c.texte}</span>
              {c.actif && <span className="text-xs text-gray-500">actif</span>}
            </button>
          ))}
          {p.modeMesure !== "off" && (
            <>
              <div role="separator" className="my-1 border-t border-gray-100" />
              <button
                ref={(el) => { items.current[choix.length] = el; }}
                type="button"
                role="menuitem"
                onClick={() => choisir(p.onEffacerMesure)}
                className="flex w-full items-center px-3 py-2 text-left text-sm hover:bg-gray-50 focus:bg-gray-50 focus:outline-none"
              >
                <X className="mr-2 h-4 w-4" aria-hidden="true" />Effacer la mesure
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
