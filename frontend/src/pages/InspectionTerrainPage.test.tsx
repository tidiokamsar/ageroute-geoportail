import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { violationsAccessibilite } from "../test/accessibilite";
import { ErreurStockageLocal, fermerCompte, ouvrirCompte, type Chiffreur } from "../lib/compteCourant";
import { nombreUrlsApercu, revoquerToutesLesUrlsApercu } from "../session/urlsApercu";

/**
 * Inspection terrain : saisie hors ligne dans la file locale chiffree du compte courant. Ce que ces tests defendent :
 *   - une ecriture refusee par le stockage (plein, coffre verrouille, trop de photos, aucun compte) n'est JAMAIS annoncee
 *     enregistree : alerte accessible avec le message de l'erreur typee, formulaire resté rempli ;
 *   - la lecture des dernieres saisies ne plante pas l'ecran quand la file n'est pas lisible (coffre verrouille) ;
 *   - une saisie ECRITE n'est pas presentee comme perdue parce que le compteur ou la liste echouent ensuite.
 * La file reelle (chiffrement, comptes) est eprouvee par lib/offlineDb.test.ts ; ici elle est simulee.
 */

const h = vi.hoisted(() => ({
  ajoute: [] as Record<string, unknown>[],
  echecEcriture: null as unknown,
  echecLecture: null as unknown,
  echecCompteur: null as unknown,
  lectures: 0,
  sync: 0,
}));

vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string) => {
      if (url === "/troncons") return { data: { data: [{ id: "t-1", code: "RN1", nom: "Conakry - Coyah" }] } };
      return { data: { data: [] } };
    }),
  },
}));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "agent-1", role: "INSPECTEUR" } }) }));
vi.mock("../hooks/useOfflineSync", () => ({ useOfflineSync: () => ({ online: false, syncing: false, pendingCount: 0 }) }));
vi.mock("../lib/offlineDb", () => ({
  addPendingInspection: async (item: Record<string, unknown>) => {
    if (h.echecEcriture) throw h.echecEcriture;
    h.ajoute.push(item);
  },
  getAllPending: async () => {
    h.lectures += 1;
    if (h.echecLecture) throw h.echecLecture;
    return h.ajoute;
  },
}));
vi.mock("../lib/offlineSync", () => ({
  refreshPendingCount: async () => { if (h.echecCompteur) throw h.echecCompteur; },
  syncPendingOfflineData: async () => { h.sync += 1; },
}));

import { toast } from "../lib/toast";
import { InspectionTerrainPage } from "./InspectionTerrainPage";

function rendre() {
  return render(<MemoryRouter><InspectionTerrainPage /></MemoryRouter>);
}

async function remplirEtEnregistrer() {
  const user = userEvent.setup();
  const vue = rendre();
  await screen.findByRole("option", { name: /RN1/ });
  await user.selectOptions(screen.getAllByRole("combobox")[0], "t-1");
  await user.type(screen.getByLabelText("Défauts constatés"), "Fissures longitudinales");
  await user.click(screen.getByRole("button", { name: "Enregistrer l'inspection" }));
  return { user, vue };
}

beforeEach(() => {
  h.ajoute.length = 0;
  h.echecEcriture = null;
  h.echecLecture = null;
  h.echecCompteur = null;
  h.lectures = 0;
  h.sync = 0;
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
});

