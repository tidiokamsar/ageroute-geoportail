import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { limiteurRefresh, limiteurApiV2 } from "./rate-limit.middleware";

/**
 * Limiteurs de /api/auth/refresh et /api/v2.
 *
 * Ces tests verifient le comportement des limiteurs avec de petits plafonds. Leur BRANCHEMENT
 * dans l'application reelle (chemins, valeurs par defaut de l'environnement) est verifie par
 * `securite/routes-authentifiees.test.ts`, qui monte `createApp()`.
 */

function appAvec(chemin: string, limiteur: express.RequestHandler) {
  const a = express();
  a.set("trust proxy", 1);
  a.use(chemin, limiteur);
  a.all(`${chemin}/*`, (_req, res) => res.json({ ok: true }));
  a.all(chemin, (_req, res) => res.json({ ok: true }));
  return a;
}

describe("limiteurRefresh", () => {
  it("laisse passer jusqu'au plafond puis repond 429 pour la meme adresse", async () => {
    const a = appAvec("/api/auth/refresh", limiteurRefresh({ max: 3, fenetreMs: 60_000 }));
    const appel = () => request(a).post("/api/auth/refresh").set("X-Forwarded-For", "10.0.0.1");

    for (let i = 0; i < 3; i++) expect((await appel()).status).toBe(200);
    const refuse = await appel();
    expect(refuse.status).toBe(429);
    expect(refuse.body.error).toMatch(/Trop de rafraichissements/);
  });

  it("compte PAR ADRESSE : une autre adresse n'est pas touchee", async () => {
    const a = appAvec("/api/auth/refresh", limiteurRefresh({ max: 1, fenetreMs: 60_000 }));
    expect((await request(a).post("/api/auth/refresh").set("X-Forwarded-For", "10.0.0.1")).status).toBe(200);
    expect((await request(a).post("/api/auth/refresh").set("X-Forwarded-For", "10.0.0.1")).status).toBe(429);
    expect((await request(a).post("/api/auth/refresh").set("X-Forwarded-For", "10.0.0.2")).status).toBe(200);
  });

  it("annonce son plafond dans les en-tetes standard", async () => {
    const a = appAvec("/api/auth/refresh", limiteurRefresh({ max: 5, fenetreMs: 60_000 }));
    const r = await request(a).post("/api/auth/refresh");
    expect(r.headers["ratelimit-limit"]).toBe("5");
    expect(r.headers["x-ratelimit-limit"]).toBeUndefined();
  });
});

describe("limiteurApiV2", () => {
  it("coupe au-dela du plafond", async () => {
    const a = appAvec("/api/v2", limiteurApiV2({ max: 2, fenetreMs: 60_000 }));
    expect((await request(a).get("/api/v2/sync/pull")).status).toBe(200);
    expect((await request(a).get("/api/v2/geo/x")).status).toBe(200);
    const refuse = await request(a).get("/api/v2/geo/y");
    expect(refuse.status).toBe(429);
    expect(refuse.body.error).toMatch(/Trop de requetes/);
  });

  it("le plafond par defaut de l'environnement laisse passer une rafale de synchronisation", async () => {
    // 100 requetes en rafale : bien au-dessous des 1200/min par defaut (config/env.ts).
    const a = appAvec("/api/v2", limiteurApiV2({ max: 1200, fenetreMs: 60_000 }));
    const reponses = await Promise.all(Array.from({ length: 100 }, () => request(a).get("/api/v2/sync/pull")));
    expect(reponses.every((r) => r.status === 200)).toBe(true);
  });
});

describe("Plafond a 0 : limiteur desactive", () => {
  it("ne limite rien, pour qu'une variable mal saisie n'arrete pas la collecte", async () => {
    const a = appAvec("/api/v2", limiteurApiV2({ max: 0, fenetreMs: 60_000 }));
    for (let i = 0; i < 20; i++) expect((await request(a).get("/api/v2/geo/x")).status).toBe(200);
    const b = appAvec("/api/auth/refresh", limiteurRefresh({ max: 0, fenetreMs: 60_000 }));
    for (let i = 0; i < 20; i++) expect((await request(b).post("/api/auth/refresh")).status).toBe(200);
  });
});
