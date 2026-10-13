import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * L'audit transactionnel de la fabrique CRUD : ce que ces tests defendent.
 *
 * LE DEFAUT D'ORIGINE
 *
 * `logAudit` est volontairement fail-soft : il rattrape l'erreur pour qu'une panne de
 * journalisation ne fasse pas echouer la requete metier. Le prix est qu'une ecriture peut
 * rester en base SANS trace. Sur un etat de troncon, cela veut dire une valeur modifiee
 * dont personne ne peut dire qui l'a changee ni quand.
 *
 * LA FIDELITE DU CHAMP `after`, ARBITREE LE 13/10/2026
 *
 * Le premier montage transactionnel utilisait la forme TABLEAU de `$transaction`. Les
 * ecritures y partent ensemble, donc la ligne retournee par la base n'etait pas connue
 * au moment de construire la trace : `after` ne pouvait valoir qu'un etat PROJETE,
 * reconstruit depuis l'etat lu et la modification. Les colonnes calculees par la base
 * n'y figuraient pas, et c'etait une perte face au helper historique.
 *
 * L'arbitrage a tranche pour la fidelite. Les modules migres passent donc a la forme
 * INTERACTIVE, et `after` redevient la ligne telle que la base l'a rendue.
 *
 * LE PIEGE QUE CE FICHIER SURVEILLE
 *
 * Le commit 4eb1525 avait deja essaye l'interactif, en retrouvant le modele par son nom
 * DERIVE de l'entite. Cela compilait, fonctionnait, et court-circuitait le delegue
 * injecte dans la fabrique : ce fichier-la s'est mis a echouer parce qu'il ne voyait plus
 * l'appel qu'il verifie. Le delegue est desormais DESIGNE par l'appelant, et le test
 * verifie qu'on passe bien par celui qu'il a injecte.
 *
 * CE QUI N'EST PAS PROUVE ICI
 *
 * Que PostgreSQL annule. `$transaction` est simule, donc la mutation du faux modele a
 * deja eu lieu quand l'audit echoue. Le rollback est une propriete de la base.
 */

const h = vi.hoisted(() => ({
  /** Lots passes a la forme TABLEAU, pour les modules NON migres. */
  lots: [] as unknown[][],
  /** Traces ecrites dans la transaction interactive. */
  audits: [] as Record<string, unknown>[],
  /** Ecritures de provenance vues sur le client de la transaction. */
  provenances: 0,
  auditEchoue: false,
  /** Delegue que le test injecte, et que `delegueTransactionnel` doit retrouver. */
  delegue: null as unknown,
}));

vi.mock("./prisma", () => {
  const upsert = vi.fn(() => ({}) as unknown);
  return {
    prisma: {
      $transaction: vi.fn(async (arg: unknown) => {
        // La fabrique utilise les DEUX formes : interactive pour les modules migres,
        // tableau pour les autres. Le mock doit servir les deux, sinon il ne prouve
        // qu'une moitie du comportement.
        if (typeof arg === "function") {
          const tx = {
            modele: h.delegue,
            valeurQualite: {
              upsert: vi.fn(() => {
                h.provenances++;
                return {} as unknown;
              }),
            },
            auditLog: {
              create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
                if (h.auditEchoue) throw new Error("audit_logs indisponible");
                h.audits.push(data);
                return data;
              }),
            },
          };
          return (arg as (t: unknown) => Promise<unknown>)(tx);
        }
        h.lots.push(arg as unknown[]);
        return Promise.all(arg as Promise<unknown>[]);
      }),
      valeurQualite: { upsert },
      auditLog: { create: vi.fn(async () => ({})) },
    },
  };
});

import { createCrudService } from "./crud-factory";

/**
 * Faux modele.
 *
 * `update` et `create` ajoutent `updatedAt`, que l'appelant n'a JAMAIS envoye : c'est
 * ainsi qu'on distingue une trace fidele d'un etat projete. Un `after` reconstruit depuis
 * l'entree ne pourrait pas le contenir.
 */
