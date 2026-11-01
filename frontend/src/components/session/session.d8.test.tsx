import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const h = vi.hoisted(() => ({ user: null as Record<string, unknown> | null }));
vi.mock("../../lib/auth", async (orig) => {
  const reel = await orig<typeof import("../../lib/auth")>();
  return { ...reel, useAuth: () => ({ user: h.user, loading: false, logout: vi.fn() }) };
});
vi.mock("../../lib/offlineSync", () => ({ syncPendingOfflineData: vi.fn(async () => undefined) }));

import { ProtectedRoute } from "../ProtectedRoute";
import { Modal } from "../ui/Modal";
import { decisionSuppressionLocale, type ComptesFile } from "../../session/politiqueDeconnexion";
import { SessionLocaleProvider, type ControleurSession, type InstantaneSession, type ResultatAction } from "../../session/useSessionLocale";
import { ConfigurationPin } from "./ConfigurationPin";
import { DialogueDeconnexion, resumeFileDeconnexion } from "./DialogueDeconnexion";
import { EcranDeverrouillage } from "./EcranDeverrouillage";
import { masquerHorsDe } from "./masqueHorsEcran";

/** Chantier D8 : masquage du verrou (defaut 6), focus apres un PIN faux (9), textes (10, 13). */

const VIDE: ComptesFile = { enAttente: 0, enErreur: 0, abandonnees: 0, enConflit: 0, photosEnFile: 0, relevesNonConfirmes: 0 };

function instantane(p: Partial<InstantaneSession> = {}): InstantaneSession {
  return {
    version: 1, demarre: true, etat: "EN_LIGNE", utilisateur: null, compteId: "agent-A", nomCompte: "Agent Diallo",
    coffrePresent: true, deverrouille: true, horsLigne: false, ecran: "AUCUN", candidats: [], attenteJusquaMs: null, echecsPin: 0,
    droitsAReverifier: null, messageFermeture: null, deverrouillageDemande: false, pinACreer: false,
    autresComptes: { comptes: 0, saisies: 0, releves: 0 }, envoiJournalEnAttente: 0, ...p,
  };
}

function faux(p: Partial<InstantaneSession> = {}, surcharge: Record<string, unknown> = {}) {
  let snap = instantane(p);
  const abonnes = new Set<() => void>();
  const c = {
    abonner: (f: () => void) => { abonnes.add(f); return () => { abonnes.delete(f); }; },
    instantane: () => snap,
    deverrouiller: vi.fn(async (): Promise<ResultatAction> => ({ ok: true })),
    creerPin: vi.fn(async (): Promise<ResultatAction> => ({ ok: true })),
    decompte: vi.fn(async () => VIDE),
    apercuPerte: vi.fn(async () => decisionSuppressionLocale(VIDE)),
    deconnecter: vi.fn(async () => ({ fermeSession: true, verrouLocal: false, deconnexionEnAttente: false, efface: false as const, texte: "ok" })),
    choisirCompte: vi.fn(), allerALaConnexion: vi.fn(),
    ...surcharge,
  };
  return {
    c: c as unknown as ControleurSession & typeof c,
    maj(q: Partial<InstantaneSession>) { snap = { ...snap, ...q, version: snap.version + 1 }; abonnes.forEach((f) => f()); },
  };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.removeAttribute("style"); });

