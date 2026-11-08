// @vitest-environment node
import "fake-indexeddb/auto";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { creerCoffre, stockageEnMemoire, sha256WebCrypto, type CoffreSession } from "../session/coffreSession";
import { empreinteCompte, nomBaseOffline } from "../session/compteLocal";
import { fermerCompte, lireCompteurs, ouvrirCompte } from "./compteCourant";
import {
  addPendingDefaut, addPendingInspection, addPendingObservation, addPendingPortion, compterFile, countPending, DB_VERSION,
  getAllPending, getAllPendingDefauts, getAllPendingObservations, getAllPendingPortions, getPendingInspection, lireIllisibles,
  PHOTO_TAILLE_MAX_OCTETS, removePendingDefaut, removePendingInspection, removePendingObservation, removePendingPortion,
  updatePendingDefaut, updatePendingInspection, updatePendingObservation, updatePendingPortion,
  type PendingDefaut, type PendingInspection, type PendingObservation, type PendingPortion,
} from "./offlineDb";

/**
 * Stockage local CHIFFRE et PAR COMPTE, eprouve contre un vrai moteur IndexedDB (fake-indexeddb) et le vrai coffre
 * (WebCrypto de Node, 1 000 iterations PBKDF2 pour aller vite : la derivation n'est pas le sujet ici).
 *
 * Ce que ces tests prouvent : le contenu des saisies et des photos n'apparait PAS dans le stockage brut ; un compte
 * verrouille ou absent leve une erreur typee et n'ecrit rien ; deux comptes sur le meme IndexedDB ne s'atteignent par
 * aucune API ; une saisie non enregistree est dite non enregistree ; un enregistrement altere n'arrete pas la file.
 * Ce qu'ils ne prouvent pas : le comportement d'un vrai navigateur (quota reel, WebView Android).
 */

const MOT_DE_PASSE_PIN = "246810";
const SECRET = "DESCRIPTION-CONFIDENTIELLE-ZX81";
const ENTETE_JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01];

function octetsJpeg(n: number, graine = 7): Uint8Array<ArrayBuffer> {
  const o = new Uint8Array(new ArrayBuffer(n));
  o.set(ENTETE_JPEG);
  let x = graine;
  for (let i = ENTETE_JPEG.length; i < n; i += 1) { x = (x * 1103515245 + 12345) & 0x7fffffff; o[i] = x & 0xff; }
  return o;
}
const photo = (nom: string, taille = 4096, graine = 7) => ({ name: nom, blob: new Blob([octetsJpeg(taille, graine)], { type: "image/jpeg" }) });

async function ouvrir(compteId: string): Promise<{ coffre: CoffreSession; empreinte: string }> {
  const coffre = await creerCoffre({
    stockage: stockageEnMemoire(), compteId, appareilId: "telephone-1", pin: MOT_DE_PASSE_PIN, maintenantMs: Date.now(), iterations: 1000, iterationsDeTest: true,
    profil: { userId: compteId, nom: compteId, role: "INSPECTEUR", modules: [], regions: [] },
  });
  const empreinte = await empreinteCompte(compteId, sha256WebCrypto);
  ouvrirCompte({ compteId, empreinte, chiffreur: coffre });
  return { coffre, empreinte };
}

const inspection = (localId: string, over: Partial<PendingInspection> = {}): PendingInspection => ({
  localId, createdAt: "2026-10-25T08:00:00.000Z", status: "pending",
  payload: { tronconId: "t-1", dateInspection: "2026-10-25", etatObserve: "MAUVAIS", defautsConstates: SECRET, lat: 9.64, lon: -13.58, precisionM: 6 },
  photos: [], ...over,
});
const defaut = (localId: string, over: Partial<PendingDefaut> = {}): PendingDefaut => ({
  localId, createdAt: "2026-10-25T08:01:00.000Z", status: "pending",
  payload: { catalogueCode: "NID_POULE", constateA: "2026-10-25T08:01:00.000Z", gravite: 3, mesures: { longueurM: 1.2 } }, ...over,
});
const portion = (localId: string): PendingPortion => ({
  localId, createdAt: "2026-10-25T08:02:00.000Z", status: "pending",
  payload: { tronconId: "t-1", debutM: 0, finM: 120, revetement: SECRET },
});
const observation = (localId: string, over: Partial<PendingObservation> = {}): PendingObservation => ({
  localId, createdAt: "2026-10-25T08:03:00.000Z", status: "pending",
  payload: { type: "DEGRADATION", description: SECRET, observeA: "2026-10-25T08:03:00.000Z", lat: 9.6, lon: -13.5 }, ...over,
});

// ---- inspection du stockage BRUT (ce qu'un autre programme du telephone verrait) --------------------------------------

