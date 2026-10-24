import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * TronconPickerGeo — trouver un tronçon sans connaître son code.
 *
 *   - trois portes d'entrée visibles d'un coup d'œil (GPS, ville, texte) ;
 *   - le refus de position n'est pas un cul-de-sac : le message PROPOSE les autres
 *     portes, et la recherche par ville reste utilisable ;
 *   - la ville résolue déclenche la requête avec ses coordonnées (la ville n'est qu'un
 *     cas du GPS : un seul mécanisme serveur, décision D4 — liste locale, jamais en base) ;
 *   - choisir un résultat remonte l'objet COMPLET (l'appelant décide : présélection,
 *     fiche, rattachement à juger).
 *
 * (La géolocalisation est simulée : jsdom n'a pas de GPS.)
 */
const h = vi.hoisted(() => ({
  gets: [] as { url: string; params: Record<string, string> }[],
  resultats: [] as unknown[],
  position: { lat: 9.64, lon: -13.68 },
  positionRefusee: false,
}));
vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string, { params }: { params: Record<string, string> }) => {
      h.gets.push({ url, params });
      return { data: { data: h.resultats } };
    }),
  },
}));

import { TronconPickerGeo, type TronconTrouve } from "./TronconPickerGeo";

function rendre(onChoisir: (t: TronconTrouve) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><TronconPickerGeo onChoisir={onChoisir} /></QueryClientProvider>);
}

beforeEach(() => {
  h.gets = [];
  h.positionRefusee = false;
  h.position = { lat: 9.64, lon: -13.68 };
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      getCurrentPosition: (ok: (p: { coords: { latitude: number; longitude: number } }) => void, ko: (e: { code: number }) => void) => {
        if (h.positionRefusee) ko({ code: 1 });
        else ok({ coords: { latitude: h.position.lat, longitude: h.position.lon } });
      },
    },
  });
});

describe("TronconPickerGeo", () => {
  it("« Près de moi » lance la recherche par les coordonnées de l'appareil", async () => {
    const u = userEvent.setup({ delay: null });
    rendre(vi.fn());
    await u.click(await screen.findByRole("button", { name: /Près de moi/ }));
    await waitFor(() => expect(h.gets).toHaveLength(1));
    expect(h.gets[0].url).toBe("/v2/troncons-recherche");
    expect(h.gets[0].params).toMatchObject({ lat: "9.64", lon: "-13.68" });
  });

  it("un refus de position propose les autres portes et ne bloque rien", async () => {
    h.positionRefusee = true;
    const u = userEvent.setup({ delay: null });
    rendre(vi.fn());
    await u.click(await screen.findByRole("button", { name: /Près de moi/ }));
    const statut = await screen.findByRole("status");
    expect(statut).toHaveTextContent(/refusée|indisponible/);
    expect(statut).toHaveTextContent(/ville ou par texte/);
    // La recherche par ville reste utilisable derrière le refus.
    await u.type(screen.getByLabelText(/Chercher par ville/), "Kindia");
    expect(screen.getByRole("option", { name: /Kindia/ })).toBeInTheDocument();
  });

  it("choisir un chef-lieu recherche autour de ses coordonnées (décision D4 : liste locale)", async () => {
    const u = userEvent.setup({ delay: null });
    rendre(vi.fn());
    const champ = await screen.findByLabelText(/Chercher par ville/);
    champ.focus();
    await u.type(champ, "Kindia");
    await u.click(await screen.findByRole("option", { name: /Kindia/ }));
    await waitFor(() => expect(h.gets).toHaveLength(1));
    expect(h.gets[0].params.lat).toBeDefined();
    expect(h.gets[0].params.lon).toBeDefined();
  });

  it("deux caractères au texte déclenchent la recherche par fragment", async () => {
    const u = userEvent.setup({ delay: null });
    rendre(vi.fn());
    await u.type(await screen.findByLabelText(/Chercher par code ou nom/), "RN");
    await waitFor(() => expect(h.gets.length).toBeGreaterThan(0));
    expect(h.gets[0].params.q).toBe("RN");
  });

  it("choisir un résultat remonte l'objet complet", async () => {
    const choisir = vi.fn();
    h.resultats = [{ id: "t-1", code: "GN N0001", nom: "Conakry - Coyah", region: "Conakry", longueurKm: 42, distanceM: 3100 }];
    const u = userEvent.setup({ delay: null });
    rendre(choisir);
    await u.type(await screen.findByLabelText(/Chercher par code ou nom/), "Coyah");
    await u.click(await screen.findByRole("option", { name: /Conakry - Coyah/ }));
    expect(choisir).toHaveBeenCalledWith(expect.objectContaining({ id: "t-1", distanceM: 3100 }));
  });
});
