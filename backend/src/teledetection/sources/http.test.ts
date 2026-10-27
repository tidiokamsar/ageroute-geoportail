import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientHttp, assainirTexte, lireRetryAfter, masquerUrl, type EvenementJournal, type OptionsClientHttp } from "./http";
import { ErreurSource, classerErreur } from "./contrat";
import { fetchScenario, horloge, reponseJson, sommeilFactice } from "./essais.support";
import { erreurQuiRepeteLeJeton } from "./__fixtures__/synthetiques";

/**
 * Le client HTTP : nouvelles tentatives BORNEES avec backoff et gigue, Retry-After, delai maximal,
 * redirections, comptage, et surtout AUCUN secret dans ce qui sort. Tout est injecte : pas de reseau,
 * pas d'attente reelle.
 */

const URL_RECHERCHE = "https://stac.example.test/v1/search";
const GET = { methode: "GET", url: "https://stac.example.test/v1/collections/x" } as const;
const POST = { methode: "POST", url: URL_RECHERCHE, corps: { limit: 1 } } as const;

function client(extra: Partial<OptionsClientHttp> & { fetch: NonNullable<OptionsClientHttp["fetch"]> }) {
  const s = sommeilFactice();
  const c = new ClientHttp({ source: "cdse-stac", sleep: s.sleep, alea: () => 0.5, version: "9.9.9", ...extra });
  return { c, attentes: s.attentes };
}

afterEach(() => { vi.useRealTimers(); });

describe("requete nominale", () => {
  it("annonce AGEROUTE-BDRI/<version> et rend le JSON", async () => {
    const { fetch, appels } = fetchScenario(reponseJson({ ok: true }));
    const { c } = client({ fetch });
    const r = await c.json(POST);
    expect(r.json).toEqual({ ok: true });
    expect(r.statut).toBe(200);
    expect(r.tentatives).toBe(1);
    expect(appels[0].entetes["User-Agent"]).toBe("AGEROUTE-BDRI/9.9.9");
    expect(appels[0].entetes["Content-Type"]).toBe("application/json");
    expect(appels[0].corps).toEqual({ limit: 1 });
  });
  it("sans version fournie, le User-Agent reste identifiable", async () => {
    const { fetch, appels } = fetchScenario(reponseJson({}));
    const c = new ClientHttp({ source: "cdse-stac", fetch });
    await c.json(GET);
    expect(appels[0].entetes["User-Agent"]).toMatch(/^AGEROUTE-BDRI\/\S+$/);
  });
  it("un GET n'envoie ni corps ni Content-Type", async () => {
    const { fetch, appels } = fetchScenario(reponseJson({}));
    await client({ fetch }).c.json(GET);
    expect(appels[0].methode).toBe("GET");
    expect(appels[0].corps).toBeNull();
    expect(appels[0].entetes["Content-Type"]).toBeUndefined();
  });
  it("une URL illisible est refusee sans rien envoyer", async () => {
    const { fetch, appels } = fetchScenario(reponseJson({}));
    await expect(client({ fetch }).c.json({ methode: "GET", url: "pas une url" })).rejects.toMatchObject({ code: "ENTREE_INVALIDE", categorie: "ENTREE" });
    expect(appels).toHaveLength(0);
  });
});

