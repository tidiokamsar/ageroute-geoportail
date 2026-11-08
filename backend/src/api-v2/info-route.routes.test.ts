import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHash } from "node:crypto";

/**
 * Info Route et bulletin -- ce que ces tests defendent.
 *
 *   - publier et generer : ADMIN et GESTIONNAIRE ; lire : tout compte authentifie ;
 *   - un evenement OUVERT ne se publie pas, un niveau non approuve non plus ;
 *   - chaque publication et chaque bulletin est audite ; aucune route ne modifie ni n'efface ;
 *   - le bulletin est archive avec l'empreinte SHA-256 exacte de son texte ;
 *   - le flux public ne laisse sortir ni troncon, ni evenement, ni niveau non approuve.
 */

const compte = { id: "u-gest", role: "GESTIONNAIRE" };
vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: compte.id, role: compte.role }; n();
  },
}));

type Ligne = Record<string, unknown>;
const h = vi.hoisted(() => ({
  statuts: new Map<string, string>(), publications: [] as Ligne[], bulletins: [] as Ligne[], audits: [] as Ligne[],
  approuves: new Set<string>(), courante: [] as Ligne[],
}));

vi.mock("../lib/prisma", () => {
  const publicationInfoRoute = {
    findUnique: async ({ where }: { where: { clientOperationId: string } }) => h.publications.find((p) => p.clientOperationId === where.clientOperationId) ?? null,
    findFirst: async ({ where }: { where: { evenementId: string } }) => [...h.publications].reverse().find((p) => p.evenementId === where.evenementId) ?? null,
    findMany: async ({ where }: { where: { evenementId: string } }) => h.publications.filter((p) => p.evenementId === where.evenementId),
    create: async ({ data }: { data: Ligne }) => { const p = { id: `p-${h.publications.length + 1}`, ...data }; h.publications.push(p); return p; },
  };
  const bulletinRoutier = {
    findMany: async () => h.bulletins.map((b) => ({ ...b })),
    findFirst: async () => h.bulletins[h.bulletins.length - 1] ?? null,
    findUnique: async ({ where }: { where: { id: string } }) => h.bulletins.find((b) => b.id === where.id) ?? null,
    create: async ({ data }: { data: Ligne }) => { const b = { id: `b-${h.bulletins.length + 1}`, ...data }; h.bulletins.push(b); return b; },
  };
  const referentielPraticabilite = {
    findUnique: async ({ where }: { where: { code: string } }) => ({ approuveeLe: h.approuves.has(where.code) ? new Date() : null }),
  };
  const auditLog = { create: async ({ data }: { data: Ligne }) => { h.audits.push(data); return data; } };
  const $queryRaw = async (gabarit: TemplateStringsArray, ...valeurs: unknown[]) => {
    const sql = gabarit.join("?");
    if (sql.includes("evenements_exploitation")) {
      const s = h.statuts.get(valeurs[0] as string);
      return s ? [{ statut: s }] : [];
    }
    if (sql.includes("info_route_courante")) return h.courante;
    return [];
  };
  const tx = { publicationInfoRoute, bulletinRoutier, referentielPraticabilite, auditLog, $queryRaw };
  return { prisma: { ...tx, $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } };
});

import { infoRouteV2Router } from "./info-route.routes";
import { publicRouter } from "../modules/public/public.routes";

const app = express();
app.use(express.json());
app.use("/api/v2/exploitation/info-route", infoRouteV2Router);
app.use("/api/public", publicRouter);
app.use((err: Error, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: err.message }); });

const base = "/api/v2/exploitation/info-route";
const publication = { action: "PUBLICATION", categorie: "COUPURE", titre: "RN1 coupee", textePublic: "Radier submerge.", localisationPublique: "RN1, PK 45, Kindia" };

beforeEach(() => {
  h.statuts = new Map([["ev-ouvert", "OUVERT"], ["ev-pris", "PRIS_EN_COMPTE"]]);
  h.publications.length = 0; h.bulletins.length = 0; h.audits.length = 0; h.courante.length = 0;
  h.approuves = new Set();
  compte.role = "GESTIONNAIRE";
});

