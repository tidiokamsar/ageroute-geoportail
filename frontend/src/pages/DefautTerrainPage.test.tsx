import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({
  ajoute: vi.fn(async (item: Record<string, unknown>) => { h.brouillons.push(item); }),
  brouillons: [] as Record<string, unknown>[],
  lire: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
  online: false,
  relancer: vi.fn(async () => {}),
  synchroniser: vi.fn(async (_options?: unknown) => {}),
  /** `enregistrementSuspendu` de l'etat de synchronisation : le serveur a refuse d'enregistrer un appareil neuf (revocation recente). */
  suspendu: false,
  /** `relancerRefusDroits` : le renvoi explicite d'une saisie en quarantaine (panneau des saisies refusees pour droits). */
  relancerDroits: vi.fn(async (_localId: string, _file: string): Promise<string> => "ENVOYEE"),
  /** Lectures des deux autres files par le panneau : il ne doit lire QUE celle des defauts (`files={["defauts"]}`). */
  lirePortions: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
  lireObservations: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
}));

vi.mock("../hooks/useOfflineSync", () => ({
  useOfflineSync: () => ({
    online: h.online, syncing: false, pendingCount: h.brouillons.length, syncNow: vi.fn(), enregistrementSuspendu: h.suspendu,
    refusDroitsCount: h.brouillons.filter((b) => b.status === "refus_droits" && b.ownerUserId === "agent-1").length,
  }),
}));
vi.mock("../lib/defautsTerrain", () => ({
  chargerReferentielsDefautsTerrain: async () => ({
    troncons: [{ id: "troncon-1", code: "RN1", nom: "Conakry — Kindia" }],
    catalogue: [{
      code: "NID_POULE",
      libelle: "Nid-de-poule",
      famille: "CHAUSSEE",
      unite: "METRE_CARRE",
      mesuresRequises: ["LONGUEUR", "LARGEUR", "PROFONDEUR"],
      graviteMax: 4,
    }],
    tronconsEnCache: true,
    catalogueEnCache: true,
  }),
}));
vi.mock("../lib/offlineDb", () => ({
  addPendingDefaut: h.ajoute,
  getAllPendingDefauts: () => h.lire(),
  getAllPendingPortions: () => h.lirePortions(),
  getAllPendingObservations: () => h.lireObservations(),
  STATUT_REFUS_DROITS: "refus_droits",
  removePendingDefaut: vi.fn(async () => {}),
  updatePendingDefaut: vi.fn(async () => {}),
}));
vi.mock("../lib/offlineSync", () => ({
  refreshPendingCount: vi.fn(async () => {}),
  syncPendingOfflineData: h.synchroniser,
  MESSAGE_REVOCATION_RECENTE: "Texte d'essai : un appareil vient d'etre retire, patientez.",
  relancerDefaut: h.relancer,
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
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "agent-1", role: "INSPECTEUR" } }) }));

import { DefautTerrainPage } from "./DefautTerrainPage";
import { toast } from "../lib/toast";
import { ErreurStockageLocal, fermerCompte, ouvrirCompte, type Chiffreur } from "../lib/compteCourant";
import { nombreUrlsApercu, revoquerToutesLesUrlsApercu } from "../session/urlsApercu";

beforeEach(() => {
  h.ajoute.mockReset().mockImplementation(async (item: Record<string, unknown>) => { h.brouillons.push(item); });
  h.brouillons.length = 0;
  h.lire.mockReset().mockImplementation(async () => h.brouillons);
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  h.online = false;
  h.suspendu = false;
  h.relancer.mockClear();
  h.synchroniser.mockClear();
  h.relancerDroits.mockReset().mockResolvedValue("ENVOYEE");
  h.lirePortions.mockClear();
  h.lireObservations.mockClear();
});