// ---------------------------------------------------------------------------------------------------
describe("defaut 6 : un dialogue Radix ouvert au moment du verrou", () => {
  function PageSensible() {
    const [ouvert, setOuvert] = useState(false);
    const [saisie, setSaisie] = useState("");
    return (
      <div>
        <p>OBSERVATION-CONFIDENTIELLE-PK-12</p>
        <label>description<input aria-label="description" value={saisie} onChange={(e) => setSaisie(e.target.value)} /></label>
        <button onClick={() => setOuvert(true)}>ouvrir fiche</button>
        {ouvert && <Modal open onClose={() => setOuvert(false)} title="Fiche"><p>FICHE-SENSIBLE-GPS-9.5N</p></Modal>}
      </div>
    );
  }
  function monter(f: ReturnType<typeof faux>) {
    return render(
      <MemoryRouter initialEntries={["/inspections/terrain"]}>
        <SessionLocaleProvider controleur={f.c}>
          <Routes>
            <Route element={<ProtectedRoute />}>
              <Route path="/inspections/terrain" element={<PageSensible />} />
            </Route>
          </Routes>
        </SessionLocaleProvider>
      </MemoryRouter>,
    );
  }

  it("au verrou : la fiche est inert, aria-hidden et invisible ; seul l'ecran de PIN est accessible, et le champ prend le focus APRES le masquage", async () => {
    h.user = { id: "agent-A", role: "INSPECTEUR", modulesAutorises: [] };
    const f = faux();
    monter(f);
    const u = userEvent.setup({ delay: null });
    await u.click(screen.getByRole("button", { name: "ouvrir fiche" }));
    expect(screen.getByRole("dialog", { name: "Fiche" })).toBeInTheDocument();

    // jsdom n'implemente ni `inert` ni le piege a focus de Radix : on prouve donc l'ORDRE, seule condition pour que le focus du
    // champ de PIN ne soit pas repris par un dialogue encore actif (le piege reprend le focus qui sort). Au moment ou le champ
    // du PIN prend le focus, le portail du dialogue est DEJA inert. Le focus reel est a verifier en navigateur (E2E).
    const portailInertAuFocus: boolean[] = [];
    const original = HTMLInputElement.prototype.focus;
    vi.spyOn(HTMLInputElement.prototype, "focus").mockImplementation(function (this: HTMLInputElement, ...args: []) {
      if (this.id === "champ-pin-deverrouillage") {
        const portail = screen.getByText("FICHE-SENSIBLE-GPS-9.5N", { selector: "p" }).closest("body > div") as HTMLElement;
        portailInertAuFocus.push(portail.hasAttribute("inert"));
      }
      return original.apply(this, args);
    });

    act(() => f.maj({ deverrouille: false }));

    const fiche = screen.getByText("FICHE-SENSIBLE-GPS-9.5N", { selector: "p" });
    const portail = fiche.closest("[data-radix-portal], body > div") as HTMLElement;
    expect(fiche.closest("[inert]")).not.toBeNull();
    expect(fiche.closest("[aria-hidden='true']")).not.toBeNull();
    expect((fiche.closest("[inert]") as HTMLElement).style.visibility).toBe("hidden");
    expect(portail).not.toBeNull();
    // Plus aucun contenu de la page ni de la fiche dans l'arbre d'accessibilite.
    expect(screen.queryByRole("dialog", { name: "Fiche" })).toBeNull();
    expect(screen.queryByRole("button", { name: "ouvrir fiche" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "description" })).toBeNull();
    // L'ecran de PIN, lui, est accessible (les ancetres caches par Radix sont devoiles), insensible au `pointer-events: none` du body.
    const pin = screen.getByRole("dialog", { name: "Session verrouillée" });
    expect(pin).toHaveStyle({ pointerEvents: "auto" });
    expect(portailInertAuFocus.length).toBeGreaterThan(0);
    expect(portailInertAuFocus.every(Boolean)).toBe(true);
  });

  it("au deverrouillage, tout est restitue (attributs d'avant, valeur de champ intacte)", async () => {
    h.user = { id: "agent-A", role: "INSPECTEUR", modulesAutorises: [] };
    const f = faux();
    monter(f);
    const u = userEvent.setup({ delay: null });
    await u.type(screen.getByLabelText("description"), "nid-de-poule");
    await u.click(screen.getByRole("button", { name: "ouvrir fiche" }));
    act(() => f.maj({ deverrouille: false }));
    expect(screen.queryByRole("dialog", { name: "Fiche" })).toBeNull();
    act(() => f.maj({ deverrouille: true }));
    expect(screen.queryByRole("dialog", { name: "Session verrouillée" })).toBeNull();
    const fiche = screen.getByText("FICHE-SENSIBLE-GPS-9.5N", { selector: "p" });
    expect(fiche.closest("[inert]")).toBeNull();
    expect((fiche.closest("[data-radix-portal], body > div") as HTMLElement).style.visibility).not.toBe("hidden");
    expect(screen.getByRole("dialog", { name: "Fiche" })).toBeInTheDocument();
    expect((document.querySelector("input[aria-label='description']") as HTMLInputElement).value).toBe("nid-de-poule");
  });
});

