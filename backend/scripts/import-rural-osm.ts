/**
 * Importe les segments routiers ruraux/prefectoraux extraits d'OpenStreetMap
 * (codes du type KA086, DI002, MA006 - 2 lettres = code prefecture + numero)
 * comme nouveaux tronçons BDRI de classe RU. Region heritee du tronçon BDRI
 * le plus proche (toutes classes), faute de referentiel de code prefecture->region.
 *
 * Usage : OSM_ROUTES_JSON=/chemin/named-routes.json tsx scripts/import-rural-osm.ts
 */
import fs from "fs";
import { PrismaClient } from "@prisma/client";

const jsonPath = process.env.OSM_ROUTES_JSON;
if (!jsonPath) {
  console.error("OSM_ROUTES_JSON manquant.");
  process.exit(1);
}

const prisma = new PrismaClient();

interface OsmFeature {
  id: string;
  numero: string;
  numeroRaw: string;
  nom: string | null;
  nature: string;
  lengthKm: number;
  geometry: { type: string; coordinates: number[][] | number[][][] };
}

function centroid(geom: OsmFeature["geometry"]): [number, number] {
  const lines = geom.type === "LineString" ? [geom.coordinates as number[][]] : (geom.coordinates as number[][][]);
  let sx = 0, sy = 0, n = 0;
  for (const line of lines) for (const [x, y] of line) { sx += x; sy += y; n++; }
  return [sx / n, sy / n];
}

async function main() {
  const features: OsmFeature[] = JSON.parse(fs.readFileSync(jsonPath!, "utf-8"));
  const rural = features.filter((f) => /^[A-Z]{2}\d{2,4}$/.test(f.numero));
  console.log(`Segments ruraux/prefectoraux exploitables : ${rural.length}`);

  let created = 0;
  const usedCodes = new Set<string>();
  for (const f of rural) {
    const [lon, lat] = centroid(f.geometry);
    const nearest = await prisma.$queryRaw<{ regionId: number }[]>`
      SELECT "regionId" FROM troncons WHERE "deletedAt" IS NULL
      ORDER BY geom <-> ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326) LIMIT 1
    `;
    const regionId = nearest[0]?.regionId ?? 1;

    let code = f.numeroRaw;
    if (usedCodes.has(code)) code = `${code}-${f.id}`;
    usedCodes.add(code);

    const geomJson = JSON.stringify(f.geometry);
    const c = await prisma.troncon.create({
      data: {
        code,
        nom: `Route rurale ${f.numeroRaw}`,
        classe: "RU",
        regionId,
        longueurKm: f.lengthKm,
        revetement: "TERRE",
        etat: "NON_EVALUE",
        pkDebut: 0,
        pkFin: 0,
      },
    });
    await prisma.$executeRaw`UPDATE troncons SET geom = ST_SetSRID(ST_GeomFromGeoJSON(${geomJson}), 4326) WHERE id = ${c.id}`;
    created++;
    console.log(`  + ${code} (${Math.round(f.lengthKm * 10) / 10} km, région ${regionId})`);
  }
  console.log(`\nTotal : ${created} tronçons ruraux créés.`);
}

main()
  .catch((err) => {
    console.error("Erreur d'import :", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
