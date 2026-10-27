// @vitest-environment node
import "fake-indexeddb/auto";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntreeJournal } from "../roulage/journal";
import { creerCoffre, stockageEnMemoire, sha256WebCrypto, type CoffreSession } from "../session/coffreSession";
import { empreinteCompte, nomBaseRoulage } from "../session/compteLocal";
import { fermerCompte, lireCompteurs, ouvrirCompte } from "./compteCourant";
import { noterEnvoiConfirme } from "./releveVue";
import { resumeAutresComptes, stockageIndexedDb } from "./roulageHote";

/**
 * Journal de roulage CHIFFRE et PAR COMPTE, eprouve contre un vrai moteur IndexedDB et le vrai coffre.
 * Ce qui est defendu : rien en clair dans le stockage brut ; verrou ou compte absent = rien d'ecrit, rien de perdu tant que
 * la page vit ; un second compte n'est plus bloque par le releve du premier et ne le lit pas ; les ecritures ratees sont
 * COMPTEES (l'ecran de roulage s'en sert pour alerter) ; le regroupement par lots rend exactement les memes entrees.
 */

const COORDONNEE = "9.6412345";

function entree(seq: number, type: EntreeJournal["type"] = "ECHANTILLON", surcharge: Record<string, unknown> = {}): EntreeJournal {
  switch (type) {
    case "DEMARRAGE":
      return { seq, type, tMs: 1000, sessionId: "sess-1", parametres: {}, agentRef: "agent-A", versionJournal: 1, ...surcharge } as unknown as EntreeJournal;
    case "ARRET":
      return { seq, type, tMs: 99_000 + seq, ...surcharge } as unknown as EntreeJournal;
    default:
      return {
        seq, type: "ECHANTILLON", segment: 0, trou: null, alertes: [], ecartHorlogeMs: 0, sautsConsecutifs: 0, identiquesConsecutifs: 0,
        echantillon: { tMs: 1000 + seq * 1000, lat: Number(COORDONNEE) + seq * 1e-5, lon: -13.5, precisionM: 5, vitesseMs: 12, capDeg: 90, altitudeM: null },
        ...surcharge,
      } as unknown as EntreeJournal;
  }
}
const session = (n: number): EntreeJournal[] => [entree(1, "DEMARRAGE"), ...Array.from({ length: n }, (_, i) => entree(i + 2)), entree(n + 2, "ARRET")];

async function ouvrir(compteId: string): Promise<{ coffre: CoffreSession; empreinte: string }> {
  const coffre = await creerCoffre({
    stockage: stockageEnMemoire(), compteId, appareilId: "tel-1", pin: "246810", maintenantMs: Date.now(), iterations: 1000, iterationsDeTest: true,
    profil: { userId: compteId, nom: compteId, role: "INSPECTEUR", modules: [], regions: [] },
  });
  const empreinte = await empreinteCompte(compteId, sha256WebCrypto);
  ouvrirCompte({ compteId, empreinte, chiffreur: coffre });
  return { coffre, empreinte };
}

function fauxLocalStorage() {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; }, key: (i: number) => [...m.keys()][i] ?? null, getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(),
  };
}

async function lireBrut(nomBase: string): Promise<Record<string, unknown>[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(nomBase); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const lots = db.objectStoreNames.contains("journal")
    ? await new Promise<Record<string, unknown>[]>((resolve) => { const r = db.transaction("journal", "readonly").objectStore("journal").getAll(); r.onsuccess = () => resolve(r.result); })
    : [];
  db.close();
  return lots;
}
function aplatir(valeur: unknown, sortie: number[] = []): number[] {
  if (typeof valeur === "string") sortie.push(...new TextEncoder().encode(valeur));
  else if (valeur instanceof Uint8Array) sortie.push(...valeur);
  else if (Array.isArray(valeur)) valeur.forEach((v) => aplatir(v, sortie));
  else if (typeof valeur === "object" && valeur !== null) Object.values(valeur).forEach((v) => aplatir(v, sortie));
  return sortie;
}
const contient = (octets: number[], texte: string) => {
  const motif = Array.from(new TextEncoder().encode(texte));
  for (let i = 0; i + motif.length <= octets.length; i += 1) if (motif.every((o, j) => octets[i + j] === o)) return true;
  return false;
};

const attendre = (ms = 30) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("localStorage", fauxLocalStorage());
  fermerCompte();
});
afterEach(() => { vi.restoreAllMocks(); fermerCompte(); });

