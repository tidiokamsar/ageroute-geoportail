import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * La fiche 360 d'un troncon : ce que ces tests defendent.
 *
 * TROIS HONNETETES, ET CHACUNE EST UN MENSONGE EVITE
 *
 * **La longueur mesuree ne remplace jamais la longueur declaree.** `longueurKm` vient
 * d'AGEROUTE, la geometrique de la numerisation. Mesure du 13/10/2026 : elles s'accordent a
 * moins de 20 % partout, MAIS 1 028 des 1 029 troncons regionaux n'ont aucune longueur
 * declaree. Rendre la seule geometrique les ferait passer pour documentes.
 *
 * **Sans longueur mesuree, aucune couverture n'est rendue.** Un pourcentage sans
 * denominateur serait invente, et c'est pire qu'une absence affichee.
 *
 * **Les trous sont nommes par leurs abscisses.** « 60 % qualifie » n'envoie personne nulle
 * part ; « non qualifie de 8 000 a 13 000 » envoie une equipe au bon endroit.
 *
 * ET LES CHEVAUCHEMENTS SONT SIGNALES, PAS CORRIGES
 *
 * Deux portions qui se recouvrent disent deux choses du meme metre. Trancher appartient a un
 * humain ; la fiche se contente de montrer la contradiction.
 */

const h = vi.hoisted(() => ({
  portions: [] as Record<string, unknown>[],
  longueurM: null as number | null,
  troncon: { id: "t-1", code: "GN N0001 3-1216", longueurKm: 20 } as Record<string, unknown>,
}));

vi.mock("../../lib/prisma", () => {
  const vide = { findMany: async () => [] };
  return {
    prisma: {
      troncon: { findFirst: async () => h.troncon, findUnique: async () => h.troncon },
      ouvrage: vide, pointNoir: vide, poste: vide, chantier: vide,
      inspection: vide, defaut: vide, mission: vide,
      portion: { findMany: async () => h.portions },
      $queryRaw: async () => (h.longueurM === null ? [] : [{ m: h.longueurM }]),
    },
  };
});

vi.mock("../../lib/crud-factory", () => ({
  createCrudService: () => ({
    getById: async () => h.troncon,
    list: async () => [], create: async () => h.troncon,
    update: async () => h.troncon, remove: async () => h.troncon, restore: async () => h.troncon,
  }),
}));

import { tronconsService } from "./troncons.service";

function portion(over: Record<string, unknown> = {}) {
  return {
    id: "p-1", tronconId: "t-1", debutM: 0, finM: 8_000,
    revetement: "LATERITE", etat: "MOYEN", praticabilite: null, largeurM: null,
    source: null, observeeLe: null, confiance: null,
    statutValidation: "VALIDE", origine: "SAISIE_TERRAIN", clientOperationId: null,
    remplaceeLe: null, deletedAt: null,
    revetementRef: { code: "LATERITE", libelle: "Latérite", bitumineux: false },
    etatRef: { code: "MOYEN", libelle: "Moyen", critique: false },
    praticabiliteRef: null,
    creePar: { id: "u-1", nomComplet: "Mamadou Diallo" },
    ...over,
  };
}

beforeEach(() => {
  h.portions = [];
  h.longueurM = 20_000;
  h.troncon = { id: "t-1", code: "GN N0001 3-1216", longueurKm: 20 };
});

describe("La longueur mesuree et la longueur declaree coexistent", () => {
  it("rend les DEUX, cote a cote", async () => {
    const f = await tronconsService.fiche("t-1");
    expect(f.longueurGeometriqueM).toBe(20_000);
    expect((f.troncon as { longueurKm: number }).longueurKm).toBe(20);
  });

  it("rend NULL quand le trace n'est pas exploitable, sans se replier sur la declaree", async () => {
    // Se replier ferait passer 1 028 troncons regionaux sans longueur declaree pour
    // documentes, ou l'inverse.
    h.longueurM = null;
    const f = await tronconsService.fiche("t-1");
    expect(f.longueurGeometriqueM).toBeNull();
    expect((f.troncon as { longueurKm: number }).longueurKm).toBe(20);
  });
});

