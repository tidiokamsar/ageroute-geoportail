import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Non-regression : un chantier sans localisation ne doit PAS apparaitre sur la carte.
 *
 * LE DEFAUT CORRIGE
 *
 * La version precedente repliait sur le centroide de Conakry tout chantier sans
 * geometrie dont la region etait « Non renseigne » ou absente, avec une dispersion
 * deterministe autour du point. Le commentaire du code assumait ce choix : garder le
 * chantier « visible et cliquable » plutot que de le faire disparaitre, en le marquant
 * `approximate`.
 *
 * Mais aucune etiquette ne rend honnete une epingle a Conakry pour un chantier
 * peut-etre situe a Nzerekore. 50 chantiers sur 488 sont dans ce cas. C'est une
 * position inventee, et le §17 du cahier des charges l'interdit.
 *
 * Ils ne disparaissent pas pour autant : listSansLocalisation les rend visibles sans
 * leur preter de position.
 */

const lignesGeo: Record<string, unknown>[] = [];

vi.mock("../../lib/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(async () => lignesGeo),
  },
}));

vi.mock("../../lib/crud-factory", () => ({
  createCrudService: () => ({}),
  createBulkRouter: () => ({}),
}));

vi.mock("../../lib/excel", () => ({ buildExportBuffer: async () => Buffer.from("") }));
vi.mock("../../lib/geo", () => ({ deriveChantierGeom: async () => true }));

import { chantiersService } from "./chantiers.service";

const chantier = (p: Record<string, unknown> = {}) => ({
  id: `c${Math.random().toString(36).slice(2, 8)}`,
  intitule: "Travaux",
  statut: "EN_COURS",
  avancementPct: 50,
  region: "Kankan",
  entreprise: "SOGEA",
  bailleur: null,
  montantGnf: null,
  numContrat: null,
  observations: null,
  tronconId: null,
  pkDebut: null,
  pkFin: null,
  geometry: null,
  /**
   * Ancre regionale, telle que la requete la calcule desormais.
   *
   * Ce sont les valeurs REELLES de `ST_PointOnSurface` sur la limite de Kankan,
   * mesurees le 05/09/2026 — pas des coordonnees de commodite. Une fixture inventee
   * ferait passer un test qui ne prouve rien.
   *
   * `ancreLat: null` represente une region dont la limite n'est pas chargee : c'est le
   * cas des nouvelles regions de Siguiri et de Beyla creees par le decret.
   */
  ancreLat: 10.6288,
  ancreLon: -9.3784,
  ...p,
});

beforeEach(() => {
  lignesGeo.length = 0;
});

