import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  distanceM, emprise, lireCsv, lireGpx, nettoyer, PAS_MIN_PAR_DEFAUT_M, type PointBrut,
} from "./trace.import.noyau";

/**
 * Ce que ces tests defendent :
 *   - un fichier qui n'est pas une trace est REFUSE avec un motif, jamais lu de travers ;
 *   - une coordonnee invalide (hors bornes, 0/0 d'un recepteur sans fixation) est ignoree ET comptee ;
 *   - la precision n'est jamais inventee : un GPX n'en porte pas, elle reste null ;
 *   - le nettoyage borne le nombre de points sans raccourcir le parcours.
 */

const gpx = (pts: string) => `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>${pts}</trkseg></trk></gpx>`;

describe("lireGpx", () => {
  it("lit position et horodatage, attributs dans n'importe quel ordre, guillemets simples ou doubles", () => {
    const l = lireGpx(gpx(
      `<trkpt lat="9.5000" lon="-13.7000"><time>2026-10-21T08:00:00Z</time></trkpt>` +
      `<trkpt lon='-13.7010' lat='9.5010'><ele>12</ele><time>2026-10-21T08:00:05Z</time></trkpt>`));
    expect(l.refus).toBeNull();
    if (l.refus !== null) return;
    expect(l.points).toHaveLength(2);
    expect(l.points[1]).toMatchObject({ lat: 9.501, lon: -13.701, precisionM: null });
    expect(l.points[1].tMs! - l.points[0].tMs!).toBe(5000);
  });

  it("n'invente jamais une precision : un GPX n'en porte pas (hdop est un facteur, pas des metres)", () => {
    const l = lireGpx(gpx(`<trkpt lat="9.5" lon="-13.7"><hdop>1.2</hdop></trkpt>`));
    expect(l.refus).toBeNull();
    if (l.refus === null) expect(l.points[0].precisionM).toBeNull();
  });

  it("lit un point auto-fermant, et tolere l'absence d'horodatage", () => {
    const l = lireGpx(gpx(`<trkpt lat="9.5" lon="-13.7"/>`));
    expect(l.refus).toBeNull();
    if (l.refus === null) expect(l.points[0].tMs).toBeNull();
  });

  it("ignore et COMPTE les coordonnees invalides, dont le 0/0 d'un recepteur sans fixation", () => {
    const l = lireGpx(gpx(
      `<trkpt lat="9.5" lon="-13.7"/><trkpt lat="0" lon="0"/><trkpt lat="95" lon="-13.7"/><trkpt lat="abc" lon="1"/>`));
    expect(l.refus).toBeNull();
    if (l.refus !== null) return;
    expect(l.points).toHaveLength(1);
    expect(l.ignores).toBe(3);
    expect(l.avertissements.join(" ")).toMatch(/3 point\(s\)/);
  });

  it("refuse un fichier qui n'est pas un GPX, et un GPX sans point", () => {
    expect(lireGpx("lat,lon\n9.5,-13.7")).toMatchObject({ refus: "FORMAT_ILLISIBLE" });
    expect(lireGpx(gpx(""))).toMatchObject({ refus: "AUCUN_POINT" });
  });

  it("ne resout aucune entite externe : un DOCTYPE hostile reste du texte inerte", () => {
    const hostile = `<?xml version="1.0"?><!DOCTYPE gpx [<!ENTITY x SYSTEM "file:///etc/passwd">]><gpx><trk><trkseg>` +
      `<trkpt lat="9.5" lon="-13.7"><name>&x;</name></trkpt></trkseg></trk></gpx>`;
    const l = lireGpx(hostile);
    expect(l.refus).toBeNull();
    if (l.refus === null) expect(JSON.stringify(l.points)).not.toMatch(/root:|passwd/);
  });

  it("reste lineaire sur un fichier volumineux (pas de retour arriere catastrophique)", () => {
    const pts = Array.from({ length: 20_000 }, (_, i) => `<trkpt lat="${9 + i * 1e-5}" lon="-13.7"><time>2026-10-21T08:00:00Z</time></trkpt>`).join("");
    const t0 = Date.now();
    const l = lireGpx(gpx(pts));
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(l.refus).toBeNull();
    if (l.refus === null) expect(l.points).toHaveLength(20_000);
  });
});

