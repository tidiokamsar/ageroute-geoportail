import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Routes du registre des anomalies : ce que ces tests defendent (le comportement en base est eprouve par
 * `tests-integration/registre.integration.mts`).
 *   - un LECTEUR lit, il n'ecrit rien ; un GESTIONNAIRE ecrit dans son perimetre ;
 *   - l'analyse exige une portee ; la portee nationale est reservee a l'ADMIN ;
 *   - un refus du service sort avec son code et son statut HTTP ; un corps mal forme est un 400 ;
 *   - l'application est bornee a 100 corrections ; l'export CSV sort en piece jointe.
 */
const h = vi.hoisted(() => ({ user: { id: "g-1", role: "GESTIONNAIRE" }, appels: [] as { f: string; args: unknown[] }[] }));

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => { (req as unknown as { user: unknown }).user = { ...h.user }; next(); },
}));
vi.mock("../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
vi.mock("../territoire/territoire.v2", () => {
  const passe = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();
  return { territoireAnomalie: passe, territoireAnomaliesGroupe: passe, territoireAnalyseReferentiel: passe };
});
vi.mock("../referentiel/registre.service", async (orig) => {
  const vrai = await orig<typeof import("../referentiel/registre.service")>();
  const espion = (f: string, rendu: unknown = {}) => vi.fn(async (...args: unknown[]) => { h.appels.push({ f, args }); return rendu; });
  return {
    ...vrai,
    analyser: espion("analyser", { nouvelles: 3 }),
    lister: espion("lister", { data: [], total: 0 }),
    detail: espion("detail"),
    decider: vi.fn(async () => { throw new vrai.RefusRegistre(422, "AUTO_VALIDATION", "Une correction se valide par une autre personne."); }),
    previsualiser: espion("previsualiser", []),
    appliquer: espion("appliquer", { appliquees: 1 }),
    annuler: espion("annuler"),
    exporterCsv: espion("exporterCsv", "﻿anomalie\n"),
  };
});

import { referentielV2Router } from "./referentiel.routes";

const app = () => {
  const a = express();
  a.use(express.json());
  a.use("/api/v2/referentiel/troncons", referentielV2Router);
  a.use((err: { name?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(err.name === "ZodError" ? 400 : 500).json({}));
  return a;
};

beforeEach(() => { h.user = { id: "g-1", role: "GESTIONNAIRE" }; h.appels.length = 0; });

describe("analyse", () => {
  it("exige une portée", async () => {
    const r = await request(app()).post("/api/v2/referentiel/troncons/analyse").send({});
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("PORTEE_REQUISE");
    expect(h.appels).toHaveLength(0);
  });
  it("réserve la portée nationale à l'administrateur", async () => {
    expect((await request(app()).post("/api/v2/referentiel/troncons/analyse").send({ national: true })).status).toBe(403);
    h.user = { id: "a-1", role: "ADMIN" };
    const r = await request(app()).post("/api/v2/referentiel/troncons/analyse").send({ national: true });
    expect(r.status).toBe(200);
    expect(h.appels[0].args.slice(0, 2)).toEqual([{ regionId: null }, { ecartLongueurPct: 10, ecartPkPct: 10 }]);
  });
  it("une analyse régionale passe les seuils choisis", async () => {
    await request(app()).post("/api/v2/referentiel/troncons/analyse").send({ regionId: 4, ecartLongueurPct: 25 });
    expect(h.appels[0].args.slice(0, 3)).toEqual([{ regionId: 4 }, { ecartLongueurPct: 25, ecartPkPct: 10 }, "g-1"]);
  });
  it("un LECTEUR n'analyse pas, mais lit", async () => {
    h.user = { id: "l-1", role: "LECTEUR" };
    expect((await request(app()).post("/api/v2/referentiel/troncons/analyse").send({ regionId: 4 })).status).toBe(403);
    expect((await request(app()).get("/api/v2/referentiel/troncons/anomalies?statut=A_EXAMINER")).status).toBe(200);
    expect((await request(app()).post("/api/v2/referentiel/troncons/anomalies/x/decision").send({ statut: "REJETEE", commentaire: "faux positif" })).status).toBe(403);
    expect((await request(app()).post("/api/v2/referentiel/troncons/anomalies/application").send({ ids: ["x"] })).status).toBe(403);
  });
});

describe("lecture et export", () => {
  it("filtre par statut et règle, et refuse un statut inconnu", async () => {
    await request(app()).get("/api/v2/referentiel/troncons/anomalies?statut=VALIDEE&regle=PK_NON_RENSEIGNES&inclureDisparues=false");
    expect(h.appels[0].args[0]).toMatchObject({ statut: "VALIDEE", regle: "PK_NON_RENSEIGNES", inclureDisparues: false });
    expect((await request(app()).get("/api/v2/referentiel/troncons/anomalies?statut=SUPPRIMEE")).status).toBe(400);
  });
  it("l'export CSV sort en pièce jointe", async () => {
    const r = await request(app()).get("/api/v2/referentiel/troncons/anomalies.csv?regle=DOUBLON_POTENTIEL");
    expect(r.status).toBe(200);
    expect(r.headers["content-disposition"]).toMatch(/anomalies-referentiel-troncons\.csv/);
    expect(r.headers["content-type"]).toMatch(/text\/csv/);
  });
  it("le catalogue rend règles, statuts et transitions", async () => {
    const r = await request(app()).get("/api/v2/referentiel/troncons/regles");
    expect(r.body.regles.map((x: { code: string }) => x.code)).toContain("DOUBLON_POTENTIEL");
    expect(r.body.transitions.CORRIGEE).toEqual([]);
  });
});

describe("décisions et corrections", () => {
  it("un refus du service sort avec son code et son statut", async () => {
    const r = await request(app()).post("/api/v2/referentiel/troncons/anomalies/x/decision").send({ statut: "VALIDEE" });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("AUTO_VALIDATION");
  });
  it("un corps mal formé est un 400 (champ inconnu, statut inconnu)", async () => {
    expect((await request(app()).post("/api/v2/referentiel/troncons/anomalies/x/decision").send({ statut: "VALIDEE", supprimer: true })).status).toBe(400);
    expect((await request(app()).post("/api/v2/referentiel/troncons/anomalies/x/decision").send({ statut: "SUPPRIMEE" })).status).toBe(400);
  });
  it("l'application est bornée à 100 corrections", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `a${i}`);
    expect((await request(app()).post("/api/v2/referentiel/troncons/anomalies/application").send({ ids })).status).toBe(400);
    expect((await request(app()).post("/api/v2/referentiel/troncons/anomalies/application").send({ ids: ["a1", "a2"] })).status).toBe(200);
    expect(h.appels.find((a) => a.f === "appliquer")?.args.slice(0, 2)).toEqual([["a1", "a2"], "g-1"]);
  });
  it("la prévisualisation est ouverte à la lecture ; l'annulation exige un motif", async () => {
    h.user = { id: "l-1", role: "LECTEUR" };
    expect((await request(app()).post("/api/v2/referentiel/troncons/anomalies/previsualisation").send({ ids: ["a1"] })).status).toBe(200);
    h.user = { id: "g-1", role: "GESTIONNAIRE" };
    expect((await request(app()).post("/api/v2/referentiel/troncons/anomalies/a1/annulation").send({})).status).toBe(400);
  });
});
