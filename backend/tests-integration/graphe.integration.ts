// Banc d'integration PostGIS : voir tests-integration/README.md. Lancer : npx tsx tests-integration/graphe.integration.ts
import "./lib/garde";
// Epreuve du graphe charge depuis la base `replay`, transaction ANNULEE.
import { PrismaClient } from "@prisma/client";
import { chargerGraphe } from "../src/geo/graphe.depot";
import { distanceReseauDepuis } from "../src/geo/graphe.noyau";

const prisma = new PrismaClient();
class Annulation extends Error {}

async function main() {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO regions (nom) VALUES ('Region integ graphe')`);
      const ins = (id: string, wkt: string) => tx.$executeRawUnsafe(`INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt")
        VALUES ('${id}', '${id}', '${id}', 'RN', (SELECT id FROM regions WHERE nom='Region integ graphe'), 1, 'BITUME', 0, 1, ST_GeomFromText('${wkt}', 4326), now())`);
      // Une RN coudee (trois sommets), une RR qui part de son interieur, une route isolee, un troncon supprime.
      await ins("g-rn", "LINESTRING(-13.60 9.64, -13.59 9.64, -13.58 9.645)");
      await ins("g-rr", "LINESTRING(-13.595 9.64, -13.595 9.65)");
      await ins("g-isole", "LINESTRING(-13.50 9.70, -13.49 9.70)");
      await ins("g-supprime", "LINESTRING(-13.60 9.64, -13.60 9.66)");
      await tx.$executeRawUnsafe(`UPDATE troncons SET "deletedAt" = now() WHERE id = 'g-supprime'`);

      const { graphe, nbTroncons } = await chargerGraphe(tx, { ouest: -13.61, sud: 9.63, est: -13.48, nord: 9.71 }, 1);
      console.log("troncons charges :", nbTroncons, "(le supprime exclu)", "noeuds :", graphe.nbNoeuds, "jonctions interieures :", graphe.nbJonctionsInterieures);
      const longueurs = await tx.$queryRawUnsafe<{ id: string; l: number }[]>(`SELECT id, ST_Length(geom::geography) AS l FROM troncons WHERE id IN ('g-rn','g-rr')`);
      const lrn = Number(longueurs.find((x) => x.id === "g-rn")!.l);
      const lrr = Number(longueurs.find((x) => x.id === "g-rr")!.l);
      const d = distanceReseauDepuis(graphe, { distanceMaxM: 10_000 });
      const jonction = graphe.parTroncon.get("g-rn")!.abscisses[1];
      console.log("longueur g-rn (geography) :", lrn.toFixed(1), "m ; jonction a", jonction.toFixed(1), "m (moitie du premier segment ~548 m attendue)");
      // De g-rn au debut vers g-rr a 500 m de son debut : jonction + 500.
      const v = d({ tronconId: "g-rn", abscisseM: 0 }, { tronconId: "g-rr", abscisseM: 500 });
      console.log("distance g-rn@0 -> g-rr@500 :", v?.toFixed(1), "attendu :", (jonction + 500).toFixed(1), "; g-rr mesure", lrr.toFixed(1), "m");
      console.log("vers la route isolee :", d({ tronconId: "g-rn", abscisseM: 0 }, { tronconId: "g-isole", abscisseM: 0 }));
      console.log("vers le troncon supprime :", d({ tronconId: "g-rn", abscisseM: 0 }, { tronconId: "g-supprime", abscisseM: 0 }));
      throw new Annulation();
    }, { timeout: 60_000 });
  } catch (e) {
    if (!(e instanceof Annulation)) throw e;
    console.log("transaction annulee");
  }
}
main().finally(() => prisma.$disconnect());
