import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  enFile: [] as unknown[],
  syncLance: 0,
  /** Options passees a chaque `syncPendingOfflineData` (le bouton « Envoyer maintenant » doit passer `{ manuel: true }`). */
  syncOptions: [] as unknown[],
  pendingCount: 0,
  /** Erreur que l'ecriture locale doit lever (stockage plein, coffre verrouille...). */
  echecFile: null as unknown,
  /** Portions deja presentes dans la file locale, lues par le panneau des saisies refusees pour droits. */
  portionsFile: [] as Record<string, unknown>[],
  /** `relancerRefusDroits` : le renvoi explicite d'une saisie en quarantaine. */
  relancerDroits: vi.fn(),
  /** Lectures des deux autres files par le panneau : il ne doit lire QUE celle des portions (`files={["portions"]}`). */
  lireDefauts: vi.fn(async (): Promise<unknown[]> => []),
  lireObservations: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock("../lib/api", () => ({ api: h }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u-agent" } }) }));
vi.mock("../hooks/useOfflineSync", () => ({
  useOfflineSync: () => ({
    pendingCount: h.pendingCount, syncing: false,
    refusDroitsCount: h.portionsFile.filter((p) => p.status === "refus_droits" && p.ownerUserId === "u-agent").length,
  }),
}));
vi.mock("../lib/offlineDb", () => ({
  addPendingPortion: async (item: unknown) => { if (h.echecFile) throw h.echecFile; h.enFile.push(item); },
  getAllPendingPortions: async () => h.portionsFile,
  getAllPendingDefauts: () => h.lireDefauts(),
  getAllPendingObservations: () => h.lireObservations(),
  STATUT_REFUS_DROITS: "refus_droits",
}));
vi.mock("../lib/offlineSync", () => ({
  refreshPendingCount: async () => {},
  syncPendingOfflineData: async (options?: unknown) => { h.syncLance += 1; h.syncOptions.push(options); },
  relancerRefusDroits: (localId: string, file: string) => h.relancerDroits(localId, file),
  etatSynchronisation: () => ({ appareilRevoque: false, compteInactif: false, message: null }),
  MESSAGES_REFUS_DROITS: {
    HORS_PERIMETRE: "Cette saisie est hors de votre périmètre territorial actuel.",
    REGION_INCONNUE: "La région de cette saisie n'a pas pu être rattachée à votre périmètre.",
    MODULE_RETIRE: "Le module de cette saisie a été retiré de votre compte.",
    MISSION_NON_AUTORISEE: "La mission de cette saisie ne vous est plus assignée.",
    NON_PRECISEE: "Le serveur a refusé cette saisie parce que vos droits ont changé.",
  },
}));

import { TerrainPortionsPage } from "./TerrainPortionsPage";
import { toast } from "../lib/toast";
import { ErreurStockageLocal } from "../lib/compteCourant";

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
  h.enFile.length = 0;
  h.syncLance = 0;
  h.syncOptions.length = 0;
  h.pendingCount = 0;
  h.echecFile = null;
  h.portionsFile = [];
  h.relancerDroits.mockReset().mockResolvedValue("ENVOYEE");
  h.lireDefauts.mockClear();
  h.lireObservations.mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
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

  it("porte la date d'effet saisie par l'agent, bornee a aujourd'hui, et JAMAIS deduite de la date du releve", async () => {
    h.post.mockResolvedValue({ data: {} });
    render(<TerrainPortionsPage />);
    const user = await localiser();
    const champ = screen.getByLabelText(/Vrai depuis le/) as HTMLInputElement;
    expect(champ.type).toBe("date");
    expect(champ.max).toBe(new Date().toISOString().slice(0, 10));
    fireEvent.change(champ, { target: { value: "2026-03-15" } });
    await user.click(screen.getByRole("button", { name: /Proposer cette portion/ }));
    await waitFor(() => expect(h.post).toHaveBeenCalled());
    const corps = h.post.mock.calls[0][1];
    expect(corps.valideDu).toBe("2026-03-15");
    // La date du releve reste un champ distinct.
    expect(corps.observeeLe).not.toBe(corps.valideDu);
  });

  it("une date d'effet laissee vide part NULLE : inconnue, pas « depuis toujours », pas la date du jour", async () => {
    h.post.mockResolvedValue({ data: {} });
    render(<TerrainPortionsPage />);
    const user = await localiser();
    await user.click(screen.getByRole("button", { name: /Proposer cette portion/ }));
    await waitFor(() => expect(h.post).toHaveBeenCalled());
    expect(h.post.mock.calls[0][1].valideDu).toBeNull();
  });

  it("explique que laisser la date vide cache la portion du curseur temporel", async () => {
    render(<TerrainPortionsPage />);
    await localiser();
    expect(screen.getByText(/n'apparaîtra à aucune date du curseur temporel/)).toBeInTheDocument();
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

describe("Hors ligne : le relevé est conservé, jamais perdu", () => {
  it("MET EN FILE sans même tenter la requête quand le réseau est absent", async () => {
    // Une requête qui expire ferait attendre dix secondes un agent en bord de route.
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    render(<TerrainPortionsPage />);
    const user = await localiser();
    await user.click(screen.getByRole("button", { name: /Proposer cette portion/ }));
    await waitFor(() => expect(h.enFile).toHaveLength(1));
    expect(h.post).not.toHaveBeenCalled();
    expect(h.enFile[0]).toMatchObject({
      ownerUserId: "u-agent",
      status: "pending",
      payload: { debutM: 10_000, finM: 11_000 },
    });
  });

  it("met en file quand la requête n'aboutit PAS, et pas quand le serveur REFUSE", async () => {
    // La distinction qui compte. Un 409 mis en file reviendrait à chaque retour de réseau
    // sans jamais passer ; une panne non mise en file perdrait une saisie de terrain.
    h.post
      .mockRejectedValueOnce({ message: "Network Error" })
      .mockRejectedValueOnce({
        response: { status: 409, data: { message: "Une portion validée couvre déjà ces mètres." } },
      });
    render(<TerrainPortionsPage />);
    const user = await localiser();
    const proposer = screen.getByRole("button", { name: /Proposer cette portion/ });

    // Premiere tentative : la requete n'aboutit pas. Le releve doit survivre.
    await user.click(proposer);
    await waitFor(() => expect(h.enFile).toHaveLength(1));

    // Seconde tentative : le serveur REFUSE. Rien ne doit entrer en file.
    h.enFile.length = 0;
    await user.click(proposer);
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(2));
    expect(h.enFile).toHaveLength(0);
  });

  it("forge la CLÉ D'IDEMPOTENCE avant de savoir si l'on est en ligne", async () => {
    // Le même relevé doit pouvoir partir maintenant ou plus tard sans jamais produire deux
    // portions. Une clé forgée après la coupure aurait différé d'un chemin à l'autre.
    h.post.mockResolvedValue({ data: {} });
    render(<TerrainPortionsPage />);
    const user = await localiser();
    await user.click(screen.getByRole("button", { name: /Proposer cette portion/ }));
    await waitFor(() => expect(h.post).toHaveBeenCalled());
    const envoye = h.post.mock.calls[0][1] as { clientOperationId: string };
    expect(envoye.clientOperationId).toMatch(/^portion-.+-10000-\d+$/);
  });
});

describe("Stockage local qui refuse : le relevé n'est JAMAIS annoncé conservé", () => {
  async function proposerHorsLigne() {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    render(<TerrainPortionsPage />);
    const user = await localiser();
    const longueur = screen.getByLabelText("Longueur de la portion en mètres") as HTMLInputElement;
    fireEvent.change(longueur, { target: { value: "1500" } });
    await user.click(screen.getByRole("button", { name: /Proposer cette portion/ }));
    return { user, longueur };
  }

  it("stockage plein : alerte accessible avec le message du stockage, aucun succès annoncé, formulaire intact", async () => {
    h.echecFile = new ErreurStockageLocal("STOCKAGE_PLEIN");
    const { longueur } = await proposerHorsLigne();
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent(/Stockage de l'appareil plein/);
    expect(alerte).toHaveTextContent(/PAS enregistrée/);
    expect(h.enFile).toHaveLength(0);
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    // Le formulaire reste tel quel et le bouton redevient disponible pour reessayer.
    expect(longueur.value).toBe("1500");
    expect(screen.getByRole("button", { name: /Proposer cette portion/ })).toBeEnabled();
  });

  it("coffre verrouillé : le message dit de déverrouiller avec le PIN, et le relevé repart une fois déverrouillé", async () => {
    h.echecFile = new ErreurStockageLocal("COFFRE_VERROUILLE");
    const { user } = await proposerHorsLigne();
    expect(await screen.findByRole("alert")).toHaveTextContent("Déverrouillez avec votre PIN pour enregistrer.");
    expect(h.enFile).toHaveLength(0);

    h.echecFile = null;
    await user.click(screen.getByRole("button", { name: /Proposer cette portion/ }));
    await waitFor(() => expect(h.enFile).toHaveLength(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
  });

  it("aucun compte ouvert : le message du stockage est affiché tel quel", async () => {
    h.echecFile = new ErreurStockageLocal("AUCUN_COMPTE");
    await proposerHorsLigne();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Aucun compte n'est ouvert sur cet appareil/);
    expect(h.enFile).toHaveLength(0);
  });

  it("réseau coupé en cours d'envoi ET stockage refusé : une seule alerte, pas de rejet non géré", async () => {
    // Avant : l'erreur typee de la mise en file etait relancee depuis le `catch` et finissait en rejet non gere.
    h.echecFile = new ErreurStockageLocal("STOCKAGE_PLEIN");
    h.post.mockRejectedValueOnce({ message: "Network Error" });
    render(<TerrainPortionsPage />);
    const user = await localiser();
    await user.click(screen.getByRole("button", { name: /Proposer cette portion/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Stockage de l'appareil plein/);
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Proposer cette portion/ })).toBeEnabled();
  });

  it("une erreur non typée du stockage est dite avec un message général, jamais comme un succès", async () => {
    h.echecFile = new Error("QuotaExceededError");
    await proposerHorsLigne();
    expect(await screen.findByRole("alert")).toHaveTextContent(/n'est PAS enregistré/);
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });
});

describe("Le bandeau de file d'attente", () => {
  it("reste invisible quand la file est vide", async () => {
    render(<TerrainPortionsPage />);
    expect(screen.queryByText(/relevé\(s\) en attente/)).not.toBeInTheDocument();
  });

  it("annonce le nombre en attente et permet d'envoyer", async () => {
    h.pendingCount = 3;
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<TerrainPortionsPage />);
    expect(screen.getByText("3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Envoyer maintenant/ }));
    expect(h.syncLance).toBe(1);
    // Geste de l'agent : cycle MANUEL (il leve la suspension de l'enregistrement d'appareil).
    expect(h.syncOptions).toEqual([{ manuel: true }]);
  });
});

describe("Saisies refusées pour droits modifiés (quarantaine)", () => {
  const quarantaine = (localId: string, over: Record<string, unknown> = {}) => ({
    localId, ownerUserId: "u-agent", status: "refus_droits", causeRefusDroits: "REGION_INCONNUE",
    errorMessage: "La région de cette saisie n'a pas pu être rattachée à votre périmètre.",
    payload: { tronconId: "t", debutM: 100, finM: 250, observeeLe: "2026-10-22T08:00:00.000Z" },
    createdAt: "2026-10-22T08:00:00.000Z", ...over,
  });

  it("PAS de panneau quand rien n'est en quarantaine, et aucune lecture des autres files", async () => {
    h.portionsFile = [{ ...quarantaine("p-ordinaire"), status: "error", causeRefusDroits: undefined }];
    h.pendingCount = 1;
    render(<TerrainPortionsPage />);
    expect(await screen.findByText(/relevé\(s\) en attente/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Saisies refusées : droits modifiés/ })).not.toBeInTheDocument();
    expect(h.lireDefauts).not.toHaveBeenCalled();
    expect(h.lireObservations).not.toHaveBeenCalled();
  });

  it("une portion refus_droits apparaît avec sa cause, sans photo, et ne montre que la file des portions", async () => {
    h.portionsFile = [quarantaine("p-q")];
    h.pendingCount = 1;
    render(<TerrainPortionsPage />);
    const panneau = (await screen.findByRole("heading", { name: /Saisies refusées : droits modifiés \(1\)/ })).closest("section")!;
    expect(within(panneau).getByText(/Portion de 100 m à 250 m/)).toBeInTheDocument();
    expect(within(panneau).getByText(/n'a pas pu être rattachée à votre périmètre/)).toBeInTheDocument();
    expect(within(panneau).getByText("Portion en quarantaine")).toBeInTheDocument();
    expect(within(panneau).getByText(/aucune photo/)).toBeInTheDocument();
    expect(h.lireDefauts).not.toHaveBeenCalled();
    expect(h.lireObservations).not.toHaveBeenCalled();
    // Aucune suppression n'est proposee dans le panneau.
    expect(within(panneau).queryByRole("button", { name: /supprimer|effacer|retirer/i })).not.toBeInTheDocument();
  });

  it("« Renvoyer » appelle relancerRefusDroits(localId, \"portions\") et le compte rendu reste affiché quand la portion est partie", async () => {
    h.portionsFile = [quarantaine("p-q")];
    h.pendingCount = 1;
    h.relancerDroits.mockImplementation(async () => { h.portionsFile = []; return "ENVOYEE"; });
    render(<TerrainPortionsPage />);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(await screen.findByRole("button", { name: /Renvoyer cette saisie : Portion de 100 m à 250 m/ }));
    expect(h.relancerDroits).toHaveBeenCalledTimes(1);
    expect(h.relancerDroits).toHaveBeenCalledWith("p-q", "portions");
    expect(await screen.findByText(/le serveur a accepté cette saisie/)).toBeInTheDocument();
  });

  it("un renvoi encore refusé le DIT : la portion reste en quarantaine, rien n'est perdu", async () => {
    h.portionsFile = [quarantaine("p-q")];
    h.pendingCount = 1;
    h.relancerDroits.mockResolvedValue("TOUJOURS_REFUSEE");
    render(<TerrainPortionsPage />);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(await screen.findByRole("button", { name: /Renvoyer cette saisie/ }));
    expect(await screen.findByText(/refuse toujours cette saisie/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Renvoyer cette saisie/ })).toBeInTheDocument();
  });

  it("ne montre PAS la quarantaine d'un autre compte", async () => {
    h.portionsFile = [quarantaine("p-q"), quarantaine("p-autre", { ownerUserId: "u-autre", payload: { tronconId: "t", debutM: 900, finM: 990, observeeLe: "2026-10-21T08:00:00.000Z" } })];
    h.pendingCount = 2;
    render(<TerrainPortionsPage />);
    await screen.findByRole("heading", { name: /Saisies refusées : droits modifiés \(1\)/ });
    expect(screen.queryByText(/Portion de 900 m à 990 m/)).not.toBeInTheDocument();
  });
});
