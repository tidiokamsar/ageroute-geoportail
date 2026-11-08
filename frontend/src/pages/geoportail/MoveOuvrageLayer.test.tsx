import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock("react-leaflet", () => ({
  Marker: (p: Record<string, unknown>) => { h.props = p; return null; },
  Tooltip: () => null,
}));
vi.mock("../../hooks/useEntity", () => ({ useEntityMutations: () => ({ update: { mutateAsync: vi.fn(), isPending: false } }) }));

import { MoveOuvrageLayer } from "./MoveOuvrageLayer";

afterEach(() => { cleanup(); h.props = null; });

describe("MoveOuvrageLayer : marqueur", () => {
  it("passe une icone EXPLICITE (la detection du dossier d'images de Leaflet echoue avec la feuille empaquetee) : memes valeurs que MapPointPicker", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MoveOuvrageLayer ouvrage={{ id: "o1", nom: "Pont", lat: 9.5, lon: -13.7 }} onTerminer={() => undefined} />
      </QueryClientProvider>,
    );
    const icone = h.props?.icon as { options: Record<string, unknown> } | undefined;
    expect(icone).toBeDefined();
    expect(icone?.options).toMatchObject({
      iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], tooltipAnchor: [16, -28], shadowSize: [41, 41],
    });
    for (const cle of ["iconUrl", "iconRetinaUrl", "shadowUrl"]) expect(typeof icone?.options[cle]).toBe("string");
    expect(h.props?.draggable).toBe(true);
  });
});
