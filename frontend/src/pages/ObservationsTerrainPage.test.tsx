import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { violationsAccessibilite } from "../test/accessibilite";

/**
 * L'ecran de saisie des observations terrain : ce que ces tests defendent.
 *
 * UN CONFLIT EST DIT, EN HAUT DE PAGE. Quand le serveur a rendu CONFLIT pour une saisie de la file, l'agent
 * doit lire que ce n'est pas une panne, qu'un responsable doit trancher et que sa saisie est conservee. Une
 * ligne grise dans une liste laisserait croire que « ca partira tout seul ».
 *
 * RIEN N'EST EFFACE SUR LE TELEPHONE PAR CET ECRAN. Une saisie refusee ou en conflit reste affichee avec son
 * motif ; seule une saisie abandonnee peut etre RELANCEE, jamais une saisie en conflit.
 *
 * L'ecran lit la file locale et les compteurs du store de synchronisation : ici ils sont simules. La file
 * reelle est eprouvee par `lib/offlineSync.observations.test.ts`.
 */

const h = vi.hoisted(() => ({
  etat: { pendingCount: 0, conflitCount: 0, abandonCount: 0, syncing: false, online: true },
  file: [] as Record<string, unknown>[],
  enregistrer: vi.fn(),
  relancer: vi.fn(),
  sync: vi.fn(),
  toastSucces: vi.fn(),
}));

vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u1", role: "INSPECTEUR" } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: h.toastSucces, error: vi.fn() } }));
vi.mock("../hooks/useOfflineSync", () => ({ useOfflineSync: () => ({ ...h.etat, syncNow: h.sync }) }));
vi.mock("../lib/offlineDb", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAllPendingObservations: async () => h.file,
}));
vi.mock("../lib/offlineSync", () => ({
  relancerObservation: (...a: unknown[]) => h.relancer(...a),
  syncPendingOfflineData: (...a: unknown[]) => h.sync(...a),
}));
vi.mock("../lib/observationsTerrain", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enregistrerObservation: (...a: unknown[]) => h.enregistrer(...a),
}));

import { ObservationsTerrainPage } from "./ObservationsTerrainPage";

function saisie(localId: string, over: Record<string, unknown> = {}) {
  return {
    localId, ownerUserId: "u1", status: "pending", createdAt: "2026-10-23T08:00:00.000Z",
    payload: { type: "DEGRADATION", description: `description ${localId}`, observeA: "2026-10-23T08:00:00.000Z" },
    ...over,
  };
}

beforeEach(() => {
  h.etat = { pendingCount: 0, conflitCount: 0, abandonCount: 0, syncing: false, online: true };
  h.file = [];
  h.enregistrer.mockReset().mockResolvedValue({ ok: true });
  h.relancer.mockReset().mockResolvedValue(undefined);
  h.sync.mockReset().mockResolvedValue(undefined);
  h.toastSucces.mockReset();
});

