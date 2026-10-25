import { afterEach, describe, expect, it, vi } from "vitest";
import { demanderStockagePersistant, estimerStockage, etatPermissionGps, garderEcranAllume, nomFichierGpx, positionVersEchantillon, stockageIndexedDb, stockageMemoire, versGpx } from "./roulageHote";
import type { EntreeJournal } from "../roulage/journal";

/**
 * Couche hote du navigateur : ce que ces tests defendent.
 *   - une valeur absente ou aberrante du navigateur reste `null` : la precision n'est JAMAIS inventee ;
 *   - le GPX n'a qu'un `<trkseg>` par segment du noyau (un trou de signal n'est pas une ligne droite) ;
 *   - la veille de l'ecran ne leve jamais : sans l'API ou refusee, elle dit `actif: false`.
 */

const pos = (surcharge: Partial<{ accuracy: number | null; speed: number | null; heading: number | null; altitude: number | null }> = {}) => ({
  timestamp: 1_790_000_000_000,
  coords: { latitude: 9.64, longitude: -13.6, accuracy: 8, speed: 11, heading: 90, altitude: 40, ...surcharge },
});

describe("positionVersEchantillon", () => {
  it("recopie une position complete", () => {
    expect(positionVersEchantillon(pos())).toEqual({ tMs: 1_790_000_000_000, lat: 9.64, lon: -13.6, precisionM: 8, vitesseMs: 11, capDeg: 90, altitudeM: 40 });
  });

  it("garde `null` pour ce que le navigateur ne donne pas, sans rien inventer", () => {
    const e = positionVersEchantillon(pos({ accuracy: null, speed: null, heading: null, altitude: null }));
    expect(e).toMatchObject({ precisionM: null, vitesseMs: null, capDeg: null, altitudeM: null });
  });

  it("refuse les valeurs aberrantes : precision ou vitesse negative, cap hors de 0 a 360, NaN", () => {
    const e = positionVersEchantillon(pos({ accuracy: -1, speed: -3, heading: 400, altitude: Number.NaN }));
    expect(e).toMatchObject({ precisionM: null, vitesseMs: null, capDeg: null, altitudeM: null });
    expect(positionVersEchantillon(pos({ accuracy: Number.POSITIVE_INFINITY })).precisionM).toBeNull();
  });

  it("accepte une precision nulle (zero est une valeur, pas une absence)", () => {
    expect(positionVersEchantillon(pos({ accuracy: 0 })).precisionM).toBe(0);
  });
});

