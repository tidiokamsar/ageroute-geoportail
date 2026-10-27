import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "../lib/auth";
import { fermerCompte } from "../lib/compteCourant";
import { ProtectedRoute } from "../components/ProtectedRoute";
import { stockageEnMemoire, type StockageCoffre } from "./coffreSession";
import type { ComptesFile } from "./politiqueDeconnexion";
import {
  ControleurSession, type InstantaneSession, type ResultatRafraichissement, type ServeurSession, type UtilisateurServeur,
} from "./useSessionLocale";

/**
 * DEFAUT E2E-5 (navigateur reel) : hors ligne, le bon PIN etait accepte puis l'application navigait vers /login.
 *
 * Cause : `deverrouiller` appliquait DEVERROUILLAGE_REUSSI (le noyau passe a HORS_LIGNE_OUVERT, `appliquer` EMET un instantane)
 * AVANT de renseigner `utilisateur` depuis le profil du coffre. Entre cet instantane et le suivant (celui de `apresOuverture`, apres
 * `await migrer()`), `ProtectedRoute` voyait « ecran AUCUN et aucun utilisateur » et redirigeait vers /login. Les tests d'avant ne
 * l'attrapaient pas : leurs dependances rendaient la migration instantanee, donc l'instantane transitoire n'etait jamais rendu.
 * Ici la migration est ASYNCHRONE (comme IndexedDB dans un navigateur) et on enregistre CHAQUE instantane, pas seulement l'etat final.
 */

const PIN = "Zx-91-pin";
const VIDE: ComptesFile = { enAttente: 0, enErreur: 0, abandonnees: 0, enConflit: 0, photosEnFile: 0, relevesNonConfirmes: 0 };
const agent: UtilisateurServeur = {
  id: "agent-A", email: "a@x.test", nomComplet: "Agent A", role: "INSPECTEUR", actif: true, modulesAutorises: ["inspections", "troncons"],
  peutDeleguerValidation: false, createdAt: "2026-01-01T00:00:00.000Z", regions: [1], perimetreNational: false,
};

let stockageCoffre: StockageCoffre;
let marqueur: boolean;
let reseau: { coupe: boolean; refus: 401 | 403 | null };
const controleurs: ControleurSession[] = [];

function serveur(): ServeurSession {
  const issue = (): ResultatRafraichissement => {
    if (reseau.coupe) return { etat: "RESEAU_COUPE" };
    if (reseau.refus !== null) return { etat: "REFUSE", statut: reseau.refus };
    return { etat: "OK", token: "j" };
  };
  return {
    connexion: async () => ({ accessToken: "j", user: agent }),
    verifierDeuxFacteurs: async () => ({ accessToken: "j", user: agent }),
    moi: async () => { if (reseau.coupe) throw {}; return agent; },
    deconnexion: async () => !reseau.coupe,
    rafraichirAuDemarrage: async () => issue(),
    sonder: async () => issue(),
    envoyerEvenements: async () => undefined,
    poserJeton: () => undefined,
    appareilServeurId: () => null,
  };
}

/** `migrer` est asynchrone ET lent : c'est l'ouverture d'IndexedDB du navigateur. */
function nouveau(migrationMs = 25): ControleurSession {
  const c = new ControleurSession({
    serveur: serveur(), stockageCoffre, idAppareilLocal: () => "tel-1", maintenant: () => Date.now(),
    marqueur: { present: () => marqueur, poser: () => { marqueur = true; }, purger: () => { marqueur = false; } },
    sha256: async (o) => { const r = new Uint8Array(32); o.forEach((b, i) => { r[i % 32] = (r[i % 32] * 31 + b) & 0xff; }); return r; },
    optionsCoffre: { iterations: 1000, iterationsDeTest: true },
    decompteFile: async () => VIDE, retourReseauMs: 0,
    migrer: () => new Promise((fin) => setTimeout(fin, migrationMs)),
  });
  controleurs.push(c);
  return c;
}

