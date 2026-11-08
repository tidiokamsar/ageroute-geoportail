import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Controle territorial (A10) : compte NATIONAL ici, le sujet de ce fichier est ailleurs. Le controle lui-meme
// (lecture et ecriture par region) est eprouve par securite/controle-acces.test.ts et par le banc
// tests-integration/controle-acces.integration.mts.
vi.mock("../territoire/territoire.service", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  perimetreDe: async () => ({ national: true }),
}));

/**
 * `/api/v2/programmation` — ce que ces tests défendent.
 *
 * LA SAISIE EST UNE PROPOSITION SIGNÉE. Toute prévision naît PROPOSE avec source SAISIE
 * et l'auteur de la session : si un client pouvait poser RETENU tout seul, l'arbitrage
 * budgétaire — l'acte qu'un auditeur vient relire — n'existerait pas.
 *
 * LE MONTANT EST UNE CHAÎNE. Un montant GNF dépasse 2^53 ; accepter un nombre JSON
 * serait fausser silencieusement le budget. La route exige des chiffres et rend une
 * chaîne.
 *
 * RIEN NE SE SUPPRIME PHYSIQUEMENT. Une prévision retirée pose deletedAt ; elle
 * disparaît des listes mais reste dans l'audit — la programmation est une donnée
 * d'archive comme le reste du patrimoine.
 */
const h = vi.hoisted(() => {
  const base = {
    id: "p1", annee: 2027, intitule: "Rehabilitation RN1 section Conakry-Kindia",
    tronconId: null as string | null, bailleur: "AFD" as string | null,
    typeIntervention: "Rehabilitation" as string | null, montantPrevuGnf: 2_400_000_000n,
    priorite: null as number | null, statut: "PROPOSE", source: "SAISIE",
    commentaire: null as string | null, createdById: "u1",
    createdAt: new Date("2026-10-21T10:00:00Z"), updatedAt: new Date("2026-10-21T10:00:00Z"),
    deletedAt: null as Date | null,
  };
  return {
    compte: { id: "u1", role: "GESTIONNAIRE" },
    base,
    lignes: [] as Array<typeof base & { troncon?: { code: string } | null }>,
    creee: null as Record<string, unknown> | null,
    audite: [] as Array<{ action: string; entityId?: string; after?: unknown; before?: unknown; userId?: string }>,
    /** Entrees d'audit anterieures a ce correctif (sans le drapeau `contenuModifie`) : le journal est relu pour opposer l'approbateur a ceux qui ont modifie le contenu. */
    auditAnterieur: [] as Array<{ userId: string | null; before: unknown; after: unknown }>,
    tronconConnu: { id: "t1", code: "RN1-001" },
  };
});

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { ...h.compte };
    n();
  },
}));
vi.mock("../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_q: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));
vi.mock("../middleware/rbac.middleware", () => ({
  requireRole: () => (req: express.Request, res: express.Response, n: express.NextFunction) => {
    if (req.user?.role !== "ADMIN" && req.user?.role !== "GESTIONNAIRE") {
      res.status(403).json({ error: "Acces refuse pour votre role" });
      return;
    }
    n();
  },
}));
vi.mock("../lib/prisma", () => ({
  prisma: {
    programmeBudgetaire: {
      count: vi.fn(async () => h.lignes.length),
      findMany: vi.fn(async () => h.lignes),
      findFirst: vi.fn(async () => (h.lignes[0] ? { ...h.lignes[0] } : null)),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        h.creee = { ...h.base, ...data, id: "p2" };
        return h.creee;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const l = h.lignes.find((x) => x.id === where.id);
        if (!l) throw new Error("introuvable");
        Object.assign(l, data);
        return l;
      }),
    },
    troncon: { findUnique: vi.fn(async () => h.tronconConnu) },
    auditLog: {
      // Journal de la ligne, du plus recent au plus ancien : les ecritures de ce test, puis les entrees anterieures.
      findMany: vi.fn(async () => [
        ...h.audite.filter((a) => a.action === "UPDATE").reverse().map((a) => ({ userId: a.userId ?? null, before: a.before, after: a.after })),
        ...h.auditAnterieur,
      ]),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      programmeBudgetaire: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          h.creee = { ...h.base, ...data, id: "p2", troncon: { code: "RN1-001" } };
          return h.creee;
        }),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const l = h.lignes.find((x) => x.id === where.id);
          if (l) Object.assign(l, data);
          return l ?? { ...h.base, ...data };
        }),
      },
    })),
  },
}));
vi.mock("../utils/audit", () => ({
  logAuditTransactionnelle: vi.fn(async (_tx: unknown, p: { action: string; entityId?: string; after?: unknown; before?: unknown; userId?: string }) => {
    h.audite.push({ action: p.action, entityId: p.entityId, after: p.after, before: p.before, userId: p.userId });
  }),
}));

