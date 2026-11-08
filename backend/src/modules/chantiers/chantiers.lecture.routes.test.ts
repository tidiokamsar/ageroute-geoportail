import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Lectures de chantiers (liste, carte, sans localisation) : QUI LIT le montant, le bailleur, le numero de contrat et l'entreprise.
 *
 * Regle UNIQUE (`droitMontantsContractuels`, D-C1-1 PROVISOIRE) : ADMIN, module `marches` ou module `chantiers`. Un compte qui n'a
 * que `decision` ou `programmation` lit le chantier (la carte, le selecteur) mais PAS ces quatre champs : ils valent `null`.
 * Avant ce correctif la liste du masque comptait aussi `decision` et `programmation`, alors que la synthese, le suivi
 * contractuel et les exports n'exigeaient que `marches` : trois definitions du meme droit.
 *
 * Les VRAIS gardes (jeton signe, compte relu par un resolveur injecte, modules lus par `modulesAutorisesDe`) et le VRAI controleur
 * sont montes ; seule la base (modules, rattachements) et le service de lecture sont simules.
 */
vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://127.0.0.1:1/essai";
  process.env.JWT_ACCESS_SECRET = "essai-access-secret-essai-access-secret-0000";
  process.env.JWT_REFRESH_SECRET = "essai-refresh-secret-essai-refresh-secret-000";
  process.env.CORS_ORIGIN = "http://localhost:5173";
});

const h = vi.hoisted(() => ({ modules: {} as Record<string, string[]> }));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    user: { findUnique: async ({ where }: { where: { id: string } }) => ({ modulesAutorises: h.modules[where.id] ?? [] }) },
    $queryRaw: async () => [],
  },
}));
vi.mock("../../lib/crud-factory", () => ({
  createCrudService: () => ({}),
  createBulkRouter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const LIGNE = { id: "c1", intitule: "Travaux RN1", statut: "EN_COURS", avancementPct: 40, region: "Kindia", montantGnf: "5000000000", bailleur: "AFD", numContrat: "N-1", entreprise: "SOGEA" };
vi.mock("./chantiers.service", () => ({
  chantiersService: {
    list: async () => ({ data: [{ ...LIGNE }], total: 1, page: 1, pageSize: 20 }),
    listGeo: async () => [{ ...LIGNE }],
    listSansLocalisation: async () => [{ ...LIGNE }],
  },
}));

import { _installerResolveurCompte } from "../../middleware/auth.middleware";
import { errorHandler } from "../../middleware/error.middleware";
import { signAccessToken } from "../../utils/jwt";
import { chantiersRouter } from "./chantiers.routes";

const app = express();
app.use(express.json());
app.use("/chantiers", chantiersRouter);
app.use(errorHandler);

const COMPTES: Record<string, { id: string; role: string; modules: string[] }> = {
  ADMIN: { id: "u-admin", role: "ADMIN", modules: [] },
  DECISION: { id: "u-dec", role: "LECTEUR", modules: ["decision"] },
  PROGRAMMATION: { id: "u-prog", role: "GESTIONNAIRE", modules: ["programmation"] },
  DECISION_PROGRAMMATION_RAPPORTS: { id: "u-dpr", role: "GESTIONNAIRE", modules: ["decision", "programmation", "rapports"] },
  AUCUN: { id: "u-aucun", role: "LECTEUR", modules: [] },
  CHANTIERS: { id: "u-ch", role: "LECTEUR", modules: ["chantiers"] },
  MARCHES: { id: "u-ma", role: "LECTEUR", modules: ["marches"] },
};
const jeton = (c: string) => signAccessToken({ sub: COMPTES[c].id, role: COMPTES[c].role as never, email: `${c}@essai.invalid` });

beforeEach(() => {
  h.modules = Object.fromEntries(Object.values(COMPTES).map((c) => [c.id, c.modules]));
  _installerResolveurCompte(async (id) => {
    const c = Object.values(COMPTES).find((x) => x.id === id);
    return c ? { actif: true, lockedUntil: null, role: c.role as never, email: `${id}@essai.invalid` } : null;
  });
});

const CHAMPS = ["montantGnf", "bailleur", "numContrat", "entreprise"] as const;
const premiere = (corps: unknown): Record<string, unknown> => (Array.isArray(corps) ? corps[0] : (corps as { data: unknown[] }).data[0]) as Record<string, unknown>;

describe.each([["/chantiers"], ["/chantiers/geo"], ["/chantiers/sans-localisation"]])("GET %s", (url) => {
  it.each(["DECISION", "PROGRAMMATION", "DECISION_PROGRAMMATION_RAPPORTS", "AUCUN"])("%s : le chantier est lu, les quatre champs contractuels valent null", async (c) => {
    const r = await request(app).get(url).set("Authorization", `Bearer ${jeton(c)}`);
    expect(r.status).toBe(200);
    const l = premiere(r.body);
    expect(l.intitule).toBe("Travaux RN1");
    for (const champ of CHAMPS) expect(l[champ], `${c} ${champ}`).toBeNull();
    expect(JSON.stringify(r.body)).not.toMatch(/SOGEA|AFD|N-1|5000000000/);
  });

  it.each(["ADMIN", "CHANTIERS", "MARCHES"])("%s : les quatre champs contractuels sont lus", async (c) => {
    const r = await request(app).get(url).set("Authorization", `Bearer ${jeton(c)}`);
    expect(r.status).toBe(200);
    const l = premiere(r.body);
    expect([l.montantGnf, l.bailleur, l.numContrat, l.entreprise]).toEqual(["5000000000", "AFD", "N-1", "SOGEA"]);
  });
});
