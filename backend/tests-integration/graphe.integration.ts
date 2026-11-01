// Banc d'integration PostGIS : voir tests-integration/README.md. Lancer : npx tsx tests-integration/graphe.integration.ts
import "./lib/garde";
// Epreuve du graphe charge depuis la base `replay`, transaction ANNULEE.
import { PrismaClient } from "@prisma/client";
import { chargerGraphe } from "../src/geo/graphe.depot";
import { distanceReseauDepuis } from "../src/geo/graphe.noyau";
import { verifier, conclure, proche } from "./lib/verdict";

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
      verifier("3 troncons charges : le troncon supprime logiquement est exclu", nbTroncons === 3, nbTroncons);
      verifier("une seule jonction interieure (la RR part de l'interieur de la RN)", graphe.nbJonctionsInterieures === 1, graphe.nbJonctionsInterieures);
      const longueurs = await tx.$queryRawUnsafe<{ id: string; l: number }[]>(`SELECT id, ST_Length(geom::geography) AS l FROM troncons WHERE id IN ('g-rn','g-rr')`);
      const lrn = Number(longueurs.find((x) => x.id === "g-rn")!.l);
      // Oracle SQL : la RR part du milieu du premier segment de la RN, a (-13.595, 9.64).
      const [o] = await tx.$queryRawUnsafe<{ j: number }[]>(`SELECT ST_Length(ST_MakeLine(ST_MakePoint(-13.60, 9.64), ST_MakePoint(-13.595, 9.64))::geography) AS j`);
      const jonction = graphe.parTroncon.get("g-rn")!.abscisses[1];
      verifier(`la jonction est a ${jonction.toFixed(1)} m, oracle SQL ${Number(o.j).toFixed(1)} m (a 1 m pres)`, proche(jonction, Number(o.j), 1), { jonction, oracle: Number(o.j) });
      verifier("la longueur de la RN reste celle de la geography (jonction < longueur)", jonction > 0 && jonction < lrn, { jonction, lrn });
      const d = distanceReseauDepuis(graphe, { distanceMaxM: 10_000 });
      // De la RN au debut vers la RR a 500 m de son debut : jonction + 500.
      const v = d({ tronconId: "g-rn", abscisseM: 0 }, { tronconId: "g-rr", abscisseM: 500 });
      verifier(`distance RN@0 vers RR@500 = jonction + 500 (${(jonction + 500).toFixed(1)} m)`, v !== null && proche(v, jonction + 500, 0.5), v);
      verifier("route isolee : aucun chemin (null), jamais une distance inventee", d({ tronconId: "g-rn", abscisseM: 0 }, { tronconId: "g-isole", abscisseM: 0 }) === null);
      verifier("troncon supprime : aucun chemin (null)", d({ tronconId: "g-rn", abscisseM: 0 }, { tronconId: "g-supprime", abscisseM: 0 }) === null);
      throw new Annulation();
    }, { timeout: 60_000 });
  } catch (e) {
    if (!(e instanceof Annulation)) throw e;
    console.log("transaction annulee");
  }
  conclure();
}
main().catch((e) => { console.error(e); process.exitCode = 2; }).finally(() => prisma.$disconnect());
