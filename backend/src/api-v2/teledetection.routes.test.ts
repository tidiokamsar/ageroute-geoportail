import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `/api/v2/teledetection` -- comportement des routes (les droits sont dans `teledetection.acces.test.ts`). Ce que ces tests defendent :
 *   - chaque endpoint du contrat repond avec la forme du contrat, et TOUTE erreur a la forme `{ error, code }` ;
 *   - une entree hostile donne 400, jamais 500 et jamais une ecriture ; un filtre invalide est refuse, pas ignore ;
 *   - une panne de lecture donne une erreur, jamais un resultat vide ;
 *   - un produit sans emprise valide ou sans nuages est ECARTE et compte ; la synchronisation deduplique ;
 *   - une source n'est jamais « active » par un test de catalogue ;
 *   - aucun appel reseau : adaptateurs et `fetch` de l'apercu sont injectes (fixtures reelles d'EO-SOURCES).
 * Les invariants tenus en base (figement, unicite, declencheurs) sont eprouves par tests-integration/eo-api.integration.ts.
 *
 * MIS A JOUR PAR EO-API : le schema des routes est etendu aux champs du service (limites non vide, methodeNom, methodeVersion,
 * confianceDetection, priorite, imageCouverture..., synthetique) ; les cinq tests « Depot de propositions » suspendus par EO-DB sont reactives.
 */

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://127.0.0.1:1/essai";
  process.env.JWT_ACCESS_SECRET = "essai-access-secret-essai-access-secret-0000";
  process.env.JWT_REFRESH_SECRET = "essai-refresh-secret-essai-refresh-secret-000";
  process.env.CORS_ORIGIN = "http://localhost:5173";
});

vi.mock("../lib/prisma", async () => {
  const f = await import("./teledetection.fantome");
  return { prisma: f.creerPrisma() };
});

import { etat, ajouterCompte, ligneProposition, reinitialiser } from "./teledetection.fantome";
import { teledetectionV2Router } from "./teledetection.routes";
import { errorHandler } from "../middleware/error.middleware";
import { signAccessToken } from "../utils/jwt";
import { _installerSources, hoteAdmis } from "../teledetection/sources.service";
import { creerAdaptateurs } from "../teledetection/sources";
import { charger, fetchScenario, reponseJson } from "../teledetection/sources/essais.support";
import { empriseHorsGlobe, itemCdseReel, page, sansNuages, variante } from "../teledetection/sources/__fixtures__/synthetiques";

const app = express();
app.use(express.json({ limit: "5mb" })); // la limite de l'application reelle
app.use("/api/v2/teledetection", teledetectionV2Router);
app.use(errorHandler);
const BASE = "/api/v2/teledetection";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PRODUIT = U(60), PREF = U(61), P1 = U(1);

const jeton = (id: string) => { const c = etat.comptes.get(id)!; return signAccessToken({ sub: c.id, role: c.role as never, email: c.email }); };
type Methode = "get" | "post";
const appeler = (methode: Methode, chemin: string, corps?: unknown, compte = "u-admin") => {
  const r = request(app)[methode](`${BASE}${chemin}`).set("Authorization", `Bearer ${jeton(compte)}`);
  return methode === "post" ? r.send(corps as object) : r;
};
const jours = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const emprise = { type: "Polygon", coordinates: [[[-13.7, 9.5], [-13.4, 9.5], [-13.4, 9.8], [-13.7, 9.8], [-13.7, 9.5]]] };
const produit = {
  code: "S2-20261001", palier: 0, source: "Sentinel-2 L2A", nature: "OPTIQUE", dateAcquisition: "2026-10-01", resolutionM: 10,
  couvertureNuagesPct: 12, incertitude: "+/- 1 pixel", provenance: "scene-id", licence: "relevee a la source", versionTraitement: "v0", emprise,
};

let reseau: { mock: { calls: unknown[] }; mockRestore: () => void };
beforeEach(() => {
  reinitialiser();
  ajouterCompte({ id: "u-admin", role: "ADMIN", modulesAutorises: [] });
  ajouterCompte({ id: "u-gest", role: "GESTIONNAIRE" });
  ajouterCompte({ id: "u-lecteur", role: "LECTEUR" });
  etat.produits.push(
    { id: PRODUIT, code: "P", synthetique: false, dateAcquisition: new Date("2026-10-02") },
    { id: PREF, code: "PR", synthetique: false, dateAcquisition: new Date("2026-09-01") },
  );
  etat.sources.push(
    { id: "s-1", code: "SENTINEL2", etat: "NON_CONFIGUREE", requiertIdentifiants: false, derniereVerificationLe: null, derniereAcquisitionLe: null, dernierMessage: null },
    { id: "s-2", code: "PLANETSCOPE", etat: "EN_ATTENTE_CONFIGURATION", requiertIdentifiants: true, derniereVerificationLe: null, derniereAcquisitionLe: null, dernierMessage: null },
    { id: "s-3", code: "LANDSAT89", etat: "NON_CONFIGUREE", requiertIdentifiants: false, derniereVerificationLe: null, derniereAcquisitionLe: null, dernierMessage: null },
  );
  _installerSources({ adaptateurs: null, fetchApercu: null, maintenant: null });
  // Aucun appel reseau pendant ces tests : le `fetch` global ne doit jamais etre atteint.
  reseau = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("appel reseau interdit dans les tests"); });
});
afterEach(() => { expect(reseau.mock.calls).toHaveLength(0); reseau.mockRestore(); });

const cdse = () => charger("cdse-stac-s2-l2a.json");
const installer = (...etapes: Parameters<typeof fetchScenario>) => {
  const s = fetchScenario(...etapes);
  _installerSources({ adaptateurs: creerAdaptateurs({ fetch: s.fetch, sleep: async () => undefined }) });
  return s;
};

// ============================================================ lecture

