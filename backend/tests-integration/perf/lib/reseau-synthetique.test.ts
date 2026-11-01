import { describe, expect, it } from "vitest";
import { decrire, empreinte, genererReseau, longueurPolylineM, wkt } from "./reseau-synthetique";
import { genererPoints } from "./points-gps";

/**
 * Le reseau synthetique doit etre REJOUABLE : meme graine, meme jeu, octet pour octet. Sans cela,
 * deux executions du banc ne se comparent pas et un tiers ne peut pas reproduire un chiffre.
 */
describe("reseau synthetique", () => {
  const a = genererReseau({ nombre: 20_000 });

  it("est deterministe : deux generations, meme empreinte", () => {
    expect(empreinte(genererReseau({ nombre: 20_000 }))).toBe(empreinte(a));
  });

  it("depend de la graine", () => {
    expect(empreinte(genererReseau({ nombre: 20_000, graine: 1 }))).not.toBe(empreinte(a));
  });

  it("compte exactement le nombre demande, au moins 20 000, avec un reseau classe de l'ordre du registre", () => {
    expect(a.nombre).toBe(20_000);
    expect(a.nombreClasse + a.nombreVoirie).toBe(20_000);
    expect(a.nombreClasse).toBeGreaterThan(1_000);
    expect(a.nombreClasse).toBeLessThan(3_000);
    expect(new Set(a.troncons.map((t) => t.id)).size).toBe(20_000);
    expect(new Set(a.troncons.map((t) => t.code)).size).toBe(20_000);
  });

  it("ne produit que des LineString valides (>= 2 points, sans point repete consecutif, dans la Guinee elargie)", () => {
    // Un seul expect final : 20 000 troncons x plusieurs expect() prenaient 19 s.
    const fautifs: string[] = [];
    for (const t of a.troncons) {
      let ok = t.coordonnees.length >= 2 && longueurPolylineM(t.coordonnees) > 5;
      for (let i = 0; i < t.coordonnees.length; i += 1) {
        const [lon, lat] = t.coordonnees[i];
        if (lon <= -16 || lon >= -7 || lat <= 6.5 || lat >= 13.5) ok = false;
        if (i > 0 && lon === t.coordonnees[i - 1][0] && lat === t.coordonnees[i - 1][1]) ok = false;
      }
      if (!ok) fautifs.push(t.id);
    }
    expect(fautifs).toEqual([]);
  });

  it("a des jonctions : les extremites des troncons voisins coincident exactement", () => {
    const comptes = new Map<string, number>();
    for (const t of a.troncons) {
      for (const c of [t.coordonnees[0], t.coordonnees[t.coordonnees.length - 1]]) {
        const k = `${c[0]} ${c[1]}`;
        comptes.set(k, (comptes.get(k) ?? 0) + 1);
      }
    }
    const partagees = [...comptes.values()].filter((v) => v >= 2).length;
    const parNoeud = (partagees / comptes.size);
    expect(parNoeud).toBeGreaterThan(0.5);
  });

  it("distingue reseau classe et voirie promue par sourceReference", () => {
    expect(a.troncons.filter((t) => t.categorie === "CLASSE").every((t) => t.sourceReference === null)).toBe(true);
    expect(a.troncons.filter((t) => t.categorie === "VOIRIE").every((t) => (t.sourceReference ?? "").startsWith("voirie_locale:"))).toBe(true);
  });

  it("decrire() rend des valeurs mesurees non nulles", () => {
    const d = decrire(a);
    expect(d.classe.kmTotal).toBeGreaterThan(10_000);
    expect(d.voirie.longueurMoyenneM).toBeGreaterThan(50);
    expect(d.voirie.longueurMoyenneM).toBeLessThan(300);
  });

  it("wkt est stable", () => {
    expect(wkt([[1, 2], [3, 4.5]])).toBe("LINESTRING(1 2, 3 4.5)");
  });
});

describe("points GPS", () => {
  const r = genererReseau({ nombre: 20_000 });
  it("sont deterministes et comptent parGroupe points par groupe", () => {
    const p1 = genererPoints(r, { graine: 7, parGroupe: 50 });
    const p2 = genererPoints(r, { graine: 7, parGroupe: 50 });
    expect(p1).toEqual(p2);
    expect(p1).toHaveLength(250);
    expect(p1.filter((p) => p.groupe === "hors-route").every((p) => p.verite === null)).toBe(true);
    expect(p1.filter((p) => p.groupe !== "hors-route").every((p) => p.verite !== null)).toBe(true);
  });
});
