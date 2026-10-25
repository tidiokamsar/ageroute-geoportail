import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Saisies de télédétection : ce que ces tests défendent.
 *   - un produit optique exige sa couverture nuageuse, un palier payant sa référence de dépense ;
 *   - l'emprise part en Polygon fermé ; rien n'est prérempli (licence comprise) ;
 *   - un lot ne propose comme référence que des produits ANTÉRIEURS ;
 *   - sans tolérance, la tolérance part nulle ; un lot fautif ne part pas.
 */

const h = vi.hoisted(() => ({ posts: [] as { url: string; corps: Record<string, unknown> }[] }));
vi.mock("../../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../../lib/api", () => ({
  api: { post: vi.fn(async (url: string, corps: Record<string, unknown>) => { h.posts.push({ url, corps }); return { data: { deposees: 1, rattachees: 0 } }; }) },
}));

import { DepotModal, ProduitModal } from "./Saisies";

const rendre = (el: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{el}</QueryClientProvider>);
const saisir = (label: RegExp | string, valeur: string) => fireEvent.change(screen.getByLabelText(label), { target: { value: valeur } });

beforeEach(() => { h.posts.length = 0; });

describe("ProduitModal", () => {
  it("exige couverture nuageuse (optique) et autorisation (palier payant), puis envoie l'emprise fermée", async () => {
    rendre(<ProduitModal open onClose={() => {}} onFait={() => {}} />);
    const bouton = screen.getByRole("button", { name: "Enregistrer le produit" });
    expect(screen.getByLabelText(/Licence/)).toHaveValue("");
    saisir("Code (unique)", "S2-20261001"); saisir(/^Source/, "Sentinel-2 L2A"); saisir("Nature", "OPTIQUE");
    saisir("Résolution (m)", "10"); saisir("Acquisition (début)", "2026-10-01"); saisir("Version de traitement", "v0");
    saisir(/^Incertitude/, "+/- 1 pixel"); saisir(/^Provenance/, "scene-id"); saisir(/^Licence/, "relevée à la source");
    saisir("Ouest", "-13.7"); saisir("Sud", "9.5"); saisir("Est", "-13.4"); saisir("Nord", "9.8");
    expect(screen.getByText(/couverture nuageuse \(optique\)/)).toBeInTheDocument();
    expect(bouton).toBeDisabled();
    saisir(/^Couverture nuageuse/, "12");
    saisir("Palier", "1");
    expect(screen.getByText(/autorisation de dépense \(palier payant\)/)).toBeInTheDocument();
    saisir("Référence de l'autorisation de dépense", "DEC-2026-001");
    fireEvent.click(bouton);
    await waitFor(() => expect(h.posts[0]?.url).toBe("/v2/teledetection/produits"));
    expect(h.posts[0].corps).toMatchObject({ palier: 1, couvertureNuagesPct: 12, autorisationDepenseRef: "DEC-2026-001", emprise: { type: "Polygon" } });
    expect((h.posts[0].corps.emprise as { coordinates: number[][][] }).coordinates[0]).toHaveLength(5);
  });
  it("refuse une emprise inversée", () => {
    rendre(<ProduitModal open onClose={() => {}} onFait={() => {}} />);
    saisir("Ouest", "-13.4"); saisir("Sud", "9.5"); saisir("Est", "-13.7"); saisir("Nord", "9.8");
    expect(screen.getByText(/L'est doit être à droite/)).toBeInTheDocument();
  });
});

describe("DepotModal", () => {
  const produits = [
    { id: "p-avant", code: "S2-AVANT", nature: "OPTIQUE", dateAcquisition: "2026-09-01", source: "Sentinel-2" },
    { id: "p-apres", code: "S1-APRES", nature: "RADAR", dateAcquisition: "2026-10-02", source: "Sentinel-1" },
    { id: "p-tard", code: "S1-TARD", nature: "RADAR", dateAcquisition: "2026-10-20", source: "Sentinel-1" },
  ];
  it("ne propose que les références antérieures ; sans tolérance elle part nulle", async () => {
    rendre(<DepotModal open produits={produits} onClose={() => {}} onFait={() => {}} />);
    saisir("Produit analysé", "p-apres");
    const ref = screen.getByLabelText(/Produit de référence/);
    expect([...(ref as HTMLSelectElement).options].map((o) => o.value)).toEqual(["", "p-avant"]);
    saisir(/Méthode/, "seuil-sar v0");
    saisir(/Type par défaut/, "INONDATION");
    saisir("ou GeoJSON collé", JSON.stringify({ type: "Point", coordinates: [-13.6, 9.6] }));
    expect(screen.getByText(/1 proposition\(s\) prête\(s\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Déposer le lot" }));
    await waitFor(() => expect(h.posts[0]?.url).toBe("/v2/teledetection/propositions"));
    expect(h.posts[0].corps).toMatchObject({ produitId: "p-apres", produitReferenceId: null, toleranceRattachementM: null, propositions: [{ type: "INONDATION", score: null }] });
  });
  it("un lot fautif ne part pas, et la faute est nommée", () => {
    rendre(<DepotModal open produits={produits} onClose={() => {}} onFait={() => {}} />);
    saisir("Produit analysé", "p-apres"); saisir(/Méthode/, "m");
    saisir("ou GeoJSON collé", JSON.stringify({ type: "Point", coordinates: [-13.6, 9.6] }));
    expect(screen.getByText(/Entité 1 : type absent/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Déposer le lot" })).toBeDisabled();
  });
});
