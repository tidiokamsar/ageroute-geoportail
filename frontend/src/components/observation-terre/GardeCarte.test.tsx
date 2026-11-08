import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GardeCarte } from "./GardeCarte";
import { violationsAccessibilite } from "../../test/accessibilite";

/** Garde-fou autour de la carte : l'exception s'arrete la, le reste de la page continue de vivre. */

let leve = true;
function Fragile() {
  if (leve) throw new Error("Invalid GeoJSON object.");
  return <p>carte vivante</p>;
}

beforeEach(() => {
  leve = true;
  // React journalise l'exception interceptee : on la tait pour garder la sortie des tests lisible.
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe("GardeCarte", () => {
  it("laisse passer une carte saine", () => {
    leve = false;
    render(<GardeCarte><Fragile /></GardeCarte>);
    expect(screen.getByText("carte vivante")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("intercepte l'exception : message, detail technique, bouton Reessayer ; les freres du garde-fou restent affiches", () => {
    render(<div><p>reste de la page</p><GardeCarte><Fragile /></GardeCarte></div>);
    const alerte = screen.getByRole("alert");
    expect(alerte).toHaveTextContent("La carte n'a pas pu s'afficher.");
    expect(alerte).toHaveTextContent("Détail technique : Invalid GeoJSON object.");
    expect(alerte).toHaveTextContent("restent utilisables");
    expect(screen.getByRole("button", { name: "Réessayer : carte" })).toBeInTheDocument();
    expect(screen.getByText("reste de la page")).toBeInTheDocument();
  });

  it("trace l'erreur pour le support", () => {
    render(<GardeCarte><Fragile /></GardeCarte>);
    expect(console.error).toHaveBeenCalledWith("[Observation de la Terre] la carte a echoue", expect.any(Error), expect.any(String));
  });

  it("Reessayer previent le parent, puis remonte la carte a neuf ; si elle leve encore, le garde-fou reprend la main", async () => {
    const onReessayer = vi.fn();
    const u = userEvent.setup();
    render(<GardeCarte onReessayer={onReessayer}><Fragile /></GardeCarte>);
    await u.click(screen.getByRole("button", { name: "Réessayer : carte" }));
    expect(onReessayer).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toBeInTheDocument(); // leve encore
    leve = false;
    await u.click(screen.getByRole("button", { name: "Réessayer : carte" }));
    expect(onReessayer).toHaveBeenCalledTimes(2);
    expect(screen.getByText("carte vivante")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("une exception sans message reste dite", () => {
    function Muette(): never { throw new Error(""); }
    render(<GardeCarte><Muette /></GardeCarte>);
    expect(screen.getByRole("alert")).toHaveTextContent("erreur sans message");
  });

  it("sans violation d'accessibilite", async () => {
    const { container } = render(<GardeCarte><Fragile /></GardeCarte>);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});
