import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `GET /api/dashboard/activity` (revue de la vague 1, m5) : le flux d'activite recente melange tous les types d'entite journalises ; il ne montre que
 * ceux des modules autorises au compte, jamais ceux du module Projets de voirie a un compte rattache a un concessionnaire (referent), et jamais un type
 * inconnu ou reserve a l'ADMIN a un autre compte. La base est simulee (lignes d'audit filtrees comme le ferait `where.entityType.in`).
 */
const h = vi.hoisted(() => ({
  user: { id: "u", role: "LECTEUR" } as { id: string; role: string },
  modules: [] as string[],
  rattaches: 0,
  lignes: [] as { id: string; action: string; entityType: string; createdAt: Date; user: { nomComplet: string } | null }[],
  requetes: [] as unknown[],
}));

vi.mock("../../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => { (req as unknown as { user: unknown }).user = h.user; n(); },
}));
vi.mock("../../middleware/module-access.middleware", () => ({ requireModuleAccess: () => (_q: express.Request, _r: express.Response, n: express.NextFunction) => n() }));
vi.mock("../../lib/reseau", () => ({ WHERE_RESEAU_CLASSE: {}, longueurReseau: async () => ({}) }));
vi.mock("../../engines/decision.estimation", () => ({ estimerPourDecision: () => ({}) }));
vi.mock("../../tableau-de-bord/indicateurs.registre", () => ({ REGISTRE: [] }));
vi.mock("../../tableau-de-bord/tableau-de-bord.service", () => ({ evaluer: async () => [] }));
vi.mock("../../lib/prisma", () => ({
  prisma: {
    user: { findUnique: async () => ({ modulesAutorises: h.modules }) },
    referentConcessionnaire: { count: async () => h.rattaches },
    auditLog: {
      findMany: async (arg: { where?: { entityType?: { in: string[] } }; take: number }) => {
        h.requetes.push(arg);
        const types = arg.where?.entityType?.in;
        return h.lignes.filter((l) => types === undefined || types.includes(l.entityType)).slice(0, arg.take);
      },
    },
  },
}));

import { dashboardRouter } from "./dashboard.routes";

const app = express();
app.use("/dashboard", dashboardRouter);
app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "erreur interne" }); });

const ligne = (id: string, entityType: string) => ({ id, action: "UPDATE", entityType, createdAt: new Date("2026-11-07T10:00:00Z"), user: { nomComplet: "Agent d'AGEROUTE" } });
const types = async () => ((await request(app).get("/dashboard/activity")).body as { entityType: string }[]).map((x) => x.entityType).sort();

beforeEach(() => {
  h.user = { id: "u", role: "LECTEUR" }; h.modules = []; h.rattaches = 0; h.requetes = [];
  h.lignes = [
    ligne("1", "Troncon"), ligne("2", "JeuDonneesProjet"), ligne("3", "ReferentConcessionnaire"), ligne("4", "TacheProjetVoirie"), ligne("5", "RecolementProjetVoirie"),
    ligne("6", "AssociationsReseau"), ligne("7", "User"), ligne("8", "TypeInconnuDuModule"), ligne("9", "Chantier"), ligne("10", "DemandeConcessionnaire"),
  ];
});

describe("m5 : GET /dashboard/activity filtre par modules autorises", () => {
  it("un ADMIN voit tout, sans filtre (comportement inchange)", async () => {
    h.user = { id: "a", role: "ADMIN" };
    expect(await types()).toHaveLength(10);
    expect((h.requetes[0] as { where?: unknown }).where).toBeUndefined();
  });

  it("un compte qui n'a que la cle dashboard ne voit AUCUNE ligne d'audit des autres modules", async () => {
    h.modules = ["dashboard"];
    expect(await types()).toEqual([]);
  });

  it("un compte voit les types des seuls modules autorises : troncons et chantiers, ni le module Projets de voirie, ni User, ni un type inconnu", async () => {
    h.modules = ["dashboard", "troncons", "chantiers"];
    expect(await types()).toEqual(["Chantier", "Troncon"]);
  });

  it("avec la cle projets-voirie (compte non rattache) : les types du module, pas ceux des autres modules", async () => {
    h.modules = ["dashboard", "projets-voirie"];
    expect(await types()).toEqual(["AssociationsReseau", "DemandeConcessionnaire", "JeuDonneesProjet", "RecolementProjetVoirie", "ReferentConcessionnaire", "TacheProjetVoirie"]);
  });

  it("un compte RATTACHE a un concessionnaire (referent) ne voit aucun type du module, meme avec la cle ; ses autres modules restent visibles", async () => {
    h.modules = ["dashboard", "projets-voirie", "troncons"];
    h.rattaches = 1;
    expect(await types()).toEqual(["Troncon"]);
  });

  it("un type reserve a l'ADMIN (User) ou absent de la table n'est montre a personne d'autre (echec ferme)", async () => {
    h.modules = ["dashboard", "troncons", "chantiers", "projets-voirie", "documents"];
    const vus = await types();
    expect(vus).not.toContain("User");
    expect(vus).not.toContain("TypeInconnuDuModule");
  });
});
