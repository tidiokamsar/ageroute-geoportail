import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * L'audit transactionnel de la fabrique CRUD : ce que ces tests defendent.
 *
 * LE DEFAUT
 *
 * `logAudit` est volontairement fail-soft : il rattrape l'erreur pour qu'une panne de
 * journalisation ne fasse pas echouer la requete metier. Le prix est qu'une ecriture
 * peut rester en base SANS trace. Sur un etat de troncon, cela veut dire une valeur
 * modifiee dont personne ne peut dire qui l'a changee ni quand — et c'est ce champ qui
 * classe une route pour des travaux.
 *
 * CE QUI EST VERIFIE ICI, ET CE QUI NE L'EST PAS
 *
 * Ces tests prouvent que l'ecriture d'audit est bien PLACEE DANS le tableau passe a
 * `$transaction`, et qu'un echec d'audit fait echouer l'appel au lieu d'etre avale.
 *
 * Ils ne prouvent PAS que PostgreSQL annule la mutation : `$transaction` est simule par
 * `Promise.all`, donc la mutation du faux modele a deja eu lieu quand l'audit echoue.
 * Le rollback est une propriete de la base, pas du code, et l'ADR 11 le dit deja : les
 * tests locaux verifient des transactions simulees, la base reelle ne l'est pas.
 *
 * ET SURTOUT : LES SEPT AUTRES MODULES NE DOIVENT PAS AVOIR CHANGE
 *
 * Huit services partagent cette fabrique. Un seul est migre. Le test le plus important
 * de ce fichier est celui qui verifie que sans l'option, rien ne bouge.
 */

const h = vi.hoisted(() => ({
  /** Operations reellement passees a `$transaction`, pour voir ce qui est atomique. */
  lots: [] as unknown[][],
  /** Fait echouer l'ecriture d'audit, pour eprouver le refus. */
  auditEchoue: false,
}));

vi.mock("./prisma", () => ({
  prisma: {
    $transaction: vi.fn(async (ops: unknown[]) => {
      h.lots.push(ops);
      return Promise.all(ops as Promise<unknown>[]);
    }),
    valeurQualite: { upsert: vi.fn(async () => ({})) },
    auditLog: {
      // Rend un objet MARQUE plutot qu'une promesse : il reste consommable par
      // `Promise.all` et devient reconnaissable dans le lot, ce qui permet de prouver
      // qu'il voyage DANS la transaction et non a cote.
      create: vi.fn(({ data }: { data: Record<string, unknown> }) =>
        h.auditEchoue
          ? Promise.reject(new Error("audit_logs indisponible"))
          : ({ __audit: data } as unknown)),
    },
  },
}));

import { createCrudService } from "./crud-factory";
import { prisma } from "./prisma";

function fauxModele(lignes: Record<string, unknown>[] = []) {
  const rows = [...lignes];
  return {
    findMany: vi.fn(async () => rows),
    count: vi.fn(async () => rows.length),
    // Prisma rend des objets FRAIS. Rendre la ligne vivante aliaserait `before` avec la
    // ligne que `update` modifie ensuite, et le test lirait l'etat d'apres en croyant
    // lire celui d'avant — un faux negatif qui vient du mock, pas du code.
    findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
      const r = rows.find((x) => x.id === where.id && x.deletedAt == null);
      return r ? { ...r } : null;
    }),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const r = rows.find((x) => x.id === where.id);
      return r ? { ...r } : null;
    }),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { deletedAt: null, ...data };
      rows.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = rows.find((r) => r.id === where.id);
      if (!row) throw new Error("introuvable");
      Object.assign(row, data);
      return row;
    }),
  };
}

/** Le lot contient-il une ecriture d'audit ? */
function lotAvecAudit(): Record<string, unknown> | undefined {
  for (const lot of h.lots) {
    for (const op of lot) {
      if (op && typeof op === "object" && "__audit" in (op as object)) {
        return (op as { __audit: Record<string, unknown> }).__audit;
      }
    }
  }
  return undefined;
}

beforeEach(() => {
  h.lots = [];
  h.auditEchoue = false;
  vi.clearAllMocks();
});

