// @vitest-environment node
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compteCourant, fermerCompte } from "../lib/compteCourant";
import { lireIndice } from "../lib/effacementLocal";
import type { Role } from "../types";
import type { CanalOnglets, MessageCanal } from "./canalOnglets";
import { listerComptesAvecCoffre, sha256WebCrypto, stockageEnMemoire, type CoffreSession, type StockageCoffre } from "./coffreSession";
import { empreinteCompte } from "./compteLocal";
import { creerJournal, type CorpsLotEvenements } from "./journalEvenementsLocaux";
import type { ComptesFile } from "./politiqueDeconnexion";
import {
  cheminCanonique, ControleurSession, routeUtiliseLaFile,
  type ResultatRafraichissement, type ServeurSession, type UtilisateurServeur,
} from "./useSessionLocale";

/**
 * Chantier D8 : corrections de l'INTEGRATION apres la relecture independante (les attaques qui ont revele les defauts sont
 * reprises ici comme tests de non-regression). Vrai noyau, vrai coffre (1 000 iterations de test), fake-indexeddb, horloge injectee.
 */

const T0 = Date.parse("2026-10-25T08:00:00.000Z");
const MIN = 60_000;
const HEURE = 60 * MIN;
const PIN = "Zx-91-pin";
const VIDE: ComptesFile = { enAttente: 0, enErreur: 0, abandonnees: 0, enConflit: 0, photosEnFile: 0, relevesNonConfirmes: 0 };

function fauxLocalStorage() {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; }, key: (i: number) => [...m.keys()][i] ?? null, getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(),
  };
}

const agent = (id: string): UtilisateurServeur => ({
  id, email: `${id}@ageroute.test`, nomComplet: `Agent ${id}`, role: "INSPECTEUR" as Role, actif: true,
  modulesAutorises: ["inspections"], peutDeleguerValidation: false, createdAt: "2026-01-01T00:00:00.000Z", regions: [1], perimetreNational: false,
});

function fauxServeur(utilisateur: UtilisateurServeur) {
  const e = { moi: utilisateur, moiAppels: 0, reseau: true, evenements: [] as CorpsLotEvenements[], deconnexions: [] as boolean[] };
  const serveur: ServeurSession = {
    async connexion() { return { accessToken: "jeton", user: e.moi }; },
    async verifierDeuxFacteurs() { return { accessToken: "jeton", user: e.moi }; },
    async moi() { e.moiAppels += 1; if (!e.reseau) throw {}; return e.moi; },
    async deconnexion(tous) { e.deconnexions.push(tous); return e.reseau; },
    async rafraichirAuDemarrage(): Promise<ResultatRafraichissement> { return e.reseau ? { etat: "OK", token: "j" } : { etat: "RESEAU_COUPE" }; },
    async sonder(): Promise<ResultatRafraichissement> { return e.reseau ? { etat: "OK", token: "j2" } : { etat: "RESEAU_COUPE" }; },
    async envoyerEvenements(corps) { e.evenements.push(corps); },
    poserJeton() { /* rien */ },
    appareilServeurId: () => null,
  };
  return { serveur, e };
}

/** Canal en memoire entre plusieurs onglets simules : un message n'est jamais livre a son emetteur. */
function concentrateur() {
  const abonnes: Array<{ auteur: string; fn: (m: MessageCanal) => void }> = [];
  return {
    creer(auteur: string): CanalOnglets {
      return {
        auteur,
        publier(type, empreinte) { for (const a of [...abonnes]) if (a.auteur !== auteur) a.fn({ type, empreinte, auteur }); },
        ecouter(fn) { const a = { auteur, fn }; abonnes.push(a); return () => { abonnes.splice(abonnes.indexOf(a), 1); }; },
        fermer() { /* rien */ },
      };
    },
  };
}

let h: { t: number };
let stockageCoffre: StockageCoffre;
let marqueur: { present: boolean };
const controleurs: ControleurSession[] = [];

