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
  etat: { pendingCount: 0, conflitCount: 0, abandonCount: 0, refusDroitsCount: 0, syncing: false, online: true },
  file: [] as Record<string, unknown>[],
  /** Saisies des deux autres files, lues par le panneau des refus de droits. */
  defauts: [] as Record<string, unknown>[],
  portions: [] as Record<string, unknown>[],
  relancerDroits: vi.fn(),
  enregistrer: vi.fn(),
  relancer: vi.fn(),
  sync: vi.fn(),
  toastSucces: vi.fn(),
  /** Erreur que la lecture de la file locale doit lever (coffre verrouille, aucun compte...). */
  lireEchec: null as unknown,
}));

vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u1", role: "INSPECTEUR" } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: h.toastSucces, error: vi.fn() } }));
vi.mock("../hooks/useOfflineSync", () => ({ useOfflineSync: () => ({ ...h.etat, syncNow: h.sync }) }));
vi.mock("../lib/offlineDb", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAllPendingObservations: async () => { if (h.lireEchec) throw h.lireEchec; return h.file; },
  getAllPendingDefauts: async () => h.defauts,
  getAllPendingPortions: async () => h.portions,
}));
vi.mock("../lib/offlineSync", () => ({
  relancerObservation: (...a: unknown[]) => h.relancer(...a),
  syncPendingOfflineData: (...a: unknown[]) => h.sync(...a),
  relancerRefusDroits: (...a: unknown[]) => h.relancerDroits(...a),
  etatSynchronisation: () => ({ appareilRevoque: false, compteInactif: false, message: null }),
  MESSAGES_REFUS_DROITS: {
    HORS_PERIMETRE: "Cette saisie est hors de votre périmètre territorial actuel.",
    REGION_INCONNUE: "La région de cette saisie n'a pas pu être rattachée à votre périmètre.",
    MODULE_RETIRE: "Le module de cette saisie a été retiré de votre compte.",
    MISSION_NON_AUTORISEE: "La mission de cette saisie ne vous est plus assignée.",
    NON_PRECISEE: "Le serveur a refusé cette saisie parce que vos droits ont changé.",
  },
}));
vi.mock("../lib/observationsTerrain", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enregistrerObservation: (...a: unknown[]) => h.enregistrer(...a),
}));

import { ObservationsTerrainPage } from "./ObservationsTerrainPage";
import { ErreurStockageLocal } from "../lib/compteCourant";

function saisie(localId: string, over: Record<string, unknown> = {}) {
  return {
    localId, ownerUserId: "u1", status: "pending", createdAt: "2026-10-23T08:00:00.000Z",
    payload: { type: "DEGRADATION", description: `description ${localId}`, observeA: "2026-10-23T08:00:00.000Z" },
    ...over,
  };
}

