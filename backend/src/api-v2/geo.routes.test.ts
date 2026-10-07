import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `/api/v2/geo/match` — la surface qui expose le moteur d'appariement.
 *
 * CE QUE CES TESTS DEFENDENT
 *
 * Deux choses, et aucune n'est une precaution de principe.
 *
 * LE REFUS EST UNE REPONSE, PAS UNE PANNE. Le moteur rend `null` quand la qualite GPS
 * ou la densite du reseau ne permettent pas de conclure — en urbain, c'est le cas de
 * 38 points sur 41 a 15 m de bruit. Si la route repondait 404 ou 422, un client
 * traiterait ce refus comme une erreur transitoire et reessaierait en boucle, alors
 * qu'il doit demander a l'agent. D'ou un 200 portant `apparie: false`.
 *
 * LE LOT EST PLAFONNE. Apparier un point contre le reseau national coute 2,5 s
 * mesurees. Le 07/10, une requete de 200 points lancee sans y penser a occupe la base
 * de production dix-sept minutes et il a fallu l'interrompre. Exposer ce lot sans
 * plafond, c'est offrir la meme erreur a n'importe quel appelant.
 */

const compte = { id: "u1", role: "INSPECTEUR" as string };

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: compte.id, role: compte.role };
    next();
  },
}));

vi.mock("../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_r: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));

/** Appels recus par le moteur, pour verifier ce que la route lui transmet. */
const appels: unknown[] = [];
/** File de reponses : un `null` simule un refus de conclure. */
const reponses: (unknown | null)[] = [];

vi.mock("../geo/appariement", async (importOriginal) => {
  const original = await importOriginal<typeof import("../geo/appariement")>();
  return {
    ...original,
    apparier: vi.fn(async (position: unknown, options: unknown) => {
      appels.push({ position, options });
      return reponses.length ? reponses.shift() : null;
    }),
  };
});

import { geoV2Router, LOT_MAX } from "./geo.routes";

const apparie = {
  tronconId: "t1", code: "RN1-001", nom: "RN1", classe: "RN",
  distanceM: 4.2, pk: 12.5, pkMotif: "CALCULE", confiance: 0.82, ambigu: false,
};

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/v2/geo", geoV2Router);
  // Gestionnaire minimal : une entree invalide doit donner 400, pas une pile.
  a.use((err: Error & { name?: string }, _rq: express.Request, rs: express.Response, _n: express.NextFunction) => {
    rs.status(err.name === "ZodError" ? 400 : 500).json({ erreur: err.name });
  });
  return a;
}

beforeEach(() => { appels.length = 0; reponses.length = 0; compte.role = "INSPECTEUR"; });

describe("POST /match — un point", () => {
  it("rend l'appariement quand le moteur conclut", async () => {
    reponses.push(apparie);
    const r = await request(app()).post("/api/v2/geo/match").send({ lat: 9.6, lon: -13.5, precisionM: 5 });

    expect(r.status).toBe(200);
    expect(r.body.apparie).toBe(true);
    expect(r.body.code).toBe("RN1-001");
    expect(r.body.pk).toBe(12.5);
  });

  it("rend 200 et apparie:false quand il ne conclut PAS", async () => {
    // Le point central. Un 404 ferait reessayer un client qui doit, lui, demander
    // a l'agent de confirmer la route.
    const r = await request(app()).post("/api/v2/geo/match").send({ lat: 9.6, lon: -13.5 });

    expect(r.status).toBe(200);
    expect(r.body.apparie).toBe(false);
    expect(r.body.motif).toBe("AUCUN_CANDIDAT_SUR");
  });

  it("transmet la precision GPS au moteur", async () => {
    reponses.push(apparie);
    await request(app()).post("/api/v2/geo/match").send({ lat: 9.6, lon: -13.5, precisionM: 22 });
    expect((appels[0] as { position: { precisionM: number } }).position.precisionM).toBe(22);
  });

  it("transmet l'emprise, qui est ce qui rend l'appariement rapide", async () => {
    reponses.push(apparie);
    await request(app()).post("/api/v2/geo/match")
      .send({ lat: 9.6, lon: -13.5, emprise: "POLYGON((0 0,1 0,1 1,0 1,0 0))" });
    expect((appels[0] as { options: { emprise: string } }).options.emprise).toContain("POLYGON");
  });

  it("refuse des coordonnees hors du domaine terrestre", async () => {
    for (const mauvais of [{ lat: 91, lon: 0 }, { lat: 0, lon: 181 }, { lat: "9.6", lon: -13.5 }]) {
      expect((await request(app()).post("/api/v2/geo/match").send(mauvais)).status).toBe(400);
    }
  });

  it("refuse une precision absurde plutot que de la propager", async () => {
    expect((await request(app()).post("/api/v2/geo/match")
      .send({ lat: 9.6, lon: -13.5, precisionM: -1 })).status).toBe(400);
  });
});

