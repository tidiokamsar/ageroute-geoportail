// @vitest-environment node
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lireMessageCanal, creerCanalOnglets, CLE_CANAL_STORAGE, type BroadcastLike } from "../session/canalOnglets";
import { creerCoffre, sha256WebCrypto, stockageEnMemoire, type CoffreSession } from "../session/coffreSession";
import { creerJournal, genererUuid, NOM_CLE_JOURNAL, PLAFOND_JOURNAL } from "../session/journalEvenementsLocaux";
import { cleLocalStorage, empreinteCompte } from "../session/compteLocal";
import { decisionSuppressionLocale } from "../session/politiqueDeconnexion";
import {
  abonnerRevocationApercus, creerUrlApercu, nombreUrlsApercu, revoquerToutesLesUrlsApercu, revoquerUrlApercu,
} from "../session/urlsApercu";
import { fermerCompte, ouvrirCompte } from "./compteCourant";
import { effacerDonneesLocales } from "./effacementLocal";
import { configurerUtilisateurSync, decompteFileLocale } from "./offlineSync";
import { stockageIndexedDb } from "./roulageHote";

/**
 * Chantier D8 : defauts 1 (releve en cours), 14 (ecouteurs du journal), 15 (lecture du journal d'evenements) et les petits modules
 * ajoutes (canal inter-onglets, registre d'URL d'apercu). Vrai coffre, vrai moteur IndexedDB (fake-indexeddb).
 */

const T0 = Date.parse("2026-10-25T08:00:00.000Z");
const PIN = "Zx-91-pin";

function fauxLocalStorage() {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; }, key: (i: number) => [...m.keys()][i] ?? null, getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(),
  };
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("localStorage", fauxLocalStorage());
  fermerCompte();
});
afterEach(() => { fermerCompte(); vi.restoreAllMocks(); });

async function ouvrir(compteId: string): Promise<{ coffre: CoffreSession; empreinte: string }> {
  const coffre = await creerCoffre({
    stockage: stockageEnMemoire(), compteId, appareilId: "tel-1", pin: PIN, maintenantMs: T0, iterations: 1000, iterationsDeTest: true,
    profil: { userId: compteId, nom: compteId, role: "INSPECTEUR", modules: [], regions: [] },
  });
  const empreinte = await empreinteCompte(compteId, sha256WebCrypto);
  ouvrirCompte({ compteId, empreinte, chiffreur: coffre });
  return { coffre, empreinte };
}

const echantillon = (seq: number) => ({
  seq, type: "ECHANTILLON", echantillon: { tMs: T0 + seq * 1000, lat: 9.5, lon: -13.7, precisionM: 5 }, segment: 0, trou: null,
  alertes: [], ecartHorlogeMs: 0, sautsConsecutifs: 0, identiquesConsecutifs: 0,
}) as never;
const demarrage = (agent = "agent-A") => ({ seq: 1, type: "DEMARRAGE", tMs: T0, sessionId: "s1", parametres: {}, agentRef: agent, versionJournal: 1 }) as never;
const arret = (seq: number) => ({ seq, type: "ARRET", tMs: T0 + seq * 1000 }) as never;