describe("nouvelles tentatives et backoff", () => {
  it("503 puis 200 : une nouvelle tentative, apres 375 ms (500 ms x gigue 0,75)", async () => {
    const { fetch, appels } = fetchScenario(reponseJson({ e: 1 }, 503), reponseJson({ ok: 1 }));
    const { c, attentes } = client({ fetch });
    const r = await c.json(POST);
    expect(r.tentatives).toBe(2);
    expect(appels).toHaveLength(2);
    expect(attentes).toEqual([375]);
    const q = c.compteur.instantane();
    expect(q).toMatchObject({ requetesEnvoyees: 2, appelsLogiques: 1, nouvellesTentatives: 1, reponses5xx: 1, reponses2xx: 1 });
  });

  it("backoff exponentiel plafonne, et nombre d'envois BORNE (4 par defaut)", async () => {
    const { fetch, appels } = fetchScenario(reponseJson({}, 503));
    const { c, attentes } = client({ fetch });
    const e = await c.json(POST).catch((x) => x);
    expect(e).toBeInstanceOf(ErreurSource);
    expect(e).toMatchObject({ code: "HTTP_INDISPONIBLE", categorie: "INDISPONIBLE", statutHttp: 503, tentatives: 4 });
    expect(appels).toHaveLength(4);
    expect(attentes).toEqual([375, 750, 1500]);
  });

  it("le backoff ne depasse pas son plafond", async () => {
    const { fetch } = fetchScenario(reponseJson({}, 500));
    const { c, attentes } = client({ fetch, tentativesMax: 6, baseBackoffMs: 1000, plafondBackoffMs: 3000 });
    await c.json(POST).catch(() => undefined);
    expect(attentes).toEqual([750, 1500, 2250, 2250, 2250]);
  });

  it("la gigue reste entre la moitie du delai et le delai plein", async () => {
    for (const [alea, attendu] of [[0, 250], [0.999, 500]] as const) {
      const { fetch } = fetchScenario(reponseJson({}, 502), reponseJson({}));
      const { c, attentes } = client({ fetch, alea: () => alea });
      await c.json(POST);
      expect(attentes[0]).toBe(attendu);
    }
  });

  it("tentativesMax = 1 : aucune nouvelle tentative", async () => {
    const { fetch, appels } = fetchScenario(reponseJson({}, 503));
    const { c, attentes } = client({ fetch, tentativesMax: 1 });
    await expect(c.json(POST)).rejects.toMatchObject({ tentatives: 1 });
    expect(appels).toHaveLength(1);
    expect(attentes).toEqual([]);
  });

  it.each([400, 404, 405, 422])("HTTP %i : erreur d'entree, jamais rejouee", async (statut) => {
    const { fetch, appels } = fetchScenario(reponseJson({ message: "non" }, statut));
    const { c, attentes } = client({ fetch });
    await expect(c.json(POST)).rejects.toMatchObject({ categorie: "ENTREE", code: "HTTP_ENTREE", statutHttp: statut });
    expect(appels).toHaveLength(1);
    expect(attentes).toEqual([]);
  });

  it.each([401, 403])("HTTP %i : AUTH, jamais rejouee", async (statut) => {
    const { fetch, appels } = fetchScenario(reponseJson({ code: "DAT-ZIP-604", message: "Token not found" }, statut));
    await expect(client({ fetch }).c.json(POST)).rejects.toMatchObject({ categorie: "AUTH", code: "HTTP_AUTH" });
    expect(appels).toHaveLength(1);
  });

  it("408 est rejouee et classee RESEAU si elle persiste", async () => {
    const { fetch, appels } = fetchScenario(reponseJson({}, 408));
    await expect(client({ fetch }).c.json(POST)).rejects.toMatchObject({ categorie: "RESEAU", statutHttp: 408 });
    expect(appels).toHaveLength(4);
  });
});