describe("defaut 11 : la route de file est reconnue quelle que soit la casse de l'URL", () => {
  it.each(["/inspections/terrain", "/Inspections/Terrain", "/INSPECTIONS/TERRAIN/"])("%s, en ligne, coffre verrouille : ecran de PIN", (chemin) => {
    h.user = { id: "agent-A", role: "INSPECTEUR", modulesAutorises: [] };
    const f = faux({ deverrouille: false });
    render(
      <MemoryRouter initialEntries={[chemin]}>
        <SessionLocaleProvider controleur={f.c}>
          <Routes>
            <Route element={<ProtectedRoute />}>
              <Route path="/inspections/terrain" element={<p>PAGE-TERRAIN</p>} />
            </Route>
            <Route path="*" element={<p>AUTRE</p>} />
          </Routes>
        </SessionLocaleProvider>
      </MemoryRouter>,
    );
    expect(screen.getByRole("dialog", { name: "Session verrouillée" })).toBeInTheDocument();
  });
});

describe("masquerHorsDe : unite", () => {
  it("masque les freres de l'element et de ses ancetres, jusqu'a body ; restitue les valeurs d'avant ; ignore script et style", () => {
    document.body.innerHTML = `
      <div id="racine"><div id="page" aria-hidden="false" style="visibility: visible">page</div><div id="ecran"><span id="cible">pin</span></div><script id="s"></script></div>
      <div id="portail">portail</div>
      <style id="st"></style>`;
    const cible = document.getElementById("ecran") as HTMLElement;
    const annuler = masquerHorsDe(cible);
    const page = document.getElementById("page") as HTMLElement;
    const portail = document.getElementById("portail") as HTMLElement;
    expect(page).toHaveAttribute("inert"); expect(page).toHaveAttribute("aria-hidden", "true"); expect(page.style.visibility).toBe("hidden");
    expect(portail).toHaveAttribute("inert");
    expect(document.getElementById("s")).not.toHaveAttribute("inert");
    expect(document.getElementById("st")).not.toHaveAttribute("inert");
    expect(cible).not.toHaveAttribute("inert");
    expect(document.getElementById("racine")).not.toHaveAttribute("inert");
    annuler();
    expect(page).not.toHaveAttribute("inert"); expect(page).toHaveAttribute("aria-hidden", "false"); expect(page.style.visibility).toBe("visible");
    expect(portail).not.toHaveAttribute("inert"); expect(portail).not.toHaveAttribute("aria-hidden");
    document.body.innerHTML = "";
  });

  it("un frere deja inert n'est pas touche (React en reste maitre) ; un ancetre aria-hidden est devoile puis recache", () => {
    document.body.innerHTML = `<div id="racine" aria-hidden="true"><div id="deja" inert aria-hidden="true">x</div><div id="ecran">pin</div></div>`;
    const annuler = masquerHorsDe(document.getElementById("ecran") as HTMLElement);
    const racine = document.getElementById("racine") as HTMLElement;
    expect(racine).not.toHaveAttribute("aria-hidden");
    annuler();
    expect(racine).toHaveAttribute("aria-hidden", "true");
    expect(document.getElementById("deja")).toHaveAttribute("inert"); // jamais retire par nous
    document.body.innerHTML = "";
  });
});