describe("lecture : listes", () => {
  const trois = () => [
    ligneProposition(U(11), { dateObservation: new Date("2026-10-03T00:00:00Z") }),
    ligneProposition(U(12), { dateObservation: new Date("2026-10-02T00:00:00Z") }),
    ligneProposition(U(13), { dateObservation: new Date("2026-10-02T00:00:00Z") }),
  ];

  it("pagine par curseur : limite, suivant, total ; le curseur reprend apres la derniere ligne", async () => {
    etat.lignesListe.push(...trois());
    etat.total = 3;
    const r = await appeler("get", "/propositions?limite=2");
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(2);
    expect(r.body.total).toBe(3);
    expect(typeof r.body.suivant).toBe("string");
    const c = JSON.parse(Buffer.from(r.body.suivant, "base64url").toString());
    expect(c).toEqual({ d: "2026-10-02T00:00:00.000Z", id: U(12) });
    etat.requetes.length = 0;
    await appeler("get", `/propositions?limite=2&curseur=${r.body.suivant}`);
    const liste = etat.requetes.find((q) => q.sql.includes('ORDER BY p."dateAcquisition" DESC'))!;
    expect(liste.sql).toContain('p."dateAcquisition" <');
    expect(liste.valeurs).toContain("2026-10-02 00:00:00.000");
    expect(liste.valeurs).toContain(U(12));
    expect(liste.valeurs.at(-1)).toBe(3); // limite + 1 : la ligne en trop dit s'il y a une suite
  });

  it("derniere page : suivant nul", async () => {
    etat.lignesListe.push(...trois().slice(0, 1));
    etat.total = 1;
    const r = await appeler("get", "/propositions");
    expect(r.body.suivant).toBeNull();
    expect(r.body.items[0]).toMatchObject({ id: U(11), statut: "A_VERIFIER", rattachee: false, synthetique: false, missionId: null });
  });

  it("filtres : tableau, liste, valeur seule normalises ; le tri est fixe (date puis id) et les synthetiques exclus", async () => {
    await appeler("get", "/propositions?statut[]=A_VERIFIER&statut[]=EN_ATTENTE&type=INONDATION&priorite=HAUTE&rattachee=false&q=RN1");
    const liste = etat.requetes.find((q) => q.sql.includes('ORDER BY p."dateAcquisition" DESC'))!;
    expect(liste.valeurs).toContainEqual(["A_VERIFIER", "EN_ATTENTE"]);
    expect(liste.valeurs).toContainEqual(["INONDATION"]);
    expect(liste.valeurs).toContainEqual(["HAUTE"]);
    expect(liste.sql).toContain('pt."tronconId" IS NULL');
    expect(liste.sql).toContain('NOT pt."synthetique"');
    expect(liste.sql).toContain('ORDER BY p."dateAcquisition" DESC, pt."id" ASC');
    expect(liste.valeurs).toContain("%RN1%");
  });

  it("la recherche texte echappe %, _ et \\ : ils n'ont pas valeur de motif", async () => {
    await appeler("get", "/propositions?q=100%25_x");
    const liste = etat.requetes.find((q) => q.sql.includes('ORDER BY p."dateAcquisition" DESC'))!;
    expect(liste.valeurs).toContain("%100\\%\\_x%");
  });

  it.each([
    ["?statut=", "filtre vide"], ["?statut=BIDON", "statut inconnu"], ["?statut[a]=b", "objet"], ["?limite=0", "limite nulle"], ["?limite=101", "limite trop grande"],
    ["?limite=abc", "limite non numerique"], ["?depuis=2999-01-01", "an 2999"], ["?depuis=demain", "date libre"], ["?curseur=xxxx", "curseur illisible"],
    ["?regionId=abc", "region non numerique"], ["?tronconId=1;DROP", "troncon non UUID"], ["?statuts=A_VERIFIER", "parametre inconnu"], ["?rattachee=oui", "booleen invalide"],
    ["?q=" + "a".repeat(101), "q trop long"], ["?depuis=2026-10-10&jusqua=2026-10-01", "periode inversee"],
  ])("%s -> 400 ENTREE_INVALIDE (%s), jamais ignore, jamais 500", async (qs) => {
    const r = await appeler("get", `/propositions${qs}`);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: expect.any(String), code: "ENTREE_INVALIDE" });
    expect(etat.requetes.filter((q) => q.sql.includes('FROM "propositions_teledetection" pt JOIN'))).toHaveLength(0);
  });

  it("une panne de la base est une ERREUR (500 ERREUR_INTERNE avec code), jamais une liste vide", async () => {
    etat.panneLecture = true;
    const r = await appeler("get", "/propositions");
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "Erreur interne du serveur", code: "ERREUR_INTERNE" });
    expect(r.body.items).toBeUndefined();
    for (const chemin of ["/sources", "/precision", "/qualite-methodes"]) {
      const x = await appeler("get", chemin);
      expect(x.status, chemin).toBe(500);
      expect(x.body.code).toBe("ERREUR_INTERNE");
    }
  });
});

describe("lecture : GeoJSON", () => {
  const ligneGeo = (n: number, extra: Record<string, unknown> = {}) => ({ id: U(n), type: "INONDATION", statut: "A_VERIFIER", prioriteNiveau: "HAUTE", rattachee: false, geometrie: { type: "Point", coordinates: [-13.6, 9.64] }, ...extra });

  it("FeatureCollection avec proprietes minimales, `tronque` et `total` (jamais de troncature silencieuse)", async () => {
    etat.lignesListe.push(ligneGeo(11), ligneGeo(12, { prioriteNiveau: null, rattachee: true }));
    etat.total = 5;
    const r = await appeler("get", "/propositions.geojson?bbox=-13.7,9.5,-13.4,9.8");
    expect(r.status).toBe(200);
    expect(r.body.type).toBe("FeatureCollection");
    expect(r.body.tronque).toBe(true);
    expect(r.body.total).toBe(5);
    expect(r.body.features[0]).toEqual({ type: "Feature", geometry: { type: "Point", coordinates: [-13.6, 9.64] }, properties: { id: U(11), type: "INONDATION", statut: "A_VERIFIER", priorite: "HAUTE", rattachee: false } });
    expect(r.body.features[1].properties.priorite).toBeNull();
    etat.total = 2;
    expect((await appeler("get", "/propositions.geojson?bbox=-13.7,9.5,-13.4,9.8")).body.tronque).toBe(false);
  });

  it("plafond 300 par defaut, borne a 1000 ; ordre de plafonnement : priorite haute, A_VERIFIER, identifiant", async () => {
    await appeler("get", "/propositions.geojson?bbox=-13.7,9.5,-13.4,9.8");
    const q = etat.requetes.find((x) => x.sql.includes("ST_AsGeoJSON"))!;
    expect(q.valeurs.at(-1)).toBe(300);
    expect(q.sql).toMatch(/ORDER BY coalesce\(pt\."prioriteNiveau" = 'HAUTE', false\) DESC, \(pt\."statut" = 'A_VERIFIER'\) DESC, pt\."id" ASC/);
    expect(q.sql).toContain('NOT pt."synthetique"');
    expect((await appeler("get", "/propositions.geojson?bbox=-13.7,9.5,-13.4,9.8&limite=1001")).status).toBe(400);
  });

  it("une emprise de 9,99 degres de cote est servie (vue nationale), 10,01 est refusee", async () => {
    expect((await appeler("get", "/propositions.geojson?bbox=-20,9,-10.01,12")).status).toBe(200);
    expect((await appeler("get", "/propositions.geojson?bbox=-20,9,-9.99,12")).status).toBe(400);
  });

  it.each([
    ["", "bbox absente"], ["?bbox=-13.7,9.5,-13.4", "trois nombres"], ["?bbox=-20,9,-9.99,12", "cote de 10,01 degres (borne : 10)"], ["?bbox=-200,9,-190,9.5", "hors du globe"],
    ["?bbox=-13.4,9.5,-13.7,9.8", "ouest > est"], ["?bbox=a,b,c,d", "texte"], ["?bbox=-13.7,9.5,-13.4,9.8&statut=", "statut vide"], ["?bbox=-13.7,9.5,-13.4,9.8&x=1", "parametre inconnu"],
  ])("%s -> 400 (%s)", async (qs) => {
    const r = await appeler("get", `/propositions.geojson${qs}`);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("ENTREE_INVALIDE");
  });
});