describe("Retry-After", () => {
  it("429 avec Retry-After: 2 : attend 2000 ms (plus que le backoff de 375 ms)", async () => {
    const { fetch } = fetchScenario(reponseJson({}, 429, { "retry-after": "2" }), reponseJson({ ok: 1 }));
    const { c, attentes } = client({ fetch });
    await c.json(POST);
    expect(attentes).toEqual([2000]);
    expect(c.compteur.instantane().reponses429).toBe(1);
  });

  it("Retry-After inferieur au backoff : le backoff l'emporte", async () => {
    const { fetch } = fetchScenario(reponseJson({}, 503, { "retry-after": "0" }), reponseJson({}));
    const { c, attentes } = client({ fetch });
    await c.json(POST);
    expect(attentes).toEqual([375]);
  });

  it("Retry-After en date HTTP, lu avec l'horloge injectee", async () => {
    const maintenant = Date.parse("2026-10-25T10:00:00Z");
    const date = new Date(maintenant + 5000).toUTCString();
    const { fetch } = fetchScenario(reponseJson({}, 429, { "retry-after": date }), reponseJson({}));
    const { c, attentes } = client({ fetch, maintenant: () => maintenant });
    await c.json(POST);
    expect(attentes).toEqual([5000]);
  });

  it("Retry-After au-dela du plafond d'attente : on ne dort pas, l'erreur QUOTA porte la duree demandee", async () => {
    const { fetch, appels } = fetchScenario(reponseJson({}, 429, { "retry-after": "3600" }));
    const { c, attentes } = client({ fetch });
    const e = await c.json(POST).catch((x) => x);
    expect(e).toMatchObject({ categorie: "QUOTA", code: "HTTP_QUOTA", retryApresMs: 3_600_000, statutHttp: 429 });
    expect(appels).toHaveLength(1);
    expect(attentes).toEqual([]);
  });

  it("429 persistant sans Retry-After : QUOTA apres le nombre d'envois permis, 4 reponses 429 comptees", async () => {
    const { fetch } = fetchScenario(reponseJson({}, 429));
    const { c } = client({ fetch });
    await expect(c.json(POST)).rejects.toMatchObject({ categorie: "QUOTA", tentatives: 4 });
    expect(c.compteur.instantane()).toMatchObject({ requetesEnvoyees: 4, reponses429: 4, nouvellesTentatives: 3 });
  });

  it("lireRetryAfter", () => {
    expect(lireRetryAfter(null, 0)).toBeNull();
    expect(lireRetryAfter("3", 0)).toBe(3000);
    expect(lireRetryAfter(" 10 ", 0)).toBe(10_000);
    expect(lireRetryAfter("n'importe quoi", 0)).toBeNull();
    expect(lireRetryAfter(new Date(1000).toUTCString(), 5000)).toBe(0);
  });
});

