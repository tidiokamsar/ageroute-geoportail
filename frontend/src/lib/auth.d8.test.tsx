import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axios, { AxiosError } from "axios";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { AuthProvider, deconnexionJointeApresErreur, serveurReel, useAuth } from "./auth";
import { fermerCompte } from "./compteCourant";
import { stockageEnMemoire } from "../session/coffreSession";
import { ControleurSession, type ServeurSession, type UtilisateurServeur } from "../session/useSessionLocale";

/**
 * Chantier D8, defauts 2 et 3 (relecture independante) :
 *   - le cache React Query n'etait jamais vide : le compte B recevait les donnees de A, et si sa requete echouait elles restaient ;
 *   - un 5xx ou un 429 sur /auth/logout etait compte « serveur joint » : la session se fermait, le toast disait « Session fermee »,
 *     mais le cookie de rafraichissement restait valide.
 */

afterEach(() => { cleanup(); vi.restoreAllMocks(); fermerCompte(); });

function erreurHttp(statut: number) {
  return new AxiosError("x", "ERR_BAD_RESPONSE", undefined, undefined, { status: statut, statusText: "", data: {}, headers: {}, config: {} as never } as never);
}

describe("serveurReel().deconnexion : seul 2xx, 401 ou 403 est un serveur « joint »", () => {
  it.each([[502, false], [500, false], [503, false], [429, false], [400, false], [404, false], [401, true], [403, true]])(
    "POST /auth/logout repond %i : joint = %s", async (statut, attendu) => {
      vi.spyOn(api, "post").mockRejectedValue(erreurHttp(statut));
      expect(await serveurReel().deconnexion(false)).toBe(attendu);
    },
  );

  it("reseau coupe (aucune reponse) : pas joint ; delai depasse : pas joint ; erreur non reseau : pas joint", async () => {
    vi.spyOn(api, "post").mockRejectedValueOnce(new AxiosError("Network Error", "ERR_NETWORK"));
    expect(await serveurReel().deconnexion(false)).toBe(false);
    vi.spyOn(api, "post").mockRejectedValueOnce(new AxiosError("timeout", "ECONNABORTED"));
    expect(await serveurReel().deconnexion(true)).toBe(false);
    vi.spyOn(api, "post").mockRejectedValueOnce(new Error("autre"));
    expect(await serveurReel().deconnexion(false)).toBe(false);
  });

  it("2xx : joint, pour logout et logout-all", async () => {
    const post = vi.spyOn(api, "post").mockResolvedValue({ data: {} });
    expect(await serveurReel().deconnexion(false)).toBe(true);
    expect(await serveurReel().deconnexion(true)).toBe(true);
    expect(post.mock.calls.map((c) => c[0])).toEqual(["/auth/logout", "/auth/logout-all"]);
  });

  it("deconnexionJointeApresErreur ne conclut pas sur une valeur etrangere", () => {
    expect(deconnexionJointeApresErreur(undefined)).toBe(false);
    expect(deconnexionJointeApresErreur({ response: { status: 401 } })).toBe(false); // pas une erreur Axios
    expect(axios.isAxiosError(erreurHttp(401))).toBe(true);
  });
});

describe("AuthProvider : un 502 sur /auth/logout passe en deconnexion EN ATTENTE, pas en « Session fermee »", () => {
  const agent: UtilisateurServeur = {
    id: "agent-A", email: "a@x", nomComplet: "Agent A", role: "INSPECTEUR", actif: true, modulesAutorises: [],
    peutDeleguerValidation: false, createdAt: "2026-01-01T00:00:00.000Z", regions: [1], perimetreNational: false,
  };

  it("le controleur ne ferme pas la session et garde le marqueur quand le serveur n'a pas revoque le cookie", async () => {
    vi.stubGlobal("matchMedia", undefined);
    const serveur: ServeurSession = {
      connexion: async () => ({ accessToken: "j", user: agent }), verifierDeuxFacteurs: async () => ({ accessToken: "j", user: agent }),
      moi: async () => agent, rafraichirAuDemarrage: async () => ({ etat: "RESEAU_COUPE" }), sonder: async () => ({ etat: "RESEAU_COUPE" }),
      envoyerEvenements: async () => undefined, poserJeton: () => undefined, appareilServeurId: () => null,
      deconnexion: (tous) => { vi.spyOn(api, "post").mockRejectedValueOnce(erreurHttp(502)); return serveurReel().deconnexion(tous); },
    };
    const purger = vi.fn();
    const c = new ControleurSession({
      serveur, stockageCoffre: stockageEnMemoire(), idAppareilLocal: () => "tel-1", maintenant: () => Date.now(),
      marqueur: { present: () => true, poser: () => undefined, purger },
      sha256: async (o) => { const r = new Uint8Array(32); o.forEach((b, i) => { r[i % 32] = (r[i % 32] * 31 + b) & 0xff; }); return r; },
      optionsCoffre: { iterations: 1000, iterationsDeTest: true },
      decompteFile: async () => ({ enAttente: 0, enErreur: 0, abandonnees: 0, enConflit: 0, photosEnFile: 0, relevesNonConfirmes: 0 }),
      retourReseauMs: 0,
    });
    await c.demarrer();
    await c.connecter("a@x", "pw");
    await c.creerPin("Zx-91-pin");
    const decision = await c.deconnecter();
    expect(decision.deconnexionEnAttente).toBe(true);
    expect(decision.fermeSession).toBe(false);
    expect(decision.texte).not.toMatch(/^Session fermée/);
    expect(purger).not.toHaveBeenCalled(); // le cookie est encore valide : le marqueur qui permet de le rejouer reste
    expect(c.instantane().etat).toBe("HORS_LIGNE_VERROUILLE");
  });
});

