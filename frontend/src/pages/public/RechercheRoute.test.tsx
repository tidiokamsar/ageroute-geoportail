import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RechercheRoute, type RouteIndexee } from "./RechercheRoute";

/**
 * Recherche de la carte publique — la porte d'entree du seul ecran ouvert a tous.
 *
 * Leaflet n'est pas testable sous jsdom : la carte elle-meme reste couverte par les
 * verifications en navigateur. Ce composant, lui, est de la logique pure et se prete
 * au test automatise.
 */

const routes: RouteIndexee[] = [
  { nom: "RN1", classe: "RN", longueurKm: 1231, regions: ["Conakry", "Kindia", "Kankan"], positions: [[9.5, -13.7]] },
  { nom: "RN31", classe: "RN", longueurKm: 202, regions: ["Kankan", "Faranah"], positions: [[10.4, -9.3]] },
  { nom: "RES-171", classe: "RR", longueurKm: 45, regions: ["Nzérékoré"], positions: [[7.8, -8.8]] },
  { nom: "RU-Conakry-12", classe: "RU", longueurKm: 3, regions: ["Conakry"], positions: [[9.6, -13.6]] },
];

function poser(onChoisir = vi.fn()) {
  render(<RechercheRoute routes={routes} onChoisir={onChoisir} />);
  return { champ: screen.getByRole("searchbox", { name: /chercher une route/i }), onChoisir };
}

describe("Recherche de route — carte publique", () => {
  it("ne propose rien tant que rien n'est saisi", () => {
    poser();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("trouve une route par son numéro", async () => {
    const { champ } = poser();
    await userEvent.type(champ, "RN31");
    expect(screen.getByText("RN31")).toBeInTheDocument();
    expect(screen.queryByText("RES-171")).not.toBeInTheDocument();
  });

  it("trouve les routes d'une région", async () => {
    const { champ } = poser();
    await userEvent.type(champ, "Kankan");
    expect(screen.getByText("RN1")).toBeInTheDocument();
    expect(screen.getByText("RN31")).toBeInTheDocument();
    expect(screen.queryByText("RES-171")).not.toBeInTheDocument();
  });

  it("ignore les accents — on tape sans, on trouve avec", async () => {
    const { champ } = poser();
    await userEvent.type(champ, "nzerekore");
    expect(screen.getByText("RES-171")).toBeInTheDocument();
  });

  it("place d'abord les correspondances en début de nom, puis les plus longues", async () => {
    const { champ } = poser();
    await userEvent.type(champ, "RN");
    // On restreint a la liste de resultats : le bouton d'effacement du champ est
    // lui aussi un bouton, et viendrait en premier.
    const noms = within(screen.getByRole("list")).getAllByRole("button").map((b) => b.textContent ?? "");
    // RN1 (1231 km) avant RN31 (202 km) : les deux commencent par "RN", l'axe le
    // plus long passe devant.
    expect(noms[0]).toContain("RN1");
    expect(noms[1]).toContain("RN31");
  });

  it("traduit la classe dans la langue du lecteur", async () => {
    const { champ } = poser();
    await userEvent.type(champ, "RES-171");
    expect(screen.getByText("Route régionale")).toBeInTheDocument();
    expect(screen.queryByText(/^RR$/)).not.toBeInTheDocument();
  });

  it("le dit quand rien ne correspond, plutôt que de rester muette", async () => {
    const { champ } = poser();
    await userEvent.type(champ, "zzzz");
    expect(screen.getByText(/aucune route ne correspond/i)).toBeInTheDocument();
  });

  it("remonte la route choisie et vide le champ", async () => {
    const { champ, onChoisir } = poser();
    await userEvent.type(champ, "RN31");
    await userEvent.click(screen.getByText("RN31"));

    expect(onChoisir).toHaveBeenCalledTimes(1);
    expect(onChoisir.mock.calls[0][0].nom).toBe("RN31");
    expect(champ).toHaveValue("");
  });

  it("Entrée choisit le premier résultat", async () => {
    const { champ, onChoisir } = poser();
    await userEvent.type(champ, "RN31{Enter}");
    expect(onChoisir.mock.calls[0][0].nom).toBe("RN31");
  });

  it("Échap referme la liste sans rien choisir", async () => {
    const { champ, onChoisir } = poser();
    await userEvent.type(champ, "RN{Escape}");
    expect(onChoisir).not.toHaveBeenCalled();
    expect(screen.queryByText("Route nationale")).not.toBeInTheDocument();
  });

  it("le bouton d'effacement vide la recherche", async () => {
    const { champ } = poser();
    await userEvent.type(champ, "RN1");
    await userEvent.click(screen.getByRole("button", { name: /effacer la recherche/i }));
    expect(champ).toHaveValue("");
  });
});
