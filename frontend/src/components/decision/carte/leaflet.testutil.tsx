import { vi } from "vitest";
import type { ReactNode } from "react";

/**
 * Double de Leaflet pour les tests (jsdom ne rend pas Leaflet : voir vitest.config.ts). `react-leaflet` est remplace par un double qui garde ce
 * qui compte ici : QUELS marqueurs et quelles lignes sont demandes, avec quelle icone, quel style, quels gestionnaires, quelle vue. Le dessin
 * reel est verifie dans Chromium (captures du rapport). Fichier utilise par les tests seulement ; toutes les donnees des tests sont SYNTHETIQUES.
 */

export const carteEtat = {
  zoom: 10,
  bounds: { w: -13.8, s: 9.5, e: -13.5, n: 9.8 },
  handlers: {} as Record<string, () => void>,
  /** Vrai : le rendu de la carte leve (garde-fou). */
  lever: false,
  /** Conteneur rendu par `map.getContainer()` (un test y place des elements Leaflet simules) ; null : un div neuf a chaque appel. */
  conteneur: null as HTMLElement | null,
};

export const mapDouble = {
  getSize: () => ({ x: 0, y: 0 }),
  setView: vi.fn(),
  getZoom: () => carteEtat.zoom,
  getBounds: () => ({
    getWest: () => carteEtat.bounds.w, getSouth: () => carteEtat.bounds.s, getEast: () => carteEtat.bounds.e, getNorth: () => carteEtat.bounds.n,
    contains: (p: [number, number]) => p[0] >= carteEtat.bounds.s && p[0] <= carteEtat.bounds.n && p[1] >= carteEtat.bounds.w && p[1] <= carteEtat.bounds.e,
  }),
  getContainer: () => carteEtat.conteneur ?? document.createElement("div"),
  fitBounds: vi.fn(),
  panTo: vi.fn(),
  invalidateSize: vi.fn(),
};

export function reinitialiserCarte() {
  carteEtat.zoom = 10;
  carteEtat.bounds = { w: -13.8, s: 9.5, e: -13.5, n: 9.8 };
  carteEtat.handlers = {};
  carteEtat.lever = false;
  carteEtat.conteneur = null;
  mapDouble.setView.mockReset();
  mapDouble.fitBounds.mockReset();
  mapDouble.panTo.mockReset();
  mapDouble.invalidateSize.mockReset();
}

type Gestionnaires = { click?: () => void };

export function moduleReactLeaflet() {
  return {
    MapContainer: ({ children, center, zoom }: { children: ReactNode; center: number[]; zoom: number }) => {
      if (carteEtat.lever) throw new Error("Invalid GeoJSON object.");
      return <div data-testid="carte" data-centre={center.join(",")} data-zoom={zoom}>{children}</div>;
    },
    TileLayer: ({ url, attribution }: { url: string; attribution: string }) => <div data-testid="tuiles" data-url={url} data-attribution={attribution} />,
    ZoomControl: () => null,
    ScaleControl: () => <div data-testid="echelle" />,
    GeoJSON: ({ data, style, onEachFeature }: {
      data: { features?: { properties?: Record<string, unknown> }[] };
      style?: (f: unknown) => Record<string, unknown>;
      onEachFeature?: (f: unknown, l: { bindTooltip: (t: string) => void }) => void;
    }) => {
      const styles = (data.features ?? []).map((f) => style?.(f));
      const infobulles: string[] = [];
      (data.features ?? []).forEach((f) => onEachFeature?.(f, { bindTooltip: (t: string) => { infobulles.push(t); } }));
      return <div data-testid="geojson" data-n={data.features?.length ?? "feature"} data-styles={JSON.stringify(styles)} data-infobulles={JSON.stringify(infobulles)} />;
    },
    Polyline: ({ children, pathOptions, eventHandlers }: { children?: ReactNode; pathOptions?: Record<string, unknown>; eventHandlers?: Gestionnaires }) => (
      <button type="button" data-testid="ligne" data-couleur={String(pathOptions?.color ?? "")} data-pointille={String(pathOptions?.dashArray ?? "")} onClick={() => eventHandlers?.click?.()}>{children}</button>
    ),
    Tooltip: ({ children }: { children: ReactNode }) => <span data-testid="infobulle">{children}</span>,
    Marker: ({ position, icon, eventHandlers, zIndexOffset, keyboard, children }: {
      position: [number, number]; icon: { options: { html: string; className: string } }; eventHandlers?: Gestionnaires; zIndexOffset?: number; keyboard?: boolean; children?: ReactNode;
    }) => (
      <button
        type="button" data-testid="marqueur" data-classe={icon.options.className} data-pos={position.join(",")} data-z={zIndexOffset ?? 0} data-clavier={String(keyboard ?? true)}
        onClick={() => eventHandlers?.click?.()}
      >
        <span dangerouslySetInnerHTML={{ __html: icon.options.html }} />
        {children}
      </button>
    ),
    useMap: () => mapDouble,
    useMapEvents: (hd: Record<string, () => void>) => { carteEtat.handlers = hd; return mapDouble; },
  };
}

export function moduleCluster() {
  return { default: ({ children }: { children: ReactNode }) => <div data-testid="groupe">{children}</div> };
}
