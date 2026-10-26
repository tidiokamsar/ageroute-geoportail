import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Le compte est relu en base a chaque requete authentifiee (chantier D4, defaut 1 de
 * `docs/securite/SESSION-HORS-LIGNE.md` section 7, decision D-C1-10 de `CONTROLE-ACCES.md`).
 *
 * LE DEFAUT QUE CES TESTS REPRODUISENT
 *
 * `requireAuth` ne consultait pas la base : l'identite ET LE ROLE venaient du jeton d'acces
 * (15 minutes). Un compte desactive ou verrouille gardait ses droits jusqu'a l'expiration du jeton,
 * `sync/push` compris ; un compte retrograde de GESTIONNAIRE a LECTEUR ecrivait encore. Ces tests
 * ont ete ecrits AVANT le correctif et echouaient sur le code d'origine.
 *
 * CE QUI EST VRAI ICI, ET CE QUI NE L'EST PAS
 *
 * La verification cryptographique du jeton est REELLE (`verifyAccessToken`, secrets d'essai) ; seule
 * la base est simulee. Le comportement contre une vraie base est prouve par
 * `tests-integration/session-appareil.integration.mts`.
 */

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://127.0.0.1:1/essai";
  process.env.JWT_ACCESS_SECRET = "essai-access-secret-essai-access-secret-0000";
  process.env.JWT_REFRESH_SECRET = "essai-refresh-secret-essai-refresh-secret-000";
  process.env.CORS_ORIGIN = "http://localhost:5173";
});

const h = vi.hoisted(() => ({
  /** Ligne `users` telle que la base la rend ; `null` = compte supprime. */
  compte: null as Record<string, unknown> | null,
  baseIndisponible: false,
  lectures: [] as Array<Record<string, unknown>>,
  regions: [] as number[],
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async (args: Record<string, unknown>) => {
        h.lectures.push(args);
        if (h.baseIndisponible) throw new Error("connexion refusee");
        return h.compte;
      }),
    },
    $queryRaw: vi.fn(async () => h.regions.map((regionId) => ({ regionId }))),
  },
}));

import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { signAccessToken } from "../utils/jwt";
import { authRouter } from "../modules/auth/auth.routes";

const ID = "11111111-1111-4111-8111-111111111111";
const jeton = (role = "GESTIONNAIRE") => signAccessToken({ sub: ID, role: role as never, email: "agent@ageroute.invalid" });

function app() {
  const a = express();
  a.use(express.json());
  a.get("/qui", requireAuth, (req, res) => res.json({ user: req.user }));
  a.post("/ecrire", requireAuth, requireRole("ADMIN", "GESTIONNAIRE"), (_req, res) => res.json({ ecrit: true }));
  a.use("/api/auth", authRouter);
  a.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => res.status(500).json({ error: "interne" }));
  return a;
}

const avec = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeEach(() => {
  h.compte = {
    id: ID, actif: true, lockedUntil: null, role: "GESTIONNAIRE", email: "agent@ageroute.invalid",
    nomComplet: "Agent d'essai", modulesAutorises: ["inspections"], totpEnabled: false, peutDeleguerValidation: false,
  };
  h.baseIndisponible = false;
  h.lectures = [];
  h.regions = [];
});

