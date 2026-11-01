import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * A1 : OUVERTURE DU MODE TERRAIN, parcours complet cote ecran.
 *
 * `usePositionGps` a ses propres tests (le hook seul). Ce fichier eprouve ce que l'agent VOIT et PEUT
 * FAIRE quand il ouvre l'ecran de terrain : chaque cause d'echec de position, la reprise apres une
 * autorisation refusee, l'ouverture sans reseau, le contexte demande au bon moment, et l'arret du GPS
 * quand il quitte l'ecran.
 *
 * CE QUE CES TESTS NE PROUVENT PAS : une seule de ces situations sur un telephone. `navigator.geolocation`
 * est ici un double ; la fenetre d'autorisation du navigateur, la puce GPS, la perte de signal reelle,
 * la consommation de batterie et le service worker ne s'eprouvent que sur un appareil. Le statut de
 * A1 reste « jamais eprouve sur appareil ».
 */
const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  succes: null as ((p: unknown) => void) | null,
  echec: null as ((e: { code: number }) => void) | null,
  veilles: 0,
  effacees: [] as number[],
  toasts: [] as string[],
}));

vi.mock("../lib/api", () => ({ api: h }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: (m: string) => { h.toasts.push(m); } } }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u-agent" } }) }));
vi.mock("../hooks/useOfflineSync", () => ({ useOfflineSync: () => ({ pendingCount: 0, syncing: false }) }));
vi.mock("../lib/offlineDb", () => ({ addPendingPortion: async () => undefined }));
vi.mock("../lib/offlineSync", () => ({ refreshPendingCount: async () => undefined, syncPendingOfflineData: async () => undefined }));

import { TerrainPortionsPage } from "./TerrainPortionsPage";

const TRONCON = {
  tronconId: "11111111-1111-4111-8111-111111111111", code: "GN N0001 3-1216", nom: "Conakry - Coyah", classe: "RN",
  abscisseM: 10_000, pk: 10, pkMotif: "CALCULE", confiance: 0.91, distanceM: 4.2,
};
const CONTEXTE = {
  troncon: TRONCON, motifSansTroncon: null, portion: null, motifSansPortion: "TRONCON_NON_QUALIFIE",
  couverture: { longueurTronconM: 20_000, qualifieM: 0, part: 0, trous: [{ debutM: 0, finM: 20_000, longueurM: 20_000 }] },
  actifsProches: [], ambigu: false,
};
const REFS = { revetements: [{ code: "LATERITE", libelle: "Latérite", actif: true }], etats: [{ code: "BON", libelle: "Bon", actif: true }], praticabilites: [], praticabiliteNonDefinie: true };

const appelsContexte = () => h.get.mock.calls.filter((c) => String(c[0]).includes("/v2/field/current-context"));
const position = (lat: number, lon: number, precision = 5, t = 1_000) => ({ coords: { latitude: lat, longitude: lon, accuracy: precision }, timestamp: t });
const erreurReseau = () => Object.assign(new Error("Network Error"), { isAxiosError: true, response: undefined });

function installerGeolocalisation() {
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      watchPosition: vi.fn((s: (p: unknown) => void, e: (x: { code: number }) => void) => { h.succes = s; h.echec = e; h.veilles += 1; return h.veilles; }),
      clearWatch: vi.fn((id: number) => { h.effacees.push(id); }),
    },
  });
}

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset();
  h.succes = null; h.echec = null; h.veilles = 0; h.effacees.length = 0; h.toasts.length = 0;
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  h.get.mockImplementation(async (url: string) => (url.includes("/v2/referentiels") ? { data: REFS } : { data: CONTEXTE }));
  installerGeolocalisation();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => { vi.useRealTimers(); });

const ouvrir = async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const rendu = render(<TerrainPortionsPage />);
  return { user, ...rendu };
};
const localiser = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("button", { name: /Me localiser/ }));

describe("A1 : l'ouverture ne demande RIEN a l'appareil tant que l'agent ne le demande pas", () => {
  it("affiche le bandeau « proposition » et le bouton, sans ouvrir de veille GPS ni demander de contexte", async () => {
    await ouvrir();
    expect(screen.getByText(/Tout ce qui est saisi ici est une proposition/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Me localiser/ })).toBeEnabled();
    expect(h.veilles).toBe(0);                                   // la fenetre d'autorisation du navigateur ne s'ouvre pas d'elle-meme
    expect(appelsContexte()).toHaveLength(0);
  });

  it("charge les vocabulaires a l'ouverture, et dit quand ils manquent", async () => {
    h.get.mockImplementation(async (url: string) => { if (url.includes("/v2/referentiels")) throw erreurReseau(); return { data: CONTEXTE }; });
    await ouvrir();
    await waitFor(() => expect(h.toasts.join()).toContain("Vocabulaires indisponibles"));
  });
});

