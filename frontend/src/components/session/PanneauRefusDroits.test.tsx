import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { violationsAccessibilite } from "../../test/accessibilite";

/**
 * Le panneau des saisies refusees pour droits modifies : ce que ces tests defendent.
 *   - les trois files (defauts, portions, observations) sont listees, avec cause en mots clairs, date du constat et photos ;
 *   - AUCUNE suppression n'est proposee ; le seul geste est « Renvoyer » (relancerRefusDroits(localId, file)) ;
 *   - chacune des sept issues d'un renvoi est traduite en une phrase, et les erreurs typees du stockage sont dites ;
 *   - 0 violation axe-core (WCAG 2.1 A et AA, contraste exclu : jsdom ne le calcule pas).
 * La file et la synchronisation sont simulees : leur comportement reel est eprouve par `lib/offlineSync.droits.test.ts`.
 */

const h = vi.hoisted(() => ({
  defauts: [] as Record<string, unknown>[],
  portions: [] as Record<string, unknown>[],
  observations: [] as Record<string, unknown>[],
  lireEchec: null as unknown,
  relancer: vi.fn(),
  arret: null as string | null,
  compteurs: { pendingCount: 0, refusDroitsCount: 0, syncing: false },
  lectures: { defauts: 0, portions: 0, observations: 0 },
}));

vi.mock("../../hooks/useOfflineSync", () => ({ useOfflineSync: () => h.compteurs }));
vi.mock("../../lib/offlineDb", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAllPendingDefauts: async () => { h.lectures.defauts += 1; if (h.lireEchec) throw h.lireEchec; return h.defauts; },
  getAllPendingPortions: async () => { h.lectures.portions += 1; if (h.lireEchec) throw h.lireEchec; return h.portions; },
  getAllPendingObservations: async () => { h.lectures.observations += 1; if (h.lireEchec) throw h.lireEchec; return h.observations; },
}));
vi.mock("../../lib/offlineSync", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  relancerRefusDroits: (...a: unknown[]) => h.relancer(...a),
  etatSynchronisation: () => ({ appareilRevoque: h.arret !== null, compteInactif: false, message: h.arret }),
}));

import { ErreurStockageLocal } from "../../lib/compteCourant";
import { MESSAGE_APPAREIL_REVOQUE, MESSAGES_REFUS_DROITS } from "../../lib/offlineSync";
import { messageIssueRelance, PanneauRefusDroits } from "./PanneauRefusDroits";

const base = { ownerUserId: "agent-1", status: "refus_droits", createdAt: "2026-10-24T08:00:00.000Z" };
const defaut = (localId: string, over: Record<string, unknown> = {}) => ({
  ...base, localId, causeRefusDroits: "MODULE_RETIRE", nbPhotos: 1, payload: { catalogueCode: "NID_POULE", constateA: "2026-10-23T09:30:00.000Z" }, ...over,
});
const portion = (localId: string, over: Record<string, unknown> = {}) => ({
  ...base, localId, causeRefusDroits: "HORS_PERIMETRE", payload: { tronconId: "t1", debutM: 120, finM: 480.4, observeeLe: "2026-10-22T07:00:00.000Z" }, ...over,
});
const observation = (localId: string, over: Record<string, unknown> = {}) => ({
  ...base, localId, causeRefusDroits: "MISSION_NON_AUTORISEE", nbPhotos: 3,
  payload: { type: "INCIDENT", description: "texte libre", observeA: "2026-10-24T06:15:00.000Z" }, ...over,
});

function rendre(props: Partial<React.ComponentProps<typeof PanneauRefusDroits>> = {}) {
  return render(<PanneauRefusDroits compteId="agent-1" {...props} />);
}

beforeEach(() => {
  h.defauts = []; h.portions = []; h.observations = [];
  h.lireEchec = null;
  h.relancer.mockReset().mockResolvedValue("ENVOYEE");
  h.arret = null;
  h.compteurs = { pendingCount: 0, refusDroitsCount: 0, syncing: false };
  h.lectures = { defauts: 0, portions: 0, observations: 0 };
});
afterEach(() => cleanup());

