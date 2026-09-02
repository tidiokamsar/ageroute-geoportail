import { describe, expect, it, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({ auditLog: { create: vi.fn() } }));
vi.mock("../lib/prisma", () => ({ prisma: db }));

import { logAudit, echecsAuditDepuisDemarrage, _reinitialiserCompteurAudit } from "./audit";

describe("logAudit — l'échec ne casse plus rien mais se voit (P2-03)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _reinitialiserCompteurAudit();
  });

  it("écrit dans audit_logs en cas de succès et ne compte aucun échec", async () => {
    db.auditLog.create.mockResolvedValue({});
    await logAudit({ userId: "u1", action: "CREATE", entityType: "Troncon", entityId: "t1" });
    expect(db.auditLog.create).toHaveBeenCalled();
    expect(echecsAuditDepuisDemarrage()).toBe(0);
  });

  it("n'échoue jamais pour l'appelant — mais incrémente le compteur d'échecs", async () => {
    db.auditLog.create.mockRejectedValue(new Error("relation audit_logs absente"));
    await expect(logAudit({ userId: "u1", action: "DELETE", entityType: "Decompte", entityId: "d1" })).resolves.toBeUndefined();
    expect(echecsAuditDepuisDemarrage()).toBe(1);
  });

  it("cumule les échecs : le compteur monte tant que l'audit ne passe pas", async () => {
    db.auditLog.create.mockRejectedValue(new Error("base saturée"));
    for (let i = 0; i < 3; i++) {
      await logAudit({ userId: null, action: "LOGIN", entityType: "User" });
    }
    expect(echecsAuditDepuisDemarrage()).toBe(3);
  });
});