describe("A1 : chaque cause d'echec de position dit un geste different, et chacune se rattrape", () => {
  it("appareil SANS geolocalisation : le dit, et propose la saisie a la main, sans ouvrir de veille", async () => {
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: undefined });
    const { user } = await ouvrir();
    await localiser(user);
    expect(screen.getByText(/n'a pas de géolocalisation/)).toBeInTheDocument();
    expect(screen.getByText(/à la main/)).toBeInTheDocument();
    expect(h.veilles).toBe(0);
  });

  it("autorisation REFUSEE : le dit, et le bouton redevient « Me localiser » pour reessayer (pas « Arreter le suivi »)", async () => {
    const { user } = await ouvrir();
    await localiser(user);
    h.echec?.({ code: 1 });
    await waitFor(() => expect(screen.getByText(/Autorisation refusée/)).toBeInTheDocument());
    expect(screen.getByText(/réglages du navigateur/)).toBeInTheDocument();
    // La veille est terminee par le navigateur apres un refus : proposer « Arreter le suivi » mentirait.
    expect(screen.queryByRole("button", { name: /Arrêter le suivi/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Me localiser/ })).toBeInTheDocument();
    expect(h.effacees).toEqual([1]);                              // l'ancienne veille est bien nettoyee
  });

  it("apres un refus, l'agent accorde l'autorisation, relance, et la position arrive : l'erreur disparait", async () => {
    const { user } = await ouvrir();
    await localiser(user);
    h.echec?.({ code: 1 });
    await waitFor(() => expect(screen.getByText(/Autorisation refusée/)).toBeInTheDocument());
    await localiser(user);                                         // second essai, apres reglage du navigateur
    expect(h.veilles).toBe(2);
    h.succes?.(position(9.5, -13.7));
    await waitFor(() => expect(screen.queryByText(/Autorisation refusée/)).not.toBeInTheDocument());
    expect(screen.getByText("9.500000")).toBeInTheDocument();
  });

  it("signal INTROUVABLE : dit de sortir a decouvert, et la veille RESTE active pour que le point arrive", async () => {
    const { user } = await ouvrir();
    await localiser(user);
    h.echec?.({ code: 3 });
    await waitFor(() => expect(screen.getByText(/Signal introuvable/)).toBeInTheDocument());
    expect(screen.getByText(/Sortez à découvert/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Arrêter le suivi/ })).toBeInTheDocument();   // elle continue de chercher
    h.succes?.(position(9.5, -13.7, 12));
    await waitFor(() => expect(screen.queryByText(/Signal introuvable/)).not.toBeInTheDocument());
  });

  it("annonce « Recherche du signal » entre la demande et le premier point", async () => {
    const { user } = await ouvrir();
    await localiser(user);
    expect(screen.getByText(/Recherche du signal/)).toBeInTheDocument();
    h.succes?.(position(9.5, -13.7));
    await waitFor(() => expect(screen.queryByText(/Recherche du signal/)).not.toBeInTheDocument());
  });
});

