// Banc d'integration PostGIS : voir tests-integration/README.md. Lancer : npx tsx tests-integration/patrouilles.integration.ts
import "./lib/garde";
// Verification d'integration du service des patrouilles contre la base `replay`, dans une
// transaction ANNULEE a la fin.
import { PrismaClient } from "@prisma/client";
import {
  couvertureMission, creerProgramme, depecherVerification, engendrerMission, listerProgrammes,
} from "../src/exploitation/patrouilles.service";
import { verifier, conclure } from "./lib/verdict";

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
      verifier("le programme est cree avec un itineraire de 2 troncons", p.code === "INT-PAT" && (await tx.programmeTroncon.count({ where: { programmeId: p.id } })) === 2);

      const m = await engendrerMission(depot, p.id, { debutPrevu: new Date("2026-10-19T07:00:00Z") }, { auteurId: "u-int" });
      verifier("la mission engendree est un BROUILLON de SURVEILLANCE codee programme + date (INT-PAT-20261019)", m.code === "INT-PAT-20261019" && m.statut === "BROUILLON" && m.type === "SURVEILLANCE", { code: m.code, statut: m.statut, type: m.type });

      // La mission est realisee : trace sur tout A, et cloture.
      await tx.$executeRawUnsafe(`INSERT INTO traces (id, "missionId", "userId", "debutA", geom) VALUES ('tri-1', '${m.id}', 'u-int', now(), ${geom(-13.60, -13.59)})`);
      await tx.mission.update({ where: { id: m.id }, data: { statut: "TERMINEE", finReelle: new Date("2026-10-19T11:00:00Z") } });

      const liste = await listerProgrammes(depot, new Date("2026-10-30T09:00:00Z"));
      const l = liste.find((x) => x.id === p.id)!;
      // Dernier passage le 19/10 11:00, periodicite 7 jours : echeance le 26/10 11:00 ; le 30/10 09:00, 3 j 22 h de retard.
      verifier("le dernier passage est la fin reelle de la mission terminee", l.dernierPassage?.toISOString() === "2026-10-19T11:00:00.000Z", l.dernierPassage);
      verifier("l'echeance est EN_RETARD de 4 jours (3 j 22 h arrondis)", l.echeance.statut === "EN_RETARD" && l.echeance.joursRetard === 4, l.echeance);

      const c = await couvertureMission(depot, m.id, 30);
      // La trace couvre tout le premier de deux troncons de meme longueur : la moitie, plus la tolerance de 30 m qui mord sur le second.
      verifier("la couverture est d'environ la moitie de l'itineraire (0,50 a 0,53)", c.taux !== null && c.taux >= 0.5 && c.taux <= 0.53, c.taux);
      verifier("aucun troncon n'est entierement non vu et la trace ne sort pas de l'itineraire", c.tronconsNonVus.length === 0 && Math.round(c.horsItineraireM) === 0, { nonVus: c.tronconsNonVus, hors: c.horsItineraireM });

      await tx.$executeRawUnsafe(`INSERT INTO signalements_citoyens (id, "numeroPublic", "typeProbleme", statut, "updatedAt")
        VALUES ('si-1', 'SIG-INT-1', (SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='TypeProbleme' ORDER BY e.enumsortorder LIMIT 1)::"TypeProbleme", 'NOUVEAU', now())`);
      const v = await depecherVerification(depot, "si-1", {}, { auteurId: "u-int" });
      const s = await tx.signalementCitoyen.findUnique({ where: { id: "si-1" } });
      verifier("la verification d'un signalement cree la mission VER-SIG-INT-1-1 et passe le signalement en qualification", v.mission.code === "VER-SIG-INT-1-1" && s?.statut === "EN_QUALIFICATION" && s?.qualifieParId === "u-int", { code: v.mission.code, statut: s?.statut });
      const v2 = await depecherVerification(depot, "si-1", {}, { auteurId: "u-int" });
      verifier("une seconde verification cree une AUTRE mission (-2) sans changer de nouveau le statut", v2.mission.code === "VER-SIG-INT-1-2" && v2.statutChange === false, { code: v2.mission.code, change: v2.statutChange });

      const audits = await tx.auditLog.findMany({ where: { userId: "u-int" }, select: { action: true, entityType: true } });
      const nb = (a: string, t: string) => audits.filter((x) => x.action === a && x.entityType === t).length;
      verifier("toute ecriture est auditee : 1 programme, 3 missions, 1 signalement mis a jour, rien d'autre", nb("CREATE", "ProgrammePatrouille") === 1 && nb("CREATE", "Mission") === 3 && nb("UPDATE", "SignalementCitoyen") === 1 && audits.length === 5, audits.map((a) => `${a.action}:${a.entityType}`));
      throw new Annulation();
    }, { timeout: 60_000 });
  } catch (e) {
    if (!(e instanceof Annulation)) throw e;
    console.log("transaction annulee");
  }
  const reste = await prisma.programmePatrouille.count({ where: { code: "INT-PAT" } });
  verifier("rien ne subsiste apres l'annulation (0 programme)", reste === 0);
  conclure();
}

main().catch((e) => { console.error(e); process.exitCode = 2; }).finally(() => prisma.$disconnect());