describe("POST /match/batch — un lot", () => {
  it("apparie chaque point et compte les refus", async () => {
    reponses.push(apparie, null, apparie);
    const r = await request(app()).post("/api/v2/geo/match/batch").send({
      points: [{ lat: 9.6, lon: -13.5, ref: "a" }, { lat: 9.7, lon: -13.4, ref: "b" }, { lat: 9.8, lon: -13.3, ref: "c" }],
    });

    expect(r.status).toBe(200);
    expect(r.body.total).toBe(3);
    expect(r.body.apparies).toBe(2);
    // Le decompte des refus dit a un responsable que la couverture GPS d'une mission
    // etait mauvaise, ou que la zone est trop dense pour conclure.
    expect(r.body.nonApparies).toBe(1);
  });

  it("rend la reference de chaque point, pour que l'appelant recolle", async () => {
    reponses.push(apparie, null);
    const r = await request(app()).post("/api/v2/geo/match/batch")
      .send({ points: [{ lat: 9.6, lon: -13.5, ref: "p1" }, { lat: 9.7, lon: -13.4, ref: "p2" }] });

    expect(r.body.resultats.map((x: { ref: string }) => x.ref)).toEqual(["p1", "p2"]);
    expect(r.body.resultats[1].apparie).toBe(false);
  });

  it("PLAFONNE le lot", async () => {
    // 2,5 s par point contre le reseau national : un lot non borne occupe la base de
    // production pendant des dizaines de minutes. C'est arrive le 07/10.
    const trop = Array.from({ length: LOT_MAX + 1 }, () => ({ lat: 9.6, lon: -13.5 }));
    expect((await request(app()).post("/api/v2/geo/match/batch").send({ points: trop })).status).toBe(400);
  });

  it("accepte exactement le plafond", async () => {
    const pile = Array.from({ length: LOT_MAX }, () => ({ lat: 9.6, lon: -13.5 }));
    const r = await request(app()).post("/api/v2/geo/match/batch").send({ points: pile });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(LOT_MAX);
  });

  it("refuse un lot vide", async () => {
    expect((await request(app()).post("/api/v2/geo/match/batch").send({ points: [] })).status).toBe(400);
  });

  it("appelle le moteur en SERIE, pas en parallele", async () => {
    // Un Promise.all de 200 appariements ouvrirait 200 requetes simultanees sur le
    // pool que la carte publique partage : le lot irait vite et tout le reste
    // attendrait, y compris les visiteurs du site public.
    reponses.push(apparie, apparie, apparie);
    await request(app()).post("/api/v2/geo/match/batch")
      .send({ points: [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }, { lat: 3, lon: 3 }] });

    expect(appels).toHaveLength(3);
    expect(appels.map((a) => (a as { position: { lat: number } }).position.lat)).toEqual([1, 2, 3]);
  });

  it("partage une seule emprise pour tout le lot", async () => {
    reponses.push(apparie, apparie);
    await request(app()).post("/api/v2/geo/match/batch").send({
      points: [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }],
      emprise: "POLYGON((0 0,1 0,1 1,0 1,0 0))",
    });
    for (const a of appels) {
      expect((a as { options: { emprise: string } }).options.emprise).toContain("POLYGON");
    }
  });
});
