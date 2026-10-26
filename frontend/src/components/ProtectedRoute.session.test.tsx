import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { decisionSuppressionLocale } from "../session/politiqueDeconnexion";
import { SessionLocaleProvider, type ControleurSession, type InstantaneSession } from "../session/useSessionLocale";

const h = vi.hoisted(() => ({ user: null as Record<string, unknown> | null }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: h.user, loading: false, logout: vi.fn() }) }));

import { ProtectedRoute } from "./ProtectedRoute";

/**
 * Session locale (docs/securite/SESSION-HORS-LIGNE.md) : la route ne montre jamais de contenu a une session verrouillee, sans
 * pour autant demonter la page (un releve de roulage en cours continue, une saisie commencee n'est pas perdue).
 */
const VIDE = { enAttente: 0, enErreur: 0, abandonnees: 0, enConflit: 0, photosEnFile: 0, relevesNonConfirmes: 0 };

function instantane(p: Partial<InstantaneSession> = {}): InstantaneSession {
  return {
    version: 1, demarre: true, etat: "EN_LIGNE", utilisateur: null, compteId: "agent-A", nomCompte: "Agent Diallo",
    coffrePresent: true, deverrouille: true, horsLigne: false, ecran: "AUCUN", candidats: [], attenteJusquaMs: null, echecsPin: 0,
    droitsAReverifier: null, messageFermeture: null, deverrouillageDemande: false, pinACreer: false,
    autresComptes: { comptes: 0, saisies: 0, releves: 0 }, envoiJournalEnAttente: 0, ...p,
  };
}

function faux(p: Partial<InstantaneSession> = {}) {
  let snap = instantane(p);
  const abonnes = new Set<() => void>();
  const c = {
    abonner: (f: () => void) => { abonnes.add(f); return () => { abonnes.delete(f); }; },
    instantane: () => snap,
    deverrouiller: vi.fn(async () => ({ ok: true })), creerPin: vi.fn(async () => ({ ok: true })),
    decompte: vi.fn(async () => VIDE), apercuPerte: vi.fn(async () => decisionSuppressionLocale(VIDE)),
    choisirCompte: vi.fn(), allerALaConnexion: vi.fn(),
  };
  return {
    c: c as unknown as ControleurSession,
    maj(q: Partial<InstantaneSession>) { snap = { ...snap, ...q, version: snap.version + 1 }; abonnes.forEach((f) => f()); },
  };
}

function Compteur() {
  const [n, setN] = useState(0);
  return <button onClick={() => setN(n + 1)}>compteur {n}</button>;
}

function monter(chemin: string, f: ReturnType<typeof faux>) {
  return render(
    <MemoryRouter initialEntries={[chemin]}>
      <SessionLocaleProvider controleur={f.c}>
        <Routes>
          <Route path="/login" element={<p>Page de connexion</p>} />
          <Route path="/carte" element={<p>Carte publique</p>} />
          <Route path="/" element={<p>Accueil</p>} />
          <Route element={<ProtectedRoute />}>
            <Route path="/inspections/terrain" element={<Compteur />} />
            <Route path="/troncons" element={<Compteur />} />
          </Route>
        </Routes>
      </SessionLocaleProvider>
    </MemoryRouter>,
  );
}

const agent = { id: "agent-A", role: "INSPECTEUR", modulesAutorises: [] };