describe("lecture : detail, synthese, sources, produits, qualite", () => {
  beforeEach(() => { etat.propositions.push({ id: P1, statut: "A_VERIFIER", regionId: null, missionId: null, type: "INONDATION" }); });

  it("detail : produits avant/apres, limites, provenance, historique, mission, preuves, geometrie, apercus", async () => {
    etat.lignesDetail.push(ligneProposition(P1, {
      regionId: 1, tronconId: U(5), tronconCode: "RN1", tronconNom: "Conakry-Kindia", regionNom: "Conakry", rattachementConfiance: "HAUTE", rattachementAlgorithme: "PLUS_PROCHE_DANS_TOLERANCE_V1",
      distanceTronconM: 12.5, confianceDetection: 0.87, prioriteNiveau: "HAUTE", prioriteRegle: "regle-1", sourceCode: "SENTINEL2", sourceNom: "Sentinel-2", produitCapteur: "SENTINEL-2",
      resolutionNativeM: 10, identifiantFournisseur: "S2C_X", collection: "sentinel-2-l2a", fournisseur: "CDSE", licenceAttribution: "Contains modified Copernicus Sentinel data 2026",
      p_sourceCode: "SENTINEL2", p_identifiantFournisseur: "S2C_X", p_collection: "sentinel-2-l2a", p_fournisseur: "CDSE", ref_id: U(61), ref_code: "PR", ref_sourceCode: "SENTINEL2",
      ref_identifiantFournisseur: "S2C_Y", ref_collection: "sentinel-2-l2a", ref_dateAcquisition: new Date("2026-09-01T00:00:00Z"), ref_synthetique: false, ref_source: "x", ref_nature: "OPTIQUE",
      ref_resolutionM: 10, ref_cycleVie: "CATALOGUE", dateReference: new Date("2026-09-01T00:00:00Z"),
    }));
    const r = await appeler("get", `/propositions/${P1}`, undefined, "u-lecteur");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      id: P1, statut: "A_VERIFIER", priorite: { niveau: "HAUTE", regle: "regle-1" },
      confianceDetection: { valeur: 0.87, calibree: false }, rattachement: { confiance: "HAUTE", distanceM: 12.5 },
      troncon: { id: U(5), code: "RN1", regionNom: "Conakry" }, rattachee: true, limites: ["Resolution native 10 m"],
      provenance: { fournisseur: "CDSE", identifiantFournisseur: "S2C_X", attribution: "Contains modified Copernicus Sentinel data 2026" },
      geometrie: { type: "Point" }, historique: [], mission: null, terrain: { observations: [] },
    });
    expect(r.body.produitApres).toMatchObject({ id: PRODUIT, identifiantFournisseur: "S2C_X" });
    expect(r.body.produitAvant).toMatchObject({ id: U(61) });
    // l'apercu passe par le SERVEUR, jamais par l'adresse du fournisseur
    expect(r.body.apercus.apres.url).toBe(`/api/v2/teledetection/produits/${PRODUIT}/apercu`);
    expect(r.body.apercus.avant.url).toBe(`/api/v2/teledetection/produits/${U(61)}/apercu`);
    expect(JSON.stringify(r.body)).not.toMatch(/https?:\/\//);
  });

  it("detail : des limites NON RENSEIGNEES (ligne d'avant la migration) ne sont pas rendues comme « aucune limite » (constat EO-FIX-BACK 8)", async () => {
    etat.lignesDetail.push(ligneProposition(P1, { limites: null }));
    const r = await appeler("get", `/propositions/${P1}`);
    expect(r.status).toBe(200);
    expect(r.body.limites).toBeNull();
    expect(r.body.limitesNonRenseignees).toBe(true);
  });

  it("detail : des limites renseignees sont rendues telles quelles, avec limitesNonRenseignees faux", async () => {
    etat.lignesDetail.push(ligneProposition(P1, { limites: ["Resolution native 10 m"] }));
    const r = await appeler("get", `/propositions/${P1}`);
    expect(r.body.limites).toEqual(["Resolution native 10 m"]);
    expect(r.body.limitesNonRenseignees).toBe(false);
  });

  it("detail sans image rattachable : apercus.url nul (jamais une image de remplacement)", async () => {
    etat.lignesDetail.push(ligneProposition(P1));
    const r = await appeler("get", `/propositions/${P1}`);
    expect(r.body.apercus.apres.url).toBeNull();
    expect(r.body.apercuDisponible).toBe(false);
    expect(r.body.produitAvant).toBeNull();
  });

  it("synthese : forme du contrat, taux nul sans verdict (pas 0 %), aucune source active", async () => {
    const r = await appeler("get", "/synthese");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      periode: { depuis: null, jusqua: null },
      propositions: { aVerifier: 0, enAttente: 0, nonConcluantes: 0, confirmees: 0, infirmees: 0, prioritaires: 0 },
      tauxConfirmation: { valeur: null, jugees: 0, echantillonSuffisant: false, seuil: 30 },
      sources: { total: 3, actives: 0 }, derniereAcquisition: null,
      fraicheur: { ageDerniereAcquisitionJours: null },
    });
    expect(typeof r.body.tauxConfirmation.definition).toBe("string");
    expect((await appeler("get", "/synthese?depuis=2999-01-01")).status).toBe(400);
  });

  it("sources : tableau, etat lu en base (jamais deduit du nom), adaptateur relie, active = TRAITEMENT_OPERATIONNEL seulement", async () => {
    const r = await appeler("get", "/sources");
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.find((s: { code: string }) => s.code === "SENTINEL2")).toMatchObject({ etat: "NON_CONFIGUREE", adaptateur: "cdse-stac", active: false, requiertIdentifiants: false, derniereVerification: null });
    expect(r.body.find((s: { code: string }) => s.code === "PLANETSCOPE")).toMatchObject({ etat: "EN_ATTENTE_CONFIGURATION", adaptateur: "planetscope", active: false });
    expect(r.body.every((s: { active: boolean }) => s.active === false)).toBe(true);
  });

  it("qualite-methodes : seuil, definition, lignes ; precision conservee", async () => {
    const q = await appeler("get", "/qualite-methodes");
    expect(q.body).toMatchObject({ seuilEchantillon: 30, lignes: [] });
    expect(q.body.definition).toMatch(/Taux de confirmation terrain/);
    expect((await appeler("get", "/precision")).body).toMatchObject({ lignes: [] });
  });

  it("precision et qualite-methodes sont des agregats NATIONAUX : refuses (403 HORS_PERIMETRE) a un compte regional, sans aucune requete de lecture (constat EO-FIX-BACK 1)", async () => {
    ajouterCompte({ id: "u-regional", role: "GESTIONNAIRE", regions: [1] });
    ajouterCompte({ id: "u-lecteur-r", role: "LECTEUR", regions: [1] });
    for (const compte of ["u-regional", "u-lecteur-r"]) {
      for (const chemin of ["/precision", "/qualite-methodes"]) {
        etat.requetes.length = 0;
        const r = await appeler("get", chemin, undefined, compte);
        expect(r.status, `${compte} ${chemin}`).toBe(403);
        expect(r.body.code).toBe("HORS_PERIMETRE");
        expect(JSON.stringify(r.body)).not.toMatch(/lignes|jugees|confirmees/);
        // le refus precede la lecture : aucune agregation nationale n'est meme calculee
        expect(etat.requetes.some((q) => q.sql.includes("precision_teledetection") || q.sql.includes("qualite_methodes_eo"))).toBe(false);
      }
    }
    // un compte national (ou sans rattachement) les lit toujours ; la synthese, filtree par region, reste lisible du compte regional
    for (const chemin of ["/precision", "/qualite-methodes"]) expect((await appeler("get", chemin, undefined, "u-gest")).status).toBe(200);
    expect((await appeler("get", "/synthese", undefined, "u-regional")).status).toBe(200);
  });

  it("coherence (reportee du lot 17) : anomalies de la vue avec leur gravite, bloquantes d'abord ; agregat NATIONAL refuse a un compte regional", async () => {
    etat.lignesCoherence.push(
      { propositionId: "pr-2", regle: "MISSION_SANS_VERDICT", detail: "VER-1 TERMINEE" },
      { propositionId: "pr-1", regle: "HORS_EMPRISE_PRODUIT", detail: "S1" },
      { propositionId: "pr-3", regle: "REGLE_INCONNUE", detail: null },
    );
    const r = await appeler("get", "/coherence", undefined, "u-gest");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ bloquantes: 2, aExaminer: 1, tronquee: false });
    expect(r.body.anomalies.map((a: { regle: string; gravite: string }) => `${a.regle}:${a.gravite}`)).toEqual([
      "HORS_EMPRISE_PRODUIT:BLOQUANTE", "REGLE_INCONNUE:BLOQUANTE", "MISSION_SANS_VERDICT:A_EXAMINER",
    ]);
    ajouterCompte({ id: "u-regional-c", role: "GESTIONNAIRE", regions: [1] });
    etat.requetes.length = 0;
    const refus = await appeler("get", "/coherence", undefined, "u-regional-c");
    expect(refus.status).toBe(403);
    expect(refus.body.code).toBe("HORS_PERIMETRE");
    expect(etat.requetes.some((q) => q.sql.includes("coherence_teledetection"))).toBe(false);
  });

  it("produits : liste paginee, filtres valides", async () => {
    etat.lignesListe.push({ id: PRODUIT, code: "P", sourceCode: "SENTINEL2", source: "SENTINEL-2 L2A", sourceNom: "Sentinel-2", fournisseur: "CDSE", identifiantFournisseur: "X", collection: "sentinel-2-l2a", capteur: "SENTINEL-2", nature: "OPTIQUE", niveauTraitement: "L2A", scene: "s", orbite: null, dateAcquisition: new Date("2026-10-02T00:00:00Z"), dateFin: null, resolutionM: 10, resolutionNativeM: 10, couvertureNuagesPct: 12, cycleVie: "CATALOGUE", licence: "l", licenceCode: null, licenceAttribution: null, versionTraitement: "v", empreinteSha256: null });
    etat.total = 1;
    const r = await appeler("get", "/produits?nature=OPTIQUE&source=SENTINEL2");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 1, suivant: null });
    expect(r.body.items[0]).toMatchObject({ id: PRODUIT, source: { code: "SENTINEL2" }, apercuDisponible: true, resolutionNativeM: 10 });
    expect((await appeler("get", "/produits?nature=SOLAIRE")).status).toBe(400);
    expect((await appeler("get", "/produits?bbox=0,0,50,50")).status).toBe(400);
  });

  it("route inconnue du module : 404 avec code", async () => {
    const r = await appeler("get", "/nexiste-pas");
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: expect.any(String), code: "ROUTE_INCONNUE" });
  });

  it("les reponses sont privees (jamais un cache partage)", async () => {
    const r = await appeler("get", "/sources");
    expect(r.headers["cache-control"]).toBe("private, no-cache");
  });
});

