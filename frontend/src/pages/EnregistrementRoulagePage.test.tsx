import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { violationsAccessibilite } from "../test/accessibilite";
import { deplacer, horlogeSysteme, SessionRoulage } from "../roulage";
import type { EntreeJournal } from "../roulage/journal";
import { ecrireStockageLocal, ErreurStockageLocal, fermerCompte, lireStockageLocal, NOM_CLE_APPAREIL_SYNC, ouvrirCompte, type Chiffreur } from "../lib/compteCourant";
import { MESSAGE_APPAREIL_REVOQUE, MESSAGE_COMPTE_INACTIF } from "../lib/offlineSync";
import { roulageEstActif, surActivite } from "../session/activiteExterne";

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
  /** Erreur que `POST /v2/devices` doit lever (appareil retire, compte inactif...). */
  erreurAppareil: null as unknown,
  /** Erreurs que `POST /v2/sync/push` leve, une par appel, dans l'ordre (la file vide : le push reussit). */
  erreursPush: [] as unknown[],
  /** Nombre d'appareils enregistres : le N-ieme est rendu sous l'identifiant `appareil-N`. */
  appareilsEnregistres: 0,
  /** Etat d'arret de la synchronisation tel que `etatSynchronisation()` le rend. */
  arret: { appareilRevoque: false, compteInactif: false, message: null as string | null },
  /** Fermetures du journal (`fermer()`) et entrees qu'il retient encore faute d'avoir pu les ecrire (`enAttente()`). */
  fermetures: 0,
  enAttenteJournal: 0,
}));

vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "agent-1", role: "GESTIONNAIRE", modulesAutorises: [] } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/api", () => ({
  api: {
    post: vi.fn(async (url: string, corps: Record<string, unknown>) => {
      h.posts.push({ url, corps });
      if (url === "/v2/devices") {
        if (h.erreurAppareil) throw h.erreurAppareil;
        h.appareilsEnregistres += 1;
        return { data: { id: `appareil-${h.appareilsEnregistres}` } };
      }
      if (url === "/v2/sync/push" && h.erreursPush.length > 0) throw h.erreursPush.shift();
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
// L'etat d'arret de la synchronisation est pose par la file (offlineSync.ts, eprouvee ailleurs) : ici il est simule.
vi.mock("../lib/offlineSync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/offlineSync")>()),
  etatSynchronisation: () => h.arret,
}));
vi.mock("../lib/observationsTerrain", async (importOriginal) => {
  const reel = await importOriginal<typeof import("../lib/observationsTerrain")>();
  return { ...reel, enregistrerObservation: vi.fn(async () => ({ ok: true as const, observation: {} })) };
});
// Leaflet a besoin d'un vrai navigateur (mesures, canvas) : la carte est remplacee par un temoin qui expose ce qu'elle recoit.
vi.mock("../components/CarteTraceRoulage", () => ({
  CarteTraceRoulage: (p: { segments: unknown[][]; position: [number, number] | null }) => (
    <div data-testid="carte-trace" data-segments={p.segments.length} data-points={p.segments.reduce((n, s) => n + s.length, 0)} data-position={p.position ? p.position.join(",") : ""} />
  ),
}));
vi.mock("../lib/roulageHote", async (importOriginal) => {
  const reel = await importOriginal<typeof import("../lib/roulageHote")>();
  // Le journal en memoire n'a ni `fermer` ni `enAttente` : ils sont ajoutes pour observer ce que la page en fait au demontage.
  const stockage = Object.assign(reel.stockageMemoire(), {
    fermer: () => { h.fermetures += 1; },
    enAttente: () => h.enAttenteJournal,
  });
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
import { EnregistrementRoulagePage, MESSAGE_REVOCATION_RECENTE } from "./EnregistrementRoulagePage";

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
  // Le bouton reste inactif (« Lecture de ce téléphone… ») tant que le journal n'a pas répondu : on attend qu'il porte son vrai nom.
  fireEvent.click(await screen.findByRole("button", { name: /Démarrer l'enregistrement/ }));
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
  h.erreurAppareil = null;
  h.erreursPush = [];
  h.appareilsEnregistres = 0;
  h.arret ={ appareilRevoque: false, compteInactif: false, message: null };
  h.fermetures = 0;
  h.enAttenteJournal = 0;
  vi.useFakeTimers({ toFake: ["Date"], now: T0 });
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  localStorage.clear();
  // Les cles localStorage (mission, intitule, envoi confirme) sont posees sous le prefixe du compte COURANT : sans compte
  // ouvert, rien n'est ecrit. Le coffre est deverrouille (chiffreur factice : ce fichier n'exerce pas le chiffrement).
  fermerCompte();
  ouvrirCompte({ compteId: "agent-1", empreinte: "0123456789abcdef", chiffreur: { estDeverrouille: () => true } as unknown as Chiffreur });
  // jsdom ne sait pas « naviguer » vers un blob : le clic de telechargement est neutralise.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:essai") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.useRealTimers(); fermerCompte(); });

describe("avant le depart", () => {
  it("dit ses limites avant de proposer de partir", async () => {
    installerGeolocalisation();
    rendre();
    const limites = screen.getByRole("region", { name: /À savoir avant de partir/ });
    expect(limites).toHaveTextContent(/premier plan, écran allumé/);
    expect(limites).toHaveTextContent(/passager manipule le téléphone, pas le conducteur/);
    expect(limites).toHaveTextContent(/ne mesure ni l'IRI ni l'état de la chaussée/);
    expect(limites).toHaveTextContent(/pas encore été essayée sur un téléphone/);
    expect(await screen.findByRole("button", { name: /Démarrer l'enregistrement/ })).toBeInTheDocument();
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

  describe("appareil de synchronisation : retire par l'administration, compte inactif", () => {
    const refus = (statut: number, code: string) => Object.assign(new Error("refus"), { response: { status: statut, data: { code, error: "texte historique" } } });
    const envoyerSession = () => fireEvent.click(screen.getByRole("button", { name: /(Envoyer|Renvoyer) la session/ }));
    const urls = () => h.posts.map((p) => p.url);
    /**
     * Un arret decide par le serveur n'est pas une panne de reseau : `envoyer()` ne le range plus dans « echec retentable », donc
     * l'effet de reprise automatique ne redemande RIEN. Ces aides laissent a la page le temps de se tromper (reprise, retour du
     * reseau) avant de compter les requetes.
     */
    const laisserPasserLaReprise = async () => {
      await new Promise((r) => setTimeout(r, 50));
      act(() => { window.dispatchEvent(new Event("offline")); });
      act(() => { window.dispatchEvent(new Event("online")); });
      await new Promise((r) => setTimeout(r, 50));
    };
    const uneSeuleDemande = async (url: string) => {
      await laisserPasserLaReprise();
      expect(urls()).toEqual([url]);
    };
    const lePush = () => h.posts.filter((p) => p.url === "/v2/sync/push").map((p) => (p.corps as { appareilId: string }).appareilId);

    it("l'arret est deja constate : aucun appareil neuf, aucun envoi, le message est dit", async () => {
      h.arret = { appareilRevoque: true, compteInactif: false, message: MESSAGE_APPAREIL_REVOQUE };
      await terminerSession();
      envoyerSession();
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(MESSAGE_APPAREIL_REVOQUE));
      expect(urls()).toEqual([]);
      // La session reste sur le telephone et peut etre renvoyee : rien n'est perdu.
      expect(screen.getByRole("button", { name: /(Envoyer|Renvoyer) la session/ })).toBeEnabled();
    });

    it("compte inactif deja constate : meme arret, avec son message", async () => {
      h.arret = { appareilRevoque: false, compteInactif: true, message: MESSAGE_COMPTE_INACTIF };
      await terminerSession();
      envoyerSession();
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(MESSAGE_COMPTE_INACTIF));
      expect(urls()).toEqual([]);
    });

    it("403 APPAREIL_REVOQUE a l'enregistrement : jamais d'envoi ni d'appareil enregistre", async () => {
      await terminerSession();
      h.erreurAppareil = refus(403, "APPAREIL_REVOQUE");
      envoyerSession();
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(MESSAGE_APPAREIL_REVOQUE));
      // UNE seule demande d'appareil, meme apres un retour du reseau : plus de seconde demande par la reprise automatique.
      await uneSeuleDemande("/v2/devices");
      expect(lireStockageLocal(NOM_CLE_APPAREIL_SYNC, "agent-1")).toBeNull();
      expect(toast.error).toHaveBeenCalledTimes(1);
      expect(screen.getByText(new RegExp(MESSAGE_APPAREIL_REVOQUE.slice(0, 40)))).toHaveTextContent(/reste sur ce téléphone/);
      expect(screen.queryByText(/Envoi impossible/)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /(Envoyer|Renvoyer) la session/ })).toBeEnabled();
    });

    it("401 COMPTE_INACTIF a l'enregistrement : jamais d'envoi, une seule demande", async () => {
      await terminerSession();
      h.erreurAppareil = refus(401, "COMPTE_INACTIF");
      envoyerSession();
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(MESSAGE_COMPTE_INACTIF));
      await uneSeuleDemande("/v2/devices");
      expect(screen.getByText(new RegExp(MESSAGE_COMPTE_INACTIF.slice(0, 40)))).toBeInTheDocument();
    });

    it("403 APPAREIL_REVOCATION_RECENTE a l'enregistrement : message clair, une seule demande, aucune boucle, saisie conservee, renvoi manuel possible", async () => {
      await terminerSession();
      h.erreurAppareil = Object.assign(new Error("refus"), { response: { status: 403, data: { code: "APPAREIL_REVOCATION_RECENTE", reessayerDansMs: 600_000 } } });
      envoyerSession();
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(MESSAGE_REVOCATION_RECENTE));
      expect(MESSAGE_REVOCATION_RECENTE).toBe("Un de vos appareils vient d'être retiré. Patientez quelques minutes avant d'enregistrer ce téléphone, ou contactez votre responsable.");
      // Pas de reprise automatique : une seule demande d'appareil, meme apres un retour du reseau, et aucun envoi.
      await uneSeuleDemande("/v2/devices");
      expect(screen.queryByText(/Envoi impossible/)).not.toBeInTheDocument();
      expect(screen.getByText(new RegExp(MESSAGE_REVOCATION_RECENTE.slice(0, 40)))).toHaveTextContent(/reste sur ce téléphone/);
      // La session est conservee et l'agent peut renvoyer a la main apres le delai.
      expect(screen.getByRole("button", { name: /(Envoyer|Renvoyer) la session/ })).toBeEnabled();
      h.erreurAppareil = null;
      envoyerSession();
      expect(await screen.findByText("Session enregistrée sur le serveur.")).toBeInTheDocument();
    });

    it("D8 : une erreur « SynchronisationArretee » qui n'est PAS une instance d'Error (objet simple) est reconnue par son nom : pas d'« Envoi impossible », pas de reprise", async () => {
      await terminerSession();
      ecrireStockageLocal(NOM_CLE_APPAREIL_SYNC, "appareil-memorise", "agent-1");
      // Un objet simple qui porte le nom et le message (autre module, autre contexte) : `instanceof Error` etait faux.
      h.erreursPush = [{ name: "SynchronisationArretee", message: "La synchronisation de ce telephone est arretee." }];
      envoyerSession();
      expect(await screen.findByText(/La synchronisation de ce telephone est arretee\. La session reste sur ce téléphone/)).toBeInTheDocument();
      await uneSeuleDemande("/v2/sync/push");
      expect(screen.queryByText(/Envoi impossible/)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /(Envoyer|Renvoyer) la session/ })).toBeEnabled();
    });

    describe("reponse de sync/push (code lu dans response.data.code)", () => {
      const memoriser = (id: string) => ecrireStockageLocal(NOM_CLE_APPAREIL_SYNC, id, "agent-1");

      it("403 APPAREIL_REVOQUE : UNE requete, aucun nouvel appareil, message du contrat, pas de reprise automatique", async () => {
        await terminerSession();
        memoriser("appareil-retire");
        h.erreursPush = [refus(403, "APPAREIL_REVOQUE")];
        envoyerSession();
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith(MESSAGE_APPAREIL_REVOQUE));
        // Le retour du reseau (qui declencherait la reprise d'un echec retentable) ne renvoie rien.
        await uneSeuleDemande("/v2/sync/push");
        expect(h.appareilsEnregistres).toBe(0);
        expect(lireStockageLocal(NOM_CLE_APPAREIL_SYNC, "agent-1")).toBe("appareil-retire"); // une decision humaine peut le rendre
        const message = screen.getByText(new RegExp(MESSAGE_APPAREIL_REVOQUE.slice(0, 40)));
        expect(message).toHaveTextContent(MESSAGE_APPAREIL_REVOQUE);
        expect(message).toHaveTextContent(/reste sur ce téléphone/);
        expect(screen.queryByText(/Envoi impossible/)).not.toBeInTheDocument();
        expect(screen.queryByText(/sera tenté automatiquement/)).not.toBeInTheDocument();
        // Rien n'est perdu : l'agent peut encore renvoyer a la main, ou telecharger le GPX.
        expect(screen.getByRole("button", { name: /(Envoyer|Renvoyer) la session/ })).toBeEnabled();
        expect(screen.getByRole("button", { name: /Télécharger le GPX/ })).toBeEnabled();
      });

      it("401 COMPTE_INACTIF : meme arret, avec son message", async () => {
        await terminerSession();
        memoriser("appareil-memorise");
        h.erreursPush = [refus(401, "COMPTE_INACTIF")];
        envoyerSession();
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith(MESSAGE_COMPTE_INACTIF));
        await uneSeuleDemande("/v2/sync/push");
        expect(h.appareilsEnregistres).toBe(0);
        expect(screen.getByText(new RegExp(MESSAGE_COMPTE_INACTIF.slice(0, 40)))).toHaveTextContent(MESSAGE_COMPTE_INACTIF);
      });

      it("403 APPAREIL_INCONNU : UN SEUL rappel de l'enregistrement, puis l'operation repart et reussit", async () => {
        await terminerSession();
        memoriser("appareil-perime");
        h.erreursPush = [refus(403, "APPAREIL_INCONNU")];
        envoyerSession();
        expect(await screen.findByText("Session enregistrée sur le serveur.")).toBeInTheDocument();
        expect(urls()).toEqual(["/v2/sync/push", "/v2/devices", "/v2/sync/push"]);
        expect(lePush()).toEqual(["appareil-perime", "appareil-1"]);
        // La session est la meme operation (meme charge) : le serveur l'accepte une seule fois.
        const corps = h.posts.filter((p) => p.url === "/v2/sync/push").map((p) => JSON.stringify((p.corps as { operations: unknown }).operations));
        expect(corps[0]).toBe(corps[1]);
        expect(lireStockageLocal(NOM_CLE_APPAREIL_SYNC, "agent-1")).toBe("appareil-1");
        expect(toast.error).not.toHaveBeenCalled();
      });

      it("APPAREIL_INCONNU puis APPAREIL_REVOQUE : arret au second refus, pas de boucle, pas de troisieme appareil", async () => {
        await terminerSession();
        memoriser("appareil-perime");
        h.erreursPush = [refus(403, "APPAREIL_INCONNU"), refus(403, "APPAREIL_REVOQUE")];
        envoyerSession();
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith(MESSAGE_APPAREIL_REVOQUE));
        await laisserPasserLaReprise();
        expect(urls()).toEqual(["/v2/sync/push", "/v2/devices", "/v2/sync/push"]);
        expect(h.appareilsEnregistres).toBe(1);
        expect(screen.getByText(new RegExp(MESSAGE_APPAREIL_REVOQUE.slice(0, 40)))).toBeInTheDocument();
        expect(screen.queryByText(/Envoi impossible/)).not.toBeInTheDocument();
      });

      it("APPAREIL_INCONNU deux fois de suite : un seul appareil enregistre, l'envoi s'arrete avec son message, pas de reprise", async () => {
        await terminerSession();
        memoriser("appareil-perime");
        h.erreursPush = [refus(403, "APPAREIL_INCONNU"), refus(403, "APPAREIL_INCONNU"), refus(403, "APPAREIL_INCONNU")];
        envoyerSession();
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/ne reconnaît pas l'appareil qu'il vient d'enregistrer/)));
        await laisserPasserLaReprise();
        expect(urls()).toEqual(["/v2/sync/push", "/v2/devices", "/v2/sync/push"]);
        expect(h.appareilsEnregistres).toBe(1);
        expect(screen.getByText(/ne reconnaît pas l'appareil qu'il vient d'enregistrer/)).toHaveTextContent(/reste sur ce téléphone/);
        expect(screen.queryByText(/Envoi impossible/)).not.toBeInTheDocument();
      });

      it("un 403 SANS code sur sync/push n'est ni un appareil inconnu ni un arret : traite comme un echec retentable", async () => {
        await terminerSession();
        memoriser("appareil-memorise");
        h.erreursPush = [Object.assign(new Error("refus"), { response: { status: 403, data: { error: "Appareil inconnu, révoqué ou non autorisé" } } })];
        envoyerSession();
        // L'echec retentable est rejoue UNE fois par la reprise automatique, qui reussit : aucun appareil n'a ete redemande.
        expect(await screen.findByText("Session enregistrée sur le serveur.")).toBeInTheDocument();
        expect(h.appareilsEnregistres).toBe(0);
        expect(urls()).toEqual(["/v2/sync/push", "/v2/sync/push"]);
        expect(toast.error).not.toHaveBeenCalled();
      });

      it("reseau muet sur sync/push : comportement conserve, message reseau, echec retentable rejoue une fois", async () => {
        await terminerSession();
        memoriser("appareil-memorise");
        h.erreursPush = [new Error("Network Error")];
        envoyerSession();
        expect(await screen.findByText("Session enregistrée sur le serveur.")).toBeInTheDocument();
        expect(urls()).toEqual(["/v2/sync/push", "/v2/sync/push"]);
        expect(h.appareilsEnregistres).toBe(0);
        expect(toast.error).not.toHaveBeenCalled();
      });

      it("reseau muet ET hors ligne : message reseau, la reprise est annoncee, rien n'est arrete", async () => {
        await terminerSession();
        memoriser("appareil-memorise");
        h.erreursPush = [new Error("Network Error")];
        act(() => { window.dispatchEvent(new Event("offline")); });
        envoyerSession();
        expect(await screen.findByText(/Envoi impossible \(réseau\)/)).toBeInTheDocument();
        expect(screen.getByText(/Un nouvel envoi sera tenté automatiquement au retour du réseau/)).toBeInTheDocument();
        expect(toast.error).not.toHaveBeenCalled();
      });
    });

    it("un 403 SANS code (autre refus) n'est pas pris pour un appareil retire", async () => {
      await terminerSession();
      h.erreurAppareil = Object.assign(new Error("refus"), { response: { status: 403, data: { error: "Appareil inconnu, révoqué ou non autorisé" } } });
      envoyerSession();
      expect(await screen.findByText(/Envoi impossible/)).toBeInTheDocument();
      expect(toast.error).not.toHaveBeenCalledWith(MESSAGE_APPAREIL_REVOQUE);
    });

    it("un appareil deja memorise est reutilise : aucun enregistrement", async () => {
      await terminerSession();
      ecrireStockageLocal(NOM_CLE_APPAREIL_SYNC, "appareil-memorise", "agent-1");
      envoyerSession();
      expect(await screen.findByText("Session enregistrée sur le serveur.")).toBeInTheDocument();
      expect(urls()).toEqual(["/v2/sync/push"]);
      expect((h.posts[0].corps as { appareilId: string }).appareilId).toBe("appareil-memorise");
    });
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

describe("complétude et indice d'irrégularité en fin de session", () => {
  function secousse(z: number) {
    act(() => { window.dispatchEvent(Object.assign(new Event("devicemotion"), { accelerationIncludingGravity: { x: 0, y: 0, z } })); });
  }

  it("l'indice d'irrégularité s'affiche APRES l'arret quand l'agent a activé l'accéléromètre, avec son avertissement expérimental", async () => {
    installerGeolocalisation();
    Object.defineProperty(window, "DeviceMotionEvent", { configurable: true, value: class {} });
    rendre();
    fireEvent.click(screen.getByRole("checkbox", { name: /Mesurer les irrégularités/ }));
    await demarrer();
    for (let i = 0; i < 4; i += 1) secousse(9.81 + 20);
    for (let s = 0; s < 4; s += 1) emettre(s);
    fireEvent.click(screen.getByRole("button", { name: /Arrêter/ }));
    await screen.findByText("Terminée, à envoyer");
    const indice = await screen.findByRole("region", { name: /Indice d'irrégularité/ });
    expect(indice).toHaveTextContent(/4 pic\(s\)/);
    expect(indice).toHaveTextContent(/EXPÉRIMENTAL/);
  });

  it("sans activation de l'accéléromètre, aucun indice n'est affiché", async () => {
    installerGeolocalisation();
    Object.defineProperty(window, "DeviceMotionEvent", { configurable: true, value: class {} });
    rendre();
    await demarrer();
    secousse(9.81 + 20);
    for (let s = 0; s < 4; s += 1) emettre(s);
    fireEvent.click(screen.getByRole("button", { name: /Arrêter/ }));
    await screen.findByText("Terminée, à envoyer");
    expect(screen.queryByRole("region", { name: /Indice d'irrégularité/ })).not.toBeInTheDocument();
  });

  it("la complétude parle de TEMPS avec signal, pas d'une « couverture » de la route, et rappelle qu'elle n'est pas un verdict d'inspection", async () => {
    installerGeolocalisation();
    rendre();
    await demarrer();
    for (let s = 0; s < 4; s += 1) emettre(s);
    fireEvent.click(screen.getByRole("button", { name: /Arrêter/ }));
    await screen.findByText("Terminée, à envoyer");
    const c = await screen.findByRole("region", { name: /Complétude du relevé/ });
    expect(c).toHaveTextContent(/Temps avec signal\s*100 %/);
    expect(c).not.toHaveTextContent(/Couverture/);
    expect(c).toHaveTextContent(/pas un verdict d'inspection/);
  });
});

describe("observation rapide dans l'enregistreur", () => {
  it("absente sans position, puis posee avec la position du dernier fix de la session en cours", async () => {
    installerGeolocalisation();
    rendre();
    await demarrer();
    expect(screen.getByText(/Rien n'est posé sans position/)).toBeInTheDocument();
    emettre(0);
    emettre(1);
    fireEvent.click(await screen.findByRole("button", { name: "Dégradation" }));
    fireEvent.click(screen.getByRole("button", { name: "Moyenne" }));
    const { enregistrerObservation } = await import("../lib/observationsTerrain");
    await waitFor(() => expect(vi.mocked(enregistrerObservation)).toHaveBeenCalledTimes(1));
    const [saisie, userId] = vi.mocked(enregistrerObservation).mock.calls[0];
    expect(userId).toBe("agent-1");
    expect(saisie).toMatchObject({ type: "DEGRADATION", gravite: "MOYENNE", precisionM: 8 });
    expect(saisie.lat).toBeCloseTo(9.64, 1);
    expect(String(saisie.description)).toMatch(/^Relevé en roulant, session [0-9a-f]{8}/);
  });

  it("n'est pas proposée en pause ni apres l'arret : on n'observe pas sans enregistrer", async () => {
    installerGeolocalisation();
    rendre();
    await demarrer();
    emettre(0);
    emettre(1);
    fireEvent.click(screen.getByRole("button", { name: /Pause/ }));
    await screen.findByText("En pause");
    expect(screen.queryByRole("group", { name: /Observation rapide/ })).not.toBeInTheDocument();
  });
});

/**
 * Le journal du telephone : ce que ces tests defendent (audit terrain).
 *   - l'echec d'ecriture du journal est DIT (alerte bloquante), pas seulement compte ;
 *   - « Demarrer » attend la fin de la lecture du journal : un appui precoce effacait une session recuperable ;
 *   - la session d'un AUTRE compte n'est ni reprise, ni envoyee, ni supprimee, ni ecrasee par un nouveau depart.
 */
type StockageEssai = {
  toutes: () => Promise<unknown[]>; vider: () => Promise<void>; echecs: () => number; ajouter: (e: EntreeJournal) => void;
};
async function stockageBrut(): Promise<StockageEssai> {
  return (await import("../lib/roulageHote") as unknown as { stockageBrut: StockageEssai }).stockageBrut;
}

/** Seme dans le journal une session enregistree par `agent` (le meme chemin que l'ecran : le noyau ecrit son journal). */
async function semerSession(agent: string, options: { positions?: number; arretee?: boolean } = {}) {
  const { positions = 4, arretee = true } = options;
  const journal = (await stockageBrut()).ajouter;
  vi.setSystemTime(T0);
  const r = SessionRoulage.demarrer({ horloge: horlogeSysteme(), genererId: () => crypto.randomUUID(), journal, agentRef: agent });
  if (!r.ok) throw new Error(r.erreurs.join(" "));
  for (let s = 0; s < positions; s += 1) {
    vi.setSystemTime(T0 + s * 1000);
    const p = deplacer({ lat: 9.64, lon: -13.6 }, 10 * s, 90);
    r.session.ajouterEchantillon({ tMs: T0 + s * 1000, lat: p.lat, lon: p.lon, precisionM: 8, vitesseMs: 10, capDeg: 90, altitudeM: null });
  }
  if (arretee) r.session.arreter("REFUSER");
}

describe("journal du telephone : echecs d'ecriture", () => {
  it("un echec d'ecriture du journal est DIT par une alerte bloquante, avec la marche a suivre", async () => {
    installerGeolocalisation();
    const stockage = await stockageBrut();
    rendre();
    await demarrer();
    emettre(0);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    const spy = vi.spyOn(stockage, "echecs").mockReturnValue(2);
    try {
      const alerte = await screen.findByRole("alert", {}, { timeout: 3000 });
      expect(alerte).toHaveTextContent(/journal n'est plus écrit/);
      expect(alerte).toHaveTextContent(/session peut être perdue/);
      expect(alerte).toHaveTextContent(/Arrêter l'enregistrement et télécharger le GPX/);
      expect(alerte).toHaveTextContent(/2 écriture\(s\) en échec/);
    } finally {
      spy.mockRestore();
    }
  });

  it("l'alerte reste affichee apres l'arret, ou elle demande de telecharger le GPX", async () => {
    installerGeolocalisation();
    const stockage = await stockageBrut();
    rendre();
    await demarrer();
    for (let s = 0; s < 3; s += 1) emettre(s);
    fireEvent.click(screen.getByRole("button", { name: /Arrêter/ }));
    await screen.findByText("Terminée, à envoyer");
    const spy = vi.spyOn(stockage, "echecs").mockReturnValue(1);
    try {
      const alerte = await screen.findByRole("alert", {}, { timeout: 3000 });
      expect(alerte).toHaveTextContent(/Télécharger le GPX maintenant/);
    } finally {
      spy.mockRestore();
    }
  });

  it("des echecs ANTERIEURS au depart de la session n'alertent pas : le compteur du stockage court depuis son ouverture", async () => {
    installerGeolocalisation();
    const stockage = await stockageBrut();
    const spy = vi.spyOn(stockage, "echecs").mockReturnValue(5);
    try {
      rendre();
      await demarrer();
      emettre(0);
      await new Promise((r) => setTimeout(r, 1200));   // plus de deux relectures du compteur
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("journal du telephone : lecture avant depart", () => {
  it("« Démarrer » reste inactif tant que le journal n'a pas répondu, et NE vide PAS une session récupérable", async () => {
    installerGeolocalisation();
    await semerSession("agent-1", { arretee: false });
    const stockage = await stockageBrut();
    const entrees = await stockage.toutes();
    expect(entrees.length).toBeGreaterThan(2);

    // Lecture lente : la reponse n'arrive que quand le test la libere.
    let liberer: () => void = () => undefined;
    const lente = vi.spyOn(stockage, "toutes").mockImplementation(() => new Promise((resolve) => { liberer = () => resolve(entrees); }));
    const vider = vi.spyOn(stockage, "vider");
    try {
      rendre();
      const bouton = await screen.findByRole("button", { name: /Lecture de ce téléphone/ });
      expect(bouton).toBeDisabled();
      expect(screen.queryByRole("button", { name: /Démarrer l'enregistrement/ })).not.toBeInTheDocument();

      fireEvent.click(bouton);
      expect(vider).not.toHaveBeenCalled();

      await act(async () => { liberer(); });
      // La session interrompue est proposee, intacte ; le bouton de depart disparait avec elle.
      expect(await screen.findByRole("heading", { name: /Une session a été retrouvée/ })).toBeInTheDocument();
      expect(vider).not.toHaveBeenCalled();
      lente.mockRestore();
      expect((await stockage.toutes()).length).toBe(entrees.length);
    } finally {
      lente.mockRestore();
      vider.mockRestore();
    }
  });

  it("sans session sur le telephone, le bouton porte son nom des que la lecture a repondu", async () => {
    installerGeolocalisation();
    rendre();
    const bouton = await screen.findByRole("button", { name: /Démarrer l'enregistrement/ });
    expect(bouton).toBeEnabled();
  });
});

describe("journal du telephone : autres comptes", () => {
  // Le journal est PAR COMPTE : le releve d'un autre compte n'est ni lisible ni supprimable ici. Seul un compteur
  // d'information (en clair, sans contenu) dit qu'il existe.
  function semerCompteurAutreCompte(releves: number, empreinte = "fedcba9876543210") {
    localStorage.setItem(`bdri:${empreinte}:compteurs`, JSON.stringify({ saisies: 0, releves, maj: "2026-10-25T08:00:00.000Z" }));
  }

  it("des releves d'un autre compte en attente sont DITS (compteur seulement) sans bloquer le depart", async () => {
    installerGeolocalisation();
    semerCompteurAutreCompte(2);
    rendre();
    const info = await screen.findByText(/2 relevés d'autres comptes sont en attente sur ce téléphone/);
    expect(info).toHaveTextContent(/illisible depuis ce compte/);
    expect(info).toHaveAttribute("role", "status");
    // Le second compte peut demarrer son propre releve.
    const bouton = await screen.findByRole("button", { name: /Démarrer l'enregistrement/ });
    expect(bouton).toBeEnabled();
    fireEvent.click(bouton);
    await screen.findByText("Enregistrement en cours");
  });

  it("un seul releve d'un autre compte : formulation au singulier", async () => {
    installerGeolocalisation();
    semerCompteurAutreCompte(1);
    rendre();
    expect(await screen.findByText(/Un relevé d'un autre compte est en attente sur ce téléphone/)).toBeInTheDocument();
  });

  it("aucun releve d'un autre compte : aucun message, et le compteur du compte courant n'est jamais presente comme « autre »", async () => {
    installerGeolocalisation();
    semerCompteurAutreCompte(0);
    localStorage.setItem("bdri:0123456789abcdef:compteurs", JSON.stringify({ saisies: 0, releves: 3, maj: "2026-10-25T08:00:00.000Z" }));
    rendre();
    await screen.findByRole("button", { name: /Démarrer l'enregistrement/ });
    expect(screen.queryByText(/autre compte|autres comptes/)).not.toBeInTheDocument();
  });

  it("une session du MEME compte reste proposee a la reprise comme avant", async () => {
    installerGeolocalisation();
    await semerSession("agent-1", { arretee: false });
    rendre();
    expect(await screen.findByRole("heading", { name: /Une session a été retrouvée/ })).toBeInTheDocument();
    expect(screen.queryByText(/autre compte/)).not.toBeInTheDocument();
  });

  it("zero violation d'accessibilite : releves d'un autre compte signales", async () => {
    installerGeolocalisation();
    semerCompteurAutreCompte(2);
    const { container } = rendre();
    await screen.findByText(/relevés d'autres comptes/);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

describe("journal du telephone : erreurs typees du stockage local", () => {
  /** Chiffreur dont l'etat de verrou se commande : le compte est ouvert, le coffre verrouille puis deverrouille. */
  function ouvrirCompteVerrouille() {
    let deverrouille = false;
    const chiffreur = { estDeverrouille: () => deverrouille } as unknown as Chiffreur;
    fermerCompte();
    ouvrirCompte({ compteId: "agent-1", empreinte: "0123456789abcdef", chiffreur });
    return { deverrouiller: () => { deverrouille = true; ouvrirCompte({ compteId: "agent-1", empreinte: "0123456789abcdef", chiffreur }); } };
  }

  it("coffre verrouille a l'ouverture : l'erreur est DITE, le depart reste inactif (il viderait un journal illisible), et se rouvre au deverrouillage", async () => {
    installerGeolocalisation();
    const stockage = await stockageBrut();
    const verrou = ouvrirCompteVerrouille();
    const lecture = vi.spyOn(stockage, "toutes").mockRejectedValueOnce(new ErreurStockageLocal("COFFRE_VERROUILLE"));
    const vider = vi.spyOn(stockage, "vider");
    try {
      rendre();
      const alerte = await screen.findByRole("alert");
      expect(alerte).toHaveTextContent(/session locale est verrouillée/);
      const bouton = screen.getByRole("button", { name: /Démarrage impossible pour l'instant/ });
      expect(bouton).toBeDisabled();
      fireEvent.click(bouton);
      expect(vider).not.toHaveBeenCalled();

      // Deverrouillage : la lecture est refaite, l'alerte disparait, le depart s'ouvre.
      await act(async () => { verrou.deverrouiller(); });
      expect(await screen.findByRole("button", { name: /Démarrer l'enregistrement/ })).toBeEnabled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(lecture).toHaveBeenCalledTimes(2);
    } finally {
      lecture.mockRestore();
      vider.mockRestore();
    }
  });

  it("aucun compte ouvert : le message du stockage est affiche, sans plantage ni depart", async () => {
    installerGeolocalisation();
    const stockage = await stockageBrut();
    const lecture = vi.spyOn(stockage, "toutes").mockRejectedValueOnce(new ErreurStockageLocal("AUCUN_COMPTE"));
    try {
      rendre();
      const alerte = await screen.findByRole("alert");
      expect(alerte).toHaveTextContent(/Aucun compte n'est ouvert sur cet appareil/);
      expect(screen.getByRole("button", { name: /Démarrage impossible pour l'instant/ })).toBeDisabled();
    } finally {
      lecture.mockRestore();
    }
  });

  it("le journal ne peut pas etre prepare au depart (coffre verrouille entre-temps) : releve NON demarre, message PIN, aucune session fantome", async () => {
    installerGeolocalisation();
    const stockage = await stockageBrut();
    rendre();
    const bouton = await screen.findByRole("button", { name: /Démarrer l'enregistrement/ });
    const vider = vi.spyOn(stockage, "vider").mockRejectedValueOnce(new ErreurStockageLocal("COFFRE_VERROUILLE"));
    try {
      fireEvent.click(bouton);
      const alerte = await screen.findByRole("alert");
      expect(alerte).toHaveTextContent("Déverrouillez avec votre PIN pour enregistrer.");
      expect(screen.queryByText("Enregistrement en cours")).not.toBeInTheDocument();
      expect(h.suivi.ok).toBeNull();                  // le GPS n'a pas ete demande
      expect(roulageEstActif()).toBe(false);
    } finally {
      vider.mockRestore();
    }
  });

  it("effacer une session quand le journal refuse : rien n'est annonce supprime, la session reste a l'ecran", async () => {
    installerGeolocalisation();
    const stockage = await stockageBrut();
    rendre();
    await demarrer();
    for (let s = 0; s < 3; s += 1) emettre(s);
    fireEvent.click(screen.getByRole("button", { name: /Arrêter/ }));
    await screen.findByText("Terminée, à envoyer");
    const vider = vi.spyOn(stockage, "vider").mockRejectedValueOnce(new ErreurStockageLocal("COFFRE_VERROUILLE"));
    try {
      fireEvent.click(screen.getByRole("button", { name: /Supprimer sans envoyer/ }));
      fireEvent.click(await screen.findByRole("button", { name: "Oui, supprimer" }));
      const alerte = await screen.findByRole("alert");
      expect(alerte).toHaveTextContent(/session locale est verrouillée/);
      expect(screen.getByText("Terminée, à envoyer")).toBeInTheDocument();
    } finally {
      vider.mockRestore();
    }
  });
});

describe("activite pendant le releve (verrou d'inactivite differe)", () => {
  function ecouterActivite() {
    const signaux = { n: 0 };
    const quitter = surActivite(() => { signaux.n += 1; });
    return { signaux, quitter };
  }

  it("un releve ACTIF se declare actif et chaque point GNSS signale l'activite (au plus un signal par 10 s)", async () => {
    installerGeolocalisation();
    const { signaux, quitter } = ecouterActivite();
    try {
      rendre();
      expect(roulageEstActif()).toBe(false);
      await demarrer();
      await waitFor(() => expect(roulageEstActif()).toBe(true));
      const apresDemarrage = signaux.n;           // la declaration d'activite signale elle-meme une fois
      emettre(0);
      expect(signaux.n).toBe(apresDemarrage + 1);
      emettre(1); emettre(2); emettre(5);
      expect(signaux.n).toBe(apresDemarrage + 1);  // meme fenetre de 10 s : pas de signal de plus
      emettre(12);
      expect(signaux.n).toBe(apresDemarrage + 2);  // fenetre suivante
    } finally {
      quitter();
    }
  });

  it("l'arret du releve retire la declaration, et un point recu apres l'arret ne signale rien", async () => {
    installerGeolocalisation();
    const { signaux, quitter } = ecouterActivite();
    try {
      rendre();
      await demarrer();
      emettre(0); emettre(1); emettre(2);
      await waitFor(() => expect(roulageEstActif()).toBe(true));
      fireEvent.click(screen.getByRole("button", { name: /Arrêter/ }));
      await screen.findByText("Terminée, à envoyer");
      await waitFor(() => expect(roulageEstActif()).toBe(false));
      const avant = signaux.n;
      emettre(60);
      expect(signaux.n).toBe(avant);
    } finally {
      quitter();
    }
  });

  it("en pause, le releve n'est plus declare actif (le telephone peut se verrouiller), et la reprise le redeclare", async () => {
    installerGeolocalisation();
    rendre();
    await demarrer();
    emettre(0);
    await waitFor(() => expect(roulageEstActif()).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: /Pause/ }));
    await waitFor(() => expect(roulageEstActif()).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: /Reprendre/ }));
    await waitFor(() => expect(roulageEstActif()).toBe(true));
  });

  it("sans releve demarre, aucune activite n'est declaree ni signalee", async () => {
    installerGeolocalisation();
    const { signaux, quitter } = ecouterActivite();
    try {
      rendre();
      await screen.findByRole("button", { name: /Démarrer l'enregistrement/ });
      expect(roulageEstActif()).toBe(false);
      expect(signaux.n).toBe(0);
    } finally {
      quitter();
    }
  });

  it("le demontage de la page retire la declaration : un releve qui n'existe plus ne differe aucun verrou", async () => {
    installerGeolocalisation();
    const { unmount } = rendre();
    await demarrer();
    await waitFor(() => expect(roulageEstActif()).toBe(true));
    unmount();
    expect(roulageEstActif()).toBe(false);
  });

  it("une session retrouvee mais non reprise n'est pas un releve actif", async () => {
    installerGeolocalisation();
    await semerSession("agent-1", { arretee: false });
    rendre();
    expect(await screen.findByRole("heading", { name: /Une session a été retrouvée/ })).toBeInTheDocument();
    expect(roulageEstActif()).toBe(false);
  });
});

describe("journal : fermeture au demontage de l'ecran (chantier D8c)", () => {
  it("le demontage ferme le journal ouvert, une seule fois ; l'ecran remonte ensuite avec un journal utilisable", async () => {
    installerGeolocalisation();
    const vue = rendre();
    await screen.findByRole("button", { name: /Démarrer l'enregistrement/ });      // le journal a ete ouvert et lu
    expect(h.fermetures).toBe(0);

    vue.unmount();

    expect(h.fermetures).toBe(1);                                                    // ecouteurs du journal retires, une fois
    rendre();
    expect(await screen.findByRole("button", { name: /Démarrer l'enregistrement/ })).toBeEnabled();
  });

  it("des entrees encore en tampon (coffre verrouille) ne sont PAS jetees : le journal n'est pas ferme, son abonnement les ecrira au deverrouillage", async () => {
    installerGeolocalisation();
    const vue = rendre();
    await screen.findByRole("button", { name: /Démarrer l'enregistrement/ });
    h.enAttenteJournal = 3;

    vue.unmount();

    expect(h.fermetures).toBe(0);
  });
});
