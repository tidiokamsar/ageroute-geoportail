import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { violationsAccessibilite } from "../test/accessibilite";

/**
 * Route entre deux villes (page Tronçons). Ce que ces tests défendent :
 *   - les tronçons de la route sont listés DANS L'ORDRE, avec leur état et la part parcourue ;
 *   - un tronçon parcouru en partie est dit, et dit que le changement d'état vaut pour le tronçon entier ;
 *   - le serveur ne trouve aucune route continue : l'écran le dit et ne montre AUCUNE liste, ni ligne droite ;
 *   - le changement d'état de l'ensemble n'est offert qu'à qui peut écrire ;
 *   - Sangarédi et Télimélé sont proposées par la recherche de ville ;
 *   - zéro violation d'accessibilité.
 */
const h = vi.hoisted(() => ({
  role: "GESTIONNAIRE" as string,
  appels: [] as { url: string; params: Record<string, number> }[],
  reponse: "ok" as "ok" | "aucun_chemin" | "panne",
}));

vi.mock("../lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", role: h.role } }),
  canWrite: (r: string | undefined) => r === "ADMIN" || r === "GESTIONNAIRE",
}));
vi.mock("./ChangerEtatCorridor", () => ({
  ChangerEtatCorridor: (p: { ids: string[]; libelle: string }) => <button type="button">Changer l'état du corridor ({p.ids.length}) {p.libelle}</button>,
}));
vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string, opts: { params: Record<string, number> }) => {
      h.appels.push({ url, params: opts.params });
      if (h.reponse === "aucun_chemin") {
        throw { response: { status: 422, data: { error: "Le referentiel est interrompu entre les deux positions.", code: "AUCUN_CHEMIN" } } };
      }
      if (h.reponse === "panne") throw new Error("reseau");
      return {
        data: {
          longueurM: 112_300, droiteM: 98_000,
          troncons: [
            { ordre: 1, id: "t1", code: "GN N0071", nom: "Sangarédi - Boké Nord", classe: "RN", etat: "MAUVAIS", region: "Boké", longueurM: 20_000, parcourM: 6_000, partiel: true, sens: "+" },
            { ordre: 2, id: "t2", code: "GN N0072", nom: "Boké Nord - Télimélé", classe: "RN", etat: "MOYEN", region: "Kindia", longueurM: 90_000, parcourM: 90_000, partiel: false, sens: "+" },
            { ordre: 3, id: "t3", code: "GN N0073", nom: "Télimélé entrée", classe: "RN", etat: "BON", region: "Kindia", longueurM: 30_000, parcourM: 16_300, partiel: true, sens: "+" },
          ],
          depart: { accrochageM: 120, tronconId: "t1" }, arrivee: { accrochageM: 80, tronconId: "t3" },
          parametres: { rayonAccrochageM: 10_000, toleranceFusionM: 15, nbTronconsCharges: 412 },
          avertissements: ["Un troncon n'est parcouru qu'en partie : changer son etat change l'etat du troncon ENTIER."],
        },
      };
    }),
  },
}));

import { RouteEntreVilles } from "./RouteEntreVilles";

function rendre() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><RouteEntreVilles /></QueryClientProvider>);
}

/** Ouvre le panneau et choisit deux villes dans la recherche. */
async function choisir(a = "Sangar", b = "Télim") {
  fireEvent.click(screen.getByRole("button", { name: /Route entre deux villes/ }));
  const champA = await screen.findByPlaceholderText("Ville ou localité…");
  fireEvent.change(champA, { target: { value: a } });
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${a}`, "i") }));
  const champB = await screen.findByPlaceholderText("vers…");
  fireEvent.change(champB, { target: { value: b } });
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${b}`, "i") }));
  fireEvent.click(screen.getByRole("button", { name: "Afficher" }));
}

beforeEach(() => { h.role = "GESTIONNAIRE"; h.appels = []; h.reponse = "ok"; });
afterEach(cleanup);