describe("Saisie terrain des défauts", () => {
  // `delay: null` : user-event cède la main au navigateur après CHAQUE frappe par défaut, et ce
  // parcours en compte une vingtaine sur une page complète. Mesuré le 14/10 : 4,9 à 6,2 s seul,
  // pour un plafond de 5 s -- un échec sur trois, davantage sous la charge de la suite. Sans ce
  // délai, le même parcours est exercé, seulement sans les pauses inutiles. La marge de 15 s
  // couvre les postes lents ; elle n'affaiblit aucune assertion.
  it("enregistre hors-ligne les mesures, le repère et la clé locale", async () => {
    const user = userEvent.setup({ delay: null });
    // Le picker géo de tronçon (recherche GPS/ville/texte) utilise react-query : le
    // test lui fournit un client dont toutes les requêtes restent en échec silencieux
    // (hors ligne : pas de recherche réseau, le cache du référentiel suffit).
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
    render(<QueryClientProvider client={qc}><MemoryRouter><DefautTerrainPage /></MemoryRouter></QueryClientProvider>);

    await screen.findByRole("option", { name: /Nid-de-poule/ });
    await user.click(screen.getByRole("button", { name: "Tronçon et repère" }));
    await user.selectOptions(screen.getByLabelText("Tronçon"), "troncon-1");
    await user.type(screen.getByLabelText("Valeur du repère"), "125");
    await user.type(screen.getByLabelText("Longueur *"), "2");
    await user.type(screen.getByLabelText("Largeur *"), "1");
    await user.type(screen.getByLabelText("Profondeur *"), "0.1");
    await user.selectOptions(screen.getByLabelText("Gravité (1 à 4)"), "2");
    await user.click(screen.getByRole("button", { name: "Enregistrer le défaut" }));

    await waitFor(() => expect(h.ajoute).toHaveBeenCalledOnce());
    const item = h.ajoute.mock.calls[0][0] as {
      localId: string;
      ownerUserId: string;
      status: string;
      payload: Record<string, unknown>;
    };
    expect(item.localId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(item.status).toBe("pending");
    expect(item.ownerUserId).toBe("agent-1");
    expect(item.payload).toMatchObject({
      catalogueCode: "NID_POULE",
      tronconId: "troncon-1",
      abscisseM: 125,
      confianceAppariement: 0.8,
      gravite: 2,
      mesures: { longueurM: 2, largeurM: 1, profondeurM: 0.1 },
    });
  }, 15_000);
});

describe("File locale : défaut abandonné déjà créé sur le serveur", () => {
  function deposerAbandonne(serverId: string | undefined) {
    h.brouillons.push({
      localId: "d0000000-0000-4000-8000-000000000001", ownerUserId: "agent-1", serverId,
      payload: { catalogueCode: "NID_POULE", constateA: "2026-10-08T10:00:00.000Z" },
      photos: [{ name: "p.jpg", blob: new Blob(["x"]), capturedA: "2026-10-08T10:00:00.000Z" }],
      createdAt: "2026-10-08T10:00:00.000Z", status: "abandonnee", errorMessage: "trop d'échecs",
    });
  }
  const rendre = () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
    render(<QueryClientProvider client={qc}><MemoryRouter><DefautTerrainPage /></MemoryRouter></QueryClientProvider>);
  };

  it("« Reprendre les photos » remet d'abord le défaut en file, puis relance la synchronisation", async () => {
    // Avant : le bouton relançait une synchronisation qui ignore les défauts abandonnés, donc ne faisait rien ;
    // « Corriger » est masqué quand un serverId existe, et la seule issue était de supprimer les photos.
    h.online = true;
    deposerAbandonne("srv-1");
    const user = userEvent.setup({ delay: null });
    rendre();

    await user.click(await screen.findByRole("button", { name: /Reprendre les photos/ }));

    await waitFor(() => expect(h.relancer).toHaveBeenCalledOnce());
    expect(h.relancer).toHaveBeenCalledWith(expect.objectContaining({ serverId: "srv-1", status: "abandonnee" }));
    // C'est un geste de l'agent : il reessaie l'enregistrement de l'appareil meme pendant le delai d'une revocation recente.
    expect(h.synchroniser).toHaveBeenCalledWith({ manuel: true });
  });

  it("un défaut abandonné SANS serverId garde « Corriger » et n'offre pas la relance des photos", async () => {
    h.online = true;
    deposerAbandonne(undefined);
    rendre();

    expect(await screen.findByRole("button", { name: /Corriger/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reprendre les photos/ })).toBeNull();
  });
});

