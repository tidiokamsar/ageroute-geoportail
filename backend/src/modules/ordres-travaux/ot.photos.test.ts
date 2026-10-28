import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../utils/audit", () => {
  const logAudit = vi.fn();
  // Les deux chemins transactionnels delegent au MEME espion. Les assertions existantes
  // continuent ainsi d'observer exactement les memes parametres, et verifient donc le
  // chemin reel — notamment celle qui exige qu'aucun jeton brut n'atteigne l'audit.
  return {
    logAudit,
    construireAudit: vi.fn((p: Record<string, unknown>) => {
      logAudit(p);
      return { __audit: p };
    }),
    logAuditTransactionnelle: vi.fn(async (_tx: unknown, p: Record<string, unknown>) => {
      logAudit(p);
    }),
  };
});

const db = vi.hoisted(() => {
  const client = {
    otPhoto: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    ordreTravaux: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn(), update: vi.fn() },
    // Les DEUX formes : interactive pour l'ajout, tableau pour le retrait.
    $transaction: vi.fn(async (arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(client)),
  };
  return client;
});

vi.mock("../../lib/prisma", () => ({ prisma: db }));

import { otService } from "./ot.service";
import { logAudit } from "../../utils/audit";

const OT_ACTIF = { id: "ot-1", statut: "EN_COURS", deletedAt: null };
const PHOTO_OT1 = { id: "ph-1", otId: "ot-1", fileName: "a.jpg", type: "AVANT", ot: { deletedAt: null } };

describe("otService photos — autorisation parentale et preuve conservée (P1-02)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removePhoto() : une photo d'un AUTRE OT est introuvable (IDOR fermé)", async () => {
    // La photo existe, mais appartient à ot-2 : le where { id, otId } ne la retourne pas.
    db.otPhoto.findFirst.mockImplementation(async ({ where }: { where: { id: string; otId: string } }) =>
      where.id === "ph-1" && where.otId === "ot-1" ? PHOTO_OT1 : null
    );

    await expect(otService.removePhoto("ot-2", "ph-1", "user-1")).rejects.toMatchObject({ status: 404 });
    expect(db.otPhoto.update).not.toHaveBeenCalled();
    expect(db.otPhoto.delete).not.toHaveBeenCalled();
  });

  it("removePhoto() : photo d'un OT retiré logiquement → 404 uniforme", async () => {
    db.otPhoto.findFirst.mockResolvedValue({ ...PHOTO_OT1, ot: { deletedAt: new Date() } });
    await expect(otService.removePhoto("ot-1", "ph-1", "user-1")).rejects.toMatchObject({ status: 404 });
  });

  it("removePhoto() : retrait logique audité, jamais de DELETE physique", async () => {
    db.otPhoto.findFirst.mockResolvedValue(PHOTO_OT1);
    db.otPhoto.update.mockResolvedValue({ ...PHOTO_OT1, deletedAt: new Date() });

    await otService.removePhoto("ot-1", "ph-1", "user-1");

    expect(db.otPhoto.delete).not.toHaveBeenCalled();
    expect(db.otPhoto.update).toHaveBeenCalledWith({
      where: { id: "ph-1" },
      data: expect.objectContaining({ deletedAt: expect.any(Date) }),
    });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "DELETE", entityType: "OtPhoto", userId: "user-1" }));
  });

  it("addPhoto() : l'ajout est audité", async () => {
    db.ordreTravaux.findFirst.mockResolvedValue(OT_ACTIF);
    db.otPhoto.create.mockResolvedValue({ ...PHOTO_OT1, deletedAt: null });

    await otService.addPhoto("ot-1", "b.jpg", "APRES", undefined, undefined, "user-1");

    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "CREATE", entityType: "OtPhoto", userId: "user-1" }));
  });

  it("addPhoto() : OT inconnu ou retiré → 404 avant toute écriture", async () => {
    db.ordreTravaux.findFirst.mockResolvedValue(null);
    await expect(otService.addPhoto("ot-x", "b.jpg", "APRES", undefined, undefined, "user-1")).rejects.toMatchObject({ status: 404 });
    expect(db.otPhoto.create).not.toHaveBeenCalled();
  });
});