// Hors `act` : React rend ENTRE les instantanes (comme dans le navigateur). Sous `act`, les mises a jour sont regroupees et l'instantane
// transitoire du defaut E2E-5 n'etait jamais rendu.
const etaitEnvironnementAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  visites.length = 0;
  vi.stubGlobal("matchMedia", undefined);
  localStorage.clear();
  fermerCompte();
  stockageCoffre = stockageEnMemoire();
  marqueur = true;
  reseau = { coupe: false, refus: null };
});
afterEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = etaitEnvironnementAct;
  cleanup();
  for (const c of controleurs.splice(0)) c.desactiver();
  fermerCompte();
  vi.restoreAllMocks();
});

/** Premiere vie du telephone : connexion en ligne et creation du PIN, puis l'application est tuee. */
async function sessionCreeeEnLigne() {
  const c = nouveau(0);
  await c.demarrer();
  await c.connecter("a@x.test", "pw");
  expect(await c.creerPin(PIN)).toEqual({ ok: true });
  c.desactiver();
  fermerCompte();
}

/** Chaque chemin rendu, dans l'ordre : une navigation TRANSITOIRE vers /login y laisse une trace meme si l'ecran final est bon. */
const visites: string[] = [];

function Chemin() {
  const chemin = useLocation().pathname;
  useEffect(() => { visites.push(chemin); }, [chemin]);
  return <p data-testid="chemin">{chemin}</p>;
}

function Qui() {
  const { user } = useAuth();
  return <p data-testid="qui">{user?.id ?? "aucun"}</p>;
}

