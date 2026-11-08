import { describe, expect, it, vi, beforeEach } from "vitest";

const tracesAudit = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("../../utils/audit", () => ({
  logAudit: vi.fn(),
  // Depuis la migration a l'audit transactionnel (ADR 11), ces deux-la sont les chemins
  // reels. Un mock qui ne les expose pas fait echouer le test sans dire pourquoi.
  construireAudit: vi.fn((p: Record<string, unknown>) => ({ __audit: p })),
  logAuditTransactionnelle: vi.fn(async (_tx: unknown, p: Record<string, unknown>) => {
    tracesAudit.push(p);
  }),
}));

const db = vi.hoisted(() => ({
  bailleur: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  marche: { count: vi.fn() },
  marcheChantier: { findUnique: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
  avancementMarche: { upsert: vi.fn() },
  // `$transaction` sert les DEUX formes : interactive quand l'audit a besoin de la ligne
  // retournee, tableau quand il n'enregistre qu'un resume.
  $transaction: vi.fn(async (arg: unknown) => {
    if (typeof arg === "function") return (arg as (t: unknown) => Promise<unknown>)(db);
    return Promise.all(arg as Promise<unknown>[]);
  }),
}));

vi.mock("../../lib/prisma", () => ({ prisma: db }));

import { marchesService } from "./marches.service";
import { construireAudit } from "../../utils/audit";


const BAILLEUR_ACTIF = { id: 3, nom: "BADR", type: "banque", deletedAt: null };

describe("marchesService — bailleurs (P1-01)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tracesAudit.length = 0;
  });

  it("listBailleurs() exclut les bailleurs retirés de la liste opérationnelle", async () => {
    db.bailleur.findMany.mockResolvedValue([]);
    await marchesService.listBailleurs();
    expect(db.bailleur.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { deletedAt: null },
    }));
  });

  it("createBailleur() est audité", async () => {
    db.bailleur.create.mockResolvedValue(BAILLEUR_ACTIF);
    await marchesService.createBailleur({ nom: "BADR", type: "banque" }, "user-1");
    // La trace part DANS la transaction, et `after` est la ligne que la base a rendue :
    // l'identifiant auto-incremente n'existe pas avant l'insertion.
    expect(tracesAudit).toHaveLength(1);
    expect(tracesAudit[0]).toMatchObject({ action: "CREATE", entityType: "Bailleur", userId: "user-1" });
    expect(tracesAudit[0].after).toMatchObject({ id: 3 });
  });

  it("updateBailleur() refuse un bailleur retiré et audite la modification", async () => {
    db.bailleur.findFirst.mockResolvedValue(BAILLEUR_ACTIF);
    db.bailleur.update.mockResolvedValue({ ...BAILLEUR_ACTIF, nom: "BADR Guinée" });
    await marchesService.updateBailleur(3, { nom: "BADR Guinée" }, "user-1");
    expect(db.bailleur.update).toHaveBeenCalled();
    // `after` est la ligne retournee : la trace dit le nouveau nom, pas le champ envoye.
    expect(tracesAudit[0]).toMatchObject({ action: "UPDATE", entityType: "Bailleur" });
    expect((tracesAudit[0].after as Record<string, unknown>).nom).toBe("BADR Guinée");
  });

  it("deleteBailleur() refuse tant qu'un marché y est rattaché, archivé compris", async () => {
    db.marche.count.mockResolvedValue(4);
    await expect(marchesService.deleteBailleur(3, "user-1")).rejects.toMatchObject({ status: 409 });
    expect(db.bailleur.update).not.toHaveBeenCalled();
  });

  it("deleteBailleur() sans marché : retrait logique audité, jamais de DELETE physique", async () => {
    db.marche.count.mockResolvedValue(0);
    db.bailleur.findFirst.mockResolvedValue(BAILLEUR_ACTIF);
    db.bailleur.update.mockResolvedValue({ ...BAILLEUR_ACTIF, deletedAt: new Date() });

    await marchesService.deleteBailleur(3, "user-1");

    expect(db.bailleur.delete).not.toHaveBeenCalled();
    expect(db.bailleur.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: expect.objectContaining({ deletedAt: expect.any(Date) }),
    });
    expect(construireAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "DELETE", entityType: "Bailleur", userId: "user-1",
    }));
  });
});
