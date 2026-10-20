import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { construireGraphe, distanceReseauDepuis, type TronconGraphe } from "./graphe.noyau";
import { apparierTrace } from "./appariement.trace";
import { TRACES_ANNOTEES } from "./appariement.trace-annotee";

/**
 * Graphe du reseau (paragraphe 7.3.7) : ce que ces tests defendent.
 *
 *   - la fusion des extremites suit la tolerance DONNEE, et aucune n'est supposee ;
 *   - une jonction en T (route partant du milieu d'une autre) coupe le troncon ;
 *   - un croisement sans jonction n'est pas un carrefour ;
 *   - une distance hors du lot ou au-dela de la borne vaut `null`, jamais une estimation ;
 *   - L'EPREUVE DECISIVE : avec des distances calculees depuis la geometrie, et non plus ecrites
 *     a la main, le HMM rend le meme resultat sur le jeu annote (130/130, 8 ruptures sur 8).
 */

// Memes constantes que le jeu annote : origine pres de Conakry.
const LAT0 = 9.6412;
const LON0 = -13.5784;
const M_PAR_DEG_LAT = 110574;
const M_PAR_DEG_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const pt = (estM: number, nordM: number): [number, number] => [LON0 + estM / M_PAR_DEG_LON, LAT0 + nordM / M_PAR_DEG_LAT];
const troncon = (id: string, de: [number, number], a: [number, number]): TronconGraphe => ({
  id, coordonnees: [pt(...de), pt(...a)], longueurM: Math.hypot(a[0] - de[0], a[1] - de[1]),
});

