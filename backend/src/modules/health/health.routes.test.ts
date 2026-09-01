import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { healthRouter } from "./health.routes";

/**
 * La sonde repondait { status: "ok" } sans rien verifier : elle annoncait donc
 * « ok » base arretee. Ces tests portent sur le seul comportement qui compte —
 * qu'elle sache dire NON.
 */

const etat = { baseRepond: true, stockageAccessible: true };

vi.mock("../../lib/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(async () => {
      if (!etat.baseRepond) throw new Error("connection refused");
      return [{ "?column?": 1 }];
    }),
  },
}));

vi.mock("fs/promises", () => ({
  default: {
    access: vi.fn(async () => {
      if (!etat.stockageAccessible) throw new Error("EACCES");
    }),
  },
}));

vi.mock("../../middleware/upload-document.middleware", () => ({ UPLOAD_DIR: "/app/uploads/documents" }));
vi.mock("../../middleware/upload-photo.middleware", () => ({ PHOTOS_UPLOAD_DIR: "/app/uploads/photos" }));

function app() {
  const a = express();
  a.use("/api/health", healthRouter);
  return a;
}

beforeEach(() => {
  etat.baseRepond = true;
  etat.stockageAccessible = true;
});

describe("GET /api/health", () => {
  it("répond 200 quand tout fonctionne", async () => {
    const res = await request(app()).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.checks.base.etat).toBe("ok");
    expect(res.body.checks.stockage.etat).toBe("ok");
  });

  it("répond 503 quand la base ne répond pas", async () => {
    // C'est le cas que l'ancienne sonde annoncait « ok ».
    etat.baseRepond = false;
    const res = await request(app()).get("/api/health");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degrade");
    expect(res.body.checks.base.etat).toBe("ko");
    expect(res.body.checks.api.etat).toBe("ok");
  });

  it("répond 503 quand le stockage n'est pas inscriptible", async () => {
    etat.stockageAccessible = false;
    const res = await request(app()).get("/api/health");
    expect(res.status).toBe(503);
    expect(res.body.checks.stockage.etat).toBe("ko");
  });

  it("ne divulgue ni version, ni chemin, ni message d'erreur", async () => {
    etat.baseRepond = false;
    etat.stockageAccessible = false;
    const corps = JSON.stringify((await request(app()).get("/api/health")).body);

    // Une sonde publique ne doit rien apprendre a qui la sollicite au-dela de
    // « cela fonctionne ou non ».
    expect(corps).not.toMatch(/connection refused|EACCES/i);
    expect(corps).not.toMatch(/\/app\/uploads/);
    expect(corps).not.toMatch(/postgres|prisma|version/i);
  });

  it("rend un temps de réponse par contrôle, pour la supervision", async () => {
    const res = await request(app()).get("/api/health");
    expect(typeof res.body.checks.base.ms).toBe("number");
    expect(typeof res.body.checks.stockage.ms).toBe("number");
  });
});