function fauxModele(lignes: Record<string, unknown>[] = []) {
  const rows = [...lignes];
  const horodater = () => new Date("2026-10-13T12:00:00.000Z");
  return {
    findMany: vi.fn(async () => rows.map((r) => ({ ...r }))),
    count: vi.fn(async () => rows.length),
    findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
      const r = rows.find((x) => x.id === where.id && x.deletedAt == null);
      return r ? { ...r } : null;
    }),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const r = rows.find((x) => x.id === where.id);
      return r ? { ...r } : null;
    }),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { deletedAt: null, ...data, updatedAt: horodater() };
      rows.push(row);
      return { ...row };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = rows.find((x) => x.id === where.id);
      if (!row) throw new Error("introuvable");
      Object.assign(row, data, { updatedAt: horodater() });
      return { ...row };
    }),
  };
}

beforeEach(() => {
  h.lots = [];
  h.audits = [];
  h.provenances = 0;
  h.auditEchoue = false;
  vi.clearAllMocks();
});

let modeleCourant: ReturnType<typeof fauxModele>;

function migre(lignes: Record<string, unknown>[] = []) {
  modeleCourant = fauxModele(lignes);
  h.delegue = modeleCourant;
  const service = createCrudService(modeleCourant, "Inspection", undefined, {
    auditTransactionnel: true,
    delegueTransactionnel: (tx) => (tx as { modele: unknown }).modele as never,
  });
  return { model: modeleCourant, service };
}

function nonMigre(lignes: Record<string, unknown>[] = []) {
  const model = fauxModele(lignes);
  return { model, service: createCrudService(model, "Troncon") };
}

describe("Module migre : la trace est FIDELE a ce que la base a rendu", () => {
  it("enregistre la ligne retournee, colonnes calculees comprises", async () => {
    // LE TEST DE L'ARBITRAGE. `updatedAt` n'a jamais ete envoye par l'appelant : il vient
    // de la base. Un `after` reconstruit depuis l'entree ne pourrait pas le contenir, et
    // c'est exactement ce que la forme tableau imposait avant cet arbitrage.
    const { service } = migre([{ id: "a", etatObserve: "MAUVAIS", deletedAt: null }]);
    await service.update("a", { etatObserve: "BON" }, "u1");

    const after = h.audits[0].after as Record<string, unknown>;
    expect(after.etatObserve).toBe("BON");
    expect(after.updatedAt).toBeInstanceOf(Date);
    expect(h.audits[0]).toMatchObject({ action: "UPDATE", entityId: "a", userId: "u1" });
    expect((h.audits[0].before as Record<string, unknown>).etatObserve).toBe("MAUVAIS");
  });

  it("enregistre la ligne creee et non les donnees envoyees", async () => {
    const { service } = migre();
    await service.create({ etatObserve: "BON" }, "u1");

    const after = h.audits[0].after as Record<string, unknown>;
    expect(after.updatedAt).toBeInstanceOf(Date);
    expect(after.deletedAt).toBeNull();
    expect(h.audits[0].action).toBe("CREATE");
  });

  it("PASSE PAR LE DELEGUE INJECTE, et non par un modele devine", async () => {
    // Le piege de 4eb1525 : retrouver le modele par son nom derive de l'entite
    // fonctionnait et court-circuitait l'injection. Si cela se reproduisait, ce test
    // tomberait.
    const { service, model } = migre([{ id: "a", deletedAt: null }]);
    await service.update("a", { nom: "x" }, "u1");
    expect(model.update).toHaveBeenCalledWith({ where: { id: "a" }, data: { nom: "x" } });
  });

  it("ECRIT LA PROVENANCE SUR LE CLIENT DE LA TRANSACTION", async () => {
    /**
     * Le piege silencieux de ce passage a l'interactif : la provenance partait sur le
     * client de base et cessait de faire partie de la transaction. Tout continuerait de
     * fonctionner, jusqu'au premier echec.
     *
     * CE TEST PROTEGE UNE MIGRATION FUTURE, PAS CELLE D'AUJOURD'HUI. `CHAMPS_SUIVIS` ne
     * couvre que Troncon, Ouvrage et Chantier : pour Inspection, `construireSaisies`
     * rend une liste vide et le risque est nul. Il devient entier le jour ou l'un de ces
     * trois migrera — et ce jour-la, personne ne pensera a verifier ce point.
     *
     * On eprouve donc le mecanisme sur une entite REELLEMENT suivie.
     */
    modeleCourant = fauxModele([{ id: "a", etat: "MAUVAIS", deletedAt: null }]);
    h.delegue = modeleCourant;
    const service = createCrudService(modeleCourant, "Troncon", undefined, {
      auditTransactionnel: true,
      delegueTransactionnel: (tx) => (tx as { modele: unknown }).modele as never,
    });

    await service.update("a", { etat: "BON" }, "u1");
    expect(h.provenances).toBeGreaterThan(0);
    // Et la trace reste fidele sur ce chemin aussi.
    expect((h.audits[0].after as Record<string, unknown>).updatedAt).toBeInstanceOf(Date);
  });

  it("n'ecrit aucune provenance pour une entite non suivie", async () => {
    // Inspection n'est pas dans `CHAMPS_SUIVIS`. Ecrire une ligne de provenance pour elle
    // affirmerait une tracabilite de champ qui n'a pas ete decidee.
    const { service } = migre([{ id: "a", etatObserve: "MAUVAIS", deletedAt: null }]);
    await service.update("a", { etatObserve: "BON" }, "u1");
    expect(h.provenances).toBe(0);
  });

  it("trace l'archivage avec la ligne archivee", async () => {
    const { service } = migre([{ id: "a", deletedAt: null }]);
    await service.remove("a", "u1");
    expect(h.audits[0].action).toBe("DELETE");
    expect((h.audits[0].after as Record<string, unknown>).deletedAt).toBeInstanceOf(Date);
  });

  it("trace la restauration avec la ligne restauree", async () => {
    const { service } = migre([{ id: "a", deletedAt: new Date() }]);
    await service.restore("a", "u1");
    expect(h.audits[0].action).toBe("RESTORE");
    expect((h.audits[0].after as Record<string, unknown>).deletedAt).toBeNull();
  });

  it("FAIT ECHOUER L'APPEL quand l'audit echoue, au lieu de l'avaler", async () => {
    h.auditEchoue = true;
    const { service } = migre([{ id: "a", deletedAt: null }]);
    await expect(service.update("a", { nom: "x" }, "u1")).rejects.toThrow("audit_logs indisponible");
  });

  it("fait aussi echouer un archivage dont l'audit echoue", async () => {
    h.auditEchoue = true;
    const { service } = migre([{ id: "a", deletedAt: null }]);
    await expect(service.remove("a", "u1")).rejects.toThrow("audit_logs indisponible");
  });
});