describe("Le noyau ne depend de rien et ne suppose aucune tolerance", () => {
  it("n'a aucun import", () => {
    const src = readFileSync(join(__dirname, "graphe.noyau.ts"), "utf8");
    expect([...src.matchAll(/^import .*?from\s+["']/gm)]).toHaveLength(0);
  });
  it("refuse une tolerance nulle ou absente, et une borne nulle", () => {
    expect(() => construireGraphe([], 0)).toThrow(/tolerance/);
    expect(() => construireGraphe([], Number.NaN)).toThrow(/tolerance/);
    expect(() => distanceReseauDepuis(construireGraphe([], 1), { distanceMaxM: 0 })).toThrow();
  });
});

describe("Construction", () => {
  it("fusionne deux extremites a 0,5 m avec une tolerance de 1 m, pas avec 0,1 m", () => {
    const a = troncon("a", [0, 0], [1000, 0]);
    const b = troncon("b", [1000.5, 0], [2000, 0]);
    expect(construireGraphe([a, b], 1).nbNoeuds).toBe(3);
    expect(construireGraphe([a, b], 0.1).nbNoeuds).toBe(4);
  });

  it("coupe un troncon a une jonction en T", () => {
    const g = construireGraphe([troncon("rn", [0, 0], [2000, 0]), troncon("rr", [334, 0], [334, 2000])], 1);
    expect(g.nbJonctionsInterieures).toBe(1);
    expect(g.parTroncon.get("rn")!.abscisses.map((s) => Math.round(s))).toEqual([0, 334, 2000]);
  });

  it("un croisement sans jonction n'est pas un carrefour", () => {
    // Deux routes qui se croisent en leur milieu : aucune extremite ne touche l'autre.
    const g = construireGraphe([troncon("x", [0, 0], [1000, 0]), troncon("y", [500, -500], [500, 500])], 1);
    expect(g.nbJonctionsInterieures).toBe(0);
    const d = distanceReseauDepuis(g, { distanceMaxM: 10_000 });
    expect(d({ tronconId: "x", abscisseM: 500 }, { tronconId: "y", abscisseM: 500 })).toBeNull();
  });
});

describe("Distance sur le reseau", () => {
  // Un carre de 1 km, dont un cote manque : le detour se mesure.
  const reseau = [
    troncon("sud", [0, 0], [1000, 0]),
    troncon("est", [1000, 0], [1000, 1000]),
    troncon("nord", [1000, 1000], [0, 1000]),
  ];
  const g = construireGraphe(reseau, 1);
  const d = distanceReseauDepuis(g, { distanceMaxM: 10_000 });

  it("sur le meme troncon : la difference d'abscisse", () => {
    expect(d({ tronconId: "sud", abscisseM: 200 }, { tronconId: "sud", abscisseM: 700 })).toBeCloseTo(500, 6);
  });
  it("entre troncons : le chemin le plus court, en passant par les noeuds", () => {
    // De sud a 200 m vers nord a 300 m (soit a 700 m du coin ouest-nord) : 800 + 1000 + 300.
    expect(d({ tronconId: "sud", abscisseM: 200 }, { tronconId: "nord", abscisseM: 300 })).toBeCloseTo(2100, 3);
  });
  it("hors du lot ou au-dela de la borne : null, jamais une estimation", () => {
    expect(d({ tronconId: "sud", abscisseM: 0 }, { tronconId: "inconnu", abscisseM: 0 })).toBeNull();
    const court = distanceReseauDepuis(g, { distanceMaxM: 1500 });
    expect(court({ tronconId: "sud", abscisseM: 200 }, { tronconId: "nord", abscisseM: 300 })).toBeNull();
  });
  it("symetrique : le reseau n'est pas oriente (aucun sens unique au referentiel)", () => {
    const aller = d({ tronconId: "sud", abscisseM: 200 }, { tronconId: "est", abscisseM: 400 });
    const retour = d({ tronconId: "est", abscisseM: 400 }, { tronconId: "sud", abscisseM: 200 });
    expect(aller).toBeCloseTo(retour!, 9);
    expect(aller).toBeCloseTo(1200, 3);
  });
  it("tient une abscisse hors bornes en la ramenant au troncon", () => {
    expect(d({ tronconId: "sud", abscisseM: -50 }, { tronconId: "sud", abscisseM: 1200 })).toBeCloseTo(1000, 6);
  });
});

/**
 * La geometrie declaree de chaque scenario du jeu annote, reconstruite en troncons.
 * Les identifiants sont reutilises d'un scenario a l'autre : un graphe par scenario.
 */
function grapheDuScenario(nom: string) {
  if (nom.startsWith("T1")) {
    // RN1 et sa contre-allee a 25 m, reliees par une bretelle a 1 000 m seulement.
    return construireGraphe([
      troncon("rn1", [0, 0], [2000, 0]),
      troncon("ca1", [0, 25], [2000, 25]),
      troncon("bretelle", [1000, 0], [1000, 25]),
    ], 1);
  }
  if (nom.startsWith("T2")) {
    // La RR5 part vers le nord depuis le carrefour situe A L'INTERIEUR de la RN1, a 334 m.
    return construireGraphe([troncon("rn1", [0, 0], [2000, 0]), troncon("rr5", [20 * 16.7, 0], [20 * 16.7, 2000])], 1);
  }
  return construireGraphe([troncon("rn1", [0, 0], [2000, 0])], 1);
}

describe("L'epreuve decisive : la geometrie remplace les distances ecrites a la main", () => {
  const resultats = TRACES_ANNOTEES.map((trace) => ({
    trace,
    resultat: apparierTrace(trace.points, { distanceReseauM: distanceReseauDepuis(grapheDuScenario(trace.nom), { distanceMaxM: 5000 }) }),
  }));

  it("le carrefour de T2 est trouve a l'interieur de la RN1", () => {
    expect(grapheDuScenario("T2").nbJonctionsInterieures).toBe(1);
  });

  it("chaque point sur le troncon attendu : 130/130, et 8 sorties du referentiel sur 8", () => {
    let attendus = 0, justes = 0, rupturesAttendues = 0, rupturesJustes = 0;
    for (const { trace, resultat } of resultats) {
      for (let i = 0; i < trace.attendu.length; i++) {
        if (trace.attendu[i] === null) {
          rupturesAttendues++;
          if (resultat.points[i].tronconId === null) rupturesJustes++;
        } else {
          attendus++;
          if (resultat.points[i].tronconId === trace.attendu[i]) justes++;
        }
      }
    }
    expect({ attendus, justes, rupturesAttendues, rupturesJustes }).toEqual({ attendus: 130, justes: 130, rupturesAttendues: 8, rupturesJustes: 8 });
  });

  it("avec le graphe, plus aucune transition n'est laissee non verifiee", () => {
    for (const { trace, resultat } of resultats) {
      expect(resultat.transitionsNonVerifiees, trace.nom).toBe(0);
    }
  });
});
