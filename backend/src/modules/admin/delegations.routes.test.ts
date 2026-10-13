import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * L'API de designation des validateurs : ce que ces tests defendent.
 *
 * LA DECISION D'AGEROUTE
 *
 * Le paragraphe 35 du cahier dit qu'un validateur est designe, PAS PAR QUI. AGEROUTE a
 * tranche le 13/10/2026 : la Direction Technique.
 *
 * CE QUI REND CES ROUTES PARTICULIERES
 *
 * Tout le reste du routeur d'administration exige le role ADMIN. Celles-ci ne peuvent
 * pas : la Direction Technique n'est pas administrateur de la plateforme, et les y placer
 * reviendrait a refuser la decision qu'on vient de prendre. Le droit est donc porte par
 * `users.peutDeleguerValidation`, et les gestionnaires le verifient eux-memes.
 *
 * C'est exactement le genre de controle qu'une refonte remplacerait par un
 * `requireRole("ADMIN")` en croyant simplifier.
 */

const h = vi.hoisted(() => ({
  compte: { id: "direction-1", role: "GESTIONNAIRE" },
  /** Le compte du demandeur, tel que la base le rend. */
  demandeur: null as Record<string, unknown> | null,
  /** Le compte a designer. */
  cible: null as Record<string, unknown> | null,
  delegationExistante: null as Record<string, unknown> | null,
  creees: [] as Record<string, unknown>[],
  majs: [] as Record<string, unknown>[],
  audits: [] as Record<string, unknown>[],
}));

vi.mock("../../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = h.compte;
    n();
  },
}));

vi.mock("../../utils/audit", () => ({
  logAuditTransactionnelle: vi.fn(async (_tx: unknown, p: Record<string, unknown>) => {
    h.audits.push(p);
  }),
  construireAudit: vi.fn((p: Record<string, unknown>) => {
    h.audits.push(p);
    return { __audit: p };
  }),
}));

vi.mock("../../lib/prisma", () => {
  const client: Record<string, unknown> = {
    user: {
      findUnique: vi.fn(async () => h.demandeur),
      findFirst: vi.fn(async () => h.cible),
    },
    region: { findUnique: vi.fn(async () => ({ id: 7 })) },
    delegationValidation: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => h.delegationExistante),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const ligne = { id: "deleg-1", revoqueeLe: null, ...data };
        h.creees.push(ligne);
        return ligne;
      }),
      update: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        h.majs.push(data);
        return { __maj: data } as unknown;
      }),
    },
    $transaction: vi.fn(async (arg: unknown) => {
      if (typeof arg === "function") return (arg as (t: unknown) => Promise<unknown>)(client);
      return Promise.all(arg as Promise<unknown>[]);
    }),
  };
  return { prisma: client };
});

import { gouvernanceRouter } from "./gouvernance.routes";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/gouvernance", gouvernanceRouter);
  a.use((err: Error & { status?: number }, _q: express.Request, s: express.Response, _n: express.NextFunction) => {
    s.status(err.status ?? 500).json({ message: err.message });
  });
  return a;
}

const DESIGNATION = {
  domaine: "DEFAUT",
  validateurId: "11111111-1111-4111-8111-111111111111",
};

beforeEach(() => {
  h.compte = { id: "direction-1", role: "GESTIONNAIRE" };
  h.demandeur = { id: "direction-1", role: "GESTIONNAIRE", peutDeleguerValidation: true, actif: true };
  h.cible = { id: DESIGNATION.validateurId, role: "GESTIONNAIRE" };
  h.delegationExistante = null;
  h.creees = [];
  h.majs = [];
  h.audits = [];
  vi.clearAllMocks();
});

