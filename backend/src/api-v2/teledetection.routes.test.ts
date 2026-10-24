import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `/api/v2/teledetection` -- ce que ces tests defendent.
 *   - ecrire : ADMIN et GESTIONNAIRE ; lire : tout compte authentifie ;
 *   - un produit sans licence, ou d'un palier payant sans autorisation de depense, est refuse ;
 *   - sans tolerance donnee, aucune proposition n'est rattachee (la tolerance part en parametre lie) ;
 *   - le terrain juge une fois, en citant son constat ; l'audit dit VALIDATE ou REJECT ;
 *   - une mission de verification se depeche une seule fois.
 * Les invariants tenus en base (figement, unicite du verdict, precision) sont eprouves par le
 * banc `observation_terre.test.sql`.
 */

const compte = { id: "u-gest", role: "GESTIONNAIRE" };
vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: compte.id, role: compte.role }; n();
  },
}));

type Ligne = Record<string, unknown>;
const h = vi.hoisted(() => ({ produits: [] as Ligne[], propositions: [] as Ligne[], missions: [] as Ligne[], audits: [] as Ligne[], raw: [] as unknown[][], erreurBase: null as string | null, lignesCoherence: [] as Ligne[] }));

vi.mock("../lib/prisma", () => {
  const earthObservationProduct = {
    findUnique: async ({ where }: { where: { code?: string; id?: string } }) => h.produits.find((p) => (where.code ? p.code === where.code : p.id === where.id)) ?? null,
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => ({ id: where.id }),
    findFirst: async ({ where }: { where: { id: string } }) => h.produits.find((p) => p.id === where.id) ?? null,
    findMany: async () => h.produits,
  };
  const propositionTeledetection = {
    findUnique: async ({ where }: { where: { id: string } }) => h.propositions.find((p) => p.id === where.id) ?? null,
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => h.propositions.find((p) => p.id === where.id),
    findMany: async () => h.propositions,
    count: async () => 0,
    updateMany: async ({ where, data }: { where: { id: string; statut: string }; data: Ligne }) => {
      const p = h.propositions.find((x) => x.id === where.id && x.statut === where.statut);
      if (!p) return { count: 0 };
      Object.assign(p, data); return { count: 1 };
    },
    update: async ({ where, data }: { where: { id: string }; data: Ligne }) => { const p = h.propositions.find((x) => x.id === where.id)!; Object.assign(p, data); return p; },
  };
  const mission = {
    findMany: async () => h.missions.map((m) => ({ code: m.code })),
    create: async ({ data }: { data: Ligne }) => { const m = { id: `m-${h.missions.length + 1}`, statut: "BROUILLON", ...data }; h.missions.push(m); return m; },
  };
  const auditLog = { create: async ({ data }: { data: Ligne }) => { h.audits.push(data); return data; } };
  const tx = {
    earthObservationProduct, propositionTeledetection, mission, auditLog,
    $executeRaw: async (...a: unknown[]) => { if (h.erreurBase) throw new Error(h.erreurBase); h.raw.push(a); return 1; },
    $queryRaw: async (sql: TemplateStringsArray) => (sql.join("?").includes("coherence_teledetection") ? h.lignesCoherence : []),
  };
  return { prisma: { ...tx, $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } };
});

import { teledetectionV2Router } from "./teledetection.routes";

const app = express();
app.use(express.json());
app.use("/api/v2/teledetection", teledetectionV2Router);
app.use((err: Error, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: err.message }); });
const base = "/api/v2/teledetection";

const emprise = { type: "Polygon", coordinates: [[[-13.7, 9.5], [-13.4, 9.5], [-13.4, 9.8], [-13.7, 9.8], [-13.7, 9.5]]] };
const produit = {
  code: "S2-20261001", palier: 0, source: "Sentinel-2 L2A", nature: "OPTIQUE", dateAcquisition: "2026-10-01", resolutionM: 10,
  couvertureNuagesPct: 12, incertitude: "+/- 1 pixel", provenance: "scene-id", licence: "relevee a la source", versionTraitement: "v0", emprise,
};

beforeEach(() => {
  h.produits.length = 0; h.propositions.length = 0; h.missions.length = 0; h.audits.length = 0; h.raw.length = 0; h.erreurBase = null;
  compte.role = "GESTIONNAIRE";
});

