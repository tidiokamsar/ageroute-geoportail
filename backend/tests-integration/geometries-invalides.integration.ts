// Banc d'integration PostGIS : voir tests-integration/README.md. Lancer : npx tsx tests-integration/geometries-invalides.integration.ts
import "./lib/garde";
// Integration : geometriesInvalides contre PostGIS reel (base de rejeu locale), transaction ANNULEE.
import { PrismaClient } from "@prisma/client";
import { prisma as clientApp } from "../src/lib/prisma";
import { geometriesInvalides, PLAFOND_EXEMPLES } from "../src/qualite/anomalies.depot";
import { verifier, conclure } from "./lib/verdict";

const prisma = new PrismaClient();
const ROLLBACK = new Error("ROLLBACK_VOULU");
const ok: Record<string, boolean> = {};

async function main() {
  const N = PLAFOND_EXEMPLES + 7; // 27 invalides, pour depasser le plafond d'exemples
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO regions (nom) VALUES ('Region test invalides')`);
      const reg = `(SELECT id FROM regions WHERE nom='Region test invalides')`;
      // Deux points identiques : une LineString invalide au sens de PostGIS (« Too few points »).
      await tx.$executeRawUnsafe(
        `INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt")
         SELECT 'inv-' || g, 'INV-' || g, 'Invalide ' || g, 'RN', ${reg}, 1, 'BITUME', 0, 1,
                ST_GeomFromText('LINESTRING(-13.5 9.5, -13.5 9.5)', 4326), CURRENT_TIMESTAMP
         FROM generate_series(1, ${N}) g`);
      await tx.$executeRawUnsafe(
        `INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt")
         VALUES ('val-1', 'VAL-1', 'Valide', 'RN', ${reg}, 1, 'BITUME', 0, 1, ST_GeomFromText('LINESTRING(-13.5 9.5, -13.4 9.6)', 4326), CURRENT_TIMESTAMP)`);
      // Un invalide supprime logiquement : il ne compte pas.
      await tx.$executeRawUnsafe(
        `INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt", "deletedAt")
         VALUES ('inv-sup', 'INV-SUP', 'Invalide supprime', 'RN', ${reg}, 1, 'BITUME', 0, 1, ST_GeomFromText('LINESTRING(-13.5 9.5, -13.5 9.5)', 4326), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
      const regionId = (await tx.$queryRawUnsafe<{ id: number }[]>(`SELECT id FROM regions WHERE nom='Region test invalides'`))[0].id;

      // geometriesInvalides utilise le client global ; on le redirige vers la transaction.
      (clientApp as any).$queryRaw = (tx as any).$queryRaw.bind(tx);
      const r = await geometriesInvalides({ regionId });
      console.log("nombre:", r.nombre, "exemples:", r.exemples.length, "premier:", r.exemples[0]?.explication);
      ok[`le compte est ${N} (et non le plafond ${PLAFOND_EXEMPLES})`] = r.nombre === N;
      ok["les exemples restent plafonnes"] = r.exemples.length === PLAFOND_EXEMPLES;
      ok["la geometrie valide et la supprimee ne comptent pas"] = r.exemples.every((e) => e.entityId.startsWith("inv-") && e.entityId !== "inv-sup");
      ok["la raison de PostGIS est restituee"] = /Too few points/.test(r.exemples[0]?.explication ?? "");
      const sans = await geometriesInvalides({ regionId: regionId + 9999 });
      ok["une region sans invalide donne 0"] = sans.nombre === 0 && sans.exemples.length === 0;
      throw ROLLBACK;
    }, { timeout: 120000 });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  const [{ n }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM troncons WHERE id LIKE 'inv-%' OR id = 'val-1'`);
  ok["fixtures restantes apres annulation : 0"] = String(n) === "0";
  for (const [nom, vrai] of Object.entries(ok)) verifier(nom, vrai);
  conclure();
}
main().catch((e) => { console.error(e); process.exitCode = 2; }).finally(() => prisma.$disconnect());
