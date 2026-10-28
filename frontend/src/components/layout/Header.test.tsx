import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { violationsAccessibilite } from "../../test/accessibilite";

vi.mock("../../lib/auth", () => ({
  useAuth: () => ({ user: { id: "u", nomComplet: "Utilisateur Synthétique", role: "ADMIN" }, logout: vi.fn(), logoutAll: vi.fn() }),
}));
vi.mock("./GlobalSearch", () => ({ GlobalSearch: () => <div data-testid="recherche" /> }));
vi.mock("./SyncStatusBadge", () => ({ SyncStatusBadge: () => <span>Synchronisé</span> }));

import { Header } from "./Header";

const rendre = (title = "Aide à la décision") => render(<MemoryRouter><Header title={title} onMenuClick={() => {}} /></MemoryRouter>);

/**
 * Cahier AD paragraphe 4.2 : « Le titre ne doit jamais être tronqué ». Mesure d'origine : « Aide à la dé... » a
 * 1440 px, titre invisible a 768 et 375 px. jsdom ne calcule pas la mise en page : ce test garde les CLASSES qui
 * portent la regle ; la mesure de rendu est faite en navigateur reel (rapport du lot AD-1).
 */
describe("Header : le titre de page n'est jamais tronque", () => {
  it("affiche le titre complet, sans classe de troncature, avec retour a la ligne", () => {
    rendre("Aide à la décision");
    const h = screen.getByRole("heading", { level: 2, name: "Aide à la décision" });
    expect(h.className).not.toMatch(/\btruncate\b|text-ellipsis|line-clamp|overflow-hidden|whitespace-nowrap/);
    expect(h.className).toMatch(/break-words/);
  });

  it("ne fixe pas la hauteur de l'en-tete : elle est un minimum, l'en-tete peut passer a la ligne", () => {
    rendre();
    const entete = screen.getByRole("banner");
    expect(entete.className).toMatch(/min-h-16/);
    expect(entete.className).not.toMatch(/(^|\s)h-16(\s|$)/);
    expect(entete.className).toMatch(/flex-wrap/);
  });

  it("garde un titre long entier", () => {
    const long = "Aide à la décision : priorisation des interventions, simulation budgétaire et suivi contractuel";
    rendre(long);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(long);
  });

  it("la recherche globale reste disponible des md, sur sa propre ligne sous xl (elle ne vole pas la place du titre)", () => {
    rendre();
    const c = screen.getByTestId("recherche").parentElement?.className ?? "";
    expect(c).toMatch(/hidden/);
    expect(c).toMatch(/md:block/);
    expect(c).toMatch(/md:basis-full/);
    expect(c).not.toMatch(/2xl:block/);
  });

  it("les commandes de l'en-tete font 44 px sous xl (cibles tactiles)", () => {
    rendre();
    expect(screen.getByRole("link", { name: "Sécurité du compte" }).className).toContain("min-h-[44px]");
    expect(screen.getByRole("button", { name: /Déconnexion/ }).className).toContain("min-h-[44px]");
    expect(screen.getByRole("button", { name: "Ouvrir le menu" }).className).toContain("min-h-[44px]");
  });

  it("passe axe", async () => {
    const { container } = rendre();
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});
