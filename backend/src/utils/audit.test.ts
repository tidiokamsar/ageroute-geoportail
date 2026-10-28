import { describe, expect, it, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({ auditLog: { create: vi.fn() } }));
vi.mock("../lib/prisma", () => ({ prisma: db }));

import {
  logAudit, logAuditTransactionnelle, normaliserPourJson,
  echecsAuditDepuisDemarrage, _reinitialiserCompteurAudit,
} from "./audit";

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

describe("logAuditTransactionnelle — l'écriture fait partie de la transaction métier", () => {
  it("laisse remonter une panne d'audit pour que la transaction appelante puisse être annulée", async () => {
    const failure = new Error("audit indisponible");
    const tx = { auditLog: { create: vi.fn().mockRejectedValue(failure) } };

    await expect(logAuditTransactionnelle(tx as never, {
      userId: "u1", action: "VALIDATE", entityType: "Observation", entityId: "obs-1",
    })).rejects.toBe(failure);
  });
});

describe("Un montant en BigInt ne doit plus faire disparaitre sa trace", () => {
  /**
   * LE DEFAUT
   *
   * `JSON.stringify({ montantGnf: 12345n })` leve `TypeError: Do not know how to
   * serialize a BigInt`. Verifie, c'est un fait de langage.
   *
   * `decomptes.service.ts` auditait `after: created`, et un decompte porte `montantGnf`
   * en BigInt. L'ecriture d'audit echouait donc vraisemblablement — et comme `logAudit`
   * est fail-soft, l'echec etait AVALE : le decompte s'ecrivait, sa trace non, et seul
   * le compteur de `/api/health` montait.
   *
   * Je n'ai pas pu confirmer que cela se produit en production : il faudrait lire ce
   * compteur. Mais la correction est juste dans les deux cas, et elle est devenue
   * NECESSAIRE : l'audit etant desormais dans la transaction, un echec de serialisation
   * ne serait plus avale — il casserait l'ecriture financiere.
   */
  beforeEach(() => {
    vi.clearAllMocks();
    _reinitialiserCompteurAudit();
  });

  it("confirme que le probleme existe : un BigInt n'est pas serialisable", () => {
    expect(() => JSON.stringify({ montantGnf: 12345n })).toThrow(TypeError);
  });

  it("convertit un BigInt en CHAINE, sans perte", () => {
    // Un montant en francs guineens peut depasser Number.MAX_SAFE_INTEGER ; le modele le
    // declare en BigInt pour cela. Convertir en nombre perdrait de la precision en
    // silence sur les gros montants — ce qu'un journal financier ne doit pas faire.
    const enorme = 9007199254740993n; // MAX_SAFE_INTEGER + 2
    expect(normaliserPourJson(enorme)).toBe("9007199254740993");

    // La chaine fait l'aller-retour SANS PERTE.
    expect(BigInt(String(normaliserPourJson(enorme)))).toBe(enorme);
    // Le nombre, non : il arrondit au flottant voisin, en silence. C'est la raison du
    // choix de la chaine, et la demonstration appartient au test.
    expect(BigInt(Number(enorme))).not.toBe(enorme);
  });

  it("descend dans les objets et les tableaux", () => {
    const valeur = normaliserPourJson({
      montantGnf: 1000n,
      lignes: [{ retenue: 50n }, { retenue: 0n }],
    });
    expect(valeur).toEqual({
      montantGnf: "1000",
      lignes: [{ retenue: "50" }, { retenue: "0" }],
    });
  });

  it("rend le resultat serialisable", () => {
    const decompte = { id: "d1", montantGnf: 1000n, statut: "PAYE" };
    expect(() => JSON.stringify(normaliserPourJson(decompte))).not.toThrow();
  });

  it("LAISSE INTACT ce que JSON sait deja traiter", () => {
    // Perimetre volontairement etroit : un nettoyage profond generique couterait a chaque
    // ecriture et risquerait d'abimer ce qui marche.
    const date = new Date("2026-10-13T00:00:00.000Z");
    expect(normaliserPourJson(date)).toBe(date);
    for (const v of [null, undefined, 42, "texte", true]) {
      expect(normaliserPourJson(v)).toBe(v);
    }
  });

  it("ecrit la trace d'un decompte sans echouer", async () => {
    // Le cas reel, de bout en bout sur l'aide transactionnelle.
    // L'argument est declare pour que `mock.calls[0][0]` soit type : sans lui, vitest
    // infere un tuple vide et tsc refuse l'acces.
    const creer = vi.fn(async (_args: unknown) => ({}));
    const tx = { auditLog: { create: creer } } as unknown as Parameters<typeof logAuditTransactionnelle>[0];
    await logAuditTransactionnelle(tx, {
      userId: "u1", action: "CREATE", entityType: "Decompte", entityId: "d1",
      after: { id: "d1", montantGnf: 1000n },
    });
    const envoye = creer.mock.calls[0][0] as unknown as { data: { after: unknown } };
    expect(envoye.data.after).toEqual({ id: "d1", montantGnf: "1000" });
  });
});