describe("A1 : la precision est affichee, avec son evolution", () => {
  it("montre la precision annoncee, et « s'ameliore » quand l'incertitude diminue", async () => {
    const { user } = await ouvrir();
    await localiser(user);
    h.succes?.(position(9.5, -13.7, 60, 1_000));
    h.succes?.(position(9.5, -13.7, 8, 2_000));
    await waitFor(() => expect(screen.getByText("8 m")).toBeInTheDocument());
    expect(screen.getByText(/s'améliore/)).toBeInTheDocument();
  });

  it("dit « se degrade » quand l'incertitude augmente (l'agent entre dans un batiment)", async () => {
    const { user } = await ouvrir();
    await localiser(user);
    h.succes?.(position(9.5, -13.7, 6, 1_000));
    h.succes?.(position(9.5, -13.7, 70, 2_000));
    await waitFor(() => expect(screen.getByText(/se dégrade/)).toBeInTheDocument());
  });
});

describe("A1 : le contexte est demande au bon moment, avec ce que l'appareil a vraiment mesure", () => {
  it("interroge le serveur deux secondes apres le premier point, avec la position ET la precision", async () => {
    const { user } = await ouvrir();
    await localiser(user);
    h.succes?.(position(9.5, -13.7, 7));
    expect(appelsContexte()).toHaveLength(0);                      // pas de requete par point GPS
    await vi.advanceTimersByTimeAsync(2_500);
    await waitFor(() => expect(appelsContexte()).toHaveLength(1));
    expect(appelsContexte()[0][1]).toEqual({ params: { lat: 9.5, lon: -13.7, precisionM: 7 } });
    await waitFor(() => expect(screen.getByText("GN N0001 3-1216")).toBeInTheDocument());
  });

  it("ne redemande PAS le contexte pour une oscillation du GPS (moins de 15 m), mais le redemande apres un vrai deplacement", async () => {
    const { user } = await ouvrir();
    await localiser(user);
    h.succes?.(position(9.5, -13.7, 5, 1_000));
    await vi.advanceTimersByTimeAsync(2_500);
    await waitFor(() => expect(appelsContexte()).toHaveLength(1));
    h.succes?.(position(9.50005, -13.7, 5, 3_000));                // ~5,5 m : bruit
    await vi.advanceTimersByTimeAsync(2_500);
    expect(appelsContexte()).toHaveLength(1);
    h.succes?.(position(9.5005, -13.7, 5, 5_000));                 // ~55 m : l'agent a marche
    await vi.advanceTimersByTimeAsync(2_500);
    await waitFor(() => expect(appelsContexte()).toHaveLength(2));
  });

  it("une rafale de points ne produit qu'UNE requete (le dernier point l'emporte)", async () => {
    const { user } = await ouvrir();
    await localiser(user);
    for (let i = 0; i < 5; i++) h.succes?.(position(9.5 + i * 1e-5, -13.7, 5, 1_000 + i));
    await vi.advanceTimersByTimeAsync(2_500);
    await waitFor(() => expect(appelsContexte()).toHaveLength(1));
    expect(appelsContexte()[0][1].params.lat).toBeCloseTo(9.50004, 6);
  });
});

describe("A1 : ouvert SANS reseau, le GPS fonctionne et rien n'est perdu", () => {
  it("le GPS ne depend pas du reseau : la position s'affiche meme si le serveur est injoignable", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    h.get.mockImplementation(async () => { throw erreurReseau(); });
    const { user } = await ouvrir();
    await localiser(user);
    h.succes?.(position(9.5, -13.7, 9));
    await waitFor(() => expect(screen.getByText("9.500000")).toBeInTheDocument());
    expect(screen.getByText("9 m")).toBeInTheDocument();
  });

  it("le contexte indisponible est annonce, la position brute est conservee, et l'agent ne peut pas qualifier a l'aveugle", async () => {
    h.get.mockImplementation(async (url: string) => { if (url.includes("/v2/referentiels")) return { data: REFS }; throw erreurReseau(); });
    const { user } = await ouvrir();
    await localiser(user);
    h.succes?.(position(9.5, -13.7, 9));
    await vi.advanceTimersByTimeAsync(2_500);
    await waitFor(() => expect(h.toasts.join()).toContain("Contexte indisponible. La position brute reste conservée."));
    expect(screen.getByText("9.500000")).toBeInTheDocument();      // la position n'a pas disparu
    expect(screen.queryByText("GN N0001 3-1216")).not.toBeInTheDocument();   // aucun troncon affiche sans reponse du serveur
  });

  it("au retour du reseau, le contexte est obtenu au point suivant, sans recharger l'ecran", async () => {
    let reseau = false;
    h.get.mockImplementation(async (url: string) => {
      if (url.includes("/v2/referentiels")) return { data: REFS };
      if (!reseau) throw erreurReseau();
      return { data: CONTEXTE };
    });
    const { user } = await ouvrir();
    await localiser(user);
    h.succes?.(position(9.5, -13.7, 5, 1_000));
    await vi.advanceTimersByTimeAsync(2_500);
    await waitFor(() => expect(appelsContexte()).toHaveLength(1));
    expect(screen.queryByText("GN N0001 3-1216")).not.toBeInTheDocument();
    reseau = true;
    h.succes?.(position(9.5002, -13.7, 5, 4_000));                 // le point suivant, apres un vrai deplacement
    await vi.advanceTimersByTimeAsync(2_500);
    await waitFor(() => expect(screen.getByText("GN N0001 3-1216")).toBeInTheDocument());
  });
});

describe("A1 : quitter l'ecran arrete le GPS", () => {
  it("le demontage efface la veille (une veille oubliee vide la batterie)", async () => {
    const { user, unmount } = await ouvrir();
    await localiser(user);
    expect(h.effacees).toEqual([]);
    unmount();
    expect(h.effacees).toEqual([1]);
  });

  it("« Arreter le suivi » efface la veille et rend le bouton « Me localiser »", async () => {
    const { user } = await ouvrir();
    await localiser(user);
    await user.click(screen.getByRole("button", { name: /Arrêter le suivi/ }));
    expect(h.effacees).toEqual([1]);
    expect(screen.getByRole("button", { name: /Me localiser/ })).toBeInTheDocument();
  });

  it("un seul clic sur « Me localiser » n'ouvre qu'UNE veille", async () => {
    const { user } = await ouvrir();
    await localiser(user);
    expect(h.veilles).toBe(1);
  });
});