async function lireBrut(nomBase: string): Promise<Record<string, unknown[]>> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(nomBase);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const sortie: Record<string, unknown[]> = {};
  for (const nom of Array.from(db.objectStoreNames)) {
    sortie[nom] = await new Promise<unknown[]>((resolve, reject) => {
      const r = db.transaction(nom, "readonly").objectStore(nom).getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  db.close();
  return sortie;
}

/** Tout ce qui est ecrit, mis bout a bout : textes en UTF-8, octets tels quels, nombres et cles ecartes. */
function aplatir(valeur: unknown, sortie: number[] = []): number[] {
  if (typeof valeur === "string") sortie.push(...new TextEncoder().encode(valeur));
  else if (valeur instanceof Uint8Array) sortie.push(...valeur);
  else if (Array.isArray(valeur)) valeur.forEach((v) => aplatir(v, sortie));
  else if (typeof valeur === "object" && valeur !== null) Object.values(valeur).forEach((v) => aplatir(v, sortie));
  return sortie;
}
function contient(octets: number[], motif: ArrayLike<number>): boolean {
  const n = motif.length;
  for (let i = 0; i + n <= octets.length; i += 1) {
    let ok = true;
    for (let j = 0; j < n; j += 1) if (octets[i + j] !== motif[j]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}
const motifTexte = (t: string) => Array.from(new TextEncoder().encode(t));

async function octetsDe(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** Un navigateur abandonne la transaction APRES coup (quota constate a l'ecriture), pas pendant l'appel qui la declenche. */
function abandonner(tx: IDBTransaction, nom: string): void {
  queueMicrotask(() => (tx as unknown as { _abort(nom: string): void })._abort(nom));
}

/** Un localStorage minimal : l'environnement node n'en a pas. */
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
afterEach(() => {
  vi.restoreAllMocks();
  fermerCompte();
});

describe("aller-retour de chaque file chiffree", () => {
  it("inspection avec photos : contenu, statut et octets des photos reviennent identiques", async () => {
    await ouvrir("agent-A");
    const p1 = photo("a.jpg", 5000, 1);
    const p2 = photo("b.jpg", 3000, 2);
    await addPendingInspection(inspection("insp-1", { photos: [p1, p2], serverId: "srv-9", tentatives: 2 }));

    const [lu] = await getAllPending();
    expect(lu).toMatchObject({ localId: "insp-1", ownerUserId: "agent-A", status: "pending", serverId: "srv-9", tentatives: 2 });
    expect(lu.payload.defautsConstates).toBe(SECRET);
    expect(lu.photos.map((p) => p.name)).toEqual(["a.jpg", "b.jpg"]);
    expect(lu.photos[0].blob.type).toBe("image/jpeg");
    expect(await octetsDe(lu.photos[0].blob)).toEqual(await octetsDe(p1.blob));
    expect(await octetsDe(lu.photos[1].blob)).toEqual(await octetsDe(p2.blob));
  });

  it("defaut avec photos (position, precision, date de prise de vue) et emprise GeoJSON", async () => {
    await ouvrir("agent-A");
    const p = { ...photo("d.jpg", 2048, 3), lat: 9.5, lon: -13.7, precisionM: 4, capturedA: "2026-10-25T08:01:30.000Z" };
    const emprise = { type: "Polygon" as const, coordinates: [[[-13.7, 9.5], [-13.69, 9.5], [-13.69, 9.51], [-13.7, 9.5]]] };
    await addPendingDefaut(defaut("def-1", { photos: [p], payload: { ...defaut("x").payload, emprise } }));
    const [lu] = await getAllPendingDefauts();
    expect(lu.payload.emprise).toEqual(emprise);
    expect(lu.photos).toHaveLength(1);
    expect(lu.photos?.[0]).toMatchObject({ name: "d.jpg", lat: 9.5, lon: -13.7, precisionM: 4, capturedA: "2026-10-25T08:01:30.000Z" });
    expect(await octetsDe(lu.photos![0].blob)).toEqual(await octetsDe(p.blob));
  });

  it("portion et observation (sans et avec photo) : aller-retour, mise a jour sans doublon, retrait", async () => {
    await ouvrir("agent-A");
    await addPendingPortion(portion("por-1"));
    await addPendingObservation(observation("obs-1"));
    await addPendingObservation(observation("obs-2", { photos: [{ ...photo("o.jpg"), capturedA: "2026-10-25T08:03:10.000Z" }] }));

    expect((await getAllPendingPortions())[0].payload.revetement).toBe(SECRET);
    expect((await getAllPendingObservations()).map((o) => o.localId).sort()).toEqual(["obs-1", "obs-2"]);

    await updatePendingObservation(observation("obs-1", { status: "conflit", conflitId: "c-1", motifConflit: "DEJA_EXISTANTE" }));
    await updatePendingPortion({ ...portion("por-1"), status: "abandonnee", refusDefinitif: true });
    const obs = await getAllPendingObservations();
    expect(obs).toHaveLength(2);
    expect(obs.find((o) => o.localId === "obs-1")).toMatchObject({ status: "conflit", conflitId: "c-1" });
    expect(obs.find((o) => o.localId === "obs-2")?.photos).toHaveLength(1);
    expect((await getAllPendingPortions())[0]).toMatchObject({ status: "abandonnee", refusDefinitif: true });

    await removePendingObservation("obs-2");
    await removePendingPortion("por-1");
    expect((await getAllPendingObservations()).map((o) => o.localId)).toEqual(["obs-1"]);
    expect(await getAllPendingPortions()).toEqual([]);
  });

  it("inspection et defaut : mise a jour puis retrait ; une saisie absente se lit « null »", async () => {
    await ouvrir("agent-A");
    await addPendingInspection(inspection("insp-1"));
    await updatePendingInspection(inspection("insp-1", { status: "error", errorMessage: "reseau" }));
    expect((await getAllPending())[0]).toMatchObject({ status: "error", errorMessage: "reseau" });
    expect(await getPendingInspection("absente")).toBeNull();
    await addPendingDefaut(defaut("def-1"));
    await updatePendingDefaut(defaut("def-1", { status: "conflit", conflitId: "c" }));
    expect((await getAllPendingDefauts())[0].status).toBe("conflit");
    await removePendingInspection("insp-1");
    await removePendingDefaut("def-1");
    expect(await getAllPending()).toEqual([]);
    expect(await getAllPendingDefauts()).toEqual([]);
  });

  it("lecture legere : pas de photo dechiffree, mais leur nombre ; le type interdit de la reecrire telle quelle", async () => {
    const { coffre } = await ouvrir("agent-A");
    await addPendingInspection(inspection("insp-1", { photos: [photo("a.jpg"), photo("b.jpg")] }));
    const dechiffrerBlob = vi.spyOn(coffre, "dechiffrerBlob");
    const [leger] = await getAllPending({ sansPhotos: true });
    expect(dechiffrerBlob).not.toHaveBeenCalled();
    expect(leger.nbPhotos).toBe(2);
    expect(leger.photos).toBeUndefined();
    expect(leger.localId).toBe("insp-1");
    // Verifie par le compilateur seulement (jamais execute) : une lecture legere n'est pas une saisie complete, la reecrire perdrait les photos.
    // @ts-expect-error photos absent de la lecture legere
    void (() => updatePendingInspection(leger));
  });

  it("une photo deja stockee n'est ni rechiffree ni reecrite quand la saisie est mise a jour ; une photo retiree disparait", async () => {
    const { coffre, empreinte } = await ouvrir("agent-A");
    await addPendingInspection(inspection("insp-1", { photos: [photo("a.jpg", 2000, 1), photo("b.jpg", 2000, 2), photo("c.jpg", 2000, 3)] }));
    const chiffrerBlob = vi.spyOn(coffre, "chiffrerBlob");

    const [lu] = await getAllPending();
    await updatePendingInspection({ ...lu, photos: lu.photos.slice(1), status: "syncing" });
    expect(chiffrerBlob).not.toHaveBeenCalled();
    const brut = await lireBrut(nomBaseOffline(empreinte));
    expect(brut.pending_photos).toHaveLength(2);
    expect((await getAllPending())[0].photos.map((p) => p.name)).toEqual(["b.jpg", "c.jpg"]);

    const [relu] = await getAllPending();
    await updatePendingInspection({ ...relu, photos: [...relu.photos, photo("d.jpg", 1000, 4)] });
    expect(chiffrerBlob).toHaveBeenCalledTimes(1);
    expect((await getAllPending())[0].photos.map((p) => p.name)).toEqual(["b.jpg", "c.jpg", "d.jpg"]);

    await removePendingInspection("insp-1");
    expect((await lireBrut(nomBaseOffline(empreinte))).pending_photos).toEqual([]);
  });
});

describe("rien en clair dans le stockage brut", () => {
  it("ni le texte des saisies, ni le debut des octets d'une photo, ni les noms de fichiers : seulement l'enveloppe minimale", async () => {
    const { empreinte } = await ouvrir("agent-A");
    await addPendingInspection(inspection("insp-1", { photos: [photo("secret-photo-chantier.jpg", 6000, 5)] }));
    await addPendingDefaut(defaut("def-1", { photos: [{ ...photo("def.jpg", 6000, 6), capturedA: "2026-10-25T08:01:30.000Z" }] }));
    await addPendingPortion(portion("por-1"));
    await addPendingObservation(observation("obs-1", { photos: [{ ...photo("obs.jpg", 6000, 8), capturedA: "x" }] }));

    const brut = await lireBrut(nomBaseOffline(empreinte));
    const tout = aplatir(brut);
    expect(contient(tout, motifTexte(SECRET))).toBe(false);
    expect(contient(tout, motifTexte("secret-photo-chantier"))).toBe(false);
    expect(contient(tout, motifTexte("NID_POULE"))).toBe(false);
    expect(contient(tout, ENTETE_JPEG)).toBe(false);
    expect(contient(tout, ENTETE_JPEG.slice(0, 6))).toBe(false);
    expect(contient(tout, motifTexte("JFIF"))).toBe(false);

    // Ce qui est en clair : l'enveloppe, rien d'autre.
    for (const nom of ["pending_inspections", "pending_defauts", "pending_portions", "pending_observations"]) {
      for (const r of brut[nom] as Record<string, unknown>[]) {
        expect(Object.keys(r).sort()).toEqual(["charge", "compteId", "createdAt", "fmt", "localId", "nbPhotos", "status"]);
        expect(r.compteId).toBe("agent-A");
      }
    }
    for (const r of brut.pending_photos as Record<string, unknown>[]) {
      expect(Object.keys(r).sort()).toEqual(["cle", "compteId", "file", "fmt", "localId", "paquet", "saisie"]);
      expect(r.paquet).toBeInstanceOf(Uint8Array);
    }
  });

  it("le controle de la methode : un enregistrement EN CLAIR, lui, serait detecte", async () => {
    await ouvrir("agent-A");
    const clair = { localId: "x", payload: { description: SECRET } };
    expect(contient(aplatir(clair), motifTexte(SECRET))).toBe(true);
    expect(contient(Array.from(octetsJpeg(100)), ENTETE_JPEG)).toBe(true);
  });
});

describe("compte absent ou coffre verrouille : erreur typee, jamais d'ecriture en clair", () => {
  const appels: [string, () => Promise<unknown>][] = [
    ["addPendingInspection", () => addPendingInspection(inspection("i"))],
    ["getAllPending", () => getAllPending()],
    ["updatePendingInspection", () => updatePendingInspection(inspection("i"))],
    ["removePendingInspection", () => removePendingInspection("i")],
    ["addPendingDefaut", () => addPendingDefaut(defaut("d"))],
    ["getAllPendingDefauts", () => getAllPendingDefauts()],
    ["updatePendingDefaut", () => updatePendingDefaut(defaut("d"))],
    ["removePendingDefaut", () => removePendingDefaut("d")],
    ["addPendingPortion", () => addPendingPortion(portion("p"))],
    ["getAllPendingPortions", () => getAllPendingPortions()],
    ["updatePendingPortion", () => updatePendingPortion(portion("p"))],
    ["removePendingPortion", () => removePendingPortion("p")],
    ["addPendingObservation", () => addPendingObservation(observation("o"))],
    ["getAllPendingObservations", () => getAllPendingObservations()],
    ["updatePendingObservation", () => updatePendingObservation(observation("o"))],
    ["removePendingObservation", () => removePendingObservation("o")],
    ["getPendingInspection", () => getPendingInspection("i")],
    ["lireIllisibles", () => lireIllisibles()],
  ];

  it("AUCUN COMPTE : chaque API leve AUCUN_COMPTE et aucune base n'est meme creee", async () => {
    for (const [nom, appel] of appels) {
      await expect(appel(), nom).rejects.toMatchObject({ name: "ErreurStockageLocal", code: "AUCUN_COMPTE" });
    }
    await expect(compterFile()).rejects.toMatchObject({ code: "AUCUN_COMPTE" });
    expect(await indexedDB.databases()).toEqual([]);
  });

  it("COFFRE VERROUILLE : chaque API leve COFFRE_VERROUILLE et le stockage brut ne change pas d'un octet", async () => {
    const { coffre, empreinte } = await ouvrir("agent-A");
    await addPendingInspection(inspection("insp-1", { photos: [photo("a.jpg")] }));
    const avant = JSON.stringify(Array.from(aplatir(await lireBrut(nomBaseOffline(empreinte)))));

    coffre.verrouiller();
    for (const [nom, appel] of appels) {
      await expect(appel(), nom).rejects.toMatchObject({ name: "ErreurStockageLocal", code: "COFFRE_VERROUILLE" });
    }
    expect(JSON.stringify(Array.from(aplatir(await lireBrut(nomBaseOffline(empreinte)))))).toBe(avant);
  });

  it("verrouille, on peut COMPTER la file par statut (enveloppes en clair, aucune cle) ; deverrouille, tout revient", async () => {
    const { coffre } = await ouvrir("agent-A");
    await addPendingInspection(inspection("i1", { photos: [photo("a.jpg"), photo("b.jpg")] }));
    await addPendingDefaut(defaut("d1", { status: "error" }));
    await addPendingObservation(observation("o1", { status: "conflit" }));
    await addPendingObservation(observation("o2", { status: "abandonnee" }));
    coffre.verrouiller();
    expect(await compterFile()).toEqual({
      total: 4, enAttente: 1, enErreur: 1, abandonnees: 1, enConflit: 1, refusDroits: 0, photosEnFile: 2,
      parFile: { inspections: 1, defauts: 1, portions: 0, observations: 2 },
    });
    expect(await countPending()).toBe(2);
    expect(lireCompteurs((await empreinteCompte("agent-A", sha256WebCrypto)))?.saisies).toBe(4);
    const r = await coffre.deverrouiller(MOT_DE_PASSE_PIN, Date.now());
    expect(r.ok).toBe(true);
    expect(await getAllPending()).toHaveLength(1);
  });

  it("quarantaine pour refus de DROITS : le statut `refus_droits` s'ecrit, se relit, se compte a part (verrouille aussi) et ne perd ni donnees ni photos", async () => {
    const { coffre } = await ouvrir("agent-A");
    const jointes = [photo("a.jpg", 3000, 3), photo("b.jpg", 2000, 5)];
    await addPendingObservation(observation("o1", { photos: jointes.map((p) => ({ ...p, capturedA: "2026-10-25T08:03:30.000Z" })) }));
    await addPendingDefaut(defaut("d1"));
    await addPendingPortion(portion("p1"));
    await updatePendingObservation({
      ...(await getAllPendingObservations())[0], status: "refus_droits", causeRefusDroits: "HORS_PERIMETRE", errorMessage: "hors perimetre",
    });
    await updatePendingDefaut({ ...(await getAllPendingDefauts())[0], status: "refus_droits", causeRefusDroits: "MODULE_RETIRE" });
    await updatePendingPortion({ ...(await getAllPendingPortions())[0], status: "refus_droits", causeRefusDroits: "MISSION_NON_AUTORISEE" });

    const brut = await lireBrut(nomBaseOffline(await empreinteCompte("agent-A", sha256WebCrypto)));
    // Le statut est une valeur de champ : meme version de schema, meme format, rien d'autre ne change.
    expect(DB_VERSION).toBe(5);
    expect((brut.pending_observations[0] as { status: string; fmt: number }).status).toBe("refus_droits");
    expect((brut.pending_observations[0] as { fmt: number }).fmt).toBe(1);

    const [o] = await getAllPendingObservations();
    expect(o).toMatchObject({ localId: "o1", status: "refus_droits", causeRefusDroits: "HORS_PERIMETRE", errorMessage: "hors perimetre" });
    expect(o.payload.description).toBe(SECRET);
    expect(o.photos).toHaveLength(2);
    expect(await octetsDe(o.photos![0].blob)).toEqual(octetsJpeg(3000, 3));
    expect(await octetsDe(o.photos![1].blob)).toEqual(octetsJpeg(2000, 5));

    const attendu = { total: 3, enAttente: 0, enErreur: 0, abandonnees: 0, enConflit: 0, refusDroits: 3, photosEnFile: 2 };
    expect(await compterFile()).toMatchObject(attendu);
    coffre.verrouiller();     // les enveloppes en clair suffisent : aucune cle pour compter
    expect(await compterFile()).toMatchObject(attendu);
  });

  it("un chiffreur verrouille entre le debut et la fin d'une ecriture ne laisse rien d'ecrit", async () => {
    const { coffre, empreinte } = await ouvrir("agent-A");
    const vrai = coffre.chiffrer.bind(coffre);
    vi.spyOn(coffre, "chiffrer").mockImplementation(async (d, aad) => { coffre.verrouiller(); return vrai(d, aad); });
    await expect(addPendingObservation(observation("o1"))).rejects.toMatchObject({ code: "COFFRE_VERROUILLE" });
    vi.restoreAllMocks();
    const brut = await lireBrut(nomBaseOffline(empreinte));
    expect(brut.pending_observations ?? []).toEqual([]);
  });
});

describe("deux comptes sur le meme IndexedDB : A n'atteint jamais B", () => {
  it("chacun ne voit que sa file ; les bases portent des noms differents ; aucune API ne croise", async () => {
    const a = await ouvrir("agent-A");
    await addPendingInspection(inspection("A-insp", { photos: [photo("a.jpg")] }));
    await addPendingDefaut(defaut("A-def"));
    await addPendingObservation(observation("A-obs"));
    await addPendingPortion(portion("A-por"));
    fermerCompte();

    const b = await ouvrir("agent-B");
    expect(await getAllPending()).toEqual([]);
    expect(await getAllPendingDefauts()).toEqual([]);
    expect(await getAllPendingObservations()).toEqual([]);
    expect(await getAllPendingPortions()).toEqual([]);
    expect(await getPendingInspection("A-insp")).toBeNull();
    expect((await compterFile()).total).toBe(0);
    expect(await countPending()).toBe(0);
    await addPendingInspection(inspection("B-insp"));
    await removePendingInspection("A-insp"); // meme identifiant que celui de A : ne touche rien chez A
    expect((await getAllPending()).map((i) => i.localId)).toEqual(["B-insp"]);

    const noms = (await indexedDB.databases()).map((d) => d.name).sort();
    expect(noms).toEqual([nomBaseOffline(a.empreinte), nomBaseOffline(b.empreinte)].sort());

    fermerCompte();
    ouvrirCompte({ compteId: "agent-A", empreinte: a.empreinte, chiffreur: a.coffre });
    expect((await getAllPending()).map((i) => i.localId)).toEqual(["A-insp"]);
    expect((await getAllPending())[0].photos).toHaveLength(1);
    expect((await compterFile()).total).toBe(4);
  });

  it("meme en recopiant a la main un enregistrement de A dans la base de B, B ne le lit pas (AAD liee au compte)", async () => {
    const a = await ouvrir("agent-A");
    await addPendingObservation(observation("A-obs"));
    const brutA = await lireBrut(nomBaseOffline(a.empreinte));
    fermerCompte();

    const b = await ouvrir("agent-B");
    await addPendingObservation(observation("B-obs"));
    // Un programme malveillant copie l'enregistrement de A dans la base de B, tel quel puis avec le compteId reecrit.
    const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open(nomBaseOffline(b.empreinte)); r.onsuccess = () => resolve(r.result); });
    const original = brutA.pending_observations[0] as Record<string, unknown>;
    await new Promise<void>((resolve) => {
      const tx = db.transaction("pending_observations", "readwrite");
      tx.objectStore("pending_observations").put({ ...original, localId: "copie-A" });
      tx.objectStore("pending_observations").put({ ...original, localId: "copie-A-2", compteId: "agent-B" });
      tx.oncomplete = () => resolve();
    });
    db.close();

    expect((await getAllPendingObservations()).map((o) => o.localId)).toEqual(["B-obs"]);
    const illisibles = await lireIllisibles();
    expect(illisibles.map((i) => i.localId).sort()).toEqual(["copie-A", "copie-A-2"]);
  });

  it("une saisie qui porte le ownerUserId d'un autre compte est refusee ; sans ownerUserId, le compte courant est pose", async () => {
    await ouvrir("agent-A");
    await expect(addPendingObservation(observation("o1", { ownerUserId: "agent-B" }))).rejects.toMatchObject({ code: "COMPTE_INCOHERENT" });
    expect(await getAllPendingObservations()).toEqual([]);
    await addPendingObservation(observation("o2"));
    expect((await getAllPendingObservations())[0].ownerUserId).toBe("agent-A");
  });
});

describe("plafonds des photos (aussi pour les inspections)", () => {
  it("six photos : refus clair, rien d'ecrit", async () => {
    await ouvrir("agent-A");
    const six = Array.from({ length: 6 }, (_, i) => photo(`p${i}.jpg`, 500, i + 1));
    const erreur = await addPendingInspection(inspection("insp-1", { photos: six })).catch((e: unknown) => e);
    expect(erreur).toMatchObject({ name: "ErreurStockageLocal", code: "TROP_DE_PHOTOS" });
    expect((erreur as Error).message).toMatch(/Cinq photos au maximum.*6 jointes.*PAS enregistrée/);
    expect(await getAllPending()).toEqual([]);
    await expect(addPendingDefaut(defaut("d", { photos: six.map((p) => ({ ...p, capturedA: "x" })) }))).rejects.toMatchObject({ code: "TROP_DE_PHOTOS" });
    await expect(addPendingObservation(observation("o", { photos: six.map((p) => ({ ...p, capturedA: "x" })) }))).rejects.toMatchObject({ code: "TROP_DE_PHOTOS" });
  });

  it("cinq photos passent ; une photo de 8 Mio exactement passe, 8 Mio + 1 octet est refusee avec son nom et sa taille", async () => {
    await ouvrir("agent-A");
    await addPendingInspection(inspection("insp-5", { photos: Array.from({ length: 5 }, (_, i) => photo(`p${i}.jpg`, 500, i)) }));
    const pile = { name: "pile.jpg", blob: new Blob([octetsJpeg(PHOTO_TAILLE_MAX_OCTETS)], { type: "image/jpeg" }) };
    await addPendingInspection(inspection("insp-pile", { photos: [pile] }));

    const trop = { name: "gros.jpg", blob: new Blob([octetsJpeg(PHOTO_TAILLE_MAX_OCTETS + 1)], { type: "image/jpeg" }) };
    const erreur = await addPendingInspection(inspection("insp-gros", { photos: [trop] })).catch((e: unknown) => e);
    expect(erreur).toMatchObject({ code: "PHOTO_TROP_GROSSE" });
    expect((erreur as Error).message).toMatch(/gros\.jpg.*8,0 Mio.*PAS enregistrée/);
    expect((await getAllPending()).map((i) => i.localId).sort()).toEqual(["insp-5", "insp-pile"]);
  });

  it("la mise a jour d'une saisie ne rejette pas sur le nombre de photos (la synchronisation ne fait que en retirer)", async () => {
    await ouvrir("agent-A");
    await addPendingInspection(inspection("insp-1", { photos: [photo("a.jpg", 300, 1), photo("b.jpg", 300, 2)] }));
    const [lu] = await getAllPending();
    await expect(updatePendingInspection({ ...lu, status: "error", errorMessage: "reseau" })).resolves.toBeUndefined();
  });
});

describe("saisie NON enregistree : jamais annoncee comme enregistree", () => {
  /** Simule ce que fait un navigateur a court de place : la transaction est annulee avec QuotaExceededError. */
  function simulerQuotaPlein() {
    const vrai = IDBObjectStore.prototype.put;
    return vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      const r = vrai.apply(this, args);
      abandonner(this.transaction, "QuotaExceededError");
      return r;
    });
  }

  it("quota plein : STOCKAGE_PLEIN avec un message clair, rien d'ecrit, et l'ecriture suivante reussit une fois la place revenue", async () => {
    await ouvrir("agent-A");
    await addPendingObservation(observation("existante"));
    const espion = simulerQuotaPlein();
    const erreur = await addPendingObservation(observation("nouvelle", { photos: [{ ...photo("x.jpg"), capturedA: "x" }] })).catch((e: unknown) => e);
    expect(erreur).toMatchObject({ name: "ErreurStockageLocal", code: "STOCKAGE_PLEIN" });
    expect((erreur as Error).message).toMatch(/Stockage de l'appareil plein.*n'est PAS enregistrée/);
    espion.mockRestore();
    expect((await getAllPendingObservations()).map((o) => o.localId)).toEqual(["existante"]);
    await addPendingObservation(observation("nouvelle"));
    expect((await getAllPendingObservations()).map((o) => o.localId).sort()).toEqual(["existante", "nouvelle"]);
  });

  it("quota plein sur chacune des quatre files et sur les retraits : la promesse rejette, elle ne reste jamais pendante", async () => {
    await ouvrir("agent-A");
    await addPendingInspection(inspection("i0"));
    const espion = simulerQuotaPlein();
    await expect(addPendingInspection(inspection("i1"))).rejects.toMatchObject({ code: "STOCKAGE_PLEIN" });
    await expect(addPendingDefaut(defaut("d1"))).rejects.toMatchObject({ code: "STOCKAGE_PLEIN" });
    await expect(addPendingPortion(portion("p1"))).rejects.toMatchObject({ code: "STOCKAGE_PLEIN" });
    await expect(addPendingObservation(observation("o1"))).rejects.toMatchObject({ code: "STOCKAGE_PLEIN" });
    espion.mockRestore();
    // Un retrait annule laisse la saisie en place.
    const delet = vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (this: IDBObjectStore) {
      abandonner(this.transaction, "QuotaExceededError");
      return undefined as never;
    });
    await expect(removePendingInspection("i0")).rejects.toMatchObject({ code: "STOCKAGE_PLEIN" });
    delet.mockRestore();
    expect((await getAllPending()).map((i) => i.localId)).toEqual(["i0"]);
  });

  it("une exception de quota levee a l'appel de put (avant toute transaction terminee) rejette aussi", async () => {
    await ouvrir("agent-A");
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => { throw new DOMException("plein", "QuotaExceededError"); });
    await expect(addPendingDefaut(defaut("d1"))).rejects.toMatchObject({ code: "STOCKAGE_PLEIN" });
  });

  it("un autre abandon de transaction rejette avec sa cause", async () => {
    await ouvrir("agent-A");
    const vrai = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      const r = vrai.apply(this, args);
      abandonner(this.transaction, "AbortError");
      return r;
    });
    await expect(addPendingPortion(portion("p1"))).rejects.toMatchObject({ code: "ECRITURE_ANNULEE" });
  });
});

