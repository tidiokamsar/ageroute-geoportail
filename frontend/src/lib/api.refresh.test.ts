import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import { api, setAccessToken } from "./api";

/**
 * Rafraichissement du jeton d'acces sur 401.
 *
 * Non-regression : `refreshAccessToken` rendait « n'importe quel jeton non nul » au lieu de rafraichir, et
 * l'intercepteur rejouait donc la requete avec LE MEME jeton perime. Un onglet ouvert plus de 15 minutes
 * (duree du JWT) ne se rafraichissait plus : chaque requete repartait en 401.
 *
 * Le serveur est simule par un adaptateur axios (pas de reseau) ; l'appel de refresh passe par `axios.post`.
 */

const adapterOrigine = api.defaults.adapter;
let valides: Set<string>;
let recus: { url: string; auth: string | undefined }[];
/** Delai (ms) avant la reponse d'une URL donnee : sert a faire arriver un 401 APRES la fin d'un refresh. */
let delais: Record<string, number>;

function reponse401(config: InternalAxiosRequestConfig) {
  return new AxiosError("401", "ERR_BAD_REQUEST", config, null, {
    status: 401, statusText: "Unauthorized", headers: {}, config, data: { message: "jeton expire" },
  });
}

beforeEach(() => {
  valides = new Set(["neuf"]);
  recus = [];
  delais = {};
  api.defaults.adapter = async (config) => {
    const auth = (config.headers as unknown as { Authorization?: string }).Authorization;
    recus.push({ url: String(config.url), auth });
    const delai = delais[String(config.url)];
    if (delai) await new Promise((r) => setTimeout(r, delai));
    if (!auth || !valides.has(auth.replace("Bearer ", ""))) throw reponse401(config);
    return { data: { ok: true }, status: 200, statusText: "OK", headers: {}, config };
  };
  setAccessToken("perime");
});

afterEach(() => {
  api.defaults.adapter = adapterOrigine;
  setAccessToken(null);
  vi.restoreAllMocks();
});

describe("Rafraichissement du jeton sur 401", () => {
  it("un 401 declenche UN refresh puis rejoue la requete avec le nouveau jeton", async () => {
    const refresh = vi.spyOn(axios, "post").mockResolvedValue({ data: { accessToken: "neuf" } });

    const res = await api.get("/troncons");

    expect(res.data).toEqual({ ok: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0][0]).toBe("/api/auth/refresh");
    // Premier envoi avec le jeton perime, rejeu avec le neuf : pas le meme jeton deux fois.
    expect(recus.map((r) => r.auth)).toEqual(["Bearer perime", "Bearer neuf"]);
  });

  it("le jeton rafraichi sert aux requetes suivantes (pas de nouveau 401)", async () => {
    const refresh = vi.spyOn(axios, "post").mockResolvedValue({ data: { accessToken: "neuf" } });

    await api.get("/a");
    await api.get("/b");

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(recus.filter((r) => r.url === "/b").map((r) => r.auth)).toEqual(["Bearer neuf"]);
  });

  it("deux 401 simultanes ne font qu'UN refresh", async () => {
    const refresh = vi.spyOn(axios, "post").mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { data: { accessToken: "neuf" } };
    });

    const [a, b] = await Promise.all([api.get("/a"), api.get("/b")]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("un 401 qui arrive APRES la fin du refresh reutilise le jeton neuf sans second refresh", async () => {
    // /lent part avec le jeton perime, sa reponse 401 n'arrive qu'une fois le refresh de /rapide termine.
    delais["/lent"] = 80;
    const refresh = vi.spyOn(axios, "post").mockResolvedValue({ data: { accessToken: "neuf" } });

    const [lent, rapide] = await Promise.all([api.get("/lent"), api.get("/rapide")]);

    expect(lent.status).toBe(200);
    expect(rapide.status).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("un echec de refresh ne boucle pas : la requete est rejetee, aucun rejeu, un seul appel de refresh", async () => {
    // jsdom signale la navigation vers /login comme « non implementee » : bruit sans objet ici.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const refresh = vi.spyOn(axios, "post").mockRejectedValue(new Error("refresh refuse"));

    await expect(api.get("/troncons")).rejects.toMatchObject({ response: { status: 401 } });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(recus).toHaveLength(1);
  });

  it("un rejeu qui re-echoue en 401 est rejete sans second refresh (une seule tentative par requete)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    valides = new Set(); // meme le jeton neuf est refuse
    const refresh = vi.spyOn(axios, "post").mockResolvedValue({ data: { accessToken: "neuf" } });

    await expect(api.get("/troncons")).rejects.toMatchObject({ response: { status: 401 } });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(recus).toHaveLength(2);
  });

  it("apres un echec de refresh, le refresh suivant peut etre retente (le creneau est libere)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const refresh = vi.spyOn(axios, "post")
      .mockRejectedValueOnce(new Error("refresh refuse"))
      .mockResolvedValue({ data: { accessToken: "neuf" } });

    await expect(api.get("/a")).rejects.toBeDefined();
    setAccessToken("perime");
    const res = await api.get("/b");

    expect(res.status).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
