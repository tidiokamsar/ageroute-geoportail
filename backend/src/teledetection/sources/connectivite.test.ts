import { describe, expect, it } from "vitest";
import { creerAdaptateurCdseStac } from "./adaptateurs/cdse-stac";
import { creerAdaptateurEarthSearch } from "./adaptateurs/earth-search";
import { creerFacadePlanetScope, creerFacadeSpot } from "./adaptateurs/facade";
import type { OptionsAdaptateurStac } from "./adaptateurs/commun";
import type { FetchLike } from "./http";
import { ZONE_SONDE_PAR_DEFAUT } from "./stac";
import type { EtatConnectivite, ResultatConnectivite } from "./contrat";
import { charger, fetchScenario, horloge, reponseJson, sommeilFactice } from "./essais.support";
import * as syn from "./__fixtures__/synthetiques";

/**
 * verifierConnectivite : un etat par scenario, jamais au-dela de PRODUIT_DISPONIBLE, et jamais
 * TRAITEMENT_OPERATIONNEL (qui exige un traitement reel reussi) ni AUTHENTIFIEE (qui exige des
 * identifiants que cette verification n'utilise pas).
 */

const MAINTENANT = "2026-10-25T12:00:00Z";
const AUTORISES: EtatConnectivite[] = ["CONFIGUREE", "ACCESSIBLE", "PRODUIT_DISPONIBLE", "EN_ERREUR", "EN_ATTENTE_CONFIGURATION"];
const vus: ResultatConnectivite[] = [];
const noter = (r: ResultatConnectivite) => { vus.push(r); return r; };
const cdse = (fetch: FetchLike, extra: Partial<OptionsAdaptateurStac> = {}) =>
  creerAdaptateurCdseStac({ fetch, sleep: sommeilFactice().sleep, maintenant: horloge(MAINTENANT), ...extra });

describe("PRODUIT_DISPONIBLE", () => {
  it("CDSE : au moins un produit dans la fenetre, requete exacte et sans identifiants", async () => {
    const f = charger("cdse-stac-s2-l2a.json");
    const { fetch, appels } = fetchScenario(reponseJson(f.reponse));
    const r = noter(await cdse(fetch).verifierConnectivite());
    expect(r.etatAtteint).toBe("PRODUIT_DISPONIBLE");
    expect(r.produitsTrouves).toBeGreaterThanOrEqual(1);
    expect(r.categorieErreur).toBeNull();
    expect(r.verifieLe).toBe("2026-10-25T12:00:00.000Z");
    expect(appels).toHaveLength(1);
    expect(appels[0].corps).toMatchObject({ limit: 1, bbox: ZONE_SONDE_PAR_DEFAUT, collections: ["sentinel-2-l2a"], datetime: "2026-08-26T12:00:00Z/2026-10-25T12:00:00Z" });
    expect(appels[0].entetes.Authorization).toBeUndefined();
    expect(r.requete).toMatch(/^POST https:\/\/stac\.dataspace\.copernicus\.eu\/v1\/search /);
    expect(r.requete).toContain('"limit":1');
    expect(r.message).toMatch(/sans identifiants/);
  });

  it("Earth Search : meme resultat sur sa propre reponse reelle", async () => {
    const f = charger("earth-search-s2-l2a.json");
    const r = noter(await creerAdaptateurEarthSearch({ fetch: fetchScenario(reponseJson(f.reponse)).fetch, maintenant: horloge(MAINTENANT) }).verifierConnectivite());
    expect(r.etatAtteint).toBe("PRODUIT_DISPONIBLE");
  });

  it("la zone et la fenetre sont reglables", async () => {
    const f = charger("cdse-stac-s2-l2a.json");
    const { fetch, appels } = fetchScenario(reponseJson(f.reponse));
    await cdse(fetch).verifierConnectivite({ bbox: [-13.8, 9.4, -13.6, 9.6], joursFenetre: 10 });
    expect(appels[0].corps.bbox).toEqual([-13.8, 9.4, -13.6, 9.6]);
    expect(appels[0].corps.datetime).toBe("2026-10-15T12:00:00Z/2026-10-25T12:00:00Z");
  });

  it("la latence est mesuree avec l'horloge injectee", async () => {
    const f = charger("cdse-stac-s2-l1c.json");
    const r = noter(await cdse(fetchScenario(reponseJson(f.reponse)).fetch, { maintenant: horloge(MAINTENANT, 100) }).verifierConnectivite());
    expect(r.latenceMs).toBeGreaterThan(0);
  });
});