function nouveau(serveur: ServeurSession, canal: CanalOnglets | null = null, decompte: () => Promise<ComptesFile> = async () => VIDE) {
  const c = new ControleurSession({
    serveur, stockageCoffre, stockageTexte: localStorage as never, idAppareilLocal: () => "tel-1", maintenant: () => h.t,
    marqueur: { present: () => marqueur.present, poser: () => { marqueur.present = true; }, purger: () => { marqueur.present = false; } },
    sha256: sha256WebCrypto, optionsCoffre: { iterations: 1000, iterationsDeTest: true },
    decompteFile: decompte, retourReseauMs: 0, canal,
  });
  controleurs.push(c);
  return c;
}

const coffreCourant = () => compteCourant()?.chiffreur as unknown as CoffreSession;
const journalDe = (empreinte: string) => creerJournal({ empreinte, stockage: localStorage }).lire().map((x) => x.evenement);

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("localStorage", fauxLocalStorage());
  fermerCompte();
  h = { t: T0 };
  stockageCoffre = stockageEnMemoire();
  marqueur = { present: true };
});
afterEach(() => {
  for (const c of controleurs.splice(0)) c.desactiver();
  fermerCompte();
  vi.restoreAllMocks();
});

async function ouvrirSession(c: ControleurSession) {
  await c.demarrer();
  await c.connecter("a@x", "pw");
  expect(await c.creerPin(PIN)).toEqual({ ok: true });
}

