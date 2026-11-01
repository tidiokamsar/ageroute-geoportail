// @vitest-environment node
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fermerCompte } from "../lib/compteCourant";
import type { Role } from "../types";
import { sha256WebCrypto, stockageEnMemoire } from "./coffreSession";
import { empreinteCompte } from "./compteLocal";
import { creerJournal } from "./journalEvenementsLocaux";
import type { ComptesFile } from "./politiqueDeconnexion";
import { ControleurSession, type ServeurSession, type UtilisateurServeur } from "./useSessionLocale";

/**
 * Le controleur de session journalise l'ARRET de la synchronisation (appareil retire, compte inactif) dans le journal des
 * evenements locaux, et seulement l'arret. L'etat d'arret est celui de `lib/offlineSync.ts` : ici un faux emetteur le remplace, car
 * ce qu'on defend est l'abonnement et la trace, pas la detection (eprouvee dans `lib/offlineSync.droits.test.ts`).
 */

const h = vi.hoisted(() => ({ ecouteurs: new Set<(etat: unknown) => void>() }));
vi.mock("../lib/offlineSync", () => ({
  surEtatSynchronisation: (cb: (etat: unknown) => void) => { h.ecouteurs.add(cb); return () => { h.ecouteurs.delete(cb); }; },
}));

const T0 = Date.parse("2026-10-25T08:00:00.000Z");
const PIN = "Zx-91-pin";
const VIDE: ComptesFile = { enAttente: 0, enErreur: 0, abandonnees: 0, enConflit: 0, photosEnFile: 0, relevesNonConfirmes: 0 };
const ETAT_REVOQUE = { appareilRevoque: true, compteInactif: false, message: "Cet appareil a été retiré par l'administration." };
const ETAT_INACTIF = { appareilRevoque: false, compteInactif: true, message: "Votre compte est désactivé ou verrouillé." };
const ETAT_LIBRE = { appareilRevoque: false, compteInactif: false, message: null };
const emettre = (etat: unknown) => { for (const e of [...h.ecouteurs]) e(etat); };

function fauxLocalStorage() {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; }, key: (i: number) => [...m.keys()][i] ?? null, getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(),
  };
}

const utilisateur: UtilisateurServeur = {
  id: "agent-A", email: "agent-A@ageroute.test", nomComplet: "Agent A", role: "INSPECTEUR" as Role, actif: true,
  modulesAutorises: ["inspections"], peutDeleguerValidation: false, createdAt: "2026-01-01T00:00:00.000Z", regions: [1], perimetreNational: false,
};

const serveur: ServeurSession = {
  async connexion() { return { accessToken: "jeton", user: utilisateur }; },
  async verifierDeuxFacteurs() { return { accessToken: "jeton", user: utilisateur }; },
  async moi() { return utilisateur; },
  async deconnexion() { return true; },
  async rafraichirAuDemarrage() { return { etat: "OK", token: "jeton" }; },
  async sonder() { return { etat: "OK", token: "jeton" }; },
  async envoyerEvenements() { /* l'envoi n'est pas l'objet */ },
  poserJeton() { /* sans objet */ },
  appareilServeurId: () => null,
};

let controleurs: ControleurSession[] = [];
let horloge = T0;

function nouveau(): ControleurSession {
  const c = new ControleurSession({
    serveur, stockageCoffre: stockageEnMemoire(), stockageTexte: localStorage as unknown as ReturnType<typeof fauxLocalStorage>,
    idAppareilLocal: () => "tel-1", maintenant: () => horloge,
    marqueur: { present: () => true, poser: () => undefined, purger: () => undefined },
    sha256: sha256WebCrypto, optionsCoffre: { iterations: 1000, iterationsDeTest: true },
    decompteFile: async () => VIDE, retourReseauMs: 0,
  });
  controleurs.push(c);
  return c;
}

async function sessionOuverte() {
  const c = nouveau();
  c.activer();
  await c.demarrer();
  await c.connecter(utilisateur.email, "motdepasse");
  expect(await c.creerPin(PIN)).toEqual({ ok: true });
  const empreinte = await empreinteCompte(utilisateur.id, sha256WebCrypto);
  return { c, empreinte, evenements: () => creerJournal({ empreinte, stockage: localStorage }).lire() };
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("localStorage", fauxLocalStorage());
  fermerCompte();
  h.ecouteurs.clear();
  controleurs = [];
  horloge = T0;
});
afterEach(() => {
  for (const c of controleurs) c.desactiver();
  vi.restoreAllMocks();
  fermerCompte();
});

describe("journal des evenements locaux : arret de la synchronisation", () => {
  it("un appareil retire est journalise, une fois, avec l'horodatage du poste (non fiable) et sans aucun contenu", async () => {
    const { c, evenements } = await sessionOuverte();
    expect(evenements()).toEqual([]);
    horloge = T0 + 5_000;
    emettre(ETAT_REVOQUE);
    const e = evenements();
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ evenement: "SESSION_LOCALE_FERMEE", horodatageClient: new Date(T0 + 5_000).toISOString() });
    // Que les champs de la liste fermee du serveur : ni message, ni cause, ni identifiant d'appareil.
    expect(Object.keys(e[0]).sort()).toEqual(["evenement", "horodatageClient", "id"]);
    expect(c.instantane().envoiJournalEnAttente).toBe(1);
  });

  it("un compte inactif est journalise de la meme facon", async () => {
    const { evenements } = await sessionOuverte();
    emettre(ETAT_INACTIF);
    expect(evenements().map((x) => x.evenement)).toEqual(["SESSION_LOCALE_FERMEE"]);
  });

  it("la LEVEE de l'arret n'est pas journalisee", async () => {
    const { evenements } = await sessionOuverte();
    emettre(ETAT_REVOQUE);
    emettre(ETAT_LIBRE);
    expect(evenements()).toHaveLength(1);
  });

  it("apres desactivation du controleur, plus rien n'est journalise (pas d'abonnement qui fuit)", async () => {
    const { c, evenements } = await sessionOuverte();
    expect(h.ecouteurs.size).toBe(1);
    c.desactiver();
    expect(h.ecouteurs.size).toBe(0);
    emettre(ETAT_REVOQUE);
    expect(evenements()).toEqual([]);
  });

  it("activer deux fois (StrictMode) ne cree qu'un abonnement : un arret = un evenement", async () => {
    const { c, evenements } = await sessionOuverte();
    c.activer();
    c.activer();
    expect(h.ecouteurs.size).toBe(1);
    emettre(ETAT_REVOQUE);
    expect(evenements()).toHaveLength(1);
  });

  it("aucun compte connu de l'hote : rien n'est ecrit, rien ne leve", () => {
    const c = nouveau();
    c.activer();
    expect(() => emettre(ETAT_REVOQUE)).not.toThrow();
    expect(localStorage.length).toBe(0);
  });
});
