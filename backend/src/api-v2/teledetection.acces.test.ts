import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

/**
 * `/api/v2/teledetection` -- MATRICE D'ACCES. Ce que ces tests defendent :
 *   - les VRAIES gardes tournent (`requireAuth`, `requireModuleAccess`, `requireRole`) ; seule la base (`lib/prisma`) est simulee ;
 *   - anonyme, jeton forge, compte sans le module, LECTEUR, INSPECTEUR, GESTIONNAIRE national, GESTIONNAIRE regional (dans et hors
 *     perimetre), ADMIN : chacun x chaque route, avec le statut ET le `code` du contrat ;
 *   - une proposition hors perimetre et une proposition inexistante donnent la MEME reponse, y compris avec un corps invalide ;
 *   - un refus ne laisse aucune trace d'ecriture (ni audit, ni insertion).
 * Ce que la base simulee ne prouve pas (PostGIS, declencheurs) est eprouve par tests-integration/eo-api.integration.ts.
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
import { _installerSources } from "../teledetection/sources.service";
import { creerAdaptateurs } from "../teledetection/sources";
import { charger, fetchScenario, reponseJson } from "../teledetection/sources/essais.support";

const app = express();
app.use(express.json());
app.use("/api/v2/teledetection", teledetectionV2Router);
app.use(errorHandler);
const BASE = "/api/v2/teledetection";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P1 = U(1), P2 = U(2), PNR = U(3), INCONNU = U(99), OBS = U(50), OBS_AUTRE = U(51), MISSION = U(70), PRODUIT = U(60);

const jeton = (id: string) => {
  const c = etat.comptes.get(id)!;
  return signAccessToken({ sub: c.id, role: c.role as never, email: c.email });
};
type Methode = "get" | "post";
const appeler = (methode: Methode, chemin: string, compte?: string, corps?: unknown) => {
  let r = request(app)[methode](`${BASE}${chemin}`);
  if (compte) r = r.set("Authorization", `Bearer ${jeton(compte)}`);
  return methode === "post" ? r.send((corps ?? {}) as object) : r;
};

const jours = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const emprise = { type: "Polygon", coordinates: [[[-13.7, 9.5], [-13.4, 9.5], [-13.4, 9.8], [-13.7, 9.8], [-13.7, 9.5]]] };
const corpsProduit = {
  code: "S2-ESSAI", palier: 0, source: "Sentinel-2 L2A", nature: "OPTIQUE", dateAcquisition: "2026-10-01", resolutionM: 10, couvertureNuagesPct: 12,
  incertitude: "+/- 1 pixel", provenance: "scene-id", licence: "relevee a la source", versionTraitement: "v0", emprise,
};
const corpsLot = {
  produitId: PRODUIT, methodeNom: "seuil-sar", methodeVersion: "v0",
  propositions: [{ type: "INONDATION", geometrie: { type: "Point", coordinates: [-13.6, 9.64] }, score: 0.7, limites: ["Resolution native 10 m"] }],
};
const corpsSynchro = { bbox: [-14.39, 10.83, -14.19, 11.03], depuis: jours(-30), jusqua: jours(0), nuagesMax: 50 };
const corpsTransition = { vers: "EN_ATTENTE", motif: "Information demandee a l'equipe", motifAttente: "AUTRE" };

beforeEach(() => {
  reinitialiser();
  ajouterCompte({ id: "u-lecteur", role: "LECTEUR" });
  ajouterCompte({ id: "u-inspecteur", role: "INSPECTEUR" });
  ajouterCompte({ id: "u-gest", role: "GESTIONNAIRE" });
  ajouterCompte({ id: "u-gest-r1", role: "GESTIONNAIRE", regions: [1] });
  ajouterCompte({ id: "u-admin", role: "ADMIN", modulesAutorises: [] });
  ajouterCompte({ id: "u-sans-module", role: "GESTIONNAIRE", modulesAutorises: ["troncons"] });
  etat.propositions.push(
    { id: P1, statut: "A_VERIFIER", regionId: 1, missionId: null, type: "INONDATION" },
    { id: P2, statut: "A_VERIFIER", regionId: 2, missionId: null, type: "INONDATION" },
    { id: PNR, statut: "A_VERIFIER", regionId: null, missionId: null, type: "INONDATION" },
  );
  etat.lignesDetail.push(ligneProposition(P1, { regionId: 1 }), ligneProposition(P2, { regionId: 2 }), ligneProposition(PNR));
  etat.observations.push({ id: OBS, agentId: "u-inspecteur" }, { id: OBS_AUTRE, agentId: "u-gest" });
  etat.produits.push({ id: PRODUIT, code: "P", synthetique: false, dateAcquisition: new Date("2026-10-02") });
  etat.sources.push(
    { id: "s-1", code: "SENTINEL2", etat: "NON_CONFIGUREE", requiertIdentifiants: false },
    { id: "s-2", code: "PLANETSCOPE", etat: "EN_ATTENTE_CONFIGURATION", requiertIdentifiants: true },
  );
  const cdse = charger("cdse-stac-s2-l2a.json");
  _installerSources({
    adaptateurs: creerAdaptateurs({ fetch: fetchScenario(reponseJson(cdse.reponse)).fetch, sleep: async () => undefined }),
    fetchApercu: async () => { throw new Error("aucun appel reseau attendu"); },
    maintenant: null,
  });
});

interface Route { nom: string; methode: Methode; chemin: string; corps?: unknown; autorises: string[] }
const TOUS = ["LECTEUR", "INSPECTEUR", "GESTIONNAIRE", "ADMIN"];
const DECIDEURS = ["GESTIONNAIRE", "ADMIN"];
const COMPTE_DU_ROLE: Record<string, string> = { LECTEUR: "u-lecteur", INSPECTEUR: "u-inspecteur", GESTIONNAIRE: "u-gest", ADMIN: "u-admin" };

const ROUTES: Route[] = [
  { nom: "GET /synthese", methode: "get", chemin: "/synthese", autorises: TOUS },
  { nom: "GET /propositions", methode: "get", chemin: "/propositions", autorises: TOUS },
  { nom: "GET /propositions.geojson", methode: "get", chemin: "/propositions.geojson?bbox=-13.7,9.5,-13.4,9.8", autorises: TOUS },
  { nom: "GET /propositions/:id", methode: "get", chemin: `/propositions/${P1}`, autorises: TOUS },
  { nom: "GET /produits", methode: "get", chemin: "/produits", autorises: TOUS },
  { nom: "GET /produits/:id/apercu", methode: "get", chemin: `/produits/${PRODUIT}/apercu`, autorises: TOUS },
  { nom: "GET /sources", methode: "get", chemin: "/sources", autorises: TOUS },
  { nom: "GET /precision", methode: "get", chemin: "/precision", autorises: TOUS },
  { nom: "GET /qualite-methodes", methode: "get", chemin: "/qualite-methodes", autorises: TOUS },
  { nom: "POST /propositions/:id/transition", methode: "post", chemin: `/propositions/${P1}/transition`, corps: corpsTransition, autorises: DECIDEURS },
  { nom: "POST /propositions/:id/verification", methode: "post", chemin: `/propositions/${P1}/verification`, corps: {}, autorises: DECIDEURS },
  { nom: "POST /propositions/:id/preuves", methode: "post", chemin: `/propositions/${P1}/preuves`, corps: { observationIds: [OBS_AUTRE] }, autorises: ["INSPECTEUR", ...DECIDEURS] },
  { nom: "POST /sources/:code/verifier", methode: "post", chemin: "/sources/SENTINEL2/verifier", corps: {}, autorises: ["ADMIN"] },
  { nom: "POST /sources/:code/synchroniser-catalogue", methode: "post", chemin: "/sources/SENTINEL2/synchroniser-catalogue", corps: corpsSynchro, autorises: DECIDEURS },
  { nom: "POST /produits", methode: "post", chemin: "/produits", corps: corpsProduit, autorises: DECIDEURS },
  { nom: "POST /propositions", methode: "post", chemin: "/propositions", corps: corpsLot, autorises: DECIDEURS },
];

describe("sans compte valide", () => {
  it.each(ROUTES)("$nom : anonyme -> 401 { error, code }", async (r) => {
    const rep = await appeler(r.methode, r.chemin, undefined, r.corps);
    expect(rep.status).toBe(401);
    expect(rep.body).toEqual({ error: expect.any(String), code: "NON_AUTHENTIFIE" });
    expect(etat.audits).toHaveLength(0);
  });

  it.each(ROUTES)("$nom : jeton forge (autre secret, role ADMIN) -> 401", async (r) => {
    const forge = jwt.sign({ sub: "u-admin", role: "ADMIN", email: "x@y.z" }, "un-autre-secret-un-autre-secret-123456");
    const rep = await request(app)[r.methode](`${BASE}${r.chemin}`).set("Authorization", `Bearer ${forge}`).send((r.corps ?? {}) as object);
    expect(rep.status).toBe(401);
    // l'arbre principal (resolveur de compte) rend JETON_INVALIDE pour un jeton illisible ; le worktree complete avec NON_AUTHENTIFIE
    expect(["NON_AUTHENTIFIE", "JETON_INVALIDE"]).toContain(rep.body.code);
    expect(etat.audits).toHaveLength(0);
  });

  it("jeton absurde, schema Basic, jeton vide : 401", async () => {
    for (const h of ["Bearer n-importe-quoi", "Basic dXNlcjpwdw==", "Bearer ", "bearer x"]) {
      const rep = await request(app).get(`${BASE}/sources`).set("Authorization", h);
      expect(rep.status, h).toBe(401);
    }
  });

  it("un jeton valide d'un compte qui n'existe plus n'obtient rien : 403 sans module (garde de module) ou 401 COMPTE_INACTIF (resolveur de compte)", async () => {
    ajouterCompte({ id: "u-fantome", role: "GESTIONNAIRE" });
    const t = jeton("u-fantome");
    etat.comptes.delete("u-fantome");
    const rep = await request(app).get(`${BASE}/sources`).set("Authorization", `Bearer ${t}`);
    expect([401, 403]).toContain(rep.status);
    expect(["MODULE_NON_AUTORISE", "COMPTE_INACTIF"]).toContain(rep.body.code);
  });

  it.each(ROUTES)("$nom : compte sans la cle `teledetection` -> 403 MODULE_NON_AUTORISE, aucune ecriture", async (r) => {
    const rep = await appeler(r.methode, r.chemin, "u-sans-module", r.corps);
    expect(rep.status).toBe(403);
    expect(rep.body).toEqual({ error: expect.any(String), code: "MODULE_NON_AUTORISE" });
    expect(etat.audits).toHaveLength(0);
    expect(etat.executions).toHaveLength(0);
  });

  it("un LECTEUR dont la liste de modules est vide n'a acces a rien (le vide n'est pas « tout »)", async () => {
    ajouterCompte({ id: "u-vide", role: "LECTEUR", modulesAutorises: [] });
    expect((await appeler("get", "/sources", "u-vide")).status).toBe(403);
  });
});

describe("matrice role x route", () => {
  for (const r of ROUTES) {
    for (const role of TOUS) {
      const autorise = r.autorises.includes(role);
      it(`${r.nom} : ${role} -> ${autorise ? "admis" : "403 ROLE_INSUFFISANT"}`, async () => {
        // l'inspecteur n'a de droit sur les preuves que pour une mission qui lui est affectee
        if (role === "INSPECTEUR" && r.nom.includes("preuves")) {
          etat.missions.push({ id: MISSION, assigneId: "u-inspecteur" });
          etat.propositions[0].missionId = MISSION;
        }
        const corps = role === "INSPECTEUR" && r.nom.includes("preuves") ? { observationIds: [OBS] } : r.corps;
        const rep = await appeler(r.methode, r.chemin, COMPTE_DU_ROLE[role], corps);
        if (autorise) {
          expect([401, 403], `${rep.status} ${JSON.stringify(rep.body)}`).not.toContain(rep.status);
          expect(rep.status).toBeLessThan(500);
        } else {
          expect(rep.status).toBe(403);
          expect(rep.body).toEqual({ error: expect.any(String), code: "ROLE_INSUFFISANT" });
          expect(etat.audits).toHaveLength(0);
          expect(etat.executions).toHaveLength(0);
        }
      });
    }
  }
});

describe("ordre des gardes : le role est verifie AVANT la ressource et AVANT le corps", () => {
  it("un LECTEUR n'apprend rien d'une proposition inexistante : 403, pas 404", async () => {
    const rep = await appeler("post", `/propositions/${INCONNU}/transition`, "u-lecteur", { n: "importe quoi" });
    expect(rep.status).toBe(403);
    expect(rep.body.code).toBe("ROLE_INSUFFISANT");
  });
});

describe("perimetre territorial : l'oracle d'existence est ferme", () => {
  it("compte regional : sa proposition 200 ; autre region, non rattachee, inexistante, id mal forme : le MEME 404", async () => {
    expect((await appeler("get", `/propositions/${P1}`, "u-gest-r1")).status).toBe(200);
    const reponses = [];
    for (const id of [P2, PNR, INCONNU, "pas-un-uuid", "1; DROP TABLE x", `${P1}x`]) reponses.push(await appeler("get", `/propositions/${encodeURIComponent(id)}`, "u-gest-r1"));
    for (const r of reponses) { expect(r.status).toBe(404); expect(r.body).toEqual({ error: "Ressource introuvable", code: "INTROUVABLE" }); }
  });

  it("MEME avec un corps invalide : 404 identique (hors perimetre = inexistant), et 400 seulement dans le perimetre", async () => {
    const invalides = [{ vers: "N_IMPORTE_QUOI" }, {}, { vers: "EN_ATTENTE", motif: "" }, "texte", null, { vers: "A_VERIFIER", motif: "x", intrus: 1 }];
    for (const corps of invalides) {
      const horsPerimetre = await appeler("post", `/propositions/${P2}/transition`, "u-gest-r1", corps);
      const inexistant = await appeler("post", `/propositions/${INCONNU}/transition`, "u-gest-r1", corps);
      const nonRattachee = await appeler("post", `/propositions/${PNR}/transition`, "u-gest-r1", corps);
      expect(horsPerimetre.status).toBe(404);
      expect(horsPerimetre.body).toEqual(inexistant.body);
      expect(nonRattachee.body).toEqual(inexistant.body);
      expect((await appeler("post", `/propositions/${P1}/transition`, "u-gest-r1", corps)).status).toBe(400);
    }
    expect(etat.audits).toHaveLength(0);
  });

  it("verification et preuves : meme 404 hors perimetre ou inexistant", async () => {
    for (const [chemin, corps] of [["verification", { n: 1 }], ["preuves", { observationIds: "x" }]] as const) {
      const a = await appeler("post", `/propositions/${P2}/${chemin}`, "u-gest-r1", corps);
      const b = await appeler("post", `/propositions/${INCONNU}/${chemin}`, "u-gest-r1", corps);
      expect(a.status).toBe(404);
      expect(a.body).toEqual(b.body);
    }
  });

  it("compte national : voit tout, y compris les propositions non rattachees ; l'inexistante donne le meme 404", async () => {
    expect((await appeler("get", `/propositions/${PNR}`, "u-gest")).status).toBe(200);
    expect((await appeler("get", `/propositions/${P2}`, "u-gest")).status).toBe(200);
    const r = await appeler("get", `/propositions/${INCONNU}`, "u-gest");
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "Ressource introuvable", code: "INTROUVABLE" });
  });

  it("la clause de region est dans les requetes de liste d'un compte regional, pas dans celles d'un national", async () => {
    await appeler("get", "/propositions", "u-gest-r1");
    const regional = etat.requetes.filter((q) => q.sql.includes("ORDER BY p.\"dateAcquisition\" DESC"));
    expect(regional.at(-1)?.sql).toContain('pt."regionId" = ANY(');
    expect(regional.at(-1)?.valeurs).toContainEqual([1]);
    etat.requetes.length = 0;
    await appeler("get", "/propositions", "u-gest");
    const national = etat.requetes.filter((q) => q.sql.includes("ORDER BY p.\"dateAcquisition\" DESC"));
    expect(national.at(-1)?.sql).not.toContain('pt."regionId" = ANY(');
    // GeoJSON aussi
    etat.requetes.length = 0;
    await appeler("get", "/propositions.geojson?bbox=-13.7,9.5,-13.4,9.8", "u-gest-r1");
    expect(etat.requetes.some((q) => q.sql.includes("ST_AsGeoJSON") && q.sql.includes('pt."regionId" = ANY('))).toBe(true);
  });

  it("un compte regional qui filtre sur une AUTRE region : 403 HORS_PERIMETRE (liste et synthese)", async () => {
    for (const chemin of ["/propositions?regionId=2", "/synthese?regionId=2"]) {
      const r = await appeler("get", chemin, "u-gest-r1");
      expect(r.status, chemin).toBe(403);
      expect(r.body.code).toBe("HORS_PERIMETRE");
    }
    expect((await appeler("get", "/propositions?regionId=1", "u-gest-r1")).status).toBe(200);
    expect((await appeler("get", "/synthese?regionId=1", "u-gest-r1")).status).toBe(200);
  });

  it("depot de lot, de produit et synchronisation du catalogue : operations NATIONALES, refusees a un compte regional", async () => {
    for (const [chemin, corps] of [["/produits", corpsProduit], ["/propositions", corpsLot], ["/sources/SENTINEL2/synchroniser-catalogue", corpsSynchro]] as const) {
      const r = await appeler("post", chemin, "u-gest-r1", corps);
      expect(r.status, chemin).toBe(403);
      expect(r.body.code).toBe("HORS_PERIMETRE");
    }
    expect(etat.executions).toHaveLength(0);
    expect(etat.audits).toHaveLength(0);
  });

  it("une transition sur sa propre proposition passe le perimetre et appelle le service avec le perimetre du compte", async () => {
    const r = await appeler("post", `/propositions/${P1}/transition`, "u-gest-r1", corpsTransition);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: P1, de: "A_VERIFIER", vers: "EN_ATTENTE" });
    expect(etat.audits.at(-1)).toMatchObject({ entityType: "PropositionTeledetection", userId: "u-gest-r1" });
  });
});

describe("INSPECTEUR : lecture + preuves de terrain sur sa mission, sans decider", () => {
  it("ne decide pas : transition et mission refusees", async () => {
    expect((await appeler("post", `/propositions/${P1}/transition`, "u-inspecteur", corpsTransition)).body.code).toBe("ROLE_INSUFFISANT");
    expect((await appeler("post", `/propositions/${P1}/verification`, "u-inspecteur", {})).body.code).toBe("ROLE_INSUFFISANT");
  });

  it("preuves : refusees sans mission, ou si la mission est celle d'un autre", async () => {
    const sans = await appeler("post", `/propositions/${P1}/preuves`, "u-inspecteur", { observationIds: [OBS] });
    expect(sans.status).toBe(403);
    expect(sans.body.code).toBe("MISSION_NON_AFFECTEE");
    etat.missions.push({ id: MISSION, assigneId: "u-autre-agent" });
    etat.propositions[0].missionId = MISSION;
    const autre = await appeler("post", `/propositions/${P1}/preuves`, "u-inspecteur", { observationIds: [OBS] });
    expect(autre.body.code).toBe("MISSION_NON_AFFECTEE");
    expect(etat.preuves).toHaveLength(0);
  });

  it("preuves : acceptees sur sa mission pour SES observations ; refusees pour celles d'un autre", async () => {
    etat.missions.push({ id: MISSION, assigneId: "u-inspecteur" });
    etat.propositions[0].missionId = MISSION;
    const autrui = await appeler("post", `/propositions/${P1}/preuves`, "u-inspecteur", { observationIds: [OBS_AUTRE] });
    expect(autrui.status).toBe(403);
    expect(autrui.body.code).toBe("OBSERVATION_NON_AUTEUR");
    const ok = await appeler("post", `/propositions/${P1}/preuves`, "u-inspecteur", { observationIds: [OBS] });
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ ajoutees: 1, dejaCitees: 0 });
    expect(etat.audits.at(-1)).toMatchObject({ entityType: "PropositionTeledetectionPreuve", userId: "u-inspecteur" });
  });

  it("hors perimetre regional, meme avec une mission affectee : 404", async () => {
    ajouterCompte({ id: "u-insp-r2", role: "INSPECTEUR", regions: [2] });
    etat.missions.push({ id: MISSION, assigneId: "u-insp-r2" });
    etat.propositions[0].missionId = MISSION;
    expect((await appeler("post", `/propositions/${P1}/preuves`, "u-insp-r2", { observationIds: [OBS] })).status).toBe(404);
  });
});
