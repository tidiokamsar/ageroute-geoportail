import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({ prisma: {} }));

import { analyserTrace, lireTrace, RefusTrace, type DepotTrace } from "./trace.service";
import { POINTS_MAX, type PointBrut } from "./trace.import.noyau";

/**
 * Ce que ces tests defendent :
 *   - un parcours qui suit un troncon donne UN passage, avec ses abscisses, son sens et sa geometrie ;
 *   - une suite que le reseau n'explique pas est rendue HORS REFERENTIEL avec ses coordonnees, et le
 *     taux de rattachement baisse : elle n'est jamais rattachee de force ;
 *   - une trace trop courte ou trop dense est refusee AVANT toute requete sur la base ;
 *   - les reserves (precision absente, transitions non verifiees) sont dites dans la reponse.
 * Le SQL lui-meme est eprouve contre une base reelle par le banc d'integration du suivi, pas ici.
 */

// 20 m en degres de latitude.
const PAS = 20 / 111_320;
const droite = (n: number, sens: 1 | -1 = 1): PointBrut[] =>
  Array.from({ length: n }, (_, i) => ({ lat: 9.5 + i * PAS * sens, lon: -13.7, tMs: i * 2000, precisionM: null }));

interface Ligne { i: number; tronconId: string; code: string; nom: string | null; classe: string; distanceM: number; fraction: number; longueurM: number; pkDebut: number | null; pkFin: number | null }

/** Depot simule : 1er appel = candidats, 2e = geometries. Les appels sont consignes. */
function depot(lignes: Ligne[], geojson: unknown = { type: "LineString", coordinates: [[-13.7, 9.5], [-13.7, 9.52]] }) {
  const appels: unknown[][] = [];
  const d = {
    $queryRaw: async (...args: unknown[]) => {
      appels.push(args);
      if (appels.length === 1) return lignes;
      return [{ ordre: 1, geojson: JSON.stringify(geojson) }];
    },
  } as unknown as DepotTrace;
  return { d, appels };
}

/** Candidats d'un troncon A rectiligne de longueur `longueur`, pour les points d'indices `indices`. */
function candidatsSurA(n: number, indices: number[], sens: 1 | -1 = 1): Ligne[] {
  const longueur = PAS * 111_320 * (n - 1);
  return indices.map((i) => ({
    i, tronconId: "t-A", code: "RN-A", nom: "Route A", classe: "RN", distanceM: 3,
    fraction: sens === 1 ? i / (n - 1) : 1 - i / (n - 1), longueurM: longueur, pkDebut: null, pkFin: null,
  }));
}

