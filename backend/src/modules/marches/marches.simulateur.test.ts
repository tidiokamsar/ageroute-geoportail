import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `POST /api/simulateur/budget` valide son corps.
 *
 * LE DEFAUT : le gestionnaire castait `req.body` sans le controler. Une enveloppe en chaine,
 * un poids negatif ou une classe inconnue atteignaient le calcul (ou Prisma, qui levait une
 * 500). Le schema est STRICT : une cle mal orthographiee ne retombe plus en silence sur
 * l'enveloppe par defaut.
 *
 * Ces tests montent le VRAI routeur ; l'authentification et le controle de module sont
 * simules (ils ont leurs propres tests), la base aussi.
 */

const h = vi.hoisted(() => ({ findMany: vi.fn(async () => [] as unknown[]) }));

vi.mock("../../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: "u1", role: "GESTIONNAIRE" };
    next();
  },
}));
vi.mock("../../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
vi.mock("../../lib/prisma", () => ({ prisma: { troncon: { findMany: h.findMany } } }));
vi.mock("../../jobs/alertes-contractuelles", () => ({ sendAlertesEmail: vi.fn() }));
vi.mock("./alertes.service", () => ({ computeAlertesContractuelles: vi.fn() }));
// Les gestionnaires CRUD ne sont pas le sujet ; chaque export importe par le routeur est
// remplace par un espion inerte.
vi.mock("./marches.controller", () => ({
  listHandler: vi.fn(), getHandler: vi.fn(), createHandler: vi.fn(), updateHandler: vi.fn(), deleteHandler: vi.fn(),
  attachChantierHandler: vi.fn(), detachChantierHandler: vi.fn(),
  listAvancementsHandler: vi.fn(), upsertAvancementHandler: vi.fn(),
  listBailleursHandler: vi.fn(), createBailleurHandler: vi.fn(), updateBailleurHandler: vi.fn(), deleteBailleurHandler: vi.fn(),
}));
vi.mock("./decomptes.controller", () => ({
  listHandler: vi.fn(), createHandler: vi.fn(), updateHandler: vi.fn(), deleteHandler: vi.fn(), sumByBailleurHandler: vi.fn(),
}));

import { marchesRouter } from "./marches.routes";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api", marchesRouter);
  return a;
}
const poster = (corps: unknown) => request(app()).post("/api/simulateur/budget").send(corps as object);

beforeEach(() => {
  h.findMany.mockClear();
  h.findMany.mockResolvedValue([]);
});

describe("POST /simulateur/budget : corps valide", () => {
  it("accepte un corps vide (valeurs par defaut) et un corps complet", async () => {
    expect((await poster({})).status).toBe(200);
    const r = await poster({
      enveloppe_md_gnf: 500,
      ponderation: { etat: 40, trafic: 20, strategique: 20, cout: 20 },
      filtres: { region: "Kankan", classe: "RN" },
    });
    expect(r.status).toBe(200);
    expect(r.body.enveloppe).toBe(500);
  });
});

describe("POST /simulateur/budget : corps refuse avant tout calcul", () => {
  it.each([
    ["enveloppe en chaine", { enveloppe_md_gnf: "2000" }],
    ["enveloppe negative", { enveloppe_md_gnf: -1 }],
    ["enveloppe demesuree", { enveloppe_md_gnf: 1e12 }],
    ["poids negatif", { ponderation: { etat: -5 } }],
    ["poids hors borne", { ponderation: { cout: 101 } }],
    ["poids en chaine", { ponderation: { trafic: "25" } }],
    ["cle inconnue a la racine (faute de frappe)", { enveloppe: 100 }],
    ["cle inconnue dans la ponderation", { ponderation: { etat: 10, autre: 1 } }],
    ["classe inconnue", { filtres: { classe: "AUTOROUTE" } }],
    ["region vide", { filtres: { region: "" } }],
    ["filtres de mauvais type", { filtres: "RN" }],
  ])("400 : %s", async (_nom, corps) => {
    const r = await poster(corps);
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("Requête invalide");
    expect(h.findMany).not.toHaveBeenCalled();
  });
});