// ============================================================ ecriture

describe("transitions", () => {
  beforeEach(() => { etat.propositions.push({ id: P1, statut: "A_VERIFIER", regionId: null, missionId: null, type: "INONDATION" }); });
  const t = (corps: unknown, compte = "u-gest") => appeler("post", `/propositions/${P1}/transition`, corps, compte);

  it("met en attente (motif d'attente), journal et audit dans la meme transaction", async () => {
    const r = await t({ vers: "EN_ATTENTE", motif: "Equipe prevenue", motifAttente: "INFO_DEMANDEE" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: P1, de: "A_VERIFIER", vers: "EN_ATTENTE", motifAttente: "INFO_DEMANDEE", verdict: null });
    expect(etat.journal).toEqual([expect.objectContaining({ propositionId: P1, de: "A_VERIFIER", vers: "EN_ATTENTE", auteurId: "u-gest", motif: "Equipe prevenue", motifAttente: "INFO_DEMANDEE" })]);
    expect(etat.audits).toEqual([expect.objectContaining({ action: "UPDATE", entityType: "PropositionTeledetection", userId: "u-gest" })]);
  });

  it("un verdict cite son constat ; audit VALIDATE / REJECT ; definitif (409 VERDICT_DEFINITIF)", async () => {
    const sans = await t({ vers: "CONFIRMEE", motif: "Eau constatee" });
    expect(sans.status).toBe(400);
    expect(sans.body.code).toBe("CONSTAT_REQUIS");
    const ok = await t({ vers: "CONFIRMEE", motif: "Eau constatee", constatRef: "mission:VER-1" });
    expect(ok.status).toBe(200);
    expect(ok.body.verdict).toMatchObject({ par: "u-gest", constatRef: "mission:VER-1" });
    expect(etat.audits.at(-1)).toMatchObject({ action: "VALIDATE" });
    const encore = await t({ vers: "EN_ATTENTE", motif: "x", motifAttente: "AUTRE" });
    expect(encore.status).toBe(409);
    expect(encore.body).toEqual({ error: expect.any(String), code: "VERDICT_DEFINITIF" });
  });

  it("transition hors table : 409 TRANSITION_INTERDITE (A_VERIFIER vers A_VERIFIER)", async () => {
    const r = await t({ vers: "A_VERIFIER", motif: "x" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("TRANSITION_INTERDITE");
    expect(etat.journal).toHaveLength(0);
  });

  it.each([
    [{}, "vide"], [{ vers: "EN_ATTENTE", motif: "" }, "motif vide"], [{ vers: "EN_ATTENTE", motif: "x".repeat(1001), motifAttente: "AUTRE" }, "motif > 1000"],
    [{ vers: "PROBABLE", motif: "x" }, "statut inconnu"], [{ vers: "EN_ATTENTE", motif: "x", motifAttente: "AUTRE", intrus: 1 }, "champ en trop"],
    [{ vers: "EN_ATTENTE", motif: "x", motifAttente: "BIDON" }, "motif d'attente inconnu"], [{ vers: "NON_CONCLUANTE", motif: "x", observationIds: ["pas-un-uuid"] }, "observation non UUID"],
    [{ vers: "NON_CONCLUANTE", motif: "x", observationIds: Array.from({ length: 21 }, (_, i) => U(100 + i)) }, "trop d'observations"], ["texte", "corps texte"], [null, "corps nul"], [[1], "tableau"],
  ])("corps %j -> 400 ENTREE_INVALIDE (%s)", async (corps, _nom) => {
    const r = await t(corps);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: expect.any(String), code: "ENTREE_INVALIDE" });
    expect(etat.audits).toHaveLength(0);
  });
});

describe("preuves de terrain et perimetre regional (constat EO-FIX-BACK 2)", () => {
  const OBS_R1 = U(91), OBS_R2 = U(92), OBS_INCONNUE = U(93), OBS_SANS_REGION = U(94);
  beforeEach(() => {
    ajouterCompte({ id: "u-r1", role: "GESTIONNAIRE", regions: [1] });
    etat.propositions.push({ id: P1, statut: "A_VERIFIER", regionId: 1, missionId: null, type: "INONDATION" });
    etat.observations.push(
      { id: OBS_R1, agentId: "u-x", regionId: 1 },
      { id: OBS_R2, agentId: "u-x", regionId: 2 },          // observation d'un autre agent, region 2
      { id: OBS_SANS_REGION, agentId: "u-x", regionId: null }, // aucun troncon ni mission : region inconnue
    );
  });
  const t = (observationIds: string[], compte: string) => appeler("post", `/propositions/${P1}/transition`, { vers: "NON_CONCLUANTE", motif: "terrain", observationIds }, compte);

  it("un gestionnaire regional ne peut pas citer l'observation d'une autre region : 404, rien n'est ecrit", async () => {
    const r = await t([OBS_R2], "u-r1");
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("OBSERVATION_INEXISTANTE");
    expect(etat.journal).toHaveLength(0);
    expect(etat.preuves).toHaveLength(0);
    expect(etat.audits).toHaveLength(0);
  });

  it("inexistante, hors perimetre et sans region determinable : EXACTEMENT la meme reponse, sans identifiant (plus d'oracle d'existence)", async () => {
    const reponses = [];
    for (const id of [OBS_INCONNUE, OBS_R2, OBS_SANS_REGION]) {
      const r = await t([id], "u-r1");
      reponses.push({ status: r.status, body: r.body });
      expect(JSON.stringify(r.body)).not.toContain(id);
    }
    expect(reponses[0].status).toBe(404);
    expect(reponses[1]).toEqual(reponses[0]);
    expect(reponses[2]).toEqual(reponses[0]);
  });

  it("une observation de son propre perimetre est acceptee ; un compte national cite aussi celle d'une autre region et celle sans region", async () => {
    expect((await t([OBS_R1], "u-r1")).status).toBe(200);
    etat.propositions.push({ id: U(2), statut: "A_VERIFIER", regionId: null, missionId: null, type: "INONDATION" });
    const nat = (id: string) => appeler("post", `/propositions/${U(2)}/transition`, { vers: "NON_CONCLUANTE", motif: "terrain", observationIds: [id] }, "u-gest");
    expect((await nat(OBS_R2)).status).toBe(200);
  });

  it("la meme regle pour l'ajout de preuves seules", async () => {
    const r = await appeler("post", `/propositions/${P1}/preuves`, { observationIds: [OBS_R2] }, "u-r1");
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("OBSERVATION_INEXISTANTE");
  });

  describe("lecture du detail : re-controle a la lecture", () => {
    const preuve = (id: string, regionId: number | null, extra = {}) => ({ id, date: new Date("2026-10-04T00:00:00Z"), auteur: `Agent ${id.slice(-2)}`, type: "DEGRADATION", description: `DESCRIPTION CONFIDENTIELLE ${id.slice(-2)}`, regionId, ...extra });
    beforeEach(() => {
      etat.lignesDetail.push(ligneProposition(P1, { regionId: 1 }));
      etat.lignesPreuves.push(preuve(OBS_R1, 1), preuve(OBS_R2, 2), preuve(OBS_SANS_REGION, null));
    });

    it("un compte regional ne recoit ni l'auteur, ni le type, ni la description d'une observation hors de son perimetre ; elle est comptee, pas omise en silence", async () => {
      const r = await appeler("get", `/propositions/${P1}`, undefined, "u-r1");
      expect(r.status).toBe(200);
      expect(r.body.terrain.observations.map((o: { id: string }) => o.id)).toEqual([OBS_R1]);
      expect(r.body.terrain.observationsMasquees).toBe(2);
      expect(JSON.stringify(r.body)).not.toContain(OBS_R2);
      expect(JSON.stringify(r.body)).not.toContain(OBS_SANS_REGION);
      expect(JSON.stringify(r.body)).not.toMatch(/CONFIDENTIELLE 92|CONFIDENTIELLE 94|Agent 92/);
    });

    it("un compte national voit toutes les preuves, aucune masquee", async () => {
      const r = await appeler("get", `/propositions/${P1}`, undefined, "u-gest");
      expect(r.body.terrain.observations).toHaveLength(3);
      expect(r.body.terrain.observationsMasquees).toBe(0);
    });
  });
});