describe("liste des saisies en quarantaine", () => {
  it("rend null quand il n'y a rien : aucun panneau vide", async () => {
    const { container } = rendre();
    await waitFor(() => expect(h.lectures.observations).toBeGreaterThan(0));
    expect(container).toBeEmptyDOMElement();
  });

  it("couvre les TROIS files, avec cause en clair, date du constat et nombre de photos", async () => {
    h.defauts = [defaut("d1")]; h.portions = [portion("p1")]; h.observations = [observation("o1")];
    rendre();
    const section = (await screen.findByRole("heading", { name: /Saisies refusées : droits modifiés \(3\)/ })).closest("section")!;
    const lignes = within(section).getAllByRole("listitem");
    expect(lignes).toHaveLength(3);

    const d = lignes.find((l) => l.getAttribute("data-file") === "defauts")!;
    expect(within(d).getByText("Défaut NID_POULE")).toBeInTheDocument();
    expect(within(d).getByText(MESSAGES_REFUS_DROITS.MODULE_RETIRE)).toBeInTheDocument();
    expect(within(d).getByText(/1 photo(?!s)/)).toBeInTheDocument();
    expect(within(d).getByText(/Constaté le 23\/10\/2026/)).toBeInTheDocument();

    const p = lignes.find((l) => l.getAttribute("data-file") === "portions")!;
    expect(within(p).getByText("Portion de 120 m à 480 m")).toBeInTheDocument();
    expect(within(p).getByText(MESSAGES_REFUS_DROITS.HORS_PERIMETRE)).toBeInTheDocument();
    expect(within(p).getByText(/aucune photo/)).toBeInTheDocument();

    const o = lignes.find((l) => l.getAttribute("data-file") === "observations")!;
    expect(within(o).getByText("Observation Incident")).toBeInTheDocument();
    expect(within(o).getByText(MESSAGES_REFUS_DROITS.MISSION_NON_AUTORISEE)).toBeInTheDocument();
    expect(within(o).getByText(/3 photos/)).toBeInTheDocument();
  });

  it("une cause absente ou inconnue se lit comme « non precisee », jamais comme un texte vide", async () => {
    h.observations = [observation("o1", { causeRefusDroits: undefined })];
    rendre();
    expect(await screen.findByText(MESSAGES_REFUS_DROITS.NON_PRECISEE)).toBeInTheDocument();
  });

  it("ne montre ni les saisies d'un autre compte, ni celles qui ne sont pas en quarantaine", async () => {
    h.observations = [
      observation("mienne"),
      observation("autre", { ownerUserId: "agent-2" }),
      observation("abandonnee", { status: "abandonnee" }),
      observation("attente", { status: "pending" }),
    ];
    rendre();
    await screen.findByRole("heading", { name: /\(1\)/ });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("`files` restreint les files lues", async () => {
    h.defauts = [defaut("d1")]; h.observations = [observation("o1")];
    rendre({ files: ["observations"] });
    await screen.findByRole("heading", { name: /\(1\)/ });
    expect(h.lectures).toEqual({ defauts: 0, portions: 0, observations: 1 });
    expect(screen.queryByText("Défaut NID_POULE")).not.toBeInTheDocument();
  });

  it("AUCUNE suppression n'est proposee : le seul bouton de chaque saisie est « Renvoyer »", async () => {
    h.defauts = [defaut("d1")]; h.portions = [portion("p1")]; h.observations = [observation("o1")];
    rendre();
    await screen.findByRole("heading", { name: /\(3\)/ });
    const boutons = screen.getAllByRole("button");
    expect(boutons).toHaveLength(3);
    for (const b of boutons) {
      expect(b).toHaveTextContent("Renvoyer");
      expect(b.getAttribute("aria-label")).toMatch(/^Renvoyer cette saisie : /);
    }
    expect(screen.queryByRole("button", { name: /supprimer|effacer|retirer|ignorer|abandonner/i })).not.toBeInTheDocument();
  });

  it("la file illisible est dite par l'alerte du stockage (coffre verrouille), sans faux « rien a renvoyer »", async () => {
    h.lireEchec = new ErreurStockageLocal("COFFRE_VERROUILLE");
    rendre();
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent(/session locale est verrouillée/);
  });
});

describe("Renvoyer : une issue, une phrase", () => {
  const cas: [string, string, RegExp][] = [
    ["ENVOYEE", "ENVOYEE", /le serveur a accepté cette saisie/],
    ["TOUJOURS_REFUSEE", "TOUJOURS_REFUSEE", /refuse toujours cette saisie.*quarantaine.*rien n'est perdu/],
    ["EN_FILE", "EN_FILE", /n'est plus refusée pour droits.*l'envoi n'a pas abouti.*synchronisation normale/],
    ["ARRET", "ARRET", new RegExp(MESSAGE_APPAREIL_REVOQUE.slice(0, 30) + ".*Rien n'a été envoyé")],
    ["HORS_LIGNE", "HORS_LIGNE", /Pas de réseau : rien n'a été envoyé/],
    ["SYNCHRONISATION_EN_COURS", "SYNCHRONISATION_EN_COURS", /synchronisation est déjà en cours : rien n'a été changé/],
    ["NON_EN_QUARANTAINE", "NON_EN_QUARANTAINE", /n'est plus en quarantaine/],
  ];

  it.each(cas)("%s", async (_nom, issue, attendu) => {
    h.arret = MESSAGE_APPAREIL_REVOQUE;
    h.observations = [observation("o1")];
    h.relancer.mockResolvedValue(issue);
    const user = userEvent.setup();
    rendre();
    await user.click(await screen.findByRole("button", { name: /Renvoyer cette saisie/ }));
    expect(h.relancer).toHaveBeenCalledTimes(1);
    expect(h.relancer).toHaveBeenCalledWith("o1", "observations");
    const statut = await screen.findByText(attendu);
    expect(statut.closest("[role=status]")).not.toBeNull();
    expect(statut).toHaveTextContent(/Observation Incident du 24\/10\/2026/);
  });

  it("chaque issue a un texte distinct, sans tiret cadratin ni emoji", () => {
    const issues = ["ENVOYEE", "TOUJOURS_REFUSEE", "EN_FILE", "ARRET", "HORS_LIGNE", "SYNCHRONISATION_EN_COURS", "NON_EN_QUARANTAINE"] as const;
    const textes = issues.map((i) => messageIssueRelance(i).message);
    expect(new Set(textes).size).toBe(issues.length);
    for (const t of textes) {
      expect(t).not.toMatch(/[–—]/);
      expect(t).not.toMatch(/\p{Extended_Pictographic}/u);
    }
    expect(issues.filter((i) => messageIssueRelance(i).ok)).toEqual(["ENVOYEE"]);
  });

  it("route le renvoi vers la bonne file (defauts, portions, observations)", async () => {
    h.defauts = [defaut("d1")]; h.portions = [portion("p1")]; h.observations = [observation("o1")];
    const user = userEvent.setup();
    rendre();
    await screen.findByRole("heading", { name: /\(3\)/ });
    await user.click(screen.getByRole("button", { name: /Renvoyer cette saisie : Défaut/ }));
    await waitFor(() => expect(h.relancer).toHaveBeenLastCalledWith("d1", "defauts"));
    await user.click(screen.getByRole("button", { name: /Renvoyer cette saisie : Portion/ }));
    await waitFor(() => expect(h.relancer).toHaveBeenLastCalledWith("p1", "portions"));
  });

  it("un seul renvoi a la fois : les autres boutons sont inactifs pendant l'envoi", async () => {
    h.observations = [observation("o1"), observation("o2")];
    let fin: (i: string) => void = () => undefined;
    h.relancer.mockImplementation(() => new Promise<string>((r) => { fin = r; }));
    const user = userEvent.setup();
    rendre();
    const boutons = await screen.findAllByRole("button", { name: /Renvoyer cette saisie/ });
    await user.click(boutons[0]);
    await waitFor(() => expect(screen.getAllByRole("button").every((b) => (b as HTMLButtonElement).disabled)).toBe(true));
    expect(boutons[0]).toHaveAttribute("aria-busy", "true");
    expect(boutons[1]).toHaveAttribute("aria-busy", "false");
    fin("TOUJOURS_REFUSEE");
    await waitFor(() => expect(screen.getAllByRole("button").every((b) => !(b as HTMLButtonElement).disabled)).toBe(true));
  });

  it("une erreur typee du stockage (coffre verrouille) est dite par l'alerte, la saisie reste listee", async () => {
    h.observations = [observation("o1")];
    h.relancer.mockRejectedValue(new ErreurStockageLocal("COFFRE_VERROUILLE"));
    const user = userEvent.setup();
    rendre();
    await user.click(await screen.findByRole("button", { name: /Renvoyer cette saisie/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Déverrouillez avec votre PIN pour enregistrer.");
    expect(screen.getByText("Observation Incident")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Renvoyer cette saisie/ })).toBeEnabled();
  });

  it("une erreur inattendue est dite aussi, et rien n'est presente comme envoye", async () => {
    h.observations = [observation("o1")];
    h.relancer.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    rendre();
    await user.click(await screen.findByRole("button", { name: /Renvoyer cette saisie/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/n'a pas pu être fait.*conservée sur ce téléphone/);
    expect(screen.queryByText(/le serveur a accepté/)).not.toBeInTheDocument();
  });

  it("le compte rendu reste affiche quand la derniere saisie est partie (la liste se vide)", async () => {
    h.observations = [observation("o1")];
    h.relancer.mockImplementation(async () => { h.observations = []; return "ENVOYEE"; });
    const user = userEvent.setup();
    rendre();
    await user.click(await screen.findByRole("button", { name: /Renvoyer cette saisie/ }));
    expect(await screen.findByText(/le serveur a accepté cette saisie/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Renvoyer/ })).not.toBeInTheDocument();
  });
});

describe("accessibilite (axe-core, WCAG 2.1 A et AA, contraste exclu)", () => {
  it("0 violation : trois files, comptes rendus et alerte affiches", async () => {
    h.defauts = [defaut("d1")]; h.portions = [portion("p1")]; h.observations = [observation("o1")];
    h.relancer.mockResolvedValue("TOUJOURS_REFUSEE");
    const user = userEvent.setup();
    const { container } = rendre();
    await user.click(await screen.findByRole("button", { name: /Renvoyer cette saisie : Défaut/ }));
    await screen.findByText(/refuse toujours cette saisie/);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("0 violation : file illisible (alerte seule)", async () => {
    h.lireEchec = new ErreurStockageLocal("COFFRE_VERROUILLE");
    const { container } = rendre();
    await screen.findByRole("alert");
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});
