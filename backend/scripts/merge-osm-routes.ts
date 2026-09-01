/**
 * Fusionne les routes nationales numerotees extraites d'OpenStreetMap (N1..N33)
 * dans le reseau BDRI existant, en ne creant des tronçons que pour les segments
 * OSM qui ne sont PAS deja couverts par un tronçon BDRI du meme nom (ecart
 * geometrique > seuil). Additif uniquement : aucune suppression ni modification
 * des tronçons existants.
 *
 * Usage : OSM_ROUTES_JSON=/chemin/named-routes.json tsx scripts/merge-osm-routes.ts
 */
import fs from "fs";
import { PrismaClient } from "@prisma/client";

const jsonPath = process.env.OSM_ROUTES_JSON;
if (!jsonPath) {
  console.error("OSM_ROUTES_JSON manquant.");
  process.exit(1);
}

const prisma = new PrismaClient();

// Au-dela de ce taux de recouvrement avec le reseau BDRI existant (tampon 150m),
// on considere le segment OSM comme deja represente -> on ne le duplique pas.
const COVERAGE_THRESHOLD = 0.3;
const BUFFER_METERS = 150;

interface OsmFeature {
  id: string;
  numero: string;
  numeroRaw: string;
  nom: string | null;
  nature: string;
  lengthKm: number;
  geometry: { type: string; coordinates: unknown };
}

function matchRnNom(numero: string): string | null {
  const m = numero.match(/^N(\d{1,2})$/);
  return m ? `RN${Number(m[1])}` : null;
}

async function main() {
  const features: OsmFeature[] = JSON.parse(fs.readFileSync(jsonPath!, "utf-8"));

  const byRn = new Map<string, OsmFeature[]>();
  for (const f of features) {
    const rn = matchRnNom(f.numero);
    if (!rn) continue;
    if (!byRn.has(rn)) byRn.set(rn, []);
    byRn.get(rn)!.push(f);
  }

  console.log(`Routes OSM exploitables (N1-N33 -> RN) : ${byRn.size}`);

  let totalInserted = 0;
  let totalKmAdded = 0;
  const report: { nom: string; existingKm: number; osmKm: number; inserted: number; addedKm: number }[] = [];

  for (const [nom, osmSegs] of byRn) {
    const existing = await prisma.$queryRaw<{ id: string; regionId: number; longueurKm: number }[]>`
      SELECT id, "regionId", "longueurKm" FROM troncons WHERE nom = ${nom} AND "deletedAt" IS NULL
    `;
    if (existing.length === 0) {
      console.log(`  ${nom} : aucun tronçon BDRI existant, ignoré (pas de référence région/classe).`);
      continue;
    }
    const existingKm = existing.reduce((s, t) => s + t.longueurKm, 0);
    const regionId = existing[0].regionId;

    let inserted = 0;
    let addedKm = 0;

    for (let i = 0; i < osmSegs.length; i++) {
      const seg = osmSegs[i];
      const geomJson = JSON.stringify(seg.geometry);

      const [{ coverage }] = await prisma.$queryRaw<{ coverage: number }[]>`
        WITH seg AS (SELECT ST_GeomFromGeoJSON(${geomJson}) AS g),
             buf AS (
               SELECT ST_Union(ST_Buffer(geom::geography, ${BUFFER_METERS})::geometry) AS g
               FROM troncons WHERE nom = ${nom} AND "deletedAt" IS NULL
             )
        SELECT CASE
          WHEN ST_Length((SELECT g FROM seg)::geography) = 0 THEN 1
          ELSE ST_Length(ST_Intersection((SELECT g FROM seg), (SELECT g FROM buf))::geography)
               / ST_Length((SELECT g FROM seg)::geography)
        END AS coverage
      `;

      if (coverage >= COVERAGE_THRESHOLD) continue; // deja represente dans BDRI

      const code = `${nom}-OSM-${i}`;
      const created = await prisma.troncon.create({
        data: {
          code,
          nom,
          classe: "RN",
          regionId,
          longueurKm: seg.lengthKm,
          revetement: "BITUME",
          etat: "NON_EVALUE",
          pkDebut: 0,
          pkFin: 0,
        },
      });
      await prisma.$executeRaw`
        UPDATE troncons SET geom = ST_SetSRID(ST_GeomFromGeoJSON(${geomJson}), 4326) WHERE id = ${created.id}
      `;
      inserted++;
      addedKm += seg.lengthKm;
    }

    totalInserted += inserted;
    totalKmAdded += addedKm;
    report.push({ nom, existingKm: Math.round(existingKm * 10) / 10, osmKm: Math.round(osmSegs.reduce((s, f) => s + f.lengthKm, 0) * 10) / 10, inserted, addedKm: Math.round(addedKm * 10) / 10 });
  }

  console.log("\n=== Rapport de fusion ===");
  for (const r of report.sort((a, b) => b.addedKm - a.addedKm)) {
    if (r.inserted > 0) {
      console.log(`  ${r.nom} : BDRI ${r.existingKm}km + OSM ${r.osmKm}km -> +${r.inserted} segment(s), +${r.addedKm}km`);
    }
  }
  console.log(`\nTotal : ${totalInserted} nouveaux tronçons, +${Math.round(totalKmAdded * 10) / 10} km`);
}

main()
  .catch((err) => {
    console.error("Erreur de fusion :", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