describe("un enregistrement altere est une erreur typee, pas un plantage de la file", () => {
  async function alterer(empreinte: string, magasin: string, localId: string, f: (r: Record<string, unknown>) => Record<string, unknown>) {
    const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open(nomBaseOffline(empreinte)); r.onsuccess = () => resolve(r.result); });
    const tx = db.transaction(magasin, "readwrite");
    const os = tx.objectStore(magasin);
    const lecture = os.get(localId);
    await new Promise<void>((resolve) => {
      lecture.onsuccess = () => { os.put(f(lecture.result as Record<string, unknown>)); };
      tx.oncomplete = () => resolve();
    });
    db.close();
  }

  it("un octet retourne dans la charge : la liste ecarte la saisie, les autres se lisent, lireIllisibles la montre, la lecture directe leve", async () => {
    const { empreinte } = await ouvrir("agent-A");
    await addPendingObservation(observation("bonne"));
    await addPendingObservation(observation("abimee"));
    await addPendingDefaut(defaut("autre-file"));
    await alterer(empreinte, "pending_observations", "abimee", (r) => {
      const charge = new Uint8Array(r.charge as Uint8Array);
      charge[charge.length - 1] ^= 0xff;
      return { ...r, charge };
    });

    expect((await getAllPendingObservations()).map((o) => o.localId)).toEqual(["bonne"]);
    expect((await getAllPendingDefauts()).map((o) => o.localId)).toEqual(["autre-file"]);
    expect(await lireIllisibles()).toEqual([{ file: "observations", localId: "abimee", status: "pending", createdAt: "2026-10-25T08:03:00.000Z", nature: "ILLISIBLE" }]);
    // Jamais supprimee : toujours comptee.
    expect((await compterFile()).total).toBe(3);
  });

  it("un statut retouche en clair (enveloppe) ne correspond plus au contenu chiffre : saisie rejetee", async () => {
    const { empreinte } = await ouvrir("agent-A");
    await addPendingInspection(inspection("insp-1", { status: "abandonnee" }));
    await alterer(empreinte, "pending_inspections", "insp-1", (r) => ({ ...r, status: "pending" }));
    expect(await getAllPending()).toEqual([]);
    await expect(getPendingInspection("insp-1")).rejects.toMatchObject({ code: "DONNEES_ALTEREES" });
  });

  it("une photo alteree : la saisie legere se lit encore, la saisie complete leve DONNEES_ALTEREES", async () => {
    const { empreinte } = await ouvrir("agent-A");
    await addPendingInspection(inspection("insp-1", { photos: [photo("a.jpg", 2000, 1)] }));
    const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open(nomBaseOffline(empreinte)); r.onsuccess = () => resolve(r.result); });
    await new Promise<void>((resolve) => {
      const tx = db.transaction("pending_photos", "readwrite");
      const os = tx.objectStore("pending_photos");
      const g = os.getAll();
      g.onsuccess = () => { for (const r of g.result as { paquet: Uint8Array }[]) { const p = new Uint8Array(r.paquet); p[40] ^= 1; os.put({ ...r, paquet: p }); } };
      tx.oncomplete = () => resolve();
    });
    db.close();
    expect((await getAllPending({ sansPhotos: true }))).toHaveLength(1);
    expect(await getAllPending()).toEqual([]);
    await expect(getPendingInspection("insp-1")).rejects.toMatchObject({ code: "DONNEES_ALTEREES" });
  });

  it("un enregistrement en clair d'avant le chiffrement n'est jamais rendu : il est signale « format inconnu » et conserve", async () => {
    const { empreinte } = await ouvrir("agent-A");
    await addPendingInspection(inspection("chiffree"));
    const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open(nomBaseOffline(empreinte)); r.onsuccess = () => resolve(r.result); });
    await new Promise<void>((resolve) => {
      const tx = db.transaction("pending_inspections", "readwrite");
      tx.objectStore("pending_inspections").put({ localId: "ancienne", ownerUserId: "agent-A", status: "pending", payload: { defautsConstates: SECRET }, photos: [], createdAt: "x" });
      tx.oncomplete = () => resolve();
    });
    db.close();
    expect((await getAllPending()).map((i) => i.localId)).toEqual(["chiffree"]);
    const illisibles = await lireIllisibles();
    expect(illisibles).toEqual([{ file: "inspections", localId: "ancienne", status: "pending", createdAt: "x", nature: "FORMAT_INCONNU" }]);
  });
});

describe("schema", () => {
  it("version 5 : quatre files avec index compteId, magasin des photos, aucun magasin supprime", async () => {
    const { empreinte } = await ouvrir("agent-A");
    await getAllPending();
    const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open(nomBaseOffline(empreinte)); r.onsuccess = () => resolve(r.result); });
    expect(db.version).toBe(DB_VERSION);
    expect(DB_VERSION).toBe(5);
    expect(Array.from(db.objectStoreNames).sort()).toEqual(["pending_defauts", "pending_inspections", "pending_observations", "pending_photos", "pending_portions"]);
    const tx = db.transaction(Array.from(db.objectStoreNames), "readonly");
    for (const nom of ["pending_defauts", "pending_inspections", "pending_observations", "pending_portions"]) {
      expect(Array.from(tx.objectStore(nom).indexNames)).toContain("compteId");
    }
    expect(Array.from(tx.objectStore("pending_photos").indexNames)).toContain("parSaisie");
    db.close();
  });
});
