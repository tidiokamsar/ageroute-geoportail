import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Menu : deux entrees dont l'acces ne va pas de soi.
 *
 *   - « Validateurs » (/gouvernance) est proposee a ADMIN ET a tout compte portant
 *     `peutDeleguerValidation` (la Direction Technique est GESTIONNAIRE), comme le serveur
 *     (delegations.controller.ts) et la garde de route (ProtectedRoute.test.tsx) ;
 *   - « Validation des portions » (/portions/validation) existe au menu : la route etait
 *     ouverte a tout compte connecte mais n'avait pour seul lien qu'une carte du tableau de bord.
 */
const h = vi.hoisted(() => ({ user: { id: "u", role: "GESTIONNAIRE" } as Record<string, unknown> }));
vi.mock("../../lib/auth", () => ({ useAuth: () => ({ user: h.user }) }));
vi.mock("../../lib/api", () => ({ api: { get: vi.fn(async () => ({ data: {} })), post: vi.fn(async () => ({ data: {} })) } }));

import { Sidebar } from "./Sidebar";

function menu(user: Record<string, unknown>) {
  h.user = user;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><Sidebar /></MemoryRouter></QueryClientProvider>);
}

describe("Menu : désignation des validateurs", () => {
  it("un gestionnaire qui porte le droit voit « Validateurs », vers /gouvernance", () => {
    menu({ id: "dt", role: "GESTIONNAIRE", peutDeleguerValidation: true, modulesAutorises: [] });
    expect(screen.getByRole("link", { name: "Validateurs" })).toHaveAttribute("href", "/gouvernance");
    // Il n'est pas administrateur : les écrans réservés à ADMIN restent absents.
    expect(screen.queryByRole("link", { name: "Utilisateurs" })).not.toBeInTheDocument();
  });

  it("un gestionnaire sans le droit ne voit pas « Validateurs »", () => {
    menu({ id: "g", role: "GESTIONNAIRE", peutDeleguerValidation: false, modulesAutorises: [] });
    expect(screen.queryByRole("link", { name: "Validateurs" })).not.toBeInTheDocument();
  });

  it("un administrateur le voit", () => {
    menu({ id: "a", role: "ADMIN", modulesAutorises: [] });
    expect(screen.getByRole("link", { name: "Validateurs" })).toBeInTheDocument();
  });
});

describe("Menu : validation des portions", () => {
  it.each(["LECTEUR", "INSPECTEUR", "GESTIONNAIRE", "ADMIN"])("%s voit « Validation des portions », vers /portions/validation", (role) => {
    menu({ id: "u", role, modulesAutorises: [] });
    expect(screen.getByRole("link", { name: "Validation des portions" })).toHaveAttribute("href", "/portions/validation");
  });
});
