import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/** Donnees SYNTHETIQUES : codes `SYNTH`, aucune geometrie ne decrit un vrai tronçon. */

const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../lib/api", () => ({ api: { get: h.get } }));

import { RechercheZoneTroncon, _viderCacheTroncons } from "./RechercheZoneTroncon";
import { violationsAccessibilite } from "../../test/accessibilite";

const TRONCON = { id: "t1", code: "SYNTH 1", nom: "Troncon synthetique", region: "Region synthetique" };
const GEO = [{ id: "t1", geometry: '{"type":"LineString","coordinates":[[-13.5,9.5],[-13.1,9.9]]}' }, { id: "t2", geometry: "{pas json" }];

function brancher(over: { recherche?: unknown; geo?: unknown } = {}) {
  h.get.mockImplementation(async (url: string) => {
    if (url === "/v2/troncons-recherche") { if (over.recherche instanceof Error) throw over.recherche; return { data: { data: over.recherche ?? [TRONCON] } }; }
    if (url === "/troncons/geo") { if (over.geo instanceof Error) throw over.geo; return { data: over.geo ?? GEO }; }
    throw new Error(`appel inattendu : ${url}`);
  });
}
const champ = () => screen.getByRole("searchbox", { name: "Rechercher une zone ou un tronçon" });
const appelsRecherche = () => h.get.mock.calls.filter((c) => c[0] === "/v2/troncons-recherche");

beforeEach(() => { h.get.mockReset(); _viderCacheTroncons(); });