describe("Désigner un validateur", () => {
  it("laisse désigner qui porte le droit, et audite l'acte", async () => {
    const r = await request(app()).post("/api/gouvernance/delegations").send(DESIGNATION);
    expect(r.status).toBe(201);
    expect(h.creees[0]).toMatchObject({
      domaine: "DEFAUT", validateurId: DESIGNATION.validateurId, delegueParId: "direction-1",
    });
    // Désigner un validateur est un acte de gouvernance : il part avec sa trace.
    expect(h.audits[0]).toMatchObject({ action: "CREATE", entityType: "DelegationValidation" });
  });

  it("REFUSE un gestionnaire qui ne porte pas le droit", async () => {
    // Le test qui compte le plus. Six profils sur onze sont GESTIONNAIRE : sans ce
    // contrôle, la désignation serait ouverte à presque tout le monde et ne voudrait
    // plus rien dire.
    h.demandeur = { id: "direction-1", role: "GESTIONNAIRE", peutDeleguerValidation: false, actif: true };
    const r = await request(app()).post("/api/gouvernance/delegations").send(DESIGNATION);
    expect(r.status).toBe(403);
    expect(r.body.motif).toBe("DROIT_DE_DELEGUER_ABSENT");
  });

  it("dispense l'ADMIN du droit explicite", async () => {
    h.compte = { id: "admin-1", role: "ADMIN" };
    h.demandeur = { id: "admin-1", role: "ADMIN", peutDeleguerValidation: false, actif: true };
    const r = await request(app()).post("/api/gouvernance/delegations").send(DESIGNATION);
    expect(r.status).toBe(201);
  });

  it("REFUSE L'AUTO-DÉSIGNATION", async () => {
    // Un délégant qui se désigne sur les sept domaines concentrerait l'arbitrage qu'on
    // voulait répartir.
    //
    // L'identifiant du délégant doit être un UUID ici : le schéma l'exige, et un
    // `direction-1` serait refusé par la validation de forme avant d'atteindre la règle —
    // le test passerait alors pour la mauvaise raison.
    const soi = DESIGNATION.validateurId;
    h.compte = { id: soi, role: "GESTIONNAIRE" };
    h.demandeur = { id: soi, role: "GESTIONNAIRE", peutDeleguerValidation: true, actif: true };
    h.cible = { id: soi, role: "GESTIONNAIRE" };

    const r = await request(app()).post("/api/gouvernance/delegations").send(DESIGNATION);
    expect(r.status).toBe(403);
    expect(r.body.motif).toBe("AUTO_DESIGNATION");
  });

  it("refuse de désigner un compte qui ne peut pas valider", async () => {
    // La délégation aurait l'air de fonctionner et n'autoriserait rien : le contrôle de
    // rôle passe avant celui de la délégation.
    h.cible = { id: DESIGNATION.validateurId, role: "LECTEUR" };
    const r = await request(app()).post("/api/gouvernance/delegations").send(DESIGNATION);
    expect(r.status).toBe(422);
    expect(r.body.motif).toBe("VALIDATEUR_SANS_ROLE_VALIDATEUR");
  });

  it("refuse un compte cible inactif en 422, pas en 404", async () => {
    // L'identifiant vient du CORPS, pas de l'URL : un administrateur doit comprendre que
    // c'est sa saisie qui est en cause.
    h.cible = null;
    const r = await request(app()).post("/api/gouvernance/delegations").send(DESIGNATION);
    expect(r.status).toBe(422);
  });

  it("refuse une période inversée", async () => {
    const r = await request(app()).post("/api/gouvernance/delegations").send({
      ...DESIGNATION,
      debutLe: "2026-12-01T00:00:00.000Z",
      finLe: "2026-11-01T00:00:00.000Z",
    });
    expect(r.status).toBe(422);
    expect(r.body.motif).toBe("PERIODE_INVALIDE");
  });

  it("rejette un champ inconnu plutôt que de l'ignorer", async () => {
    const r = await request(app())
      .post("/api/gouvernance/delegations")
      .send({ ...DESIGNATION, delegueParId: "quelqu-un-d-autre" });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(h.creees).toEqual([]);
  });
});

describe("Révoquer une désignation", () => {
  it("ne SUPPRIME jamais la ligne : elle est datée", async () => {
    // Des validations ont été rendues sous son autorité ; les supprimer les rendrait
    // inexplicables. Règle 2 d'AGENTS.md appliquée à un objet de gouvernance.
    h.delegationExistante = { id: "deleg-1", delegueParId: "direction-1", revoqueeLe: null, domaine: "DEFAUT" };
    const r = await request(app()).post("/api/gouvernance/delegations/deleg-1/revocation").send({ motif: "fin de mission" });
    expect(r.status).toBe(204);
    expect(h.majs[0]).toMatchObject({ revoqueeParId: "direction-1" });
    expect(h.majs[0].revoqueeLe).toBeInstanceOf(Date);
    expect(h.audits[0]).toMatchObject({ action: "DELETE", entityType: "DelegationValidation" });
  });

  it("REFUSE à un délégant de défaire la désignation d'un pair", async () => {
    // Pouvoir défaire celle d'un autre permettrait de vider un domaine de ses validateurs
    // pour s'y substituer, sans jamais rien désigner soi-même.
    h.delegationExistante = { id: "deleg-1", delegueParId: "direction-2", revoqueeLe: null, domaine: "DEFAUT" };
    const r = await request(app()).post("/api/gouvernance/delegations/deleg-1/revocation").send({});
    expect(r.status).toBe(403);
    expect(h.majs).toEqual([]);
  });

  it("laisse un ADMIN révoquer celle d'un autre", async () => {
    h.compte = { id: "admin-1", role: "ADMIN" };
    h.delegationExistante = { id: "deleg-1", delegueParId: "direction-1", revoqueeLe: null, domaine: "DEFAUT" };
    const r = await request(app()).post("/api/gouvernance/delegations/deleg-1/revocation").send({});
    expect(r.status).toBe(204);
  });

  it("refuse une seconde révocation en 409", async () => {
    h.delegationExistante = {
      id: "deleg-1", delegueParId: "direction-1",
      revoqueeLe: new Date("2026-10-01T00:00:00.000Z"), domaine: "DEFAUT",
    };
    const r = await request(app()).post("/api/gouvernance/delegations/deleg-1/revocation").send({});
    expect(r.status).toBe(409);
    expect(h.majs).toEqual([]);
  });
});

describe("Consulter les désignations", () => {
  it("REFUSE un compte qui ne porte pas le droit", async () => {
    /**
     * Cette liste dit qui est désigné. Rapprochée des sept domaines connus, elle dit
     * aussi où PERSONNE ne l'est — la même carte des points faibles du contrôle de
     * validation que j'ai refusé de publier sur la sonde `/api/health`.
     *
     * La restreindre là et pas ici l'aurait rendue accessible à tout compte authentifié.
     */
    h.demandeur = { id: "x", role: "GESTIONNAIRE", peutDeleguerValidation: false };
    const r = await request(app()).get("/api/gouvernance/delegations");
    expect(r.status).toBe(403);
  });

  it("laisse consulter qui porte le droit", async () => {
    const r = await request(app()).get("/api/gouvernance/delegations");
    expect(r.status).toBe(200);
  });
});
