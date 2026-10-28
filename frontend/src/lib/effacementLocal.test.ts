// @vitest-environment node
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { creerCoffre, listerComptesAvecCoffre, sha256WebCrypto, stockageEnMemoire, type CoffreSession, type StockageCoffre } from "../session/coffreSession";
import { cleLocalStorage, empreinteCompte, nomBaseOffline, nomBaseRoulage } from "../session/compteLocal";
import { creerJournal, NOM_CLE_JOURNAL } from "../session/journalEvenementsLocaux";
import type { ComptesFile } from "../session/politiqueDeconnexion";
import { compteCourant, fermerCompte, ouvrirCompte } from "./compteCourant";
import {
  CLE_INDICE_COMPTES, effacerDonneesLocales, lireIndice, noterCompteDansIndice, retirerCompteDeIndice, supprimerStockageDuCompte,
} from "./effacementLocal";
import { addPendingObservation, compterFile, type PendingObservation } from "./offlineDb";

/**
 * Effacement local : refuse tant que la file n'est pas vide, n'efface QUE le compte courant, et laisse intact tout ce qui
 * appartient a un autre compte du meme telephone (bases, cles, coffre, journal). Vrai coffre (1 000 iterations PBKDF2 de
 * test) et vrai moteur IndexedDB (fake-indexeddb).
 */

function fauxLocalStorage() {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; }, key: (i: number) => [...m.keys()][i] ?? null, getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(),
  };
}

const VIDE: ComptesFile = { enAttente: 0, enErreur: 0, abandonnees: 0, enConflit: 0, photosEnFile: 0, relevesNonConfirmes: 0 };
const PIN = "Zx-91-pin";

let stockageCoffre: StockageCoffre;
let coffres: Map<string, CoffreSession>;

async function noms(): Promise<string[]> {
  return ((await indexedDB.databases()) as { name?: string }[]).map((d) => d.name ?? "").sort();
}

async function creerBase(nom: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const r = indexedDB.open(nom, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("x");
    r.onsuccess = () => { r.result.close(); resolve(); };
    r.onerror = () => reject(r.error);
  });
}

const observation = (localId: string): PendingObservation => ({
  localId, createdAt: "2026-10-25T08:03:00.000Z", status: "pending",
  payload: { type: "DEGRADATION", description: "x", observeA: "2026-10-25T08:03:00.000Z", lat: 9.6, lon: -13.5 },
}) as PendingObservation;

/** Un compte complet sur le telephone : coffre, bases, cles localStorage, indice, journal. */
async function peupler(compteId: string): Promise<{ empreinte: string; coffre: CoffreSession }> {
  const coffre = await creerCoffre({
    stockage: stockageCoffre, compteId, appareilId: "tel-1", pin: PIN, maintenantMs: Date.now(), iterations: 1000, iterationsDeTest: true,
    profil: { userId: compteId, nom: `Agent ${compteId}`, role: "INSPECTEUR", modules: [], regions: [] },
  });
  const empreinte = await empreinteCompte(compteId, sha256WebCrypto);
  coffres.set(compteId, coffre);
  await creerBase(nomBaseOffline(empreinte));
  await creerBase(nomBaseRoulage(empreinte));
  localStorage.setItem(cleLocalStorage(empreinte, "referentiels"), "ref");
  localStorage.setItem(cleLocalStorage(empreinte, "sync.device"), "dev");
  noterCompteDansIndice(compteId, `Agent ${compteId}`);
  creerJournal({ empreinte }).ajouter("DEVERROUILLAGE");
  return { empreinte, coffre };
}

function ouvrir(compteId: string, empreinte: string) {
  ouvrirCompte({ compteId, empreinte, chiffreur: coffres.get(compteId) as CoffreSession });
}

async function etatDe(compteId: string, empreinte: string) {
  const bases = await noms();
  const cles = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) as string).filter((k) => k.startsWith(`bdri:${empreinte}:`));
  return {
    offline: bases.includes(nomBaseOffline(empreinte)), roulage: bases.includes(nomBaseRoulage(empreinte)),
    cles: cles.sort(), coffre: (await listerComptesAvecCoffre(stockageCoffre)).includes(compteId),
    indice: compteId in lireIndice().comptes,
  };
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("localStorage", fauxLocalStorage());
  stockageCoffre = stockageEnMemoire();
  coffres = new Map();
  fermerCompte();
});
afterEach(() => { vi.restoreAllMocks(); fermerCompte(); });

