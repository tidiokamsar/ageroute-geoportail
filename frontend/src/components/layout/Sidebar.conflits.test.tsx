import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Le menu : « Conflits de synchronisation » est reserve aux responsables (ADMIN, GESTIONNAIRE), « Observations
 * terrain » est ouvert a tout agent du module Inspections. Le serveur impose le meme partage (la liste des
 * conflits rend 403 a un agent) ; le menu ne fait que ne pas proposer ce qui serait refuse.
 */

const h = vi.hoisted(() => ({ user: { id: "u", role: "GESTIONNAIRE", modulesAutorises: [] as string[] } }));
vi.mock("../../lib/auth", () => ({ useAuth: () => ({ user: h.user }) }));
vi.mock("../../lib/api", () => ({ api: { get: vi.fn(async () => ({ data: {} })), post: vi.fn(async () => ({ data: {} })) } }));

import { Sidebar } from "./Sidebar";

function menu(role: string, modulesAutorises: string[] = []) {
  h.user = { id: "u", role, modulesAutorises };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><Sidebar /></MemoryRouter></QueryClientProvider>);
}

describe("Menu : conflits de synchronisation et observations terrain", () => {
  it("un gestionnaire voit les deux entrees, avec les bonnes cibles", () => {
    menu("GESTIONNAIRE");
    expect(screen.getByRole("link", { name: "Conflits de synchronisation" })).toHaveAttribute("href", "/inspections/conflits");
    expect(screen.getByRole("link", { name: "Observations terrain" })).toHaveAttribute("href", "/inspections/terrain/observations");
  });

  it("un administrateur voit les conflits", () => {
    menu("ADMIN");
    expect(screen.getByRole("link", { name: "Conflits de synchronisation" })).toBeInTheDocument();
  });

  it("un inspecteur ne voit PAS les conflits, mais saisit ses observations", () => {
    menu("INSPECTEUR");
    expect(screen.queryByRole("link", { name: "Conflits de synchronisation" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Observations terrain" })).toBeInTheDocument();
  });

  it("sans acces au module Inspections, aucune des deux entrees n'est proposee", () => {
    menu("GESTIONNAIRE", ["dashboard"]);
    expect(screen.queryByRole("link", { name: "Conflits de synchronisation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Observations terrain" })).not.toBeInTheDocument();
  });
});
