import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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
/**
 * Les codes de referentiel et les missions ci-dessous sont des DONNEES D'ESSAI : aucune n'est une valeur du
 * referentiel reel, et l'ecran ne doit jamais en proposer d'autres que celles que le serveur (ici simule) rend.
 */
const REFERENTIELS_ESSAI = {
  revetements: [{ code: "R_UN", libelle: "Revêtement essai un", actif: true }, { code: "R_RETIRE", libelle: "Revêtement retiré", actif: false }],
  etats: [{ code: "E_UN", libelle: "État essai un", actif: true }, { code: "E_DEUX", libelle: "État essai deux", actif: true }],
  praticabilites: [{ code: "P_UN", libelle: "Praticabilité essai un", actif: true }],
  praticabiliteNonDefinie: false,
};
const MISSIONS_ESSAI = [
  { id: "11111111-1111-4111-8111-111111111111", code: "M-MIENNE", intitule: "Patrouille assignée", statut: "EN_COURS", assigneId: "agent-1", createurId: "chef-1" },
  { id: "22222222-2222-4222-8222-222222222222", code: "M-AUTRE", intitule: "Mission d'un autre agent", statut: "EN_COURS", assigneId: "agent-2", createurId: "chef-1" },
  { id: "33333333-3333-4333-8333-333333333333", code: "M-ANNULEE", intitule: "Mission annulée", statut: "ANNULEE", assigneId: "agent-1", createurId: "agent-1" },
];

const h = vi.hoisted(() => ({
  posts: [] as { url: string; corps: Record<string, unknown> }[],
  reponsePush: { resultats: [{ statut: "SYNCHRONISE" }] } as unknown,
  suivi: { ok: null as ((p: unknown) => void) | null, err: null as ((e: { code: number }) => void) | null },
  referentiels: null as unknown,
  referentielsEchec: false,
  missions: null as unknown,
  missionsEchec: false,
}));

vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "agent-1", role: "GESTIONNAIRE", modulesAutorises: [] } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/api", () => ({
  api: {
    post: vi.fn(async (url: string, corps: Record<string, unknown>) => {
      h.posts.push({ url, corps });
      if (url === "/v2/devices") return { data: { id: "appareil-1" } };
      return { data: h.reponsePush };
    }),
    get: vi.fn(async (url: string) => {
      if (url === "/v2/referentiels") {
        if (h.referentielsEchec) throw new Error("reseau");
        return { data: h.referentiels };
      }
      if (url === "/v2/missions") {
        if (h.missionsEchec) throw new Error("reseau");
        return { data: h.missions };
      }
      throw new Error(`GET inattendu : ${url}`);
    }),
  },
}));
// Leaflet a besoin d'un vrai navigateur (mesures, canvas) : la carte est remplacee par un temoin qui expose ce qu'elle recoit.
vi.mock("../components/CarteTraceRoulage", () => ({
  CarteTraceRoulage: (p: { segments: unknown[][]; position: [number, number] | null }) => (
    <div data-testid="carte-trace" data-segments={p.segments.length} data-points={p.segments.reduce((n, s) => n + s.length, 0)} data-position={p.position ? p.position.join(",") : ""} />
  ),
}));
vi.mock("../lib/roulageHote", async (importOriginal) => {
  const reel = await importOriginal<typeof import("../lib/roulageHote")>();
  const stockage = reel.stockageMemoire();
  return {
    ...reel,
    ouvrirStockage: () => stockage,
    // Le stockage en memoire est partage par tout le fichier : chaque test repart d'un telephone vide.
    viderStockageEssai: () => stockage.vider(),
    // Acces brut pour SEMER un journal dans les tests (reprise refusee, phase 1 SMART FIELD).
    stockageBrut: stockage,
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
  return render(<MemoryRouter><EnregistrementRoulagePage /></MemoryRouter>);
}

async function demarrer() {
  fireEvent.click(screen.getByRole("button", { name: /Démarrer l'enregistrement/ }));
  await screen.findByText("Enregistrement en cours");
}

beforeEach(async () => {
  await (await import("../lib/roulageHote") as unknown as { viderStockageEssai: () => Promise<void> }).viderStockageEssai();
  h.posts.length = 0;
  h.reponsePush = { resultats: [{ statut: "SYNCHRONISE" }] };
  h.suivi.ok = null; h.suivi.err = null;
  h.referentiels = structuredClone(REFERENTIELS_ESSAI);
  h.referentielsEchec = false;
  h.missions = structuredClone(MISSIONS_ESSAI);
  h.missionsEchec = false;
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
    expect(screen.queryByText("Terminée, à envoyer")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Le clore à l'instant de l'arrêt/ }));
    expect(await screen.findByText("Terminée, à envoyer")).toBeInTheDocument();
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
    await screen.findByText("Terminée, à envoyer");
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
    fireEvent.click(screen.getByRole("button", { name: /(Envoyer|Renvoyer) la session/ }));
    expect(await screen.findByText("Session enregistrée sur le serveur.")).toBeInTheDocument();
    expect(h.posts.map((p) => p.url)).toEqual(["/v2/devices", "/v2/sync/push"]);
    const push = h.posts[1].corps as { appareilId: string; operations: { entityType: string; operation: string; payload: { points: unknown[]; versionContrat: number } }[] };
    expect(push.appareilId).toBe("appareil-1");
    expect(push.operations).toHaveLength(1);
    expect(push.operations[0]).toMatchObject({ entityType: "SessionRoulage", operation: "CREATE" });
    expect(push.operations[0].payload.points).toHaveLength(5);
    expect(push.operations[0].payload.versionContrat).toBe(1);
  });

  it("un rejeu est dit comme tel : rien n'est duplique", async () => {
    h.reponsePush = { resultats: [{ statut: "REJOUEE" }] };
    await terminerSession();
    fireEvent.click(screen.getByRole("button", { name: /(Envoyer|Renvoyer) la session/ }));
    expect(await screen.findByText(/déjà enregistrée sur le serveur : rien n'a été dupliqué/)).toBeInTheDocument();
  });

  it("un refus du serveur est rendu avec son motif, et la session reste sur le telephone", async () => {
    h.reponsePush = { resultats: [{ statut: "REJETE", motif: "HORS_TERRITOIRE" }] };
    await terminerSession();
    fireEvent.click(screen.getByRole("button", { name: /(Envoyer|Renvoyer) la session/ }));
    const msg = await screen.findByText(/Refusée par le serveur \(HORS_TERRITOIRE\)/);
    expect(msg).toHaveTextContent(/reste sur ce téléphone/);
    expect(screen.getByRole("button", { name: /(Envoyer|Renvoyer) la session/ })).toBeEnabled();
  });

  it("zero violation d'accessibilite en fin de session", async () => {
    await terminerSession();
    expect(await violationsAccessibilite(document.body)).toEqual([]);
  });
});

// ------------------------------------------------------------------ qualification par segment et mission

type PayloadEnvoye = { missionId: string | null; evenements: { code: string; statut: string; qualification: Record<string, string> | null }[] };

/** La charge de la derniere session envoyee. */
function chargeEnvoyee(): PayloadEnvoye {
  const push = h.posts.filter((p) => p.url === "/v2/sync/push").at(-1);
  if (!push) throw new Error("rien n'a ete envoye");
  return (push.corps as { operations: { payload: PayloadEnvoye }[] }).operations[0].payload;
}

const choisir = (libelle: string, code: string) => fireEvent.change(screen.getByLabelText(libelle), { target: { value: code } });

async function demarrerAvecListes() {
  installerGeolocalisation();
  const rendu = rendre();
  await demarrer();
  await screen.findByRole("option", { name: "Revêtement essai un" });
  return rendu;
}

async function arreterEtEnvoyer() {
  fireEvent.click(screen.getByRole("button", { name: /Arrêter/ }));
  await screen.findByText("Terminée, à envoyer");
  fireEvent.click(screen.getByRole("button", { name: /(Envoyer|Renvoyer) la session/ }));
  await screen.findByText(/Session enregistrée|Refusée par le serveur|Pas confirmée/);
}

describe("qualification d'un segment", () => {
  it("les trois listes ne proposent QUE les valeurs actives du serveur, avec 'Non relevé' en premier et aucune valeur choisie", async () => {
    await demarrerAvecListes();
    const revetement = screen.getByLabelText("Revêtement") as HTMLSelectElement;
    expect(revetement.value).toBe("");
    expect(Array.from(revetement.options).map((o) => o.textContent)).toEqual(["Non relevé", "Revêtement essai un"]);
    expect(Array.from((screen.getByLabelText("État de chaussée") as HTMLSelectElement).options).map((o) => o.value)).toEqual(["", "E_UN", "E_DEUX"]);
    expect((screen.getByLabelText("Praticabilité") as HTMLSelectElement).value).toBe("");
    expect(screen.getByLabelText("Praticabilité")).toBeEnabled();
  });

  it("qualification choisie AVANT le debut : elle part dans l'evenement envoye, avec les codes du serveur", async () => {
    await demarrerAvecListes();
    for (let s = 0; s < 3; s += 1) emettre(s);
    choisir("Revêtement", "R_UN");
    choisir("État de chaussée", "E_DEUX");
    fireEvent.click(screen.getByRole("button", { name: "Début d'un segment" }));
    expect(screen.getByText(/Qualification enregistrée pour ce segment : Revêtement essai un, État essai deux/)).toBeInTheDocument();
    for (let s = 3; s < 9; s += 1) emettre(s);
    fireEvent.click(screen.getByRole("button", { name: "Fin du segment" }));
    await arreterEtEnvoyer();
    expect(chargeEnvoyee().evenements).toEqual([expect.objectContaining({ code: "SEGMENT", statut: "CLOS", qualification: { revetement: "R_UN", etat: "E_DEUX" } })]);
  });

  it("qualification choisie A LA FIN du segment (segment ouvert sans qualification) : elle qualifie CE segment", async () => {
    await demarrerAvecListes();
    for (let s = 0; s < 3; s += 1) emettre(s);
    fireEvent.click(screen.getByRole("button", { name: "Début d'un segment" }));
    expect(screen.getByText(/Qualification enregistrée pour ce segment : non qualifié/)).toBeInTheDocument();
    for (let s = 3; s < 9; s += 1) emettre(s);
    choisir("Praticabilité", "P_UN");
    expect(screen.getByText(/Qualification enregistrée pour ce segment : Praticabilité essai un/)).toBeInTheDocument();
    choisir("État de chaussée", "E_UN");
    fireEvent.click(screen.getByRole("button", { name: "Fin du segment" }));
    await arreterEtEnvoyer();
    expect(chargeEnvoyee().evenements[0]).toMatchObject({ statut: "CLOS", qualification: { etat: "E_UN", praticabilite: "P_UN" } });
  });

  it("remettre un champ sur 'Non relevé' efface cette part : aucune valeur ne reste", async () => {
    await demarrerAvecListes();
    for (let s = 0; s < 3; s += 1) emettre(s);
    choisir("État de chaussée", "E_UN");
    fireEvent.click(screen.getByRole("button", { name: "Début d'un segment" }));
    choisir("État de chaussée", "");
    for (let s = 3; s < 9; s += 1) emettre(s);
    fireEvent.click(screen.getByRole("button", { name: "Fin du segment" }));
    await arreterEtEnvoyer();
    expect(chargeEnvoyee().evenements[0].qualification).toBeNull();
  });

  it("un segment clos SANS qualification est signale : le serveur n'en tirera aucune portion", async () => {
    await demarrerAvecListes();
    for (let s = 0; s < 3; s += 1) emettre(s);
    fireEvent.click(screen.getByRole("button", { name: "Début d'un segment" }));
    for (let s = 3; s < 9; s += 1) emettre(s);
    fireEvent.click(screen.getByRole("button", { name: "Fin du segment" }));
    expect(screen.getByText(/1 segment\(s\) clos sans qualification : le serveur n'en tirera aucune portion/)).toBeInTheDocument();
    await arreterEtEnvoyer();
    expect(chargeEnvoyee().evenements[0].qualification).toBeNull();
  });

  it("la qualification NE SE REPORTE PAS sur le segment suivant : les listes reviennent sur 'Non relevé'", async () => {
    await demarrerAvecListes();
    for (let s = 0; s < 3; s += 1) emettre(s);
    choisir("Revêtement", "R_UN");
    fireEvent.click(screen.getByRole("button", { name: "Début d'un segment" }));
    for (let s = 3; s < 9; s += 1) emettre(s);
    fireEvent.click(screen.getByRole("button", { name: "Fin du segment" }));
    expect((screen.getByLabelText("Revêtement") as HTMLSelectElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Début d'un segment" }));
    for (let s = 9; s < 15; s += 1) emettre(s);
    fireEvent.click(screen.getByRole("button", { name: "Fin du segment" }));
    await arreterEtEnvoyer();
    expect(chargeEnvoyee().evenements.map((e) => e.qualification)).toEqual([{ revetement: "R_UN" }, null]);
  });

  it("la praticabilite reste DESACTIVEE quand le serveur n'a pas defini son vocabulaire, et le dit", async () => {
    h.referentiels = { ...structuredClone(REFERENTIELS_ESSAI), praticabilites: [], praticabiliteNonDefinie: true };
    await demarrerAvecListes();
    expect(screen.getByLabelText("Praticabilité")).toBeDisabled();
    expect(screen.getByText(/Vocabulaire non défini par AGEROUTE : ce champ reste indisponible, et aucune valeur n'a été inventée/)).toBeInTheDocument();
    expect(Array.from((screen.getByLabelText("Praticabilité") as HTMLSelectElement).options).map((o) => o.value)).toEqual([""]);
  });

  it("sans vocabulaire (serveur injoignable, aucune copie) : listes desactivees, message clair, le segment s'enregistre sans qualification", async () => {
    h.referentielsEchec = true;
    installerGeolocalisation();
    rendre();
    await demarrer();
    expect(await screen.findByText(/vocabulaires du serveur n'ont pas pu être chargés et aucune copie n'est gardée/)).toBeInTheDocument();
    expect(screen.getByLabelText("Revêtement")).toBeDisabled();
    expect(screen.getByLabelText("État de chaussée")).toBeDisabled();
    for (let s = 0; s < 3; s += 1) emettre(s);
    fireEvent.click(screen.getByRole("button", { name: "Début d'un segment" }));
    for (let s = 3; s < 9; s += 1) emettre(s);
    fireEvent.click(screen.getByRole("button", { name: "Fin du segment" }));
    await arreterEtEnvoyer();
    expect(chargeEnvoyee().evenements[0].qualification).toBeNull();
  });

  it("une copie des vocabulaires gardee par un chargement precedent sert hors ligne, datee, sans rien inventer", async () => {
    installerGeolocalisation();
    const premier = rendre();
    await demarrer();
    await screen.findByRole("option", { name: "Revêtement essai un" });
    premier.unmount();
    h.referentielsEchec = true;
    rendre();
    fireEvent.click(await screen.findByRole("button", { name: /Recommencer/ }));
    await screen.findByRole("button", { name: /Démarrer l'enregistrement/ });
    await demarrer();
    expect(await screen.findByText(/Listes gardées sur ce téléphone depuis le/)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "État essai un" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Revêtement retiré" })).not.toBeInTheDocument();
  });

  it("un segment ouvert EMPECHE toujours l'arret, meme qualifie : le choix clore ou abandonner reste offert", async () => {
    await demarrerAvecListes();
    for (let s = 0; s < 3; s += 1) emettre(s);
    choisir("État de chaussée", "E_UN");
    fireEvent.click(screen.getByRole("button", { name: "Début d'un segment" }));
    for (let s = 3; s < 9; s += 1) emettre(s);
    fireEvent.click(screen.getByRole("button", { name: /Arrêter/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Un segment est encore ouvert/);
    expect(screen.queryByText("Terminée, à envoyer")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Le clore à l'instant de l'arrêt/ }));
    await screen.findByText("Terminée, à envoyer");
    fireEvent.click(screen.getByRole("button", { name: /(Envoyer|Renvoyer) la session/ }));
    await screen.findByText("Session enregistrée sur le serveur.");
    expect(chargeEnvoyee().evenements[0]).toMatchObject({ statut: "CLOS_PAR_ARRET", qualification: { etat: "E_UN" } });
  });

  it("apres un redemarrage de la page, le segment ouvert garde sa qualification et la mission choisie est retrouvee", async () => {
    installerGeolocalisation();
    const premier = rendre();
    await demarrer();
    await screen.findByRole("option", { name: /M-MIENNE/ });
    for (let s = 0; s < 3; s += 1) emettre(s);
    choisir("Mission (facultative)", MISSIONS_ESSAI[0].id);
    choisir("Revêtement", "R_UN");
    fireEvent.click(screen.getByRole("button", { name: "Début d'un segment" }));
    for (let s = 3; s < 6; s += 1) emettre(s);
    premier.unmount();

    rendre();
    expect(await screen.findByRole("heading", { name: /Une session a été retrouvée/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Reprendre l'enregistrement/ }));
    await screen.findByText("Enregistrement en cours");
    expect((screen.getByLabelText("Revêtement") as HTMLSelectElement).value).toBe("R_UN");
    expect((screen.getByLabelText("Mission (facultative)") as HTMLSelectElement).value).toBe(MISSIONS_ESSAI[0].id);
    expect(screen.getByRole("button", { name: "Fin du segment" })).toBeInTheDocument();
  });

  it("zero violation d'accessibilite : listes de qualification, segment ouvert, mission, fin de session", async () => {
    const { container } = await demarrerAvecListes();
    for (let s = 0; s < 3; s += 1) emettre(s);
    expect(await violationsAccessibilite(container)).toEqual([]);
    choisir("Revêtement", "R_UN");
    fireEvent.click(screen.getByRole("button", { name: "Début d'un segment" }));
    for (let s = 3; s < 9; s += 1) emettre(s);
    expect(await violationsAccessibilite(container)).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Fin du segment" }));
    expect(await violationsAccessibilite(container)).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /Arrêter/ }));
    await screen.findByText("Terminée, à envoyer");
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("zero violation d'accessibilite avec la praticabilite desactivee et les vocabulaires absents", async () => {
    h.referentielsEchec = true;
    installerGeolocalisation();
    const { container } = rendre();
    await demarrer();
    await screen.findByText(/vocabulaires du serveur n'ont pas pu être chargés/);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

describe("lien a une mission", () => {
  it("ne propose QUE les missions assignees a l'agent ou creees par lui, jamais une annulee ni celle d'un autre", async () => {
    await demarrerAvecListes();
    const liste = screen.getByLabelText("Mission (facultative)") as HTMLSelectElement;
    await screen.findByRole("option", { name: /M-MIENNE/ });
    expect(Array.from(liste.options).map((o) => o.textContent)).toEqual(["Aucune mission", "M-MIENNE : Patrouille assignée (en cours)"]);
    expect(liste.value).toBe("");
  });

  it("la mission choisie est transmise comme missionId de la charge", async () => {
    await demarrerAvecListes();
    await screen.findByRole("option", { name: /M-MIENNE/ });
    for (let s = 0; s < 5; s += 1) emettre(s);
    choisir("Mission (facultative)", MISSIONS_ESSAI[0].id);
    await arreterEtEnvoyer();
    expect(chargeEnvoyee().missionId).toBe(MISSIONS_ESSAI[0].id);
  });

  it("sans choix de mission, la charge porte missionId nul (le lien est facultatif)", async () => {
    await demarrerAvecListes();
    for (let s = 0; s < 5; s += 1) emettre(s);
    await arreterEtEnvoyer();
    expect(chargeEnvoyee().missionId).toBeNull();
  });

  it("un refus MISSION_NON_AUTORISEE est rendu avec son motif, et la mission peut etre retiree pour renvoyer", async () => {
    h.reponsePush = { resultats: [{ statut: "REJETE", motif: "MISSION_NON_AUTORISEE" }] };
    await demarrerAvecListes();
    await screen.findByRole("option", { name: /M-MIENNE/ });
    for (let s = 0; s < 5; s += 1) emettre(s);
    choisir("Mission (facultative)", MISSIONS_ESSAI[0].id);
    await arreterEtEnvoyer();
    expect(screen.getByText(/Refusée par le serveur \(MISSION_NON_AUTORISEE\)/)).toBeInTheDocument();
    expect(screen.getByLabelText("Mission (facultative)")).toBeEnabled();
    h.reponsePush = { resultats: [{ statut: "SYNCHRONISE" }] };
    choisir("Mission (facultative)", "");
    fireEvent.click(screen.getByRole("button", { name: /(Envoyer|Renvoyer) la session/ }));
    await screen.findByText("Session enregistrée sur le serveur.");
    const pushes = h.posts.filter((p) => p.url === "/v2/sync/push").map((p) => (p.corps as { operations: { payload: PayloadEnvoye }[] }).operations[0].payload.missionId);
    expect(pushes).toEqual([MISSIONS_ESSAI[0].id, null]);
  });

  it("missions indisponibles : le lien est absent, l'ecran le dit, l'enregistrement et l'envoi continuent", async () => {
    h.missionsEchec = true;
    installerGeolocalisation();
    rendre();
    await demarrer();
    expect(await screen.findByText(/Missions indisponibles .* la session partira sans lien à une mission/)).toBeInTheDocument();
    for (let s = 0; s < 5; s += 1) emettre(s);
    await arreterEtEnvoyer();
    expect(chargeEnvoyee().missionId).toBeNull();
  });

  it("aucune mission a soi : message clair, aucune option inventee", async () => {
    h.missions = [MISSIONS_ESSAI[1]];
    installerGeolocalisation();
    rendre();
    await demarrer();
    expect(await screen.findByText(/Aucune mission assignée à votre compte ou créée par vous/)).toBeInTheDocument();
    expect(Array.from((screen.getByLabelText("Mission (facultative)") as HTMLSelectElement).options).map((o) => o.value)).toEqual([""]);
  });
});

describe("session vide (aucune position)", () => {
  it("arretee sans position : explication claire, jamais presentee comme un releve, ni GPX ni envoi", async () => {
    installerGeolocalisation();
    rendre();
    await demarrer();
    fireEvent.click(screen.getByRole("button", { name: /Arrêter/ }));
    expect(await screen.findByText("Terminée sans aucune position")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/Aucune position valide n'a été enregistrée/);
    expect(screen.getByRole("alert")).toHaveTextContent(/Ce n'est pas un relevé/);
    expect(screen.queryByRole("button", { name: /Télécharger le GPX/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /(Envoyer|Renvoyer) la session/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Résumé du relevé")).not.toBeInTheDocument();
    expect(h.posts).toHaveLength(0);
  });

  it("« Recommencer » repart d'une preparation propre, sans rien de la session vide", async () => {
    installerGeolocalisation();
    rendre();
    await demarrer();
    fireEvent.click(screen.getByRole("button", { name: /Arrêter/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Recommencer/ }));
    expect(await screen.findByRole("button", { name: /Démarrer l'enregistrement/ })).toBeInTheDocument();
  });

  it("une session vide retrouvee apres rechargement est dite vide, avec « Recommencer » et sans reprise ni envoi", async () => {
    installerGeolocalisation();
    const premier = rendre();
    await demarrer();
    premier.unmount();
    rendre();
    const carte = await screen.findByRole("region", { name: /Une session a été retrouvée/ });
    expect(carte).toHaveTextContent(/aucune position/);
    expect(screen.getByRole("button", { name: /Recommencer/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reprendre l'enregistrement/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Supprimer cette session/ })).not.toBeInTheDocument();
  });
});

describe("suppression et envoi confirme", () => {
  async function terminer() {
    installerGeolocalisation();
    const rendu = rendre();
    await demarrer();
    for (let s = 0; s < 5; s += 1) emettre(s);
    fireEvent.click(screen.getByRole("button", { name: /Arrêter/ }));
    await screen.findByText("Terminée, à envoyer");
    return rendu;
  }

  it("supprimer une session non envoyee demande une confirmation explicite : « Non » la garde", async () => {
    await terminer();
    fireEvent.click(screen.getByRole("button", { name: /Supprimer sans envoyer/ }));
    const dialogue = await screen.findByRole("alertdialog");
    expect(dialogue).toHaveTextContent(/5 position\(s\) n'ont pas été confirmées par le serveur et seront perdues/);
    fireEvent.click(screen.getByRole("button", { name: /Non, la garder/ }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByText("Résumé du relevé")).toBeInTheDocument();
  });

  it("« Oui, supprimer » efface la session et revient a la preparation", async () => {
    await terminer();
    fireEvent.click(screen.getByRole("button", { name: /Supprimer sans envoyer/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Oui, supprimer/ }));
    expect(await screen.findByRole("button", { name: /Démarrer l'enregistrement/ })).toBeInTheDocument();
  });

  it("le resume donne distance, durees, positions, interruptions et qualite, et rappelle que la distance est estimee", async () => {
    await terminer();
    const resume = screen.getByRole("region", { name: /Résumé du relevé/ });
    expect(resume).toHaveTextContent(/Distance estimée/);
    expect(resume).toHaveTextContent(/Durée totale/);
    expect(resume).toHaveTextContent(/Durée effective d'enregistrement/);
    expect(resume).toHaveTextContent(/Positions valides\s*5/);
    expect(resume).toHaveTextContent(/Trace de bonne qualité/);
    expect(screen.getByText(/n'est pas une mesure exacte/)).toBeInTheDocument();
  });

  it("un envoi confirme est retenu : apres rechargement, la session est dite DEJA envoyee, plus « a envoyer »", async () => {
    const rendu = await terminer();
    fireEvent.click(screen.getByRole("button", { name: /(Envoyer|Renvoyer) la session/ }));
    await screen.findByText("Session enregistrée sur le serveur.");
    expect(screen.getByText("Envoyée et confirmée par le serveur")).toBeInTheDocument();
    rendu.unmount();
    rendre();
    const carte = await screen.findByRole("region", { name: /Une session a été retrouvée/ });
    expect(carte).toHaveTextContent(/déjà confirmée par le serveur/);
    expect(carte).not.toHaveTextContent(/pas encore envoyée/);
    expect(screen.getByRole("button", { name: /Nouveau relevé/ })).toBeInTheDocument();
  });

  it("une session NON confirmee reste « pas encore envoyee » apres rechargement, et se supprime avec confirmation", async () => {
    h.reponsePush = { resultats: [{ statut: "REJETE", motif: "HORS_TERRITOIRE" }] };
    const rendu = await terminer();
    fireEvent.click(screen.getByRole("button", { name: /(Envoyer|Renvoyer) la session/ }));
    await screen.findByText(/Refusée par le serveur/);
    rendu.unmount();
    rendre();
    const carte = await screen.findByRole("region", { name: /Une session a été retrouvée/ });
    expect(carte).toHaveTextContent(/pas encore envoyée/);
    fireEvent.click(screen.getByRole("button", { name: /Supprimer cette session/ }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(/Cette action est définitive/);
  });
});

describe("carte, etats et preparation", () => {
  it("la carte recoit la trace et la position ; un trou de signal reste deux segments, jamais relies", async () => {
    installerGeolocalisation();
    rendre();
    await demarrer();
    for (let s = 0; s < 3; s += 1) emettre(s);
    expect(screen.getByTestId("carte-trace")).toHaveAttribute("data-segments", "1");
    // 120 s sans position : bien au-dela de la coupure de segment (30 s).
    for (let s = 120; s < 123; s += 1) emettre(s);
    const carte = screen.getByTestId("carte-trace");
    expect(carte).toHaveAttribute("data-segments", "2");
    expect(carte).toHaveAttribute("data-points", "6");
    expect(carte.getAttribute("data-position")).toMatch(/^9\.6\d+,-13\.\d+$/);
  });

  it("affiche vitesse GPS, precision, derniere position et les etats GPS / reseau / conservation", async () => {
    installerGeolocalisation();
    rendre();
    await demarrer();
    emettre(0);
    emettre(1);
    expect(screen.getByText("Vitesse GPS").nextSibling).toHaveTextContent("36 km/h");
    expect(screen.getByText("Précision actuelle").nextSibling).toHaveTextContent("8 m");
    expect(screen.getByText("Dernière position valide").nextSibling).toHaveTextContent(/à l'instant/);
    const etats = screen.getByRole("list", { name: /États du GPS, du réseau et de la conservation/ });
    expect(etats).toHaveTextContent(/GPS : signal reçu/);
    expect(etats).toHaveTextContent(/Réseau : en ligne/);
    expect(etats).toHaveTextContent(/Conservation : /);
  });

  it("une vitesse non communiquee n'est pas inventee", async () => {
    installerGeolocalisation();
    rendre();
    await demarrer();
    act(() => { h.suivi.ok?.({ timestamp: T0, coords: { latitude: 9.64, longitude: -13.6, accuracy: 8, speed: null, heading: null, altitude: null } }); });
    expect(screen.getByText("Vitesse GPS").nextSibling).toHaveTextContent("non communiquée");
  });

  it("le GPS perdu change l'etat affiche, sans effacer la trace deja collectee", async () => {
    installerGeolocalisation();
    rendre();
    await demarrer();
    for (let s = 0; s < 3; s += 1) emettre(s);
    act(() => { h.suivi.err?.({ code: 2 }); });
    expect(await screen.findByText("Signal GPS interrompu")).toBeInTheDocument();
    expect(screen.getByTestId("carte-trace")).toHaveAttribute("data-points", "3");
  });

  it("la preparation propose intitule, profil de precision et controles avant depart ; le profil strict part avec la session", async () => {
    installerGeolocalisation();
    rendre();
    expect(screen.getByRole("region", { name: /Préparer le relevé/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Intitulé (facultatif)"), { target: { value: "RN1 Coyah - Kindia" } });
    fireEvent.click(screen.getByRole("radio", { name: /Strict/ }));
    expect(screen.getByLabelText("Contrôles avant le départ")).toBeInTheDocument();
    await demarrer();
    expect(screen.getByText("RN1 Coyah - Kindia")).toBeInTheDocument();
    for (let s = 0; s < 3; s += 1) emettre(s);
    fireEvent.click(screen.getByRole("button", { name: /Arrêter/ }));
    await screen.findByText("Terminée, à envoyer");
    fireEvent.click(screen.getByRole("button", { name: /(Envoyer|Renvoyer) la session/ }));
    await screen.findByText("Session enregistrée sur le serveur.");
    const push = h.posts[h.posts.length - 1].corps as { operations: { payload: { parametres: { precisionMaxM: number } } }[] };
    expect(push.operations[0].payload.parametres.precisionMaxM).toBe(20);
  });
});

describe("hors ligne", () => {
  it("un envoi qui echoue faute de reseau garde la session et est rejoue SEUL au retour du reseau, une fois", async () => {
    installerGeolocalisation();
    rendre();
    await demarrer();
    for (let s = 0; s < 4; s += 1) emettre(s);
    fireEvent.click(screen.getByRole("button", { name: /Arrêter/ }));
    await screen.findByText("Terminée, à envoyer");
    const { api } = await import("../lib/api");
    vi.mocked(api.post).mockRejectedValueOnce(new Error("reseau"));
    act(() => { window.dispatchEvent(new Event("offline")); });
    fireEvent.click(screen.getByRole("button", { name: /(Envoyer|Renvoyer) la session/ }));
    expect(await screen.findByText(/Envoi impossible \(réseau\)/)).toBeInTheDocument();
    expect(screen.getByText("Envoi non confirmé")).toBeInTheDocument();
    expect(screen.getByText(/Un nouvel envoi sera tenté automatiquement au retour du réseau/)).toBeInTheDocument();
    expect(h.posts.filter((p) => p.url === "/v2/sync/push")).toHaveLength(0);
    act(() => { window.dispatchEvent(new Event("online")); });
    expect(await screen.findByText("Session enregistrée sur le serveur.")).toBeInTheDocument();
    expect(h.posts.filter((p) => p.url === "/v2/sync/push")).toHaveLength(1);
  });
});