describe("route entre deux villes", () => {
  it("est repliée par défaut : aucun calcul tant qu'on ne l'ouvre pas", () => {
    rendre();
    expect(screen.getByRole("button", { name: /Route entre deux villes/ })).toHaveAttribute("aria-expanded", "false");
    expect(h.appels).toHaveLength(0);
  });

  it("Sangarédi et Télimélé sont proposées, et le serveur reçoit leurs positions", async () => {
    rendre();
    await choisir();
    await screen.findByText(/3 tronçon\(s\)/);
    expect(h.appels).toHaveLength(1);
    expect(h.appels[0].url).toBe("/v2/troncons-recherche/chemin");
    expect(h.appels[0].params).toMatchObject({ deLat: 11.1, deLon: -13.77, versLat: 10.9, versLon: -12.79 });
  });

  it("liste les tronçons dans l'ordre, avec état, région et part parcourue ; le partiel est dit", async () => {
    rendre();
    await choisir();
    const table = await screen.findByRole("table", { name: /Tronçons de la route Sangarédi vers Télimélé/ });
    const lignes = Array.from(table.querySelectorAll("tbody tr"));
    expect(lignes.map((l) => l.querySelector("td:nth-child(2)")?.textContent)).toEqual(["GN N0071", "GN N0072", "GN N0073"]);
    expect(lignes[0]).toHaveTextContent(/partiel/);
    expect(lignes[1]).not.toHaveTextContent(/partiel/);
    expect(screen.getByText(/2 tronçon\(s\) ne sont parcourus qu'en partie.*tronçon ENTIER/)).toBeInTheDocument();
    expect(screen.getByText(/par le réseau/)).toHaveTextContent(/à vol d'oiseau/);
    expect(screen.getByText(/ce n'est pas « la route officielle »/)).toBeInTheDocument();
  });

  it("un compte qui peut écrire a le changement d'état de TOUS les tronçons de la route ; un lecteur ne l'a pas", async () => {
    const premier = rendre();
    await choisir();
    expect(await screen.findByRole("button", { name: /Changer l'état du corridor \(3\) Sangarédi ↔ Télimélé/ })).toBeInTheDocument();
    premier.unmount();
    h.role = "LECTEUR";
    rendre();
    await choisir();
    await screen.findByText(/3 tronçon\(s\)/);
    expect(screen.queryByRole("button", { name: /Changer l'état du corridor/ })).not.toBeInTheDocument();
  });

  it("aucune route continue : l'écran le dit, sans liste ni ligne droite, et sans action de masse", async () => {
    h.reponse = "aucun_chemin";
    rendre();
    await choisir();
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent(/Aucune route continue dans le référentiel/);
    expect(alerte).toHaveTextContent(/Aucune ligne droite n'est substituée/);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Changer l'état du corridor/ })).not.toBeInTheDocument();
  });

  it("une panne du serveur est dite comme une panne, pas comme une absence de route", async () => {
    h.reponse = "panne";
    rendre();
    await choisir();
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent(/Route non calculée/);
    expect(alerte).not.toHaveTextContent(/Aucune route continue/);
  });

  it("une seule ville choisie : on demande la seconde, sans rien calculer", async () => {
    rendre();
    fireEvent.click(screen.getByRole("button", { name: /Route entre deux villes/ }));
    const champA = await screen.findByPlaceholderText("Ville ou localité…");
    fireEvent.change(champA, { target: { value: "Sangar" } });
    fireEvent.click(await screen.findByRole("button", { name: /^Sangar/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Afficher" }));
    expect(await screen.findByText(/Choisir une seconde ville/)).toBeInTheDocument();
    await waitFor(() => expect(h.appels).toHaveLength(0));
  });

  it("zéro violation d'accessibilité, panneau ouvert avec une route", async () => {
    const { container } = rendre();
    await choisir();
    await screen.findByRole("table");
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});
