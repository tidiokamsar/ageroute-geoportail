import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `/api/v2/exploitation/patrouilles` -- ce que ces tests defendent.
 *
 *   - ecrire est reserve a ADMIN et GESTIONNAIRE, lire est ouvert ;
 *   - un programme sans itineraire, ou citant un troncon inconnu, est refuse ; rien n'est seme ;
 *   - un passage engendre est une mission SURVEILLANCE ordinaire, BROUILLON, citant son programme ;
 *   - la depeche de verification qualifie un signalement NOUVEAU une seule fois, dans la
 *     transaction, et refuse un signalement deja qualifie ;
 *   - chaque ecriture est auditee.
 */

const compte = { id: "u-gest", role: "GESTIONNAIRE" };
vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: compte.id, role: compte.role }; n();
  },
}));

type Ligne = Record<string, unknown>;
const h = vi.hoisted(() => ({
  programmes: [] as Ligne[], missions: [] as Ligne[], signalements: [] as Ligne[], audits: [] as Ligne[],
  troncons: new Set<string>(), raw: [] as unknown[], couverture: [] as Ligne[], tx: 0,
}));

vi.mock("../lib/prisma", () => {
  const programmePatrouille = {
    findUnique: async ({ where }: { where: { code: string } }) => h.programmes.find((p) => p.code === where.code) ?? null,
    findFirst: async ({ where }: { where: { id: string } }) => h.programmes.find((p) => p.id === where.id && !p.deletedAt) ?? null,
    findMany: async () => h.programmes.filter((p) => !p.deletedAt).map((p) => ({ ...p, _count: { troncons: (p.troncons as string[]).length } })),
    create: async ({ data }: { data: Ligne & { troncons: { create: { tronconId: string }[] } } }) => {
      const p = { id: `p-${h.programmes.length + 1}`, actif: true, deletedAt: null, ...data, troncons: data.troncons.create.map((t) => t.tronconId) };
      h.programmes.push(p); return p;
    },
  };
  const mission = {
    findFirst: async ({ where }: { where: { id: string } }) => h.missions.find((m) => m.id === where.id) ?? null,
    findMany: async ({ where }: { where: { code: { startsWith: string } } }) =>
      h.missions.filter((m) => String(m.code).startsWith(where.code.startsWith)).map((m) => ({ code: m.code })),
    create: async ({ data }: { data: Ligne }) => { const m = { id: `m-${h.missions.length + 1}`, statut: "BROUILLON", ...data }; h.missions.push(m); return m; },
    groupBy: async () => h.missions
      .filter((m) => m.programmeId && (m.statut === "TERMINEE" || m.statut === "SYNC_EN_ATTENTE") && m.finReelle)
      .map((m) => ({ programmeId: m.programmeId, _max: { finReelle: m.finReelle } })),
  };
  const signalementCitoyen = {
    findUnique: async ({ where }: { where: { id: string } }) => h.signalements.find((s) => s.id === where.id) ?? null,
    updateMany: async ({ where, data }: { where: { id: string; statut: string }; data: Ligne }) => {
      const s = h.signalements.find((x) => x.id === where.id && x.statut === where.statut);
      if (!s) return { count: 0 };
      Object.assign(s, data); return { count: 1 };
    },
  };
  const troncon = { count: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.filter((id) => h.troncons.has(id)).length };
  const auditLog = { create: async ({ data }: { data: Ligne }) => { h.audits.push(data); return data; } };
  const tx = { programmePatrouille, mission, signalementCitoyen, troncon, auditLog };
  const prisma = {
    ...tx,
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => { h.tx += 1; return fn(tx); },
    $queryRaw: async (...a: unknown[]) => { h.raw.push(a); return h.couverture; },
  };
  return { prisma };
});

import { patrouillesV2Router } from "./patrouilles.routes";

const app = express();
app.use(express.json());
app.use("/api/v2/exploitation/patrouilles", patrouillesV2Router);
app.use((err: Error, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: err.message }); });

const base = "/api/v2/exploitation/patrouilles";
const programme = {
  code: "PAT-RN1", libelle: "RN1 Coyah - Kindia", classeAxe: "RN",
  periodiciteJours: 7, moisActifs: [6, 7, 8, 9, 10], responsableId: "u-chef", troncons: ["t-a", "t-b"],
};

