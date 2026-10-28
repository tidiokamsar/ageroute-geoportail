import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axios, { AxiosError } from "axios";
import { api } from "../lib/api";
import { AuthProvider, useAuth } from "../lib/auth";
import { fermerCompte } from "../lib/compteCourant";
import { signalerActivite, declarerRoulageActif } from "./activiteExterne";
import { stockageEnMemoire } from "./coffreSession";
import {
  brancherNavigateur, ControleurSession, SessionLocaleProvider, useSessionLocale, useSessionLocaleOptionnelle,
  type ServeurSession, type UtilisateurServeur,
} from "./useSessionLocale";

/**
 * Colle navigateur de l'hote : evenements DOM, pont d'activite des ecrans, fournisseur React, AuthProvider. La logique du
 * noyau et du coffre est eprouvee (vrai coffre, faux minuteurs) dans useSessionLocale.test.ts.
 */

function fauxControleur() {
  return {
    signalerActivite: vi.fn(), signalerActiviteExterne: vi.fn(), signalerArrierePlan: vi.fn(), signalerPremierPlan: vi.fn(),
    reseauPerdu: vi.fn(async () => undefined), reseauRevenu: vi.fn(async () => undefined),
  };
}
const surControleur = (c: ReturnType<typeof fauxControleur>) => c as unknown as ControleurSession;

function visibilite(etat: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => etat });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); fermerCompte(); declarerRoulageActif(false); visibilite("visible"); });

describe("brancherNavigateur", () => {
  it("pointeur, clavier, tactile et defilement comptent comme une activite", () => {
    const c = fauxControleur();
    const stop = brancherNavigateur(surControleur(c));
    window.dispatchEvent(new Event("pointerdown"));
    window.dispatchEvent(new Event("keydown"));
    window.dispatchEvent(new Event("touchstart"));
    document.dispatchEvent(new Event("scroll"));
    expect(c.signalerActivite).toHaveBeenCalledTimes(4);
    stop();
  });

  it("le defilement d'un element interne est capte aussi (le scroll ne remonte pas)", () => {
    const c = fauxControleur();
    const stop = brancherNavigateur(surControleur(c));
    const zone = document.createElement("div");
    document.body.appendChild(zone);
    zone.dispatchEvent(new Event("scroll"));
    expect(c.signalerActivite).toHaveBeenCalledTimes(1);
    zone.remove();
    stop();
  });

  it("le pont des ecrans (releve de roulage) arrive au controleur, y compris quand un releve est declare actif", () => {
    const c = fauxControleur();
    const stop = brancherNavigateur(surControleur(c));
    signalerActivite();
    // Le pont n'est PAS une interaction : evenement distinct (plafonne, sans effet sur l'arriere-plan).
    expect(c.signalerActiviteExterne).toHaveBeenCalledTimes(1);
    declarerRoulageActif(true);
    expect(c.signalerActiviteExterne).toHaveBeenCalledTimes(2);
    expect(c.signalerActivite).not.toHaveBeenCalled();
    stop();
  });

  it("arriere-plan et premier plan suivent visibilitychange", () => {
    const c = fauxControleur();
    const stop = brancherNavigateur(surControleur(c));
    visibilite("hidden");
    expect(c.signalerArrierePlan).toHaveBeenCalledTimes(1);
    visibilite("visible");
    expect(c.signalerPremierPlan).toHaveBeenCalledTimes(1);
    stop();
  });

  it("offline / online : le reseau perdu est declare par l'evenement, le retour declenche la reconnexion", () => {
    const c = fauxControleur();
    const stop = brancherNavigateur(surControleur(c));
    window.dispatchEvent(new Event("offline"));
    expect(c.reseauPerdu).toHaveBeenCalledWith("EVENEMENT");
    window.dispatchEvent(new Event("online"));
    expect(c.reseauRevenu).toHaveBeenCalledTimes(1);
    stop();
  });

  it("une fois debranche, plus rien n'arrive au controleur", () => {
    const c = fauxControleur();
    brancherNavigateur(surControleur(c))();
    window.dispatchEvent(new Event("pointerdown"));
    window.dispatchEvent(new Event("offline"));
    visibilite("hidden");
    signalerActivite();
    expect(c.signalerActivite).not.toHaveBeenCalled();
    expect(c.signalerActiviteExterne).not.toHaveBeenCalled();
    expect(c.reseauPerdu).not.toHaveBeenCalled();
    expect(c.signalerArrierePlan).not.toHaveBeenCalled();
  });
});