describe("Stockage local qui refuse : le défaut n'est JAMAIS annoncé enregistré", () => {
  const rendre = () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
    return render(<QueryClientProvider client={qc}><MemoryRouter><DefautTerrainPage /></MemoryRouter></QueryClientProvider>);
  };

  async function remplirEtEnregistrer() {
    const user = userEvent.setup({ delay: null });
    rendre();
    await screen.findByRole("option", { name: /Nid-de-poule/ });
    await user.click(screen.getByRole("button", { name: "Tronçon et repère" }));
    await user.selectOptions(screen.getByLabelText("Tronçon"), "troncon-1");
    await user.type(screen.getByLabelText("Valeur du repère"), "125");
    await user.type(screen.getByLabelText("Longueur *"), "2");
    await user.type(screen.getByLabelText("Largeur *"), "1");
    await user.type(screen.getByLabelText("Profondeur *"), "0.1");
    await user.selectOptions(screen.getByLabelText("Gravité (1 à 4)"), "2");
    await user.click(screen.getByRole("button", { name: "Enregistrer le défaut" }));
    return user;
  }

  it("stockage plein : alerte avec le message du stockage, aucun succès annoncé, formulaire resté rempli", async () => {
    h.ajoute.mockRejectedValueOnce(new ErreurStockageLocal("STOCKAGE_PLEIN"));
    await remplirEtEnregistrer();
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent(/Stockage de l'appareil plein/);
    expect(alerte).toHaveTextContent(/PAS enregistrée/);
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    expect(h.brouillons).toHaveLength(0);
    expect((screen.getByLabelText("Valeur du repère") as HTMLInputElement).value).toBe("125");
    expect((screen.getByLabelText("Longueur *") as HTMLInputElement).value).toBe("2");
    expect(screen.getByRole("button", { name: "Enregistrer le défaut" })).toBeEnabled();
  }, 15_000);

  it("trop de photos : le message du stockage est affiché tel quel", async () => {
    h.ajoute.mockRejectedValueOnce(new ErreurStockageLocal("TROP_DE_PHOTOS"));
    await remplirEtEnregistrer();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Cinq photos au maximum par saisie/);
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  }, 15_000);

  it("coffre verrouillé : « Déverrouillez avec votre PIN pour enregistrer », puis l'enregistrement passe une fois déverrouillé", async () => {
    h.ajoute.mockRejectedValueOnce(new ErreurStockageLocal("COFFRE_VERROUILLE"));
    const user = await remplirEtEnregistrer();
    expect(await screen.findByRole("alert")).toHaveTextContent("Déverrouillez avec votre PIN pour enregistrer.");
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Enregistrer le défaut" }));
    await waitFor(() => expect(h.brouillons).toHaveLength(1));
    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("la file locale illisible (coffre verrouillé) est dite, sans plantage ni faux « aucun défaut en attente »", async () => {
    h.lire.mockRejectedValue(new ErreurStockageLocal("COFFRE_VERROUILLE"));
    rendre();
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent(/session locale est verrouillée/);
    expect(screen.queryByText("Aucun défaut en attente.")).not.toBeInTheDocument();
  });

  it("« Reprendre les photos » : si la remise en file est refusée, l'alerte le dit et rien n'est relancé", async () => {
    h.online = true;
    h.brouillons.push({
      localId: "d0000000-0000-4000-8000-000000000002", ownerUserId: "agent-1", serverId: "srv-2",
      payload: { catalogueCode: "NID_POULE", constateA: "2026-10-08T10:00:00.000Z" },
      photos: [], createdAt: "2026-10-08T10:00:00.000Z", status: "abandonnee", errorMessage: "trop d'échecs",
    });
    h.relancer.mockRejectedValueOnce(new ErreurStockageLocal("STOCKAGE_PLEIN"));
    const user = userEvent.setup({ delay: null });
    rendre();
    await user.click(await screen.findByRole("button", { name: /Reprendre les photos/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Stockage de l'appareil plein/);
    expect(h.synchroniser).not.toHaveBeenCalled();
  });
});

describe("Saisies refusées pour droits modifiés (quarantaine)", () => {
  const rendre = () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
    return render(<QueryClientProvider client={qc}><MemoryRouter><DefautTerrainPage /></MemoryRouter></QueryClientProvider>);
  };
  const quarantaine = (localId: string, over: Record<string, unknown> = {}) => ({
    localId, ownerUserId: "agent-1", status: "refus_droits", causeRefusDroits: "HORS_PERIMETRE",
    errorMessage: "Cette saisie est hors de votre périmètre territorial actuel.",
    payload: { catalogueCode: "NID_POULE", constateA: "2026-10-08T10:00:00.000Z" },
    photos: [{ name: "p.jpg", blob: new Blob(["x"]), capturedA: "2026-10-08T10:00:00.000Z" }],
    createdAt: "2026-10-08T10:00:00.000Z", ...over,
  });

  it("PAS de panneau quand rien n'est en quarantaine, et il ne lit pas les autres files", async () => {
    h.online = true;
    h.brouillons.push({ ...quarantaine("d-ordinaire"), status: "error", causeRefusDroits: undefined });
    rendre();
    await screen.findByText("Échec — à corriger ou réessayer");
    expect(screen.queryByRole("heading", { name: /Saisies refusées : droits modifiés/ })).not.toBeInTheDocument();
    expect(h.lirePortions).not.toHaveBeenCalled();
    expect(h.lireObservations).not.toHaveBeenCalled();
  });

  it("une saisie refus_droits apparaît avec sa cause dans le panneau et avec son propre statut dans la file, sans promesse d'envoi", async () => {
    h.online = true;
    h.brouillons.push(quarantaine("d-q"));
    rendre();
    const panneau = (await screen.findByRole("heading", { name: /Saisies refusées : droits modifiés \(1\)/ })).closest("section")!;
    expect(within(panneau).getByText(/Défaut NID_POULE/)).toBeInTheDocument();
    expect(within(panneau).getByText(/hors de votre périmètre territorial actuel/)).toBeInTheDocument();
    expect(within(panneau).getByText(/1 photo\b/)).toBeInTheDocument();
    expect(within(panneau).getByText("Défaut en quarantaine")).toBeInTheDocument();
    // Dans la file locale : ni « En attente de synchronisation » (elle ne part pas seule), ni bouton « Synchroniser » qui ne ferait rien pour elle.
    const fileLocale = screen.getByRole("heading", { name: "File locale des défauts" }).closest("section")!;
    expect(within(fileLocale).getByText(/Refusée : droits modifiés/)).toBeInTheDocument();
    expect(within(fileLocale).queryByText("En attente de synchronisation")).not.toBeInTheDocument();
    expect(within(fileLocale).queryByRole("button", { name: /Synchroniser/ })).not.toBeInTheDocument();
    // Seule la file des défauts est lue par le panneau.
    expect(h.lirePortions).not.toHaveBeenCalled();
    expect(h.lireObservations).not.toHaveBeenCalled();
  });

  it("« Renvoyer » appelle relancerRefusDroits(localId, \"defauts\") et le compte rendu reste affiché quand la saisie est partie", async () => {
    h.online = true;
    h.brouillons.push(quarantaine("d-q"));
    h.relancerDroits.mockImplementation(async () => { h.brouillons.length = 0; return "ENVOYEE"; });
    const user = userEvent.setup({ delay: null });
    rendre();
    await user.click(await screen.findByRole("button", { name: /Renvoyer cette saisie : Défaut NID_POULE/ }));
    expect(h.relancerDroits).toHaveBeenCalledTimes(1);
    expect(h.relancerDroits).toHaveBeenCalledWith("d-q", "defauts");
    expect(await screen.findByText(/le serveur a accepté cette saisie/)).toBeInTheDocument();
  });

  it("un renvoi encore refusé le DIT : la saisie reste en quarantaine, rien n'est perdu", async () => {
    h.online = true;
    h.brouillons.push(quarantaine("d-q"));
    h.relancerDroits.mockResolvedValue("TOUJOURS_REFUSEE");
    const user = userEvent.setup({ delay: null });
    rendre();
    await user.click(await screen.findByRole("button", { name: /Renvoyer cette saisie/ }));
    expect(await screen.findByText(/refuse toujours cette saisie/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Renvoyer cette saisie/ })).toBeInTheDocument();
  });

  it("ne montre PAS la quarantaine d'un autre compte", async () => {
    h.online = true;
    h.brouillons.push(quarantaine("d-q"), quarantaine("d-autre", { ownerUserId: "agent-2", payload: { catalogueCode: "AUTRE_CODE", constateA: "2026-10-09T10:00:00.000Z" } }));
    rendre();
    await screen.findByRole("heading", { name: /Saisies refusées : droits modifiés \(1\)/ });
    expect(screen.queryByText(/AUTRE_CODE/)).not.toBeInTheDocument();
  });
});

describe("Enregistrement de l'appareil suspendu (403 APPAREIL_REVOCATION_RECENTE)", () => {
  const rendre = () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
    return render(<QueryClientProvider client={qc}><MemoryRouter><DefautTerrainPage /></MemoryRouter></QueryClientProvider>);
  };
  const deposerEnErreur = () => h.brouillons.push({
    localId: "d0000000-0000-4000-8000-000000000002", ownerUserId: "agent-1",
    payload: { catalogueCode: "NID_POULE", constateA: "2026-10-08T10:00:00.000Z" }, photos: [],
    createdAt: "2026-10-08T10:00:00.000Z", status: "error", errorMessage: "reseau",
  });

  it("le message est dit, les defauts restent en file, et « Synchroniser » est un geste (reessai immediat)", async () => {
    h.online = true;
    h.suspendu = true;
    deposerEnErreur();
    const user = userEvent.setup({ delay: null });
    rendre();

    const note = await screen.findByRole("status");
    expect(note).toHaveTextContent("Texte d'essai : un appareil vient d'etre retire, patientez.");
    expect(note).toHaveTextContent(/Vos défauts restent sur ce téléphone/);
    await user.click(screen.getByRole("button", { name: /Synchroniser/ }));
    expect(h.synchroniser).toHaveBeenCalledWith({ manuel: true });
  });

  it("sans suspension, aucun message", async () => {
    h.online = true;
    deposerEnErreur();
    rendre();
    await screen.findByRole("button", { name: /Synchroniser/ });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("Apercus des photos : revoques au verrou, recrees au deverrouillage, jamais de fuite (chantier D8c)", () => {
  let compteur = 0;
  const revoquees: string[] = [];
  let deverrouille = true;
  const chiffreur = { estDeverrouille: () => deverrouille } as unknown as Chiffreur;
  const ouvrirLeCompte = () => ouvrirCompte({ compteId: "agent-1", empreinte: "0123456789abcdef", chiffreur });
  const photo = (nom: string) => new File(["x"], nom, { type: "image/jpeg" });
  const rendre = (strict = false) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
    const page = <QueryClientProvider client={qc}><MemoryRouter><DefautTerrainPage /></MemoryRouter></QueryClientProvider>;
    return render(strict ? <StrictMode>{page}</StrictMode> : page);
  };
  const choisir = async (user: ReturnType<typeof userEvent.setup>, ...fichiers: File[]) => {
    await screen.findByRole("option", { name: /Nid-de-poule/ });
    await user.upload(screen.getByLabelText("Choisir des photos existantes du défaut"), fichiers);
  };

  beforeEach(() => {
    revoquerToutesLesUrlsApercu();                        // repart d'un registre vide, quoi qu'ait laisse un test precedent
    compteur = 0; revoquees.length = 0; deverrouille = true;
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => `blob:apercu-${++compteur}`) });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn((u: string) => { revoquees.push(u); }) });
    fermerCompte();
    ouvrirLeCompte();
  });
  afterEach(() => { cleanup(); fermerCompte(); });

  it("un verrou revoque les URL et masque les vignettes ; au deverrouillage elles sont recreees ; la photo n'est jamais perdue", async () => {
    const user = userEvent.setup({ delay: null });
    rendre();
    await choisir(user, photo("a.jpg"), photo("b.jpg"));
    expect(await screen.findByAltText("Aperçu de a.jpg")).toHaveAttribute("src", "blob:apercu-1");
    expect(screen.getByAltText("Aperçu de b.jpg")).toHaveAttribute("src", "blob:apercu-2");
    expect(nombreUrlsApercu()).toBe(2);

    // Verrou : la session oublie la cle, puis le registre revoque toutes les URL.
    deverrouille = false;
    act(() => { revoquerToutesLesUrlsApercu(); });
    expect(revoquees.sort()).toEqual(["blob:apercu-1", "blob:apercu-2"]);
    expect(nombreUrlsApercu()).toBe(0);
    expect(screen.queryByAltText("Aperçu de a.jpg")).not.toBeInTheDocument();
    expect(screen.getAllByText("Aperçu masqué")).toHaveLength(2);       // l'emplacement reste, pas d'image cassee
    expect(screen.getByText("a.jpg")).toBeInTheDocument();                // la photo est toujours la
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);                // rien n'est recree TANT QUE le compte est verrouille

    // Deverrouillage : un apercu neuf par photo, a partir du meme Blob.
    deverrouille = true;
    act(() => { ouvrirLeCompte(); });
    expect(await screen.findByAltText("Aperçu de a.jpg")).toHaveAttribute("src", "blob:apercu-3");
    expect(screen.getByAltText("Aperçu de b.jpg")).toHaveAttribute("src", "blob:apercu-4");
    expect(nombreUrlsApercu()).toBe(2);
    expect(screen.queryByText("Aperçu masqué")).not.toBeInTheDocument();
  });

  it("retirer une photo revoque son URL (et seulement la sienne), y compris une photo recreee apres un verrou", async () => {
    const user = userEvent.setup({ delay: null });
    rendre();
    await choisir(user, photo("a.jpg"), photo("b.jpg"));
    deverrouille = false;
    act(() => { revoquerToutesLesUrlsApercu(); });
    deverrouille = true;
    act(() => { ouvrirLeCompte(); });
    await screen.findByAltText("Aperçu de a.jpg");
    revoquees.length = 0;

    await user.click(screen.getAllByRole("button", { name: "Retirer" })[0]);

    expect(revoquees).toEqual(["blob:apercu-3"]);
    expect(screen.queryByAltText("Aperçu de a.jpg")).not.toBeInTheDocument();
    expect(screen.getByAltText("Aperçu de b.jpg")).toHaveAttribute("src", "blob:apercu-4");
    expect(nombreUrlsApercu()).toBe(1);
  });

  it("le demontage revoque toutes les URL encore vivantes ; apres un verrou, rien n'est revoque deux fois", async () => {
    const user = userEvent.setup({ delay: null });
    const { unmount } = rendre();
    await choisir(user, photo("a.jpg"), photo("b.jpg"));
    expect(nombreUrlsApercu()).toBe(2);

    unmount();

    expect(revoquees.sort()).toEqual(["blob:apercu-1", "blob:apercu-2"]);
    expect(nombreUrlsApercu()).toBe(0);

    revoquees.length = 0;
    const seconde = rendre();
    await choisir(user, photo("c.jpg"));
    deverrouille = false;
    act(() => { revoquerToutesLesUrlsApercu(); });
    expect(revoquees).toEqual(["blob:apercu-3"]);
    seconde.unmount();
    expect(revoquees).toEqual(["blob:apercu-3"]);
    expect(nombreUrlsApercu()).toBe(0);
  });

  it("en mode strict (double appel des mises a jour d'etat), une photo ajoutee ne cree qu'une URL, revoquee au demontage", async () => {
    const user = userEvent.setup({ delay: null });
    const { unmount } = rendre(true);
    await choisir(user, photo("a.jpg"), photo("b.jpg"));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    expect(nombreUrlsApercu()).toBe(2);

    unmount();

    expect(nombreUrlsApercu()).toBe(0);
  });
});