describe("enregistrement", () => {
  it("une inspection ecrite est annoncee, le formulaire est vide et la liste relue", async () => {
    await remplirEtEnregistrer();
    await waitFor(() => expect(h.ajoute).toHaveLength(1));
    expect(h.ajoute[0]).toMatchObject({ ownerUserId: "agent-1", status: "pending", payload: { tronconId: "t-1", defautsConstates: "Fissures longitudinales" } });
    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Défauts constatés")).toHaveValue("");
    await waitFor(() => expect(h.lectures).toBeGreaterThanOrEqual(2));
  });

  it("sans tronçon ni ouvrage choisi : refus clair, rien n'est écrit", async () => {
    const user = userEvent.setup();
    rendre();
    await screen.findByRole("option", { name: /RN1/ });
    // Le bouton est inactif tant que l'objet n'est pas choisi : aucune ecriture possible.
    expect(screen.getByRole("button", { name: "Enregistrer l'inspection" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Enregistrer l'inspection" }));
    expect(h.ajoute).toHaveLength(0);
  });
});

describe("stockage local qui refuse l'ecriture : jamais annoncee enregistree", () => {
  it("stockage plein : alerte avec le message du stockage, aucun succès, formulaire resté rempli, bouton disponible", async () => {
    h.echecEcriture = new ErreurStockageLocal("STOCKAGE_PLEIN");
    await remplirEtEnregistrer();
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent(/Stockage de l'appareil plein/);
    expect(alerte).toHaveTextContent(/PAS enregistrée/);
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    expect(h.ajoute).toHaveLength(0);
    expect(screen.getByLabelText("Défauts constatés")).toHaveValue("Fissures longitudinales");
    expect(screen.getByRole("button", { name: "Enregistrer l'inspection" })).toBeEnabled();
    expect(h.sync).toBe(0);
  });

  it("trop de photos et photo trop grosse : le message du stockage est affiché tel quel", async () => {
    h.echecEcriture = new ErreurStockageLocal("TROP_DE_PHOTOS");
    const { user } = await remplirEtEnregistrer();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Cinq photos au maximum par saisie/);

    h.echecEcriture = new ErreurStockageLocal("PHOTO_TROP_GROSSE");
    await user.click(screen.getByRole("button", { name: "Enregistrer l'inspection" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/dépasse la taille maximale de 8 Mio/));
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });

  it("coffre verrouillé : « Déverrouillez avec votre PIN pour enregistrer », puis l'enregistrement passe une fois déverrouillé", async () => {
    h.echecEcriture = new ErreurStockageLocal("COFFRE_VERROUILLE");
    const { user } = await remplirEtEnregistrer();
    expect(await screen.findByRole("alert")).toHaveTextContent("Déverrouillez avec votre PIN pour enregistrer.");
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();

    h.echecEcriture = null;
    await user.click(screen.getByRole("button", { name: "Enregistrer l'inspection" }));
    await waitFor(() => expect(h.ajoute).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
  });

  it("aucun compte ouvert : le message du stockage est affiché", async () => {
    h.echecEcriture = new ErreurStockageLocal("AUCUN_COMPTE");
    await remplirEtEnregistrer();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Aucun compte n'est ouvert sur cet appareil/);
  });

  it("erreur non typée (quota navigateur) : message général, jamais un succès, saisie conservée à l'écran", async () => {
    h.echecEcriture = new Error("QuotaExceededError");
    await remplirEtEnregistrer();
    expect(await screen.findByRole("alert")).toHaveTextContent(/n'a pas pu être enregistrée sur cet appareil/);
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Défauts constatés")).toHaveValue("Fissures longitudinales");
  });

  it("une saisie ÉCRITE n'est pas présentée comme perdue si le compteur d'information échoue ensuite", async () => {
    h.echecCompteur = new ErreurStockageLocal("COFFRE_VERROUILLE");
    await remplirEtEnregistrer();
    await waitFor(() => expect(h.ajoute).toHaveLength(1));
    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Défauts constatés")).toHaveValue("");
  });

  it("zéro violation d'accessibilité avec l'alerte affichée", async () => {
    h.echecEcriture = new ErreurStockageLocal("STOCKAGE_PLEIN");
    const { vue } = await remplirEtEnregistrer();
    await screen.findByRole("alert");
    expect(await violationsAccessibilite(vue.container)).toEqual([]);
  });
});

describe("lecture des dernieres saisies", () => {
  it("file illisible (coffre verrouillé) à l'ouverture : message clair, pas de plantage, le formulaire reste utilisable", async () => {
    h.echecLecture = new ErreurStockageLocal("COFFRE_VERROUILLE");
    rendre();
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent(/session locale est verrouillée/);
    expect(screen.queryByText(/Dernières saisies/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enregistrer l'inspection" })).toBeInTheDocument();
  });

  it("lecture en échec non typée : message général, sans plantage", async () => {
    h.echecLecture = new Error("IDB indisponible");
    rendre();
    expect(await screen.findByRole("alert")).toHaveTextContent(/dernières saisies de ce téléphone n'ont pas pu être lues/);
  });

  it("les dernieres saisies du compte sont listées quand la lecture réussit", async () => {
    h.ajoute.push({ localId: "a", ownerUserId: "agent-1", status: "pending", createdAt: "2026-10-25T08:00:00.000Z", payload: {}, photos: [] });
    h.ajoute.push({ localId: "b", ownerUserId: "autre", status: "pending", createdAt: "2026-10-25T09:00:00.000Z", payload: {}, photos: [] });
    rendre();
    expect(await screen.findByText(/Dernières saisies/)).toBeInTheDocument();
    expect(screen.getAllByText("En attente")).toHaveLength(1);
  });
});

describe("apercus des photos : revoques au verrou, recrees au deverrouillage, jamais de fuite (chantier D8c)", () => {
  let compteur = 0;
  const revoquees: string[] = [];
  let deverrouille = true;
  const chiffreur = { estDeverrouille: () => deverrouille } as unknown as Chiffreur;
  const ouvrirLeCompte = () => ouvrirCompte({ compteId: "agent-1", empreinte: "0123456789abcdef", chiffreur });
  const photo = (nom: string) => new File(["x"], nom, { type: "image/jpeg" });
  const vignettes = (conteneur: HTMLElement) => [...conteneur.querySelectorAll("img")].map((i) => i.getAttribute("src"));

  beforeEach(() => {
    revoquerToutesLesUrlsApercu();                       // repart d'un registre vide, quoi qu'ait laisse un test precedent
    compteur = 0; revoquees.length = 0; deverrouille = true;
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => `blob:apercu-${++compteur}`) });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn((u: string) => { revoquees.push(u); }) });
    fermerCompte();
    ouvrirLeCompte();
  });
  afterEach(() => { cleanup(); fermerCompte(); });

  it("un verrou revoque les URL et masque les vignettes ; au deverrouillage elles sont recreees ; la photo n'est jamais perdue", async () => {
    const user = userEvent.setup();
    const { container } = rendre();
    await user.upload(screen.getByLabelText("Photos"), [photo("a.jpg"), photo("b.jpg")]);
    expect(vignettes(container)).toEqual(["blob:apercu-1", "blob:apercu-2"]);
    expect(nombreUrlsApercu()).toBe(2);

    // Verrou : la session oublie la cle, puis le registre revoque toutes les URL.
    deverrouille = false;
    act(() => { revoquerToutesLesUrlsApercu(); });
    expect(revoquees.sort()).toEqual(["blob:apercu-1", "blob:apercu-2"]);
    expect(nombreUrlsApercu()).toBe(0);
    expect(vignettes(container)).toEqual([]);
    expect(screen.getAllByText("Aperçu masqué")).toHaveLength(2);       // l'emplacement reste, pas d'image cassee
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);                // rien n'est recree TANT QUE le compte est verrouille

    // Deverrouillage : un apercu neuf par photo, a partir du meme Blob.
    deverrouille = true;
    act(() => { ouvrirLeCompte(); });
    await waitFor(() => expect(vignettes(container)).toEqual(["blob:apercu-3", "blob:apercu-4"]));
    expect(nombreUrlsApercu()).toBe(2);
    expect(screen.queryByText("Aperçu masqué")).not.toBeInTheDocument();
  });

  it("retirer une photo revoque son URL (et seulement la sienne) ; le registre ne garde que les photos restantes", async () => {
    const user = userEvent.setup();
    const { container } = rendre();
    await user.upload(screen.getByLabelText("Photos"), [photo("a.jpg"), photo("b.jpg")]);

    await user.click(container.querySelectorAll<HTMLButtonElement>("button.absolute")[0]);

    expect(revoquees).toEqual(["blob:apercu-1"]);
    expect(vignettes(container)).toEqual(["blob:apercu-2"]);
    expect(nombreUrlsApercu()).toBe(1);
  });

  it("le demontage revoque toutes les URL encore vivantes ; apres un verrou, il n'y a rien de plus a revoquer", async () => {
    const user = userEvent.setup();
    const { unmount } = rendre();
    await user.upload(screen.getByLabelText("Photos"), [photo("a.jpg"), photo("b.jpg")]);
    expect(nombreUrlsApercu()).toBe(2);

    unmount();

    expect(revoquees.sort()).toEqual(["blob:apercu-1", "blob:apercu-2"]);
    expect(nombreUrlsApercu()).toBe(0);

    // Verrou puis demontage : les URL sont deja revoquees une fois, pas deux.
    revoquees.length = 0;
    const seconde = rendre();
    await user.upload(screen.getByLabelText("Photos"), [photo("c.jpg")]);
    deverrouille = false;
    act(() => { revoquerToutesLesUrlsApercu(); });
    expect(revoquees).toEqual(["blob:apercu-3"]);
    seconde.unmount();
    expect(revoquees).toEqual(["blob:apercu-3"]);
    expect(nombreUrlsApercu()).toBe(0);
  });

  it("enregistrer l'inspection libere les apercus : le formulaire vide ne retient aucune URL", async () => {
    const user = userEvent.setup();
    rendre();
    await screen.findByRole("option", { name: /RN1/ });
    await user.selectOptions(screen.getAllByRole("combobox")[0], "t-1");
    await user.upload(screen.getByLabelText("Photos"), [photo("a.jpg")]);
    expect(nombreUrlsApercu()).toBe(1);

    await user.click(screen.getByRole("button", { name: "Enregistrer l'inspection" }));

    await waitFor(() => expect(h.ajoute).toHaveLength(1));
    await waitFor(() => expect(nombreUrlsApercu()).toBe(0));
    expect(revoquees).toEqual(["blob:apercu-1"]);
  });

  it("en mode strict (double appel des mises a jour d'etat), une photo ajoutee ne cree qu'une URL, revoquee au demontage", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<StrictMode><MemoryRouter><InspectionTerrainPage /></MemoryRouter></StrictMode>);
    await user.upload(screen.getByLabelText("Photos"), [photo("a.jpg"), photo("b.jpg")]);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    expect(nombreUrlsApercu()).toBe(2);

    unmount();

    expect(nombreUrlsApercu()).toBe(0);
  });
});