// ---------------------------------------------------------------------------------------------------
describe("AuthProvider : le cache de requetes est vide a la sortie de session et au changement de compte", () => {
  const utilisateur = (id: string): UtilisateurServeur => ({
    id, email: `${id}@x`, nomComplet: id, role: "INSPECTEUR", actif: true, modulesAutorises: [],
    peutDeleguerValidation: false, createdAt: "2026-01-01T00:00:00.000Z", regions: [1], perimetreNational: false,
  });
  let courant = utilisateur("agent-A");

  function controleur() {
    const serveur: ServeurSession = {
      connexion: async (email) => { courant = utilisateur(email.startsWith("a") ? "agent-A" : "agent-B"); return { accessToken: "j", user: courant }; },
      verifierDeuxFacteurs: async () => ({ accessToken: "j", user: courant }),
      moi: async () => courant,
      deconnexion: async () => true,
      rafraichirAuDemarrage: async () => ({ etat: "RESEAU_COUPE" }), sonder: async () => ({ etat: "RESEAU_COUPE" }),
      envoyerEvenements: async () => undefined, poserJeton: () => undefined, appareilServeurId: () => null,
    };
    return new ControleurSession({
      serveur, stockageCoffre: stockageEnMemoire(), idAppareilLocal: () => "tel-1", maintenant: () => Date.now(),
      marqueur: { present: () => false, poser: () => undefined, purger: () => undefined },
      sha256: async (o) => { const r = new Uint8Array(32); o.forEach((b, i) => { r[i % 32] = (r[i % 32] * 31 + b) & 0xff; }); return r; },
      optionsCoffre: { iterations: 1000, iterationsDeTest: true },
      decompteFile: async () => ({ enAttente: 0, enErreur: 0, abandonnees: 0, enConflit: 0, photosEnFile: 0, relevesNonConfirmes: 0 }),
      retourReseauMs: 0,
    });
  }

  beforeEach(() => { vi.stubGlobal("matchMedia", undefined); courant = utilisateur("agent-A"); });

  // Meme cle pour les deux comptes : c'est l'attaque (les cles de l'application ne portent pas le compte).
  function Donnees() {
    const { user } = useAuth();
    const q = useQuery({
      queryKey: ["observations-terrain"],
      retry: false,
      queryFn: async () => {
        if (user?.id === "agent-B") throw new Error("403 hors perimetre / hors ligne");
        return ["saisie-secrete-de-A"];
      },
    });
    return <p data-testid="sortie">{JSON.stringify({ data: q.data ?? null, erreur: q.isError })}</p>;
  }

  function Appli() {
    const a = useAuth();
    return (
      <div>
        <button onClick={() => void a.login("a@x", "pw")}>login-A</button>
        <button onClick={() => void a.login("b@x", "pw")}>login-B</button>
        <button onClick={() => void a.logout()}>logout</button>
        <p data-testid="qui">{a.user?.id ?? "aucun"}</p>
        {a.user && <Donnees />}
      </div>
    );
  }

  it("A charge une cle, se deconnecte ; B monte la meme cle EN ERREUR : il ne lit rien de A", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
    render(<QueryClientProvider client={qc}><AuthProvider controleur={controleur()}><Appli /></AuthProvider></QueryClientProvider>);
    const u = userEvent.setup({ delay: null });
    await waitFor(() => expect(screen.getByTestId("qui")).toHaveTextContent("aucun"));
    await u.click(screen.getByText("login-A"));
    await waitFor(() => expect(screen.getByTestId("sortie")).toHaveTextContent("saisie-secrete-de-A"));
    expect(qc.getQueryData(["observations-terrain"])).toEqual(["saisie-secrete-de-A"]);

    await u.click(screen.getByText("logout"));
    await waitFor(() => expect(screen.getByTestId("qui")).toHaveTextContent("aucun"));
    expect(qc.getQueryCache().getAll()).toHaveLength(0); // cache vide des la sortie

    await u.click(screen.getByText("login-B"));
    await waitFor(() => expect(screen.getByTestId("sortie")).toHaveTextContent('"erreur":true'));
    expect(screen.getByTestId("sortie")).not.toHaveTextContent("saisie-secrete-de-A");
    expect(qc.getQueryData(["observations-terrain"])).toBeUndefined();
  });

  it("changement de compte sans deconnexion visible (connexion de B apres A) : le cache de A est vide", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["observations-terrain"], ["saisie-secrete-de-A"]);
    const c = controleur();
    render(<QueryClientProvider client={qc}><AuthProvider controleur={c}><Appli /></AuthProvider></QueryClientProvider>);
    await waitFor(() => expect(screen.getByTestId("qui")).toHaveTextContent("aucun"));
    const u = userEvent.setup({ delay: null });
    await u.click(screen.getByText("login-B"));
    await waitFor(() => expect(screen.getByTestId("qui")).toHaveTextContent("agent-B"));
    expect(qc.getQueryData(["observations-terrain"])).toBeUndefined();
  });

  it("sans fournisseur de requetes (tests, composants isoles), rien n'est vide et rien ne plante", async () => {
    render(<AuthProvider controleur={controleur()}><p>ok</p></AuthProvider>);
    expect(await screen.findByText("ok")).toBeInTheDocument();
  });
});
