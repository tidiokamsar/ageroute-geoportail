import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";

/**
 * Lecture du VRAI IndexedDB du navigateur, tel que Chromium le stocke : c'est ce qu'un autre agent du meme telephone, ou
 * quelqu'un qui copie le profil, verrait. Les tests sous jsdom ne peuvent pas le faire.
 *
 * Depuis la session hors ligne (docs/securite/SESSION-HORS-LIGNE.md, sections 3 et 4) :
 *   - UNE BASE PAR COMPTE : `bdri-offline-<empreinte>` (empreinte = 16 premiers caracteres hexadecimaux de SHA-256 de l'identifiant du
 *     compte), de meme `bdri-roulage-<empreinte>` ; le coffre (code PIN, cle enveloppee) est dans `bdri-coffre` ;
 *   - la saisie est CHIFFREE : l'enveloppe en clair ne porte que `localId`, `compteId`, `status`, `createdAt`, `fmt`, `nbPhotos` et
 *     la `charge` chiffree ; les photos sont des blocs chiffres dans `pending_photos`.
 * `lireFile` rend donc ce qu'on peut lire SANS cle : de quoi compter, trier, suivre un statut, et correler une saisie a la ligne
 * du serveur (`localId` = `clientOperationId`). Le CONTENU d'une saisie ne se lit pas ici, et c'est le but.
 */
export type MagasinFile = "pending_observations" | "pending_inspections" | "pending_defauts" | "pending_portions";

export interface EntreeFile {
  localId: string;
  compteId: string;
  status: string;
  createdAt: string;
  nbPhotos: number;
  /** Taille en octets de la charge chiffree. */
  tailleCharge: number;
}

/** Empreinte de compte de `frontend/src/session/compteLocal.ts` : 16 premiers hexadecimaux de SHA-256(identifiant UTF-8). */
export function empreinteCompte(compteId: string): string {
  return createHash("sha256").update(compteId, "utf8").digest("hex").slice(0, 16);
}

export const nomBaseOffline = (compteId: string) => `bdri-offline-${empreinteCompte(compteId)}`;
export const nomBaseRoulage = (compteId: string) => `bdri-roulage-${empreinteCompte(compteId)}`;

/** Noms de toutes les bases IndexedDB de l'origine. */
export async function nomsBases(page: Page): Promise<string[]> {
  return evaluerStable(page, async () => ((await indexedDB.databases()) ?? []).map((d) => d.name ?? "").filter(Boolean).sort());
}