describe("RechercheZoneTroncon", () => {
  it("les zones viennent de la liste locale : aucun appel reseau sous trois caracteres", async () => {
    const user = userEvent.setup();
    brancher();
    render(<RechercheZoneTroncon onCentrer={vi.fn()} />);
    await user.type(champ(), "ma");
    expect(screen.getByRole("button", { name: /Mamou/ })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 400));
    expect(h.get).not.toHaveBeenCalled();
  });

  it("choisir une zone cadre autour du chef-lieu et le dit", async () => {
    const user = userEvent.setup();
    brancher();
    const onCentrer = vi.fn();
    render(<RechercheZoneTroncon onCentrer={onCentrer} />);
    await user.type(champ(), "kankan");
    await user.click(screen.getByRole("button", { name: /Kankan/ }));
    expect(onCentrer).toHaveBeenCalledTimes(1);
    expect(onCentrer.mock.calls[0][0]).toEqual([-9.41, 10.28, -9.21, 10.48]);
    expect(onCentrer.mock.calls[0][1]).toBe("Kankan");
    expect(screen.getByRole("status")).toHaveTextContent("centre approximatif du chef-lieu, pas une limite administrative");
  });

  it("Entree choisit le premier resultat ; Echap ferme la liste", async () => {
    const user = userEvent.setup();
    brancher();
    const onCentrer = vi.fn();
    render(<RechercheZoneTroncon onCentrer={onCentrer} />);
    await user.type(champ(), "labe");
    expect(screen.getByRole("list", { name: "Résultats de la recherche" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("list", { name: "Résultats de la recherche" })).toBeNull();
    await user.clear(champ());
    await user.type(champ(), "labe{Enter}");
    expect(onCentrer).toHaveBeenCalledTimes(1);
    expect(onCentrer.mock.calls[0][1]).toBe("Labé");
  });

  it("interroge les troncons apres une pause de 300 ms, avec le texte et une limite", async () => {
    const user = userEvent.setup();
    brancher();
    render(<RechercheZoneTroncon onCentrer={vi.fn()} />);
    await user.type(champ(), "synth");
    expect(appelsRecherche()).toHaveLength(0);
    await screen.findByRole("button", { name: /SYNTH 1/ }, { timeout: 3000 });
    expect(appelsRecherche()).toHaveLength(1);
    expect(appelsRecherche()[0][1]).toEqual({ params: { q: "synth", limite: 8 } });
  });

  it("choisir un tronçon cadre son trace ; le reseau n'est charge qu'une fois", async () => {
    const user = userEvent.setup();
    brancher();
    const onCentrer = vi.fn();
    render(<RechercheZoneTroncon onCentrer={onCentrer} />);
    await user.type(champ(), "synth");
    await user.click(await screen.findByRole("button", { name: /SYNTH 1/ }, { timeout: 3000 }));
    await waitFor(() => expect(onCentrer).toHaveBeenCalledTimes(1));
    expect(onCentrer.mock.calls[0][0]).toEqual([-13.5, 9.5, -13.1, 9.9]);
    await user.clear(champ());
    await user.type(champ(), "synth");
    await user.click(await screen.findByRole("button", { name: /SYNTH 1/ }, { timeout: 3000 }));
    await waitFor(() => expect(onCentrer).toHaveBeenCalledTimes(2));
    expect(h.get.mock.calls.filter((c) => c[0] === "/troncons/geo")).toHaveLength(1);
  });

  it("un tronçon absent du reseau, ou au trace illisible : alerte, la carte n'est pas recadree", async () => {
    const user = userEvent.setup();
    brancher({ recherche: [{ ...TRONCON, id: "t2", code: "SYNTH 2" }, { ...TRONCON, id: "t3", code: "SYNTH 3" }] });
    const onCentrer = vi.fn();
    render(<RechercheZoneTroncon onCentrer={onCentrer} />);
    await user.type(champ(), "synth");
    await user.click(await screen.findByRole("button", { name: /SYNTH 2/ }, { timeout: 3000 }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Tracé indisponible pour SYNTH 2");
    await user.clear(champ());
    await user.type(champ(), "synth");
    await user.click(await screen.findByRole("button", { name: /SYNTH 3/ }, { timeout: 3000 }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Tracé indisponible pour SYNTH 3"));
    expect(onCentrer).not.toHaveBeenCalled();
  });

  it("echec du chargement du reseau : message du serveur, pas de recadrage, nouvel essai possible", async () => {
    const user = userEvent.setup();
    brancher({ geo: Object.assign(new Error("x"), { response: { data: { error: "Reseau en maintenance" } } }) });
    const onCentrer = vi.fn();
    render(<RechercheZoneTroncon onCentrer={onCentrer} />);
    await user.type(champ(), "synth");
    await user.click(await screen.findByRole("button", { name: /SYNTH 1/ }, { timeout: 3000 }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Reseau en maintenance");
    expect(onCentrer).not.toHaveBeenCalled();
    brancher();
    await user.clear(champ());
    await user.type(champ(), "synth");
    await user.click(await screen.findByRole("button", { name: /SYNTH 1/ }, { timeout: 3000 }));
    await waitFor(() => expect(onCentrer).toHaveBeenCalledTimes(1));
  });

  it("recherche de troncons en erreur : alerte, et les zones restent consultables", async () => {
    const user = userEvent.setup();
    brancher({ recherche: Object.assign(new Error("x"), { response: { data: { error: "Module Géoportail requis" } } }) });
    render(<RechercheZoneTroncon onCentrer={vi.fn()} />);
    await user.type(champ(), "kind");
    expect(await screen.findByRole("alert", {}, { timeout: 3000 })).toHaveTextContent("Module Géoportail requis");
    expect(screen.getByRole("button", { name: /Kindia/ })).toBeInTheDocument();
  });

  it("aucun resultat : le dit, ne reste pas muet", async () => {
    const user = userEvent.setup();
    brancher({ recherche: [] });
    render(<RechercheZoneTroncon onCentrer={vi.fn()} />);
    await user.type(champ(), "zzzzz");
    expect(await screen.findByText(/Aucun résultat pour « zzzzz »/, {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it("ignore la reponse d'une recherche abandonnee", async () => {
    const user = userEvent.setup();
    let liberer: (v: unknown) => void = () => undefined;
    h.get.mockImplementation((_url: string, o: { params: { q: string } }) => {
      if (o.params.q === "synth") return new Promise((r) => { liberer = r; });
      return Promise.resolve({ data: { data: [{ ...TRONCON, id: "u", code: "AUTRE 1" }] } });
    });
    render(<RechercheZoneTroncon onCentrer={vi.fn()} />);
    await user.type(champ(), "synth");
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    await user.clear(champ());
    await user.type(champ(), "autre");
    await screen.findByRole("button", { name: /AUTRE 1/ }, { timeout: 3000 });
    await act(async () => { liberer({ data: { data: [TRONCON] } }); });
    expect(screen.queryByRole("button", { name: /SYNTH 1/ })).toBeNull();
  });

  it("sans violation axe, liste ouverte", async () => {
    const user = userEvent.setup();
    brancher();
    const { container } = render(<RechercheZoneTroncon onCentrer={vi.fn()} />);
    await user.type(champ(), "kin");
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});
