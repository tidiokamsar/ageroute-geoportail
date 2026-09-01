import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { searchRouter } from "./search.routes";

/**
 * Non-regression de P0-SEC-01 : /api/search interrogeait cinq types d'entites sans
 * regarder les modules autorises du compte. Un utilisateur restreint aux troncons
 * obtenait ainsi les ouvrages, postes et chantiers en appelant l'API directement.
 *
 * Ces tests passent par la vraie chaine HTTP (express + requireAuth + le routeur) :
 * seules la verification du jeton et la base sont simulees. Un test qui appellerait
 * le gestionnaire en contournant les middlewares ne prouverait rien sur le controle
 * d'acces, puisque c'est precisement la qu'il se joue.
 */

// Jeton = payload JSON encode : la verification cryptographique n'est pas l'objet du
// test, l'identite portee par le jeton l'est.
vi.mock("../../utils/jwt", () => ({
  verifyAccessToken: vi.fn((token: string) => JSON.parse(Buffer.from(token, "base64url").toString("utf8"))),
}));

const compte = {
  id: "u1",
  role: "GESTIONNAIRE" as string,
  email: "agent@ageroute.gov.gn",
  modulesAutorises: [] as string[],
};

const appels = {
  troncon: 0,
  ouvrage: 0,
  pointNoir: 0,
  poste: 0,
  chantier: 0,
};

vi.mock("../../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => ({ modulesAutorises: compte.modulesAutorises })),
    },
    troncon: {
      findMany: vi.fn(async () => {
        appels.troncon++;
        return [{ id: "t1", code: "GN N0001", nom: "RN1" }];
      }),
    },
    ouvrage: {
      findMany: vi.fn(async () => {
        appels.ouvrage++;
        return [{ id: "o1", nom: "Pont de Kankan" }];
      }),
    },
    pointNoir: {
      findMany: vi.fn(async () => {
        appels.pointNoir++;
        return [{ id: "p1", description: "Virage accidentogène" }];
      }),
    },
    poste: {
      findMany: vi.fn(async () => {
        appels.poste++;
        return [{ id: "s1", nom: "Péage de Coyah" }];
      }),
    },
    chantier: {
      findMany: vi.fn(async () => {
        appels.chantier++;
        return [{ id: "c1", intitule: "Réhabilitation RN1" }];
      }),
    },
  },
}));


function jeton() {
  return Buffer.from(JSON.stringify({ sub: compte.id, role: compte.role, email: compte.email })).toString("base64url");
}

function app() {
  const a = express();
  a.use("/api/search", searchRouter);
  return a;
}

function typesRetournes(body: { type: string }[]) {
  return [...new Set(body.map((r) => r.type))].sort();
}

beforeEach(() => {
  compte.role = "GESTIONNAIRE";
  compte.modulesAutorises = [];
  Object.keys(appels).forEach((k) => ((appels as Record<string, number>)[k] = 0));
});

describe("GET /api/search — cloisonnement par module", () => {
  it("refuse l'appel sans jeton", async () => {
    const res = await request(app()).get("/api/search?q=RN");
    expect(res.status).toBe(401);
  });

  it("GESTIONNAIRE restreint aux tronçons ne reçoit que des tronçons", async () => {
    compte.modulesAutorises = ["troncons"];
    const res = await request(app()).get("/api/search?q=RN").set("Authorization", `Bearer ${jeton()}`);

    expect(res.status).toBe(200);
    expect(typesRetournes(res.body)).toEqual(["troncon"]);
  });

  it("GESTIONNAIRE restreint aux tronçons n'interroge même pas les autres tables", async () => {
    compte.modulesAutorises = ["troncons"];
    await request(app()).get("/api/search?q=RN").set("Authorization", `Bearer ${jeton()}`);

    // Le cloisonnement doit se faire avant la requete, pas par filtrage du resultat :
    // sinon la donnee interdite transite quand meme par le serveur.
    expect(appels.troncon).toBe(1);
    expect(appels.ouvrage).toBe(0);
    expect(appels.pointNoir).toBe(0);
    expect(appels.poste).toBe(0);
    expect(appels.chantier).toBe(0);
  });

  it("un compte restreint aux ouvrages ne reçoit aucun tronçon", async () => {
    compte.role = "LECTEUR";
    compte.modulesAutorises = ["ouvrages"];
    const res = await request(app()).get("/api/search?q=pont").set("Authorization", `Bearer ${jeton()}`);

    expect(typesRetournes(res.body)).toEqual(["ouvrage"]);
  });

  it("plusieurs modules autorisés donnent exactement ces types", async () => {
    compte.modulesAutorises = ["troncons", "chantiers"];
    const res = await request(app()).get("/api/search?q=RN").set("Authorization", `Bearer ${jeton()}`);

    expect(typesRetournes(res.body)).toEqual(["chantier", "troncon"]);
  });

  it("une liste vide vaut absence de restriction — comportement historique conservé", async () => {
    compte.modulesAutorises = [];
    const res = await request(app()).get("/api/search?q=RN").set("Authorization", `Bearer ${jeton()}`);

    expect(typesRetournes(res.body)).toEqual(["chantier", "ouvrage", "pointNoir", "poste", "troncon"]);
  });

  it("ADMIN n'est jamais restreint, même avec une liste de modules", async () => {
    compte.role = "ADMIN";
    compte.modulesAutorises = ["troncons"];
    const res = await request(app()).get("/api/search?q=RN").set("Authorization", `Bearer ${jeton()}`);

    expect(typesRetournes(res.body)).toEqual(["chantier", "ouvrage", "pointNoir", "poste", "troncon"]);
  });

  it("rejette une requête sans terme de recherche", async () => {
    const res = await request(app()).get("/api/search").set("Authorization", `Bearer ${jeton()}`);
    expect(res.status).not.toBe(200);
  });
});
