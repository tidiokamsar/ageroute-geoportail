import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { violationsAccessibilite } from "../test/accessibilite";
import { deplacer } from "../roulage";

/**
 * Enregistrer un releve en roulant (paragraphe 7.13) : ce que ces tests defendent.
 *   - l'ecran dit ses limites AVANT le depart (premier plan, ecran allume, pas d'IRI, pas essaye sur un telephone) ;
 *   - la position du navigateur alimente le noyau ; repere, segment, pause et arret sont pilotables ;
 *   - un segment encore ouvert EMPECHE l'arret et laisse le choix (clore ou abandonner) : jamais de fin inventee ;
 *   - la session part au serveur comme une operation `SessionRoulage`, et un refus du serveur est rendu avec son motif ;
 *   - une permission de position refusee est dite, pas avalee ;
 *   - zero violation d'accessibilite (axe-core) a chaque etape.
 * Rien ici ne prouve le comportement sur un vrai telephone : la geolocalisation est SIMULEE.
 */

const T0 = 1_790_000_000_000;
const h = vi.hoisted(() => ({
  posts: [] as { url: string; corps: Record<string, unknown> }[],
  reponsePush: { resultats: [{ statut: "SYNCHRONISE" }] } as unknown,
  suivi: { ok: null as ((p: unknown) => void) | null, err: null as ((e: { code: number }) => void) | null },
}));

vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "agent-1", role: "GESTIONNAIRE", modulesAutorises: [] } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async () => ({ data: [
      { id: "m-1", code: "MIS-1", intitule: "RN1 Coyah", statut: "EN_COURS", assigneId: "agent-1", createurId: "chef" },
      { id: "m-2", code: "MIS-2", intitule: "Close", statut: "TERMINEE", assigneId: "agent-1", createurId: "chef" },
      { id: "m-3", code: "MIS-3", intitule: "Autre agent", statut: "EN_COURS", assigneId: "agent-2", createurId: "chef" },
    ] })),
    post: vi.fn(async (url: string, corps: Record<string, unknown>) => {
      h.posts.push({ url, corps });
      if (url === "/v2/devices") return { data: { id: "appareil-1" } };
      return { data: h.reponsePush };
    }),
  },
}));
vi.mock("../lib/roulageHote", async (importOriginal) => {
  const reel = await importOriginal<typeof import("../lib/roulageHote")>();
  const stockage = reel.stockageMemoire();
  return {
    ...reel,
    ouvrirStockage: () => stockage,
    garderEcranAllume: async () => ({ actif: true, liberer: async () => undefined }),
  };
});

import { toast } from "../lib/toast";
import { EnregistrementRoulagePage } from "./EnregistrementRoulagePage";

function installerGeolocalisation() {
  const watchPosition = vi.fn((ok: (p: unknown) => void, err: (e: { code: number }) => void, _options?: unknown) => { h.suivi.ok = ok; h.suivi.err = err; return 7; });
  const clearWatch = vi.fn();
  Object.defineProperty(navigator, "geolocation", { configurable: true, value: { watchPosition, clearWatch } });
  return { watchPosition, clearWatch };
}

/** Une position `s` secondes apres le depart, a 10 m/s vers l'est, precision 8 m. */
function emettre(s: number) {
  vi.setSystemTime(T0 + s * 1000);
  const p = deplacer({ lat: 9.64, lon: -13.6 }, 10 * s, 90);
  act(() => { h.suivi.ok?.({ timestamp: T0 + s * 1000, coords: { latitude: p.lat, longitude: p.lon, accuracy: 8, speed: 10, heading: 90, altitude: null } }); });
}

function rendre() {
  return render(<MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><EnregistrementRoulagePage /></QueryClientProvider></MemoryRouter>);
}

