import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { violationsAccessibilite } from "../../test/accessibilite";
import { BarreOutilsCarte, type PropsBarreOutils } from "./BarreOutilsCarte";

/**
 * Barre d'outils de la carte : ce que ces tests defendent.
 *   - UNE rangee qui ne passe jamais a la ligne (la version precedente se cassait en deux rangees decalees
 *     qui recouvraient le zoom et les panneaux de mesure) ;
 *   - distance, surface et distance entre deux troncons sont rangees dans UN menu « Mesures » ;
 *   - chaque bouton a un nom accessible, meme quand il n'a que son icone ;
 *   - « Creer un troncon » n'existe que pour qui peut ecrire ;
 *   - zero violation d'accessibilite (axe-core), menu ferme et ouvert.
 */

vi.mock("./ExportControl", () => ({ ExportControl: () => <button type="button">Exporter</button> }));

beforeAll(() => {
  // jsdom n'a pas ces methodes, dont Radix a besoin pour ouvrir un menu.
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});
afterEach(cleanup);

function props(surcharge: Partial<PropsBarreOutils> = {}): PropsBarreOutils {
  return {
    peutEcrire: true, modeDessin: false, onBasculerDessin: vi.fn(),
    modeMesure: "off", onMesure: vi.fn(), onEffacerMesure: vi.fn(),
    itineraireOuvert: false, onBasculerItineraire: vi.fn(),
    onPartager: vi.fn(), copie: false, pleinEcran: false, onBasculerPleinEcran: vi.fn(),
    cibleExport: { current: null },
    ...surcharge,
  };
}

