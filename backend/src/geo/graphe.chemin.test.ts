import { describe, expect, it } from "vitest";
import { cheminEntre, construireGraphe, type TronconGraphe } from "./graphe.noyau";

/**
 * Chemin entre deux positions du reseau (route entre deux villes) : ce que ces tests defendent.
 *
 *   - le chemin rendu est la liste ORDONNEE des troncons, chacun avec son sens de parcours ;
 *   - un troncon emprunte seulement en partie (la ville est en son milieu) l'est avec ses abscisses reelles ;
 *   - deux routes possibles : la plus courte ;
 *   - un trou dans le referentiel n'est jamais comble par une ligne droite : « aucun chemin » ;
 *   - un troncon hors du lot est refuse, une borne nulle est refusee.
 */

const LAT0 = 10.5;
const LON0 = -13.0;
const M_PAR_DEG_LAT = 110574;
const M_PAR_DEG_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const pt = (estM: number, nordM: number): [number, number] => [LON0 + estM / M_PAR_DEG_LON, LAT0 + nordM / M_PAR_DEG_LAT];
const troncon = (id: string, de: [number, number], a: [number, number]): TronconGraphe => ({
  id, coordonnees: [pt(...de), pt(...a)], longueurM: Math.hypot(a[0] - de[0], a[1] - de[1]),
});

// Une route en trois troncons bout a bout : t1 (0-10 km), t2 (10-25 km), t3 (25-40 km), vers l'est.
const t1 = troncon("t1", [0, 0], [10_000, 0]);
const t2 = troncon("t2", [10_000, 0], [25_000, 0]);
const t3 = troncon("t3", [25_000, 0], [40_000, 0]);

describe("cheminEntre", () => {
  it("liste les troncons dans l'ordre, du depart a l'arrivee, avec leurs abscisses", () => {
    const g = construireGraphe([t1, t2, t3], 5);
    const c = cheminEntre(g, { tronconId: "t1", abscisseM: 2_000 }, { tronconId: "t3", abscisseM: 5_000 }, { distanceMaxM: 100_000 });
    expect("refus" in c).toBe(false);
    if ("refus" in c) return;
    expect(c.segments.map((s) => s.tronconId)).toEqual(["t1", "t2", "t3"]);
    // Depart a 2 km de t1 : on emprunte les 8 km restants ; arrivee a 5 km de t3 : seulement les 5 premiers.
    expect(c.segments[0]).toMatchObject({ tronconId: "t1", deM: 2_000, aM: 10_000 });
    expect(c.segments[1]).toMatchObject({ tronconId: "t2", deM: 0, aM: 15_000 });
    expect(c.segments[2]).toMatchObject({ tronconId: "t3", deM: 0, aM: 5_000 });
    expect(c.longueurM).toBeCloseTo(8_000 + 15_000 + 5_000, 0);
  });

  it("dans l'autre sens, la liste est inversee et les abscisses decroissent", () => {
    const g = construireGraphe([t1, t2, t3], 5);
    const c = cheminEntre(g, { tronconId: "t3", abscisseM: 5_000 }, { tronconId: "t1", abscisseM: 2_000 }, { distanceMaxM: 100_000 });
    if ("refus" in c) throw new Error(c.motif);
    expect(c.segments.map((s) => s.tronconId)).toEqual(["t3", "t2", "t1"]);
    expect(c.segments[0].deM).toBeGreaterThan(c.segments[0].aM);
    expect(c.longueurM).toBeCloseTo(28_000, 0);
  });

  it("sur un meme troncon : le morceau entre les deux positions, sans autre troncon", () => {
    const g = construireGraphe([t1, t2, t3], 5);
    const c = cheminEntre(g, { tronconId: "t2", abscisseM: 3_000 }, { tronconId: "t2", abscisseM: 9_000 }, { distanceMaxM: 100_000 });
    if ("refus" in c) throw new Error(c.motif);
    expect(c.segments).toEqual([{ tronconId: "t2", deM: 3_000, aM: 9_000 }]);
    expect(c.longueurM).toBeCloseTo(6_000, 6);
  });

  it("deux routes possibles : la plus courte, pas la plus directe en nombre de troncons", () => {
    // Detour par le nord : d1 (10 km -> nord 3 km), d2 (retour), plus long que t2 direct (15 km).
    const dA = troncon("dA", [10_000, 0], [17_500, 12_000]);
    const dB = troncon("dB", [17_500, 12_000], [25_000, 0]);
    const g = construireGraphe([t1, t2, t3, dA, dB], 5);
    const c = cheminEntre(g, { tronconId: "t1", abscisseM: 5_000 }, { tronconId: "t3", abscisseM: 10_000 }, { distanceMaxM: 200_000 });
    if ("refus" in c) throw new Error(c.motif);
    expect(c.segments.map((s) => s.tronconId)).toEqual(["t1", "t2", "t3"]);
    expect(c.segments.some((s) => s.tronconId === "dA")).toBe(false);
  });

  it("un trou dans le referentiel : « aucun chemin », jamais une ligne droite par-dessus", () => {
    const apresLeTrou = troncon("t4", [45_000, 0], [60_000, 0]); // t3 finit a 40 km, t4 commence a 45 km
    const g = construireGraphe([t1, t2, t3, apresLeTrou], 5);
    const c = cheminEntre(g, { tronconId: "t1", abscisseM: 1_000 }, { tronconId: "t4", abscisseM: 1_000 }, { distanceMaxM: 500_000 });
    expect(c).toMatchObject({ refus: "AUCUN_CHEMIN" });
  });

  it("la borne de longueur est respectee : au-dela, aucun chemin plutot qu'un trajet trop long", () => {
    const g = construireGraphe([t1, t2, t3], 5);
    const c = cheminEntre(g, { tronconId: "t1", abscisseM: 0 }, { tronconId: "t3", abscisseM: 15_000 }, { distanceMaxM: 20_000 });
    expect(c).toMatchObject({ refus: "AUCUN_CHEMIN" });
  });

  it("un troncon hors du lot est refuse ; une borne nulle l'est aussi", () => {
    const g = construireGraphe([t1], 5);
    expect(cheminEntre(g, { tronconId: "t1", abscisseM: 0 }, { tronconId: "absent", abscisseM: 0 }, { distanceMaxM: 1000 })).toMatchObject({ refus: "TRONCON_HORS_GRAPHE" });
    expect(() => cheminEntre(g, { tronconId: "t1", abscisseM: 0 }, { tronconId: "t1", abscisseM: 1 }, { distanceMaxM: 0 })).toThrow();
  });
});