describe("fournisseur et crochets", () => {
  function Lecteur() {
    const s = useSessionLocaleOptionnelle();
    return <p>{s ? `etat ${s.session.etat}` : "sans fournisseur"}</p>;
  }
  function Strict() { useSessionLocale(); return null; }

  it("hors fournisseur : le crochet optionnel rend null, le crochet strict leve", () => {
    render(<Lecteur />);
    expect(screen.getByText("sans fournisseur")).toBeInTheDocument();
    cleanup();
    const erreur = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Strict />)).toThrow(/SessionLocaleProvider/);
    erreur.mockRestore();
  });
});

// ---------------------------------------------------------------------------------------------------

const agent: UtilisateurServeur = {
  id: "agent-A", email: "a@ageroute.test", nomComplet: "Agent A", role: "INSPECTEUR", actif: true,
  modulesAutorises: [], peutDeleguerValidation: false, createdAt: "2026-01-01T00:00:00.000Z", regions: [1], perimetreNational: false,
};

function serveur(): ServeurSession & { deconnexions: boolean[] } {
  const deconnexions: boolean[] = [];
  return {
    deconnexions,
    connexion: vi.fn(async () => ({ accessToken: "jeton", user: agent })),
    verifierDeuxFacteurs: vi.fn(async () => ({ accessToken: "jeton", user: agent })),
    moi: vi.fn(async () => agent),
    deconnexion: vi.fn(async (tous: boolean) => { deconnexions.push(tous); return true; }),
    rafraichirAuDemarrage: vi.fn(async () => ({ etat: "RESEAU_COUPE" as const })),
    sonder: vi.fn(async () => ({ etat: "RESEAU_COUPE" as const })),
    envoyerEvenements: vi.fn(async () => undefined),
    poserJeton: vi.fn(), appareilServeurId: () => null,
  };
}

function controleur(s: ServeurSession, marqueur = false) {
  return new ControleurSession({
    serveur: s, stockageCoffre: stockageEnMemoire(), idAppareilLocal: () => "tel-1", maintenant: () => Date.now(),
    marqueur: { present: () => marqueur, poser: () => undefined, purger: () => undefined },
    sha256: async (o) => { const r = new Uint8Array(32); o.forEach((b, i) => { r[i % 32] = (r[i % 32] * 31 + b) & 0xff; }); return r; },
    optionsCoffre: { iterations: 1000, iterationsDeTest: true }, decompteFile: async () => ({ enAttente: 0, enErreur: 0, abandonnees: 0, enConflit: 0, photosEnFile: 0, relevesNonConfirmes: 0 }),
    retourReseauMs: 0,
  });
}

function Sonde() {
  const a = useAuth();
  return (
    <div>
      <p>{a.loading ? "chargement" : "pret"}</p>
      <p data-testid="user">{a.user?.id ?? "aucun"}</p>
      <button onClick={() => void a.login("a@ageroute.test", "pw")}>connexion</button>
      <button onClick={() => void a.logout()}>deconnexion</button>
      <button onClick={() => void a.logoutAll()}>tous</button>
    </div>
  );
}

