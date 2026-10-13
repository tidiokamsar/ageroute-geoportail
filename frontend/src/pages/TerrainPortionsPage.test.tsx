import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * L'écran de terrain : ce que ces tests défendent.
 *
 * LE SEUL VRAI RISQUE EST D'AFFICHER UNE CERTITUDE QUE LE SERVEUR N'A PAS DONNÉE
 *
 * Une page qui montre « RN1, bitume, bon état » alors que rien n'est sûr fait qualifier une
 * route sur laquelle l'agent n'est peut-être pas. Ces tests défendent donc les QUATRE
 * absences et le fait que chacune dit un geste différent :
 *
 *   le GPS ne tranche pas        attendre une meilleure précision
 *   tronçon jamais inventorié    votre relevé sera le premier
 *   trou dans l'inventaire       vous comblez un trou
 *   ambiguïté signalée           vérifiez avant de qualifier
 *
 * ET QUE RIEN N'EST PRÉSENTÉ COMME OFFICIEL
 *
 * Une proposition doit se lire comme telle. C'est la règle du §10 du cahier, et un écran
 * qui l'ignore annule tout le travail de validation côté serveur.
 */

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  contexte: null as unknown,
  refs: {
    revetements: [
      { code: "BETON_BITUMINEUX", libelle: "Béton bitumineux", actif: true },
      { code: "LATERITE", libelle: "Latérite", actif: true },
      { code: "RETIRE", libelle: "Valeur retirée", actif: false },
    ],
    etats: [{ code: "BON", libelle: "Bon", actif: true }],
    praticabilites: [] as { code: string; libelle: string; actif: boolean }[],
    praticabiliteNonDefinie: true,
  },
  succes: null as ((p: unknown) => void) | null,
}));