describe("ProtectedRoute : session locale", () => {
  it("route de terrain, en ligne, coffre verrouille : l'ecran de PIN passe devant ; le contenu est cache (inert, aria-hidden) mais RESTE MONTE", async () => {
    h.user = agent;
    const f = faux({ deverrouille: true });
    const { container } = monter("/inspections/terrain", f);
    const u = userEvent.setup({ delay: null });
    await u.click(screen.getByRole("button", { name: "compteur 0" }));
    expect(screen.getByRole("button", { name: "compteur 1" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => f.maj({ deverrouille: false }));
    expect(screen.getByRole("dialog", { name: "Session verrouillée" })).toBeInTheDocument();
    const masque = container.querySelector("[aria-hidden='true']") as HTMLElement;
    expect(masque).not.toBeNull();
    expect(masque).toHaveAttribute("inert");
    expect(masque.style.visibility).toBe("hidden");
    expect(masque.textContent).toContain("compteur 1"); // le contenu est la, mais invisible et inaccessible
    expect(screen.queryByRole("button", { name: "compteur 1" })).toBeNull(); // hors de l'arbre d'accessibilite

    act(() => f.maj({ deverrouille: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "compteur 1" })).toBeInTheDocument(); // l'etat a survecu au verrou
  });

  it("route sans file (tableaux, carte) : un coffre verrouille ne gene pas, le contenu reste visible", () => {
    h.user = agent;
    monter("/troncons", faux({ deverrouille: false }));
    expect(screen.getByRole("button", { name: "compteur 0" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("route sans file : l'agent peut demander l'ecran de deverrouillage depuis le bandeau", () => {
    h.user = agent;
    monter("/troncons", faux({ deverrouille: false, deverrouillageDemande: true }));
    expect(screen.getByRole("dialog", { name: "Session verrouillée" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "compteur 0" })).toBeNull();
  });

  it("route de terrain sans coffre : creation du PIN a la place du contenu, avec un retour au tableau de bord", async () => {
    h.user = agent;
    monter("/inspections/terrain", faux({ coffrePresent: false, deverrouille: false, pinACreer: true }));
    expect(screen.getByRole("heading", { name: "Créez votre code PIN" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "compteur 0" })).toBeNull();
    await userEvent.setup({ delay: null }).click(screen.getByRole("button", { name: /Retour au tableau de bord/ }));
    expect(await screen.findByText("Accueil")).toBeInTheDocument();
  });

  it("route sans file et sans coffre : pas de creation de PIN imposee (les pages web restent utilisables)", () => {
    h.user = agent;
    monter("/troncons", faux({ coffrePresent: false, deverrouille: false, pinACreer: true }));
    expect(screen.getByRole("button", { name: "compteur 0" })).toBeInTheDocument();
  });

  it("hors ligne au demarrage (aucun utilisateur, PIN requis) : l'ecran de PIN, pas de redirection ; aucun contenu", () => {
    h.user = null;
    monter("/inspections/terrain", faux({ etat: "HORS_LIGNE_VERROUILLE", ecran: "DEVERROUILLAGE", horsLigne: true, deverrouille: false }));
    expect(screen.getByRole("dialog", { name: "Session verrouillée" })).toBeInTheDocument();
    expect(screen.queryByText("Page de connexion")).toBeNull();
    expect(screen.queryByText("Carte publique")).toBeNull();
    expect(screen.queryByRole("button", { name: "compteur 0" })).toBeNull();
  });

  it("hors ligne, verrouille, utilisateur connu : l'ecran de PIN sur n'importe quelle route, contenu cache", () => {
    h.user = agent;
    const { container } = monter("/troncons", faux({ etat: "HORS_LIGNE_VERROUILLE", ecran: "DEVERROUILLAGE", horsLigne: true, deverrouille: false }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(container.querySelector("[inert]")).not.toBeNull();
  });

  it("hors ligne, deverrouille : le contenu s'affiche, sans ecran", () => {
    h.user = agent;
    monter("/inspections/terrain", faux({ etat: "HORS_LIGNE_OUVERT", horsLigne: true, deverrouille: true }));
    expect(screen.getByRole("button", { name: "compteur 0" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("session expiree : l'ecran d'expiration, sans contenu", () => {
    h.user = null;
    monter("/inspections/terrain", faux({ etat: "EXPIRE", ecran: "SESSION_EXPIREE", horsLigne: false, deverrouille: false }));
    expect(screen.getByRole("heading", { name: "Session locale expirée" })).toBeInTheDocument();
  });

  it("non connecte et sans session locale a ouvrir : comportement d'avant (connexion)", () => {
    h.user = null;
    monter("/inspections/terrain", faux({ etat: "DECONNECTE", coffrePresent: false, deverrouille: false }));
    expect(screen.getByText("Page de connexion")).toBeInTheDocument();
  });
});