describe("Publier", () => {
  it("publie un evenement pris en compte, audite, avec l'auteur authentifie", async () => {
    const r = await request(app).post(`${base}/evenements/ev-pris/publications`).send(publication);
    expect(r.status).toBe(201);
    expect(h.publications[0]).toMatchObject({ evenementId: "ev-pris", action: "PUBLICATION", publieParId: "u-gest", categorie: "COUPURE" });
    expect(h.audits).toEqual([expect.objectContaining({ action: "CREATE", entityType: "PublicationInfoRoute" })]);
  });
  it("refuse un evenement OUVERT (409) ou inconnu (404), sans rien ecrire", async () => {
    const o = await request(app).post(`${base}/evenements/ev-ouvert/publications`).send(publication);
    expect(o.status).toBe(409); expect(o.body.code).toBe("EVENEMENT_NON_PRIS_EN_COMPTE");
    expect((await request(app).post(`${base}/evenements/ev-zz/publications`).send(publication)).status).toBe(404);
    expect(h.publications).toHaveLength(0); expect(h.audits).toHaveLength(0);
  });
  it("refuse un niveau non approuve, accepte le meme niveau une fois approuve", async () => {
    const r = await request(app).post(`${base}/evenements/ev-pris/publications`).send({ ...publication, praticabiliteCode: "P4" });
    expect(r.status).toBe(409); expect(r.body.code).toBe("NIVEAU_NON_APPROUVE");
    h.approuves.add("P4");
    expect((await request(app).post(`${base}/evenements/ev-pris/publications`).send({ ...publication, praticabiliteCode: "P4" })).status).toBe(201);
  });
  it("un retrait ecrit une ligne vide de contenu", async () => {
    await request(app).post(`${base}/evenements/ev-pris/publications`).send(publication);
    const r = await request(app).post(`${base}/evenements/ev-pris/publications`).send({ action: "RETRAIT" });
    expect(r.status).toBe(201);
    expect(h.publications[1]).toMatchObject({ action: "RETRAIT", categorie: null, titre: null, textePublic: null });
  });
  it("le meme clientOperationId rend la publication existante sans rien ecrire", async () => {
    await request(app).post(`${base}/evenements/ev-pris/publications`).send({ ...publication, clientOperationId: "op-12345678" });
    const r = await request(app).post(`${base}/evenements/ev-pris/publications`).send({ ...publication, clientOperationId: "op-12345678" });
    expect(r.status).toBe(200); expect(r.body.dejaRecue).toBe(true);
    expect(h.publications).toHaveLength(1);
  });
  it("un LECTEUR lit mais ne publie ni ne genere", async () => {
    compte.role = "LECTEUR";
    expect((await request(app).get(`${base}/courante`)).status).toBe(200);
    expect((await request(app).post(`${base}/evenements/ev-pris/publications`).send(publication)).status).toBe(403);
    expect((await request(app).post(`${base}/bulletins`)).status).toBe(403);
  });
  it("aucune route de modification ni d'effacement", async () => {
    for (const m of ["put", "patch", "delete"] as const) expect((await request(app)[m](`${base}/evenements/ev-pris/publications`)).status).toBe(404);
    expect((await request(app).delete(`${base}/bulletins/b-1`)).status).toBe(404);
  });
});

const ligne = (o: Ligne = {}) => ({
  publicationId: "p-1", evenementId: "ev-pris", categorie: "COUPURE", titre: "RN1 coupee", textePublic: "Radier submerge.",
  localisationPublique: "RN1, PK 45, Kindia", deviation: null, praticabiliteCode: "P4", praticabiliteLibelle: "Impraticable ou coupee",
  niveauApprouve: false, misAJourLe: new Date("2026-10-19T05:00:00Z"), publieDepuis: new Date("2026-10-19T05:00:00Z"),
  debutValidite: null, finValidite: null, tronconId: "t-1", tronconCode: "GN N0001", point: null, ...o,
});

describe("Bulletin", () => {
  it("genere, archive avec l'empreinte exacte, audite ; le texte se telecharge tel quel", async () => {
    h.courante.push(ligne());
    const r = await request(app).post(`${base}/bulletins`);
    expect(r.status).toBe(201);
    const b = h.bulletins[0] as { texte: string; empreinteSha256: string; numero: string; publicationsIds: string[] };
    expect(b.empreinteSha256).toBe(createHash("sha256").update(b.texte, "utf8").digest("hex"));
    expect(b.numero).toMatch(/^BR-\d{8}-1$/);
    expect(b.publicationsIds).toEqual(["p-1"]);
    expect(b.texte).not.toContain("P4");
    expect(h.audits).toEqual([expect.objectContaining({ entityType: "BulletinRoutier" })]);
    const t = await request(app).get(`${base}/bulletins/b-1/texte`);
    expect(t.status).toBe(200);
    expect(t.headers["content-type"]).toContain("text/plain");
    expect(t.headers["x-empreinte-sha256"]).toBe(b.empreinteSha256);
    expect(t.text).toBe(b.texte);
  });
});

describe("Flux public", () => {
  it("ne laisse sortir ni troncon, ni evenement, ni niveau non approuve", async () => {
    h.courante.push(ligne());
    const r = await request(app).get("/api/public/info-route");
    expect(r.status).toBe(200);
    const p = r.body.publications[0];
    expect(p).toMatchObject({ id: "p-1", categorie: "COUPURE", localisation: "RN1, PK 45, Kindia", niveau: null });
    expect(JSON.stringify(r.body)).not.toMatch(/ev-pris|t-1|GN N0001|u-gest/);
  });
  it("rend le niveau quand il est approuve", async () => {
    h.courante.push(ligne({ niveauApprouve: true }));
    const r = await request(app).get("/api/public/info-route");
    expect(r.body.publications[0].niveau).toEqual({ code: "P4", libelle: "Impraticable ou coupee" });
  });
  it("le dernier bulletin en texte simple ; 404 explicite s'il n'y en a pas", async () => {
    expect((await request(app).get("/api/public/info-route/bulletin")).status).toBe(404);
    h.bulletins.push({ id: "b-1", numero: "BR-20261019-1", texte: "Bulletin.", empreinteSha256: "a".repeat(64) });
    const r = await request(app).get("/api/public/info-route/bulletin");
    expect(r.status).toBe(200); expect(r.text).toBe("Bulletin."); expect(r.headers["x-bulletin"]).toBe("BR-20261019-1");
  });
});