beforeEach(() => {
  h.etat = { pendingCount: 0, conflitCount: 0, abandonCount: 0, refusDroitsCount: 0, syncing: false, online: true };
  h.file = [];
  h.defauts = [];
  h.portions = [];
  h.relancerDroits.mockReset().mockResolvedValue("ENVOYEE");
  h.enregistrer.mockReset().mockResolvedValue({ ok: true });
  h.relancer.mockReset().mockResolvedValue(undefined);
  h.sync.mockReset().mockResolvedValue(undefined);
  h.toastSucces.mockReset();
  h.lireEchec = null;
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
    await waitFor(() => expect(h.sync).toHaveBeenCalledWith({ manuel: true }));
  });

  it("« Envoyer maintenant » est un geste de l'agent : cycle MANUEL", async () => {
    h.file = [saisie("a")]; h.etat = { ...h.etat, pendingCount: 1 };
    const user = userEvent.setup();
    render(<ObservationsTerrainPage />);
    await screen.findByText("description a");
    await user.click(screen.getByRole("button", { name: "Envoyer maintenant" }));
    expect(h.sync).toHaveBeenCalledTimes(1);
    expect(h.sync).toHaveBeenCalledWith({ manuel: true });
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

describe("Saisies refusees pour droits modifies (quarantaine)", () => {
  const quarantaine = (localId: string, cause = "HORS_PERIMETRE") => saisie(localId, {
    status: "refus_droits", causeRefusDroits: cause, errorMessage: "Cette saisie est hors de votre périmètre territorial actuel.", nbPhotos: 2,
  });

  it("PAS de panneau quand rien n'est en quarantaine", async () => {
    h.file = [saisie("a")]; h.etat = { ...h.etat, pendingCount: 1 };
    render(<ObservationsTerrainPage />);
    await screen.findByText("description a");
    expect(screen.queryByRole("heading", { name: /Saisies refusées : droits modifiés/ })).not.toBeInTheDocument();
  });

  it("montre le panneau (cause en clair, photos) ET la saisie dans la liste avec son propre libelle, sans bouton « Relancer l'envoi »", async () => {
    h.file = [quarantaine("q")]; h.etat = { ...h.etat, pendingCount: 1, refusDroitsCount: 1 };
    render(<ObservationsTerrainPage />);
    const panneau = (await screen.findByRole("heading", { name: /Saisies refusées : droits modifiés \(1\)/ })).closest("section")!;
    expect(within(panneau).getByText(/hors de votre périmètre territorial actuel/)).toBeInTheDocument();
    expect(within(panneau).getByText(/2 photos/)).toBeInTheDocument();
    const item = (await screen.findByText("description q")).closest("li")!;
    expect(item).toHaveAttribute("data-statut", "refus_droits");
    expect(within(item).getByText("Refusée : droits modifiés")).toBeInTheDocument();
    expect(within(item).getByText(/ne part pas toute seule/)).toBeInTheDocument();
    expect(within(item).queryByText("En attente d'envoi")).not.toBeInTheDocument();
    expect(within(item).queryByRole("button")).not.toBeInTheDocument();
    // Aucune suppression n'est proposee, nulle part.
    expect(screen.queryByRole("button", { name: /supprimer|effacer/i })).not.toBeInTheDocument();
  });

  it("couvre aussi les defauts et les portions en quarantaine, et renvoie dans la bonne file", async () => {
    h.defauts = [{ localId: "d1", ownerUserId: "u1", status: "refus_droits", causeRefusDroits: "MODULE_RETIRE", createdAt: "2026-10-23T08:00:00.000Z", payload: { catalogueCode: "NID_POULE", constateA: "2026-10-23T08:00:00.000Z" }, nbPhotos: 1 }];
    h.portions = [{ localId: "p1", ownerUserId: "u1", status: "refus_droits", causeRefusDroits: "REGION_INCONNUE", createdAt: "2026-10-22T08:00:00.000Z", payload: { tronconId: "t", debutM: 100, finM: 250 } }];
    h.etat = { ...h.etat, pendingCount: 2, refusDroitsCount: 2 };
    const user = userEvent.setup();
    render(<ObservationsTerrainPage />);
    await screen.findByText(/Défaut NID_POULE/);
    expect(screen.getByText(/Portion de 100 m à 250 m/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Renvoyer cette saisie : Portion/ }));
    await waitFor(() => expect(h.relancerDroits).toHaveBeenCalledWith("p1", "portions"));
  });

  it("« Renvoyer » appelle relancerRefusDroits(localId, \"observations\") et le compte rendu reste affiche quand la saisie est partie", async () => {
    h.file = [quarantaine("q")]; h.etat = { ...h.etat, pendingCount: 1, refusDroitsCount: 1 };
    h.relancerDroits.mockImplementation(async () => { h.file = []; h.etat = { ...h.etat, pendingCount: 0, refusDroitsCount: 0 }; return "ENVOYEE"; });
    const user = userEvent.setup();
    const { rerender } = render(<ObservationsTerrainPage />);
    await user.click(await screen.findByRole("button", { name: /Renvoyer cette saisie/ }));
    expect(h.relancerDroits).toHaveBeenCalledWith("q", "observations");
    expect(await screen.findByText(/le serveur a accepté cette saisie/)).toBeInTheDocument();
    rerender(<ObservationsTerrainPage />);
    // La quarantaine est vide : le panneau reste monte pour garder le compte rendu.
    expect(screen.getByText(/le serveur a accepté cette saisie/)).toBeInTheDocument();
  });

  it("ne montre PAS la quarantaine d'un autre compte", async () => {
    h.file = [quarantaine("q"), { ...quarantaine("autre"), ownerUserId: "u2" }]; h.etat = { ...h.etat, pendingCount: 2, refusDroitsCount: 1 };
    render(<ObservationsTerrainPage />);
    await screen.findByRole("heading", { name: /\(1\)/ });
    expect(screen.queryByText("description autre")).not.toBeInTheDocument();
  });

  it("0 violation d'accessibilite avec le panneau", async () => {
    h.file = [quarantaine("q"), saisie("a")]; h.etat = { ...h.etat, pendingCount: 2, refusDroitsCount: 1 };
    const { container } = render(<ObservationsTerrainPage />);
    await screen.findByText("description q");
    expect(await violationsAccessibilite(container)).toEqual([]);
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

describe("Erreurs typees du stockage local", () => {
  async function saisirEtEnregistrer() {
    const user = userEvent.setup();
    render(<ObservationsTerrainPage />);
    await user.selectOptions(screen.getByLabelText("Type"), "INCIDENT");
    await user.type(screen.getByLabelText("Description"), "Arbre sur la chaussée");
    await user.click(screen.getByRole("button", { name: "Enregistrer sur ce téléphone" }));
    return user;
  }

  it("stockage plein : le message du stockage est affiché, aucun succès annoncé, le formulaire reste rempli", async () => {
    h.enregistrer.mockRejectedValue(new ErreurStockageLocal("STOCKAGE_PLEIN"));
    await saisirEtEnregistrer();
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent(/Stockage de l'appareil plein/);
    expect(alerte).toHaveTextContent(/PAS enregistrée/);
    expect(h.toastSucces).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Description")).toHaveValue("Arbre sur la chaussée");
    expect(screen.getByLabelText("Type")).toHaveValue("INCIDENT");
  });

  it("trop de photos : le message du stockage est affiché tel quel", async () => {
    h.enregistrer.mockRejectedValue(new ErreurStockageLocal("TROP_DE_PHOTOS"));
    await saisirEtEnregistrer();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Cinq photos au maximum par saisie/);
  });

  it("coffre verrouillé : « Déverrouillez avec votre PIN pour enregistrer »", async () => {
    h.enregistrer.mockRejectedValue(new ErreurStockageLocal("COFFRE_VERROUILLE"));
    await saisirEtEnregistrer();
    expect(await screen.findByRole("alert")).toHaveTextContent("Déverrouillez avec votre PIN pour enregistrer.");
    expect(h.toastSucces).not.toHaveBeenCalled();
  });

  it("la file locale illisible (coffre verrouillé) est dite, sans rejet non géré ni faux « aucune observation en attente »", async () => {
    h.lireEchec = new ErreurStockageLocal("COFFRE_VERROUILLE");
    render(<ObservationsTerrainPage />);
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent(/session locale est verrouillée/);
    expect(screen.queryByText(/Aucune observation en attente/)).not.toBeInTheDocument();
  });

  it("relancer une saisie abandonnée quand l'écriture est refusée : l'alerte le dit et rien n'est renvoyé", async () => {
    const abandonnee = saisie("x", { status: "abandonnee", errorMessage: "Refusé." });
    h.file = [abandonnee];
    h.etat = { ...h.etat, pendingCount: 1, abandonCount: 1 };
    h.relancer.mockRejectedValue(new ErreurStockageLocal("STOCKAGE_PLEIN"));
    const user = userEvent.setup();
    render(<ObservationsTerrainPage />);
    const item = (await screen.findByText("description x")).closest("li")!;
    await user.click(within(item).getByRole("button", { name: "Relancer l'envoi" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Stockage de l'appareil plein/);
    expect(h.sync).not.toHaveBeenCalled();
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
