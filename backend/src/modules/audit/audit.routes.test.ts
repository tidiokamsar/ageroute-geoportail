import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { auditRouter } from "./audit.routes";

/**
 * Non-regression de P0-SEC-02 : /api/audit n'appliquait que requireAuth et renvoyait
 * before/after. Un compte LECTEUR obtenait donc les montants et statuts contractuels
 * des marches sans avoir le module Marches.
 *
 * Politique retenue et testee ici : l'acces au journal d'une entite suit le module
 * dont releve cette entite. Les comptes utilisateurs et les parametres applicatifs,
 * qui ne relevent d'aucun module configurable, restent reserves a ADMIN. Un type
 * d'entite inconnu est refuse — on echoue ferme.
 */

vi.mock("../../utils/jwt", () => ({
  verifyAccessToken: vi.fn((token: string) => JSON.parse(Buffer.from(token, "base64url").toString("utf8"))),
}));

const compte = {
  id: "u1",
  role: "GESTIONNAIRE" as string,
  email: "agent@ageroute.gov.gn",
  modulesAutorises: [] as string[],
};

vi.mock("../../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => ({ modulesAutorises: compte.modulesAutorises })),
    },
    auditLog: {
      findMany: vi.fn(async () => [
        {
          id: "a1",
          action: "UPDATE",
          createdAt: new Date("2026-07-01T10:00:00Z"),
          user: { nomComplet: "Agent", email: "agent@ageroute.gov.gn" },
          before: { montant: 1200000, devise: "GNF" },
          after: { montant: 1500000, devise: "GNF" },
        },
      ]),
      count: vi.fn(async () => 1),
    },
  },
}));


function jeton() {
  return Buffer.from(JSON.stringify({ sub: compte.id, role: compte.role, email: compte.email })).toString("base64url");
}

function app() {
  const a = express();
  a.use("/api/audit", auditRouter);
  return a;
}

function lire(entityType: string) {
  return request(app())
    .get(`/api/audit?entityType=${entityType}&entityId=x1`)
    .set("Authorization", `Bearer ${jeton()}`);
}

beforeEach(() => {
  compte.role = "GESTIONNAIRE";
  compte.modulesAutorises = [];
});

describe("GET /api/audit — cloisonnement du journal", () => {
  it("refuse l'appel sans jeton", async () => {
    const res = await request(app()).get("/api/audit?entityType=Marche&entityId=x1");
    expect(res.status).toBe(401);
  });

  it("LECTEUR restreint aux tronçons n'obtient pas le journal d'un marché", async () => {
    // C'est la vulnerabilite P0-SEC-02 : ce test doit echouer si elle revient.
    compte.role = "LECTEUR";
    compte.modulesAutorises = ["troncons"];
    const res = await lire("Marche");

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain("montant");
  });

  it("GESTIONNAIRE restreint aux tronçons n'obtient pas le journal d'un marché", async () => {
    compte.modulesAutorises = ["troncons"];
    expect((await lire("Marche")).status).toBe(403);
  });

  it("GESTIONNAIRE ayant le module Marchés obtient le journal, before/after compris", async () => {
    compte.modulesAutorises = ["marches"];
    const res = await lire("Marche");

    expect(res.status).toBe(200);
    expect(res.body.data[0].before).toEqual({ montant: 1200000, devise: "GNF" });
  });

  it("un décompte suit les droits du module Marchés", async () => {
    compte.modulesAutorises = ["troncons"];
    expect((await lire("Decompte")).status).toBe(403);
    compte.modulesAutorises = ["marches"];
    expect((await lire("Decompte")).status).toBe(200);
  });

  it("INSPECTEUR ayant le module Inspections lit le journal d'une inspection", async () => {
    compte.role = "INSPECTEUR";
    compte.modulesAutorises = ["inspections"];
    expect((await lire("Inspection")).status).toBe(200);
  });

  it("INSPECTEUR n'accède pas au journal des comptes utilisateurs", async () => {
    compte.role = "INSPECTEUR";
    compte.modulesAutorises = [];
    expect((await lire("User")).status).toBe(403);
  });

  it("GESTIONNAIRE sans restriction n'accède pas non plus au journal des comptes", async () => {
    // Liste vide vaut absence de restriction sur les MODULES, mais User et AppSetting
    // ne relevent d'aucun module : ils restent ADMIN uniquement.
    compte.modulesAutorises = [];
    expect((await lire("User")).status).toBe(403);
    expect((await lire("AppSetting")).status).toBe(403);
  });

  it("ADMIN accède au journal des comptes et des paramètres", async () => {
    compte.role = "ADMIN";
    expect((await lire("User")).status).toBe(200);
    expect((await lire("AppSetting")).status).toBe(200);
  });

  it("ADMIN n'est jamais restreint par sa liste de modules", async () => {
    compte.role = "ADMIN";
    compte.modulesAutorises = ["troncons"];
    expect((await lire("Marche")).status).toBe(200);
  });

  it("un type d'entité inconnu est refusé plutôt qu'autorisé par défaut", async () => {
    compte.role = "ADMIN";
    expect((await lire("EntiteInventee")).status).toBe(403);
  });

  it("le paramètre entityId reste obligatoire", async () => {
    const res = await request(app()).get("/api/audit?entityType=Troncon").set("Authorization", `Bearer ${jeton()}`);
    expect(res.status).not.toBe(200);
  });
});
