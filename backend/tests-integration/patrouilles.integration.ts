// Banc d'integration PostGIS : voir tests-integration/README.md. Lancer : npx tsx tests-integration/patrouilles.integration.ts
import "./lib/garde";
// Verification d'integration du service des patrouilles contre la base `replay`, dans une
// transaction ANNULEE a la fin.
import { PrismaClient } from "@prisma/client";
import {
  couvertureMission, creerProgramme, depecherVerification, engendrerMission, listerProgrammes,
} from "../src/exploitation/patrouilles.service";

const prisma = new PrismaClient();
class Annulation extends Error {}

async function main() {
  try {
    await prisma.$transaction(async (tx) => {
      const depot = new Proxy(tx as unknown as Record<string, unknown>, {
        get: (t, k) => (k === "$transaction" ? (fn: (x: unknown) => unknown) => fn(tx) : t[k as string]),
      }) as never;

      await tx.$executeRawUnsafe(`INSERT INTO regions (nom) VALUES ('Region integ patrouilles')`);
      await tx.$executeRawUnsafe(`INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt") VALUES ('u-int','int@local.invalid','Integ','x','GESTIONNAIRE',now())`);
      const geom = (x0: number, x1: number) => `ST_SetSRID(ST_MakeLine(ST_MakePoint(${x0}, 9.64), ST_MakePoint(${x1}, 9.64)), 4326)`;
      for (const [id, x0, x1] of [["ti-a", -13.60, -13.59], ["ti-b", -13.59, -13.58]] as const) {
        await tx.$executeRawUnsafe(`INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt")
          VALUES ('${id}', '${id}', '${id}', 'RN', (SELECT id FROM regions WHERE nom='Region integ patrouilles'), 1.1, 'BITUME', 0, 1.1, ${geom(x0, x1)}, now())`);
      }

      const p = await creerProgramme(depot, {
        code: "INT-PAT", libelle: "Integration", classeAxe: "RN", periodiciteJours: 7, moisActifs: [],
        responsableId: "u-int", troncons: ["ti-a", "ti-b"],
      }, { auteurId: "u-int" });
      console.log("programme cree :", p.code, "itineraire :", await tx.programmeTroncon.count({ where: { programmeId: p.id } }));

      const m = await engendrerMission(depot, p.id, { debutPrevu: new Date("2026-10-19T07:00:00Z") }, { auteurId: "u-int" });
      console.log("mission :", m.code, m.statut, m.type);

      // La mission est realisee : trace sur tout A, et cloture.
      await tx.$executeRawUnsafe(`INSERT INTO traces (id, "missionId", "userId", "debutA", geom) VALUES ('tri-1', '${m.id}', 'u-int', now(), ${geom(-13.60, -13.59)})`);
      await tx.mission.update({ where: { id: m.id }, data: { statut: "TERMINEE", finReelle: new Date("2026-10-19T11:00:00Z") } });

      const liste = await listerProgrammes(depot, new Date("2026-10-30T09:00:00Z"));
      const l = liste.find((x) => x.id === p.id)!;
      console.log("echeance :", l.dernierPassage?.toISOString(), l.echeance.statut, l.echeance.joursRetard);

      const c = await couvertureMission(depot, m.id, 30);
      console.log("couverture :", c.taux?.toFixed(3), "non vus :", c.tronconsNonVus, "hors :", Math.round(c.horsItineraireM));

      await tx.$executeRawUnsafe(`INSERT INTO signalements_citoyens (id, "numeroPublic", "typeProbleme", statut, "updatedAt")
        VALUES ('si-1', 'SIG-INT-1', (SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='TypeProbleme' ORDER BY e.enumsortorder LIMIT 1)::"TypeProbleme", 'NOUVEAU', now())`);
      const v = await depecherVerification(depot, "si-1", {}, { auteurId: "u-int" });
      const s = await tx.signalementCitoyen.findUnique({ where: { id: "si-1" } });
      console.log("verification :", v.mission.code, "signalement :", s?.statut, "qualifiePar :", s?.qualifieParId);
      const v2 = await depecherVerification(depot, "si-1", {}, { auteurId: "u-int" });
      console.log("seconde verification :", v2.mission.code, v2.statutChange);

      const audits = await tx.auditLog.findMany({ where: { userId: "u-int" }, select: { action: true, entityType: true } });
      console.log("audits :", audits.map((a) => `${a.action}:${a.entityType}`).join(", "));
      throw new Annulation();
    }, { timeout: 60_000 });
  } catch (e) {
    if (!(e instanceof Annulation)) throw e;
    console.log("transaction annulee");
  }
  const reste = await prisma.programmePatrouille.count({ where: { code: "INT-PAT" } });
  console.log("programmes INT-PAT restants :", reste);
}

main().finally(() => prisma.$disconnect());
