import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Menu lateral et modules (E2E-EO-3). Le serveur lit une liste de modules VIDE comme « aucun module » : le menu ne doit pas promettre
 * « Observation de la Terre » (ni aucun autre module) a un compte dont personne n'a encore choisi les modules.
 */
const h = vi.hoisted(() => ({ user: { id: "u", role: "GESTIONNAIRE", modulesAutorises: [] as string[] | undefined } }));
vi.mock("../../lib/auth", () => ({ useAuth: () => ({ user: h.user }) }));

import { Sidebar } from "./Sidebar";

function rendre() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/"]}><Sidebar open /></MemoryRouter></QueryClientProvider>);
}
const entree = (nom: string) => screen.queryByRole("link", { name: nom });

describe("Sidebar : modules autorises", () => {
  it("liste vide : aucune entree de module (ni Observation de la Terre, ni Tronçons routiers, ni Géoportail)", () => {
    h.user = { id: "u", role: "GESTIONNAIRE", modulesAutorises: [] };
    rendre();
    expect(entree("Observation de la Terre")).toBeNull();
    expect(entree("Tronçons routiers")).toBeNull();
    expect(entree("Géoportail")).toBeNull();
  });

  it("liste renseignee : seules les entrees des modules listes apparaissent", () => {
    h.user = { id: "u", role: "GESTIONNAIRE", modulesAutorises: ["teledetection"] };
    rendre();
    expect(entree("Observation de la Terre")).not.toBeNull();
    expect(entree("Tronçons routiers")).toBeNull();
  });

  it("ADMIN : toutes les entrees, meme avec une liste vide", () => {
    h.user = { id: "u", role: "ADMIN", modulesAutorises: [] };
    rendre();
    expect(entree("Observation de la Terre")).not.toBeNull();
    expect(entree("Tronçons routiers")).not.toBeNull();
  });
});