describe("versGpx", () => {
  const pt = (s: number, segment: number) => ({ tMs: 1_790_000_000_000 + s * 1000, lat: 9.64 + s * 1e-4, lon: -13.6, precisionM: 5, vitesseMs: 10, capDeg: 90, altitudeM: null, segment });

  it("ecrit un trkseg par segment : un trou n'est pas relie par une ligne droite", () => {
    const gpx = versGpx({ sessionId: "s", echantillons: [pt(0, 0), pt(1, 0), pt(30, 1), pt(31, 1)] });
    expect(gpx.match(/<trkseg>/g)).toHaveLength(2);
    expect(gpx.match(/<trkpt /g)).toHaveLength(4);
    expect(gpx).toContain('<time>' + new Date(1_790_000_000_000).toISOString() + '</time>');
    expect(gpx.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });

  it("echappe le nom et reste un XML bien forme", () => {
    const gpx = versGpx({ sessionId: "s", echantillons: [pt(0, 0)] }, 'Relevé <A> & "B"');
    expect(gpx).toContain("Relevé &lt;A&gt; &amp; &quot;B&quot;");
    expect(gpx).not.toMatch(/<name>[^<]*<A>/);
  });

  it("une session sans position ne produit aucun point", () => {
    expect(versGpx({ sessionId: "s", echantillons: [] }).match(/<trkpt /g)).toBeNull();
  });
});

describe("nomFichierGpx", () => {
  it("donne un nom sans espace ni deux-points", () => {
    expect(nomFichierGpx(Date.UTC(2026, 9, 22, 14, 5))).toBe("releve-2026-10-22-14-05.gpx");
  });
});

describe("stockageMemoire", () => {
  const entree = (seq: number) => ({ seq, type: "ARRET", tMs: seq }) as unknown as EntreeJournal;

  it("garde les entrees dans l'ordre, par copie, et se vide", async () => {
    const s = stockageMemoire();
    const e = entree(1);
    s.ajouter(e);
    s.ajouter(entree(2));
    (e as unknown as { tMs: number }).tMs = 999;
    const toutes = await s.toutes();
    expect(toutes.map((x) => x.seq)).toEqual([1, 2]);
    expect((toutes[0] as unknown as { tMs: number }).tMs).toBe(1);
    await s.vider();
    expect(await s.toutes()).toEqual([]);
    expect(s.nature).toBe("memoire");
  });
});

describe("garderEcranAllume", () => {
  it("sans l'API : actif=false, sans lever", async () => {
    const v = await garderEcranAllume({});
    expect(v.actif).toBe(false);
    await expect(v.liberer()).resolves.toBeUndefined();
  });

  it("API refusee par le navigateur : actif=false, sans lever", async () => {
    const v = await garderEcranAllume({ wakeLock: { request: async () => { throw new Error("NotAllowedError"); } } });
    expect(v.actif).toBe(false);
  });

  it("API acceptee : actif=true, et liberer() relache le verrou", async () => {
    let relache = 0;
    const v = await garderEcranAllume({ wakeLock: { request: async () => ({ release: async () => { relache += 1; } }) } });
    expect(v.actif).toBe(true);
    await v.liberer();
    expect(relache).toBe(1);
  });
});

describe("permission GPS, stockage", () => {
  it("la permission est lue sans etre demandee ; sans API ou en erreur : « inconnue », jamais un refus invente", async () => {
    const etat = (state: string) => etatPermissionGps({ permissions: { query: async () => ({ state }) } });
    expect(await etat("granted")).toBe("accordee");
    expect(await etat("denied")).toBe("refusee");
    expect(await etat("prompt")).toBe("a_demander");
    expect(await etat("autre")).toBe("inconnue");
    expect(await etatPermissionGps({})).toBe("inconnue");
    expect(await etatPermissionGps({ permissions: { query: async () => { throw new Error("TypeError"); } } })).toBe("inconnue");
  });

  it("l'estimation du stockage donne la part utilisee ; absente ou incoherente : null", async () => {
    const e = await estimerStockage({ storage: { estimate: async () => ({ usage: 50 * 1_048_576, quota: 200 * 1_048_576 }) } });
    expect(e).not.toBeNull();
    expect(e?.part).toBeCloseTo(0.25, 6);
    expect(e?.usageMo).toBeCloseTo(50, 6);
    expect(await estimerStockage({})).toBeNull();
    expect(await estimerStockage({ storage: { estimate: async () => ({ usage: 1, quota: 0 }) } })).toBeNull();
    expect(await estimerStockage({ storage: { estimate: async () => { throw new Error("x"); } } })).toBeNull();
  });

  it("la persistance du stockage ne leve jamais : sans API ou refusee, c'est « false »", async () => {
    expect(await demanderStockagePersistant({ storage: { persist: async () => true } })).toBe(true);
    expect(await demanderStockagePersistant({ storage: { persist: async () => false } })).toBe(false);
    expect(await demanderStockagePersistant({})).toBe(false);
    expect(await demanderStockagePersistant({ storage: { persist: async () => { throw new Error("x"); } } })).toBe(false);
  });
});

/**
 * Les ecritures du journal sont lancees sans attendre : leur echec ne se voit QUE dans `echecs()`. L'ecran de roulage le lit
 * pour dire « le journal n'est plus ecrit » (test de l'ecran dans `EnregistrementRoulagePage.test.tsx`). Faux IndexedDB minimal :
 * une transaction qui se termine, ou qui est annulee (quota).
 */
describe("stockage du journal : les echecs d'ecriture sont comptes", () => {
  afterEach(() => vi.unstubAllGlobals());

  function fauxIndexedDB(issue: () => "ok" | "abandon") {
    return {
      open() {
        const req: { result: unknown; error: null; onsuccess: (() => void) | null; onerror: (() => void) | null; onupgradeneeded: (() => void) | null } =
          { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
        setTimeout(() => {
          req.result = {
            objectStoreNames: { contains: () => true },
            transaction: () => {
              const tx: { error: { name: string }; oncomplete: (() => void) | null; onerror: (() => void) | null; onabort: (() => void) | null; objectStore: () => unknown } = {
                error: { name: "QuotaExceededError" }, oncomplete: null, onerror: null, onabort: null,
                objectStore: () => ({ put: () => ({ result: undefined }) }),
              };
              const sortie = issue();
              setTimeout(() => (sortie === "ok" ? tx.oncomplete?.() : tx.onabort?.()), 0);
              return tx;
            },
          };
          req.onsuccess?.();
        }, 0);
        return req;
      },
    };
  }
  const entree = { seq: 1, type: "ARRET", tMs: 1 } as unknown as EntreeJournal;
  const attendre = () => new Promise((r) => setTimeout(r, 30));

  it("une ecriture annulee (quota) incremente echecs(), sans lever d'erreur dans le noyau", async () => {
    vi.stubGlobal("indexedDB", fauxIndexedDB(() => "abandon"));
    const s = stockageIndexedDb();
    expect(s).not.toBeNull();
    expect(s!.echecs()).toBe(0);
    expect(() => s!.ajouter(entree)).not.toThrow();
    s!.ajouter({ ...entree, seq: 2 } as EntreeJournal);
    await attendre();
    expect(s!.echecs()).toBe(2);
  });

  it("une ecriture reussie ne compte aucun echec", async () => {
    vi.stubGlobal("indexedDB", fauxIndexedDB(() => "ok"));
    const s = stockageIndexedDb()!;
    s.ajouter(entree);
    await attendre();
    expect(s.echecs()).toBe(0);
  });
});
