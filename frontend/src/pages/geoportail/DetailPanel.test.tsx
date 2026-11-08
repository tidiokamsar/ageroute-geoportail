import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { violationsAccessibilite } from "../../test/accessibilite";

const h = vi.hoisted(() => ({ fiche: null as unknown }));
vi.mock("../../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string) => {
      if (url.includes("/fiche")) return { data: h.fiche };
      if (url.startsWith("/documents")) return { data: { data: [] } };
      return { data: { data: [] } };
    }),
    put: vi.fn(async () => ({ data: {} })),
    patch: vi.fn(async () => ({ data: {} })),
    post: vi.fn(async () => ({ data: {} })),
  },
}));
vi.mock("../../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { DetailPanel } from "./DetailPanel";
import type { SelectedFeature, TronconGeoFeature } from "./types";

/**
 * Fiche latérale de la carte interne : ce que ces tests défendent.
 *
 *   - Echap ferme la fiche ; avec une saisie non enregistrée, il demande d'abord confirmation
 *     (et un Echap destiné à cette confirmation ne ferme pas la fiche derrière elle) ;
 *   - la fiche est un dialogue nommé, ses boutons icône ont un nom accessible ;
 *   - un état seulement DÉCLARÉ n'est jamais présenté comme « constaté » ;
 *   - largeur : pleine largeur sous `md`, 520 px au-delà.
 */
const TRONCON: TronconGeoFeature = {
  id: "t-1", code: "RN1-01", nom: "RN1 Conakry - Coyah", classe: "RN", etat: "MOYEN",
  longueurKm: 12.5, region: "Conakry", revetement: "BITUME", pkDebut: 0, pkFin: 12.5,
  geometry: JSON.stringify({ type: "LineString", coordinates: [[-13.7, 9.5], [-13.6, 9.6]] }),
};

beforeEach(() => {
  h.fiche = {
    troncon: {
      id: "t-1", code: "RN1-01", nom: "RN1 Conakry - Coyah", classe: "RN", etat: "MOYEN", longueurKm: 12.5,
      revetement: "BITUME", pkDebut: 0, pkFin: 12.5, createdAt: "2026-01-01", updatedAt: "2026-01-01", region: { nom: "Conakry" },
    },
    ouvrages: [], pointsNoirs: [], postes: [], chantiers: [], inspections: [],
  };
});

function rendre(troncon: TronconGeoFeature = TRONCON, props: { canEdit?: boolean } = {}) {
  const onClose = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const feature: SelectedFeature = { kind: "troncon", data: troncon };
  const vue = render(
    <QueryClientProvider client={qc}>
      <DetailPanel feature={feature} onClose={onClose} canEdit={props.canEdit} onZoomTo={() => {}} />
    </QueryClientProvider>,
  );
  return { onClose, ...vue };
}

describe("DetailPanel : clavier et accessibilité", () => {
  it("est un dialogue nommé par le tronçon, avec des boutons icône nommés", () => {
    rendre();
    expect(screen.getByRole("dialog", { name: "Fiche : RN1 Conakry - Coyah" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fermer la fiche" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Réduire la fiche" }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: "Zoomer sur le tronçon" })).toBeInTheDocument();
  });

  it("Echap ferme la fiche quand rien n'a été saisi", async () => {
    const u = userEvent.setup({ delay: null });
    const { onClose } = rendre();
    await u.keyboard("{Escape}");
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("la croix ferme aussi la fiche", async () => {
    const u = userEvent.setup({ delay: null });
    const { onClose } = rendre();
    await u.click(screen.getByRole("button", { name: "Fermer la fiche" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("avec un brouillon d'édition, Echap demande confirmation avant de fermer", async () => {
    const u = userEvent.setup({ delay: null });
    const { onClose } = rendre(TRONCON, { canEdit: true });
    await u.click(await screen.findByRole("button", { name: /Modifier/ }));
    const nom = await screen.findByLabelText("Nom");
    await u.type(nom, " (bis)");

    await u.keyboard("{Escape}");
    expect(await screen.findByText(/Des modifications n'ont pas été enregistrées/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    // Un Echap destiné à la confirmation la ferme, mais ne ferme pas la fiche derrière.
    await u.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText(/Des modifications n'ont pas été enregistrées/)).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Nom")).toHaveValue("RN1 Conakry - Coyah (bis)");

    // Confirmer abandonne la saisie et ferme.
    await u.keyboard("{Escape}");
    await u.click(await screen.findByRole("button", { name: "Confirmer" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("en édition sans aucune modification, Echap ferme sans confirmation", async () => {
    const u = userEvent.setup({ delay: null });
    const { onClose } = rendre(TRONCON, { canEdit: true });
    await u.click(await screen.findByRole("button", { name: /Modifier/ }));
    await screen.findByLabelText("Nom");
    await u.keyboard("{Escape}");
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("largeur : pleine largeur sur téléphone, 520 px dès le breakpoint md", () => {
    rendre();
    const classes = screen.getByRole("dialog", { name: /Fiche : / }).className;
    expect(classes).toContain("w-full");
    expect(classes).toContain("md:w-[520px]");
    expect(classes).not.toMatch(/(^|\s)w-\[520px\]/);
  });

  it("n'a pas de violation d'accessibilité détectable", async () => {
    const { container } = rendre();
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

describe("DetailPanel : état déclaré, non constaté", () => {
  it("un état constaté garde la mention « Dernier état constaté »", async () => {
    const u = userEvent.setup({ delay: null });
    rendre();
    await u.click(screen.getByRole("button", { name: /^État$/ }));
    expect(await screen.findByText("Dernier état constaté")).toBeInTheDocument();
    expect(screen.queryByText(/Déclaré, non constaté/)).not.toBeInTheDocument();
  });

  it("un état déclaré est dit déclaré dans l'en-tête et dans l'onglet État, jamais « constaté »", async () => {
    const u = userEvent.setup({ delay: null });
    rendre({ ...TRONCON, etatDeclare: true });
    // En-tête : la pastille d'état porte « déclaré ».
    expect(screen.getByText(/\(déclaré\)/)).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: /^État$/ }));
    expect(await screen.findByText("Déclaré, non constaté sur le terrain")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("n'a pas fait l'objet d'un relevé de terrain");
    expect(screen.queryByText("Dernier état constaté")).not.toBeInTheDocument();
    expect(screen.queryByText("État observé")).not.toBeInTheDocument();
  });
});