describe("ACCESSIBLE", () => {
  it("catalogue joignable mais aucun produit dans la fenetre", async () => {
    const r = noter(await cdse(fetchScenario(reponseJson(syn.page([]))).fetch).verifierConnectivite());
    expect(r).toMatchObject({ etatAtteint: "ACCESSIBLE", produitsTrouves: 0, categorieErreur: null });
    expect(r.message).toMatch(/aucun produit sentinel-2-l2a/);
  });

  it("catalogue joignable mais le produit rendu est inexploitable : ACCESSIBLE, pas PRODUIT_DISPONIBLE", async () => {
    const r = noter(await cdse(fetchScenario(reponseJson(syn.page([syn.empriseNonFermee()]))).fetch).verifierConnectivite());
    expect(r.etatAtteint).toBe("ACCESSIBLE");
    expect(r.produitsTrouves).toBe(0);
    expect(r.message).toMatch(/PRODUIT_ECARTE_EMPRISE_INVALIDE/);
  });
});

describe("EN_ERREUR", () => {
  it.each([
    ["503 persistant", reponseJson({}, 503), "INDISPONIBLE"],
    ["429 persistant", reponseJson({}, 429), "QUOTA"],
    ["401", reponseJson({ code: "DAT-ZIP-604", message: "Token not found" }, 401), "AUTH"],
    ["403", reponseJson({}, 403), "AUTH"],
    ["404", reponseJson({}, 404), "ENTREE"],
    ["panne reseau", new TypeError("fetch failed"), "RESEAU"],
    ["200 qui n'est pas du JSON", new Response("<html>maintenance</html>", { status: 200 }), "INDISPONIBLE"],
    ["200 sans liste de produits", reponseJson({ code: "InternalError" }), "INDISPONIBLE"],
  ] as const)("%s : categorie %s, requete conservee", async (_nom, etape, categorie) => {
    const r = noter(await cdse(fetchScenario(etape).fetch).verifierConnectivite());
    expect(r.etatAtteint).toBe("EN_ERREUR");
    expect(r.categorieErreur).toBe(categorie);
    expect(r.message.startsWith(categorie)).toBe(true);
    expect(r.requete).toMatch(/^POST https:\/\//);
    expect(r.produitsTrouves).toBeNull();
  });

  it("une zone invalide est une erreur d'entree, et rien n'est envoye", async () => {
    const { fetch, appels } = fetchScenario(reponseJson(syn.page([])));
    const r = noter(await cdse(fetch).verifierConnectivite({ bbox: [1, 2, 0, 1] }));
    expect(r).toMatchObject({ etatAtteint: "EN_ERREUR", categorieErreur: "ENTREE" });
    expect(appels).toHaveLength(0);
  });

  it("le message d'erreur ne laisse pas passer un jeton que le fournisseur repeterait", async () => {
    const JETON = "eyJraWQiOiJ0ZXN0In0.CHARGE-SECRETE-9876543210.sig";
    const { fetch } = fetchScenario(reponseJson(syn.erreurQuiRepeteLeJeton(JETON), 400));
    const r = noter(await cdse(fetch, { secrets: [JETON] }).verifierConnectivite());
    expect(r.etatAtteint).toBe("EN_ERREUR");
    expect(JSON.stringify(r)).not.toContain(JETON);
    expect(JSON.stringify(r)).not.toContain("CHARGE-SECRETE");
  });
});

describe("CONFIGUREE et EN_ATTENTE_CONFIGURATION", () => {
  it("sansReseau : CONFIGUREE, aucune requete", async () => {
    const { fetch, appels } = fetchScenario(reponseJson({}));
    const r = noter(await cdse(fetch).verifierConnectivite({ sansReseau: true }));
    expect(r).toMatchObject({ etatAtteint: "CONFIGUREE", requete: null, latenceMs: 0, produitsTrouves: null });
    expect(appels).toHaveLength(0);
  });

  it("les facades : EN_ATTENTE_CONFIGURATION, quoi qu'on demande", async () => {
    for (const f of [creerFacadePlanetScope(horloge(MAINTENANT)), creerFacadeSpot(horloge(MAINTENANT))]) {
      for (const options of [undefined, { sansReseau: true }, { bbox: ZONE_SONDE_PAR_DEFAUT, joursFenetre: 5 }]) {
        const r = noter(await f.verifierConnectivite(options));
        expect(r).toMatchObject({ etatAtteint: "EN_ATTENTE_CONFIGURATION", message: "interface prevue, aucune commande sans autorisation humaine", latenceMs: 0, requete: null });
        expect(r.verifieLe).toBe("2026-10-25T12:00:00.000Z");
      }
    }
  });
});

describe("l'echelle du contrat n'est jamais depassee", () => {
  it("aucun scenario ci-dessus n'a rendu un etat hors de l'ensemble autorise", () => {
    expect(vus.length).toBeGreaterThanOrEqual(15);
    for (const r of vus) {
      expect(AUTORISES).toContain(r.etatAtteint);
      expect(r.etatAtteint).not.toBe("TRAITEMENT_OPERATIONNEL");
      expect(r.etatAtteint).not.toBe("AUTHENTIFIEE");
    }
    // et chaque etat autorise est bien atteint par au moins un scenario
    for (const e of AUTORISES) expect(vus.some((r) => r.etatAtteint === e)).toBe(true);
  });
});