describe("analyserTrace", () => {
  it("un parcours qui suit un troncon donne un passage, ses abscisses, son sens et sa geometrie", async () => {
    const n = 50;
    const { d, appels } = depot(candidatsSurA(n, [...Array(n).keys()]));
    const a = await analyserTrace(d, { points: droite(n) });

    expect(a.passages).toHaveLength(1);
    const p = a.passages[0];
    expect(p).toMatchObject({ tronconId: "t-A", code: "RN-A", nom: "Route A", sens: "CROISSANT", nombrePoints: n });
    expect(p.deM).toBeCloseTo(0, 0);
    expect(p.aM).toBeCloseTo(20 * (n - 1), 0);
    expect(p.longueurM).toBeCloseTo(20 * (n - 1), 0);
    expect(p.geojson).toMatchObject({ type: "LineString" });
    expect(a.indicateurs.tauxRattachement).toBe(1);
    expect(a.horsReferentiel).toHaveLength(0);
    expect(a.trace).toHaveLength(n);
    expect(a.rattache.every(Boolean)).toBe(true);
    expect(appels).toHaveLength(2);
  });

  it("envoie les nombres en TEXTE : Prisma devine le type d'un tableau d'apres son PREMIER element", async () => {
    // [0, 19.87] partait en int8[] et 19.87 etait refuse (22P03) : defaut constate contre PostGIS
    // le 22/10/2026, que les tests a depot simule ne pouvaient pas voir. Les coordonnees de la trace
    // sont concernees aussi : un fichier dont le premier point est (10, -13) declencherait le meme.
    const n = 60;
    const longueur = PAS * 111_320 * (n - 1);
    const lignes: Ligne[] = [];
    for (let i = 0; i < n; i += 1) {
      const sur = i < 30 ? "A" : "B";
      lignes.push({ i, tronconId: `t-${sur}`, code: `RN-${sur}`, nom: null, classe: "RN", distanceM: 3, fraction: (i % 30) / 29 * 0.99 + 0.0089, longueurM: longueur, pkDebut: null, pkFin: null });
    }
    const { d, appels } = depot(lignes);
    await analyserTrace(d, { points: droite(n) });
    const requeteGeometrie = appels[1] as unknown[];
    const [, ids, de, a] = requeteGeometrie as [unknown, string[], unknown[], unknown[]];
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(de.every((x) => typeof x === "string")).toBe(true);
    expect(a.every((x) => typeof x === "string")).toBe(true);
    const valeursCandidats = (appels[0] as [{ values: unknown[] }])[0].values;
    const tableaux = valeursCandidats.filter(Array.isArray) as unknown[][];
    expect(tableaux.length).toBeGreaterThanOrEqual(2);
    expect(tableaux.every((t) => t.every((x) => typeof x === "string"))).toBe(true);
  });

  it("detecte le sens decroissant quand le vehicule remonte le troncon", async () => {
    const n = 40;
    const { d } = depot(candidatsSurA(n, [...Array(n).keys()], -1));
    const a = await analyserTrace(d, { points: droite(n) });
    expect(a.passages[0].sens).toBe("DECROISSANT");
    expect(a.passages[0].deM!).toBeGreaterThan(a.passages[0].aM!);
  });

  it("calcule distance, duree et vitesse moyenne a partir des horodatages", async () => {
    const n = 51; // 50 intervalles de 20 m en 2 s = 36 km/h
    const { d } = depot(candidatsSurA(n, [...Array(n).keys()]));
    const a = await analyserTrace(d, { points: droite(n) });
    expect(a.indicateurs.distanceParcourueM).toBeGreaterThan(990);
    expect(a.indicateurs.distanceParcourueM).toBeLessThan(1010);
    expect(a.indicateurs.dureeS).toBe(100);
    expect(a.indicateurs.vitesseMoyenneKmH).toBeGreaterThan(35);
    expect(a.indicateurs.vitesseMoyenneKmH).toBeLessThan(37);
  });

  it("une suite sans candidat est rendue HORS REFERENTIEL avec ses coordonnees, jamais rattachee de force", async () => {
    const n = 60;
    const avec = [...Array(n).keys()].filter((i) => i < 20 || i >= 40);
    const { d } = depot(candidatsSurA(n, avec));
    const a = await analyserTrace(d, { points: droite(n) });

    expect(a.horsReferentiel).toHaveLength(1);
    const s = a.horsReferentiel[0];
    expect(s.indexDebut).toBe(20);
    expect(s.indexFin).toBe(39);
    expect(s.nombrePoints).toBe(20);
    expect(s.coordonnees).toHaveLength(20);
    expect(a.indicateurs.pointsRattaches).toBe(40);
    expect(a.indicateurs.tauxRattachement).toBeCloseTo(40 / 60, 2);
    expect(a.rattache.slice(20, 40).some(Boolean)).toBe(false);
  });

  it("dit ses reserves : precision absente, et transitions non verifiees entre troncons", async () => {
    const n = 40;
    // Deux troncons differents se relayant au point 20 : une transition que rien ne verifie.
    const longueur = PAS * 111_320 * 20;
    const lignes: Ligne[] = [];
    for (let i = 0; i < n; i += 1) {
      const sur = i < 20 ? "A" : "B";
      lignes.push({ i, tronconId: `t-${sur}`, code: `RN-${sur}`, nom: null, classe: "RN", distanceM: 3, fraction: (i % 20) / 19, longueurM: longueur, pkDebut: null, pkFin: null });
    }
    const { d } = depot(lignes);
    const a = await analyserTrace(d, { points: droite(n) });
    expect(a.passages.map((p) => p.code)).toEqual(["RN-A", "RN-B"]);
    expect(a.indicateurs.transitionsNonVerifiees).toBeGreaterThan(0);
    const texte = a.avertissements.join(" | ");
    expect(texte).toMatch(/Aucune precision annoncee/);
    expect(texte).toMatch(/ne sont pas verifies sur le reseau \(le graphe n'est pas utilise\)/);
    expect(texte).toMatch(/fournir la tolerance de fusion/);
  });

  it("signale un passage tres court pour verification, sans le supprimer", async () => {
    const n = 60;
    const longueur = PAS * 111_320 * (n - 1);
    const lignes: Ligne[] = [];
    for (let i = 0; i < n; i += 1) {
      // Un seul point (30) est rattache a un autre troncon : un carrefour, ou une voie parallele.
      lignes.push({ i, tronconId: i === 30 ? "t-C" : "t-A", code: i === 30 ? "RN-C" : "RN-A", nom: null, classe: "RN",
        distanceM: i === 30 ? 2 : 3, fraction: i / (n - 1), longueurM: longueur, pkDebut: null, pkFin: null });
    }
    const { d } = depot(lignes);
    const a = await analyserTrace(d, { points: droite(n) });
    const court = a.passages.find((p) => p.code === "RN-C");
    expect(court).toBeDefined();
    expect(court!.court).toBe(true);
    expect(a.passages.filter((p) => p.code === "RN-A").every((p) => !p.court)).toBe(true);
    expect(a.avertissements.join(" ")).toMatch(/passage\(s\) tres court\(s\)/);
  });

  it("avertit quand moins de la moitie des points sont expliques", async () => {
    const n = 40;
    const { d } = depot(candidatsSurA(n, [0, 1, 2, 3, 4]));
    const a = await analyserTrace(d, { points: droite(n) });
    expect(a.avertissements.join(" ")).toMatch(/Moins de la moitie/);
  });

  it("refuse une trace trop courte, sans interroger la base", async () => {
    const { d, appels } = depot([]);
    await expect(analyserTrace(d, { points: droite(1) })).rejects.toMatchObject({ code: "TRACE_TROP_COURTE", http: 422 });
    // Deux points a moins du pas minimal : un seul point distinct.
    await expect(analyserTrace(d, { points: [{ lat: 9.5, lon: -13.7, tMs: 0, precisionM: null }, { lat: 9.50001, lon: -13.7, tMs: 1000, precisionM: null }] }))
      .rejects.toBeInstanceOf(RefusTrace);
    expect(appels).toHaveLength(0);
  });

  it("refuse une trace trop dense avec le conseil d'usage, sans interroger la base", async () => {
    const { d, appels } = depot([]);
    await expect(analyserTrace(d, { points: droite(POINTS_MAX + 500) })).rejects.toMatchObject({ code: "TROP_DE_POINTS" });
    expect(appels).toHaveLength(0);
  });

  it("restitue les parametres retenus et le plafond, pour que le resultat se lise sans deviner", async () => {
    const { d } = depot(candidatsSurA(30, [...Array(30).keys()]));
    const a = await analyserTrace(d, { points: droite(30) }, { reseau: "tout", distanceMaxM: 30, pasMinM: 10 });
    expect(a.parametres).toMatchObject({ reseau: "tout", distanceMaxM: 30, pasMinM: 10, pointsMax: POINTS_MAX });
  });
});

describe("lireTrace", () => {
  it("transforme un refus de lecture en refus HTTP 400 avec son motif", () => {
    try {
      lireTrace("gpx", "pas un gpx");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RefusTrace);
      expect(e).toMatchObject({ code: "FORMAT_ILLISIBLE", http: 400 });
    }
  });
  it("lit un CSV valide", () => {
    const l = lireTrace("csv", "lat,lon\n9.5,-13.7\n9.6,-13.7");
    expect(l.points).toHaveLength(2);
  });
});
