import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { messageErreur } from "../lib/exploitation";

/**
 * Gestion des portions : ce que ces tests défendent.
 *   - la fusion n'est proposée qu'entre deux portions COURANTES qui se touchent ;
 *   - la découpe refuse un point hors des bornes, envoie le point saisi ;
 *   - la requalification exige une date d'effet postérieure à la version remplacée ;
 *   - l'historique ne part au serveur que demandé (jamais `historique=false`) ;
 *   - le motif de refus du serveur est affiché tel quel ; un LECTEUR ne voit aucun geste.
 */
const h = vi.hoisted(() => ({ role: "INSPECTEUR", gets: [] as { url: string; params?: Record<string, unknown> }[], posts: [] as { url: string; corps: unknown }[] }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u", role: h.role } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../components/TronconPicker", () => ({
  TronconPicker: ({ id, onChange }: { id: string; onChange: (v: string) => void }) => <button id={id} type="button" onClick={() => onChange("t-1")}>choisir</button>,
}));
const portion = (id: string, debutM: number, finM: number, o: Record<string, unknown> = {}) => ({
  id, debutM, finM, statutValidation: "VALIDE", remplaceeLe: null, revetement: "BITUME", etat: "BON", praticabilite: null, largeurM: 7,
  source: null, observeeLe: null, valideDu: "2026-01-01", confiance: null, createdAt: "2026-01-02T00:00:00Z", creePar: null,
  revetementRef: { libelle: "Bitume" }, etatRef: { libelle: "Bon" }, praticabiliteRef: null, ...o,
});
vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string, cfg?: { params?: Record<string, unknown> }) => {
      h.gets.push({ url, params: cfg?.params });
      if (url === "/v2/referentiels") return { data: { revetements: [{ code: "BITUME", libelle: "Bitume", actif: true }], etats: [{ code: "BON", libelle: "Bon", actif: true }], praticabilites: [] } };
      return { data: { portions: [
        portion("p-b", 400, 900), portion("p-a", 0, 400), portion("p-c", 1000, 1500),
        portion("p-old", 0, 900, { remplaceeLe: "2026-02-01T00:00:00Z" }),
      ] } };
    }),
    post: vi.fn(async (url: string, corps: unknown) => { h.posts.push({ url, corps }); return { data: {} }; }),
  },
}));

import { pairesAdjacentes, PortionsGestionPage } from "./PortionsGestionPage";

const rendre = async () => {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PortionsGestionPage /></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Tronçon" }));
  await screen.findByText("0 m – 400 m");
};

beforeEach(() => { h.role = "INSPECTEUR"; h.gets.length = 0; h.posts.length = 0; });

describe("pairesAdjacentes", () => {
  it("ne lie que les portions qui se touchent, dans l'ordre des abscisses", () => {
    expect(pairesAdjacentes([{ id: "b", debutM: 400, finM: 900 }, { id: "a", debutM: 0, finM: 400 }, { id: "c", debutM: 1000, finM: 1500 }])).toEqual([["a", "b"]]);
  });
});

describe("PortionsGestionPage", () => {
  it("ne propose la fusion qu'entre courantes adjacentes, et l'envoie", async () => {
    await rendre();
    const fusions = screen.getAllByRole("button", { name: "Fusionner avec la suivante" });
    expect(fusions).toHaveLength(1);
    expect(h.gets.find((g) => g.url === "/v2/portions")?.params).toEqual({ tronconId: "t-1", limite: 200 });
    fireEvent.click(fusions[0]);
    await waitFor(() => expect(h.posts[0]).toEqual({ url: "/v2/portions/fusion", corps: { idA: "p-a", idB: "p-b" } }));
  });
  it("découpe : refuse un point hors bornes, envoie le point saisi", async () => {
    await rendre();
    fireEvent.click(screen.getAllByRole("button", { name: "Découper" })[0]);
    const champ = screen.getByLabelText(/Point de coupe/);
    fireEvent.change(champ, { target: { value: "400" } });
    const bouton = screen.getAllByRole("button", { name: "Découper" }).at(-1)!;
    expect(bouton).toBeDisabled();
    fireEvent.change(champ, { target: { value: "150,5" } });
    fireEvent.click(bouton);
    await waitFor(() => expect(h.posts[0]).toEqual({ url: "/v2/portions/p-a/decoupe", corps: { aM: 150.5 } }));
  });
  it("requalification : date d'effet postérieure exigée", async () => {
    await rendre();
    fireEvent.click(screen.getAllByRole("button", { name: "Requalifier" })[0]);
    const bouton = await screen.findByRole("button", { name: "Proposer la requalification" });
    fireEvent.change(screen.getByLabelText(/Vrai depuis/), { target: { value: "2025-12-01" } });
    expect(bouton).toBeDisabled();
    expect(screen.getByText(/postérieure à celle de la version remplacée/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Vrai depuis/), { target: { value: "2026-03-01" } });
    fireEvent.change(screen.getByLabelText("État"), { target: { value: "" } });
    fireEvent.click(bouton);
    await waitFor(() => expect(h.posts[0]).toMatchObject({ url: "/v2/portions/p-a/requalification", corps: { valideDu: "2026-03-01", etat: null, revetement: "BITUME", largeurM: 7 } }));
  });
  it("l'historique n'est demandé que coché ; un LECTEUR ne voit aucun geste", async () => {
    h.role = "LECTEUR";
    await rendre();
    expect(screen.queryByRole("button", { name: "Découper" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Inclure les versions remplacées"));
    await waitFor(() => expect(h.gets.some((g) => g.params?.historique === "true")).toBe(true));
    expect(h.gets.some((g) => g.url === "/v2/referentiels")).toBe(false);
  });
  it("affiche le motif du serveur, qu'il soit en `error` ou en `message`", () => {
    expect(messageErreur({ response: { data: { message: "Ces deux portions ne se touchent pas" } } }, "repli")).toBe("Ces deux portions ne se touchent pas");
    expect(messageErreur({ response: { data: { error: "Refus" } } }, "repli")).toBe("Refus");
    expect(messageErreur(new Error("x"), "repli")).toBe("repli");
  });
});
