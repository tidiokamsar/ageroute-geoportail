import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ComparaisonAvantApres } from "./ComparaisonAvantApres";
import { violationsAccessibilite } from "../../test/accessibilite";

/**
 * Ce que ces tests defendent : une image absente ou en echec se DIT (jamais une image de remplacement), le curseur
 * ne fait semblant de comparer que s'il y a deux images, il se manie au clavier, les dates sont affichees telles
 * qu'elles sont ecrites. Les URLs sont SYNTHETIQUES (`/essai/...`) : aucune image reelle n'est chargee sous jsdom.
 */

const AVANT = { url: "/essai/avant.png", date: "2026-09-15" };
const APRES = { url: "/essai/apres.png", date: "2026-10-23" };

const curseur = () => screen.getByRole("slider") as HTMLInputElement;
const images = () => screen.queryAllByRole("img") as HTMLImageElement[];

describe("ComparaisonAvantApres : deux images", () => {
  it("montre les deux images, leurs dates et un curseur actif", () => {
    render(<ComparaisonAvantApres avant={AVANT} apres={APRES} libelleZone="Zone synthetique" />);
    expect(images()).toHaveLength(2);
    expect(images().map((i) => i.getAttribute("src"))).toEqual(["/essai/apres.png", "/essai/avant.png"]);
    expect(screen.getAllByText("Avant (15/09/2026)").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Après (23/10/2026)").length).toBeGreaterThan(0);
    expect(curseur()).toBeEnabled();
    expect(curseur().value).toBe("50");
  });

  it("affiche la date sous chaque image, dans un element <time>", () => {
    const { container } = render(<ComparaisonAvantApres avant={AVANT} apres={APRES} />);
    const legende = container.querySelector("figcaption") as HTMLElement;
    const temps = legende.querySelectorAll("time");
    expect(Array.from(temps).map((t) => [t.textContent, t.getAttribute("datetime")])).toEqual([
      ["15/09/2026", "2026-09-15"], ["23/10/2026", "2026-10-23"],
    ]);
  });

  it("garde un texte alternatif honnete : la vignette et sa date, jamais le changement detecte", () => {
    render(<ComparaisonAvantApres avant={AVANT} apres={APRES} libelleZone="Zone synthetique" />);
    const alts = images().map((i) => i.getAttribute("alt"));
    expect(alts).toEqual([
      "Zone synthetique : vignette satellite après, acquise le 23/10/2026",
      "Zone synthetique : vignette satellite avant, acquise le 15/09/2026",
    ]);
    for (const a of alts) expect(a).not.toMatch(/dégrad|route|coupure|inond|changement/i);
  });

  it("le curseur nomme sa fonction et annonce sa valeur en clair", () => {
    render(<ComparaisonAvantApres avant={AVANT} apres={APRES} />);
    expect(screen.getByLabelText(/Curseur de comparaison/)).toBe(curseur());
    expect(curseur()).toHaveAttribute("aria-valuetext", "Image avant visible sur 50 % de la largeur, image après sur 50 %");
  });

  it("deplacer le curseur rogne l'image avant (clip-path) et met la valeur a jour", () => {
    const { container } = render(<ComparaisonAvantApres avant={AVANT} apres={APRES} />);
    fireEvent.change(curseur(), { target: { value: "20" } });
    expect(curseur().value).toBe("20");
    expect(curseur()).toHaveAttribute("aria-valuetext", "Image avant visible sur 20 % de la largeur, image après sur 80 %");
    const div = Array.from(container.querySelectorAll<HTMLElement>("div.absolute.inset-0")).find((d) => d.querySelector("img"));
    expect(div?.style.clipPath).toBe("inset(0 80% 0 0)");
    fireEvent.change(curseur(), { target: { value: "100" } });
    expect(div?.style.clipPath).toBe("inset(0 0% 0 0)");
  });

  it("se prend au clavier : un arret de tabulation, de type range, borne de 0 a 100", async () => {
    const user = userEvent.setup();
    render(<ComparaisonAvantApres avant={AVANT} apres={APRES} />);
    await user.tab();
    expect(curseur()).toHaveFocus();
    expect(curseur()).toHaveAttribute("type", "range");
    expect(curseur()).toHaveAttribute("min", "0");
    expect(curseur()).toHaveAttribute("max", "100");
    expect(curseur()).toHaveAttribute("step", "1");
  });

  it("annonce le chargement tant que les images ne sont pas arrivees, puis le retire", () => {
    render(<ComparaisonAvantApres avant={AVANT} apres={APRES} />);
    expect(screen.getByRole("status")).toHaveTextContent("Chargement des images");
    for (const i of images()) fireEvent.load(i);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("une date absente ou illisible se dit « date inconnue »", () => {
    render(<ComparaisonAvantApres avant={{ url: AVANT.url, date: null }} apres={{ url: APRES.url, date: "n'importe quoi" }} />);
    expect(screen.getAllByText("Avant (date inconnue)").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Après (date inconnue)").length).toBeGreaterThan(0);
    expect(images()[0].getAttribute("alt")).toContain("date d'acquisition inconnue");
  });
});

describe("ComparaisonAvantApres : image absente", () => {
  it("avant absente : message explicite, aucune image de remplacement, curseur desactive, l'autre image reste visible", () => {
    render(<ComparaisonAvantApres avant={{ url: null, date: "2026-09-15" }} apres={APRES} />);
    expect(screen.getByText("Image avant non disponible")).toBeInTheDocument();
    expect(images()).toHaveLength(1);
    expect(images()[0].getAttribute("src")).toBe("/essai/apres.png");
    expect(images()[0].getAttribute("alt")).toContain("après");
    expect(curseur()).toBeDisabled();
    expect(curseur()).toHaveAttribute("aria-valuetext", "Curseur désactivé");
    expect(screen.getByText(/Comparaison impossible : l'image avant n'est pas disponible/)).toBeInTheDocument();
  });

  it("apres absente : meme traitement, du bon cote", () => {
    render(<ComparaisonAvantApres avant={AVANT} apres={{ url: null, date: null }} />);
    expect(screen.getByText("Image après non disponible")).toBeInTheDocument();
    expect(screen.queryByText("Image avant non disponible")).toBeNull();
    expect(images()).toHaveLength(1);
    expect(images()[0].getAttribute("src")).toBe("/essai/avant.png");
    expect(curseur()).toBeDisabled();
  });

  it("les deux absentes : deux messages, aucune image du tout", () => {
    render(<ComparaisonAvantApres avant={{ url: null, date: null }} apres={{ url: null, date: null }} />);
    expect(screen.getByText("Image avant non disponible")).toBeInTheDocument();
    expect(screen.getByText("Image après non disponible")).toBeInTheDocument();
    expect(images()).toHaveLength(0);
    expect(document.querySelectorAll("img")).toHaveLength(0);
    expect(curseur()).toBeDisabled();
    expect(screen.getByText(/les images avant et après ne sont pas disponibles/)).toBeInTheDocument();
  });

  it("une chaine vide n'est pas une image : meme message", () => {
    render(<ComparaisonAvantApres avant={{ url: "", date: null }} apres={APRES} />);
    expect(screen.getByText("Image avant non disponible")).toBeInTheDocument();
    expect(document.querySelectorAll("img")).toHaveLength(1);
  });

  it("garde la date de l'image manquante : l'absence se voit avec sa date", () => {
    render(<ComparaisonAvantApres avant={{ url: null, date: "2026-09-15" }} apres={APRES} />);
    expect(screen.getAllByText("Avant (15/09/2026)").length).toBeGreaterThan(0);
  });
});

describe("ComparaisonAvantApres : echec de chargement", () => {
  it("une image qui ne charge pas est remplacee par une alerte, et le curseur se desactive", () => {
    render(<ComparaisonAvantApres avant={AVANT} apres={APRES} />);
    fireEvent.error(images().find((i) => i.getAttribute("src") === "/essai/avant.png")!);
    const alerte = screen.getByRole("alert");
    expect(alerte).toHaveTextContent("Image avant impossible à charger");
    expect(images()).toHaveLength(1);
    expect(curseur()).toBeDisabled();
    expect(screen.getByText(/l'image avant n'a pas pu être chargée/)).toBeInTheDocument();
  });

  it("l'echec n'est pas confondu avec l'absence", () => {
    render(<ComparaisonAvantApres avant={AVANT} apres={APRES} />);
    fireEvent.error(images()[0]);
    expect(screen.queryByText(/non disponible/)).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("impossible à charger");
  });

  it("une nouvelle URL efface l'echec de l'ancienne", () => {
    const { rerender } = render(<ComparaisonAvantApres avant={AVANT} apres={APRES} />);
    fireEvent.error(images().find((i) => i.getAttribute("src") === "/essai/avant.png")!);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    rerender(<ComparaisonAvantApres avant={{ url: "/essai/avant2.png", date: "2026-09-16" }} apres={APRES} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(images()).toHaveLength(2);
    expect(curseur()).toBeEnabled();
  });
});

describe("ComparaisonAvantApres : accessibilite (axe)", () => {
  it.each([
    ["deux images", AVANT, APRES],
    ["avant absente", { url: null, date: null }, APRES],
    ["deux absentes", { url: null, date: null }, { url: null, date: null }],
  ])("sans violation : %s", async (_nom, avant, apres) => {
    const { container } = render(<ComparaisonAvantApres avant={avant} apres={apres} libelleZone="Zone synthetique" />);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("sans violation apres un echec de chargement", async () => {
    const { container } = render(<ComparaisonAvantApres avant={AVANT} apres={APRES} />);
    fireEvent.error(images()[0]);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("la figure porte un nom", () => {
    render(<ComparaisonAvantApres avant={AVANT} apres={APRES} libelleZone="Zone synthetique" />);
    expect(within(screen.getByRole("figure")).getByRole("slider")).toBeInTheDocument();
    expect(screen.getByRole("figure", { name: "Comparaison avant et après : Zone synthetique" })).toBeInTheDocument();
  });
});