describe("mission de verification", () => {
  beforeEach(() => { etat.propositions.push({ id: P1, statut: "A_VERIFIER", regionId: null, missionId: null, type: "INONDATION" }); });

  it("depeche une mission SURVEILLANCE une seule fois ; le commentaire est journalise", async () => {
    const r = await appeler("post", `/propositions/${P1}/verification`, { commentaire: "A voir cette semaine" }, "u-gest");
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ type: "SURVEILLANCE", statut: "BROUILLON" });
    expect(r.body.code).toMatch(/^VER-TD-/);
    expect(etat.audits.map((a) => (a.after as { operation?: string })?.operation)).toContain("DEMANDE_VERIFICATION");
    const encore = await appeler("post", `/propositions/${P1}/verification`, {}, "u-gest");
    expect(encore.status).toBe(409);
    expect(encore.body.code).toBe("MISSION_DEJA_DEPECHEE");
  });

  it("commentaire > 500, champ inconnu, assigne non UUID : 400", async () => {
    for (const corps of [{ commentaire: "x".repeat(501) }, { intrus: 1 }, { assigneId: "moi" }, { commentaire: "" }]) {
      expect((await appeler("post", `/propositions/${P1}/verification`, corps)).status, JSON.stringify(corps).slice(0, 40)).toBe(400);
    }
    expect(etat.missions).toHaveLength(0);
  });
});

describe("depot de produits", () => {
  it("enregistre un produit complet, en une insertion parametree, auditee", async () => {
    const r = await appeler("post", "/produits", produit, "u-gest");
    expect(r.status).toBe(201);
    const sql = etat.executions[0].sql;
    expect(sql).toContain('INSERT INTO "earth_observation_products"');
    expect(sql).toContain("ST_GeomFromGeoJSON(");
    expect(etat.audits).toEqual([expect.objectContaining({ action: "CREATE", entityType: "EarthObservationProduct" })]);
  });

  it("accepte la tracabilite fournisseur (champs du service) ; refuse l'incoherence", async () => {
    const ok = await appeler("post", "/produits", { ...produit, code: "S2-TR", fournisseur: "CDSE", identifiantFournisseur: "S2C_1", collection: "sentinel-2-l2a", capteur: "SENTINEL-2", niveauTraitement: "L2A", sourceCode: "SENTINEL2", synthetique: false });
    expect(ok.status).toBe(201);
    const incoherent = await appeler("post", "/produits", { ...produit, code: "S2-TR2", fournisseur: "CDSE" });
    expect(incoherent.status).toBe(400);
    expect(incoherent.body.code).toBe("FOURNISSEUR_INCOMPLET");
  });

  it("refuse sans licence, palier payant sans autorisation, nuages manquants (optique), emprise non polygonale", async () => {
    expect((await appeler("post", "/produits", { ...produit, licence: " " })).status).toBe(400);
    const d = await appeler("post", "/produits", { ...produit, palier: 1 });
    expect(d.status).toBe(400); expect(d.body.code).toBe("DEPENSE_NON_AUTORISEE");
    const n = await appeler("post", "/produits", { ...produit, couvertureNuagesPct: undefined });
    expect(n.status).toBe(400); expect(n.body.code).toBe("NUAGES_REQUIS");
    const e = await appeler("post", "/produits", { ...produit, emprise: { type: "Point", coordinates: [0, 0] } });
    expect(e.status).toBe(400);
    expect(etat.executions).toHaveLength(0);
  });

  it.each([
    ["emprise hors du globe", { emprise: { type: "Polygon", coordinates: [[[0, 0], [200, 0], [200, 1], [0, 1], [0, 0]]] } }],
    ["emprise latitude 95", { emprise: { type: "Polygon", coordinates: [[[0, 90], [1, 95], [1, 80], [0, 80], [0, 90]]] } }],
    ["emprise absente", { emprise: undefined }],
    ["emprise coordinates texte", { emprise: { type: "Polygon", coordinates: "0,0" } }],
    ["emprise auto-intersectee", { emprise: { type: "Polygon", coordinates: [[[0, 0], [2, 2], [2, 0], [0, 1], [0, 0]]] } }],
    ["emprise anneau ouvert", { emprise: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] } }],
    ["date en l'an 2999", { dateAcquisition: "2999-01-01" }],
    ["date illisible", { dateAcquisition: "hier" }],
    ["fin avant debut", { dateFin: "2026-09-01" }],
    ["resolution negative", { resolutionM: -10 }],
    ["nuages 140 %", { couvertureNuagesPct: 140 }],
    ["champ inconnu", { confianceCalibree: true }],
    ["SHA-256 invalide", { empreinteSha256: "abc" }],
    ["code trop long", { code: "x".repeat(65) }],
    ["nature inconnue", { nature: "SOLAIRE" }],
    ["palier decimal", { palier: 0.5 }],
  ])("hostile : %s -> 400, aucune ecriture", async (_nom, delta) => {
    const r = await appeler("post", "/produits", { ...produit, ...delta });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: expect.any(String), code: expect.any(String) });
    expect(etat.executions).toHaveLength(0);
    expect(etat.audits).toHaveLength(0);
  });

  it("corps qui n'est pas un objet : 400", async () => {
    for (const corps of ["texte", null, []]) expect((await appeler("post", "/produits", corps)).status).toBe(400);
  });
});

