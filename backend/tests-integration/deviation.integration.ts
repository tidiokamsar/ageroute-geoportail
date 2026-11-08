// Banc d'integration PostGIS : voir tests-integration/README.md. Lancer : npx tsx tests-integration/deviation.integration.ts
import "./lib/garde";
// Epreuve de la deviation contre `replay`, transaction ANNULEE.
import { PrismaClient } from "@prisma/client";
import { calculerDeviation, RefusDeviationHttp } from "../src/geo/deviation.service";
import { verifier, conclure, proche } from "./lib/verdict";

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

      // Oracle independant (SQL) : le trajet va de la sortie de la coupure (800 m) jusqu'a l'embranchement
      // du contournement sur la RN, parcourt le contournement, puis revient jusqu'a la fin de la coupure.
      const [o] = await tx.$queryRawUnsafe<{ j1: number; j2: number; lctr: number; lrn: number }[]>(`
        SELECT ST_LineLocatePoint(rn.geom, ST_SetSRID(ST_MakePoint(-13.5955, 9.64), 4326)) * ST_Length(rn.geom::geography) AS j1,
               ST_LineLocatePoint(rn.geom, ST_SetSRID(ST_MakePoint(-13.5855, 9.64), 4326)) * ST_Length(rn.geom::geography) AS j2,
               ST_Length(ctr.geom::geography) AS lctr, ST_Length(rn.geom::geography) AS lrn
        FROM troncons rn, troncons ctr WHERE rn.id = 'dv-rn' AND ctr.id = 'dv-ctr'`);
      const attendu = (800 - Number(o.j1)) + Number(o.lctr) + (Number(o.j2) - 1200);

      const r = await calculerDeviation(tx, { tronconId: "dv-rn", debutM: 800, finM: 1200, distanceMaxM: 10_000, toleranceFusionM: 1 });
      verifier("la deviation emprunte la RN, le contournement, puis la RN", r.troncons.map((t) => t.code).join(" > ") === "DV-RN > DV-CTR > DV-RN", r.troncons.map((t) => t.code));
      verifier(`la longueur (${r.longueurM.toFixed(1)} m) egale l'oracle SQL (${attendu.toFixed(1)} m) a 2 m pres`, proche(r.longueurM, attendu, 2), { mesuree: r.longueurM, attendu });
      verifier("la longueur coupee est celle de la coupure demandee (400 m)", r.longueurCoupeeM === 400, r.longueurCoupeeM);
      verifier("l'allongement vaut longueur moins longueur coupee", proche(r.allongementM, r.longueurM - 400, 0.01), r.allongementM);
      verifier("le sous-reseau compte 2 troncons et 2 jonctions interieures", r.sousReseau.troncons === 2 && r.sousReseau.jonctionsInterieures === 2, r.sousReseau);
      verifier("chaque troncon de la deviation porte une geometrie LineString", r.troncons.every((t) => (t.geometrie as { type: string }).type === "LineString"));
      for (const [nom, args, http, code] of [
        ["un cul-de-sac sans autre route", { tronconId: "dv-isole", distanceMaxM: 10_000, toleranceFusionM: 1 }, 422, "AUCUNE_DEVIATION"],
        ["un troncon inconnu", { tronconId: "zz", distanceMaxM: 10_000, toleranceFusionM: 1 }, 404, "TRONCON_INTROUVABLE"],
      ] as const) {
        let obtenu: unknown = "aucun refus";
        try { await calculerDeviation(tx, args); } catch (e) { obtenu = e instanceof RefusDeviationHttp ? `${e.http} ${e.code}` : String(e); }
        verifier(`${nom} : refus ${http} ${code}`, obtenu === `${http} ${code}`, obtenu);
      }
      throw new Annulation();
    }, { timeout: 60_000 });
  } catch (e) {
    if (!(e instanceof Annulation)) throw e;
    console.log("transaction annulee");
  }
  conclure();
}
main().catch((e) => { console.error(e); process.exitCode = 2; }).finally(() => prisma.$disconnect());
