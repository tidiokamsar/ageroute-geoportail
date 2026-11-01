// Banc d'integration PostGIS : voir tests-integration/README.md. Lancer : npx tsx tests-integration/contour.integration.ts
import "./lib/garde";
// Contour du pays contre PostGIS reel, transaction ANNULEE.
import { PrismaClient } from "@prisma/client";
import { contourPays, oublierContour } from "../src/geo/contour.service";
import { verifier, conclure, proche } from "./lib/verdict";

const prisma = new PrismaClient();
class Annulation extends Error {}

/** Longueur d'une ligne GeoJSON en degres de latitude/longitude, sommes des segments (carres alignes sur les axes). */
function longueurDegres(g: { type: string; coordinates: number[][] | number[][][] }): number {
  const lignes = (g.type === "LineString" ? [g.coordinates] : g.coordinates) as number[][][];
  let somme = 0;
  for (const l of lignes) for (let i = 1; i < l.length; i++) somme += Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]);
  return somme;
}

async function main() {
  try {
    await prisma.$transaction(async (tx) => {
      oublierContour();
      const avant = await contourPays(tx as never);
      verifier("sans limite de niveau 1 en base, le contour est ABSENT (aucun trace de repli)", avant === null, avant);

      // Deux regions voisines : deux carres de 1 degre de cote, partageant la droite x = -12.
      // Frontiere exterieure attendue : un rectangle 2 x 1, perimetre 6 ; la limite commune (longueur 1) disparait.
      const carre = (x0: number, y0: number, x1: number, y1: number) =>
        `ST_Multi(ST_GeomFromText('POLYGON((${x0} ${y0}, ${x1} ${y0}, ${x1} ${y1}, ${x0} ${y1}, ${x0} ${y0}))', 4326))`;
      const ins = (pcode: string, niveau: number, nom: string, geom: string) =>
        tx.$executeRawUnsafe(`INSERT INTO limites_admin (pcode, niveau, nom, source, "validOn", geom) VALUES ('${pcode}', ${niveau}, '${nom}', 'OCHA COD-AB (banc)', '2016-03-04', ${geom})`);
      await ins("ZZ001", 1, "Region A", carre(-13, 9, -12, 10));
      await ins("ZZ002", 1, "Region B", carre(-12, 9, -11, 10));
      // Une prefecture (niveau 2) loin des regions : ne doit pas figurer dans le contour du pays.
      await ins("ZZ101", 2, "Prefecture isolee", carre(-9, 11, -8.5, 11.5));

      oublierContour();
      const c = await contourPays(tx as never);
      verifier("le contour existe et porte sa source, sa date et son avertissement", !!c && c.properties.source === "OCHA COD-AB (banc)" && c.properties.valideLe === "2016-03-04" && /pas une frontiere officielle/.test(c.properties.avertissement), c?.properties);
      verifier("2 regions de niveau 1 comptees (la prefecture de niveau 2 est exclue)", c?.properties.nombreRegions === 2, c?.properties.nombreRegions);
      const g = c?.geometry as { type: string; coordinates: number[][] | number[][][] };
      verifier("la geometrie est une ligne (frontiere), pas un polygone", g?.type === "LineString" || g?.type === "MultiLineString", g?.type);
      const l = g ? longueurDegres(g) : -1;
      verifier(`la frontiere exterieure mesure 6 degres (rectangle 2 x 1) : la limite commune a disparu (mesure ${l.toFixed(3)})`, proche(l, 6, 1e-6), l);
      const xs = new Set<number>();
      for (const ligne of (g.type === "LineString" ? [g.coordinates] : g.coordinates) as number[][][]) for (const [x] of ligne) xs.add(x);
      verifier("aucun sommet a l'ecart de la prefecture isolee (x = -9)", ![...xs].some((x) => x > -10), [...xs]);
      throw new Annulation();
    }, { timeout: 60_000 });
  } catch (e) {
    if (!(e instanceof Annulation)) throw e;
    console.log("transaction annulee");
  }
  const [{ n }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM limites_admin WHERE pcode LIKE 'ZZ%'`);
  verifier("rien ne subsiste apres l'annulation", String(n) === "0");
  oublierContour();
  conclure();
}
main().catch((e) => { console.error(e); process.exitCode = 2; }).finally(() => prisma.$disconnect());
