import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../utils/audit", () => ({ logAudit: vi.fn() }));

const db = vi.hoisted(() => ({
  decompte: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), groupBy: vi.fn() },
  marche: { findFirst: vi.fn() },
}));

vi.mock("../../lib/prisma", () => ({ prisma: db }));

import { decomptesService } from "./decomptes.service";
import { logAudit } from "../../utils/audit";

const DECOMPTE_ACTIF = { id: "d1", marcheId: "m1", numero: 1, statut: "PAYE", montantGnf: 1000n, deletedAt: null };

describe("decomptesService — suppression logique (P1-01)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "DELETE", entityType: "Decompte", userId: "user-1" }));
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