describe("requireAuth relit le compte en base", () => {
  it("compte actif : la requete passe, avec le role et l'adresse lus en base", async () => {
    const r = await request(app()).get("/qui").set(avec(jeton()));
    expect(r.status).toBe(200);
    expect(r.body.user).toEqual({ id: ID, role: "GESTIONNAIRE", email: "agent@ageroute.invalid" });
  });

  it("compte DESACTIVE avec un jeton encore valide : 401 COMPTE_INACTIF, immediatement", async () => {
    h.compte = { ...h.compte!, actif: false };
    const r = await request(app()).get("/qui").set(avec(jeton()));
    expect(r.status).toBe(401);
    expect(r.body.code).toBe("COMPTE_INACTIF");
  });

  it("compte VERROUILLE (verrou dans le futur) : 401 COMPTE_INACTIF ; verrou echu : la requete passe", async () => {
    h.compte = { ...h.compte!, lockedUntil: new Date(Date.now() + 60_000) };
    const verrouille = await request(app()).get("/qui").set(avec(jeton()));
    expect(verrouille.status).toBe(401);
    expect(verrouille.body.code).toBe("COMPTE_INACTIF");

    h.compte = { ...h.compte!, lockedUntil: new Date(Date.now() - 60_000) };
    const echu = await request(app()).get("/qui").set(avec(jeton()));
    expect(echu.status).toBe(200);
  });

  it("compte SUPPRIME : meme reponse qu'un compte desactive (l'existence n'est pas revelee)", async () => {
    h.compte = null;
    const r = await request(app()).get("/qui").set(avec(jeton()));
    expect(r.status).toBe(401);
    expect(r.body.code).toBe("COMPTE_INACTIF");
  });

  it("compte RETROGRADE : le role de la base prime sur celui du jeton (le jeton dit GESTIONNAIRE, la base LECTEUR)", async () => {
    h.compte = { ...h.compte!, role: "LECTEUR" };
    const identite = await request(app()).get("/qui").set(avec(jeton("GESTIONNAIRE")));
    expect(identite.body.user.role).toBe("LECTEUR");
    const ecriture = await request(app()).post("/ecrire").set(avec(jeton("GESTIONNAIRE")));
    expect(ecriture.status).toBe(403);
  });

  it("compte PROMU dans la base : le role du jeton ne l'emporte pas non plus (ADMIN du jeton, LECTEUR en base)", async () => {
    h.compte = { ...h.compte!, role: "LECTEUR" };
    const r = await request(app()).post("/ecrire").set(avec(jeton("ADMIN")));
    expect(r.status).toBe(403);
  });

  it("base INDISPONIBLE : 503 SERVICE_INDISPONIBLE, et surtout pas un 401 (le client ne doit pas fermer sa session locale)", async () => {
    h.baseIndisponible = true;
    const r = await request(app()).get("/qui").set(avec(jeton()));
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("SERVICE_INDISPONIBLE");
  });

  it("jeton absent ou invalide : 401 avec un code stable chacun, et la base n'est pas lue", async () => {
    const absent = await request(app()).get("/qui");
    expect(absent.status).toBe(401);
    expect(absent.body.code).toBe("NON_AUTHENTIFIE");
    const invalide = await request(app()).get("/qui").set(avec("pas.un.jeton"));
    expect(invalide.status).toBe(401);
    expect(invalide.body.code).toBe("JETON_INVALIDE");
    expect(h.lectures).toHaveLength(0);
  });

  it("une seule lecture par requete authentifiee, bornee aux quatre colonnes utiles", async () => {
    await request(app()).get("/qui").set(avec(jeton()));
    expect(h.lectures).toHaveLength(1);
    expect(h.lectures[0]).toMatchObject({
      where: { id: ID },
      select: { actif: true, lockedUntil: true, role: true, email: true },
    });
  });
});

describe("GET /api/auth/me rend les droits effectifs lus en base", () => {
  it("role, modules et regions : la base fait foi, pas le jeton", async () => {
    h.compte = { ...h.compte!, role: "LECTEUR", modulesAutorises: ["geoportail", "inspections"] };
    h.regions = [7, 3];
    const r = await request(app()).get("/api/auth/me").set(avec(jeton("GESTIONNAIRE")));
    expect(r.status).toBe(200);
    expect(r.body.user.role).toBe("LECTEUR");
    expect(r.body.user.modulesAutorises).toEqual(["geoportail", "inspections"]);
    expect(r.body.user.regions).toEqual([3, 7]);
    expect(r.body.user.perimetreNational).toBe(false);
  });

  it("un compte sans rattachement est national : regions vide ET perimetreNational vrai (on ne confond pas les deux)", async () => {
    h.regions = [];
    const r = await request(app()).get("/api/auth/me").set(avec(jeton()));
    expect(r.body.user.regions).toEqual([]);
    expect(r.body.user.perimetreNational).toBe(true);
  });

  it("ADMIN : national quelles que soient ses lignes, regions vide", async () => {
    h.compte = { ...h.compte!, role: "ADMIN" };
    h.regions = [1];
    const r = await request(app()).get("/api/auth/me").set(avec(jeton("ADMIN")));
    expect(r.body.user.perimetreNational).toBe(true);
    expect(r.body.user.regions).toEqual([]);
  });

  it("additif : les champs historiques sont toujours la", async () => {
    const r = await request(app()).get("/api/auth/me").set(avec(jeton()));
    expect(Object.keys(r.body.user)).toEqual(expect.arrayContaining([
      "id", "role", "email", "totpEnabled", "nomComplet", "modulesAutorises", "peutDeleguerValidation",
    ]));
  });

  it("compte desactive : /me refuse aussi (COMPTE_INACTIF), le client sait qu'il doit fermer sa session", async () => {
    h.compte = { ...h.compte!, actif: false };
    const r = await request(app()).get("/api/auth/me").set(avec(jeton()));
    expect(r.status).toBe(401);
    expect(r.body.code).toBe("COMPTE_INACTIF");
  });
});