describe("structure", () => {
  it("est une barre d'outils nommee, sur UNE rangee qui ne retrecit ni ne passe a la ligne", () => {
    render(<BarreOutilsCarte {...props()} />);
    const barre = screen.getByRole("toolbar", { name: "Outils de la carte" });
    expect(barre.className).toContain("flex-nowrap");
    expect(barre.className).toContain("shrink-0");
    expect(barre.className).not.toContain("flex-wrap ");
  });

  it("chaque bouton a un nom accessible, y compris ceux qui n'ont que leur icone", () => {
    render(<BarreOutilsCarte {...props()} />);
    for (const nom of ["Créer un tronçon", "Mesures", "Partager la vue", "Plein écran", "Exporter"]) {
      expect(screen.getByRole("button", { name: nom }), nom).toBeInTheDocument();
    }
  });

  it("« Créer un tronçon » n'existe que pour qui peut ecrire", () => {
    render(<BarreOutilsCarte {...props({ peutEcrire: false })} />);
    expect(screen.queryByRole("button", { name: /Créer un tronçon/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mesures" })).toBeInTheDocument();
  });
});

describe("creer un troncon", () => {
  it("appelle la bascule, et devient « Annuler le tracé » pendant le dessin", async () => {
    const p = props();
    const { rerender } = render(<BarreOutilsCarte {...p} />);
    await userEvent.click(screen.getByRole("button", { name: "Créer un tronçon" }));
    expect(p.onBasculerDessin).toHaveBeenCalledTimes(1);
    rerender(<BarreOutilsCarte {...p} modeDessin />);
    expect(screen.getByRole("button", { name: "Annuler le tracé" })).toBeInTheDocument();
  });
});

describe("menu Mesures", () => {
  async function ouvrir(p: PropsBarreOutils) {
    render(<BarreOutilsCarte {...p} />);
    await userEvent.click(screen.getByRole("button", { name: "Mesures" }));
    return screen.findByRole("menu");
  }

  it("range les trois mesures dans un seul menu", async () => {
    const menu = await ouvrir(props());
    expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(3);
    expect(within(menu).getByText("Mesurer une distance sur la carte")).toBeInTheDocument();
    expect(within(menu).getByText("Mesurer une surface")).toBeInTheDocument();
    expect(within(menu).getByText(/Distance à vol d'oiseau entre deux tronçons/)).toBeInTheDocument();
  });

  it("choisir une distance ou une surface appelle onMesure avec le bon mode", async () => {
    const p = props();
    await ouvrir(p);
    await userEvent.click(screen.getByText("Mesurer une surface"));
    expect(p.onMesure).toHaveBeenCalledWith("area");
    await userEvent.click(screen.getByRole("button", { name: "Mesures" }));
    await userEvent.click(await screen.findByText("Mesurer une distance sur la carte"));
    expect(p.onMesure).toHaveBeenLastCalledWith("distance");
  });

  it("la distance entre deux troncons appelle sa propre bascule", async () => {
    const p = props();
    await ouvrir(p);
    await userEvent.click(screen.getByText(/Distance à vol d'oiseau/));
    expect(p.onBasculerItineraire).toHaveBeenCalledTimes(1);
    expect(p.onMesure).not.toHaveBeenCalled();
  });

  it("« Effacer la mesure » n'apparait que si une mesure est active, et l'efface", async () => {
    const sans = props();
    const menu1 = await ouvrir(sans);
    expect(within(menu1).queryByText("Effacer la mesure")).not.toBeInTheDocument();
    cleanup();

    const avec = props({ modeMesure: "distance" });
    await ouvrir(avec);
    await userEvent.click(screen.getByText("Effacer la mesure"));
    expect(avec.onEffacerMesure).toHaveBeenCalledTimes(1);
  });

  it("le declencheur est mis en evidence tant qu'une mesure ou la distance A-B est active", () => {
    const { rerender } = render(<BarreOutilsCarte {...props()} />);
    expect(screen.getByRole("button", { name: "Mesures" }).className).not.toContain("bg-navy");
    rerender(<BarreOutilsCarte {...props({ modeMesure: "area" })} />);
    expect(screen.getByRole("button", { name: "Mesures" }).className).toContain("bg-navy");
    rerender(<BarreOutilsCarte {...props({ itineraireOuvert: true })} />);
    expect(screen.getByRole("button", { name: "Mesures" }).className).toContain("bg-navy");
  });

  it("marque le mode actif dans le menu", async () => {
    const menu = await ouvrir(props({ modeMesure: "area" }));
    const [distance, surface] = within(menu).getAllByRole("menuitemradio");
    expect(distance).toHaveAttribute("aria-checked", "false");
    expect(surface).toHaveAttribute("aria-checked", "true");
  });
});

describe("menu Mesures : clavier et fermeture", () => {
  async function ouvrir() {
    render(<BarreOutilsCarte {...props()} />);
    await userEvent.click(screen.getByRole("button", { name: "Mesures" }));
    return screen.findByRole("menu");
  }

  it("l'ouverture place le focus sur le premier choix et annonce l'etat au declencheur", async () => {
    await ouvrir();
    const declencheur = screen.getByRole("button", { name: "Mesures" });
    expect(declencheur).toHaveAttribute("aria-expanded", "true");
    expect(declencheur).toHaveAttribute("aria-haspopup", "menu");
    expect(screen.getAllByRole("menuitemradio")[0]).toHaveFocus();
  });

  it("Bas et Haut deplacent le focus, en boucle", async () => {
    await ouvrir();
    const [a, b, c] = screen.getAllByRole("menuitemradio");
    await userEvent.keyboard("{ArrowDown}");
    expect(b).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(a).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(c).toHaveFocus();
  });

  it("Echap ferme le menu et rend le focus au declencheur", async () => {
    await ouvrir();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mesures" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Mesures" })).toHaveAttribute("aria-expanded", "false");
  });

  it("un clic en dehors ferme le menu", async () => {
    await ouvrir();
    await userEvent.click(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("choisir un element ferme le menu", async () => {
    await ouvrir();
    await userEvent.click(screen.getByText("Mesurer une surface"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("Bas sur le declencheur ouvre le menu sans clic", async () => {
    render(<BarreOutilsCarte {...props()} />);
    screen.getByRole("button", { name: "Mesures" }).focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(await screen.findByRole("menu")).toBeInTheDocument();
  });
});

describe("partager et plein ecran", () => {
  it("appellent leurs rappels, et le nom suit l'etat", async () => {
    const p = props();
    const { rerender } = render(<BarreOutilsCarte {...p} />);
    await userEvent.click(screen.getByRole("button", { name: "Partager la vue" }));
    await userEvent.click(screen.getByRole("button", { name: "Plein écran" }));
    expect(p.onPartager).toHaveBeenCalledTimes(1);
    expect(p.onBasculerPleinEcran).toHaveBeenCalledTimes(1);
    rerender(<BarreOutilsCarte {...p} copie pleinEcran />);
    expect(screen.getByRole("button", { name: "Lien copié" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Quitter le plein écran" })).toBeInTheDocument();
  });
});

describe("accessibilite", () => {
  it("zero violation, menu ferme", async () => {
    const { container } = render(<BarreOutilsCarte {...props()} />);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("zero violation, menu ouvert", async () => {
    render(<BarreOutilsCarte {...props({ modeMesure: "distance" })} />);
    await userEvent.click(screen.getByRole("button", { name: "Mesures" }));
    await screen.findByRole("menu");
    expect(await violationsAccessibilite(document.body)).toEqual([]);
  });
});
