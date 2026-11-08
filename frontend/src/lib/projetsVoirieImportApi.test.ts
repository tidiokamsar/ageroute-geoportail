import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("./api", () => ({ api: { get: h.get, post: h.post, patch: vi.fn(), delete: vi.fn() } }));

import {
  apercevoirFichier, chargerOptionsImport, deposerAvecOptions, inventorierFichier, lireDeltaJeu, revenirEnArriere, revoirSuppressions,
} from "./projetsVoirieImportApi";
import { SAISIE_VIDE, construireDonneesDepot, lireOptionsImport } from "./projetsVoirieImport";
import { DELTA_AUTORISE_AVEC_RETOUR, OPTIONS, SHA, apercu, inventaireKml, reponseDepot } from "../components/projets-voirie/assistant/assistantImport.testutil";

/** Client de l'assistant d'import : routes du contrat A1, champs AVANT le fichier, annulation, progression. */

const BASE = "/v2/projets-voirie";
beforeEach(() => { h.get.mockReset(); h.post.mockReset(); });
const fichier = new File(["<kml/>"], "reseau-synthetique.kml");
const entrees = (corps: FormData) => [...corps.entries()].map(([k, v]) => [k, typeof v === "string" ? v : "(fichier)"]);

describe("etape 0 : options", () => {
  it("GET /:id/import/options, signal transmis", async () => {
    h.get.mockResolvedValueOnce({ data: OPTIONS });
    const c = new AbortController();
    const o = await chargerOptionsImport("p/1", c.signal);
    expect(h.get).toHaveBeenCalledWith(`${BASE}/p%2F1/import/options`, { signal: c.signal });
    expect(o.formats).toHaveLength(5);
  });
  it("une reponse inattendue leve", async () => {
    h.get.mockResolvedValueOnce({ data: { x: 1 } });
    await expect(chargerOptionsImport("p1")).rejects.toThrow(/Réponse inattendue/);
  });
});

describe("inventaire et apercu : le fichier est renvoye a chaque etape, apres ses options", () => {
  it("POST /:id/import/inventaire : champs puis fichier, signal et progression", async () => {
    h.post.mockImplementationOnce(async (_u: string, _c: FormData, cfg: { onUploadProgress?: (e: { loaded: number; total?: number }) => void }) => {
      cfg.onUploadProgress?.({ loaded: 50, total: 100 });
      return { data: inventaireKml() };
    });
    const c = new AbortController();
    const progression: Array<[number, number | null]> = [];
    const inv = await inventorierFichier("p1", fichier, { couche: "c1", entreeKml: "a.kml" }, { signal: c.signal, onProgression: (e, t) => progression.push([e, t]) });
    const [url, corps, cfg] = h.post.mock.calls[0];
    expect(url).toBe(`${BASE}/p1/import/inventaire`);
    expect(entrees(corps)).toEqual([["couche", "c1"], ["entreeKml", "a.kml"], ["fichier", "(fichier)"]]);
    expect(cfg.signal).toBe(c.signal);
    expect(progression).toEqual([[50, 100]]);
    expect(inv.format).toBe("KML");
  });
  it("POST /:id/import/apercu", async () => {
    h.post.mockResolvedValueOnce({ data: apercu() });
    const a = await apercevoirFichier("p1", fichier, { epsgSource: "32629", sha256Attendu: SHA });
    expect(h.post.mock.calls[0][0]).toBe(`${BASE}/p1/import/apercu`);
    expect(entrees(h.post.mock.calls[0][1])).toEqual([["epsgSource", "32629"], ["sha256Attendu", SHA], ["fichier", "(fichier)"]]);
    expect(a.echantillon.objets).toHaveLength(3);
  });
  it("une progression sans taille totale est rendue sans total", async () => {
    h.post.mockImplementationOnce(async (_u: string, _c: FormData, cfg: { onUploadProgress?: (e: { loaded: number; total?: number }) => void }) => {
      cfg.onUploadProgress?.({ loaded: 10 });
      return { data: apercu() };
    });
    const p: Array<number | null> = [];
    await apercevoirFichier("p1", fichier, {}, { onProgression: (_e, t) => p.push(t) });
    expect(p).toEqual([null]);
  });
});

