import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { violationsAccessibilite } from "../test/accessibilite";
import { deplacer } from "../roulage";
import { fermerCompte, ouvrirCompte, type Chiffreur } from "../lib/compteCourant";

/**
 * Enregistrer en roulant : les LIENS vers les releves envoyes. Ce que ces tests defendent.
 *   - une fois l'envoi CONFIRME par le serveur, l'ecran propose « Voir ce relevé sur le serveur », vers le detail de CETTE session
 *     (l'identifiant du releve serveur est celui de la session locale) ;
 *   - ce lien n'existe pas tant que le serveur n'a pas confirme (envoi refuse, ou pas encore tente) : on ne promet pas une page vide ;
 *   - l'ecran de fin renvoie vers la liste « Relevés envoyés », envoye ou non.
 * Fichier separe de EnregistrementRoulagePage.test.tsx (qui porte le reste du comportement de l'ecran) : meme principe de simulation,
 * le GPS, l'api et le journal sont simules.
 */

const T0 = 1_790_000_000_000;
const h = vi.hoisted(() => ({
  suivi: { ok: null as ((p: unknown) => void) | null },
  reponsePush: { resultats: [{ statut: "SYNCHRONISE" }] } as unknown,
  posts: [] as { url: string; corps: Record<string, unknown> }[],
}));

vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "agent-1", role: "GESTIONNAIRE", modulesAutorises: [] } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/api", () => ({
  api: {
    post: vi.fn(async (url: string, corps: Record<string, unknown>) => {
      h.posts.push({ url, corps });
      return url === "/v2/devices" ? { data: { id: "appareil-1" } } : { data: h.reponsePush };
    }),
    get: vi.fn(async () => { throw new Error("hors ligne"); }),
  },
}));
vi.mock("../lib/offlineSync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/offlineSync")>()),
  etatSynchronisation: () => ({ appareilRevoque: false, compteInactif: false, message: null }),
}));
vi.mock("../components/CarteTraceRoulage", () => ({ CarteTraceRoulage: () => <div data-testid="carte-trace" /> }));
vi.mock("../lib/roulageHote", async (importOriginal) => {
  const reel = await importOriginal<typeof import("../lib/roulageHote")>();
  const stockage = reel.stockageMemoire();
  return { ...reel, ouvrirStockage: () => stockage, viderStockageEssai: () => stockage.vider(), garderEcranAllume: async () => ({ actif: true, liberer: async () => undefined }) };
});

import { EnregistrementRoulagePage } from "./EnregistrementRoulagePage";

function installerGeolocalisation() {
  const watchPosition = vi.fn((ok: (p: unknown) => void) => { h.suivi.ok = ok; return 7; });
  Object.defineProperty(navigator, "geolocation", { configurable: true, value: { watchPosition, clearWatch: vi.fn() } });
}
function emettre(s: number) {
  vi.setSystemTime(T0 + s * 1000);
  const p = deplacer({ lat: 9.64, lon: -13.6 }, 10 * s, 90);
  act(() => { h.suivi.ok?.({ timestamp: T0 + s * 1000, coords: { latitude: p.lat, longitude: p.lon, accuracy: 8, speed: 10, heading: 90, altitude: null } }); });
}

async function terminerSession() {
  installerGeolocalisation();
  render(<MemoryRouter><EnregistrementRoulagePage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("button", { name: /Démarrer l'enregistrement/ }));
  await screen.findByText("Enregistrement en cours");
  for (let s = 0; s < 5; s += 1) emettre(s);
  fireEvent.click(screen.getByRole("button", { name: /Arrêter/ }));
  await screen.findByText("Terminée, à envoyer");
}

/** L'identifiant de la session locale, tel que le push l'a envoyee (`entityId` de l'operation). */
function idEnvoye(): string {
  const push = h.posts.find((p) => p.url === "/v2/sync/push");
  return (push?.corps as { operations: { entityId: string }[] }).operations[0].entityId;
}

beforeEach(async () => {
  await (await import("../lib/roulageHote") as unknown as { viderStockageEssai: () => Promise<void> }).viderStockageEssai();
  h.posts.length = 0;
  h.reponsePush = { resultats: [{ statut: "SYNCHRONISE" }] };
  h.suivi.ok = null;
  vi.useFakeTimers({ toFake: ["Date"], now: T0 });
  localStorage.clear();
  fermerCompte();
  ouvrirCompte({ compteId: "agent-1", empreinte: "0123456789abcdef", chiffreur: { estDeverrouille: () => true } as unknown as Chiffreur });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); vi.useRealTimers(); fermerCompte(); });

describe("liens vers les releves envoyes", () => {
  it("avant l'envoi : le lien vers la liste existe, pas le lien vers le detail", async () => {
    await terminerSession();
    expect(screen.getByRole("link", { name: "Relevés envoyés" })).toHaveAttribute("href", "/inspections/releve/envoyes");
    expect(screen.queryByRole("link", { name: "Voir ce relevé sur le serveur" })).toBeNull();
  });

  it("apres la confirmation du serveur : « Voir ce relevé sur le serveur » mene au detail de cette session", async () => {
    await terminerSession();
    fireEvent.click(screen.getByRole("button", { name: /(Envoyer|Renvoyer) la session/ }));
    await screen.findByText("Session enregistrée sur le serveur.");
    const lien = screen.getByRole("link", { name: "Voir ce relevé sur le serveur" });
    expect(lien).toHaveAttribute("href", `/inspections/releve/envoyes/${idEnvoye()}`);
    expect(idEnvoye()).toMatch(/^[0-9a-f-]{36}$/);
    expect(screen.getByRole("link", { name: "Relevés envoyés" })).toHaveAttribute("href", "/inspections/releve/envoyes");
  });

  it("un envoi refuse par le serveur ne propose PAS de voir le relevé sur le serveur", async () => {
    h.reponsePush = { resultats: [{ statut: "REJETE", motif: "HORS_TERRITOIRE" }] };
    await terminerSession();
    fireEvent.click(screen.getByRole("button", { name: /(Envoyer|Renvoyer) la session/ }));
    await screen.findByText(/Refusée par le serveur/);
    expect(screen.queryByRole("link", { name: "Voir ce relevé sur le serveur" })).toBeNull();
    expect(screen.getByRole("link", { name: "Relevés envoyés" })).toBeInTheDocument();
  });

  it("l'ecran de fin avec les deux liens n'a aucune violation d'accessibilite (axe-core)", async () => {
    await terminerSession();
    fireEvent.click(screen.getByRole("button", { name: /(Envoyer|Renvoyer) la session/ }));
    await screen.findByText("Session enregistrée sur le serveur.");
    expect(await violationsAccessibilite(document.body)).toEqual([]);
  });
});