describe("aller-retour et contenu du stockage brut", () => {
  it("les entrees reviennent identiques et dans l'ordre", async () => {
    await ouvrir("agent-A");
    const j = stockageIndexedDb()!;
    const entrees = session(40);
    entrees.forEach((e) => j.ajouter(e));
    expect(await j.toutes()).toEqual(entrees);
    expect(j.echecs()).toBe(0);
    expect(j.nature).toBe("indexeddb");
  });

  it("une lecture lancee juste apres un ajout sans attendre le voit (l'ordre des ecritures est tenu malgre le chiffrement asynchrone)", async () => {
    await ouvrir("agent-A");
    const j = stockageIndexedDb()!;
    j.ajouter(entree(1, "DEMARRAGE"));
    j.ajouter(entree(2));
    j.ajouter(entree(3));
    expect((await j.toutes()).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("rien en clair : ni les positions, ni les types d'entree, ni l'identifiant de session ; en clair seulement cle, bornes et effectif", async () => {
    const { empreinte } = await ouvrir("agent-A");
    const j = stockageIndexedDb()!;
    session(30).forEach((e) => j.ajouter(e));
    await j.toutes();
    const lots = await lireBrut(nomBaseRoulage(empreinte));
    expect(lots.length).toBeGreaterThan(0);
    const tout = aplatir(lots);
    for (const interdit of [COORDONNEE, "9.6412", "ECHANTILLON", "DEMARRAGE", "sess-1", "latitude", "lat\"", "agent-A\""]) expect(contient(tout, interdit), interdit).toBe(false);
    for (const l of lots) {
      expect(Object.keys(l).sort()).toEqual(["compteId", "dernier", "fmt", "n", "paquet", "seq"]);
      expect(l.paquet).toBeInstanceOf(Uint8Array);
    }
  });

  it("la base porte le nom du compte (bdri-roulage-<empreinte>), pas l'ancien nom partage", async () => {
    const { empreinte } = await ouvrir("agent-A");
    const j = stockageIndexedDb()!;
    j.ajouter(entree(1, "DEMARRAGE"));
    await j.toutes();
    expect((await indexedDB.databases()).map((d) => d.name)).toEqual([nomBaseRoulage(empreinte)]);
  });
});

describe("compte absent ou coffre verrouille", () => {
  it("coffre verrouille : les entrees sont retenues en memoire, JAMAIS ecrites, puis ecrites au deverrouillage", async () => {
    const { coffre, empreinte } = await ouvrir("agent-A");
    const j = stockageIndexedDb()!;
    j.ajouter(entree(1, "DEMARRAGE"));
    await j.toutes();
    coffre.verrouiller();

    j.ajouter(entree(2));
    j.ajouter(entree(3, "ARRET"));
    await attendre();
    expect(j.enAttente?.()).toBe(2);
    expect(j.echecs()).toBe(0);
    const brutVerrouille = await lireBrut(nomBaseRoulage(empreinte));
    expect(brutVerrouille).toHaveLength(1); // seule l'entree d'avant le verrou
    expect(contient(aplatir(brutVerrouille), "ARRET")).toBe(false);
    await expect(j.toutes()).rejects.toMatchObject({ code: "COFFRE_VERROUILLE" });
    await expect(j.vider()).rejects.toMatchObject({ code: "COFFRE_VERROUILLE" });

    await coffre.deverrouiller("246810", Date.now());
    const compte = (await import("./compteCourant")).compteCourant()!;
    ouvrirCompte({ compteId: compte.compteId, empreinte: compte.empreinte, chiffreur: compte.chiffreur }); // le rappel d'apres deverrouillage
    await attendre(60);
    expect(j.enAttente?.()).toBe(0);
    expect((await j.toutes()).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(j.echecs()).toBe(0);
  });

  it("aucun compte : retenu en memoire, aucune base creee, lecture et vidage leves AUCUN_COMPTE", async () => {
    const j = stockageIndexedDb()!;
    j.ajouter(entree(1, "DEMARRAGE"));
    await attendre();
    expect(j.enAttente?.()).toBe(1);
    expect(await indexedDB.databases()).toEqual([]);
    await expect(j.toutes()).rejects.toMatchObject({ code: "AUCUN_COMPTE" });
    await expect(j.vider()).rejects.toMatchObject({ code: "AUCUN_COMPTE" });
  });

  it("la memoire retenue est bornee : au-dela, la plus ancienne entree est abandonnee ET comptee", async () => {
    const { coffre } = await ouvrir("agent-A");
    coffre.verrouiller();
    const j = stockageIndexedDb({ maxEnAttente: 5 })!;
    for (let i = 1; i <= 8; i += 1) j.ajouter(entree(i));
    expect(j.enAttente?.()).toBe(5);
    expect(j.echecs()).toBe(3);
  });
});

describe("deux comptes sur le meme telephone", () => {
  it("le second compte n'est PLUS bloque par le releve du premier : il demarre le sien, sans lire ni effacer l'autre", async () => {
    const a = await ouvrir("agent-A");
    const jA = stockageIndexedDb()!;
    session(10).forEach((e) => jA.ajouter(e));
    await jA.toutes();
    fermerCompte();

    const b = await ouvrir("agent-B");
    const jB = stockageIndexedDb()!;
    expect(await jB.toutes()).toEqual([]);           // B ne voit rien de A
    await jB.vider();                                // B demarre : ne touche pas au releve de A
    session(4).forEach((e) => jB.ajouter(entree(e.seq, e.type as "ECHANTILLON", e.type === "DEMARRAGE" ? { sessionId: "sess-B", agentRef: "agent-B" } : {})));
    expect((await jB.toutes()).length).toBe(6);

    fermerCompte();
    ouvrirCompte({ compteId: "agent-A", empreinte: a.empreinte, chiffreur: a.coffre });
    const relu = await stockageIndexedDb()!.toutes();
    expect(relu).toEqual(session(10));               // le releve de A est intact
    expect((await indexedDB.databases()).map((d) => d.name).sort()).toEqual([nomBaseRoulage(a.empreinte), nomBaseRoulage(b.empreinte)].sort());
  });

  it("une instance creee sous A ne sert jamais B : elle refuse de lire, et ce qu'elle recevrait n'est pas ecrit chez B", async () => {
    const a = await ouvrir("agent-A");
    const jA = stockageIndexedDb()!;
    jA.ajouter(entree(1, "DEMARRAGE"));
    await jA.toutes();
    fermerCompte();
    const b = await ouvrir("agent-B");
    await expect(jA.toutes()).rejects.toMatchObject({ code: "COMPTE_INCOHERENT" });
    jA.ajouter(entree(2));
    await attendre();
    expect(await lireBrut(nomBaseRoulage(b.empreinte))).toEqual([]);
    expect((await lireBrut(nomBaseRoulage(a.empreinte))).length).toBe(1);
  });

  it("resumeAutresComptes : un releve arrete du compte A est visible pour B (nombres seulement), et disparait a la confirmation", async () => {
    const a = await ouvrir("agent-A");
    const jA = stockageIndexedDb()!;
    session(5).forEach((e) => jA.ajouter(e));
    await jA.toutes();
    expect(lireCompteurs(a.empreinte)).toMatchObject({ releves: 1 });
    fermerCompte();

    await ouvrir("agent-B");
    expect(resumeAutresComptes()).toEqual({ comptes: 1, saisies: 0, releves: 1 });

    ouvrirCompte({ compteId: "agent-A", empreinte: a.empreinte, chiffreur: a.coffre });
    noterEnvoiConfirme("sess-1");
    fermerCompte();
    await ouvrir("agent-B");
    expect(resumeAutresComptes()).toEqual({ comptes: 0, saisies: 0, releves: 0 });
  });

  it("vider remet le compteur de releves a zero", async () => {
    const a = await ouvrir("agent-A");
    const j = stockageIndexedDb()!;
    session(3).forEach((e) => j.ajouter(e));
    await j.toutes();
    expect(lireCompteurs(a.empreinte)?.releves).toBe(1);
    await j.vider();
    expect(lireCompteurs(a.empreinte)?.releves).toBe(0);
    expect(await j.toutes()).toEqual([]);
  });
});

describe("vider", () => {
  it("efface le journal et ce qui n'etait pas encore ecrit ; les ecritures suivantes repartent d'un journal propre", async () => {
    await ouvrir("agent-A");
    const j = stockageIndexedDb({ tailleLot: 50 })!;
    session(10).forEach((e) => j.ajouter(e));
    j.ajouter(entree(20));      // dans le tampon, pas encore ecrite
    await j.vider();
    expect(await j.toutes()).toEqual([]);
    j.ajouter(entree(1, "DEMARRAGE", { sessionId: "sess-2" }));
    expect((await j.toutes()).map((e) => e.seq)).toEqual([1]);
  });
});

describe("echecs d'ecriture comptes, sans lever d'erreur dans le noyau", () => {
  it("une transaction annulee (quota) incremente echecs() du nombre d'entrees perdues ; une ecriture reussie n'en compte aucun", async () => {
    await ouvrir("agent-A");
    const j = stockageIndexedDb()!;
    j.ajouter(entree(1, "DEMARRAGE"));
    // Attente de la CONDITION et non d'une duree : sous charge, l'entree 1 pouvait encore etre en cours d'ecriture quand
    // l'espion s'installait, et son ecriture etait alors comptee parmi les pertes (echecs() = 3 au lieu de 2).
    await vi.waitFor(async () => { expect((await j.toutes()).map((e) => e.seq)).toEqual([1]); }, { timeout: 5000 });
    expect(j.echecs()).toBe(0);

    const vrai = IDBObjectStore.prototype.put;
    const espion = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      const r = vrai.apply(this, args);
      queueMicrotask(() => (this.transaction as unknown as { _abort(n: string): void })._abort("QuotaExceededError"));
      return r;
    });
    expect(() => j.ajouter(entree(2))).not.toThrow();
    j.ajouter(entree(3));
    await vi.waitFor(() => { expect(j.echecs()).toBe(2); }, { timeout: 5000 });
    await attendre(80);
    expect(j.echecs()).toBe(2);
    espion.mockRestore();

    j.ajouter(entree(4));
    await attendre(60);
    expect(j.echecs()).toBe(2);
    expect((await j.toutes()).map((e) => e.seq)).toEqual([1, 4]);
  });
});

describe("regroupement par lots (debit)", () => {
  it("25 echantillons en lots de 10 : trois blocs au lieu de vingt-cinq, memes entrees a la relecture, ordre conserve", async () => {
    const { empreinte } = await ouvrir("agent-A");
    const j = stockageIndexedDb({ tailleLot: 10, delaiLotMs: 5000 })!;
    const entrees = [entree(1, "DEMARRAGE"), ...Array.from({ length: 25 }, (_, i) => entree(i + 2))];
    entrees.forEach((e) => j.ajouter(e));
    const relu = await j.toutes();
    expect(relu).toEqual(entrees);
    const lots = await lireBrut(nomBaseRoulage(empreinte));
    expect(lots.map((l) => l.n)).toEqual([10, 10, 6]);   // blocs de 10 au plus (le reste part a la lecture) : 26 entrees, trois ecritures
  });

  it("une entree qui n'est pas un echantillon (marqueur, arret) declenche l'ecriture immediate du tampon", async () => {
    const { empreinte } = await ouvrir("agent-A");
    const j = stockageIndexedDb({ tailleLot: 100, delaiLotMs: 60_000 })!;
    j.ajouter(entree(1, "DEMARRAGE"));
    await attendre(40);
    j.ajouter(entree(2));
    j.ajouter(entree(3));
    await attendre(40);
    expect(j.enAttente?.()).toBe(2);        // des echantillons seuls attendent leur lot
    j.ajouter(entree(4, "ARRET"));
    await attendre(80);
    expect(j.enAttente?.()).toBe(0);
    expect((await lireBrut(nomBaseRoulage(empreinte))).map((l) => l.n)).toEqual([1, 3]);
  });

  it("un lot incomplet est ecrit apres delaiLotMs, sans autre appel", async () => {
    const { empreinte } = await ouvrir("agent-A");
    const j = stockageIndexedDb({ tailleLot: 100, delaiLotMs: 25 })!;
    j.ajouter(entree(1, "DEMARRAGE"));
    j.ajouter(entree(2));
    expect(j.enAttente?.()).toBeGreaterThan(0);
    await attendre(150);
    expect(j.enAttente?.()).toBe(0);
    expect((await lireBrut(nomBaseRoulage(empreinte))).length).toBeGreaterThan(0);
  });
});

describe("lot altere ou rejoue", () => {
  it("un lot altere est ecarte (compte dans lotsIllisibles), les autres se lisent ; un chiffre mal ecrit ne plante pas le journal", async () => {
    const { empreinte } = await ouvrir("agent-A");
    const j = stockageIndexedDb()!;
    session(5).forEach((e) => j.ajouter(e));
    await j.toutes();
    const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open(nomBaseRoulage(empreinte)); r.onsuccess = () => resolve(r.result); });
    await new Promise<void>((resolve) => {
      const tx = db.transaction("journal", "readwrite");
      const os = tx.objectStore("journal");
      const g = os.get(3);
      g.onsuccess = () => { const l = g.result as { paquet: Uint8Array }; const p = new Uint8Array(l.paquet); p[p.length - 1] ^= 0xff; os.put({ ...l, paquet: p }); };
      tx.oncomplete = () => resolve();
    });
    db.close();
    const relu = await j.toutes();
    expect(relu.map((e) => e.seq)).toEqual([1, 2, 4, 5, 6, 7]);
    expect(j.lotsIllisibles?.()).toBe(1);
  });

  it("une entree ajoutee deux fois (meme numero) n'apparait qu'une fois", async () => {
    await ouvrir("agent-A");
    const j = stockageIndexedDb()!;
    j.ajouter(entree(1, "DEMARRAGE"));
    j.ajouter(entree(2));
    j.ajouter(entree(2));
    expect((await j.toutes()).map((e) => e.seq)).toEqual([1, 2]);
  });
});