describe("pannes reseau et delai maximal", () => {
  it("une panne reseau est rejouee puis reussit", async () => {
    const { fetch, appels } = fetchScenario(new TypeError("fetch failed"), reponseJson({ ok: 1 }));
    const { c, attentes } = client({ fetch });
    await c.json(POST);
    expect(appels).toHaveLength(2);
    expect(attentes).toEqual([375]);
    expect(c.compteur.instantane().echecsReseau).toBe(1);
  });

  it("une panne reseau persistante : RESEAU, apres 4 envois, avec la cause systeme", async () => {
    const cause = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    const { fetch, appels } = fetchScenario(cause);
    const e = await client({ fetch }).c.json(POST).catch((x) => x);
    expect(e).toMatchObject({ code: "RESEAU", categorie: "RESEAU", tentatives: 4 });
    expect(e.message).toContain("ENOTFOUND");
    expect(appels).toHaveLength(4);
  });

  it("delai maximal : la requete est interrompue (faux minuteurs), DELAI_DEPASSE, compte a part", async () => {
    vi.useFakeTimers();
    const appels: number[] = [];
    const c = new ClientHttp({
      source: "cdse-stac", delaiMaxMs: 1000, tentativesMax: 1, version: "t",
      fetch: (_url, init) => new Promise<Response>((_res, rej) => {
        appels.push(1);
        init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
    });
    const attendu = expect(c.json(POST)).rejects.toMatchObject({ code: "DELAI_DEPASSE", categorie: "RESEAU" });
    await vi.advanceTimersByTimeAsync(1000);
    await attendu;
    expect(appels).toHaveLength(1);
    expect(c.compteur.instantane()).toMatchObject({ delaisDepasses: 1, echecsReseau: 0 });
  });

  it("corps de reponse trop gros : REPONSE_TROP_GROSSE, jamais rejouee", async () => {
    const { fetch, appels } = fetchScenario(reponseJson("x".repeat(5000)));
    const { c } = client({ fetch, octetsMax: 1000 });
    await expect(c.json(POST)).rejects.toMatchObject({ code: "REPONSE_TROP_GROSSE", categorie: "INDISPONIBLE" });
    expect(appels).toHaveLength(1);
  });

  it("200 qui n'est pas du JSON (page de maintenance) : REPONSE_ILLISIBLE, jamais rejouee", async () => {
    const { fetch, appels } = fetchScenario(new Response("<html>maintenance</html>", { status: 200 }));
    await expect(client({ fetch }).c.json(POST)).rejects.toMatchObject({ code: "REPONSE_ILLISIBLE", categorie: "INDISPONIBLE" });
    expect(appels).toHaveLength(1);
  });
});

describe("redirections", () => {
  const redirection = (statut: number, location: string) => new Response(null, { status: statut, headers: { location } });

  it("suit une redirection de meme origine pour un GET, sans la compter comme nouvelle tentative", async () => {
    const { fetch, appels } = fetchScenario(redirection(301, "/v1/collections/y"), reponseJson({ ok: 1 }));
    const { c } = client({ fetch });
    const r = await c.json(GET);
    expect(r.json).toEqual({ ok: 1 });
    expect(appels.map((a) => a.url)).toEqual(["https://stac.example.test/v1/collections/x", "https://stac.example.test/v1/collections/y"]);
    expect(c.compteur.instantane().nouvellesTentatives).toBe(0);
  });

  it("refuse une redirection vers un autre hote : rien n'y est envoye", async () => {
    const { fetch, appels } = fetchScenario(redirection(302, "https://autre.example.test/pris"), reponseJson({}));
    await expect(client({ fetch }).c.json(GET)).rejects.toMatchObject({ code: "REDIRECTION_REFUSEE" });
    expect(appels).toHaveLength(1);
  });

  it("un POST n'est suivi que si la redirection preserve la methode (307/308), corps compris", async () => {
    const a = fetchScenario(redirection(307, "/v1/search2"), reponseJson({ ok: 1 }));
    await client({ fetch: a.fetch }).c.json(POST);
    expect(a.appels[1]).toMatchObject({ methode: "POST", corps: { limit: 1 } });
    const b = fetchScenario(redirection(302, "/v1/search2"), reponseJson({}));
    await expect(client({ fetch: b.fetch }).c.json(POST)).rejects.toMatchObject({ code: "REDIRECTION_REFUSEE" });
    expect(b.appels).toHaveLength(1);
  });

  it("au plus deux sauts", async () => {
    const { fetch, appels } = fetchScenario(redirection(301, "/v1/a"), redirection(301, "/v1/b"), redirection(301, "/v1/c"));
    await expect(client({ fetch }).c.json(GET)).rejects.toMatchObject({ code: "REDIRECTION_REFUSEE" });
    expect(appels).toHaveLength(3);
  });
});

describe("aucun secret dans ce qui sort", () => {
  const JETON = "eyJhbGciOiJSUzI1NiJ9.SECRET-PAYLOAD-0123456789.signature-ABCDEF";

  it("ni dans le journal, ni dans les messages d'erreur, ni dans la description de requete, ni dans les compteurs", async () => {
    const evenements: EvenementJournal[] = [];
    const urlAvecJeton = `https://stac.example.test/v1/search?token=${JETON}&sig=ZZZSIGZZZ&q=ok`;
    const { fetch, appels } = fetchScenario(
      reponseJson(erreurQuiRepeteLeJeton(JETON), 429, { "retry-after": "1" }),
      reponseJson(erreurQuiRepeteLeJeton(JETON), 500),
      reponseJson(erreurQuiRepeteLeJeton(JETON), 403),
    );
    const { c } = client({
      fetch, secrets: [JETON], journal: (e) => evenements.push(e), entetes: { Authorization: `Bearer ${JETON}` },
    });
    const e = (await c.json({ methode: "POST", url: urlAvecJeton, corps: { auth: JETON, limit: 1 } }).catch((x) => x)) as ErreurSource;

    // le jeton PART bien dans la requete (sinon le test ne prouverait rien) ...
    expect(appels[0].entetes.Authorization).toBe(`Bearer ${JETON}`);
    // ... mais n'est ecrit nulle part
    const sorties = JSON.stringify({
      evenements,
      message: e.message,
      requete: e.requete,
      description: c.decrire({ methode: "POST", url: urlAvecJeton, corps: { auth: JETON } }),
      compteurs: c.compteur.instantane(),
    });
    expect(sorties).not.toContain(JETON);
    expect(sorties).not.toContain("SECRET-PAYLOAD");
    expect(sorties).not.toContain("ZZZSIGZZZ");
    expect(sorties).not.toMatch(/Bearer eyJ/);
    expect(evenements.length).toBeGreaterThan(3);
    expect(evenements.some((x) => x.type === "NOUVELLE_TENTATIVE")).toBe(true);
  });

  it("un journal qui plante ne fait pas echouer la requete", async () => {
    const { fetch } = fetchScenario(reponseJson({ ok: 1 }));
    const { c } = client({ fetch, journal: () => { throw new Error("journal casse"); } });
    await expect(c.json(POST)).resolves.toMatchObject({ statut: 200 });
  });

  it("masquerUrl : userinfo et parametres de signature", () => {
    expect(masquerUrl("https://u:p@h.example/a?token=1&sig=2&x=3&se=4")).toBe("https://h.example/a?token=MASQUE&sig=MASQUE&x=3&se=MASQUE");
    expect(masquerUrl("illisible")).toBe("[URL illisible]");
  });

  it("assainirTexte : secrets, Bearer, formes access_token, JSON, caracteres de controle, longueur", () => {
    const t = assainirTexte('Bearer abcdefgh12345 access_token=zzzz9999 {"password":"hunter2hunter2"} \u0007fin', ["hunter2hunter2"]);
    expect(t).not.toMatch(/abcdefgh12345|zzzz9999|hunter2/);
    expect(t).not.toMatch(/\u0007/);
    expect(assainirTexte("x".repeat(1000), [], 50)).toHaveLength(50);
  });
});

describe("compteurs", () => {
  it("derniereMinute ne garde que les 60 dernieres secondes (horloge injectee)", async () => {
    const t = horloge("2026-10-25T10:00:00Z", 20_000); // chaque lecture avance de 20 s
    const { fetch } = fetchScenario(reponseJson({}));
    const c = new ClientHttp({ source: "earth-search", fetch, maintenant: t, version: "t" });
    await c.json(GET);
    await c.json(GET);
    await c.json(GET);
    const q = c.compteur.instantane();
    expect(q.requetesEnvoyees).toBe(3);
    expect(q.derniereMinute).toBeLessThanOrEqual(3);
    expect(q.premiereRequeteLe).toMatch(/^2026-10-25T10:/);
    expect(q.octetsRecus).toBeGreaterThan(0);
  });
});

describe("classerErreur", () => {
  it("lit la categorie d'une ErreurSource, reconnait les pannes de fetch, laisse le reste INCONNUE", () => {
    const e = (categorie: ErreurSource["categorie"]) => new ErreurSource({ code: "INCONNUE", categorie, message: "x" });
    for (const cat of ["QUOTA", "AUTH", "RESEAU", "INDISPONIBLE", "ENTREE", "INCONNUE", "NON_SUPPORTE"] as const) expect(classerErreur(e(cat))).toBe(cat);
    expect(classerErreur(new TypeError("fetch failed"))).toBe("RESEAU");
    expect(classerErreur(Object.assign(new Error("x"), { name: "AbortError" }))).toBe("RESEAU");
    expect(classerErreur(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe("RESEAU");
    expect(classerErreur(Object.assign(new Error("x"), { cause: { code: "ECONNRESET" } }))).toBe("RESEAU");
    expect(classerErreur(new Error("bug"))).toBe("INCONNUE");
    expect(classerErreur("texte")).toBe("INCONNUE");
    expect(classerErreur(null)).toBe("INCONNUE");
    expect(classerErreur(undefined)).toBe("INCONNUE");
  });
});