vi.mock("../lib/api", () => ({ api: h }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { TerrainPortionsPage } from "./TerrainPortionsPage";

const TRONCON = {
  tronconId: "11111111-1111-4111-8111-111111111111",
  code: "GN N0001 3-1216", nom: "Conakry - Coyah", classe: "RN",
  abscisseM: 10_000, pk: 10, pkMotif: "CALCULE", confiance: 0.91, distanceM: 4.2,
};

function contexte(over: Record<string, unknown> = {}) {
  return {
    troncon: TRONCON, motifSansTroncon: null,
    portion: null, motifSansPortion: "TRONCON_NON_QUALIFIE",
    couverture: { longueurTronconM: 20_000, qualifieM: 0, part: 0, trous: [{ debutM: 0, finM: 20_000, longueurM: 20_000 }] },
    actifsProches: [], ambigu: false,
    ...over,
  };
}

beforeEach(() => {
  h.get.mockReset();
  h.post.mockReset();
  h.succes = null;
  h.contexte = contexte();
  h.get.mockImplementation(async (url: string) => {
    if (url.includes("/v2/referentiels")) return { data: h.refs };
    if (url.includes("/v2/field/current-context")) return { data: h.contexte };
    return { data: {} };
  });
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      watchPosition: vi.fn((s: (p: unknown) => void) => { h.succes = s; return 1; }),
      clearWatch: vi.fn(),
    },
  });
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

async function localiser(precision = 5) {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  await user.click(screen.getByRole("button", { name: /Me localiser/ }));
  h.succes?.({ coords: { latitude: 9.5, longitude: -13.7, accuracy: precision }, timestamp: 1_000 });
  await vi.advanceTimersByTimeAsync(2_500);
  return user;
}

describe("Le bandeau qui empêche la confusion", () => {
  it("annonce d'entrée que tout ce qui est saisi est une PROPOSITION", () => {
    render(<TerrainPortionsPage />);
    expect(screen.getByText(/Tout ce qui est saisi ici est une proposition/)).toBeInTheDocument();
  });
});

describe("Les quatre absences disent quatre gestes différents", () => {
  it("GPS insuffisant : invite à attendre, et rappelle que la position brute est gardée", async () => {
    h.contexte = contexte({ troncon: null, motifSansTroncon: "AUCUN_CANDIDAT_SUR", couverture: null, motifSansPortion: null });
    render(<TerrainPortionsPage />);
    await localiser(60);
    expect(await screen.findByText(/Attendez une meilleure\s+précision/)).toBeInTheDocument();
    expect(screen.getByText(/la position brute est conservée/)).toBeInTheDocument();
  });

  it("tronçon JAMAIS inventorié : dit que le relevé sera le premier", async () => {
    render(<TerrainPortionsPage />);
    await localiser();
    expect(await screen.findByText(/votre relevé sera le premier/)).toBeInTheDocument();
  });

  it("TROU dans l'inventaire : dit qu'on comble, et non qu'on commence", async () => {
    // La distinction qui compte. Confondre les deux ferait faire le mauvais geste.
    h.contexte = contexte({
      motifSansPortion: "TROU_DE_QUALIFICATION",
      couverture: { longueurTronconM: 20_000, qualifieM: 15_000, part: 0.75, trous: [{ debutM: 8_000, finM: 13_000, longueurM: 5_000 }] },
    });
    render(<TerrainPortionsPage />);
    await localiser();
    expect(await screen.findByText(/Vous comblez un trou/)).toBeInTheDocument();
    expect(screen.queryByText(/votre relevé sera le premier/)).not.toBeInTheDocument();
  });

  it("AMBIGUÏTÉ : avertit de vérifier avant de qualifier", async () => {
    h.contexte = contexte({ ambigu: true, troncon: { ...TRONCON, confiance: 0.42 } });
    render(<TerrainPortionsPage />);
    await localiser();
    expect(await screen.findByText(/n'est pas sûr/)).toBeInTheDocument();
  });
});

describe("Ce que l'écran dit du tronçon", () => {
  it("nomme les trous par leurs abscisses, pas seulement un pourcentage", async () => {
    // « 75 % qualifié » n'envoie personne nulle part.
    h.contexte = contexte({
      motifSansPortion: "TROU_DE_QUALIFICATION",
      couverture: { longueurTronconM: 20_000, qualifieM: 15_000, part: 0.75, trous: [{ debutM: 8_000, finM: 13_000, longueurM: 5_000 }] },
    });
    render(<TerrainPortionsPage />);
    await localiser();
    expect(await screen.findByText(/8\.00 km à 13\.00 km/)).toBeInTheDocument();
  });

  it("dit que le PK n'est PAS CALCULABLE au lieu d'afficher un vide", async () => {
    // Deux tiers du réseau classé n'ont pas de PK exploitable : un tiret laisserait croire
    // à une donnée manquante plutôt qu'à une impossibilité.
    h.contexte = contexte({ troncon: { ...TRONCON, pk: null, pkMotif: "TRONCON_SANS_PK" } });
    render(<TerrainPortionsPage />);
    await localiser();
    expect(await screen.findByText(/non calculable sur ce tronçon/)).toBeInTheDocument();
  });

  it("marque une portion existante comme PROPOSITION quand elle n'est pas validée", async () => {
    h.contexte = contexte({
      motifSansPortion: null,
      portion: {
        id: "p-1", debutM: 8_000, finM: 13_000, revetement: "LATERITE", etat: "BON",
        praticabilite: null, statutValidation: "A_VALIDER", observeeLe: null, source: null,
      },
    });
    render(<TerrainPortionsPage />);
    await localiser();
    expect(await screen.findByText(/Proposition, non officielle/)).toBeInTheDocument();
  });
});

describe("Le vocabulaire", () => {
  it("ne propose PAS les valeurs retirées du référentiel", async () => {
    render(<TerrainPortionsPage />);
    await localiser();
    await screen.findByRole("option", { name: "Latérite" });
    expect(screen.queryByRole("option", { name: "Valeur retirée" })).not.toBeInTheDocument();
  });

  it("DÉSACTIVE la praticabilité et dit qu'aucune valeur n'a été inventée", async () => {
    // Le point le plus important de ce bloc : l'écran assume le manque au lieu d'afficher
    // un menu vide sans explication, et surtout au lieu d'inventer trois valeurs.
    render(<TerrainPortionsPage />);
    await localiser();
    const champ = await screen.findByLabelText("Praticabilité");
    expect(champ).toBeDisabled();
    expect(screen.getByText(/aucune\s+valeur n'a été inventée/)).toBeInTheDocument();
  });
});

describe("Proposer une portion", () => {
  it("envoie l'abscisse courante comme début, et la longueur saisie", async () => {
    h.post.mockResolvedValue({ data: {} });
    render(<TerrainPortionsPage />);
    const user = await localiser();
    await user.click(screen.getByRole("button", { name: /Proposer cette portion/ }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith("/v2/portions", expect.objectContaining({
      tronconId: TRONCON.tronconId, debutM: 10_000, finM: 11_000,
    })));
  });

  it("n'envoie JAMAIS de statutValidation", async () => {
    // Même ignoré par le serveur, l'envoyer laisserait croire que le client peut décider.
    h.post.mockResolvedValue({ data: {} });
    render(<TerrainPortionsPage />);
    const user = await localiser();
    await user.click(screen.getByRole("button", { name: /Proposer cette portion/ }));
    await waitFor(() => expect(h.post).toHaveBeenCalled());
    expect(h.post.mock.calls[0][1]).not.toHaveProperty("statutValidation");
  });

  it("fait suivre la confiance du rattachement à la portion", async () => {
    // Qualifier depuis un appariement douteux ne produit pas une observation sûre.
    h.contexte = contexte({ troncon: { ...TRONCON, confiance: 0.42 } });
    h.post.mockResolvedValue({ data: {} });
    render(<TerrainPortionsPage />);
    const user = await localiser();
    await user.click(screen.getByRole("button", { name: /Proposer cette portion/ }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith("/v2/portions",
      expect.objectContaining({ confiance: "LOW" })));
  });

  it("REFUSE une longueur sous le plancher sans appeler le serveur", async () => {
    render(<TerrainPortionsPage />);
    const user = await localiser();
    const champ = screen.getByLabelText(/Longueur de la portion/);
    await user.clear(champ);
    await user.type(champ, "4");
    await user.click(screen.getByRole("button", { name: /Proposer cette portion/ }));
    expect(h.post).not.toHaveBeenCalled();
  });
});

describe("Les ouvrages à proximité", () => {
  it("dit explicitement qu'il n'y en a aucun, au lieu d'une liste vide muette", async () => {
    render(<TerrainPortionsPage />);
    await localiser();
    expect(await screen.findByText(/Aucun ouvrage recensé dans les 150 mètres/)).toBeInTheDocument();
  });

  it("les liste avec leur distance", async () => {
    h.contexte = contexte({
      actifsProches: [{ id: "o-1", type: "PONT", nom: "Pont de la Moribaya", distanceM: 42.6, etat: "MOYEN" }],
    });
    render(<TerrainPortionsPage />);
    await localiser();
    expect(await screen.findByText(/Pont de la Moribaya/)).toBeInTheDocument();
    expect(screen.getByText("43 m")).toBeInTheDocument();
  });
});