// ---------------------------------------------------------------------------------------------------
describe("defaut 8 : le pont du releve est plafonne et n'annule pas le verrou d'arriere-plan", () => {
  it("24 h de points GNSS (un toutes les 10 s) : la cle est oubliee apres 30 min + 5 min sans interaction, plus de 24 h deverrouille", async () => {
    const { serveur } = fauxServeur(agent("agent-A"));
    const c = nouveau(serveur);
    await ouvrirSession(c);
    let verrouA: number | null = null;
    for (let i = 1; i <= 24 * 360; i += 1) {
      h.t += 10_000;
      c.signalerActiviteExterne();
      if (i % 6 === 0) c.tick();
      if (verrouA === null && !c.instantane().deverrouille) verrouA = h.t - T0;
    }
    expect(verrouA).not.toBeNull();
    expect(verrouA as number).toBeLessThanOrEqual(30 * MIN + 5 * MIN + MIN); // plafond + inactivite + un tick par minute
    expect(verrouA as number).toBeGreaterThan(30 * MIN);
    expect(c.instantane().deverrouille).toBe(false);
  });

  it("30 min en arriere-plan avec un point GNSS toutes les 10 s : verrouille apres 2 min", async () => {
    const { serveur } = fauxServeur(agent("agent-A"));
    const c = nouveau(serveur);
    await ouvrirSession(c);
    c.signalerArrierePlan();
    let verrouA: number | null = null;
    for (let i = 1; i <= 180; i += 1) {
      h.t += 10_000;
      c.signalerActiviteExterne();
      c.tick();
      if (verrouA === null && !c.instantane().deverrouille) verrouA = h.t - T0;
    }
    expect(verrouA).toBe(2 * MIN);
    expect(c.instantane().deverrouille).toBe(false);
  });

  it("l'interaction REELLE de l'agent differe toujours le verrou", async () => {
    const { serveur } = fauxServeur(agent("agent-A"));
    const c = nouveau(serveur);
    await ouvrirSession(c);
    for (let i = 0; i < 20; i += 1) { h.t += 4 * MIN; c.signalerActivite(); c.tick(); }
    expect(c.instantane().deverrouille).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("defaut 4 : un rafraichissement OK n'est pas celui du bon compte (cookie partage entre onglets)", () => {
  it("refresh OK mais /auth/me rend B : la session de A est FERMEE, rien n'est prolonge, rien n'est envoye, la file reste", async () => {
    const { serveur, e } = fauxServeur(agent("agent-A"));
    const c = nouveau(serveur);
    await ouvrirSession(c);
    const coffre = coffreCourant();
    const prolonger = vi.spyOn(coffre, "prolonger");
    const revalider = vi.spyOn(coffre, "revalider");
    const profilAvant = coffre.profilCourant();
    for (let i = 0; i < 15; i += 1) { h.t += 4 * MIN; c.signalerActivite(); c.tick(); }
    e.evenements.length = 0;
    e.moi = agent("agent-B"); // l'autre onglet a connecte B : le cookie partage est celui de B

    await c.surRafraichissement({ etat: "OK", token: "jeton-de-B" });

    const s = c.instantane();
    expect(e.moiAppels).toBeGreaterThan(0);
    expect(prolonger).not.toHaveBeenCalled();
    expect(revalider).not.toHaveBeenCalled();
    expect(coffre.profilCourant()).toBeNull(); // cle oubliee
    expect(s.etat).toBe("FERME");
    expect(s.utilisateur).toBeNull();
    expect(s.deverrouille).toBe(false);
    expect(s.messageFermeture).toMatch(/autre compte/);
    expect(s.messageFermeture).toMatch(/restent chiffrées/);
    expect(compteCourant()).toBeNull();
    expect(profilAvant?.userId).toBe("agent-A");
    // Le journal de A ne part pas sous B ; la file (le coffre) est conservee ; le cookie reste utilisable par l'onglet de B.
    await Promise.resolve();
    expect(e.evenements).toEqual([]);
    expect(await listerComptesAvecCoffre(stockageCoffre)).toEqual(["agent-A"]);
    expect(marqueur.present).toBe(true);
    // A reste dans l'indice : il pourra s'ouvrir hors ligne.
    expect(Object.keys(lireIndice(localStorage as never).comptes)).toContain("agent-A");
  });

  it("temoin : refresh OK et /auth/me rend A : la session est prolongee comme avant", async () => {
    const { serveur } = fauxServeur(agent("agent-A"));
    const c = nouveau(serveur);
    await ouvrirSession(c);
    const prolonger = vi.spyOn(coffreCourant(), "prolonger");
    h.t += 2 * MIN; c.signalerActivite();
    await c.surRafraichissement({ etat: "OK", token: "j" });
    expect(prolonger).toHaveBeenCalledTimes(1);
    expect(c.instantane().etat).toBe("EN_LIGNE");
  });

  it("hors ligne puis refresh OK du cookie de B : A ne passe PAS EN_LIGNE", async () => {
    const A = fauxServeur(agent("agent-A"));
    const premier = nouveau(A.serveur);
    await ouvrirSession(premier);
    premier.desactiver(); fermerCompte();
    const hors = fauxServeur(agent("agent-A"));
    hors.e.reseau = false;
    const c = nouveau(hors.serveur);
    await c.demarrer();
    expect((await c.deverrouiller(PIN)).ok).toBe(true);
    expect(c.instantane().etat).toBe("HORS_LIGNE_OUVERT");
    hors.e.reseau = true;
    hors.e.moi = agent("agent-B");
    await c.surRafraichissement({ etat: "OK", token: "jeton-de-B" });
    expect(c.instantane().etat).toBe("FERME");
    expect(c.instantane().utilisateur).toBeNull();
  });

  it("refresh OK mais /auth/me refuse (401) : la session se ferme (REFUSE), sans prolongation", async () => {
    const { serveur, e } = fauxServeur(agent("agent-A"));
    const c = nouveau(serveur);
    await ouvrirSession(c);
    const prolonger = vi.spyOn(coffreCourant(), "prolonger");
    e.moi = undefined as never;
    serveur.moi = async () => { throw { response: { status: 401 } }; };
    await c.surRafraichissement({ etat: "OK", token: "j" });
    expect(prolonger).not.toHaveBeenCalled();
    expect(c.instantane().etat).toBe("FERME");
  });
});

// ---------------------------------------------------------------------------------------------------
describe("defaut 2 : cache de requetes vide a chaque sortie de session et a chaque changement de compte", () => {
  it("deconnexion, fermeture par le serveur, expiration, reinitialisation, effacement et changement de compte previennent les abonnes", async () => {
    const A = fauxServeur(agent("agent-A"));
    const c = nouveau(A.serveur);
    const sortie = vi.fn();
    c.surSortieDeSession(sortie);
    await c.demarrer();
    await c.connecter("a@x", "pw");
    expect(sortie).toHaveBeenCalled(); // premier compte pris : le cache de la page publique ne sert pas au compte
    await c.creerPin(PIN);

    sortie.mockClear();
    await c.deconnecter();
    expect(sortie).toHaveBeenCalled();

    // reinitialisation
    await c.connecter("a@x", "pw");
    sortie.mockClear();
    expect((await c.reinitialiserPin()).ok).toBe(true);
    expect(sortie).toHaveBeenCalled();

    // effacement
    await c.creerPin(PIN);
    sortie.mockClear();
    expect((await c.effacerDonneesLocales()).ok).toBe(true);
    expect(sortie).toHaveBeenCalled();

    // changement de compte
    A.e.moi = agent("agent-B");
    sortie.mockClear();
    await c.deconnecter();
    sortie.mockClear();
    await c.connecter("b@x", "pw");
    expect(sortie).toHaveBeenCalled();
  });

  it("expiration hors ligne : les abonnes sont prevenus", async () => {
    const A = fauxServeur(agent("agent-A"));
    const premier = nouveau(A.serveur);
    await ouvrirSession(premier);
    premier.desactiver(); fermerCompte();
    const hors = fauxServeur(agent("agent-A"));
    hors.e.reseau = false;
    const c = nouveau(hors.serveur);
    await c.demarrer();
    await c.deverrouiller(PIN);
    const sortie = vi.fn();
    c.surSortieDeSession(sortie);
    h.t += 8 * 24 * HEURE;
    c.tick();
    expect(c.instantane().etat).toBe("EXPIRE");
    expect(sortie).toHaveBeenCalledTimes(1);
  });

  it("un abonne desabonne n'est plus appele, un abonne qui leve ne bloque pas les autres", async () => {
    const A = fauxServeur(agent("agent-A"));
    const c = nouveau(A.serveur);
    const a = vi.fn(); const b = vi.fn(() => { throw new Error("x"); }); const d = vi.fn();
    const stopA = c.surSortieDeSession(a); c.surSortieDeSession(b); c.surSortieDeSession(d);
    stopA();
    await c.demarrer();
    await c.connecter("a@x", "pw");
    expect(a).not.toHaveBeenCalled();
    expect(d).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------
describe("defaut 5 : signal entre onglets (reinitialisation, effacement, fermeture, changement de compte)", () => {
  /** Deux onglets du meme appareil, tous deux connectes en A, cle en memoire. */
  async function deuxOnglets() {
    const hub = concentrateur();
    const sA = fauxServeur(agent("agent-A"));
    const onglet1 = nouveau(sA.serveur, hub.creer("onglet-1"));
    await ouvrirSession(onglet1);
    onglet1.activer();
    const sA2 = fauxServeur(agent("agent-A"));
    const onglet2 = nouveau(sA2.serveur, hub.creer("onglet-2"));
    await onglet2.demarrer();
    await onglet2.connecter("a@x", "pw");
    expect((await onglet2.deverrouiller(PIN)).ok).toBe(true);
    onglet2.activer();
    expect(onglet2.instantane()).toMatchObject({ etat: "EN_LIGNE", deverrouille: true });
    const empreinte = await empreinteCompte("agent-A", sha256WebCrypto);
    return { hub, onglet1, onglet2, sA, sA2, empreinte };
  }

  it("reinitialisation du PIN dans l'onglet 1 : l'onglet 2 verrouille, ferme le compte et le dit ; un seul PIN_REINITIALISE au journal", async () => {
    const { onglet1, onglet2, empreinte } = await deuxOnglets();
    expect((await onglet1.reinitialiserPin()).ok).toBe(true);
    const s = onglet2.instantane();
    expect(s.deverrouille).toBe(false);
    expect(s.utilisateur).toBeNull();
    expect(s.coffrePresent).toBe(false);
    expect(s.etat).toBe("DECONNECTE");
    expect(s.messageFermeture).toMatch(/réinitialisé dans un autre onglet/);
    expect(compteCourant()).toBeNull();
    expect(journalDe(empreinte).filter((x) => x === "PIN_REINITIALISE")).toHaveLength(1);
    expect(marqueur.present).toBe(true); // le cookie de rafraichissement reste valide
  });

  it("effacement local dans l'onglet 1 : l'onglet 2 ferme le compte", async () => {
    const { onglet1, onglet2, empreinte } = await deuxOnglets();
    expect((await onglet1.effacerDonneesLocales()).ok).toBe(true);
    const s = onglet2.instantane();
    expect(s).toMatchObject({ etat: "DECONNECTE", deverrouille: false, utilisateur: null });
    expect(s.messageFermeture).toMatch(/effacées dans un autre onglet/);
    expect(journalDe(empreinte).filter((x) => x === "EFFACEMENT_LOCAL")).toHaveLength(1);
  });

  it("deconnexion dans l'onglet 1 : l'onglet 2 ferme sa session", async () => {
    const { onglet1, onglet2 } = await deuxOnglets();
    await onglet1.deconnecter();
    const s = onglet2.instantane();
    expect(s).toMatchObject({ etat: "FERME", deverrouille: false, utilisateur: null });
    expect(s.messageFermeture).toMatch(/déconnecté dans un autre onglet/);
    expect(await listerComptesAvecCoffre(stockageCoffre)).toEqual(["agent-A"]); // rien n'est efface
  });

  it("un AUTRE compte s'ouvre dans l'onglet 1 : l'onglet 2 (compte A) se ferme, le cookie reste (il est a l'autre compte)", async () => {
    const { hub, onglet2, empreinte } = await deuxOnglets();
    const sB = fauxServeur(agent("agent-B"));
    const onglet1b = nouveau(sB.serveur, hub.creer("onglet-3"));
    await onglet1b.demarrer();
    await onglet1b.connecter("b@x", "pw");
    const s = onglet2.instantane();
    expect(s).toMatchObject({ etat: "FERME", deverrouille: false, utilisateur: null });
    expect(s.messageFermeture).toMatch(/autre compte/);
    expect(marqueur.present).toBe(true);
    expect(Object.keys(lireIndice(localStorage as never).comptes)).toContain("agent-A");
    expect(journalDe(empreinte)).toContain("SESSION_LOCALE_FERMEE");
  });

  it("un message qui concerne un AUTRE compte que celui de l'onglet est ignore ; un onglet sans compte aussi", async () => {
    const { hub, onglet2 } = await deuxOnglets();
    const autreEmpreinte = await empreinteCompte("agent-Z", sha256WebCrypto);
    const emetteur = hub.creer("intrus");
    emetteur.publier("PIN_REINITIALISE", autreEmpreinte);
    emetteur.publier("EFFACEMENT_LOCAL", autreEmpreinte);
    emetteur.publier("SESSION_FERMEE", autreEmpreinte);
    expect(onglet2.instantane()).toMatchObject({ etat: "EN_LIGNE", deverrouille: true });
    const nu = nouveau(fauxServeur(agent("agent-A")).serveur, hub.creer("nu"));
    nu.activer();
    emetteur.publier("PIN_REINITIALISE", await empreinteCompte("agent-A", sha256WebCrypto));
    expect(nu.instantane().etat).toBe("DECONNECTE");
  });

  it("l'onglet emetteur ne se ferme pas lui-meme (le canal ne lui livre pas son message)", async () => {
    const { onglet1 } = await deuxOnglets();
    await onglet1.deconnecter();
    expect(onglet1.instantane().etat).toBe("FERME"); // fermeture voulue, une seule fois
    expect(onglet1.instantane().messageFermeture).toBeNull();
  });

  it("apres desactivation, un onglet n'ecoute plus", async () => {
    const { onglet1, onglet2 } = await deuxOnglets();
    onglet2.desactiver();
    await onglet1.deconnecter();
    expect(onglet2.instantane().etat).toBe("EN_LIGNE");
  });
});

// ---------------------------------------------------------------------------------------------------
describe("defaut 12 : reinitialisation ou effacement hors ligne", () => {
  it("l'utilisateur est annule (l'etat est DECONNECTE, il n'y a plus rien a ouvrir)", async () => {
    const premier = nouveau(fauxServeur(agent("agent-A")).serveur);
    await ouvrirSession(premier);
    premier.desactiver(); fermerCompte();
    const hors = fauxServeur(agent("agent-A"));
    hors.e.reseau = false;
    const c = nouveau(hors.serveur);
    await c.demarrer();
    await c.deverrouiller(PIN);
    expect(c.instantane().utilisateur?.id).toBe("agent-A");
    expect((await c.reinitialiserPin()).ok).toBe(true);
    expect(c.instantane()).toMatchObject({ etat: "DECONNECTE", utilisateur: null });
  });

  it("effacement hors ligne : meme chose", async () => {
    const premier = nouveau(fauxServeur(agent("agent-A")).serveur);
    await ouvrirSession(premier);
    premier.desactiver(); fermerCompte();
    const hors = fauxServeur(agent("agent-A"));
    hors.e.reseau = false;
    const c = nouveau(hors.serveur);
    await c.demarrer();
    await c.deverrouiller(PIN);
    expect((await c.effacerDonneesLocales()).ok).toBe(true);
    expect(c.instantane()).toMatchObject({ etat: "DECONNECTE", utilisateur: null });
  });

  it("temoin : en ligne, l'agent reste connecte (il peut recreer un code)", async () => {
    const c = nouveau(fauxServeur(agent("agent-A")).serveur);
    await ouvrirSession(c);
    expect((await c.reinitialiserPin()).ok).toBe(true);
    expect(c.instantane()).toMatchObject({ etat: "EN_LIGNE", pinACreer: true });
    expect(c.instantane().utilisateur?.id).toBe("agent-A");
  });
});

// ---------------------------------------------------------------------------------------------------
describe("defaut 11 : routeUtiliseLaFile ne depend ni de la casse, ni de la barre finale, ni des barres doublees", () => {
  it.each([
    "/inspections/terrain", "/Inspections/Terrain", "/INSPECTIONS/TERRAIN/", "/inspections//terrain", "/inspections/terrain///",
    "/%69nspections/terrain", "/inspections/Terrain/Defauts", "/Inspections/Releve/Enregistrer/",
  ])("%s exige le PIN", (chemin) => {
    expect(routeUtiliseLaFile(chemin)).toBe(true);
  });

  it.each(["/", "/inspections", "/inspections/releve", "/inspections/terrain/autre", "/carte", "/inspections/terrain-x"])("%s ne l'exige pas", (chemin) => {
    expect(routeUtiliseLaFile(chemin)).toBe(false);
  });

  it("un chemin mal forme ne leve pas", () => {
    expect(cheminCanonique("/%E0%A4%A")).toBe("/%e0%a4%a");
    expect(routeUtiliseLaFile("/%E0%A4%A")).toBe(false);
  });
});