/** Les enveloppes d'une file, pour un compte. Liste vide si la base du compte n'existe pas (rien n'est cree par cette lecture). */
export async function lireFile(page: Page, magasin: MagasinFile, compteId: string): Promise<EntreeFile[]> {
  const nom = nomBaseOffline(compteId);
  return evaluerStable(page, async ({ nom, m }) => {
    const existantes = ((await indexedDB.databases()) ?? []).map((d) => d.name);
    if (!existantes.includes(nom)) return [];
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const r = indexedDB.open(nom);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      if (!db.objectStoreNames.contains(m)) return [];
      const items: Array<Record<string, any>> = await new Promise((resolve, reject) => {
        const r = db.transaction(m, "readonly").objectStore(m).getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      return items.map((i) => ({
        localId: i.localId, compteId: i.compteId, status: i.status, createdAt: i.createdAt, nbPhotos: i.nbPhotos ?? 0,
        tailleCharge: i.charge?.byteLength ?? 0,
      }));
    } finally {
      db.close();
    }
  }, { nom, m: magasin });
}

/** Nombre de blocs de photo chiffres stockes pour un compte. */
export async function compterPhotos(page: Page, compteId: string): Promise<number> {
  const nom = nomBaseOffline(compteId);
  return evaluerStable(page, async (nom) => {
    const existantes = ((await indexedDB.databases()) ?? []).map((d) => d.name);
    if (!existantes.includes(nom)) return 0;
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const r = indexedDB.open(nom);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      if (!db.objectStoreNames.contains("pending_photos")) return 0;
      return await new Promise<number>((resolve, reject) => {
        const r = db.transaction("pending_photos", "readonly").objectStore("pending_photos").count();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    } finally {
      db.close();
    }
  }, nom);
}

/** Tout le stockage brut de l'origine : chaines (JSON) et blocs binaires (octets reels), pour y chercher du clair. */
export interface StockageBrut {
  /** Representation JSON de tout (les binaires y sont remplaces par leur taille). */
  json: string;
  binaires: Buffer[];
  bases: string[];
}

export async function lireStockageBrut(page: Page): Promise<StockageBrut> {
  const r = await evaluerStable(page, async () => {
    const binaires: string[] = [];
    const versBase64 = (o: Uint8Array): string => {
      let s = "";
      for (let i = 0; i < o.length; i += 0x8000) s += String.fromCharCode(...o.subarray(i, i + 0x8000));
      return btoa(s);
    };
    async function plat(v: any, profondeur = 0): Promise<any> {
      if (profondeur > 12) return "[profondeur]";
      if (v instanceof Blob) { binaires.push(versBase64(new Uint8Array(await v.arrayBuffer()))); return `[Blob ${v.size}]`; }
      if (v instanceof ArrayBuffer) { binaires.push(versBase64(new Uint8Array(v))); return `[ArrayBuffer ${v.byteLength}]`; }
      if (ArrayBuffer.isView(v)) { const o = new Uint8Array(v.buffer, v.byteOffset, v.byteLength); binaires.push(versBase64(o)); return `[octets ${o.length}]`; }
      if (Array.isArray(v)) return Promise.all(v.map((x) => plat(x, profondeur + 1)));
      if (v && typeof v === "object") {
        const sortie: Record<string, any> = {};
        for (const [k, x] of Object.entries(v)) sortie[k] = await plat(x, profondeur + 1);
        return sortie;
      }
      return v;
    }
    const bases: string[] = [];
    const contenu: Record<string, any> = {};
    for (const d of (await indexedDB.databases()) ?? []) {
      if (!d.name) continue;
      bases.push(d.name);
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const q = indexedDB.open(d.name!);
        q.onsuccess = () => resolve(q.result);
        q.onerror = () => reject(q.error);
      });
      contenu[d.name] = {};
      try {
        for (const magasin of Array.from(db.objectStoreNames)) {
          const lignes: any[] = await new Promise((resolve, reject) => {
            const q = db.transaction(magasin, "readonly").objectStore(magasin).getAll();
            q.onsuccess = () => resolve(q.result);
            q.onerror = () => reject(q.error);
          });
          contenu[d.name][magasin] = await plat(lignes);
        }
      } finally {
        db.close();
      }
    }
    let local = "";
    try { local = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }); } catch { /* indisponible */ }
    return { json: JSON.stringify(contenu) + local, binaires, bases };
  });
  return { json: r.json, binaires: r.binaires.map((b) => Buffer.from(b, "base64")), bases: r.bases };
}

/** Vrai si `aiguille` (texte ou octets) apparait en clair, dans une chaine ou dans un bloc binaire, n'importe ou du stockage. */
export function contientEnClair(brut: StockageBrut, aiguille: string | Buffer): boolean {
  const a = typeof aiguille === "string" ? Buffer.from(aiguille, "utf8") : aiguille;
  if (typeof aiguille === "string" && brut.json.includes(aiguille)) return true;
  if (Buffer.from(brut.json, "utf8").includes(a)) return true;
  return brut.binaires.some((b) => b.includes(a));
}

/**
 * `page.evaluate` qui reessaie quand la page change sous le pied (« Execution context was destroyed ») : une lecture de stockage faite
 * pendant une redirection (renvoi vers /login, rechargement) n'est pas une erreur du test. Cinq essais, en attendant le chargement.
 */
async function evaluerStable<R, A = undefined>(page: Page, fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> {
  for (let i = 0; ; i++) {
    try {
      return (await page.evaluate(fn as (a: unknown) => unknown, arg)) as R;
    } catch (e) {
      if (i >= 4 || !/Execution context was destroyed|navigat/i.test(String(e))) throw e;
      await page.waitForLoadState("load").catch(() => undefined);
    }
  }
}