beforeEach(() => {
  h.programmes.length = 0; h.missions.length = 0; h.signalements.length = 0; h.audits.length = 0;
  h.raw.length = 0; h.couverture.length = 0; h.tx = 0;
  h.troncons = new Set(["t-a", "t-b", "t-c"]);
  compte.role = "GESTIONNAIRE";
});

describe("Droits", () => {
  it("un LECTEUR lit mais n'ecrit pas", async () => {
    compte.role = "LECTEUR";
    expect((await request(app).get(`${base}/programmes`)).status).toBe(200);
    expect((await request(app).post(`${base}/programmes`).send(programme)).status).toBe(403);
    expect((await request(app).post(`${base}/signalements/s1/verification`).send({})).status).toBe(403);
    expect(h.programmes).toHaveLength(0);
  });
  it("aucune route DELETE n'existe", async () => {
    const r = await request(app).delete(`${base}/programmes/p-1`);
    expect(r.status).toBe(404);
  });
});

describe("Creer un programme", () => {
  it("cree le programme et son itineraire ordonne, audite", async () => {
    const r = await request(app).post(`${base}/programmes`).send(programme);
    expect(r.status).toBe(201);
    expect(h.programmes[0]).toMatchObject({ code: "PAT-RN1", periodiciteJours: 7, creeParId: "u-gest", troncons: ["t-a", "t-b"] });
    expect(h.audits).toEqual([expect.objectContaining({ action: "CREATE", entityType: "ProgrammePatrouille" })]);
  });
  it("refuse sans periodicite : aucune valeur n'est supposee", async () => {
    const { periodiciteJours: _omis, ...sans } = programme;
    expect((await request(app).post(`${base}/programmes`).send(sans)).status).toBe(400);
  });
  it("refuse un itineraire vide, un troncon inconnu, un code deja pris", async () => {
    const vide = await request(app).post(`${base}/programmes`).send({ ...programme, troncons: [] });
    expect(vide.status).toBe(400); expect(vide.body.code).toBe("ITINERAIRE_VIDE");
    const inconnu = await request(app).post(`${base}/programmes`).send({ ...programme, troncons: ["t-a", "t-zz"] });
    expect(inconnu.status).toBe(400); expect(inconnu.body.code).toBe("TRONCON_INCONNU");
    await request(app).post(`${base}/programmes`).send(programme);
    const double = await request(app).post(`${base}/programmes`).send(programme);
    expect(double.status).toBe(409); expect(double.body.code).toBe("CODE_EXISTANT");
    expect(h.programmes).toHaveLength(1);
  });
});

describe("Lister avec echeance", () => {
  it("rend le dernier passage realise et l'echeance calculee par le noyau", async () => {
    await request(app).post(`${base}/programmes`).send({ ...programme, moisActifs: [] });
    h.missions.push({ id: "m-x", code: "X", programmeId: "p-1", statut: "TERMINEE", finReelle: new Date("2020-01-01T10:00:00Z") });
    const r = await request(app).get(`${base}/programmes`);
    expect(r.status).toBe(200);
    expect(r.body.programmes[0].dernierPassage).toBe("2020-01-01T10:00:00.000Z");
    expect(r.body.programmes[0].echeance.statut).toBe("EN_RETARD");
  });
});

describe("Engendrer un passage", () => {
  it("cree une mission SURVEILLANCE BROUILLON citant le programme, code date et suffixe", async () => {
    await request(app).post(`${base}/programmes`).send(programme);
    const r1 = await request(app).post(`${base}/programmes/p-1/missions`).send({ debutPrevu: "2026-10-19T07:00:00Z" });
    const r2 = await request(app).post(`${base}/programmes/p-1/missions`).send({ debutPrevu: "2026-10-19T14:00:00Z" });
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({ code: "PAT-RN1-20261019", type: "SURVEILLANCE", statut: "BROUILLON", programmeId: "p-1", createurId: "u-gest" });
    expect(r2.body.code).toBe("PAT-RN1-20261019-2");
    expect(h.audits.filter((a) => a.entityType === "Mission")).toHaveLength(2);
  });
  it("refuse un programme inactif (409) ou inconnu (404)", async () => {
    await request(app).post(`${base}/programmes`).send(programme);
    h.programmes[0].actif = false;
    expect((await request(app).post(`${base}/programmes/p-1/missions`).send({ debutPrevu: "2026-10-19" })).status).toBe(409);
    expect((await request(app).post(`${base}/programmes/p-9/missions`).send({ debutPrevu: "2026-10-19" })).status).toBe(404);
    expect(h.missions).toHaveLength(0);
  });
});

