import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Revue independante (lot 6) : le prix des baremes est affiche EXACT. L'ancien formatage convertissait en nombre et arrondissait :
 * « 400000 » devenait « 0 M GNF/km », « 999999999 » « 1 000 M », et tout montant au-dela de 2^53 perdait des unites. L'approbateur
 * lit le prix exact dans la confirmation.
 */
const h = vi.hoisted(() => {
  const base = { uniteCout: "KM", devise: "GNF", code: null, libelle: null, source: "standard_initial", version: 1, approuveLe: null, approuvePar: null, anneeReference: 2026, largeurChausseeM: "6.5", validDe: null, validA: null, commentaire: null, typeIntervention: "entretien" };
  return {
    lignes: [
      { ...base, id: 1, familleRevetement: "bitume", etatDepart: "MOYEN", coutKmGnf: "400000" },
      { ...base, id: 2, familleRevetement: "terre_laterite", etatDepart: "MOYEN", coutKmGnf: "999999999" },
      { ...base, id: 3, familleRevetement: "pave", etatDepart: "MOYEN", coutKmGnf: "9007199254740993" },
    ],
  };
});
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u-1", role: "ADMIN" } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/api", () => ({ api: { get: vi.fn(async () => ({ data: { data: h.lignes.map((l) => ({ ...l })) } })), patch: vi.fn(), post: vi.fn() } }));

import { BaremesPage } from "./BaremesPage";

const n = (s: string | null) => (s ?? "").replace(new RegExp(String.fromCharCode(160), "g"), " ");

function rendre() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><BaremesPage /></QueryClientProvider>);
}

beforeEach(() => undefined);

describe("BaremesPage : prix exact", () => {
  it("400000 s'affiche 400 000 GNF/km, jamais « 0 M » ; 999999999 s'affiche exact, jamais « 1 000 M » ; 2^53+1 garde tous ses chiffres", async () => {
    const { container } = rendre();
    await screen.findByText(/Bitume/);
    const exacts = [...container.querySelectorAll('[data-prix="exact"]')].map((e) => n(e.textContent));
    expect(exacts).toEqual(["400 000 GNF/km", "999 999 999 GNF/km", "9 007 199 254 740 993 GNF/km"]);
    expect(n(container.textContent)).not.toMatch(/\b0 M GNF/);
    expect(n(container.textContent)).not.toMatch(/1 000 M\b/);
  });

  it("l'abrege est annonce approche (≈) et absent sous un million ; 999999999 passe en milliards", async () => {
    const { container } = rendre();
    await screen.findByText(/Bitume/);
    const abreges = [...container.querySelectorAll('[data-prix="abrege"]')].map((e) => n(e.textContent));
    expect(abreges).toEqual(["≈ 1 Md GNF/km", "≈ 9 007 199,3 Md GNF/km"]);
  });

  it("la confirmation de l'approbation montre le prix EXACT de la ligne a approuver", async () => {
    const u = userEvent.setup({ delay: null });
    rendre();
    await u.click(await screen.findByRole("button", { name: /Approuver la ligne terre_laterite MOYEN/ }));
    const form = screen.getByRole("form", { name: /Approuver la ligne terre_laterite MOYEN/ });
    const exact = within(form).getByText((_c, el) => el?.getAttribute("data-prix") === "confirmation");
    expect(n(exact.textContent)).toBe("999 999 999 GNF/km");
    expect(n(form.textContent)).toMatch(/prix EXACT/);
  }, 15000);
});
