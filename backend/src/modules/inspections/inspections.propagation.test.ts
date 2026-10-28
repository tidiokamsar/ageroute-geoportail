import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * La propagation d'etat d'une inspection : ce que ces tests defendent.
 *
 * POURQUOI CE CHEMIN PLUS QUE LES AUTRES
 *
 * Une inspection est le seul evenement de la base qui produise une valeur REELLEMENT
 * constatee — datee, attribuee, de methode connue. Elle propage cet etat au troncon ou a
 * l'ouvrage inspecte, et c'est ce champ `etat` qui classe une route pour des travaux.
 *
 * Ces deux ecritures — l'etat et sa trace — etaient successives. Un echec de
 * journalisation laissait donc un etat patrimonial modifie sans dire qui l'avait change
 * ni quand, et seul un compteur dans `/api/health` le signalait. C'est le pire silence
 * possible sur ce champ.
 *
 * CE QUI EST VERIFIE ICI, ET CE QUI NE L'EST PAS
 *
 * Que les deux ecritures partent dans le MEME appel a `$transaction`. Pas que PostgreSQL
 * annule : `$transaction` est simule, et le rollback est une propriete de la base.
 */

const h = vi.hoisted(() => ({
  lots: [] as unknown[][],
  troncon: null as Record<string, unknown> | null,
  ouvrage: null as Record<string, unknown> | null,
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(async (ops: unknown[]) => {
      h.lots.push(ops);
      return Promise.all(ops as Promise<unknown>[]);
    }),
    auditLog: {
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => ({ __audit: data } as unknown)),
    },
    troncon: {
      findUnique: vi.fn(async () => h.troncon),
      update: vi.fn(({ data }: { data: Record<string, unknown> }) => ({ __maj: data } as unknown)),
    },
    ouvrage: {
      findUnique: vi.fn(async () => h.ouvrage),
      update: vi.fn(({ data }: { data: Record<string, unknown> }) => ({ __maj: data } as unknown)),
    },
    inspection: {},
    valeurQualite: { upsert: vi.fn(async () => ({})) },
  },
}));

// La fabrique CRUD et le service de photos ne sont pas le sujet : on les neutralise pour
// que la propagation soit observee seule.
vi.mock("../../lib/crud-factory", () => ({
  createCrudService: () => ({
    list: vi.fn(), getById: vi.fn(),
    create: vi.fn(async (data: Record<string, unknown>) => ({ id: "i1", ...data })),
    update: vi.fn(async (_id: string, data: Record<string, unknown>) => ({ id: "i1", ...data })),
    remove: vi.fn(), restore: vi.fn(), bulkRemove: vi.fn(), bulkRestore: vi.fn(),
  }),
}));
vi.mock("../../lib/photos", () => ({
  createPhotoService: () => ({ addPhoto: vi.fn(), removePhoto: vi.fn() }),
}));
vi.mock("../../lib/qualite", () => ({
  // Marque comme les autres, pour qu'on puisse prouver que la ligne de qualite voyage
  // DANS la transaction et non a cote.
  construireQualite: vi.fn((e: Record<string, unknown>) => ({ __qualite: e } as unknown)),
}));

import { inspectionsService } from "./inspections.service";

/** Le lot contient-il la mutation, sa trace ET sa ligne de qualite ? */
function lotComplet() {
  const marque = (lot: unknown[], cle: string) =>
    lot.find((o) => o && typeof o === "object" && cle in (o as object)) as
      Record<string, Record<string, unknown>> | undefined;

  for (const lot of h.lots) {
    const maj = marque(lot, "__maj");
    const audit = marque(lot, "__audit");
    const qualite = marque(lot, "__qualite");
    if (maj && audit && qualite) {
      return { maj: maj.__maj, audit: audit.__audit, qualite: qualite.__qualite };
    }
  }
  return null;
}

beforeEach(() => {
  h.lots = [];
  h.troncon = null;
  h.ouvrage = null;
  vi.clearAllMocks();
});