import { programmationV2Router } from "./programmation.routes";

const app = express();
app.use(express.json(), programmationV2Router);

beforeEach(() => {
  h.compte = { id: "u1", role: "GESTIONNAIRE" };
  h.lignes = [{ ...h.base }];
  h.creee = null;
  h.audite = [];
  h.auditAnterieur = [];
});

describe("GET /api/v2/programmation", () => {
  it("rend les prévisions non supprimées, montant en chaîne", async () => {
    const r = await request(app).get("/");
    expect(r.status).toBe(200);
    expect(r.body.data[0].montantPrevuGnf).toBe("2400000000");
    expect(r.body.data[0].statut).toBe("PROPOSE");
  });
});

describe("POST /api/v2/programmation", () => {
  it("cree une prévision PROPOSE/SOURCE=SAISIE signée par la session, et l'audite", async () => {
    const r = await request(app).post("/").send({
      annee: 2027, intitule: "Renforcement RN2", montantPrevuGnf: "900000000", bailleur: "BAD",
    });
    expect(r.status).toBe(201);
    expect(r.body.statut).toBe("PROPOSE");
    expect(r.body.source).toBe("SAISIE");
    expect(r.body.montantPrevuGnf).toBe("900000000");
    expect(h.creee?.createdById).toBe("u1");
    expect(h.audite).toHaveLength(1);
    expect(h.audite[0].action).toBe("CREATE");
  });

  it("refuse un montant qui n'est pas une chaîne de chiffres (2^53 silencieux)", async () => {
    const r = await request(app).post("/").send({
      annee: 2027, intitule: "Renforcement RN2", montantPrevuGnf: 900000000,
    });
    expect(r.status).toBe(400);
    expect(h.creee).toBeNull();
  });

  it("refuse un intitulé trop court ou une année absente", async () => {
    expect((await request(app).post("/").send({ annee: 2027, intitule: "X", montantPrevuGnf: "1" })).status).toBe(400);
    expect((await request(app).post("/").send({ intitule: "Renforcement RN2", montantPrevuGnf: "1" })).status).toBe(400);
  });

  it("refuse un champ inconnu (source ne s'entre pas par la requête)", async () => {
    const r = await request(app).post("/").send({
      annee: 2027, intitule: "Renforcement RN2", montantPrevuGnf: "1", source: "MOTEUR",
    });
    expect(r.status).toBe(400);
  });
});