describe("AuthProvider", () => {
  beforeEach(() => { vi.stubGlobal("matchMedia", undefined); });

  it("charge puis est pret ; connexion : l'utilisateur est celui du serveur ; deconnexion : il disparait", async () => {
    const s = serveur();
    render(<AuthProvider controleur={controleur(s)}><Sonde /></AuthProvider>);
    await waitFor(() => expect(screen.getByText("pret")).toBeInTheDocument());
    expect(screen.getByTestId("user")).toHaveTextContent("aucun");
    const u = userEvent.setup({ delay: null });
    await u.click(screen.getByRole("button", { name: "connexion" }));
    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("agent-A"));
    expect(s.poserJeton).toHaveBeenCalledWith("jeton");
    await u.click(screen.getByRole("button", { name: "deconnexion" }));
    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("aucun"));
    expect(s.deconnexions).toEqual([false]);
  });

  it("sous StrictMode (double montage), le demarrage n'est lance qu'une fois : un seul rafraichissement", async () => {
    const s = serveur();
    render(<StrictMode><AuthProvider controleur={controleur(s, true)}><Sonde /></AuthProvider></StrictMode>);
    await waitFor(() => expect(screen.getByText("pret")).toBeInTheDocument());
    expect(s.rafraichirAuDemarrage).toHaveBeenCalledTimes(1);
  });

  it("« tous les appareils » transmet la demande au serveur", async () => {
    const s = serveur();
    render(<AuthProvider controleur={controleur(s)}><Sonde /></AuthProvider>);
    await waitFor(() => expect(screen.getByText("pret")).toBeInTheDocument());
    const u = userEvent.setup({ delay: null });
    await u.click(screen.getByRole("button", { name: "connexion" }));
    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("agent-A"));
    await u.click(screen.getByRole("button", { name: "tous" }));
    await waitFor(() => expect(s.deconnexions).toEqual([true]));
  });

  it("une requete qui echoue SANS reponse previent le controleur ; une erreur avec reponse, non", async () => {
    const c = controleur(serveur());
    const reseauPerdu = vi.spyOn(c, "reseauPerdu").mockResolvedValue(undefined);
    render(<AuthProvider controleur={c}><Sonde /></AuthProvider>);
    await waitFor(() => expect(screen.getByText("pret")).toBeInTheDocument());
    await expect(api.get("/x", { adapter: () => Promise.reject(new AxiosError("Network Error", "ERR_NETWORK")) })).rejects.toBeTruthy();
    expect(reseauPerdu).toHaveBeenCalledWith("REQUETE");
    reseauPerdu.mockClear();
    await expect(api.get("/x", {
      adapter: (config) => Promise.reject(new AxiosError("Bad", "ERR_BAD_RESPONSE", config, null, { status: 500, statusText: "", headers: {}, config, data: {} })),
    })).rejects.toBeTruthy();
    expect(reseauPerdu).not.toHaveBeenCalled();
  });

  it("l'intercepteur est retire au demontage (pas de fuite entre deux montages)", async () => {
    const c = controleur(serveur());
    const reseauPerdu = vi.spyOn(c, "reseauPerdu").mockResolvedValue(undefined);
    const { unmount } = render(<AuthProvider controleur={c}><Sonde /></AuthProvider>);
    await waitFor(() => expect(screen.getByText("pret")).toBeInTheDocument());
    unmount();
    await expect(api.get("/x", { adapter: () => Promise.reject(new AxiosError("Network Error", "ERR_NETWORK")) })).rejects.toBeTruthy();
    expect(reseauPerdu).not.toHaveBeenCalled();
  });

  it("l'issue de chaque rafraichissement reel arrive au controleur (ecouteur de api.ts)", async () => {
    const c = controleur(serveur());
    const issue = vi.spyOn(c, "surRafraichissement").mockResolvedValue(undefined);
    render(<AuthProvider controleur={c}><Sonde /></AuthProvider>);
    await waitFor(() => expect(screen.getByText("pret")).toBeInTheDocument());
    vi.spyOn(axios, "post").mockRejectedValueOnce(new AxiosError("Network Error", "ERR_NETWORK"));
    const { rafraichirJeton } = await import("../lib/api");
    const r = await rafraichirJeton("perime");
    expect(r.etat).toBe("RESEAU_COUPE");
    expect(issue).toHaveBeenCalledWith({ etat: "RESEAU_COUPE" });
  });

  it("le fournisseur de session est partage avec les enfants", async () => {
    function Enfant() { const { session } = useSessionLocale(); return <p>{session.demarre ? "demarre" : "en cours"}</p>; }
    render(<AuthProvider controleur={controleur(serveur())}><Enfant /></AuthProvider>);
    await waitFor(() => expect(screen.getByText("demarre")).toBeInTheDocument());
  });

  it("SessionLocaleProvider fournit le controleur donne", () => {
    const c = controleur(serveur());
    function Enfant() { const { controleur: x } = useSessionLocale(); return <p>{x === c ? "le meme" : "autre"}</p>; }
    render(<SessionLocaleProvider controleur={c}><Enfant /></SessionLocaleProvider>);
    expect(screen.getByText("le meme")).toBeInTheDocument();
  });
});