async function demarrer() {
  fireEvent.click(screen.getByRole("button", { name: /Démarrer l'enregistrement/ }));
  await screen.findByText("Enregistrement en cours");
}

beforeEach(() => {
  h.posts.length = 0;
  h.reponsePush = { resultats: [{ statut: "SYNCHRONISE" }] };
  h.suivi.ok = null; h.suivi.err = null;
  vi.useFakeTimers({ toFake: ["Date"], now: T0 });
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  localStorage.clear();
  // jsdom ne sait pas « naviguer » vers un blob : le clic de telechargement est neutralise.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:essai") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("avant le depart", () => {
  it("dit ses limites avant de proposer de partir", () => {
    installerGeolocalisation();
    rendre();
    const limites = screen.getByRole("region", { name: /À savoir avant de partir/ });
    expect(limites).toHaveTextContent(/premier plan, écran allumé/);
    expect(limites).toHaveTextContent(/passager manipule le téléphone, pas le conducteur/);
    expect(limites).toHaveTextContent(/ne mesure ni l'IRI ni l'état de la chaussée/);
    expect(limites).toHaveTextContent(/pas encore été essayée sur un téléphone/);
    expect(screen.getByRole("button", { name: /Démarrer l'enregistrement/ })).toBeInTheDocument();
  });

  it("zero violation d'accessibilite", async () => {
    installerGeolocalisation();
    const { container } = rendre();
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

describe("enregistrement", () => {
  it("demande la position en haute precision et compte les positions retenues", async () => {
    const g = installerGeolocalisation();
    rendre();
    await demarrer();
    expect(g.watchPosition).toHaveBeenCalledTimes(1);
    expect(g.watchPosition.mock.calls[0][2]).toMatchObject({ enableHighAccuracy: true, maximumAge: 0 });
    for (let s = 0; s < 5; s += 1) emettre(s);
    const carte = screen.getByText("Positions retenues").parentElement as HTMLElement;
    expect(carte).toHaveTextContent("5");
  });

  it("pose un repere avec sa note et le dit", async () => {
    installerGeolocalisation();
    rendre();
    await demarrer();
    for (let s = 0; s < 3; s += 1) emettre(s);
    fireEvent.change(screen.getByLabelText(/Note \(facultative/), { target: { value: "nid de poule" } });
    fireEvent.click(screen.getByRole("button", { name: /Poser un repère ici/ }));
    expect(toast.success).toHaveBeenCalledWith("Repère posé.");
    expect(screen.getByText(/1 repère\(s\)/)).toBeInTheDocument();
  });

  it("un segment ouvert EMPECHE l'arret et laisse le choix : jamais de fin inventee", async () => {
    installerGeolocalisation();
    rendre();
    await demarrer();
    for (let s = 0; s < 3; s += 1) emettre(s);
    fireEvent.click(screen.getByRole("button", { name: "Début d'un segment" }));
    for (let s = 3; s < 6; s += 1) emettre(s);
    expect(screen.getByRole("button", { name: "Fin du segment" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Arrêter/ }));
    const choix = await screen.findByRole("alert");
    expect(choix).toHaveTextContent(/Un segment est encore ouvert/);
    expect(screen.queryByText("Enregistrement terminé")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Le clore à l'instant de l'arrêt/ }));
    expect(await screen.findByText("Enregistrement terminé")).toBeInTheDocument();
  });

  it("la pause suspend la prise de segment, la reprise la rend", async () => {
    installerGeolocalisation();
    rendre();
    await demarrer();
    emettre(0); emettre(1);
    fireEvent.click(screen.getByRole("button", { name: /Pause/ }));
    expect(screen.getByText("En pause")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Poser un repère ici/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Reprendre/ }));
    expect(screen.getByText("Enregistrement en cours")).toBeInTheDocument();
  });

  it("une permission de position refusee est DITE, avec la marche a suivre", async () => {
    installerGeolocalisation();
    rendre();
    await demarrer();
    act(() => { h.suivi.err?.({ code: 1 }); });
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent(/La position est refusée pour ce site/);
    expect(alerte).toHaveTextContent(/réglages du navigateur/);
  });

  it("un signal GPS perdu est dit, et la trace ne sera pas reliee", async () => {
    installerGeolocalisation();
    rendre();
    await demarrer();
    act(() => { h.suivi.err?.({ code: 2 }); });
    expect(await screen.findByText(/signal GPS est perdu/)).toHaveTextContent(/sans relier les deux côtés/);
  });

  it("zero violation d'accessibilite pendant l'enregistrement", async () => {
    installerGeolocalisation();
    const { container } = rendre();
    await demarrer();
    for (let s = 0; s < 3; s += 1) emettre(s);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

describe("apres l'arret", () => {
  async function terminerSession() {
    installerGeolocalisation();
    rendre();
    await demarrer();
    for (let s = 0; s < 5; s += 1) emettre(s);
    fireEvent.click(screen.getByRole("button", { name: /Arrêter/ }));
    await screen.findByText("Enregistrement terminé");
  }

  it("exporte la trace en GPX", async () => {
    await terminerSession();
    fireEvent.click(screen.getByRole("button", { name: /Télécharger le GPX/ }));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect(blob.type).toBe("application/gpx+xml");
  });

  it("envoie la session comme une operation SessionRoulage et confirme", async () => {
    await terminerSession();
    fireEvent.click(screen.getByRole("button", { name: /Envoyer la session au serveur/ }));
    expect(await screen.findByText("Session enregistrée sur le serveur.")).toBeInTheDocument();
    expect(h.posts.map((p) => p.url)).toEqual(["/v2/devices", "/v2/sync/push"]);
    const push = h.posts[1].corps as { appareilId: string; operations: { entityType: string; operation: string; payload: { points: unknown[]; versionContrat: number } }[] };
    expect(push.appareilId).toBe("appareil-1");
    expect(push.operations).toHaveLength(1);
    expect(push.operations[0]).toMatchObject({ entityType: "SessionRoulage", operation: "CREATE" });
    expect(push.operations[0].payload.points).toHaveLength(5);
    expect(push.operations[0].payload.versionContrat).toBe(1);
  });

  it("rattache la session a une mission ouverte de l'agent, et seulement a celles-la", async () => {
    await terminerSession();
    fireEvent.click(screen.getByRole("button", { name: /Rattacher à une de mes missions/ }));
    const choix = await screen.findByRole("combobox", { name: /Mission/ });
    expect([...(choix as HTMLSelectElement).options].map((o) => o.value)).toEqual(["", "m-1"]);
    fireEvent.change(choix, { target: { value: "m-1" } });
    fireEvent.click(screen.getByRole("button", { name: /Envoyer la session au serveur/ }));
    await screen.findByText("Session enregistrée sur le serveur.");
    const push = h.posts[1].corps as { operations: { payload: { missionId: string | null } }[] };
    expect(push.operations[0].payload.missionId).toBe("m-1");
  });

  it("sans choix, la session part sans mission", async () => {
    await terminerSession();
    fireEvent.click(screen.getByRole("button", { name: /Envoyer la session au serveur/ }));
    await screen.findByText("Session enregistrée sur le serveur.");
    expect((h.posts[1].corps as { operations: { payload: { missionId: string | null } }[] }).operations[0].payload.missionId).toBeNull();
  });

  it("un rejeu est dit comme tel : rien n'est duplique", async () => {
    h.reponsePush = { resultats: [{ statut: "REJOUEE" }] };
    await terminerSession();
    fireEvent.click(screen.getByRole("button", { name: /Envoyer la session au serveur/ }));
    expect(await screen.findByText(/déjà enregistrée sur le serveur : rien n'a été dupliqué/)).toBeInTheDocument();
  });

  it("un refus du serveur est rendu avec son motif, et la session reste sur le telephone", async () => {
    h.reponsePush = { resultats: [{ statut: "REJETE", motif: "HORS_TERRITOIRE" }] };
    await terminerSession();
    fireEvent.click(screen.getByRole("button", { name: /Envoyer la session au serveur/ }));
    const msg = await screen.findByText(/Refusée par le serveur \(HORS_TERRITOIRE\)/);
    expect(msg).toHaveTextContent(/reste sur ce téléphone/);
    expect(screen.getByRole("button", { name: /Envoyer la session au serveur/ })).toBeEnabled();
  });

  it("zero violation d'accessibilite en fin de session", async () => {
    await terminerSession();
    expect(await violationsAccessibilite(document.body)).toEqual([]);
  });
});
