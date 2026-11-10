import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OBJETS_ANALYSE_DEFAUT, SOMMETS_ANALYSE_DEFAUT, analyseObjetsMax, analyseSommetsMax, exigerCapacite } from "./capacite";
import { ErreurMetier } from "./erreurs";

// Correctif D4 (pilote local du 09/11/2026) : comptage prealable et refus immediat des trois calculs lourds. Sans base ; la mesure est le banc
// `projets-voirie-capacite` (PostGIS).
afterEach(() => { vi.unstubAllEnvs(); });

const v = (objetsReseau: number, sommetsReseau: number, objetsAxes = 12, sommetsAxes = 972) => ({ objetsAxes, objetsReseau, sommetsAxes, sommetsReseau });

describe("plafonds des calculs lourds : reglages bornes", () => {
  it("defauts tires de la mesure", () => {
    expect([analyseObjetsMax(), analyseSommetsMax()]).toEqual([OBJETS_ANALYSE_DEFAUT, SOMMETS_ANALYSE_DEFAUT]);
  });
  it("une valeur dans les bornes est prise ; hors bornes, illisible ou vide : le defaut", () => {
    vi.stubEnv("PROJETS_VOIRIE_ANALYSE_OBJETS_MAX", "5000");
    vi.stubEnv("PROJETS_VOIRIE_ANALYSE_SOMMETS_MAX", "50000");
    expect([analyseObjetsMax(), analyseSommetsMax()]).toEqual([5_000, 50_000]);
    for (const x of ["0", "99", "200001", "abc", "", "1.5", "-3"]) {
      vi.stubEnv("PROJETS_VOIRIE_ANALYSE_OBJETS_MAX", x);
      expect(analyseObjetsMax(), x).toBe(OBJETS_ANALYSE_DEFAUT);
    }
    for (const x of ["999", "4000001", "NaN"]) {
      vi.stubEnv("PROJETS_VOIRIE_ANALYSE_SOMMETS_MAX", x);
      expect(analyseSommetsMax(), x).toBe(SOMMETS_ANALYSE_DEFAUT);
    }
  });
});

describe("exigerCapacite : refus immediat 422 ANALYSE_TROP_VOLUMINEUSE avec le volume et les plafonds", () => {
  const plafonds = { objetsMax: 20_000, sommetsMax: 400_000 };
  it("sous les deux plafonds (bornes incluses) : rien", () => {
    expect(() => exigerCapacite(v(19_988, 399_028), "ANALYSE_2D", plafonds)).not.toThrow();
  });
  it("au-dela du plafond d'objets (axes + reseaux) : 422, code, volume, plafonds et calcul dans la reponse", () => {
    let e: unknown;
    try { exigerCapacite(v(50_000, 199_720), "ANALYSE_CONFLITS", plafonds); } catch (x) { e = x; }
    expect(e).toBeInstanceOf(ErreurMetier);
    const m = e as ErreurMetier;
    expect([m.status, m.code]).toEqual([422, "ANALYSE_TROP_VOLUMINEUSE"]);
    expect(m.extra).toMatchObject({ calcul: "ANALYSE_CONFLITS", objets: 50_012, sommets: 200_692, objetsMax: 20_000, sommetsMax: 400_000, objetsReseau: 50_000, sommetsAxes: 972 });
    expect(m.message).toMatch(/50 012 objets linéaires et 200 692 sommets/);
    expect(m.message).toMatch(/l'analyse de conflits/);
  });
  it("au-dela du seul plafond de sommets : 422 aussi (peu d'objets tres denses)", () => {
    expect(() => exigerCapacite(v(100, 400_001, 0, 0), "COMPTAGE", plafonds)).toThrow(/le comptage des réseaux/);
  });
  it("les plafonds par defaut sont ceux des reglages", () => {
    vi.stubEnv("PROJETS_VOIRIE_ANALYSE_OBJETS_MAX", "1000");
    expect(() => exigerCapacite(v(989, 4_000), "ANALYSE_2D")).toThrow(ErreurMetier);
    expect(() => exigerCapacite(v(988, 4_000), "ANALYSE_2D")).not.toThrow();
  });
});

describe("les trois calculs lourds commencent par le comptage prealable (preuve statique)", () => {
  const lire = (f: string) => readFileSync(path.join(__dirname, f), "utf8");
  const cas: [string, string, string, string][] = [
    ["analyse.service.ts", "ANALYSE_2D", "depot.volumes(", "depot.mesurerParJeu("],
    ["reseaux/comptage.service.ts", "COMPTAGE", "volumes(tx, [], jeuxIds)", "depot.mesurerComptage("],
    ["conflits/analyse-conflits.service.ts", "ANALYSE_CONFLITS", "socle.volumes(", "depot.candidatsLineaires("],
  ];
  for (const [fichier, calcul, comptage, lourd] of cas) {
    it(`${fichier} : exigerCapacite(..., "${calcul}") sur le comptage prealable, avant le premier calcul lourd`, () => {
      const s = lire(fichier);
      const i = s.indexOf(`exigerCapacite(await budget.etape(() => ${comptage}`);
      expect(i, "appel du comptage prealable").toBeGreaterThan(0);
      expect(s.slice(i, i + 200)).toContain(`"${calcul}")`);
      expect(s.indexOf(lourd), lourd).toBeGreaterThan(i);
    });
  }
});