// ---------------------------------------------------------------------------------------------------
describe("defaut 9 : apres un PIN faux, le focus revient au champ", () => {
  it("focus() n'est jamais appele sur un champ encore desactive ; le champ est refocalise une fois reactive", async () => {
    const f = faux(
      { ecran: "DEVERROUILLAGE", etat: "HORS_LIGNE_VERROUILLE", horsLigne: true, deverrouille: false },
      { deverrouiller: vi.fn(async (): Promise<ResultatAction> => ({ ok: false, erreur: "PIN_INCORRECT", message: "Code incorrect." })) },
    );
    const appels: Array<{ desactive: boolean; apresErreur: boolean }> = [];
    const original = HTMLInputElement.prototype.focus;
    vi.spyOn(HTMLInputElement.prototype, "focus").mockImplementation(function (this: HTMLInputElement, ...args: []) {
      appels.push({ desactive: this.disabled, apresErreur: document.querySelector("[role='alert']") !== null });
      return original.apply(this, args);
    });
    render(<MemoryRouter><SessionLocaleProvider controleur={f.c}><EcranDeverrouillage /></SessionLocaleProvider></MemoryRouter>);
    const u = userEvent.setup({ delay: null });
    const champ = screen.getByLabelText("Code PIN") as HTMLInputElement;
    await waitFor(() => expect(champ).toHaveFocus());
    await u.type(champ, "mauvais-code");
    await u.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Code incorrect."));
    await waitFor(() => expect(champ).not.toBeDisabled());
    // Un focus a bien eu lieu APRES l'erreur, et aucun focus n'a jamais vise un champ desactive (sans effet : le focus tombait sur BODY).
    expect(appels.some((a) => a.apresErreur && !a.desactive)).toBe(true);
    expect(appels.every((a) => !a.desactive)).toBe(true);
    expect(champ).toHaveFocus();
    expect(champ).toHaveValue("");
  });
});

// ---------------------------------------------------------------------------------------------------
describe("defaut 10 : creation du PIN, textes exacts et attributs", () => {
  it("ne pretend plus que personne ne peut lire les donnees ; dit que le chiffrement ralentit sans rendre impossible, la phrase de passe, l'appareil compromis", () => {
    const f = faux({ etat: "EN_LIGNE", horsLigne: false, ecran: "AUCUN", coffrePresent: false, pinACreer: true });
    render(<MemoryRouter><SessionLocaleProvider controleur={f.c}><ConfigurationPin /></SessionLocaleProvider></MemoryRouter>);
    const texte = document.body.textContent ?? "";
    expect(texte).not.toMatch(/personne ne peut les lire/);
    expect(texte).not.toMatch(/volé ou prêté/);
    expect(texte).toMatch(/ralentit son attaque mais ne la rend pas impossible/);
    expect(texte).toMatch(/phrase de passe protège beaucoup mieux que six chiffres/);
    expect(texte).toMatch(/téléphone compromis/);
  });

  it("les deux champs n'invitent pas le navigateur a enregistrer le code (pas de new-password) et ouvrent un clavier texte", () => {
    const f = faux({ etat: "EN_LIGNE", horsLigne: false, ecran: "AUCUN", coffrePresent: false });
    render(<MemoryRouter><SessionLocaleProvider controleur={f.c}><ConfigurationPin /></SessionLocaleProvider></MemoryRouter>);
    for (const nom of ["Code PIN", "Confirmez le code"]) {
      const champ = screen.getByLabelText(nom);
      expect(champ).toHaveAttribute("autocomplete", "off");
      expect(champ).toHaveAttribute("inputmode", "text");
    }
  });

  it("l'ecran de deverrouillage : meme choix", () => {
    const f = faux({ ecran: "DEVERROUILLAGE", etat: "HORS_LIGNE_VERROUILLE", horsLigne: true, deverrouille: false });
    render(<MemoryRouter><SessionLocaleProvider controleur={f.c}><EcranDeverrouillage /></SessionLocaleProvider></MemoryRouter>);
    expect(screen.getByLabelText("Code PIN")).toHaveAttribute("autocomplete", "off");
    expect(screen.getByLabelText("Code PIN")).toHaveAttribute("inputmode", "text");
  });
});