describe("Une fabrique mal configuree se voit au montage", () => {
  it("refuse auditTransactionnel sans delegue", () => {
    // Au DEMARRAGE et non a la premiere ecriture : une erreur de montage doit tomber
    // quand le module se charge, pas en pleine synchronisation de terrain.
    expect(() => createCrudService(fauxModele(), "Inspection", undefined, {
      auditTransactionnel: true,
    })).toThrow(/delegueTransactionnel/);
  });
});

describe("Modules non migres : RIEN ne doit avoir change", () => {
  /**
   * Le test le plus important du fichier.
   *
   * Sept services partagent cette fabrique. Basculer leur comportement sans arbitrage
   * transformerait une panne de journalisation en panne d'ecriture sur tout le chemin
   * patrimonial. L'ADR 11 reste « propose » et prevoit une migration explicite.
   */
  it("n'ouvre aucune transaction interactive", async () => {
    const { service } = nonMigre([{ id: "a", nom: "RN1", deletedAt: null }]);
    await service.update("a", { nom: "RN1 bis" }, "u1");
    // Forme tableau uniquement, et aucune trace dans la transaction.
    expect(h.lots.length).toBeGreaterThan(0);
    expect(h.audits).toEqual([]);
  });

  it("reussit malgre un audit en panne, comme avant", async () => {
    // La garantie historique : une panne de journalisation ne fait pas echouer la requete
    // metier. Elle reste vraie ici, et c'est voulu.
    h.auditEchoue = true;
    const { service } = nonMigre([{ id: "a", nom: "RN1", deletedAt: null }]);
    const r = await service.update("a", { nom: "RN1 bis" }, "u1");
    expect(r).toMatchObject({ id: "a", nom: "RN1 bis" });
  });

  it("archive sans transaction interactive", async () => {
    const { service, model } = nonMigre([{ id: "a", deletedAt: null }]);
    await service.remove("a", "u1");
    expect(model.update).toHaveBeenCalledWith({ where: { id: "a" }, data: { deletedAt: expect.any(Date) } });
    expect(h.audits).toEqual([]);
  });
});
