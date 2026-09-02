import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../utils/audit", () => ({ logAudit: vi.fn() }));

const db = vi.hoisted(() => ({
  bailleur: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  marche: { count: vi.fn() },
}));

vi.mock("../../lib/prisma", () => ({ prisma: db }));

import { marchesService } from "./marches.service";
import { logAudit } from "../../utils/audit";

const BAILLEUR_ACTIF = { id: 3, nom: "BADR", type: "banque", deletedAt: null };

describe("marchesService — bailleurs (P1-01)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "CREATE", entityType: "Bailleur", userId: "user-1" }));
  });

  it("updateBailleur() refuse un bailleur retiré et audite la modification", async () => {
    db.bailleur.findFirst.mockResolvedValue(BAILLEUR_ACTIF);
    db.bailleur.update.mockResolvedValue({ ...BAILLEUR_ACTIF, nom: "BADR Guinée" });
    await marchesService.updateBailleur(3, { nom: "BADR Guinée" }, "user-1");
    expect(db.bailleur.update).toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "UPDATE", entityType: "Bailleur" }));
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
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "DELETE", entityType: "Bailleur", userId: "user-1" }));
  });
});