// ---------------------------------------------------------------------------------------------------
describe("defaut 13 : le dialogue de deconnexion distingue chargement, inconnu, zero, saisies et refus de droits", () => {
  it("resumeFileDeconnexion : chaque cas a sa nature", () => {
    expect(resumeFileDeconnexion(undefined).nature).toBe("CHARGEMENT");
    expect(resumeFileDeconnexion(null).nature).toBe("INCONNU");
    expect(resumeFileDeconnexion({ ...VIDE, enAttente: -1 }).nature).toBe("INCONNU"); // decompte invalide
    expect(resumeFileDeconnexion({ ...VIDE, enAttente: Number.NaN }).nature).toBe("INCONNU");
    expect(resumeFileDeconnexion(VIDE).nature).toBe("VIDE");
    expect(resumeFileDeconnexion({ ...VIDE, refusDroits: 0 }).nature).toBe("VIDE");
  });

  it("saisies ordinaires : elles partiront a la prochaine connexion", () => {
    const r = resumeFileDeconnexion({ ...VIDE, enAttente: 2, photosEnFile: 1 });
    expect(r).toMatchObject({ nature: "RESTE" });
    expect((r as { texte: string }).texte).toMatch(/Restent chiffrés sur ce téléphone : 2 saisies et 1 photo\./);
    expect((r as { texte: string }).texte).toMatch(/Elles partiront à votre prochaine connexion/);
  });

  it("SEULEMENT des refus de droits : ne promet PAS qu'elles partiront", () => {
    const r = resumeFileDeconnexion({ ...VIDE, refusDroits: 2 }) as { nature: string; texte: string };
    expect(r.nature).toBe("RESTE");
    expect(r.texte).toMatch(/2 saisies/);
    expect(r.texte).toMatch(/ne partiront pas sans votre décision/);
    expect(r.texte).not.toMatch(/partiront à votre prochaine connexion/);
  });

  it("refus de droits ET saisies ordinaires : seules les ordinaires partent", () => {
    const r = resumeFileDeconnexion({ ...VIDE, enAttente: 1, refusDroits: 1 }) as { texte: string };
    expect(r.texte).toMatch(/ne partira pas sans votre décision/);
    expect(r.texte).toMatch(/Les autres partiront à votre prochaine connexion/);
  });

  it("un releve de roulage ne part pas tout seul", () => {
    const r = resumeFileDeconnexion({ ...VIDE, relevesNonConfirmes: 1 }) as { texte: string };
    expect(r.texte).toMatch(/1 relevé de roulage/);
    expect(r.texte).toMatch(/ne part pas tout seul/);
    expect(r.texte).not.toMatch(/partiront à votre prochaine connexion/);
  });

  it("le dialogue : « verification » pendant la lecture, « n'a pas pu etre verifie » si elle echoue, jamais « Aucune saisie » dans ces deux cas", async () => {
    let liberer!: (c: ComptesFile) => void;
    const f = faux({ etat: "EN_LIGNE", horsLigne: false }, { decompte: vi.fn(() => new Promise<ComptesFile>((r) => { liberer = r; })) });
    const { unmount } = render(<MemoryRouter><SessionLocaleProvider controleur={f.c}><DialogueDeconnexion ouvert surFermer={() => undefined} /></SessionLocaleProvider></MemoryRouter>);
    expect(await screen.findByText(/Vérification de la file de ce téléphone/)).toBeInTheDocument();
    expect(screen.queryByText(/Aucune saisie en attente/)).not.toBeInTheDocument();
    await act(async () => { liberer({ ...VIDE, refusDroits: 1 }); });
    expect(await screen.findByText(/ne partira pas sans votre décision/)).toBeInTheDocument();
    unmount();

    const g = faux({ etat: "EN_LIGNE", horsLigne: false }, { decompte: vi.fn(async () => { throw new Error("illisible"); }) });
    render(<MemoryRouter><SessionLocaleProvider controleur={g.c}><DialogueDeconnexion ouvert surFermer={() => undefined} /></SessionLocaleProvider></MemoryRouter>);
    expect(await screen.findByText(/n'a pas pu être vérifié/)).toBeInTheDocument();
    expect(screen.queryByText(/Aucune saisie en attente/)).not.toBeInTheDocument();
  });
});