function monter(c: ControleurSession, chemin = "/inspections/terrain") {
  return render(
    <MemoryRouter initialEntries={[chemin]}>
      <AuthProvider controleur={c}>
        <Chemin />
        <Qui />
        <Routes>
          <Route path="/login" element={<p>Page de connexion</p>} />
          <Route path="/carte" element={<p>Carte publique</p>} />
          <Route element={<ProtectedRoute />}>
            <Route path="/inspections/terrain" element={<p>Saisies de terrain</p>} />
            <Route path="/troncons" element={<p>Tableau des troncons</p>} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

/** Enregistre chaque instantane emis, dans l'ordre (c'est l'ordre des evenements qui comptait, pas l'etat final). */
function enregistrer(c: ControleurSession): InstantaneSession[] {
  const vus: InstantaneSession[] = [];
  c.abonner(() => { vus.push(c.instantane()); });
  return vus;
}

describe("ouverture hors ligne : le bon PIN rouvre l'ecran demande, jamais /login (defaut E2E-5)", () => {
  it("API injoignable au demarrage, PIN, migration lente : aucun instantane « ouvert sans utilisateur », jamais /login", async () => {
    await sessionCreeeEnLigne();
    reseau.coupe = true;
    const c = nouveau();
    const vus = enregistrer(c);
    monter(c);

    expect(await screen.findByRole("dialog", { name: "Session verrouillée" })).toBeInTheDocument();
    expect(screen.getByTestId("chemin")).toHaveTextContent("/inspections/terrain");
    expect(screen.queryByText("Saisies de terrain")).toBeNull(); // rien de lisible avant le code

    const resultat = await c.deverrouiller(PIN);
    expect(resultat).toEqual({ ok: true });

    // La migration est terminee : le dernier etat est le bon...
    await waitFor(() => expect(screen.getByText("Saisies de terrain")).toBeInTheDocument());
    expect(screen.getByTestId("qui")).toHaveTextContent("agent-A");
    expect(screen.getByTestId("chemin")).toHaveTextContent("/inspections/terrain");
    expect(screen.queryByText("Page de connexion")).toBeNull();
    expect(visites).not.toContain("/login"); // jamais, meme un instant
    // ... et AUCUN instantane intermediaire n'a montre un coffre ouvert sans utilisateur (c'est ce qui renvoyait vers /login).
    const ouvertsSansUtilisateur = vus.filter((s) => s.etat === "HORS_LIGNE_OUVERT" && s.utilisateur === null);
    expect(ouvertsSansUtilisateur).toHaveLength(0);
    const apres = c.instantane();
    expect(apres.etat).toBe("HORS_LIGNE_OUVERT");
    expect(apres.utilisateur).toMatchObject({ id: "agent-A", role: "INSPECTEUR", modulesAutorises: ["inspections", "troncons"] });
  });

  it("le chemin demande est conserve pendant toute la suite des instantanes (aucune navigation transitoire)", async () => {
    await sessionCreeeEnLigne();
    reseau.coupe = true;
    const c = nouveau(60);
    monter(c);
    await screen.findByRole("dialog", { name: "Session verrouillée" });
    const chemins: string[] = [];
    c.abonner(() => { chemins.push(screen.getByTestId("chemin").textContent ?? ""); });
    await c.deverrouiller(PIN);
    await waitFor(() => expect(screen.getByText("Saisies de terrain")).toBeInTheDocument());
    expect(new Set(chemins)).toEqual(new Set(["/inspections/terrain"]));
  });

  it("route qui n'utilise pas la file : l'agent reste sur la route (pas de /login) ; le layout dit « en ligne seulement » (voir AppLayout)", async () => {
    await sessionCreeeEnLigne();
    reseau.coupe = true;
    const c = nouveau();
    monter(c, "/troncons");
    await screen.findByRole("dialog", { name: "Session verrouillée" });
    await c.deverrouiller(PIN);
    await waitFor(() => expect(screen.getByText("Tableau des troncons")).toBeInTheDocument());
    expect(screen.getByTestId("chemin")).toHaveTextContent("/troncons");
  });

  it("le reseau revient apres l'ouverture hors ligne : l'agent reste sur sa route, l'identite vient du serveur", async () => {
    await sessionCreeeEnLigne();
    reseau.coupe = true;
    const c = nouveau();
    monter(c);
    await screen.findByRole("dialog", { name: "Session verrouillée" });
    await c.deverrouiller(PIN);
    await waitFor(() => expect(screen.getByText("Saisies de terrain")).toBeInTheDocument());

    reseau.coupe = false;
    await c.reseauRevenu();
    await waitFor(() => expect(c.instantane().etat).toBe("EN_LIGNE"));
    expect(screen.getByText("Saisies de terrain")).toBeInTheDocument();
    expect(screen.getByTestId("chemin")).toHaveTextContent("/inspections/terrain");
    expect(c.instantane().utilisateur?.email).toBe("a@x.test");
  });

  it("un vrai refus du serveur (401) au retour du reseau ferme la session et renvoie a la connexion", async () => {
    await sessionCreeeEnLigne();
    reseau.coupe = true;
    const c = nouveau();
    monter(c);
    await screen.findByRole("dialog", { name: "Session verrouillée" });
    await c.deverrouiller(PIN);
    await waitFor(() => expect(screen.getByText("Saisies de terrain")).toBeInTheDocument());

    reseau.coupe = false;
    reseau.refus = 401;
    await c.reseauRevenu();
    await waitFor(() => expect(screen.getByText("Page de connexion")).toBeInTheDocument());
    expect(c.instantane().etat).toBe("FERME");
    expect(c.instantane().utilisateur).toBeNull();
  });

  it("une simple coupure ne renvoie jamais a /login : sonde « reseau coupe » apres l'ouverture, l'agent reste", async () => {
    await sessionCreeeEnLigne();
    reseau.coupe = true;
    const c = nouveau();
    monter(c);
    await screen.findByRole("dialog", { name: "Session verrouillée" });
    await c.deverrouiller(PIN);
    await waitFor(() => expect(screen.getByText("Saisies de terrain")).toBeInTheDocument());
    await c.reseauRevenu(); // le reseau est toujours coupe : sonde, issue RESEAU_COUPE
    expect(screen.getByText("Saisies de terrain")).toBeInTheDocument();
    expect(screen.queryByText("Page de connexion")).toBeNull();
    expect(c.instantane().etat).toBe("HORS_LIGNE_OUVERT");
  });

  it("un code faux n'ouvre rien et ne change pas de page", async () => {
    await sessionCreeeEnLigne();
    reseau.coupe = true;
    const c = nouveau();
    monter(c);
    await screen.findByRole("dialog", { name: "Session verrouillée" });
    await c.deverrouiller("pas-le-bon-code");
    expect(screen.getByRole("dialog", { name: "Session verrouillée" })).toBeInTheDocument();
    expect(screen.queryByText("Page de connexion")).toBeNull();
    expect(c.instantane().utilisateur).toBeNull();
  });
});
