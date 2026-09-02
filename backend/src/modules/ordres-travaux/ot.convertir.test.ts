import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../utils/audit", () => ({ logAudit: vi.fn() }));

const db = vi.hoisted(() => ({
  ordreTravaux: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    groupBy: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  },
  chantier: { create: vi.fn() },
  otHistorique: { create: vi.fn() },
  otPhoto: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({ prisma: db }));

import { otService } from "./ot.service";

const OT_ACTIF = {
  id: "ot-1", numero: "OT-2026-00001", titre: "Réparation RN5", statut: "ASSIGNE",
  regionId: 3, tronconId: "t-1", entreprise: "Entreprise X", coutEstimeGnf: 60_000_000n,
  description: "Potholes", deletedAt: null,
};

describe("convertirChantier — transactionnel (P2-04)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.ordreTravaux.findFirst.mockResolvedValue(OT_ACTIF);
  });

  it("crée le chantier et bascule l'OT DANS une même transaction interactive", async () => {
    db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ chantier: { create: db.chantier.create }, ordreTravaux: { update: db.ordreTravaux.update } })
    );
    db.chantier.create.mockResolvedValue({ id: "ch-9" });
    db.ordreTravaux.update.mockResolvedValue({ ...OT_ACTIF, statut: "CONVERTI_CHANTIER" });
    db.otHistorique.create.mockResolvedValue({});

    const resultat = await otService.convertirChantier("ot-1", "user-1");

    expect(resultat).toEqual({ chantierId: "ch-9" });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.chantier.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ statut: "PLANIFIE", regionId: 3 }),
    }));
    expect(db.ordreTravaux.update).toHaveBeenCalledWith({
      where: { id: "ot-1" },
      data: expect.objectContaining({ statut: "CONVERTI_CHANTIER", chantierId: "ch-9" }),
    });
  });

  it("si la bascule échoue, l'erreur remonte : plus de chantier orphelin silencieux", async () => {
    db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ chantier: { create: db.chantier.create }, ordreTravaux: { update: db.ordreTravaux.update } })
    );
    db.chantier.create.mockResolvedValue({ id: "ch-9" });
    db.ordreTravaux.update.mockRejectedValue(new Error("verrou concurrent"));

    // En base réelle, le rollback transactionnel annule le chantier créé ; avec les
    // mocks, on vérifie que l'échec de la bascule fait échouer la conversion.
    await expect(otService.convertirChantier("ot-1", "user-1")).rejects.toThrow("verrou concurrent");
  });

  it("refuse un OT clos ou sans région, avant toute écriture", async () => {
    db.ordreTravaux.findFirst.mockResolvedValue({ ...OT_ACTIF, statut: "TERMINE" });
    await expect(otService.convertirChantier("ot-1", "user-1")).rejects.toMatchObject({ status: 400 });
    db.ordreTravaux.findFirst.mockResolvedValue({ ...OT_ACTIF, regionId: null });
    await expect(otService.convertirChantier("ot-1", "user-1")).rejects.toMatchObject({ status: 400 });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
