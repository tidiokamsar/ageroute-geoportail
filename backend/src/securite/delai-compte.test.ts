import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Delai de la lecture du compte (relecture D9, point 7b) : un resolveur qui ne repond JAMAIS ne laisse plus la requete
 * pendante, il donne 503 `SERVICE_INDISPONIBLE` (jamais 401 : un 401 ferme la session locale d'un telephone).
 *
 * Les minuteurs sont simules : le test n'attend pas trois secondes reelles.
 */

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://127.0.0.1:1/essai";
  process.env.JWT_ACCESS_SECRET = "essai-access-secret-essai-access-secret-0000";
  process.env.JWT_REFRESH_SECRET = "essai-refresh-secret-essai-refresh-secret-000";
  process.env.CORS_ORIGIN = "http://localhost:5173";
});
vi.mock("../lib/prisma", () => ({ prisma: { user: { findUnique: vi.fn() } } }));

import { requireAuth, _installerResolveurCompte, DELAI_RESOLVEUR_COMPTE_MS } from "../middleware/auth.middleware";
import { signAccessToken } from "../utils/jwt";

const jeton = signAccessToken({ sub: "11111111-1111-4111-8111-111111111111", role: "GESTIONNAIRE" as never, email: "a@b.invalid" });
const compteActif = { actif: true, lockedUntil: null, role: "GESTIONNAIRE" as const, email: "a@b.invalid" };

/** Appelle le middleware directement (supertest et les faux minuteurs se marchent dessus). */
async function appeler() {
  const res = { statusCode: 0, corps: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.corps = b; return this; } };
  const req = { headers: { authorization: `Bearer ${jeton}` } } as unknown as express.Request;
  const suite = vi.fn();
  const fin = requireAuth(req, res as unknown as express.Response, suite);
  return { res, req, suite, fin };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); _installerResolveurCompte(null); });

describe("delai de la lecture du compte", () => {
  it("le delai est de 3 secondes (provisoire)", () => {
    expect(DELAI_RESOLVEUR_COMPTE_MS).toBe(3000);
  });

  it("un resolveur qui ne repond jamais : 503 SERVICE_INDISPONIBLE apres le delai, pas avant, jamais 401", async () => {
    _installerResolveurCompte(() => new Promise(() => { /* ne rend jamais */ }));
    const { res, suite, fin } = await appeler();
    await vi.advanceTimersByTimeAsync(DELAI_RESOLVEUR_COMPTE_MS - 1);
    expect(res.statusCode).toBe(0); // pas encore tranche
    await vi.advanceTimersByTimeAsync(2);
    await fin;
    expect(res.statusCode).toBe(503);
    expect(res.corps).toMatchObject({ code: "SERVICE_INDISPONIBLE" });
    expect(suite).not.toHaveBeenCalled();
  });

  it("un resolveur rapide : la requete passe, et le minuteur est nettoye (aucun minuteur en attente)", async () => {
    _installerResolveurCompte(async () => compteActif);
    const { req, suite, fin } = await appeler();
    await fin;
    expect(suite).toHaveBeenCalledOnce();
    expect((req as unknown as { user: { role: string } }).user.role).toBe("GESTIONNAIRE");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("un resolveur tardif qui finit apres le delai ne change pas la reponse deja donnee (503) et ne leve rien", async () => {
    let rendre: (c: typeof compteActif) => void = () => undefined;
    _installerResolveurCompte(() => new Promise((r) => { rendre = r as typeof rendre; }));
    const { res, suite, fin } = await appeler();
    await vi.advanceTimersByTimeAsync(DELAI_RESOLVEUR_COMPTE_MS + 1);
    await fin;
    rendre(compteActif);
    await vi.advanceTimersByTimeAsync(10);
    expect(res.statusCode).toBe(503);
    expect(suite).not.toHaveBeenCalled();
  });

  it("un resolveur en erreur rapide reste un 503 (comportement d'avant)", async () => {
    _installerResolveurCompte(async () => { throw new Error("connexion perdue"); });
    const { res, fin } = await appeler();
    await fin;
    expect(res.statusCode).toBe(503);
  });

  it("un compte desactive reste un 401 COMPTE_INACTIF (le delai ne masque pas ce cas)", async () => {
    _installerResolveurCompte(async () => ({ ...compteActif, actif: false }));
    const { res, fin } = await appeler();
    await fin;
    expect(res.statusCode).toBe(401);
    expect(res.corps).toMatchObject({ code: "COMPTE_INACTIF" });
  });
});

describe("le montage reel reste fonctionnel avec le delai (supertest, minuteurs reels)", () => {
  it("une route authentifiee repond 200 avec un resolveur immediat", async () => {
    vi.useRealTimers();
    _installerResolveurCompte(async () => compteActif);
    const a = express();
    a.get("/x", requireAuth, (_q, s) => { s.json({ ok: true }); });
    expect((await request(a).get("/x").set("Authorization", `Bearer ${jeton}`)).status).toBe(200);
  });
});