describe("Module migre : la mutation et sa trace partent ensemble", () => {
  const migre = (lignes: Record<string, unknown>[] = []) => {
    const model = fauxModele(lignes);
    return { model, service: createCrudService(model, "Inspection", undefined, { auditTransactionnel: true }) };
  };

  it("joint l'audit a la transaction de creation", async () => {
    const { service } = migre();
    await service.create({ etatObserve: "BON" }, "u1");

    const audit = lotAvecAudit();
    expect(audit).toMatchObject({ action: "CREATE", entityType: "Inspection", userId: "u1" });
    // L'identifiant est tire AVANT l'insertion — c'est ce qui permet a la trace de
    // connaitre sa cible sans attendre la reponse de la base.
    expect(audit?.entityId).toBeTruthy();
  });

  it("joint l'audit a la transaction de modification, avec l'etat precedent", async () => {
    const { service } = migre([{ id: "a", etatObserve: "MAUVAIS", deletedAt: null }]);
    await service.update("a", { etatObserve: "BON" }, "u1");

    const audit = lotAvecAudit();
    expect(audit).toMatchObject({ action: "UPDATE", entityId: "a" });
    // `before` est LU en base avant la transaction : c'est la seule partie dont on
    // connaisse la valeur reelle.
    expect(audit?.before).toMatchObject({ etatObserve: "MAUVAIS" });
  });

  it("enregistre l'etat PROJETE et non la seule modification", async () => {
    // Consequence de la forme tableau : la ligne retournee n'est pas connue au moment de
    // construire la trace. L'etat projete se reconstruit depuis l'etat lu et la
    // modification, ce qui est plus lisible qu'un `after` ne contenant que le delta.
    const { service } = migre([{ id: "a", etatObserve: "MAUVAIS", recommandations: "a revoir", deletedAt: null }]);
    await service.update("a", { etatObserve: "BON" }, "u1");

    expect(lotAvecAudit()?.after).toMatchObject({
      etatObserve: "BON",
      recommandations: "a revoir",
    });
  });

  it("joint l'audit a l'archivage, qui est le geste le plus silencieux", async () => {
    // Une archive sans trace est une disparition : la donnee quitte les listes
    // operationnelles et rien ne dit qui l'en a retiree.
    const { service } = migre([{ id: "a", deletedAt: null }]);
    await service.remove("a", "u1");
    expect(lotAvecAudit()).toMatchObject({ action: "DELETE", entityId: "a" });
  });

  it("joint l'audit a la restauration", async () => {
    const { service } = migre([{ id: "a", deletedAt: new Date() }]);
    await service.restore("a", "u1");
    expect(lotAvecAudit()).toMatchObject({ action: "RESTORE", entityId: "a" });
  });

  it("FAIT ECHOUER L'APPEL quand l'audit echoue, au lieu de l'avaler", async () => {
    // Le coeur du changement. Avant, l'erreur etait rattrapee et la requete reussissait :
    // l'etat changeait sans trace, et seul un compteur dans /api/health le signalait.
    h.auditEchoue = true;
    const { service } = migre([{ id: "a", etatObserve: "MAUVAIS", deletedAt: null }]);
    await expect(service.update("a", { etatObserve: "BON" }, "u1"))
      .rejects.toThrow("audit_logs indisponible");
  });

  it("fait aussi echouer un archivage dont l'audit echoue", async () => {
    h.auditEchoue = true;
    const { service } = migre([{ id: "a", deletedAt: null }]);
    await expect(service.remove("a", "u1")).rejects.toThrow("audit_logs indisponible");
  });
});

describe("Modules non migres : RIEN ne doit avoir change", () => {
  /**
   * Le test le plus important du fichier.
   *
   * Sept services partagent cette fabrique — chantiers, documents, marches, ouvrages,
   * points noirs, postes, troncons. Basculer leur comportement sans arbitrage
   * transformerait une panne de journalisation en panne d'ecriture sur tout le chemin
   * patrimonial. L'ADR 11 est « propose, approbation non documentee » : il prevoit une
   * migration explicite, module par module.
   */
  const nonMigre = (lignes: Record<string, unknown>[] = []) => {
    const model = fauxModele(lignes);
    return { model, service: createCrudService(model, "Troncon") };
  };

  it("n'ecrit AUCUN audit dans la transaction", async () => {
    const { service } = nonMigre([{ id: "a", nom: "RN1", deletedAt: null }]);
    await service.update("a", { nom: "RN1 bis" }, "u1");
    expect(lotAvecAudit()).toBeUndefined();
  });

  it("reussit malgre un audit en panne, comme avant", async () => {
    // La garantie historique : une panne de journalisation ne fait pas echouer la
    // requete metier. Elle reste vraie ici, et c'est voulu.
    h.auditEchoue = true;
    const { service } = nonMigre([{ id: "a", nom: "RN1", deletedAt: null }]);
    const r = await service.update("a", { nom: "RN1 bis" }, "u1");
    expect(r).toMatchObject({ id: "a", nom: "RN1 bis" });
  });

  it("archive sans transaction d'audit", async () => {
    const { service, model } = nonMigre([{ id: "a", deletedAt: null }]);
    await service.remove("a", "u1");
    expect(model.update).toHaveBeenCalledWith({ where: { id: "a" }, data: { deletedAt: expect.any(Date) } });
    expect(lotAvecAudit()).toBeUndefined();
  });

  it("garde la provenance dans la transaction, migre ou non", async () => {
    // La traçabilite des valeurs, elle, etait deja atomique des deux cotes : la migration
    // de l'audit ne doit pas l'avoir deplacee.
    const { service } = nonMigre([{ id: "a", etat: "MAUVAIS", deletedAt: null }]);
    await service.update("a", { etat: "BON" }, "u1");
    expect(prisma.valeurQualite.upsert).toHaveBeenCalled();
    expect(h.lots.length).toBeGreaterThan(0);
  });
});