// ---------------------------------------------------------------------------------------------------
describe("defaut 1 : un releve de roulage EN COURS compte dans le decompte qui protege l'effacement", () => {
  async function journalEnCours(avecArret: boolean, n = 39, compte = "agent-A") {
    const { coffre } = await ouvrir(compte);
    configurerUtilisateurSync(compte);
    const j = stockageIndexedDb({ tailleLot: 1 });
    expect(j).not.toBeNull();
    j!.ajouter(demarrage(compte));
    for (let i = 2; i <= n; i += 1) j!.ajouter(echantillon(i));
    if (avecArret) j!.ajouter(arret(n + 1));
    await j!.toutes();
    return { coffre, j: j! };
  }

  it("journal de 39 entrees SANS arret : relevesNonConfirmes = 1 et l'effacement est REFUSE (il repondait EFFACE)", async () => {
    await journalEnCours(false);
    const d = await decompteFileLocale();
    expect(d.relevesNonConfirmes).toBe(1);
    expect(decisionSuppressionLocale(d)).toMatchObject({ refusee: true, raisons: ["RELEVE_NON_CONFIRME"], nbReleves: 1 });
    const r = await effacerDonneesLocales({ decompte: decompteFileLocale });
    expect(r).toMatchObject({ ok: false, raison: "FILE_NON_VIDE" });
  });

  it("temoin : releve arrete et non confirme = 1 aussi (comportement conserve)", async () => {
    await journalEnCours(true, 39, "agent-T");
    expect((await decompteFileLocale()).relevesNonConfirmes).toBe(1);
  });

  it("COFFRE VERROUILLE : le compteur d'information pose des les premiers points dit aussi « un releve en cours »", async () => {
    const { coffre } = await journalEnCours(false, 10, "agent-V");
    coffre.verrouiller();
    // le journal est illisible sans cle : seul le compteur d'information en clair reste
    expect((await decompteFileLocale()).relevesNonConfirmes).toBe(1);
  });

  it("une session confirmee par le serveur ne compte plus", async () => {
    await journalEnCours(false, 39, "agent-C");
    const { noterEnvoiConfirme } = await import("./releveVue");
    noterEnvoiConfirme("s1");
    expect((await decompteFileLocale()).relevesNonConfirmes).toBe(0);
  });

  it("session d'un autre agent dans le journal : 0", async () => {
    await ouvrir("agent-Y");
    configurerUtilisateurSync("agent-Y");
    const j = stockageIndexedDb({ tailleLot: 1 })!;
    j.ajouter(demarrage("agent-Z"));
    j.ajouter(echantillon(2)); j.ajouter(echantillon(3));
    await j.toutes();
    expect((await decompteFileLocale()).relevesNonConfirmes).toBe(0);
  });

  it("un DEMARRAGE sans position (menu ouvert puis page fermee) n'est pas un releve a protéger", async () => {
    await ouvrir("agent-W");
    configurerUtilisateurSync("agent-W");
    const j = stockageIndexedDb({ tailleLot: 1 })!;
    j.ajouter(demarrage("agent-W"));
    await j.toutes();
    expect((await decompteFileLocale()).relevesNonConfirmes).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("defaut 14 : les ecouteurs du journal de roulage sont retires a la fermeture", () => {
  it("fermer() retire l'abonnement au compte et l'ecouteur de visibilite ; apres, plus d'ecriture declenchee", async () => {
    const ajout = vi.fn();
    const retrait = vi.fn();
    vi.stubGlobal("document", { visibilityState: "visible", addEventListener: ajout, removeEventListener: retrait });
    const { coffre } = await ouvrir("agent-A");
    const j = stockageIndexedDb({ tailleLot: 1 })!;
    expect(ajout).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    const ecouteur = ajout.mock.calls.find((c) => c[0] === "visibilitychange")![1];
    j.fermer!();
    expect(retrait).toHaveBeenCalledWith("visibilitychange", ecouteur);

    // L'abonnement au compte est retire : un tampon retenu pendant le verrou n'est PAS ecrit par un deverrouillage ulterieur.
    coffre.verrouiller();
    j.ajouter(demarrage());
    await Promise.resolve();
    expect(j.enAttente!()).toBe(1);
    await ouvrir("agent-A");
    await new Promise((r) => setTimeout(r, 20));
    expect(j.enAttente!()).toBe(1); // une instance fermee ne reagit plus au compte
    vi.unstubAllGlobals();
  });

  it("sans fermer(), l'instance reagit au deverrouillage (comportement d'avant, pour comparaison)", async () => {
    const { coffre } = await ouvrir("agent-A");
    const j = stockageIndexedDb({ tailleLot: 1 })!;
    coffre.verrouiller();
    j.ajouter(demarrage());
    expect(j.enAttente!()).toBe(1);
    await ouvrir("agent-A");
    await vi.waitFor(() => expect(j.enAttente!()).toBe(0));
  });
});

// ---------------------------------------------------------------------------------------------------
describe("defaut 15 : la LECTURE du journal d'evenements est bornee", () => {
  it("20 000 entrees forgees : on ne lit que les 200 plus recentes, et l'envoi ne depose pas plus", async () => {
    const emp = await empreinteCompte("agent-A", sha256WebCrypto);
    const cle = cleLocalStorage(emp, NOM_CLE_JOURNAL);
    const entrees = Array.from({ length: 20_000 }, (_, i) => ({ id: genererUuid(), evenement: "DEVERROUILLAGE", horodatageClient: new Date(T0 + i).toISOString() }));
    localStorage.setItem(cle, JSON.stringify({ v: 1, entrees, perdus: 0 }));
    const j = creerJournal({ empreinte: emp, stockage: localStorage });
    expect(j.nombre()).toBe(PLAFOND_JOURNAL);
    expect(j.lire()).toHaveLength(200);
    expect(j.lire()[199].horodatageClient).toBe(new Date(T0 + 19_999).toISOString()); // les plus recentes
    j.ajouter("ECHEC_DEVERROUILLAGE", T0);
    expect(j.nombre()).toBeLessThanOrEqual(PLAFOND_JOURNAL);
  });

  it("un journal de 200 entrees ou moins est lu en entier, dans l'ordre", async () => {
    const emp = await empreinteCompte("agent-A", sha256WebCrypto);
    const j = creerJournal({ empreinte: emp, stockage: localStorage });
    for (let i = 0; i < 50; i += 1) j.ajouter(i % 2 === 0 ? "DEVERROUILLAGE" : "VERROU_INACTIVITE", T0 + i);
    expect(j.nombre()).toBe(50);
    expect(j.lire()[0].horodatageClient).toBe(new Date(T0).toISOString());
  });
});

// ---------------------------------------------------------------------------------------------------
describe("canal entre onglets", () => {
  function faussaire() {
    const canaux: Array<{ nom: string; rappels: Set<(e: { data: unknown }) => void>; ferme: boolean }> = [];
    const fabrique = (nom: string): BroadcastLike => {
      const c = { nom, rappels: new Set<(e: { data: unknown }) => void>(), ferme: false };
      canaux.push(c);
      return {
        postMessage: (m) => { for (const autre of canaux) if (autre !== c && autre.nom === nom && !autre.ferme) for (const r of autre.rappels) r({ data: structuredClone(m) }); },
        addEventListener: (_t, r) => { c.rappels.add(r); },
        removeEventListener: (_t, r) => { c.rappels.delete(r); },
        close: () => { c.ferme = true; },
      };
    };
    return { fabrique, canaux };
  }
  const EMP = "0123456789abcdef";

  it("BroadcastChannel : un message arrive aux AUTRES onglets, jamais a l'emetteur", () => {
    const { fabrique } = faussaire();
    const a = creerCanalOnglets({ fabriqueBroadcast: fabrique, auteur: "a" });
    const b = creerCanalOnglets({ fabriqueBroadcast: fabrique, auteur: "b" });
    const recuA = vi.fn(); const recuB = vi.fn();
    a.ecouter(recuA); b.ecouter(recuB);
    a.publier("PIN_REINITIALISE", EMP);
    expect(recuB).toHaveBeenCalledWith({ type: "PIN_REINITIALISE", empreinte: EMP, auteur: "a" });
    expect(recuA).not.toHaveBeenCalled();
  });

  it("repli sur l'evenement `storage` quand BroadcastChannel est absent : ecriture puis retrait d'une cle, lue par l'autre document", () => {
    const ecouteurs = new Set<(e: Event) => void>();
    const cible = { addEventListener: (_t: string, r: (e: Event) => void) => { ecouteurs.add(r); }, removeEventListener: (_t: string, r: (e: Event) => void) => { ecouteurs.delete(r); } };
    const ecrit: Array<[string, string]> = []; const retire: string[] = [];
    const stockage = { setItem: (k: string, v: string) => { ecrit.push([k, v]); }, removeItem: (k: string) => { retire.push(k); } };
    const recepteur = creerCanalOnglets({ fabriqueBroadcast: null, cible: cible as never, stockage: null, auteur: "r" });
    const emetteur = creerCanalOnglets({ fabriqueBroadcast: null, cible: { addEventListener() { /* rien */ }, removeEventListener() { /* rien */ } } as never, stockage, auteur: "e" });
    const recu = vi.fn();
    recepteur.ecouter(recu);
    emetteur.publier("EFFACEMENT_LOCAL", EMP);
    expect(ecrit[0][0]).toBe(CLE_CANAL_STORAGE);
    expect(retire).toEqual([CLE_CANAL_STORAGE]);
    // Le navigateur livre un evenement `storage` aux AUTRES documents avec la valeur ecrite.
    for (const e of ecouteurs) e({ key: CLE_CANAL_STORAGE, newValue: ecrit[0][1] } as unknown as Event);
    expect(recu).toHaveBeenCalledWith({ type: "EFFACEMENT_LOCAL", empreinte: EMP, auteur: "e" });
    // Une autre cle, ou un retrait (newValue nul), ne declenche rien.
    for (const e of ecouteurs) { e({ key: "autre", newValue: ecrit[0][1] } as unknown as Event); e({ key: CLE_CANAL_STORAGE, newValue: null } as unknown as Event); }
    expect(recu).toHaveBeenCalledTimes(1);
  });

  it("un message mal forme, d'un type inconnu, d'une empreinte invalide ou de soi-meme est ecarte", () => {
    expect(lireMessageCanal({ type: "SESSION_FERMEE", empreinte: EMP, auteur: "x" })).toEqual({ type: "SESSION_FERMEE", empreinte: EMP, auteur: "x" });
    expect(lireMessageCanal(JSON.stringify({ type: "COMPTE_CHANGE", empreinte: EMP, auteur: "x", n: 1 }))).toEqual({ type: "COMPTE_CHANGE", empreinte: EMP, auteur: "x" });
    for (const mauvais of [null, 3, "pas du json", { type: "SUPPRIMER_TOUT", empreinte: EMP, auteur: "x" }, { type: "SESSION_FERMEE", empreinte: "agent-A", auteur: "x" }, { type: "SESSION_FERMEE", empreinte: EMP }, { type: "SESSION_FERMEE", empreinte: EMP, auteur: "" }]) {
      expect(lireMessageCanal(mauvais as never)).toBeNull();
    }
    const { fabrique, canaux } = faussaire();
    const c = creerCanalOnglets({ fabriqueBroadcast: fabrique, auteur: "moi" });
    const recu = vi.fn();
    c.ecouter(recu);
    for (const r of canaux[0].rappels) r({ data: { type: "SESSION_FERMEE", empreinte: EMP, auteur: "moi" } });
    expect(recu).not.toHaveBeenCalled();
  });

  it("fermer() desabonne et ferme le canal ; un abonne qui leve ne bloque pas les autres", () => {
    const { fabrique, canaux } = faussaire();
    const a = creerCanalOnglets({ fabriqueBroadcast: fabrique, auteur: "a" });
    const b = creerCanalOnglets({ fabriqueBroadcast: fabrique, auteur: "b" });
    const bon = vi.fn();
    b.ecouter(() => { throw new Error("x"); }); b.ecouter(bon);
    a.publier("SESSION_FERMEE", EMP);
    expect(bon).toHaveBeenCalledTimes(1);
    b.fermer();
    expect(canaux[1].ferme).toBe(true);
    expect(canaux[1].rappels.size).toBe(0);
  });

  it("un canal indisponible ne leve jamais", () => {
    const c = creerCanalOnglets({ fabriqueBroadcast: () => { throw new Error("non"); }, stockage: { setItem() { throw new Error("plein"); }, removeItem() { /* rien */ } }, cible: null });
    expect(() => c.publier("SESSION_FERMEE", EMP)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------
describe("registre des URL d'apercu (defaut 7a)", () => {
  it("les URL creees par le registre sont revoquees ensemble, les abonnes (pages) sont prevenus ; revoquer une URL la retire", () => {
    let n = 0;
    const creees: string[] = []; const revoquees: string[] = [];
    vi.stubGlobal("URL", Object.assign(function URLFausse() { /* inutile */ }, { createObjectURL: () => { const u = `blob:essai-${++n}`; creees.push(u); return u; }, revokeObjectURL: (u: string) => { revoquees.push(u); } }));
    const prevenue = vi.fn();
    const stop = abonnerRevocationApercus(prevenue);
    const a = creerUrlApercu(new Blob(["a"]));
    const b = creerUrlApercu(new Blob(["b"]));
    creerUrlApercu(new Blob(["c"]));
    expect(nombreUrlsApercu()).toBe(3);
    revoquerUrlApercu(b);
    expect(nombreUrlsApercu()).toBe(2);
    expect(revoquerToutesLesUrlsApercu()).toBe(2);
    expect(revoquees.sort()).toEqual(creees.sort());
    expect(revoquees).toContain(a);
    expect(nombreUrlsApercu()).toBe(0);
    expect(prevenue).toHaveBeenCalledTimes(1);
    expect(revoquerToutesLesUrlsApercu()).toBe(0);
    expect(prevenue).toHaveBeenCalledTimes(1); // rien a revoquer : personne n'est derange
    stop();
    vi.unstubAllGlobals();
  });
});