describe("Couverture", () => {
  it("interroge la fonction SQL avec la tolerance, en parametre lie, et resume", async () => {
    h.missions.push({ id: "m-1", code: "C", programmeId: "p-1" });
    h.couverture.push(
      { tronconId: "t-a", ordre: 1, longueurM: 1000, couvertM: 1000, taux: 1 },
      { tronconId: "t-b", ordre: 2, longueurM: 1000, couvertM: 0, taux: 0 },
      { tronconId: null, ordre: null, longueurM: 120, couvertM: null, taux: null },
    );
    const r = await request(app).get(`${base}/missions/m-1/couverture?tolerance=50`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ toleranceM: 50, taux: 0.5, horsItineraireM: 120, tronconsNonVus: ["t-b"] });
    const [gabarit, ...valeurs] = h.raw[0] as [TemplateStringsArray, ...unknown[]];
    expect(gabarit.join("?")).toContain("couverture_patrouille(");
    expect(valeurs).toEqual(["m-1", 50]);
  });
  it("30 m par defaut ; refuse une tolerance nulle, negative ou demesuree", async () => {
    h.missions.push({ id: "m-1", code: "C", programmeId: "p-1" });
    await request(app).get(`${base}/missions/m-1/couverture`);
    expect((h.raw[0] as unknown[])[2]).toBe(30);
    for (const t of ["0", "-5", "abc", "501"]) expect((await request(app).get(`${base}/missions/m-1/couverture?tolerance=${t}`)).status).toBe(400);
  });
  it("une mission sans programme n'a pas d'itineraire de reference (409)", async () => {
    h.missions.push({ id: "m-2", code: "P", programmeId: null });
    const r = await request(app).get(`${base}/missions/m-2/couverture`);
    expect(r.status).toBe(409); expect(r.body.code).toBe("MISSION_SANS_PROGRAMME");
  });
});

describe("Depeche de verification", () => {
  it("NOUVEAU : qualifie le signalement, cree la mission liee, audite les deux", async () => {
    h.signalements.push({ id: "s1", numeroPublic: "SIG-2026-00001", statut: "NOUVEAU", tronconId: "t-a" });
    const r = await request(app).post(`${base}/signalements/s1/verification`).send({ assigneId: "u-agent" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ statutSignalement: "EN_QUALIFICATION", statutChange: true });
    expect(r.body.mission).toMatchObject({ code: "VER-SIG-2026-00001-1", signalementId: "s1", type: "SURVEILLANCE", assigneId: "u-agent" });
    expect(h.signalements[0]).toMatchObject({ statut: "EN_QUALIFICATION", qualifieParId: "u-gest" });
    expect(h.audits.map((a) => `${a.action}:${a.entityType}`)).toEqual(["UPDATE:SignalementCitoyen", "CREATE:Mission"]);
    expect(h.tx).toBe(1);
  });
  it("EN_QUALIFICATION : seconde verification, statut inchange, aucun audit de statut", async () => {
    h.signalements.push({ id: "s1", numeroPublic: "SIG-2026-00001", statut: "EN_QUALIFICATION" });
    h.missions.push({ id: "m-0", code: "VER-SIG-2026-00001-1", signalementId: "s1" });
    const r = await request(app).post(`${base}/signalements/s1/verification`).send({});
    expect(r.status).toBe(201);
    expect(r.body.mission.code).toBe("VER-SIG-2026-00001-2");
    expect(h.audits.map((a) => a.entityType)).toEqual(["Mission"]);
  });
  it("refuse un signalement deja qualifie (409) ou inconnu (404), sans rien ecrire", async () => {
    h.signalements.push({ id: "s2", numeroPublic: "SIG-2026-00002", statut: "RESOLU" });
    const r = await request(app).post(`${base}/signalements/s2/verification`).send({});
    expect(r.status).toBe(409); expect(r.body.code).toBe("SIGNALEMENT_DEJA_QUALIFIE");
    expect((await request(app).post(`${base}/signalements/s9/verification`).send({})).status).toBe(404);
    expect(h.missions).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });
});
