import { vi } from "vitest";
import type { ReactNode } from "react";

/**
 * Double de `react-leaflet` pour les tests du module (jsdom ne rend pas Leaflet). Il garde ce qui compte ici : QUELLES couches sont demandees,
 * avec quel style, quelle infobulle (en TEXTE : l'element passe a `bindTooltip` est lu par `textContent`), quel gestionnaire de clic, quelle vue.
 * Le dessin reel est verifie dans Chromium (captures du rapport). Fichier pour les tests seulement ; toutes les donnees sont SYNTHETIQUES.
 */

export const carteEtat = {
  zoom: 15,
  bounds: { w: -10.103, s: 9.177, e: -10.097, n: 9.183 },
  handlers: {} as Record<string, () => void>,
};

export const mapDouble = {
  getSize: () => ({ x: 800, y: 600 }),
  setView: vi.fn(),
  getZoom: () => carteEtat.zoom,
  getBounds: () => ({
    getWest: () => carteEtat.bounds.w, getSouth: () => carteEtat.bounds.s, getEast: () => carteEtat.bounds.e, getNorth: () => carteEtat.bounds.n,
  }),
  getContainer: () => document.createElement("div"),
  fitBounds: vi.fn(),
  panTo: vi.fn(),
  invalidateSize: vi.fn(),
};

export function reinitialiserCarte() {
  carteEtat.zoom = 15;
  carteEtat.bounds = { w: -10.103, s: 9.177, e: -10.097, n: 9.183 };
  carteEtat.handlers = {};
  mapDouble.fitBounds.mockReset();
  mapDouble.setView.mockReset();
}

interface FeatureLue { type?: string; properties?: Record<string, unknown>; geometry?: { type?: string } }
interface CoucheDouble { bindTooltip: (el: HTMLElement, opts?: unknown) => void; on: (ev: string, fn: () => void) => void }

function listerFeatures(data: unknown): FeatureLue[] {
  const d = data as { type?: string; features?: FeatureLue[] };
  return d?.type === "FeatureCollection" ? d.features ?? [] : d ? [d as FeatureLue] : [];
}

export function moduleReactLeaflet() {
  return {
    MapContainer: ({ children, center, zoom, preferCanvas }: { children: ReactNode; center: number[]; zoom: number; preferCanvas?: boolean }) => (
      <div data-testid="carte" data-centre={center.join(",")} data-zoom={zoom} data-canvas={String(preferCanvas === true)}>{children}</div>
    ),
    TileLayer: ({ url, attribution }: { url: string; attribution: string }) => <div data-testid="tuiles" data-url={url} data-attribution={attribution} />,
    ZoomControl: () => <div data-testid="zoom" />,
    ScaleControl: () => <div data-testid="echelle" />,
    GeoJSON: ({ data, style, onEachFeature, interactive }: {
      data: unknown;
      style?: (f: FeatureLue) => Record<string, unknown>;
      onEachFeature?: (f: FeatureLue, l: CoucheDouble) => void;
      interactive?: boolean;
    }) => {
      const features = listerFeatures(data);
      return (
        <div data-testid="geojson" data-n={features.length} data-interactive={String(interactive !== false)}>
          {features.map((f, i) => {
            const clics: Array<() => void> = [];
            let infobulle = "";
            let enfants = 0;
            onEachFeature?.(f, {
              on: (ev, fn) => { if (ev === "click") clics.push(fn); },
              bindTooltip: (el) => { infobulle = el.textContent ?? ""; enfants = el.children.length; },
            });
            const st = style?.(f) ?? {};
            // Couche non interactive (surbrillance, zones de conflit) : ni bouton, ni objet cliquable.
            if (interactive === false) return <span key={i} data-testid="couche-passive" data-style={JSON.stringify(st)} />;
            return (
              <button
                key={i} type="button" data-testid="objet-carte" data-style={JSON.stringify(st)} data-infobulle={infobulle} data-infobulle-enfants={enfants}
                onClick={() => clics.forEach((c) => c())}
              >
                {String(f.properties?.nom ?? "objet")}
              </button>
            );
          })}
        </div>
      );
    },
    useMap: () => mapDouble,
    useMapEvents: (hd: Record<string, () => void>) => { carteEtat.handlers = hd; return mapDouble; },
  };
}
