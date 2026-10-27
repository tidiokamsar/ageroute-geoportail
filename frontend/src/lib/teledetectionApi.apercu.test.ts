// @vitest-environment node
// Environnement node : jsdom ne porte pas un vrai Blob lisible (`text()`), or c'est exactement la forme que prend
// `error.response.data` quand axios est configure en `responseType: "blob"`. Les tests de teledetectionApi.test.ts,
// eux, simulaient une erreur JSON et laissaient passer le defaut : en reel le corps d'erreur est un Blob.
import axios, { type AxiosAdapter, type AxiosResponse, AxiosError } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ adapter: null as null | AxiosAdapter }));

// Vrai client axios : seul le transport reseau est remplace par un adaptateur (qui rend un Blob, comme XHR en `responseType: "blob"`).
vi.mock("./api", () => ({
  api: axios.create({ adapter: (config) => (h.adapter as AxiosAdapter)(config) }),
}));

import { api } from "./api";
import { ApercuIllisible, classerErreur, lireApercu } from "./teledetectionApi";

/** Reponse telle que la rend XHR en `responseType: "blob"` : le corps (JSON compris) est un Blob. */
function repondre(status: number, corps: BlobPart | null, type: string): AxiosAdapter {
  return async (config) => {
    const response: AxiosResponse = {
      data: corps === null ? new Blob([], { type }) : new Blob([corps], { type }),
      status, statusText: String(status), headers: {}, config, request: {},
    };
    if (status >= 200 && status < 300) return response;
    throw new AxiosError(`HTTP ${status}`, "ERR_BAD_REQUEST", config, {}, response);
  };
}

const CHEMIN = "/api/v2/teledetection/produits/p1/apercu";
const attraper = async (): Promise<unknown> => { try { await lireApercu(CHEMIN); } catch (e) { return e; } throw new Error("aucune erreur levee"); };

beforeEach(() => { h.adapter = null; });

describe("lireApercu : le corps d'erreur est un vrai Blob (responseType blob)", () => {
  it("axios rend bien un Blob pour le corps d'erreur : c'est la forme reelle que le defaut ignorait", async () => {
    h.adapter = repondre(404, JSON.stringify({ error: "Aperçu indisponible", code: "APERCU_INDISPONIBLE" }), "application/json");
    const brut = await api.get(CHEMIN, { responseType: "blob" }).catch((e: AxiosError) => e);
    expect((brut as AxiosError).response?.data).toBeInstanceOf(Blob);
    expect(classerErreur(brut).code).toBeNull(); // sans relecture du Blob : le code est perdu
  });

  it("404 {error, code: APERCU_INDISPONIBLE} : le code et le message du serveur sont lus dans le Blob", async () => {
    h.adapter = repondre(404, JSON.stringify({ error: "Aperçu indisponible : le fournisseur a répondu 404", code: "APERCU_INDISPONIBLE" }), "application/json; charset=utf-8");
    const t = classerErreur(await attraper());
    expect(t.status).toBe(404);
    expect(t.code).toBe("APERCU_INDISPONIBLE");
    expect(t.genre).toBe("introuvable");
    expect(t.message).toBe("Aperçu indisponible : le fournisseur a répondu 404");
  });

  it("404 sans code (corps JSON sans code) : introuvable, code nul, jamais APERCU_INDISPONIBLE", async () => {
    h.adapter = repondre(404, JSON.stringify({ error: "Introuvable" }), "application/json");
    const t = classerErreur(await attraper());
    expect(t).toMatchObject({ status: 404, code: null, genre: "introuvable", message: "Introuvable" });
  });

  it("404 dont le corps n'est pas du JSON (page HTML) : toleree, genre par defaut, aucun plantage", async () => {
    h.adapter = repondre(404, "<html><body>Not found</body></html>", "text/html");
    const t = classerErreur(await attraper());
    expect(t).toMatchObject({ status: 404, code: null, genre: "introuvable" });
    expect(t.message).toMatch(/introuvable/i);
  });

  it("404 au corps vide : tolere", async () => {
    h.adapter = repondre(404, null, "application/json");
    expect(classerErreur(await attraper())).toMatchObject({ status: 404, code: null });
  });

  it("403 : permission, avec le message du serveur lu dans le Blob", async () => {
    h.adapter = repondre(403, JSON.stringify({ error: "Hors périmètre", code: "HORS_PERIMETRE" }), "application/json");
    const t = classerErreur(await attraper());
    expect(t).toMatchObject({ status: 403, genre: "permission", code: "HORS_PERIMETRE", message: "Hors périmètre" });
  });

  it("401 : session", async () => {
    h.adapter = repondre(401, JSON.stringify({ error: "Non authentifié" }), "application/json");
    expect(classerErreur(await attraper())).toMatchObject({ status: 401, genre: "session" });
  });

  it("500 : serveur, jamais confondu avec un aperçu indisponible", async () => {
    h.adapter = repondre(500, JSON.stringify({ error: "Erreur interne" }), "application/json");
    const t = classerErreur(await attraper());
    expect(t).toMatchObject({ status: 500, genre: "serveur", code: null });
  });

  it("un code d'erreur du Blob n'est jamais invente : un code non textuel est ignore", async () => {
    h.adapter = repondre(404, JSON.stringify({ error: 12, code: { a: 1 } }), "application/json");
    expect(classerErreur(await attraper())).toMatchObject({ status: 404, code: null });
  });

  it("reseau coupe (aucune reponse) : genre reseau, pas de statut", async () => {
    h.adapter = async (config) => { throw new AxiosError("Network Error", "ERR_NETWORK", config); };
    const t = classerErreur(await attraper());
    expect(t).toMatchObject({ status: null, genre: "reseau" });
  });

  it("corps d'erreur demesure : non lu (pas un JSON d'erreur), le statut suffit", async () => {
    h.adapter = repondre(500, new Uint8Array(200_000), "application/octet-stream");
    expect(classerErreur(await attraper())).toMatchObject({ status: 500, code: null, genre: "serveur" });
  });
});

describe("lireApercu : une reponse 200 doit etre une image", () => {
  it("image/png : le Blob est rendu tel quel", async () => {
    h.adapter = repondre(200, new Uint8Array([137, 80, 78, 71]), "image/png");
    const blob = await lireApercu(CHEMIN);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("image/png");
  });

  it.each(["image/jpeg", "image/webp", "IMAGE/PNG"])("%s est admis", async (type) => {
    h.adapter = repondre(200, new Uint8Array([1, 2, 3]), type);
    await expect(lireApercu(CHEMIN)).resolves.toBeInstanceOf(Blob);
  });

  it("200 HTML (repli SPA : index.html) : ApercuIllisible, jamais rendu comme image", async () => {
    h.adapter = repondre(200, "<!doctype html><html><body>app</body></html>", "text/html; charset=utf-8");
    const e = await attraper();
    expect(e).toBeInstanceOf(ApercuIllisible);
  });

  it.each(["application/json", "text/plain", "application/octet-stream", ""])("200 de type %j : illisible", async (type) => {
    h.adapter = repondre(200, "x", type);
    expect(await attraper()).toBeInstanceOf(ApercuIllisible);
  });
});