describe("Depot de propositions", () => {
  const lot = {
    produitId: PRODUIT, methodeNom: "seuil-sar", methodeVersion: "v0",
    propositions: [{ type: "INONDATION", geometrie: { type: "Point", coordinates: [-13.6, 9.64] }, score: 0.7, limites: ["Resolution native 10 m"] }],
  };

  it("sans tolerance : la tolerance part nulle, rien n'est suppose ; nom et version separes", async () => {
    const r = await appeler("post", "/propositions", lot, "u-gest");
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ deposees: 1, toleranceRattachementM: null });
    const valeurs = etat.executions[0].valeurs;
    expect(valeurs).toContain(null);
    expect(valeurs).toContain("seuil-sar v0");
    expect(valeurs).toContain("seuil-sar");
  });

  it("champs du service : confiance de detection, priorite et sa regle, qualite d'image, limites, synthetique", async () => {
    const complet = { ...lot, propositions: [{ ...lot.propositions[0], confianceDetection: 0.87, priorite: { niveau: "HAUTE", regle: "regle-inondation-v1" }, imageCouvertureNuagesPct: 12, imageNote: "Voile leger", limites: ["Resolution native 10 m", "Nuages possibles"] }] };
    const r = await appeler("post", "/propositions", complet);
    expect(r.status).toBe(201);
    const v = etat.executions[0].valeurs;
    expect(v).toEqual(expect.arrayContaining([0.87, "HAUTE", "regle-inondation-v1", 12, "Voile leger", ["Resolution native 10 m", "Nuages possibles"]]));
  });

  it("avec tolerance : elle part en parametre lie ; hors bornes elle est refusee", async () => {
    await appeler("post", "/propositions", { ...lot, toleranceRattachementM: 50 });
    expect(etat.requetes.find((q) => q.sql.includes("ST_Distance"))?.valeurs).toContain(50);
    for (const toleranceRattachementM of [0, -5, 5001, "50"]) {
      const r = await appeler("post", "/propositions", { ...lot, toleranceRattachementM });
      expect(r.status, String(toleranceRattachementM)).toBe(400);
    }
  });

  it("refuse un produit inconnu (404 PRODUIT_INEXISTANT), une methode vide, un lot vide, un type hors liste, des limites absentes", async () => {
    const inconnu = await appeler("post", "/propositions", { ...lot, produitId: U(999) });
    expect(inconnu.status).toBe(404); expect(inconnu.body.code).toBe("PRODUIT_INEXISTANT");
    expect((await appeler("post", "/propositions", { ...lot, methodeNom: " " })).status).toBe(400);
    expect((await appeler("post", "/propositions", { ...lot, propositions: [] })).status).toBe(400);
    expect((await appeler("post", "/propositions", { ...lot, propositions: [{ ...lot.propositions[0], type: "GLISSEMENT" }] })).status).toBe(400);
    expect((await appeler("post", "/propositions", { ...lot, propositions: [{ ...lot.propositions[0], limites: [] }] })).status).toBe(400);
    expect((await appeler("post", "/propositions", { ...lot, propositions: [{ ...lot.propositions[0], limites: undefined }] })).status).toBe(400);
  });

  it("deux dates : la reference est anterieure ; posterieure ou egale refusee (400), inconnue 404", async () => {
    const ok = await appeler("post", "/propositions", { ...lot, produitReferenceId: PREF });
    expect(ok.status).toBe(201);
    const inverse = await appeler("post", "/propositions", { ...lot, produitId: PREF, produitReferenceId: PRODUIT });
    expect(inverse.status).toBe(400); expect(inverse.body.code).toBe("REFERENCE_NON_ANTERIEURE");
    const inconnue = await appeler("post", "/propositions", { ...lot, produitReferenceId: U(998) });
    expect(inconnue.status).toBe(404); expect(inconnue.body.code).toBe("REFERENCE_INEXISTANTE");
  });

  it("une detection hors de l'emprise (refus de la base) refuse tout le lot en 400 HORS_EMPRISE, pas en 500", async () => {
    etat.erreurBase = "propositions_teledetection : la detection est hors de l'emprise du produit";
    const r = await appeler("post", "/propositions", lot);
    expect(r.status).toBe(400); expect(r.body.code).toBe("HORS_EMPRISE");
  });

  it("un refus de geometrie par la base (ST_GeomFromGeoJSON) est une entree invalide (400), une autre panne reste une erreur serveur SANS detail", async () => {
    etat.erreurBase = "ST_GeomFromGeoJSON: invalid GeoJSON representation";
    const g = await appeler("post", "/propositions", lot);
    expect(g.status).toBe(400); expect(g.body).toEqual({ error: expect.any(String), code: "ENTREE_INVALIDE" });
    etat.erreurBase = "connexion perdue vers 10.0.0.5:5432 mot de passe incorrect";
    const p = await appeler("post", "/propositions", lot);
    expect(p.status).toBe(500);
    expect(p.body).toEqual({ error: "Erreur interne du serveur", code: "ERREUR_INTERNE" });
    expect(JSON.stringify(p.body)).not.toMatch(/10\.0\.0\.5|mot de passe/);
  });

  it.each([
    ["coordinates en texte", { type: "Point", coordinates: "9.6,-13.6" }],
    ["coordinates absentes", { type: "Point" }],
    ["type de geometrie inconnu", { type: "Cercle", coordinates: [0, 0] }],
    ["GeometryCollection", { type: "GeometryCollection", geometries: [] }],
    ["polygone auto-intersecte", { type: "Polygon", coordinates: [[[0, 0], [2, 2], [2, 0], [0, 1], [0, 0]]] }],
    ["polygone ouvert", { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }],
    ["longitude 200", { type: "Point", coordinates: [200, 0] }],
    ["position en 3D", { type: "Point", coordinates: [0, 0, 12] }],
    ["NaN", { type: "Point", coordinates: [null, 0] }],
    ["ligne d'une position", { type: "LineString", coordinates: [[0, 0]] }],
  ])("hostile : %s -> 400 ENTREE_INVALIDE, jamais 500, aucune ecriture", async (_nom, geometrie) => {
    const r = await appeler("post", "/propositions", { ...lot, propositions: [{ ...lot.propositions[0], geometrie }] });
    expect(r.status).toBe(400);
    expect(r.body).toEqual(expect.objectContaining({ error: expect.any(String), code: "ENTREE_INVALIDE" }));
    expect(etat.executions).toHaveLength(0);
    expect(etat.audits).toHaveLength(0);
  });

  it.each([
    ["champ inconnu (confianceCalibree)", { propositions: [{ type: "INONDATION", geometrie: { type: "Point", coordinates: [0, 0] }, limites: ["l"], confianceCalibree: true }] }],
    ["ancienne forme (methode en une chaine)", { methodeNom: undefined, methodeVersion: undefined, methode: "seuil-sar v0" }],
    ["score 1,5", { propositions: [{ type: "INONDATION", geometrie: { type: "Point", coordinates: [0, 0] }, limites: ["l"], score: 1.5 }] }],
    ["priorite sans regle", { propositions: [{ type: "INONDATION", geometrie: { type: "Point", coordinates: [0, 0] }, limites: ["l"], priorite: { niveau: "HAUTE" } }] }],
    ["priorite inconnue", { propositions: [{ type: "INONDATION", geometrie: { type: "Point", coordinates: [0, 0] }, limites: ["l"], priorite: { niveau: "URGENTE", regle: "r" } }] }],
    ["produitId non UUID", { produitId: "p-1" }],
    ["plus de 5000 propositions", { propositions: Array.from({ length: 5001 }, () => ({ type: "INONDATION", geometrie: { type: "Point", coordinates: [0, 0] }, limites: ["l"] })) }],
  ])("schema strict : %s -> 400", async (_nom, delta) => {
    const r = await appeler("post", "/propositions", { ...lot, ...delta });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("ENTREE_INVALIDE");
    expect(etat.executions).toHaveLength(0);
  });

  it("le journal audite aussi les IDENTIFIANTS des propositions deposees, par lots de 500", async () => {
    const n = 1203;
    const gros = { ...lot, propositions: Array.from({ length: n }, () => lot.propositions[0]) };
    const r = await appeler("post", "/propositions", gros);
    expect(r.status).toBe(201);
    const lignes = etat.audits.filter((a) => (a.after as { operation?: string })?.operation === "DEPOT_LOT_IDENTIFIANTS");
    expect(lignes).toHaveLength(3);
    const ids = lignes.flatMap((a) => (a.after as { ids: string[] }).ids);
    expect(ids).toHaveLength(n);
    expect(new Set(ids)).toEqual(new Set(r.body.ids));
    expect(etat.audits.some((a) => (a.after as { nombre?: number })?.nombre === n)).toBe(true);
  });
});