describe("Registre des produits", () => {
  it("enregistre un produit complet, en une insertion parametree, auditee", async () => {
    const r = await request(app).post(`${base}/produits`).send(produit);
    expect(r.status).toBe(201);
    const sql = (h.raw[0][0] as string[]).join("?");
    expect(sql).toContain('INSERT INTO "earth_observation_products"');
    expect(sql).toContain("ST_GeomFromGeoJSON(");
    expect(h.audits).toEqual([expect.objectContaining({ action: "CREATE", entityType: "EarthObservationProduct" })]);
  });
  it("refuse sans licence, sans autorisation de depense pour un palier payant, sans emprise polygonale", async () => {
    const l = await request(app).post(`${base}/produits`).send({ ...produit, licence: " " });
    expect(l.status).toBe(400); expect(l.body.code).toBe("CHAMP_MANQUANT");
    const d = await request(app).post(`${base}/produits`).send({ ...produit, palier: 1 });
    expect(d.status).toBe(400); expect(d.body.code).toBe("DEPENSE_NON_AUTORISEE");
    const e = await request(app).post(`${base}/produits`).send({ ...produit, emprise: { type: "Point", coordinates: [0, 0] } });
    expect(e.status).toBe(400); expect(e.body.code).toBe("EMPRISE_INVALIDE");
    expect(h.raw).toHaveLength(0);
  });
  it("un LECTEUR lit le registre mais n'ecrit rien", async () => {
    compte.role = "LECTEUR";
    expect((await request(app).get(`${base}/produits`)).status).toBe(200);
    expect((await request(app).post(`${base}/produits`).send(produit)).status).toBe(403);
    expect((await request(app).post(`${base}/propositions`).send({})).status).toBe(403);
  });
});

describe("Depot de propositions", () => {
  beforeEach(() => { h.produits.push({ id: "p-1", code: "S1" }); });
  const lot = { produitId: "p-1", methode: "seuil-sar v0", propositions: [{ type: "INONDATION", geometrie: { type: "Point", coordinates: [-13.6, 9.64] }, score: 0.7 }] };

  it("sans tolerance : la tolerance part nulle, rien n'est suppose", async () => {
    const r = await request(app).post(`${base}/propositions`).send(lot);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ deposees: 1, toleranceRattachementM: null });
    const valeurs = h.raw[0].slice(1);
    expect(valeurs).toContain(null);
    expect(valeurs).toContain("seuil-sar v0");
  });
  it("avec tolerance : elle part en parametre lie ; hors bornes elle est refusee", async () => {
    await request(app).post(`${base}/propositions`).send({ ...lot, toleranceRattachementM: 50 });
    expect(h.raw[0].slice(1)).toContain(50);
    const r = await request(app).post(`${base}/propositions`).send({ ...lot, toleranceRattachementM: 0 });
    expect(r.status).toBe(400); expect(r.body.code).toBe("TOLERANCE_INVALIDE");
  });
  it("refuse un produit inconnu (404), une methode vide, un lot vide, un type hors liste", async () => {
    expect((await request(app).post(`${base}/propositions`).send({ ...lot, produitId: "p-9" })).status).toBe(404);
    expect((await request(app).post(`${base}/propositions`).send({ ...lot, methode: " " })).body.code).toBe("METHODE_REQUISE");
    expect((await request(app).post(`${base}/propositions`).send({ ...lot, propositions: [] })).body.code).toBe("LOT_VIDE");
    expect((await request(app).post(`${base}/propositions`).send({ ...lot, propositions: [{ ...lot.propositions[0], type: "GLISSEMENT" }] })).status).toBe(400);
  });
  it("deux dates : la reference est anterieure ; posterieure ou egale refusee (400), inconnue 404", async () => {
    h.produits.length = 0;
    h.produits.push({ id: "p-new", code: "S2-1001", dateAcquisition: new Date("2026-10-01") }, { id: "p-ref", code: "S2-0901", dateAcquisition: new Date("2026-09-01") });
    const ok = await request(app).post(`${base}/propositions`).send({ ...lot, produitId: "p-new", produitReferenceId: "p-ref" });
    expect(ok.status).toBe(201);
    const inverse = await request(app).post(`${base}/propositions`).send({ ...lot, produitId: "p-ref", produitReferenceId: "p-new" });
    expect(inverse.status).toBe(400); expect(inverse.body.code).toBe("REFERENCE_NON_ANTERIEURE");
    const inconnue = await request(app).post(`${base}/propositions`).send({ ...lot, produitId: "p-new", produitReferenceId: "p-9" });
    expect(inconnue.status).toBe(404); expect(inconnue.body.code).toBe("REFERENCE_INEXISTANTE");
  });
  it("une detection hors de l'emprise (refus de la base) refuse tout le lot en 400, pas en 500", async () => {
    h.erreurBase = "propositions_teledetection : la detection est hors de l'emprise du produit p-1";
    const r = await request(app).post(`${base}/propositions`).send(lot);
    expect(r.status).toBe(400); expect(r.body.code).toBe("HORS_EMPRISE");
  });
});

