import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

/**
 * Main courante : ce que ces tests défendent.
 *   - la liste se filtre par statut côté serveur et se cherche par texte ;
 *   - la déclaration exige type, source et texte, refuse une position incomplète, et part avec
 *     une clé d'idempotence ;
 *   - le journal ne propose que les gestes permis (rien ne recule ; un événement clos n'a plus de
 *     changement de statut, mais garde complément et rectification) ;
 *   - une rectification cite l'entrée qu'elle corrige ;
 *   - les statistiques exigent une période.
 */

const h = vi.hoisted(() => ({ get: {} as Record<string, unknown>, params: [] as unknown[], posts: [] as { url: string; corps: Record<string, unknown> }[] }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../components/TronconPicker", () => ({ TronconPicker: ({ id }: { id?: string }) => <input id={id} aria-label="troncon" /> }));
vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string, cfg?: { params?: unknown }) => { h.params.push({ url, params: cfg?.params }); return { data: h.get[url] }; }),
    post: vi.fn(async (url: string, corps: Record<string, unknown>) => { h.posts.push({ url, corps }); return { data: { evenementId: "ev-nouveau" } }; }),
  },
}));

import { MainCourantePage } from "./MainCourantePage";

function rendre() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}><MainCourantePage /></QueryClientProvider></MemoryRouter>);
}

const ligne = (id: string, statut: string, texte: string) => ({
  evenementId: id, typeCode: "COUPURE", sourceCode: "PATROUILLE", texte, tronconId: null, statut,
  ouvertLe: "2026-10-22T08:00:00Z", statutDepuis: "2026-10-22T08:00:00Z", nbEntrees: 1, nbRectifications: 0,
});
const entree = (id: string, nature: string, statut: string | null, texte: string) => ({
  id, nature, statut, texte, enregistreLe: "2026-10-22T08:00:00Z", horodatageClient: null, rectifieId: null,
  auteur: { nomComplet: "Agent" }, typeRef: { libelle: "Coupure" }, sourceRef: { libelle: "Patrouille" },
});

beforeEach(() => {
  h.posts.length = 0; h.params.length = 0;
  h.get = {
    "/v2/exploitation/referentiels": { types: [{ code: "COUPURE", libelle: "Coupure" }], sources: [{ code: "PATROUILLE", libelle: "Patrouille" }] },
    "/v2/exploitation/main-courante/evenements": { evenements: [ligne("ev-1", "OUVERT", "Radier submergé à Kouria"), ligne("ev-2", "CLOS", "Arbre tombé")] },
    "/v2/exploitation/main-courante/ev-1": { evenementId: "ev-1", statutCourant: "OUVERT", entrees: [entree("e-1", "DECLARATION", "OUVERT", "Radier submergé à Kouria")] },
    "/v2/exploitation/main-courante/ev-2": { evenementId: "ev-2", statutCourant: "CLOS", entrees: [entree("e-2", "DECLARATION", "OUVERT", "Arbre tombé"), entree("e-3", "STATUT", "CLOS", "Dégagé")] },
  };
});

describe("Liste", () => {
  it("filtre par statut côté serveur et cherche par texte", async () => {
    rendre();
    expect(await screen.findByText("Radier submergé à Kouria")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clos" }));
    await waitFor(() => expect(h.params).toContainEqual({ url: "/v2/exploitation/main-courante/evenements", params: { statut: "CLOS" } }));
    fireEvent.click(screen.getByRole("button", { name: "Tous" }));
    fireEvent.change(await screen.findByLabelText("Rechercher"), { target: { value: "arbre" } });
    expect(screen.queryByText("Radier submergé à Kouria")).not.toBeInTheDocument();
    expect(screen.getByText("Arbre tombé")).toBeInTheDocument();
  });
});

describe("Déclaration", () => {
  it("exige type, source et texte ; refuse une position incomplète ; envoie une clé d'idempotence", async () => {
    rendre();
    fireEvent.click(await screen.findByRole("button", { name: /Déclarer un événement/ }));
    const dialog = await screen.findByRole("dialog");
    const declarer = within(dialog).getByRole("button", { name: "Déclarer" });
    expect(declarer).toBeDisabled();
    await within(dialog).findByRole("option", { name: "Coupure" });
    fireEvent.change(within(dialog).getByLabelText("Type d'événement"), { target: { value: "COUPURE" } });
    fireEvent.change(within(dialog).getByLabelText("Source de l'information"), { target: { value: "PATROUILLE" } });
    fireEvent.change(within(dialog).getByLabelText("Ce qui est constaté"), { target: { value: "Pont emporté" } });
    fireEvent.change(within(dialog).getByLabelText("Latitude"), { target: { value: "9.6" } });
    expect(within(dialog).getByText(/Position incomplète/)).toBeInTheDocument();
    expect(declarer).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Longitude"), { target: { value: "-13.6" } });
    fireEvent.click(declarer);
    await waitFor(() => expect(h.posts[0]?.url).toBe("/v2/exploitation/main-courante"));
    expect(h.posts[0].corps).toMatchObject({ typeCode: "COUPURE", sourceCode: "PATROUILLE", texte: "Pont emporté", point: [-13.6, 9.6] });
    expect(String(h.posts[0].corps.clientOperationId).length).toBeGreaterThanOrEqual(8);
  });
});

describe("Journal", () => {
  it("ouvert : propose prise en compte et clôture, pas « Passer en traitement »", async () => {
    rendre();
    fireEvent.click((await screen.findAllByRole("button", { name: "Ouvrir" }))[0]);
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("button", { name: "Prendre en compte" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Clore" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Passer en traitement" })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Prendre en compte" }));
    fireEvent.change(within(dialog).getByLabelText("Ce qui justifie le changement"), { target: { value: "Équipe dépêchée" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Enregistrer l'entrée" }));
    await waitFor(() => expect(h.posts[0]).toMatchObject({ url: "/v2/exploitation/main-courante/ev-1/entrees", corps: { nature: "STATUT", statut: "PRIS_EN_COMPTE", texte: "Équipe dépêchée", rectifieId: null } }));
  });
  it("clos : aucun changement de statut ; une rectification cite son entrée", async () => {
    rendre();
    fireEvent.click((await screen.findAllByRole("button", { name: "Ouvrir" }))[1]);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/Événement clos/);
    expect(within(dialog).queryByRole("button", { name: "Clore" })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Rectifier une entrée" }));
    fireEvent.change(within(dialog).getByLabelText("Entrée à rectifier"), { target: { value: "e-3" } });
    fireEvent.change(within(dialog).getByLabelText("La correction"), { target: { value: "Dégagé à 10 h, pas 9 h" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Enregistrer l'entrée" }));
    await waitFor(() => expect(h.posts[0]).toMatchObject({ corps: { nature: "RECTIFICATION", rectifieId: "e-3", statut: null } }));
  });
});

describe("Statistiques", () => {
  it("n'interroge rien sans période", async () => {
    rendre();
    fireEvent.click(await screen.findByRole("button", { name: "Statistiques" }));
    expect(await screen.findByText(/aucune n'est supposée/)).toBeInTheDocument();
    expect(h.params.some((p) => (p as { url: string }).url === "/v2/exploitation/statistiques")).toBe(false);
  });
});
