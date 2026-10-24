import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `GET /api/dashboard/kpis` : les nombres partages avec le registre viennent du registre (A12).
 * Le chiffre affiche est donc celui qui a une requete de controle, pas une seconde implementation ;
 * et un indicateur en erreur fait echouer la route (500) au lieu de s'afficher comme un zero.
 */

const h = vi.hoisted(() => ({ valeurs: {} as Record<string, number | null>, erreur: false, codesDemandes: [] as string[], sansSource: false }));

vi.mock("../../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => { (req as unknown as { user: unknown }).user = { id: "u", role: "LECTEUR" }; n(); },
}));
vi.mock("../../middleware/module-access.middleware", () => ({ requireModuleAccess: () => (_q: express.Request, _r: express.Response, n: express.NextFunction) => n() }));
vi.mock("../../lib/reseau", () => ({
  WHERE_RESEAU_CLASSE: {},
  longueurReseau: async () => ({ metier: { totalKm: 1, tronconsRenseignes: 1, tronconsTotal: 1, tronconsDerives: 0, couverturePct: 100 }, geometrique: { totalKm: 2, methode: "m" }, parClasse: [] }),
}));
vi.mock("../../engines/decision.estimation", () => ({ estimerPourDecision: () => ({}) }));
vi.mock("../../lib/prisma", () => {
  const groupe = async () => [];
  return {
    prisma: {
      troncon: { groupBy: groupe, aggregate: async () => ({ _sum: { longueurKm: 12 } }), count: async () => 0 },
      ouvrage: { groupBy: groupe, count: async () => 0 },
      chantier: { groupBy: groupe },
      valeurQualite: { groupBy: async () => [{ statut: "OBSERVED", _count: { _all: 2 } }, { statut: "UNKNOWN", _count: { _all: 3 } }] },
    },
  };
});
vi.mock("../../tableau-de-bord/indicateurs.registre", () => ({ REGISTRE: [] }));
vi.mock("../../tableau-de-bord/tableau-de-bord.service", () => ({
  evaluer: async (_d: unknown, _r: unknown, portee: { regions: unknown }, filtre: { codes: string[]; sansSource?: boolean }) => {
    h.codesDemandes = filtre.codes; h.sansSource = filtre.sansSource === true;
    expect(portee.regions).toBeNull();
    return filtre.codes.map((code) => ({
      code, statut: h.erreur && code === "postes" ? "ERREUR" : "CALCULE", valeur: h.erreur && code === "postes" ? null : h.valeurs[code] ?? 0,
    }));
  },
}));

import { dashboardRouter } from "./dashboard.routes";

const app = express();
app.use("/dashboard", dashboardRouter);
app.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: "erreur interne" }); });

beforeEach(() => {
  h.valeurs = {
    troncons_classes: 1691, ouvrages_inventories: 126, points_noirs: 40, postes: 12, documents: 7, chantiers_en_cours: 5,
    troncons_mauvais_critique: 100, ouvrages_mauvais_critique: 20, portions_validees: 3, portions_validees_km: 4.26,
  };
  h.erreur = false; h.codesDemandes = []; h.sansSource = false;
});

describe("GET /dashboard/kpis", () => {
  it("les nombres partages viennent du registre, en national, sans interroger les tables sources", async () => {
    const r = await request(app).get("/dashboard/kpis");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      tronconsCount: 1691, ouvragesCount: 126, pointsNoirsCount: 40, postesCount: 12, documentsCount: 7, chantiersEnCours: 5,
      alertesCount: 120,
      portions: { validees: 3, kmValides: 4.3, avertissement: null },
    });
    expect(h.codesDemandes.sort()).toEqual([
      "chantiers_en_cours", "documents", "ouvrages_inventories", "ouvrages_mauvais_critique", "points_noirs", "portions_validees",
      "portions_validees_km", "postes", "troncons_classes", "troncons_mauvais_critique",
    ]);
    expect(h.sansSource).toBe(true);
  });

  it("dit toujours son perimetre, et ne l'appelle pas « reseau national »", async () => {
    const r = await request(app).get("/dashboard/kpis");
    expect(r.body.perimetre).toMatchObject({ code: "RESEAU_CLASSE_SAISI", libelle: "Réseau classé saisi" });
    expect(r.body.perimetre.libelle).not.toMatch(/national/i);
  });

  it("zero portion validee : l'avertissement est rendu", async () => {
    h.valeurs.portions_validees = 0; h.valeurs.portions_validees_km = 0;
    const r = await request(app).get("/dashboard/kpis");
    expect(r.body.portions.avertissement).toMatch(/Aucune portion validée/);
  });

  it("un indicateur en erreur fait echouer la route : pas de zero fabrique", async () => {
    h.erreur = true;
    const r = await request(app).get("/dashboard/kpis");
    expect(r.status).toBe(500);
  });
});
