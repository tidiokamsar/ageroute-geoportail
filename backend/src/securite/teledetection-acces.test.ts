import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * INVENTAIRE D'ACCES de `/api/v2/teledetection` (EO-API). Ce test ENUMERE les routes du routeur au lieu de les recopier : une route
 * ajoutee demain sans la garde du module `teledetection` fait echouer ce test sans qu'on ait pense a l'y inscrire.
 *
 *   - un compte authentifie SANS la cle `teledetection` recoit 403 MODULE_NON_AUTORISE sur CHAQUE route, quel que soit le verbe ;
 *   - un compte AVEC la cle passe cette garde (il peut etre refuse plus loin, par son role ou la validation : jamais par le module) ;
 *   - un appel sans jeton recoit 401 sur chaque route (le cas general est couvert par routes-authentifiees.test.ts).
 * Gardes reelles, base simulee.
 */

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://127.0.0.1:1/essai";
  process.env.JWT_ACCESS_SECRET = "essai-access-secret-essai-access-secret-0000";
  process.env.JWT_REFRESH_SECRET = "essai-refresh-secret-essai-refresh-secret-000";
});

const h = vi.hoisted(() => ({ modules: ["troncons"] as string[] }));

vi.mock("../lib/prisma", () => {
  const fantome = (): unknown => new Proxy(function () {}, { get: (_c, p) => (p === "then" || typeof p === "symbol" ? undefined : fantome()), apply: () => Promise.resolve([]) });
  return { prisma: new Proxy({}, { get: (_c, p) => (p === "user" ? { findUnique: async () => ({ modulesAutorises: h.modules, actif: true, lockedUntil: null, role: "GESTIONNAIRE", email: "x@y.z" }) } : fantome()) }) };
});

import { teledetectionV2Router } from "../api-v2/teledetection.routes";
import { signAccessToken } from "../utils/jwt";

interface Route { methode: string; chemin: string }

function routesDuRouteur(): Route[] {
  const sortie: Route[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const couche of (teledetectionV2Router as any).stack as any[]) {
    if (!couche.route) continue;
    for (const m of Object.keys(couche.route.methods).filter((k) => couche.route.methods[k])) {
      sortie.push({ methode: m, chemin: String(couche.route.path).replace(/:id/g, "00000000-0000-4000-8000-000000000001").replace(/:code/g, "SENTINEL2") });
    }
  }
  return sortie;
}

const app = express();
app.use(express.json());
app.use("/api/v2/teledetection", teledetectionV2Router);
const jeton = (role: "GESTIONNAIRE" | "ADMIN") => signAccessToken({ sub: "u-1", role, email: "x@y.z" });
const envoyer = (r: Route, t?: string) => {
  let q = (request(app) as unknown as Record<string, (u: string) => request.Test>)[r.methode](`/api/v2/teledetection${r.chemin}`);
  if (t) q = q.set("Authorization", `Bearer ${t}`);
  return r.methode === "get" ? q : q.send({});
};

describe("routes de /api/v2/teledetection", () => {
  const routes = routesDuRouteur();

  it("sont enumerees (plancher : un routeur vide ou une enumeration tronquee ne passerait pas)", () => {
    expect(routes.length).toBeGreaterThanOrEqual(16);
    expect(routes.map((r) => `${r.methode} ${r.chemin.replace(/00000000-0000-4000-8000-000000000001/, ":id").replace("SENTINEL2", ":code")}`)).toEqual(expect.arrayContaining([
      "get /synthese", "get /propositions", "get /propositions.geojson", "get /propositions/:id", "get /produits", "get /produits/:id/apercu", "get /sources", "get /precision",
      "get /qualite-methodes", "post /propositions/:id/transition", "post /propositions/:id/verification", "post /propositions/:id/preuves", "post /sources/:code/verifier",
      "post /sources/:code/synchroniser-catalogue", "post /produits", "post /propositions",
    ]));
  });

  it("sans jeton : 401 sur chacune", async () => {
    for (const r of routes) expect((await envoyer(r)).status, `${r.methode} ${r.chemin}`).toBe(401);
  });

  it("sans la cle de module `teledetection` : 403 MODULE_NON_AUTORISE sur chacune, GET comme POST", async () => {
    h.modules = ["troncons", "ouvrages"];
    for (const r of routes) {
      const rep = await envoyer(r, jeton("GESTIONNAIRE"));
      expect(rep.status, `${r.methode} ${r.chemin}`).toBe(403);
      expect(rep.body.code, `${r.methode} ${r.chemin}`).toBe("MODULE_NON_AUTORISE");
    }
  });

  it("avec la cle : la garde du module ne refuse plus (le refus eventuel vient du role, du perimetre ou de la validation)", async () => {
    h.modules = ["teledetection"];
    for (const r of routes) {
      const rep = await envoyer(r, jeton("GESTIONNAIRE"));
      expect(rep.body?.code, `${r.methode} ${r.chemin}`).not.toBe("MODULE_NON_AUTORISE");
      expect(rep.body?.code, `${r.methode} ${r.chemin}`).not.toBe("NON_AUTHENTIFIE");
    }
  });

  it("l'ADMIN n'a pas besoin de la cle (il ne peut pas se bloquer lui-meme)", async () => {
    h.modules = [];
    for (const r of routes) expect((await envoyer(r, jeton("ADMIN"))).body?.code, `${r.methode} ${r.chemin}`).not.toBe("MODULE_NON_AUTORISE");
  });
});
