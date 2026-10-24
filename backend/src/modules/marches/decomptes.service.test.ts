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
  decompte: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), groupBy: vi.fn() },
  marche: { findFirst: vi.fn() },
  // `$transaction` sert les DEUX formes : interactive quand l'audit a besoin de la ligne
  // retournee, tableau quand il n'enregistre qu'un resume.
  $transaction: vi.fn(async (arg: unknown) => {
    if (typeof arg === "function") return (arg as (t: unknown) => Promise<unknown>)(db);
    return Promise.all(arg as Promise<unknown>[]);
  }),
}));

vi.mock("../../lib/prisma", () => ({ prisma: db }));

import { decomptesService } from "./decomptes.service";
import { construireAudit } from "../../utils/audit";


const DECOMPTE_ACTIF = { id: "d1", marcheId: "m1", numero: 1, statut: "PAYE", montantGnf: 1000n, deletedAt: null };

describe("decomptesService — suppression logique (P1-01)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tracesAudit.length = 0;
    db.marche.findFirst.mockResolvedValue({ id: "m1" });
  });

  it("remove() retire logiquement et n'exécute jamais DELETE physique", async () => {
    db.decompte.findFirst.mockResolvedValue(DECOMPTE_ACTIF);
    db.decompte.update.mockResolvedValue({ ...DECOMPTE_ACTIF, deletedAt: new Date() });

    await decomptesService.remove("d1", "user-1");

    expect(db.decompte.delete).not.toHaveBeenCalled();
    expect(db.decompte.update).toHaveBeenCalledWith({
      where: { id: "d1" },
      data: expect.objectContaining({ deletedAt: expect.any(Date) }),
    });
    // Un retrait n'audite qu'un resume : il part par la forme tableau, aux cotes de
    // la mise a jour logique.
    expect(construireAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "DELETE", entityType: "Decompte", userId: "user-1",
    }));
  });

  it("remove() refuse un décompte déjà retiré (404)", async () => {
    db.decompte.findFirst.mockResolvedValue(null);
    await expect(decomptesService.remove("d2", "user-1")).rejects.toMatchObject({ status: 404 });
    expect(db.decompte.update).not.toHaveBeenCalled();
  });

  it("update() refuse un décompte retiré : donnée d'archive figée", async () => {
    db.decompte.findFirst.mockResolvedValue(null);
    await expect(decomptesService.update("d2", { statut: "PAYE" }, "user-1")).rejects.toMatchObject({ status: 404 });
  });

  it("list() exclut les décomptes retirés", async () => {
    db.decompte.findMany.mockResolvedValue([]);
    await decomptesService.list("m1");
    expect(db.decompte.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { marcheId: "m1", deletedAt: null },
    }));
  });

  it("sumByMarche() n'agrège pas les décomptes retirés : un retrait décaisse moins", async () => {
    db.decompte.groupBy.mockResolvedValue([]);
    await decomptesService.sumByMarche(["m1"]);
    expect(db.decompte.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: { marcheId: { in: ["m1"] }, statut: "PAYE", deletedAt: null },
    }));
  });
});