// ============================================================ sources et catalogue

describe("verifier une source", () => {
  it("catalogue joignable avec un produit : PRODUIT_DISPONIBLE, jamais TRAITEMENT_OPERATIONNEL, trace en audit", async () => {
    const s = installer(reponseJson(cdse().reponse));
    const r = await appeler("post", "/sources/SENTINEL2/verifier", {});
    expect(r.status).toBe(200);
    expect(r.body.source).toMatchObject({ code: "SENTINEL2", adaptateur: "cdse-stac", etat: "PRODUIT_DISPONIBLE" });
    expect(r.body.resultat).toMatchObject({ etatAtteint: "PRODUIT_DISPONIBLE", categorieErreur: null });
    expect(etat.sources.find((x) => x.code === "SENTINEL2")).toMatchObject({ etat: "PRODUIT_DISPONIBLE" });
    expect(s.appels).toHaveLength(1);
    expect(s.appels[0].entetes.Authorization).toBeUndefined();
    expect(etat.audits.some((a) => (a.after as { operation?: string })?.operation === "VERIFIER_CONNECTIVITE")).toBe(true);
    expect(JSON.stringify(r.body)).not.toMatch(/token|secret|password/i);
  });

  it("accepte aussi le code de l'adaptateur (`cdse-stac`)", async () => {
    installer(reponseJson(cdse().reponse));
    expect((await appeler("post", "/sources/cdse-stac/verifier", {})).body.source.code).toBe("SENTINEL2");
  });

  it("catalogue joignable sans produit : ACCESSIBLE", async () => {
    installer(reponseJson(page([])));
    const r = await appeler("post", "/sources/SENTINEL2/verifier", {});
    expect(r.status).toBe(200);
    expect(r.body.source.etat).toBe("ACCESSIBLE");
  });

  it("catalogue en panne : 503 SOURCE_INDISPONIBLE ET l'etat EN_ERREUR est enregistre (pas de faux succes)", async () => {
    installer(new Response("oups", { status: 503 }));
    const r = await appeler("post", "/sources/SENTINEL2/verifier", {});
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ code: "SOURCE_INDISPONIBLE", etat: "EN_ERREUR", error: expect.any(String) });
    expect(etat.sources.find((x) => x.code === "SENTINEL2")).toMatchObject({ etat: "EN_ERREUR" });
  });

  it("facade (PlanetScope) : EN_ATTENTE_CONFIGURATION sans aucun appel reseau", async () => {
    const s = installer(reponseJson(page([])));
    const r = await appeler("post", "/sources/PLANETSCOPE/verifier", {});
    expect(r.status).toBe(200);
    expect(r.body.source.etat).toBe("EN_ATTENTE_CONFIGURATION");
    expect(s.appels).toHaveLength(0);
  });

  it("Landsat : la sonde porte sur SA collection, pas sur Sentinel-2", async () => {
    const s = installer(reponseJson(charger("earth-search-landsat-c2-l2.json").reponse));
    const r = await appeler("post", "/sources/LANDSAT89/verifier", {});
    expect(r.status).toBe(200);
    expect(s.appels[0].corps.collections).toEqual(["landsat-c2-l2"]);
    expect(s.appels[0].url).toMatch(/earth-search/);
    expect(["ACCESSIBLE", "PRODUIT_DISPONIBLE"]).toContain(r.body.source.etat);
  });

  it("source inconnue ou code mal forme : 404 INTROUVABLE ; corps non vide : 400", async () => {
    expect((await appeler("post", "/sources/INCONNUE/verifier", {})).status).toBe(404);
    expect((await appeler("post", "/sources/a%20b/verifier", {})).status).toBe(404);
    expect((await appeler("post", "/sources/SENTINEL2/verifier", { force: true })).status).toBe(400);
  });

  it("au plus 6 verifications par minute et par source : la septieme est refusee (429 LIMITE_ATTEINTE)", async () => {
    installer(reponseJson(cdse().reponse));
    for (let i = 0; i < 6; i++) expect((await appeler("post", "/sources/SENTINEL2/verifier", {})).status).toBe(200);
    const r = await appeler("post", "/sources/SENTINEL2/verifier", {});
    expect(r.status).toBe(429);
    expect(r.body.code).toBe("LIMITE_ATTEINTE");
  });
});

describe("synchroniser le catalogue", () => {
  const demande = (extra: Record<string, unknown> = {}) => ({ bbox: [-14.39, 10.83, -14.19, 11.03], depuis: jours(-30), jusqua: jours(0), nuagesMax: 50, ...extra });
  const pages = () => { const f = cdse(); return [reponseJson(f.reponse), reponseJson(f.suite!.reponse), reponseJson(page([]))] as const; };
  const idsFixture = () => { const f = cdse(); return [...f.reponse.features, ...f.suite!.reponse.features].map((x: { id: string }) => x.id); };

  it("rapport {trouves, nouveaux, dejaConnus, ecartes} ; produits enregistres sans doublon ; audit de la synchro", async () => {
    installer(...pages());
    const r = await appeler("post", "/sources/SENTINEL2/synchroniser-catalogue", demande(), "u-gest");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ trouves: 4, nouveaux: 4, dejaConnus: 0, ecartes: {}, complet: true, source: { code: "SENTINEL2", adaptateur: "cdse-stac" } });
    expect(etat.produits.filter((p) => String(p.code).startsWith("CDSE:"))).toHaveLength(4);
    const synchro = etat.audits.find((a) => (a.after as { operation?: string })?.operation === "SYNCHRONISER_CATALOGUE");
    expect(synchro?.after).toMatchObject({ trouves: 4, nouveaux: 4, adaptateur: "cdse-stac", nuagesMax: 50 });
    const insertion = etat.executions.find((e) => e.sql.includes("ON CONFLICT"))!;
    expect(insertion.valeurs).toEqual(expect.arrayContaining(["CDSE", "SENTINEL2", "CATALOGUE"]));
  });

  it("deuxieme appel : tout est deja connu (deduplication par identifiant fournisseur)", async () => {
    installer(...pages());
    for (const id of idsFixture()) etat.idsProduitsConnus.add(id);
    const r = await appeler("post", "/sources/SENTINEL2/synchroniser-catalogue", demande(), "u-gest");
    expect(r.body).toMatchObject({ trouves: 4, nouveaux: 0, dejaConnus: 4 });
  });

  it("ecarte (sans les enregistrer) les produits sans emprise valide ou sans couverture nuageuse, et les compte par raison", async () => {
    const bon = itemCdseReel();
    installer(reponseJson(page([bon, sansNuages(variante(bon, "S2C_MSIL2A_X1", "2026-10-20T00:00:00Z")), empriseHorsGlobe(variante(bon, "S2C_MSIL2A_X2", "2026-10-19T00:00:00Z"))])), reponseJson(page([])));
    const r = await appeler("post", "/sources/SENTINEL2/synchroniser-catalogue", demande());
    expect(r.status).toBe(200);
    const somme = Object.values(r.body.ecartes as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(r.body.nouveaux).toBe(1);
    expect(r.body.trouves).toBe(r.body.nouveaux + r.body.dejaConnus + somme);
    expect(r.body.ecartes).toMatchObject({ NUAGES_REQUIS: 1 });
    expect(Object.keys(r.body.ecartes).some((k) => k.startsWith("PRODUIT_ECARTE_"))).toBe(true);
    expect(etat.produits.filter((p) => String(p.code).startsWith("CDSE:"))).toHaveLength(1);
  });

  it("une recherche arretee par un plafond le dit (complet: false), jamais une liste tronquee presentee comme complete", async () => {
    const f = cdse();
    installer(reponseJson(f.reponse), reponseJson(f.suite!.reponse)); // la derniere etape se repete : toujours un lien « next »
    const r = await appeler("post", "/sources/SENTINEL2/synchroniser-catalogue", demande());
    expect(r.body.complet).toBe(false);
    expect(r.body.pagination.raisonArret).toBe("PLAFOND_PAGES");
  });

  it("catalogue en panne : 503 SOURCE_INDISPONIBLE, rien n'est enregistre", async () => {
    installer(new Response("oups", { status: 502 }));
    const r = await appeler("post", "/sources/SENTINEL2/synchroniser-catalogue", demande());
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("SOURCE_INDISPONIBLE");
    expect(etat.executions).toHaveLength(0);
  });

  it("facade : 409 SOURCE_NON_CONFIGUREE sans reseau", async () => {
    const s = installer(reponseJson(page([])));
    const r = await appeler("post", "/sources/PLANETSCOPE/synchroniser-catalogue", demande());
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("SOURCE_NON_CONFIGUREE");
    expect(s.appels).toHaveLength(0);
  });

  it.each([
    ["bbox trop grande", { bbox: [-16, 8, -10, 12] }], ["bbox inversee", { bbox: [-14.19, 10.83, -14.39, 11.03] }], ["bbox absente", { bbox: undefined }],
    ["bbox texte", { bbox: "ici" }], ["corridorId (non pris en charge)", { bbox: undefined, corridorId: U(5) }], ["fenetre de 200 jours", { depuis: jours(-200) }],
    ["depuis apres jusqua", { depuis: jours(0), jusqua: jours(-30) }], ["jusqua en 2999", { jusqua: "2999-01-01" }], ["depuis en 1999", { depuis: "1999-01-01" }],
    ["nuagesMax absent", { nuagesMax: undefined }], ["nuagesMax 150", { nuagesMax: 150 }], ["nuagesMax texte", { nuagesMax: "50" }], ["champ inconnu", { limite: 5000 }],
  ])("hostile : %s -> 400, aucun appel reseau, aucune ecriture", async (_nom, delta) => {
    const s = installer(reponseJson(page([])));
    const r = await appeler("post", "/sources/SENTINEL2/synchroniser-catalogue", demande(delta));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("ENTREE_INVALIDE");
    expect(s.appels).toHaveLength(0);
    expect(etat.executions).toHaveLength(0);
  });
});