describe("L'etat propage et sa trace partent ensemble", () => {
  it("joint l'audit a la mise a jour du troncon", async () => {
    h.troncon = { etat: "MAUVAIS" };
    await inspectionsService.create(
      { tronconId: "t1", etatObserve: "BON", dateInspection: "2026-10-12T00:00:00.000Z" },
      "u1",
    );

    const lot = lotComplet();
    expect(lot).not.toBeNull();
    expect(lot?.maj).toMatchObject({ etat: "BON" });
    expect(lot?.audit).toMatchObject({
      action: "UPDATE", entityType: "Troncon", entityId: "t1", userId: "u1",
    });
    // L'etat precedent est conserve : sans lui, la trace ne dit pas ce qui a ete ecrase.
    expect(lot?.audit.before).toMatchObject({ etat: "MAUVAIS" });

    // LA LIGNE DE QUALITE VOYAGE DANS LA MEME TRANSACTION.
    //
    // Elle partait apres, hors transaction : un echec apres le commit laissait un etat
    // trace SANS sa provenance, et la base affirmait « etat BON » sans pouvoir dire qu'il
    // venait d'un releve de terrain date et attribue.
    expect(lot?.qualite).toMatchObject({
      entityType: "Troncon", entityId: "t1", champ: "etat",
      statut: "OBSERVED", source: "INSPECTION_TERRAIN", confiance: "HIGH",
      observedById: "u1",
    });
  });

  it("n'ouvre qu'UNE transaction pour les trois ecritures", async () => {
    // Trois transactions successives ne vaudraient pas mieux que trois ecritures : ce
    // qui compte est qu'elles reussissent ou echouent ENSEMBLE.
    h.troncon = { etat: "MAUVAIS" };
    await inspectionsService.create({ tronconId: "t1", etatObserve: "BON" }, "u1");
    expect(h.lots.length).toBe(1);
    expect(h.lots[0].length).toBe(3);
  });

  it("joint l'audit a la mise a jour de l'ouvrage", async () => {
    h.ouvrage = { etat: "CRITIQUE" };
    await inspectionsService.create({ ouvrageId: "o1", etatObserve: "MOYEN" }, "u1");

    const lot = lotComplet();
    expect(lot?.audit).toMatchObject({ entityType: "Ouvrage", entityId: "o1" });
    expect(lot?.audit.before).toMatchObject({ etat: "CRITIQUE" });
  });

  it("ecrit la date du CONSTAT et non celle de la saisie", async () => {
    // `dateDerniereEvaluation` n'etait jamais ecrite : les 647 troncons dont l'etat est
    // connu n'etaient donc pas comparables entre eux, un « BON » de cette annee occupant
    // la meme case qu'un « BON » d'il y a dix ans.
    h.troncon = { etat: "MAUVAIS" };
    await inspectionsService.create(
      { tronconId: "t1", etatObserve: "BON", dateInspection: "2024-03-15T00:00:00.000Z" },
      "u1",
    );
    const maj = lotComplet()?.maj as { dateDerniereEvaluation?: Date };
    expect(maj.dateDerniereEvaluation?.toISOString()).toBe("2024-03-15T00:00:00.000Z");
  });
});

describe("Ce que la propagation refuse de faire", () => {
  it("NE PROPAGE PAS un NON_EVALUE", async () => {
    // Enregistrer « non evalue » lors d'une inspection effacerait un etat deja connu.
    // Une absence de constat n'est pas un constat d'absence.
    h.troncon = { etat: "BON" };
    await inspectionsService.create({ tronconId: "t1", etatObserve: "NON_EVALUE" }, "u1");
    expect(h.lots).toEqual([]);
  });

  it("ne propage rien sans etat observe", async () => {
    h.troncon = { etat: "BON" };
    await inspectionsService.create({ tronconId: "t1" }, "u1");
    expect(h.lots).toEqual([]);
  });

  it("N'ECRIT AUCUNE LIGNE DE QUALITE si la cible est introuvable", async () => {
    // LE DEFAUT CORRIGE. La ligne de qualite s'ecrivait hors des gardes : quand la cible
    // etait introuvable, aucun etat n'etait propage et une ligne de qualite etait
    // pourtant ecrite, affirmant une provenance de releve terrain pour une valeur jamais
    // posee. Regrouper les trois ecritures sous une seule garde ferme le cas par
    // construction.
    h.troncon = null;
    await inspectionsService.create({ tronconId: "inconnu", etatObserve: "BON" }, "u1");
    expect(h.lots).toEqual([]);
    const { construireQualite } = await import("../../lib/qualite");
    expect(construireQualite).not.toHaveBeenCalled();
  });

  it("prefere l'ouvrage au troncon quand les deux sont fournis", async () => {
    // Le comportement existant : une inspection porte sur UN element. Le figer evite
    // qu'une refonte le change par accident et propage deux fois.
    h.ouvrage = { etat: "BON" };
    h.troncon = { etat: "BON" };
    await inspectionsService.create({ ouvrageId: "o1", tronconId: "t1", etatObserve: "MOYEN" }, "u1");
    expect(lotComplet()?.audit).toMatchObject({ entityType: "Ouvrage" });
    expect(h.lots.length).toBe(1);
  });
});