describe("Signalement du conflit au telephone", () => {
  it("PAS d'alerte quand il n'y a aucun conflit", async () => {
    h.file = [saisie("a")]; h.etat.pendingCount = 1;
    render(<ObservationsTerrainPage />);
    await screen.findByText("description a");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("annonce le conflit en haut de page, dit que ce n'est pas une panne et que la saisie est CONSERVEE", async () => {
    h.file = [saisie("c", { status: "conflit", conflitId: "conflit-9", motifConflit: "DEJA_EXISTANTE", errorMessage: "Conflit de synchronisation (DEJA_EXISTANTE) : le serveur porte déjà une version différente. Un responsable doit trancher. Cette saisie est conservée sur ce téléphone." })];
    h.etat = { ...h.etat, pendingCount: 1, conflitCount: 1 };
    render(<ObservationsTerrainPage />);
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent("1 saisie(s) en conflit de synchronisation");
    expect(alerte).toHaveTextContent(/un responsable doit trancher/);
    expect(alerte).toHaveTextContent(/conservées sur ce téléphone/);
    expect(alerte).toHaveTextContent(/réessayer n'y change rien/);
  });

  it("la saisie en conflit RESTE dans la liste, avec son statut, son numero de conflit, sans bouton « relancer »", async () => {
    h.file = [saisie("c", { status: "conflit", conflitId: "conflit-9", errorMessage: "Un responsable doit trancher." })];
    h.etat = { ...h.etat, pendingCount: 1, conflitCount: 1 };
    render(<ObservationsTerrainPage />);
    const item = (await screen.findByText("description c")).closest("li")!;
    expect(item).toHaveAttribute("data-statut", "conflit");
    expect(within(item).getByText("En conflit")).toBeInTheDocument();
    expect(within(item).getByText("conflit-9")).toBeInTheDocument();
    expect(within(item).getByText(/Rien à refaire : votre saisie est conservée/)).toBeInTheDocument();
    expect(within(item).queryByRole("button", { name: /Relancer/ })).not.toBeInTheDocument();
  });

  it("une saisie abandonnee reste visible avec son motif et peut etre RELANCEE", async () => {
    const abandonnee = saisie("x", { status: "abandonnee", refusDefinitif: true, errorMessage: "Refusé : PAYLOAD_INVALIDE:Observation. Cette saisie ne passera pas en l'état." });
    h.file = [abandonnee];
    h.etat = { ...h.etat, pendingCount: 1, abandonCount: 1 };
    const user = userEvent.setup();
    render(<ObservationsTerrainPage />);
    const item = (await screen.findByText("description x")).closest("li")!;
    expect(within(item).getByText("Refusée")).toBeInTheDocument();
    expect(within(item).getByText(/PAYLOAD_INVALIDE:Observation/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/plus retentée automatiquement/);

    await user.click(within(item).getByRole("button", { name: "Relancer l'envoi" }));
    expect(h.relancer).toHaveBeenCalledWith(abandonnee);
    await waitFor(() => expect(h.sync).toHaveBeenCalled());
  });

  it("ne montre PAS les saisies d'un autre compte", async () => {
    h.file = [saisie("a"), saisie("b", { ownerUserId: "u2" })];
    render(<ObservationsTerrainPage />);
    await screen.findByText("description a");
    expect(screen.queryByText("description b")).not.toBeInTheDocument();
  });

  it("hors ligne : le dit, et desactive l'envoi manuel", async () => {
    h.file = [saisie("a")]; h.etat = { ...h.etat, pendingCount: 1, online: false };
    render(<ObservationsTerrainPage />);
    expect(await screen.findByText(/Hors ligne : les saisies partiront au retour du réseau/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Envoyer maintenant" })).toBeDisabled();
  });
});

describe("Saisie", () => {
  it("annonce d'entree que tout est une PROPOSITION", async () => {
    render(<ObservationsTerrainPage />);
    expect(await screen.findByText(/Tout ce qui est saisi ici est une proposition/)).toBeInTheDocument();
  });

  it("refuse une saisie invalide en listant ce qui manque, sans rien conserver", async () => {
    h.enregistrer.mockResolvedValue({ ok: false, erreurs: ["Choisissez le type d'observation."] });
    const user = userEvent.setup();
    render(<ObservationsTerrainPage />);
    await user.click(screen.getByRole("button", { name: "Enregistrer sur ce téléphone" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choisissez le type d'observation.");
    expect(h.toastSucces).not.toHaveBeenCalled();
  });

  it("conserve la saisie, vide le formulaire et le dit", async () => {
    const user = userEvent.setup();
    render(<ObservationsTerrainPage />);
    await user.selectOptions(screen.getByLabelText("Type"), "INCIDENT");
    await user.selectOptions(screen.getByLabelText("Gravité (facultative)"), "FORTE");
    await user.type(screen.getByLabelText("Description"), "Arbre sur la chaussée");
    await user.click(screen.getByRole("button", { name: "Enregistrer sur ce téléphone" }));

    await waitFor(() => expect(h.enregistrer).toHaveBeenCalledTimes(1));
    const [donnees, userId] = h.enregistrer.mock.calls[0];
    expect(donnees).toMatchObject({ type: "INCIDENT", gravite: "FORTE", description: "Arbre sur la chaussée", lat: null, lon: null });
    expect(userId).toBe("u1");
    await waitFor(() => expect(h.toastSucces).toHaveBeenCalledWith(expect.stringMatching(/conservée sur ce téléphone/)));
    expect(screen.getByLabelText("Description")).toHaveValue("");
  });

  it("si le stockage local refuse, l'agent est PREVENU que la saisie n'est pas conservee", async () => {
    h.enregistrer.mockRejectedValue(new Error("QuotaExceededError"));
    const user = userEvent.setup();
    render(<ObservationsTerrainPage />);
    await user.selectOptions(screen.getByLabelText("Type"), "AUTRE");
    await user.click(screen.getByRole("button", { name: "Enregistrer sur ce téléphone" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/n'a pas pu être conservée/);
    expect(h.toastSucces).not.toHaveBeenCalled();
  });
});

describe("Accessibilite (axe-core, WCAG 2.1 A et AA, contraste exclu)", () => {
  it("0 violation : formulaire seul", async () => {
    const { container } = render(<ObservationsTerrainPage />);
    await screen.findByText(/Aucune observation en attente/);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("0 violation : file avec une saisie en attente, une en conflit, une abandonnee, alertes affichees", async () => {
    h.file = [
      saisie("a"),
      saisie("c", { status: "conflit", conflitId: "conflit-9", errorMessage: "Un responsable doit trancher." }),
      saisie("x", { status: "abandonnee", refusDefinitif: true, errorMessage: "Refusé : MISSION_NON_AUTORISEE." }),
    ];
    h.etat = { ...h.etat, pendingCount: 3, conflitCount: 1, abandonCount: 1 };
    const { container } = render(<ObservationsTerrainPage />);
    await screen.findByText("description x");
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("0 violation : erreurs de validation affichees", async () => {
    h.enregistrer.mockResolvedValue({ ok: false, erreurs: ["Choisissez le type d'observation.", "Décrivez l'observation."] });
    const user = userEvent.setup();
    const { container } = render(<ObservationsTerrainPage />);
    await user.click(screen.getByRole("button", { name: "Enregistrer sur ce téléphone" }));
    await screen.findByRole("alert");
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});