// ============================================================ apercu

describe("apercu d'un produit (lu cote serveur)", () => {
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const catalogue = (extra: Record<string, unknown> = {}) => {
    const item = cdse().reponse.features[0];
    etat.produits.push({ id: U(70), code: "C", synthetique: false, sourceCode: "SENTINEL2", fournisseur: "CDSE", identifiantFournisseur: item.id, collection: "sentinel-2-l2a", cycleVie: "CATALOGUE", ...extra });
    return item;
  };
  const image = (corps: Buffer | string, type = "image/jpeg", statut = 200) => new Response(corps, { status: statut, headers: { "content-type": type } });

  it("sert l'image lue par le serveur, avec des en-tetes prudents, sans adresse ni cle du fournisseur", async () => {
    const item = catalogue();
    installer(reponseJson(item));
    const appelsImage: string[] = [];
    _installerSources({ fetchApercu: async (url) => { appelsImage.push(url); return image(PNG); } });
    const r = await appeler("get", `/produits/${U(70)}/apercu`, undefined, "u-lecteur");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("image/jpeg");
    expect(r.headers["cache-control"]).toBe("private, max-age=300");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.from(r.body).equals(PNG)).toBe(true);
    expect(appelsImage).toHaveLength(1);
    expect(appelsImage[0]).toMatch(/^https:\/\/datahub\.creodias\.eu\//);
    expect(JSON.stringify(r.headers)).not.toMatch(/creodias/);
  });

  it("echec du fournisseur, absence, type non image : 404 APERCU_INDISPONIBLE, jamais d'image de remplacement ni d'adresse", async () => {
    const item = catalogue();
    for (const reponse of [image("", "image/jpeg", 404), image("<html>", "text/html"), image("", "image/jpeg", 200), image(PNG, "image/jpeg", 503)]) {
      installer(reponseJson(item));
      _installerSources({ fetchApercu: async () => reponse.clone() });
      const r = await appeler("get", `/produits/${U(70)}/apercu`);
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ error: expect.stringContaining("Apercu indisponible"), code: "APERCU_INDISPONIBLE" });
      expect(JSON.stringify(r.body)).not.toMatch(/https?:/);
    }
  });

  it("le fournisseur du catalogue repond 404 ou tombe : 404 APERCU_INDISPONIBLE", async () => {
    catalogue();
    installer(new Response("{}", { status: 404 }));
    expect((await appeler("get", `/produits/${U(70)}/apercu`)).body.code).toBe("APERCU_INDISPONIBLE");
    installer(new Response("oups", { status: 503 }));
    expect((await appeler("get", `/produits/${U(70)}/apercu`)).body.code).toBe("APERCU_INDISPONIBLE");
  });

  it("donnee synthetique, produit sans reference de catalogue, produit inconnu, identifiant mal forme, source facade : 404 APERCU_INDISPONIBLE", async () => {
    etat.produits.push({ id: U(71), code: "S", synthetique: true, sourceCode: "SENTINEL2", fournisseur: "CDSE", identifiantFournisseur: "x", collection: "sentinel-2-l2a", cycleVie: "CATALOGUE" });
    etat.produits.push({ id: U(72), code: "M", synthetique: false, sourceCode: null, fournisseur: null, identifiantFournisseur: null, collection: null, cycleVie: "CATALOGUE" });
    etat.produits.push({ id: U(73), code: "F", synthetique: false, sourceCode: "PLANETSCOPE", fournisseur: "PLANET", identifiantFournisseur: "x", collection: "c", cycleVie: "CATALOGUE" });
    for (const id of [U(71), U(72), U(73), U(999), "pas-un-uuid"]) {
      const r = await appeler("get", `/produits/${id}/apercu`);
      expect(r.status, id).toBe(404);
      expect(r.body.code).toBe("APERCU_INDISPONIBLE");
    }
  });

  it("le fetch de la vignette n'atteint jamais un hote hors liste (SSRF) : adresses IP, http, hotes etrangers refuses", () => {
    expect(hoteAdmis("https://datahub.creodias.eu/odata/v1/Assets(x)/$value")).toBe(true);
    expect(hoteAdmis("https://sentinel-cogs.s3.us-west-2.amazonaws.com/a/b.jpg")).toBe(true);
    for (const u of ["http://datahub.creodias.eu/x", "https://169.254.169.254/latest/meta-data", "https://localhost/x", "https://[::1]/x", "https://evil.example/creodias.eu", "https://creodias.eu.evil.example/x", "https://u:p@datahub.creodias.eu/x", "ftp://datahub.creodias.eu/x", "n'importe quoi"]) {
      expect(hoteAdmis(u), u).toBe(false);
    }
  });

  it("suit au plus deux redirections, vers des hotes admis seulement", async () => {
    const item = catalogue();
    installer(reponseJson(item));
    const vus: string[] = [];
    _installerSources({
      fetchApercu: async (url) => {
        vus.push(url);
        if (vus.length === 1) return new Response(null, { status: 301, headers: { location: "https://zipper.creodias.eu/odata/v1/Assets(1)/$value" } });
        return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/" } });
      },
    });
    const r = await appeler("get", `/produits/${U(70)}/apercu`);
    expect(r.status).toBe(404);
    expect(vus).toEqual([expect.stringContaining("datahub.creodias.eu"), "https://zipper.creodias.eu/odata/v1/Assets(1)/$value"]);
  });
});
