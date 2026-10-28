import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import {
  api, rafraichirJeton, refreshAccessToken, setAccessToken, surIssueRafraichissement, type ResultatRafraichissement,
} from "./api";

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

  it("un 401 sur la CONNEXION (mauvais mot de passe) ne declenche ni refresh ni redirection : l'erreur remonte au formulaire", async () => {
    // Defaut E2E-1 : l'intercepteur traitait ce 401 comme un jeton expire, tentait un refresh (401 faute de cookie) puis
    // rechargeait /login, ce qui effacait le message d'erreur : un mauvais mot de passe ne montrait rien.
    const refresh = vi.spyOn(axios, "post").mockResolvedValue({ data: { accessToken: "neuf" } });
    setAccessToken(null);
    const r = await api.post("/auth/login", { email: "x@y.z", password: "faux" }).then((x) => ({ ok: x.status }), (e) => ({ err: e.response?.status }));
    console.log("DBG", JSON.stringify(r), JSON.stringify(recus), refresh.mock.calls.length);
    expect(r).toEqual({ err: 401 });
    expect(refresh).not.toHaveBeenCalled();
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
    // Erreur sans reponse HTTP : RESEAU_COUPE, donc aucune redirection (voir la suite « Issue typee »).
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


/**
 * ISSUE TYPEE DU RAFRAICHISSEMENT (session hors ligne, etape 2).
 *
 * Avant : n'importe quel echec (reseau coupe, 500, 401) vidait le jeton et envoyait vers /login. Un agent hors
 * ligne etait donc jete de l'application a la premiere expiration de son jeton de 15 minutes. Maintenant seul
 * un refus du serveur (401/403) ferme la session.
 *
 * Detection de la redirection : jsdom ne sait pas naviguer et le signale par `console.error`
 * (« Not implemented: navigation »). Un test « positif » (REFUSE => signale) valide le detecteur lui-meme.
 */
describe("Issue typee du rafraichissement", () => {
  const LEGACY = "bdri_refresh_token";
  let erreursConsole: ReturnType<typeof vi.spyOn>;

  const navigations = () =>
    erreursConsole.mock.calls.filter((appel) => appel.some((a) => String((a as { message?: string })?.message ?? a).includes("navigation"))).length;

  function reponseHttp(status: number, data: unknown = {}) {
    const config = { headers: {} } as InternalAxiosRequestConfig;
    return new AxiosError(String(status), status >= 500 ? "ERR_BAD_RESPONSE" : "ERR_BAD_REQUEST", config, null, {
      status, statusText: "", headers: {}, config, data,
    });
  }
  const sansReponse = () => new AxiosError("Network Error", "ERR_NETWORK", { headers: {} } as InternalAxiosRequestConfig, null, undefined);

  beforeEach(() => {
    erreursConsole = vi.spyOn(console, "error").mockImplementation(() => undefined);
    localStorage.removeItem(LEGACY);
  });
  afterEach(() => {
    localStorage.removeItem(LEGACY);
  });

  describe("rafraichirJeton : classement des issues", () => {
    it("2xx avec jeton : OK, et le jeton devient le jeton courant", async () => {
      vi.spyOn(axios, "post").mockResolvedValue({ data: { accessToken: "neuf" } });
      expect(await rafraichirJeton("perime")).toEqual({ etat: "OK", token: "neuf" });
      await api.get("/x");
      expect(recus.at(-1)?.auth).toBe("Bearer neuf");
    });

    it("aucune reponse HTTP (ERR_NETWORK) : RESEAU_COUPE", async () => {
      vi.spyOn(axios, "post").mockRejectedValue(sansReponse());
      expect(await rafraichirJeton("perime")).toEqual({ etat: "RESEAU_COUPE" });
    });

    it("delai depasse ou requete avortee (pas de reponse) : RESEAU_COUPE", async () => {
      const delai = new AxiosError("timeout", "ECONNABORTED", { headers: {} } as InternalAxiosRequestConfig, null, undefined);
      vi.spyOn(axios, "post").mockRejectedValueOnce(delai).mockRejectedValueOnce(new Error("avorte"));
      expect(await rafraichirJeton("perime")).toEqual({ etat: "RESEAU_COUPE" });
      expect(await rafraichirJeton("perime")).toEqual({ etat: "RESEAU_COUPE" });
    });

    it.each([401, 403] as const)("%i : REFUSE avec le statut", async (statut) => {
      vi.spyOn(axios, "post").mockRejectedValue(reponseHttp(statut));
      expect(await rafraichirJeton("perime")).toEqual({ etat: "REFUSE", statut });
    });

    it.each([500, 502, 503, 504, 429, 400, 404])("%i : INDISPONIBLE (ni refus d'identite, ni coupure) avec le statut", async (statut) => {
      vi.spyOn(axios, "post").mockRejectedValue(reponseHttp(statut));
      expect(await rafraichirJeton("perime")).toEqual({ etat: "INDISPONIBLE", statut });
    });

    it("2xx sans jeton (reponse mal formee) : INDISPONIBLE, pas OK avec un jeton vide", async () => {
      vi.spyOn(axios, "post").mockResolvedValueOnce({ data: {} }).mockResolvedValueOnce({ data: { accessToken: "" } });
      expect(await rafraichirJeton("perime")).toEqual({ etat: "INDISPONIBLE", statut: 200 });
      expect(await rafraichirJeton("perime")).toEqual({ etat: "INDISPONIBLE", statut: 200 });
    });

    it("un jeton deja renouvele par un autre appel est rendu sans nouvelle requete", async () => {
      const refresh = vi.spyOn(axios, "post");
      expect(await rafraichirJeton("autre-jeton-perime")).toEqual({ etat: "OK", token: "perime" });
      expect(refresh).not.toHaveBeenCalled();
    });
  });

  describe("effets sur le jeton en memoire", () => {
    it("RESEAU_COUPE et INDISPONIBLE ne vident PAS le jeton", async () => {
      vi.spyOn(axios, "post").mockRejectedValueOnce(sansReponse()).mockRejectedValueOnce(reponseHttp(503));
      await rafraichirJeton("perime");
      await rafraichirJeton("perime");
      await api.get("/x").catch(() => undefined);
      // Le jeton (perime, ici) est toujours presente : il n'a pas ete remplace par « aucun jeton ».
      expect(recus[0].auth).toBe("Bearer perime");
    });

    it.each([401, 403])("REFUSE %i vide le jeton : la requete suivante part sans Authorization", async (statut) => {
      vi.spyOn(axios, "post").mockRejectedValue(reponseHttp(statut));
      await rafraichirJeton("perime");
      await api.get("/x").catch(() => undefined);
      expect(recus[0].auth).toBeUndefined();
    });
  });

  describe("ancien jeton localStorage (migration)", () => {
    it("reste en place sur RESEAU_COUPE et INDISPONIBLE (il n'a pas ete consomme)", async () => {
      localStorage.setItem(LEGACY, "ancien");
      const post = vi.spyOn(axios, "post").mockRejectedValueOnce(sansReponse()).mockRejectedValueOnce(reponseHttp(500));
      await rafraichirJeton("perime");
      await rafraichirJeton("perime");
      expect(localStorage.getItem(LEGACY)).toBe("ancien");
      expect(post.mock.calls[0][1]).toEqual({ refreshToken: "ancien" });
    });

    it("est purge sur OK et sur REFUSE", async () => {
      localStorage.setItem(LEGACY, "ancien");
      vi.spyOn(axios, "post").mockResolvedValueOnce({ data: { accessToken: "neuf" } });
      await rafraichirJeton("perime");
      expect(localStorage.getItem(LEGACY)).toBeNull();

      localStorage.setItem(LEGACY, "ancien");
      setAccessToken("perime");
      vi.spyOn(axios, "post").mockRejectedValueOnce(reponseHttp(401));
      await rafraichirJeton("perime");
      expect(localStorage.getItem(LEGACY)).toBeNull();
    });
  });

  describe("intercepteur 401 : redirection vers /login", () => {
    it("le detecteur de navigation fonctionne (controle positif) : REFUSE 401 => une navigation vers /login", async () => {
      vi.spyOn(axios, "post").mockRejectedValue(reponseHttp(401));
      await expect(api.get("/troncons")).rejects.toMatchObject({ response: { status: 401 } });
      expect(navigations()).toBe(1);
    });

    it("REFUSE 403 : navigation vers /login, requete rejetee, un seul refresh, aucun rejeu", async () => {
      const refresh = vi.spyOn(axios, "post").mockRejectedValue(reponseHttp(403));
      await expect(api.get("/troncons")).rejects.toMatchObject({ response: { status: 401 } });
      expect(navigations()).toBe(1);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(recus).toHaveLength(1);
    });

    it("RESEAU_COUPE : la requete echoue avec son 401 d'origine, SANS navigation, jeton conserve, un seul refresh, aucun rejeu", async () => {
      const refresh = vi.spyOn(axios, "post").mockRejectedValue(sansReponse());
      await expect(api.get("/troncons")).rejects.toMatchObject({ response: { status: 401 } });
      expect(navigations()).toBe(0);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(recus).toHaveLength(1);
      await api.get("/autre").catch(() => undefined);
      expect(recus.at(-1)?.auth).toBe("Bearer perime"); // jeton non vide
    });

    it.each([500, 503, 429])("INDISPONIBLE %i : meme conduite, SANS navigation", async (statut) => {
      const refresh = vi.spyOn(axios, "post").mockRejectedValue(reponseHttp(statut));
      await expect(api.get("/troncons")).rejects.toMatchObject({ response: { status: 401 } });
      expect(navigations()).toBe(0);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(recus).toHaveLength(1);
    });

    it("pas de boucle : N requetes en 401 hors ligne font N tentatives de refresh, jamais plus, chacune rejetee une fois", async () => {
      const refresh = vi.spyOn(axios, "post").mockRejectedValue(sansReponse());
      for (let i = 0; i < 3; i++) await api.get(`/r${i}`).catch(() => undefined);
      expect(refresh).toHaveBeenCalledTimes(3);
      expect(recus).toHaveLength(3);
      expect(navigations()).toBe(0);
    });

    it("trois requetes simultanees hors ligne : UN seul refresh partage, trois rejets, pas de navigation", async () => {
      const refresh = vi.spyOn(axios, "post").mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 20));
        throw sansReponse();
      });
      const res = await Promise.allSettled([api.get("/a"), api.get("/b"), api.get("/c")]);
      expect(res.every((r) => r.status === "rejected")).toBe(true);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(navigations()).toBe(0);
    });

    it("le reseau revient : le rafraichissement suivant reussit et la requete passe", async () => {
      const refresh = vi.spyOn(axios, "post")
        .mockRejectedValueOnce(sansReponse())
        .mockResolvedValue({ data: { accessToken: "neuf" } });
      await expect(api.get("/a")).rejects.toBeDefined();
      const res = await api.get("/b");
      expect(res.status).toBe(200);
      expect(refresh).toHaveBeenCalledTimes(2);
    });

    it("un 401 qui persiste apres un refresh reussi reste rejete sans navigation (comportement inchange)", async () => {
      valides = new Set();
      vi.spyOn(axios, "post").mockResolvedValue({ data: { accessToken: "neuf" } });
      await expect(api.get("/troncons")).rejects.toMatchObject({ response: { status: 401 } });
      expect(navigations()).toBe(0);
    });
  });

  describe("refreshAccessToken (forme historique, appelants actuels)", () => {
    it("rend le jeton sur OK, null sur toute autre issue", async () => {
      const post = vi.spyOn(axios, "post");
      setAccessToken(null);
      post.mockResolvedValueOnce({ data: { accessToken: "neuf" } });
      expect(await refreshAccessToken()).toBe("neuf");

      setAccessToken(null);
      post.mockRejectedValueOnce(sansReponse());
      expect(await refreshAccessToken()).toBeNull();
      post.mockRejectedValueOnce(reponseHttp(500));
      expect(await refreshAccessToken()).toBeNull();
      post.mockRejectedValueOnce(reponseHttp(401));
      expect(await refreshAccessToken()).toBeNull();
    });

    it("sans argument (demarrage) renvoie le jeton courant sans requete, comme avant", async () => {
      const post = vi.spyOn(axios, "post");
      expect(await refreshAccessToken()).toBe("perime");
      expect(post).not.toHaveBeenCalled();
    });

    it("difference voulue avec l'ancien comportement : un echec reseau ne vide plus le jeton ; un refus le vide toujours", async () => {
      setAccessToken("valide");
      vi.spyOn(axios, "post").mockRejectedValueOnce(sansReponse());
      expect(await refreshAccessToken("valide")).toBeNull();
      expect(await refreshAccessToken()).toBe("valide"); // toujours la

      vi.spyOn(axios, "post").mockRejectedValueOnce(reponseHttp(401));
      expect(await refreshAccessToken("valide")).toBeNull();
      vi.spyOn(axios, "post").mockRejectedValueOnce(sansReponse());
      expect(await refreshAccessToken()).toBeNull(); // vide par le refus : plus de jeton, la requete part et echoue
    });
  });

  describe("surIssueRafraichissement", () => {
    it("annonce chaque issue reellement tentee, y compris celle declenchee par l'intercepteur", async () => {
      const vues: ResultatRafraichissement[] = [];
      const fin = surIssueRafraichissement((r) => vues.push(r));
      vi.spyOn(axios, "post")
        .mockRejectedValueOnce(sansReponse())
        .mockRejectedValueOnce(reponseHttp(503))
        .mockRejectedValueOnce(reponseHttp(401))
        .mockResolvedValueOnce({ data: { accessToken: "neuf" } });
      setAccessToken("perime");
      await api.get("/a").catch(() => undefined);
      setAccessToken("perime");
      await api.get("/b").catch(() => undefined);
      setAccessToken("perime");
      await api.get("/c").catch(() => undefined);
      setAccessToken("perime");
      await api.get("/d");
      fin();
      expect(vues.map((v) => v.etat)).toEqual(["RESEAU_COUPE", "INDISPONIBLE", "REFUSE", "OK"]);
    });

    it("le desabonnement coupe l'ecoute ; un ecouteur qui jette n'altere pas le rafraichissement", async () => {
      const appels: string[] = [];
      const fin = surIssueRafraichissement((r) => appels.push(r.etat));
      const finDefaillant = surIssueRafraichissement(() => { throw new Error("ecouteur casse"); });
      vi.spyOn(axios, "post").mockRejectedValue(sansReponse());
      expect(await rafraichirJeton("perime")).toEqual({ etat: "RESEAU_COUPE" });
      expect(appels).toEqual(["RESEAU_COUPE"]);
      fin();
      finDefaillant();
      await rafraichirJeton("perime");
      expect(appels).toEqual(["RESEAU_COUPE"]);
    });

    it("la reutilisation d'un jeton deja frais n'est pas annoncee (aucun rafraichissement n'a eu lieu)", async () => {
      const appels: string[] = [];
      const fin = surIssueRafraichissement((r) => appels.push(r.etat));
      await rafraichirJeton("autre");
      fin();
      expect(appels).toEqual([]);
    });
  });
});
