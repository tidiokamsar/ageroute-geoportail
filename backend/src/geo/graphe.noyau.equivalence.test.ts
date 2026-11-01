import { describe, expect, it } from "vitest";
import { construireGraphe, type TronconGraphe } from "./graphe.noyau";
import { construireGrapheReference } from "./graphe.noyau.reference";

/**
 * EQUIVALENCE de la construction du graphe avant et apres l'index spatial des extremites
 * (23/10/2026, banc de performance A20 : l'ancienne etape 2 prenait 34 s sur 7 000 troncons).
 *
 * La reference (`graphe.noyau.reference.ts`) est la construction d'ORIGINE,
 * recopiee du commit 2943e22. Le test exige que les deux rendent exactement le meme graphe -- noeuds,
 * jonctions en T, abscisses, arcs et leur ordre -- sur des reseaux tires au hasard avec une graine
 * fixe, y compris des extremites posees sur l'interieur d'autres troncons (jonctions en T).
 */

function alea(graine: number) {
  let s = graine >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Reseau aleatoire dense : segments courts, dont des extremites tombent sur l'interieur d'autres troncons. */
function reseauAleatoire(graine: number, n: number): TronconGraphe[] {
  const r = alea(graine);
  const sortie: TronconGraphe[] = [];
  const M = 111_320;
  const lon0 = -13.6, lat0 = 9.6;
  const pt = (x: number, y: number): [number, number] => [lon0 + x / (M * Math.cos((lat0 * Math.PI) / 180)), lat0 + y / M];
  for (let i = 0; i < n; i++) {
    const x = r() * 3000, y = r() * 3000;
    const l = 200 + r() * 600, a = r() * 2 * Math.PI;
    const coords: [number, number][] = [pt(x, y), pt(x + (l / 2) * Math.cos(a) + (r() - 0.5) * 30, y + (l / 2) * Math.sin(a) + (r() - 0.5) * 30), pt(x + l * Math.cos(a), y + l * Math.sin(a))];
    sortie.push({ id: `t${i}`, longueurM: l, coordonnees: coords });
  }
  // Jonctions en T : une extremite posee (a 1 m pres) sur le milieu d'un autre troncon.
  for (let i = 0; i < n / 3; i++) {
    const cible = sortie[Math.floor(r() * n)];
    const m = cible.coordonnees[1];
    const a = r() * 2 * Math.PI;
    const l = 150 + r() * 300;
    const [lx, ly] = [m[0] + 1 / M, m[1]];
    sortie.push({ id: `j${i}`, longueurM: l, coordonnees: [[lx, ly], [lx + (l * Math.cos(a)) / (M * Math.cos((lat0 * Math.PI) / 180)), ly + (l * Math.sin(a)) / M]] });
  }
  return sortie;
}

const normaliser = (g: { nbNoeuds: number; nbJonctionsInterieures: number; parTroncon: ReadonlyMap<string, unknown>; adjacence: readonly unknown[] }) =>
  JSON.stringify({ n: g.nbNoeuds, j: g.nbJonctionsInterieures, t: [...g.parTroncon.entries()], a: g.adjacence });

describe("construireGraphe : l'index spatial des extremites ne change pas le graphe", () => {
  for (const [graine, n, tol] of [[1, 150, 2], [7, 400, 5], [42, 400, 0.5], [99, 60, 25]] as const) {
    it(`graine ${graine}, ${n} troncons, tolerance ${tol} m : graphe identique a la reference`, () => {
      const reseau = reseauAleatoire(graine, n);
      const attendu = construireGrapheReference(reseau, tol);
      const obtenu = construireGraphe(reseau, tol);
      expect(obtenu.nbJonctionsInterieures).toBe(attendu.nbJonctionsInterieures);
      expect(normaliser(obtenu)).toBe(normaliser(attendu));
    });
  }

  it("le jeu aleatoire produit effectivement des jonctions en T (l'epreuve n'est pas vide)", () => {
    expect(construireGraphe(reseauAleatoire(7, 400), 5).nbJonctionsInterieures).toBeGreaterThan(20);
  });

  it("une boite englobante plus etendue que le semis d'extremites retombe sur le balayage complet", () => {
    const grand: TronconGraphe = { id: "grand", longueurM: 400_000, coordonnees: [[-15, 8], [-9, 12]] };
    const petit: TronconGraphe = { id: "petit", longueurM: 300, coordonnees: [[-12, 10], [-11.997, 10]] };
    const attendu = construireGrapheReference([grand, petit], 5);
    expect(normaliser(construireGraphe([grand, petit], 5))).toBe(normaliser(attendu));
  });
});