describe("effacement refuse", () => {
  it("sans compte ouvert : retour type AUCUN_COMPTE, rien ne leve", async () => {
    expect(await effacerDonneesLocales({ decompte: async () => VIDE })).toEqual({ ok: false, raison: "AUCUN_COMPTE" });
  });

  it("file non vide : refus avec le texte et les actions, RIEN n'est supprime", async () => {
    const { empreinte } = await peupler("agent-A");
    ouvrir("agent-A", empreinte);
    await addPendingObservation(observation("o1"));
    const r = await effacerDonneesLocales({
      decompte: async () => { const d = await compterFile(); return { ...VIDE, enAttente: d.enAttente, enErreur: d.enErreur, abandonnees: d.abandonnees, enConflit: d.enConflit, photosEnFile: d.photosEnFile }; },
    });
    expect(r.ok).toBe(false);
    if (r.ok || r.raison !== "FILE_NON_VIDE") throw new Error("refus attendu");
    expect(r.decision?.refusee).toBe(true);
    expect(r.decision?.texte).toMatch(/1 saisie non synchronisée/);
    expect(r.decision?.actions).toContain("SYNCHRONISER_MAINTENANT");
    expect(await etatDe("agent-A", empreinte)).toMatchObject({ offline: true, roulage: true, coffre: true, indice: true });
    expect(compteCourant()?.compteId).toBe("agent-A"); // le compte reste ouvert
  });

  it.each([
    ["saisie en erreur", { enErreur: 1 }], ["saisie abandonnee", { abandonnees: 2 }], ["saisie en conflit", { enConflit: 1 }],
    ["photo en file", { photosEnFile: 1 }], ["releve non confirme", { relevesNonConfirmes: 1 }],
  ])("refuse pour : %s", async (_nom, delta) => {
    const { empreinte } = await peupler("agent-A");
    ouvrir("agent-A", empreinte);
    const r = await effacerDonneesLocales({ decompte: async () => ({ ...VIDE, ...delta }) });
    expect(r).toMatchObject({ ok: false, raison: "FILE_NON_VIDE" });
    expect((await etatDe("agent-A", empreinte)).offline).toBe(true);
  });

  it("decompte illisible ou invalide : on ne supprime pas (dans le doute, on garde)", async () => {
    const { empreinte } = await peupler("agent-A");
    ouvrir("agent-A", empreinte);
    expect(await effacerDonneesLocales({ decompte: async () => { throw new Error("illisible"); } })).toEqual({ ok: false, raison: "DECOMPTE_INDISPONIBLE" });
    const r = await effacerDonneesLocales({ decompte: async () => ({ ...VIDE, enAttente: Number.NaN }) });
    expect(r).toMatchObject({ ok: false, raison: "FILE_NON_VIDE" });
    expect((await etatDe("agent-A", empreinte)).coffre).toBe(true);
  });

  it("le compte change pendant le decompte : COMPTE_CHANGE, rien n'est supprime", async () => {
    const a = await peupler("agent-A");
    const b = await peupler("agent-B");
    ouvrir("agent-A", a.empreinte);
    const r = await effacerDonneesLocales({ decompte: async () => { ouvrir("agent-B", b.empreinte); return VIDE; } });
    expect(r).toEqual({ ok: false, raison: "COMPTE_CHANGE" });
    expect((await etatDe("agent-A", a.empreinte)).offline).toBe(true);
    expect((await etatDe("agent-B", b.empreinte)).offline).toBe(true);
  });
});