describe("simulation et depot avec options d'import", () => {
  const donnees = () => construireDonneesDepot({ ...SAISIE_VIDE, fichier, concessionnaireId: "c1" }, lireOptionsImport(OPTIONS).formats, 1e6, { epsgSource: "32629", sha256Attendu: SHA, mapping: "{\"nom\":\"Name\"}" }).donnees!;
  it("simulation : ?simuler=true, options avant le fichier, signal transmis", async () => {
    h.post.mockResolvedValueOnce({ data: reponseDepot() });
    const c = new AbortController();
    const r = await deposerAvecOptions("p1", donnees(), { simuler: true, signal: c.signal });
    const [url, corps, cfg] = h.post.mock.calls[0];
    expect(url).toBe(`${BASE}/p1/jeux`);
    expect(cfg.params).toEqual({ simuler: "true" });
    expect(cfg.signal).toBe(c.signal);
    const e = entrees(corps);
    expect(e[e.length - 1]).toEqual(["fichier", "(fichier)"]);
    expect(Object.fromEntries(e)).toMatchObject({ role: "RESEAU_TIERS", concessionnaireId: "c1", epsgSource: "32629", sha256Attendu: SHA, mapping: "{\"nom\":\"Name\"}" });
    expect(r.simulation).toBe(true);
    expect(r.version).toBe(3);
    expect(r.suppressions).toEqual({ statut: "A_REVOIR", nb: 1 });
    expect(r.delta).toEqual({ ajoutes: 1, modifies: 1, retires: 1, identiques: 0 });
    expect(r.crs?.epsgSource).toBe(4326);
    expect(r.jeu).toBeNull();
  });
  it("depot reel : sans ?simuler, jeu identifie", async () => {
    h.post.mockResolvedValueOnce({ data: reponseDepot({}, false) });
    const r = await deposerAvecOptions("p1", donnees(), { simuler: false });
    expect(h.post.mock.calls[0][2].params).toBeUndefined();
    expect(r.jeu?.id).toBe("jeu-nouveau");
  });
});

describe("delta, revue, retour arriere", () => {
  it("GET delta", async () => {
    h.get.mockResolvedValueOnce({ data: DELTA_AUTORISE_AVEC_RETOUR() });
    const d = await lireDeltaJeu("p1", "j/1");
    expect(h.get).toHaveBeenCalledWith(`${BASE}/p1/jeux/j%2F1/delta`, { signal: undefined });
    expect(d.retourArriere?.possible).toBe(true);
  });
  it("POST revue-suppressions : decision et justification", async () => {
    h.post.mockResolvedValueOnce({ data: { jeu: {}, suppressions: { statut: "REFUSEES", nb: 1, revue: null }, evenement: { id: "e1" } } });
    const r = await revoirSuppressions("p1", "j1", "REFUSER", "Regard 2 existe toujours");
    expect(h.post).toHaveBeenCalledWith(`${BASE}/p1/jeux/j1/revue-suppressions`, { decision: "REFUSER", justification: "Regard 2 existe toujours" });
    expect(r.suppressions.statut).toBe("REFUSEES");
  });
  it("POST retour-arriere", async () => {
    h.post.mockResolvedValueOnce({ data: { jeuRestaure: { id: "a", version: 2 }, jeuRetire: { id: "b", version: 3 }, evenement: { id: "e" } } });
    const r = await revenirEnArriere("p1", "b", "Retour a la version 2 : suppression a tort");
    expect(h.post).toHaveBeenCalledWith(`${BASE}/p1/jeux/b/retour-arriere`, { justification: "Retour a la version 2 : suppression a tort" });
    expect(r.restaureVersion).toBe(2);
  });
});
