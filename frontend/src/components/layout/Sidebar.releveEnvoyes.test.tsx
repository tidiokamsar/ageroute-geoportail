import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Menu lateral : l'entree « Relevés envoyés ». Ce que ces tests defendent.
 *   - elle figure dans le groupe « Relevé terrain », sous l'adresse de la liste, pour un role sans acces d'administration ;
 *   - sur la liste comme sur le detail d'un releve, elle est la SEULE entree active (pas « Enregistrer en roulant », pas « Relevé en véhicule ») ;
 *   - elle suit le module `inspections` : un compte dont les modules ne l'incluent pas ne la voit pas.
 */

const h = vi.hoisted(() => ({ user: { id: "u", role: "LECTEUR", modulesAutorises: [] as string[] } }));
vi.mock("../../lib/auth", () => ({ useAuth: () => ({ user: h.user }) }));

import { Sidebar } from "./Sidebar";
import { MODULES } from "../../lib/modules";

// Le serveur lit une liste vide comme « aucun module » (E2E-EO-3) : ces tests de menu donnent donc tous les modules.
const TOUS_MODULES: string[] = MODULES.map((m) => m.key);

function rendreA(chemin: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[chemin]}><Sidebar open /></MemoryRouter></QueryClientProvider>);
}
const actifs = () => screen.getAllByRole("link").filter((l) => l.getAttribute("aria-current") === "page").map((l) => l.textContent);

describe("Sidebar : Relevés envoyés", () => {
  it("figure dans le groupe Relevé terrain avec son adresse, pour un lecteur", () => {
    h.user = { id: "u", role: "LECTEUR", modulesAutorises: TOUS_MODULES };
    rendreA("/");
    expect(screen.getByRole("link", { name: "Relevés envoyés" })).toHaveAttribute("href", "/inspections/releve/envoyes");
    expect(screen.getAllByRole("link", { name: "Relevés envoyés" })).toHaveLength(1);
  });
  it("sur la liste, seule « Relevés envoyés » est active", () => {
    rendreA("/inspections/releve/envoyes");
    expect(actifs()).toEqual(["Relevés envoyés"]);
  });
  it("sur le detail d'un releve, seule « Relevés envoyés » reste active", () => {
    rendreA("/inspections/releve/envoyes/11111111-2222-4333-8444-555555555555");
    expect(actifs()).toEqual(["Relevés envoyés"]);
  });
  it("« Enregistrer en roulant » et « Relevé en véhicule » ne s'activent pas sur la liste des releves envoyes", () => {
    rendreA("/inspections/releve/envoyes");
    expect(actifs()).not.toContain("Enregistrer en roulant");
    expect(actifs()).not.toContain("Relevé en véhicule");
  });
  it("un compte restreint a d'autres modules que « inspections » ne la voit pas", () => {
    h.user = { id: "u", role: "LECTEUR", modulesAutorises: ["alertes"] };
    rendreA("/");
    expect(screen.queryByRole("link", { name: "Relevés envoyés" })).toBeNull();
  });
  it("un compte dont les modules incluent « inspections » la voit", () => {
    h.user = { id: "u", role: "LECTEUR", modulesAutorises: ["inspections"] };
    rendreA("/");
    expect(screen.getByRole("link", { name: "Relevés envoyés" })).toBeInTheDocument();
  });
});
