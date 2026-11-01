import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * L'assignation d'un ordre de travaux laisse une trace d'audit.
 *
 * LE DEFAUT : `assigner` n'ecrivait que dans `otHistorique`, la frise lue sur la fiche.
 * Ce n'est pas le journal d'audit : decider QUI doit intervenir sur un OT (et a quelle
 * priorite) etait la seule ecriture de ce service sans trace dans `audit_logs`
 * (regle 3 d'AGENTS.md).
 *
 * CE QUI EST VERIFIE : la trace nomme l'auteur, dit l'ancien et le nouveau responsable,
 * et est ecrite DANS la transaction de la mutation. Que PostgreSQL annule reellement
 * n'est pas verifie : `$transaction` est simule.
 */

const h = vi.hoisted(() => ({
  journal: [] as string[],
  audits: [] as Record<string, unknown>[],
}));

vi.mock("../../utils/audit", () => ({
  logAudit: vi.fn(),
  construireAudit: vi.fn((p: Record<string, unknown>) => ({ __audit: p })),
  logAuditTransactionnelle: vi.fn(async (_tx: unknown, p: Record<string, unknown>) => {
    h.journal.push("audit");
    h.audits.push(p);
  }),
}));

const db = vi.hoisted(() => ({
  ordreTravaux: { findFirst: vi.fn(), update: vi.fn() },
  user: { findFirst: vi.fn() },
  otHistorique: { create: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("../../lib/prisma", () => ({ prisma: db }));

import { otService } from "./ot.service";

const OT_BROUILLON = {
  id: "ot-1", numero: "OT-2026-00001", titre: "Réparation RN5", statut: "BROUILLON",
  assigneAId: null, priorite: "NORMALE", dateEcheance: null, deletedAt: null, historique: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.journal = [];
  h.audits = [];
  db.ordreTravaux.findFirst.mockResolvedValue(OT_BROUILLON);
  db.user.findFirst.mockResolvedValue({ id: "agent-2", nomComplet: "Agent Deux", actif: true });
  db.otHistorique.create.mockResolvedValue({});
  db.ordreTravaux.update.mockImplementation(async () => {
    h.journal.push("maj-ot");
    return { ...OT_BROUILLON, statut: "ASSIGNE", assigneAId: "agent-2", priorite: "HAUTE", dateEcheance: null };
  });
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    h.journal.push("transaction-ouverte");
    return fn({ ordreTravaux: { update: db.ordreTravaux.update } });
  });
});

describe("assigner : la decision est auditee", () => {
  it("ecrit une trace d'audit avec l'auteur, l'ancien et le nouveau responsable", async () => {
    await otService.assigner("ot-1", { assigneAId: "agent-2", priorite: "HAUTE" }, "gest-1");

    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      userId: "gest-1", action: "UPDATE", entityType: "OrdreTravaux", entityId: "ot-1",
      before: { statut: "BROUILLON", assigneAId: null },
      after: { statut: "ASSIGNE", assigneAId: "agent-2", priorite: "HAUTE" },
    });
  });

  it("ecrit la mutation puis la trace DANS la meme transaction", async () => {
    await otService.assigner("ot-1", { assigneAId: "agent-2" }, "gest-1");
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(h.journal).toEqual(["transaction-ouverte", "maj-ot", "audit"]);
  });

  it("n'ecrit ni mutation ni trace quand l'utilisateur cible est inactif", async () => {
    db.user.findFirst.mockResolvedValue(null);
    await expect(otService.assigner("ot-1", { assigneAId: "x" }, "gest-1")).rejects.toMatchObject({ status: 404 });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(h.audits).toHaveLength(0);
  });

  it("n'ecrit rien sur un OT deja en cours", async () => {
    db.ordreTravaux.findFirst.mockResolvedValue({ ...OT_BROUILLON, statut: "EN_COURS" });
    await expect(otService.assigner("ot-1", { assigneAId: "agent-2" }, "gest-1")).rejects.toMatchObject({ status: 400 });
    expect(h.audits).toHaveLength(0);
  });
});
