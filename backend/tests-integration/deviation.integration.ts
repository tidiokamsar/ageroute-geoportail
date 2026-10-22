// Banc d'integration PostGIS : voir tests-integration/README.md. Lancer : npx tsx tests-integration/deviation.integration.ts
import "./lib/garde";
// Epreuve de la deviation contre `replay`, transaction ANNULEE.
import { PrismaClient } from "@prisma/client";
import { calculerDeviation, RefusDeviationHttp } from "../src/geo/deviation.service";

const prisma = new PrismaClient();
class Annulation extends Error {}

async function main() {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO regions (nom) VALUES ('Region integ deviation')`);
      const ins = (id: string, wkt: string) => tx.$executeRawUnsafe(`INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt")
        VALUES ('${id}', '${id.toUpperCase()}', 'Route ${id}', 'RN', (SELECT id FROM regions WHERE nom='Region integ deviation'), 1, 'BITUME', 0, 1, ST_GeomFromText('${wkt}', 4326), now())`);
      // Une RN est-ouest de ~2,2 km et un contournement qui s'y branche a ~0,5 et ~1,6 km.
      await ins("dv-rn", "LINESTRING(-13.60 9.64, -13.58 9.64)");
      await ins("dv-ctr", "LINESTRING(-13.5955 9.64, -13.5955 9.645, -13.5855 9.645, -13.5855 9.64)");
      await ins("dv-isole", "LINESTRING(-13.40 9.80, -13.39 9.80)");

      const r = await calculerDeviation(tx, { tronconId: "dv-rn", debutM: 800, finM: 1200, distanceMaxM: 10_000, toleranceFusionM: 1 });
      console.log("deviation :", r.troncons.map((t) => t.code).join(" > "), "| longueur", r.longueurM.toFixed(1), "m | coupee", r.longueurCoupeeM, "| allongement", r.allongementM.toFixed(1), "m");
      console.log("sous-reseau :", JSON.stringify(r.sousReseau));
      console.log("geometries :", r.troncons.map((t) => `${t.code}:${(t.geometrie as { type: string }).type}`).join(", "));
      const [ctr] = await tx.$queryRawUnsafe<{ l: number }[]>(`SELECT ST_Length(geom::geography) AS l FROM troncons WHERE id = 'dv-ctr'`);
      console.log("controle : longueur du contournement mesuree", Number(ctr.l).toFixed(1), "m");
      for (const [nom, args] of [["cul-de-sac", { tronconId: "dv-isole", distanceMaxM: 10_000, toleranceFusionM: 1 }], ["inconnu", { tronconId: "zz", distanceMaxM: 10_000, toleranceFusionM: 1 }]] as const) {
        try { await calculerDeviation(tx, args); console.log(nom, ": ERREUR, une deviation a ete rendue"); }
        catch (e) { console.log(nom, ":", e instanceof RefusDeviationHttp ? `${e.http} ${e.code}` : e); }
      }
      throw new Annulation();
    }, { timeout: 60_000 });
  } catch (e) {
    if (!(e instanceof Annulation)) throw e;
    console.log("transaction annulee");
  }
}
main().finally(() => prisma.$disconnect());
