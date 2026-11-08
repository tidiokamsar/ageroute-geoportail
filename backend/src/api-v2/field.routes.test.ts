import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `GET /api/v2/field/current-context` — la surface qui repond « ou suis-je ».
 *
 * CE QUE CES TESTS DEFENDENT
 *
 * UN REFUS DE CONCLURE EST UN 200. Comme pour `/geo/match` : rendre 404 ou 422 quand le
 * GPS ne tranche pas pousserait le client a reessayer en boucle alors qu'il doit demander
 * a l'agent. Le contexte est TOUJOURS rendu, avec ses absences et leurs motifs.
 *
 * LA ROUTE NE LIT PAS LA BASE ELLE-MEME. Elle valide, compose, et rend. Le raisonnement
 * est teste dans `field/contexte.test.ts` sans base ; ici on verifie le CONTRAT HTTP et ce
 * que la route transmet reellement au service.
 *
 * LE PLAFOND DU RAYON. Un rayon non borne ferait balayer les 1 172 ouvrages du pays pour
 * repondre a un agent qui regarde devant lui. 2 km est la borne ; au-dela ce n'est plus du
 * terrain.
 */

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: "u1", role: "INSPECTEUR" };
    next();
  },
}));

vi.mock("../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_r: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));

const h = vi.hoisted(() => ({
  appels: [] as { position: unknown; options: unknown }[],
  reponse: null as unknown,
}));

vi.mock("../field/contexte.prisma", () => ({ sourcesPrisma: {} }));

vi.mock("../field/contexte", () => ({
  RAYON_ACTIFS_M: 150,
  contexteTerrain: async (position: unknown, _sources: unknown, options: unknown) => {
    h.appels.push({ position, options });
    return h.reponse;
  },
}));

import { fieldV2Router } from "./field.routes";

function app() {
  const a = express();
  a.use("/api/v2/field", fieldV2Router);
  a.use((err: unknown, _rq: express.Request, rs: express.Response, _n: express.NextFunction) => {
    const nom = err instanceof Error ? err.name : "";
    rs.status(nom === "ZodError" ? 400 : 500).json({ erreur: nom });
  });
  return a;
}

const CONTEXTE_VIDE = {
  position: { lat: 9.5, lon: -13.7 },
  troncon: null,
  motifSansTroncon: "AUCUN_CANDIDAT_SUR",
  portion: null,
  motifSansPortion: null,
  couverture: null,
  actifsProches: [],
  ambigu: false,
};

beforeEach(() => {
  h.appels.length = 0;
  h.reponse = CONTEXTE_VIDE;
});

describe("Le contrat HTTP", () => {
  it("rend 200 ET un motif quand rien n'a pu etre apparie", async () => {
    // Un 404 ferait reessayer le client en boucle, alors qu'il doit demander a l'agent.
    const r = await request(app()).get("/api/v2/field/current-context?lat=9.5&lon=-13.7");
    expect(r.status).toBe(200);
    expect(r.body.troncon).toBeNull();
    expect(r.body.motifSansTroncon).toBe("AUCUN_CANDIDAT_SUR");
  });

  it("transmet la position et la precision telles qu'elles arrivent", async () => {
    await request(app()).get("/api/v2/field/current-context?lat=9.5&lon=-13.7&precisionM=4.5");
    expect(h.appels[0].position).toEqual({ lat: 9.5, lon: -13.7, precisionM: 4.5 });
  });

  it("transmet l'emprise, qui fait passer l'appariement de 2,5 s a 19 ms", async () => {
    await request(app()).get(
      "/api/v2/field/current-context?lat=9.5&lon=-13.7&emprise=POLYGON((0%200,1%200,1%201,0%201,0%200))",
    );
    expect(h.appels[0].options).toMatchObject({
      appariement: { emprise: "POLYGON((0 0,1 0,1 1,0 1,0 0))" },
    });
  });

  it("applique le rayon d'actifs par defaut quand il n'est pas demande", async () => {
    await request(app()).get("/api/v2/field/current-context?lat=9.5&lon=-13.7");
    expect(h.appels[0].options).toMatchObject({ rayonActifsM: 150 });
  });
});

describe("Ce que la route refuse", () => {
  it("REFUSE une latitude hors du monde", async () => {
    const r = await request(app()).get("/api/v2/field/current-context?lat=95&lon=-13.7");
    expect(r.status).toBe(400);
    expect(h.appels).toHaveLength(0);
  });

  it("REFUSE une position absente au lieu de prendre une valeur par defaut", async () => {
    // Un contexte calcule depuis (0, 0) repondrait pour le golfe de Guinee.
    const r = await request(app()).get("/api/v2/field/current-context?lon=-13.7");
    expect(r.status).toBe(400);
  });

  it("REFUSE un rayon d'actifs au-dela de 2 km", async () => {
    // Sans borne, un appel ferait balayer les 1 172 ouvrages du pays.
    const r = await request(app()).get(
      "/api/v2/field/current-context?lat=9.5&lon=-13.7&rayonActifsM=500000",
    );
    expect(r.status).toBe(400);
  });

  it("REFUSE un reseau inconnu plutot que de l'ignorer en silence", async () => {
    const r = await request(app()).get(
      "/api/v2/field/current-context?lat=9.5&lon=-13.7&reseau=tous-les-chemins",
    );
    expect(r.status).toBe(400);
  });
});

describe("Ce que la route rend quand tout est connu", () => {
  it("rend le troncon, la portion, la couverture et les actifs", async () => {
    h.reponse = {
      position: { lat: 9.5, lon: -13.7 },
      troncon: { tronconId: "t-1", code: "GN N0001 3-1216", abscisseM: 10_000, pk: 10, pkMotif: "CALCULE", confiance: 0.91 },
      motifSansTroncon: null,
      portion: { id: "p-b", debutM: 8_000, finM: 13_000, etat: "MAUVAIS" },
      motifSansPortion: null,
      couverture: { longueurTronconM: 20_000, qualifieM: 15_000, part: 0.75, trous: [] },
      actifsProches: [{ id: "o-1", type: "PONT", nom: "Pont de la Moribaya", distanceM: 40 }],
      ambigu: false,
    };
    const r = await request(app()).get("/api/v2/field/current-context?lat=9.5&lon=-13.7");
    expect(r.status).toBe(200);
    expect(r.body.troncon.code).toBe("GN N0001 3-1216");
    expect(r.body.portion.id).toBe("p-b");
    expect(r.body.couverture.part).toBe(0.75);
    expect(r.body.actifsProches).toHaveLength(1);
  });

  it("transmet l'ambiguite, pour que l'ecran propose un choix", async () => {
    h.reponse = { ...CONTEXTE_VIDE, ambigu: true };
    const r = await request(app()).get("/api/v2/field/current-context?lat=9.5&lon=-13.7");
    expect(r.body.ambigu).toBe(true);
  });
});