describe("La couverture refuse d'etre inventee", () => {
  it("est NULLE quand la longueur mesuree manque", async () => {
    // Un pourcentage sans denominateur serait invente.
    h.longueurM = null;
    h.portions = [portion()];
    const f = await tronconsService.fiche("t-1");
    expect(f.couverture).toBeNull();
    expect(f.repartitions).toBeNull();
  });

  it("dit zero et nomme le trou pour un troncon SANS portion", async () => {
    const f = await tronconsService.fiche("t-1");
    expect(f.couverture).toMatchObject({ qualifieM: 0, part: 0 });
    expect(f.couverture?.trous).toEqual([{ debutM: 0, finM: 20_000, longueurM: 20_000 }]);
  });

  it("nomme les trous par leurs ABSCISSES, pas par un pourcentage", async () => {
    h.portions = [
      portion({ id: "a", debutM: 0, finM: 8_000 }),
      portion({ id: "b", debutM: 13_000, finM: 20_000 }),
    ];
    const f = await tronconsService.fiche("t-1");
    expect(f.couverture?.trous).toEqual([{ debutM: 8_000, finM: 13_000, longueurM: 5_000 }]);
    expect(f.couverture?.part).toBe(0.75);
  });
});

describe("Les repartitions ne laissent pas croire le troncon inventorie", () => {
  it("affiche TOUJOURS la part NON_QUALIFIEE", async () => {
    h.portions = [portion({ debutM: 0, finM: 5_000 })];
    const f = await tronconsService.fiche("t-1");
    const cles = f.repartitions!.revetement.map((r) => r.cle);
    expect(cles).toContain("NON_QUALIFIE");
    expect(f.repartitions!.revetement.find((r) => r.cle === "NON_QUALIFIE")?.longueurM).toBe(15_000);
  });

  it("distingue NON_RENSEIGNE de NON_QUALIFIE", async () => {
    // Le premier dit « personne n'a releve sur ces metres qualifies », le second « ces
    // metres n'ont pas ete inventories ». Les confondre perd l'information utile.
    h.portions = [portion({ debutM: 0, finM: 5_000, revetement: null, revetementRef: null })];
    const f = await tronconsService.fiche("t-1");
    const cles = f.repartitions!.revetement.map((r) => r.cle);
    expect(cles).toContain("NON_RENSEIGNE");
    expect(cles).toContain("NON_QUALIFIE");
  });

  it("rend les trois axes : revetement, etat, praticabilite", async () => {
    // Une route peut etre bitumee et en mauvais etat, et praticable malgre tout.
    h.portions = [portion()];
    const f = await tronconsService.fiche("t-1");
    expect(Object.keys(f.repartitions!)).toEqual(["revetement", "etat", "praticabilite"]);
  });
});

describe("Ce que la fiche ajoute et ne remplace pas", () => {
  it("conserve les cinq collections d'origine", async () => {
    // La fiche a ete ETENDUE : en construire une seconde aurait laisse deux verites sur le
    // meme objet, dont une seule serait maintenue.
    const f = await tronconsService.fiche("t-1");
    for (const k of ["ouvrages", "pointsNoirs", "postes", "chantiers", "inspections"]) {
      expect(f).toHaveProperty(k);
    }
  });

  it("ajoute portions, defauts et missions", async () => {
    const f = await tronconsService.fiche("t-1");
    for (const k of ["portions", "defauts", "missions"]) {
      expect(f).toHaveProperty(k);
    }
  });

  it("SIGNALE un chevauchement sans le corriger", async () => {
    h.portions = [
      portion({ id: "a", debutM: 0, finM: 1_000 }),
      portion({ id: "b", debutM: 800, finM: 1_500 }),
    ];
    const f = await tronconsService.fiche("t-1");
    expect(f.chevauchements).toHaveLength(1);
    expect(f.chevauchements[0]).toMatchObject({ a: "a", b: "b", longueurM: 200 });
    // Et les deux portions sont rendues telles quelles : rien n'a ete ecarte.
    expect(f.portions).toHaveLength(2);
  });
});