describe("Verdict du terrain et verification", () => {
  beforeEach(() => { h.propositions.push({ id: "pr-1", statut: "A_VERIFIER", missionId: null, type: "INONDATION" }); });

  it("confirme en citant le constat ; audit VALIDATE ; ne se reprend pas", async () => {
    const r = await request(app).post(`${base}/propositions/pr-1/verdict`).send({ statut: "CONFIRMEE", motif: "Eau constatee", constatRef: "mission:VER-1" });
    expect(r.status).toBe(200);
    expect(h.propositions[0]).toMatchObject({ statut: "CONFIRMEE", verifieeParId: "u-gest", constatRef: "mission:VER-1" });
    expect(h.audits.at(-1)).toMatchObject({ action: "VALIDATE", entityType: "PropositionTeledetection" });
    const again = await request(app).post(`${base}/propositions/pr-1/verdict`).send({ statut: "INFIRMEE", motif: "x", constatRef: "y" });
    expect(again.status).toBe(409); expect(again.body.code).toBe("VERDICT_DEJA_RENDU");
  });
  it("infirme : audit REJECT ; sans constat : refus", async () => {
    expect((await request(app).post(`${base}/propositions/pr-1/verdict`).send({ statut: "INFIRMEE", motif: "sec", constatRef: "" })).body.code).toBe("CONSTAT_REQUIS");
    await request(app).post(`${base}/propositions/pr-1/verdict`).send({ statut: "INFIRMEE", motif: "Chaussee seche", constatRef: "observation:O-1" });
    expect(h.audits.at(-1)).toMatchObject({ action: "REJECT" });
  });
  it("depeche une mission SURVEILLANCE une seule fois", async () => {
    const r = await request(app).post(`${base}/propositions/pr-1/verification`).send({});
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ type: "SURVEILLANCE", statut: "BROUILLON" });
    expect(r.body.code).toMatch(/^VER-TD-/);
    expect(h.propositions[0].missionId).toBe("m-1");
    const again = await request(app).post(`${base}/propositions/pr-1/verification`).send({});
    expect(again.status).toBe(409); expect(again.body.code).toBe("MISSION_DEJA_DEPECHEE");
  });
  it("refuse un filtre de statut inconnu", async () => {
    expect((await request(app).get(`${base}/propositions?statut=PROBABLE`)).status).toBe(400);
  });
});

describe("Coherence", () => {
  it("rend les anomalies de la vue avec leur gravite, bloquantes d'abord ; lisible par tout compte", async () => {
    compte.role = "LECTEUR";
    h.lignesCoherence = [
      { propositionId: "pr-2", regle: "MISSION_SANS_VERDICT", detail: "VER-1 TERMINEE" },
      { propositionId: "pr-1", regle: "HORS_EMPRISE_PRODUIT", detail: "S1" },
      { propositionId: "pr-3", regle: "REGLE_INCONNUE", detail: null },
    ];
    const r = await request(app).get(`${base}/coherence`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ bloquantes: 2, aExaminer: 1, tronquee: false });
    expect(r.body.anomalies.map((a: { regle: string; gravite: string }) => `${a.regle}:${a.gravite}`)).toEqual([
      "HORS_EMPRISE_PRODUIT:BLOQUANTE", "REGLE_INCONNUE:BLOQUANTE", "MISSION_SANS_VERDICT:A_EXAMINER",
    ]);
    h.lignesCoherence = [];
  });
});