describe("PATCH /api/v2/programmation/:id", () => {
  // CONTRAT MODIFIE (AD-07, revue : separation des taches des previsions). Ce test envoyait {montantPrevuGnf, statut: "RETENU"} dans UNE
  // requete par un compte etranger a la saisie : modifier le contenu ET le retenir d'un seul geste, la porte que la separation des
  // taches doit fermer (le compte B changeait le montant puis se l'approuvait). Modification et retenue sont deux actes distincts.
  it("retient une prevision (compte etranger a la saisie), avec before/after dans l'audit", async () => {
    h.compte = { id: "u2", role: "GESTIONNAIRE" };
    const r = await request(app).patch("/p1").send({ statut: "RETENU" });
    expect(r.status).toBe(200);
    expect(r.body.statut).toBe("RETENU");
    expect(h.audite[0].action).toBe("UPDATE");
    expect((h.audite[0].before as { statut?: string } | undefined)?.statut).toBe("PROPOSE");
    expect((h.audite[0].after as { statut?: string } | undefined)?.statut).toBe("RETENU");
  });

  it("revise le montant (acte distinct), avec before/after dans l'audit et le drapeau contenuModifie", async () => {
    h.compte = { id: "u2", role: "GESTIONNAIRE" };
    const r = await request(app).patch("/p1").send({ montantPrevuGnf: "3100000000" });
    expect(r.status).toBe(200);
    expect(r.body.montantPrevuGnf).toBe("3100000000");
    expect(r.body.statut).toBe("PROPOSE");
    expect(h.audite[0].before).toMatchObject({ montantPrevuGnf: "2400000000" });
    expect(h.audite[0].after).toMatchObject({ montantPrevuGnf: "3100000000", contenuModifie: true });
  });

  it("SEPARATION DES TACHES : modifier le contenu ET retenir dans la meme requete est refuse (422), rien n'est modifie ni audite", async () => {
    h.compte = { id: "u2", role: "GESTIONNAIRE" };
    for (const corps of [
      { montantPrevuGnf: "3100000000", statut: "RETENU" }, { annee: 2028, statut: "RETENU" }, { intitule: "Autre objet", statut: "RETENU" },
      { tronconId: "t1", statut: "RETENU" }, { bailleur: "BAD", statut: "RETENU" }, { typeIntervention: "Reconstruction", statut: "RETENU" }, { priorite: 1, statut: "RETENU" },
    ]) {
      const r = await request(app).patch("/p1").send(corps);
      expect([r.status, r.body.code], JSON.stringify(corps)).toEqual([422, "MODIFICATION_ET_APPROBATION"]);
    }
    expect(h.lignes[0]).toMatchObject({ montantPrevuGnf: 2_400_000_000n, statut: "PROPOSE", annee: 2027 });
    expect(h.audite).toEqual([]);
  });

  it("un champ renvoye a l'identique, ou un simple commentaire, n'est pas une modification : la retenue passe", async () => {
    h.compte = { id: "u2", role: "GESTIONNAIRE" };
    expect((await request(app).patch("/p1").send({ montantPrevuGnf: "2400000000", annee: 2027, bailleur: "AFD", statut: "RETENU" })).status).toBe(200);
    h.lignes = [{ ...h.base }];
    expect((await request(app).patch("/p1").send({ commentaire: "arbitrage du comite", statut: "RETENU" })).status).toBe(200);
  });

  it("SEPARATION DES TACHES : celui qui a modifie le contenu ne peut pas ensuite retenir (deux requetes), un troisieme compte le peut", async () => {
    h.compte = { id: "u2", role: "GESTIONNAIRE" };
    expect((await request(app).patch("/p1").send({ montantPrevuGnf: "9900000000" })).status).toBe(200);
    const refus = await request(app).patch("/p1").send({ statut: "RETENU" });
    expect([refus.status, refus.body.code]).toEqual([403, "AUTO_VALIDATION"]);
    expect(refus.body.error).toMatch(/a modifié le contenu de cette prévision/);
    expect(h.lignes[0].statut).toBe("PROPOSE");
    // le createur reste exclu, et un compte etranger a la saisie ET aux modifications retient
    h.compte = { id: "u1", role: "ADMIN" };
    expect((await request(app).patch("/p1").send({ statut: "RETENU" })).status).toBe(403);
    h.compte = { id: "u3", role: "GESTIONNAIRE" };
    expect((await request(app).patch("/p1").send({ statut: "RETENU" })).status).toBe(200);
    expect(h.lignes[0]).toMatchObject({ statut: "RETENU", montantPrevuGnf: 9_900_000_000n });
  });

  it("tous les modificateurs sont opposes, pas seulement le dernier ; une entree d'audit ancienne (sans drapeau) compte si le montant a change ; un report n'est pas une modification", async () => {
    h.auditAnterieur = [{ userId: "u4", before: { annee: 2027, statut: "PROPOSE", montantPrevuGnf: "1" }, after: { annee: 2027, statut: "PROPOSE", montantPrevuGnf: "2400000000" } }];
    h.compte = { id: "u4", role: "GESTIONNAIRE" };
    expect((await request(app).patch("/p1").send({ statut: "RETENU" })).status).toBe(403);
    h.compte = { id: "u2", role: "GESTIONNAIRE" };
    await request(app).patch("/p1").send({ montantPrevuGnf: "5" });
    h.compte = { id: "u1", role: "GESTIONNAIRE" };
    await request(app).patch("/p1").send({ montantPrevuGnf: "6" }); // le dernier modificateur est u1, mais u2 a aussi modifie
    h.compte = { id: "u2", role: "GESTIONNAIRE" };
    expect((await request(app).patch("/p1").send({ statut: "RETENU" })).status).toBe(403);
    h.audite = []; h.auditAnterieur = []; h.lignes = [{ ...h.base }];
    h.compte = { id: "u2", role: "GESTIONNAIRE" };
    await request(app).patch("/p1").send({ statut: "REPORTE" });
    await request(app).patch("/p1").send({ statut: "PROPOSE" });
    expect((await request(app).patch("/p1").send({ statut: "RETENU" })).status).toBe(200);
  });

  it("SEPARATION DES TACHES : modifier le contenu d'une prevision RETENUE la renvoie a PROPOSE (nouvelle approbation distincte), et l'audit le dit", async () => {
    h.lignes = [{ ...h.base, statut: "RETENU" }];
    h.compte = { id: "u1", role: "GESTIONNAIRE" };
    const r = await request(app).patch("/p1").send({ montantPrevuGnf: "7000000000" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ statut: "PROPOSE", montantPrevuGnf: "7000000000" });
    expect(h.audite[0].before).toMatchObject({ statut: "RETENU" });
    expect(h.audite[0].after).toMatchObject({ statut: "PROPOSE", contenuModifie: true, reouverte: true });
    // un report ou une annulation explicites d'une ligne retenue restent possibles avec la modification
    h.lignes = [{ ...h.base, statut: "RETENU" }];
    const a = await request(app).patch("/p1").send({ montantPrevuGnf: "1", statut: "ANNULE" });
    expect([a.status, a.body.statut]).toEqual([200, "ANNULE"]);
    // modifier ET garder RETENU dans la meme requete : refuse
    h.lignes = [{ ...h.base, statut: "RETENU" }];
    expect((await request(app).patch("/p1").send({ montantPrevuGnf: "2", statut: "RETENU" })).status).toBe(422);
    // un commentaire n'est pas un contenu : la ligne reste retenue
    h.lignes = [{ ...h.base, statut: "RETENU" }];
    expect((await request(app).patch("/p1").send({ commentaire: "note" })).body.statut).toBe("RETENU");
  });

  it("AD-07 : l'auteur de la saisie ne peut pas la retenir lui-meme (403 AUTO_VALIDATION), rien n'est modifie ni audite", async () => {
    h.compte = { id: "u1", role: "GESTIONNAIRE" };
    const r = await request(app).patch("/p1").send({ statut: "RETENU" });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("AUTO_VALIDATION");
    expect(r.body.error).toMatch(/a saisi cette prévision/);
    expect(h.lignes[0].statut).toBe("PROPOSE");
    expect(h.audite).toEqual([]);
  });

  it("AD-07 : un ADMIN auteur n'echappe pas a la regle ; un ADMIN etranger retient", async () => {
    h.compte = { id: "u1", role: "ADMIN" };
    expect((await request(app).patch("/p1").send({ statut: "RETENU" })).status).toBe(403);
    h.compte = { id: "admin2", role: "ADMIN" };
    expect((await request(app).patch("/p1").send({ statut: "RETENU" })).status).toBe(200);
  });

  it("AD-07 : l'auteur garde la main sur sa proposition (montant, report, annulation) : seul RETENU est un arbitrage", async () => {
    h.compte = { id: "u1", role: "GESTIONNAIRE" };
    expect((await request(app).patch("/p1").send({ montantPrevuGnf: "1" })).status).toBe(200);
    expect((await request(app).patch("/p1").send({ statut: "REPORTE" })).status).toBe(200);
    expect((await request(app).patch("/p1").send({ statut: "ANNULE" })).status).toBe(200);
  });

  it("AD-07 : une prevision sans auteur identifie (createdById nul) peut etre retenue par tout compte habilite", async () => {
    h.lignes = [{ ...h.base, createdById: null as unknown as string }];
    expect((await request(app).patch("/p1").send({ statut: "RETENU" })).status).toBe(200);
  });

  it("404 sur une prévision inconnue ou supprimée", async () => {
    h.lignes = [];
    const r = await request(app).patch("/p1").send({ statut: "RETENU" });
    expect(r.status).toBe(404);
  });
});

describe("POST /:id/supprimer", () => {
  it("pose deletedAt, n'efface aucune ligne, et l'audite", async () => {
    const r = await request(app).post("/p1/supprimer");
    expect(r.status).toBe(200);
    expect(h.lignes[0].deletedAt).toBeInstanceOf(Date);
    expect(h.audite[0].action).toBe("DELETE");
  });
});
