// Banc d'integration PostGIS : voir tests-integration/README.md. Lancer : npx tsx tests-integration/chemin.integration.ts
import "./lib/garde";
// Epreuve de la route entre deux villes (chemin sur le reseau) contre `replay`, transaction ANNULEE.
import { PrismaClient } from "@prisma/client";
import { cheminEntrePoints, RefusChemin } from "../src/geo/chemin.service";
import { verifier, conclure, proche } from "./lib/verdict";

const prisma = new PrismaClient();
class Annulation extends Error {}

async function main() {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO regions (nom) VALUES ('Region integ chemin')`);
      const ins = (id: string, wkt: string) => tx.$executeRawUnsafe(`INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt")
        VALUES ('${id}', '${id.toUpperCase()}', 'Route ${id}', 'RN', (SELECT id FROM regions WHERE nom='Region integ chemin'), 1, 'BITUME', 0, 1, ST_GeomFromText('${wkt}', 4326), now())`);
      // Une route est-ouest en trois troncons bout a bout (donnees d'ESSAI, aucune route reelle) : latitude 11,00, de -13,80 a -12,80.
      await ins("ch-1", "LINESTRING(-13.80 11.00, -13.45 11.00)");
      await ins("ch-2", "LINESTRING(-13.45 11.00, -13.12 11.00)");
      await ins("ch-3", "LINESTRING(-13.12 11.00, -12.80 11.00)");
      // Deux pieges pour l'ancien filtre (bande de 20 km autour de la droite) : une route PARALLELE a 5,5 km au nord,
      // et une route qui TRAVERSE ch-2 sans jonction (aucune extremite sur ch-2).
      await ins("ch-parallele", "LINESTRING(-13.80 11.05, -12.80 11.05)");
      await ins("ch-croise", "LINESTRING(-13.30 10.90, -13.30 11.10)");
      // Un troncon isole, au-dela d'un trou du referentiel.
      await ins("ch-apres-trou", "LINESTRING(-12.60 11.00, -12.40 11.00)");

      const depart = { lat: 11.0005, lon: -13.70 }; // ~55 m de ch-1, en son milieu
      const arrivee = { lat: 11.0005, lon: -12.90 }; // ~55 m de ch-3

      // Oracle independant (SQL) : parcours = (ch-1 depuis A) + ch-2 entier + (ch-3 jusqu'a B).
      const [o] = await tx.$queryRawUnsafe<{ a: number; l1: number; l2: number; b: number }[]>(`
        SELECT ST_LineLocatePoint(t1.geom, ST_SetSRID(ST_MakePoint(${depart.lon}, ${depart.lat}), 4326)) * ST_Length(t1.geom::geography) AS a,
               ST_Length(t1.geom::geography) AS l1, ST_Length(t2.geom::geography) AS l2,
               ST_LineLocatePoint(t3.geom, ST_SetSRID(ST_MakePoint(${arrivee.lon}, ${arrivee.lat}), 4326)) * ST_Length(t3.geom::geography) AS b
          FROM troncons t1, troncons t2, troncons t3 WHERE t1.id = 'ch-1' AND t2.id = 'ch-2' AND t3.id = 'ch-3'`);
      const attendu = (Number(o.l1) - Number(o.a)) + Number(o.l2) + Number(o.b);

      const r = await cheminEntrePoints(tx, depart, arrivee, { toleranceFusionM: 15 });
      verifier("la route suit le reseau : CH-1 > CH-2 > CH-3, dans l'ordre", r.troncons.map((t) => t.code).join(" > ") === "CH-1 > CH-2 > CH-3", r.troncons.map((t) => t.code));
      verifier("ni la route parallele ni la route qui traverse ne sont dans la liste (l'ancienne bande de 20 km les aurait prises)",
        !r.troncons.some((t) => t.code === "CH-PARALLELE" || t.code === "CH-CROISE"), r.troncons.map((t) => t.code));
      verifier(`la longueur (${r.longueurM.toFixed(1)} m) egale l'oracle SQL (${attendu.toFixed(1)} m) a 3 m pres`, proche(r.longueurM, attendu, 3), { mesuree: r.longueurM, attendu });
      verifier("ch-1 et ch-3 sont parcourus en partie, ch-2 en entier",
        r.troncons[0].partiel && !r.troncons[1].partiel && r.troncons[2].partiel, r.troncons.map((t) => [t.code, t.partiel]));
      verifier("les parcours partiels sont avertis : changer l'etat change celui du troncon entier", r.avertissements.some((a) => a.includes("ENTIER")), r.avertissements);
      verifier("tous dans le sens de l'abscisse a l'aller", r.troncons.every((t) => t.sens === "+"), r.troncons.map((t) => t.sens));
      verifier("la reponse nomme ses parametres provisoires (rayon d'accrochage, tolerance, marge)", r.parametres.toleranceFusionM === 15 && r.parametres.rayonAccrochageM === 10_000 && r.parametres.nbTronconsCharges >= 5, r.parametres);
      verifier("l'accrochage des deux villes est d'environ 55 m", r.depart.accrochageM > 40 && r.depart.accrochageM < 70 && r.arrivee.accrochageM > 40 && r.arrivee.accrochageM < 70, [r.depart.accrochageM, r.arrivee.accrochageM]);

      const retour = await cheminEntrePoints(tx, arrivee, depart, { toleranceFusionM: 15 });
      verifier("au retour : ordre inverse, sens inverse, meme longueur",
        retour.troncons.map((t) => t.code).join(" > ") === "CH-3 > CH-2 > CH-1" && retour.troncons.every((t) => t.sens === "-") && proche(retour.longueurM, r.longueurM, 0.5),
        { ordre: retour.troncons.map((t) => [t.code, t.sens]), longueurs: [retour.longueurM, r.longueurM] });

      for (const [nom, a, b, http, code] of [
        ["une ville a 25 km de tout troncon", { lat: 11.35, lon: -13.70 }, arrivee, 404, "ACCROCHAGE_IMPOSSIBLE"],
        ["un troncon separe par un trou du referentiel", depart, { lat: 11.0005, lon: -12.50 }, 422, "AUCUN_CHEMIN"],
        ["deux endroits identiques", depart, depart, 422, "POINTS_IDENTIQUES"],
      ] as const) {
        let obtenu: unknown = "aucun refus";
        try { await cheminEntrePoints(tx, a, b, { toleranceFusionM: 15 }); } catch (e) { obtenu = e instanceof RefusChemin ? `${e.http} ${e.code}` : String(e); }
        verifier(`${nom} : refus ${http} ${code}, jamais une ligne droite`, obtenu === `${http} ${code}`, obtenu);
      }

      // Un troncon supprime logiquement n'est plus emprunte : la route est coupee.
      await tx.$executeRawUnsafe(`UPDATE troncons SET "deletedAt" = now() WHERE id = 'ch-2'`);
      let apresSuppression: unknown = "aucun refus";
      try { await cheminEntrePoints(tx, depart, arrivee, { toleranceFusionM: 15 }); } catch (e) { apresSuppression = e instanceof RefusChemin ? e.code : String(e); }
      verifier("un troncon archive (deletedAt) coupe la route : AUCUN_CHEMIN", apresSuppression === "AUCUN_CHEMIN", apresSuppression);
      throw new Annulation();
    }, { timeout: 60_000 });
  } catch (e) {
    if (!(e instanceof Annulation)) throw e;
    console.log("transaction annulee");
  }
  conclure();
}
main().catch((e) => { console.error(e); process.exitCode = 2; }).finally(() => prisma.$disconnect());