describe("Chantiers sur la carte", () => {
  it("N'AFFICHE PAS un chantier rattaché à « Non renseigné »", async () => {
    lignesGeo.push(chantier({ id: "sans", region: "Non renseigné", ancreLat: null, ancreLon: null }));
    const geo = await chantiersService.listGeo();
    expect(geo).toHaveLength(0);
  });

  it("n'affiche pas non plus un chantier sans aucune région", async () => {
    lignesGeo.push(chantier({ id: "vide", region: null, ancreLat: null, ancreLon: null }));
    expect(await chantiersService.listGeo()).toHaveLength(0);
  });

  it("ne replie plus rien sur Conakry", async () => {
    // Le defaut d'origine : le centroide de Conakry est [9.5092, -13.7122].
    lignesGeo.push(
      chantier({ region: "Non renseigné", ancreLat: null, ancreLon: null }),
      chantier({ region: null, ancreLat: null, ancreLon: null }),
    );
    const geo = await chantiersService.listGeo();
    for (const g of geo) {
      expect(Math.abs((g.lat as number) - 9.5092)).toBeGreaterThan(0.5);
    }
    expect(geo).toHaveLength(0);
  });

  it("garde un chantier dont la région est réelle, en le disant approximatif", async () => {
    lignesGeo.push(chantier({ region: "Boké" }));
    const geo = await chantiersService.listGeo();

    expect(geo).toHaveLength(1);
    expect(geo[0].approximate).toBe(true);
    expect(geo[0].localisation).toBe("APPROXIMATIVE");
    expect(geo[0].localisationLibelle).toMatch(/non localisée/);
  });

  it("garde un chantier géométrique, en le disant précis", async () => {
    lignesGeo.push(chantier({ geometry: '{"type":"LineString","coordinates":[[0,0],[1,1]]}' }));
    const geo = await chantiersService.listGeo();

    expect(geo).toHaveLength(1);
    expect(geo[0].approximate).toBe(false);
    expect(geo[0].localisation).toBe("PRECISE");
  });

  it("reconnaît une emprise déduite des PK", async () => {
    lignesGeo.push(chantier({ tronconId: "t1", pkDebut: 24, pkFin: 66 }));
    const geo = await chantiersService.listGeo();

    expect(geo[0].localisation).toBe("LINEAIRE");
    expect(geo[0].localisationLibelle).toMatch(/déduite des PK/);
  });

  it("ne présente jamais une position approximative comme précise", async () => {
    lignesGeo.push(
      chantier({ region: "Labé" }),
      chantier({ tronconId: "t1" }),
      chantier({ geometry: '{"type":"LineString","coordinates":[[0,0],[1,1]]}' })
    );
    const geo = await chantiersService.listGeo();

    for (const g of geo) {
      if (g.localisation === "PRECISE") expect(g.approximate).toBe(false);
      else expect(g.approximate).toBe(true);
    }
  });

  /**
   * Le decret du 05/09/2026 cree les regions de Siguiri et de Beyla. Elles existent au
   * referentiel mais aucune limite de niveau 1 ne les couvre encore : leur ancre est
   * donc nulle. Ces tests fixent ce qui doit alors se passer.
   */
  describe("Une region reelle dont la limite n'est pas encore chargee", () => {
    it("ne pose pas d'epingle", async () => {
      lignesGeo.push(chantier({ region: "Siguiri", ancreLat: null, ancreLon: null }));
      expect(await chantiersService.listGeo()).toHaveLength(0);
    });

    it("ne replie pas sur une autre region", async () => {
      // Le defaut d'origine envoyait a Conakry tout ce qui manquait a la table codee.
      // Une region nouvelle est exactement le cas qui le declenchait.
      lignesGeo.push(
        chantier({ region: "Beyla", ancreLat: null, ancreLon: null }),
        chantier({ region: "Siguiri", ancreLat: null, ancreLon: null }),
      );
      expect(await chantiersService.listGeo()).toEqual([]);
    });

    it("reprend l'epingle des que la limite est chargee, sans toucher au code", async () => {
      // C'est la propriete qui justifie le changement : plus aucune reforme
      // administrative n'exige de modifier un fichier source.
      lignesGeo.push(chantier({ region: "Siguiri", ancreLat: 11.4161, ancreLon: -9.1667 }));
      const geo = await chantiersService.listGeo();

      expect(geo).toHaveLength(1);
      expect(geo[0].approximate).toBe(true);
      expect(geo[0].localisation).toBe("APPROXIMATIVE");
      // L'epingle est dispersee autour de l'ancre, jamais posee dessus a l'identique :
      // sans cela des dizaines de chantiers se superposeraient au meme pixel.
      expect(Math.abs((geo[0].lat as number) - 11.4161)).toBeLessThan(0.2);
      expect(Math.abs((geo[0].lon as number) - -9.1667)).toBeLessThan(0.2);
    });
  });

  it("ne perd aucun chantier localisable de la population mesurée", async () => {
    // 6 precis, 432 regionaux, 50 sans localisation : 438 doivent rester sur la carte.
    for (let i = 0; i < 6; i++) {
      lignesGeo.push(chantier({ geometry: '{"type":"LineString","coordinates":[[0,0],[1,1]]}' }));
    }
    for (let i = 0; i < 432; i++) lignesGeo.push(chantier({ region: "Conakry" }));
    for (let i = 0; i < 50; i++) {
      lignesGeo.push(chantier({ region: "Non renseigné", ancreLat: null, ancreLon: null }));
    }

    const geo = await chantiersService.listGeo();
    expect(geo).toHaveLength(438);
    expect(geo.filter((g) => g.localisation === "PRECISE")).toHaveLength(6);
  });
});
