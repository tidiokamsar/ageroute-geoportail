import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { requireModuleAccess } from "../../middleware/module-access.middleware";
import { requireAuth } from "../../middleware/auth.middleware";

/**
 * Non-regression de P0-SEC-03 : les neuf routes d'ECRITURE de marches portaient bien
 * requireModuleAccess("marches"), les treize routes de LECTURE n'en avaient aucune.
 * N'importe quel compte authentifie — un LECTEUR restreint aux troncons compris —
 * pouvait donc lire la liste des marches, leurs montants, les decomptes, les
 * bailleurs et les decaissements par bailleur.
 *
 * Ce fichier ne teste pas les gestionnaires de marches eux-memes (ils demandent la
 * base) mais le middleware de cloisonnement, monte exactement comme sur les vraies
 * routes. C'est la que se jouait la faille : les gestionnaires, eux, n'ont jamais eu
 * a connaitre les droits.
 */

vi.mock("../../utils/jwt", () => ({
  verifyAccessToken: vi.fn((token: string) => JSON.parse(Buffer.from(token, "base64url").toString("utf8"))),
}));

const compte = {
  id: "u1",
  role: "LECTEUR" as string,
  email: "lecteur@ageroute.gov.gn",
  modulesAutorises: ["troncons"] as string[],
};

vi.mock("../../lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn(async () => ({ modulesAutorises: compte.modulesAutorises })) },
  },
}));

function jeton() {
  return Buffer.from(JSON.stringify({ sub: compte.id, role: compte.role, email: compte.email })).toString("base64url");
}

/** Reproduit le montage reel : app.use("/api", marchesRouter). */
function app(moduleKey: "marches" | "decision" | "programmation") {
  const a = express();
  a.get("/api/marches", requireAuth, requireModuleAccess(moduleKey), (_req, res) => {
    res.json([{ id: "m1", intitule: "Réhabilitation RN1", montant: 4500000000, devise: "GNF" }]);
  });
  return a;
}

function lire(moduleKey: "marches" | "decision" | "programmation" = "marches") {
  return request(app(moduleKey)).get("/api/marches").set("Authorization", `Bearer ${jeton()}`);
}

beforeEach(() => {
  compte.role = "LECTEUR";
  compte.modulesAutorises = ["troncons"];
});

describe("Cloisonnement des routes Marchés", () => {
  it("LECTEUR restreint aux tronçons n'obtient ni la liste des marchés ni les montants", async () => {
    const res = await lire();
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain("montant");
  });

  it("GESTIONNAIRE restreint aux tronçons n'obtient pas les marchés", async () => {
    compte.role = "GESTIONNAIRE";
    expect((await lire()).status).toBe(403);
  });

  it("un compte ayant le module Marchés y accède", async () => {
    compte.modulesAutorises = ["marches"];
    const res = await lire();
    expect(res.status).toBe(200);
    expect(res.body[0].montant).toBe(4500000000);
  });

  it("les scores de priorisation relèvent du module Aide à la décision", async () => {
    compte.modulesAutorises = ["marches"];
    expect((await lire("decision")).status).toBe(403);
    compte.modulesAutorises = ["decision"];
    expect((await lire("decision")).status).toBe(200);
  });

  it("le simulateur budgétaire relève du module Programmation", async () => {
    compte.modulesAutorises = ["marches"];
    expect((await lire("programmation")).status).toBe(403);
    compte.modulesAutorises = ["programmation"];
    expect((await lire("programmation")).status).toBe(200);
  });

  it("ADMIN n'est jamais restreint", async () => {
    compte.role = "ADMIN";
    compte.modulesAutorises = ["troncons"];
    expect((await lire()).status).toBe(200);
  });

  it("une liste vide vaut absence de restriction", async () => {
    compte.modulesAutorises = [];
    expect((await lire()).status).toBe(200);
  });

  it("refuse l'appel sans jeton", async () => {
    const res = await request(app("marches")).get("/api/marches");
    expect(res.status).toBe(401);
  });
});