describe("effacement accepte", () => {
  it("file vide : supprime les deux bases, les cles, le coffre et l'indice du compte courant ; garde le journal et y ajoute EFFACEMENT_LOCAL", async () => {
    const { empreinte } = await peupler("agent-A");
    ouvrir("agent-A", empreinte);
    const r = await effacerDonneesLocales({ decompte: async () => VIDE });
    expect(r).toMatchObject({ ok: true, bases: [nomBaseOffline(empreinte), nomBaseRoulage(empreinte)] });
    const e = await etatDe("agent-A", empreinte);
    expect(e).toMatchObject({ offline: false, roulage: false, coffre: false, indice: false });
    expect(e.cles).toEqual([cleLocalStorage(empreinte, NOM_CLE_JOURNAL)]);
    expect(creerJournal({ empreinte }).lire().map((x) => x.evenement)).toEqual(["DEVERROUILLAGE", "EFFACEMENT_LOCAL"]);
    expect(compteCourant()).toBeNull(); // plus rien a ouvrir
  });

  it("JAMAIS l'autre compte : bases, cles, coffre, indice et journal de B sont intacts", async () => {
    const a = await peupler("agent-A");
    const b = await peupler("agent-B");
    const avantB = await etatDe("agent-B", b.empreinte);
    const journalB = creerJournal({ empreinte: b.empreinte }).lire();
    ouvrir("agent-A", a.empreinte);
    // Aucun parametre de compte n'existe : un argument parasite n'a aucun effet.
    const r = await (effacerDonneesLocales as unknown as (o: object) => ReturnType<typeof effacerDonneesLocales>)({ decompte: async () => VIDE, compteId: "agent-B", empreinte: b.empreinte });
    expect(r.ok).toBe(true);
    expect((await etatDe("agent-A", a.empreinte)).coffre).toBe(false);
    expect(await etatDe("agent-B", b.empreinte)).toEqual(avantB);
    expect(creerJournal({ empreinte: b.empreinte }).lire()).toEqual(journalB);
    // Le coffre de B s'ouvre toujours.
    const ouvert = await coffres.get("agent-B")?.deverrouiller(PIN, Date.now());
    expect(ouvert?.ok).toBe(true);
  });

  it("l'inverse : effacer B laisse A entier", async () => {
    const a = await peupler("agent-A");
    const b = await peupler("agent-B");
    const avantA = await etatDe("agent-A", a.empreinte);
    ouvrir("agent-B", b.empreinte);
    expect((await effacerDonneesLocales({ decompte: async () => VIDE })).ok).toBe(true);
    expect(await etatDe("agent-A", a.empreinte)).toEqual(avantA);
  });

  it("une base que d'autres programmes gardent ouverte bloque : ECHEC_SUPPRESSION, le compte est rouvert, le coffre reste", async () => {
    const { empreinte } = await peupler("agent-A");
    ouvrir("agent-A", empreinte);
    // Connexion qui ne se ferme pas sur versionchange : la suppression reste bloquee.
    const tenue = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open(nomBaseOffline(empreinte), 1); r.onsuccess = () => resolve(r.result); });
    const r = await effacerDonneesLocales({ decompte: async () => VIDE, delaiBloqueMs: 50 });
    tenue.close();
    expect(r).toEqual({ ok: false, raison: "ECHEC_SUPPRESSION" });
    expect(compteCourant()?.compteId).toBe("agent-A");
    expect((await etatDe("agent-A", empreinte)).coffre).toBe(true);
  });
});

describe("supprimerStockageDuCompte", () => {
  it("n'atteint que les noms derives de l'empreinte demandee et refuse une empreinte mal formee", async () => {
    const a = await peupler("agent-A");
    const b = await peupler("agent-B");
    localStorage.setItem("bdri.appareilLocal", "installation");
    const bilan = await supprimerStockageDuCompte(a.empreinte);
    expect(bilan.bases).toHaveLength(2);
    expect(await noms()).toEqual([nomBaseOffline(b.empreinte), nomBaseRoulage(b.empreinte)].sort());
    expect(localStorage.getItem("bdri.appareilLocal")).toBe("installation");
    await expect(supprimerStockageDuCompte("*")).rejects.toThrow();
    await expect(supprimerStockageDuCompte("")).rejects.toThrow();
  });
});

describe("indice du dernier compte", () => {
  it("note, relit, retire un compte sans toucher aux autres ; le dernier est le dernier note", () => {
    noterCompteDansIndice("A", "Alpha");
    noterCompteDansIndice("B", "Beta", { deconnexionEnAttente: true, tous: true });
    expect(lireIndice()).toEqual({ dernier: "B", comptes: { A: { nom: "Alpha" }, B: { nom: "Beta", deconnexionEnAttente: true, tous: true } } });
    retirerCompteDeIndice("B");
    expect(lireIndice()).toEqual({ dernier: null, comptes: { A: { nom: "Alpha" } } });
    retirerCompteDeIndice("A");
    expect(localStorage.getItem(CLE_INDICE_COMPTES)).toBeNull();
  });

  it("un contenu abime donne un indice vide, sans lever", () => {
    localStorage.setItem(CLE_INDICE_COMPTES, "{pas du json");
    expect(lireIndice()).toEqual({ dernier: null, comptes: {} });
    localStorage.setItem(CLE_INDICE_COMPTES, JSON.stringify({ dernier: "Z", comptes: { A: { nom: 3 }, B: { nom: "ok" } } }));
    expect(lireIndice()).toEqual({ dernier: null, comptes: { B: { nom: "ok" } } });
  });
});