describe("lireCsv", () => {
  it("retrouve les colonnes par leur nom d'en-tete, quel que soit l'ordre", () => {
    const l = lireCsv("heure,Longitude,Latitude,precision\n2026-10-21T08:00:00Z,-13.7,9.5,6.5\n2026-10-21T08:00:05Z,-13.701,9.501,8");
    expect(l.refus).toBeNull();
    if (l.refus !== null) return;
    expect(l.points[0]).toMatchObject({ lat: 9.5, lon: -13.7, precisionM: 6.5 });
    expect(l.points[1].tMs! - l.points[0].tMs!).toBe(5000);
  });

  it("sans en-tete : lat, lon, puis horodatage et precision facultatifs", () => {
    const l = lireCsv("9.5,-13.7\n9.501,-13.701");
    expect(l.refus).toBeNull();
    if (l.refus === null) { expect(l.points).toHaveLength(2); expect(l.points[0].tMs).toBeNull(); expect(l.points[0].precisionM).toBeNull(); }
  });

  it("lit le format europeen : point-virgule et virgule decimale", () => {
    const l = lireCsv("lat;lon\n9,5;-13,7\n9,501;-13,701");
    expect(l.refus).toBeNull();
    if (l.refus === null) expect(l.points[0]).toMatchObject({ lat: 9.5, lon: -13.7 });
  });

  it("accepte un horodatage en secondes ou en millisecondes depuis 1970", () => {
    const l = lireCsv("lat,lon,time\n9.5,-13.7,1792569600\n9.501,-13.701,1792569605000");
    expect(l.refus).toBeNull();
    if (l.refus === null) expect(l.points[1].tMs! - l.points[0].tMs!).toBe(5000);
  });

  it("refuse un en-tete sans latitude ni longitude reconnues, et un fichier vide", () => {
    expect(lireCsv("x,y\n1,2")).toMatchObject({ refus: "FORMAT_ILLISIBLE" });
    expect(lireCsv("")).toMatchObject({ refus: "AUCUN_POINT" });
  });

  it("n'accepte pas une precision absurde ou negative", () => {
    const l = lireCsv("lat,lon,precision\n9.5,-13.7,-3\n9.501,-13.701,99999");
    expect(l.refus).toBeNull();
    if (l.refus === null) expect(l.points.map((p) => p.precisionM)).toEqual([null, null]);
  });
});

describe("nettoyer", () => {
  // Un point tous les ~1,1 m le long d'un meridien (1e-5 degre de latitude).
  const droite = (n: number): PointBrut[] => Array.from({ length: n }, (_, i) => ({ lat: 9 + i * 1e-5, lon: -13.7, tMs: i * 1000, precisionM: null }));

  it("borne le nombre de points au pas minimal, et ne raccourcit le parcours que du pas au plus", () => {
    const entree = droite(1000);
    const n = nettoyer(entree, 15);
    expect(n.points.length).toBeLessThan(entree.length / 10);
    expect(n.points[0]).toBe(entree[0]);
    expect(distanceM(n.points[n.points.length - 1], entree[entree.length - 1])).toBeLessThan(15);
    expect(n.retiresParPas + n.points.length).toBe(entree.length);
  });

  it("espace les points conserves d'au moins le pas", () => {
    const n = nettoyer(droite(1000), 15);
    for (let i = 1; i < n.points.length; i += 1) {
      expect(distanceM(n.points[i - 1], n.points[i])).toBeGreaterThanOrEqual(15);
    }
  });

  it("supprime les points d'arret : un vehicule immobile ne produit qu'un point", () => {
    const arret: PointBrut[] = Array.from({ length: 50 }, (_, i) => ({ lat: 9.5, lon: -13.7, tMs: i * 1000, precisionM: null }));
    expect(nettoyer(arret).points).toHaveLength(1);
  });

  it("signale l'absence d'horodatage et les horodatages non croissants", () => {
    const sans = droite(100).map((p) => ({ ...p, tMs: null }));
    expect(nettoyer(sans).avertissements.join(" ")).toMatch(/aucun horodatage/);
    const desordre = droite(100).map((p, i) => ({ ...p, tMs: 100_000 - i * 1000 }));
    expect(nettoyer(desordre).avertissements.join(" ")).toMatch(/pas croissants/);
  });

  it("le pas par defaut est un choix provisoire de 15 m", () => { expect(PAS_MIN_PAR_DEFAUT_M).toBe(15); });
});

describe("distanceM et emprise", () => {
  it("un degre de latitude vaut environ 111 km", () => {
    expect(distanceM({ lat: 9, lon: -13.7 }, { lat: 10, lon: -13.7 })).toBeGreaterThan(110_000);
    expect(distanceM({ lat: 9, lon: -13.7 }, { lat: 10, lon: -13.7 })).toBeLessThan(112_000);
  });
  it("l'emprise contient la trace avec la marge demandee", () => {
    const e = emprise([{ lat: 9.5, lon: -13.7 }, { lat: 9.6, lon: -13.6 }], 1000);
    expect(e.sud).toBeLessThan(9.5 - 0.008);
    expect(e.nord).toBeGreaterThan(9.6 + 0.008);
    expect(e.ouest).toBeLessThan(-13.7);
    expect(e.est).toBeGreaterThan(-13.6);
  });
});

describe("noyau pur", () => {
  it("n'importe rien : il doit tourner tel quel dans la coque mobile", () => {
    const source = readFileSync(join(__dirname, "trace.import.noyau.ts"), "utf8");
    const imports = [...source.matchAll(/^import .*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    for (const i of imports) expect(i.startsWith("."), `import non relatif : ${i}`).toBe(true);
    expect(source).not.toMatch(/@prisma\/client|from "express"|node:/);
  });
});
