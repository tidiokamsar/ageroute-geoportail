// Banc d'integration PostGIS : voir tests-integration/README.md. Lancer : npx tsx tests-integration/veille.integration.ts
import "./lib/garde";
// Verification d'integration de la cellule de veille contre `replay`, transaction ANNULEE.
import { PrismaClient } from "@prisma/client";
import { declarer, ajouterEntree } from "../src/exploitation/main-courante.service";
import { creerAstreinte, creerRegle, declarerMode, evaluerEscalades, tableauVeille, desactiverRegle, RefusVeille } from "../src/exploitation/veille.service";

const prisma = new PrismaClient();
class Annulation extends Error {}

async function main() {
  try {
    await prisma.$transaction(async (tx) => {
      const depot = new Proxy(tx as unknown as Record<string, unknown>, {
        get: (t, k) => (k === "$transaction" ? (fn: (x: unknown) => unknown) => fn(tx) : t[k as string]),
      }) as never;
      await tx.$executeRawUnsafe(`INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt") VALUES ('u-cvi','cvi@local.invalid','Chef de veille','x','GESTIONNAIRE',now()), ('u-ast','ast@local.invalid','Agent astreinte','x','LECTEUR',now())`);
      const ctx = { auteurId: "u-cvi" };

      console.log("sans regle :", JSON.stringify(await evaluerEscalades(depot, ctx)));

      const ev1 = (await declarer(depot, { typeCode: "COUPURE", sourceCode: "PATROUILLE", texte: "Radier", point: [-13.6, 9.64] }, ctx)).evenementId;
      const ev2 = (await declarer(depot, { typeCode: "ACCIDENT", sourceCode: "PATROUILLE", texte: "Accident", point: [-13.5, 9.7] }, ctx)).evenementId;
      await ajouterEntree(depot, ev2, { nature: "STATUT", statut: "PRIS_EN_COMPTE", texte: "vu" }, ctx);

      // Delais saisis PAR L'ESSAI. ouvertLe = maintenant : on evalue "dans 2 heures".
      await creerRegle(depot, { typeCode: null, mode: "TOUS", niveau: 1, delaiMinutes: 30 }, ctx);
      const r2 = await creerRegle(depot, { typeCode: null, mode: "TOUS", niveau: 2, delaiMinutes: 90 }, ctx);
      try { await creerRegle(depot, { typeCode: null, mode: "TOUS", niveau: 2, delaiMinutes: 60 }, ctx); console.log("ERREUR : doublon de regle"); }
      catch (e) { console.log("doublon de regle :", e instanceof RefusVeille ? e.code : e); }

      const plus2h = new Date(Date.now() + 2 * 3600_000);
      await creerAstreinte(depot, { userId: "u-ast", niveau: 1, debut: new Date(Date.now() - 3600_000), fin: new Date(Date.now() + 6 * 3600_000) }, ctx);

      const e1 = await evaluerEscalades(depot, ctx, plus2h);
      console.log("evaluation 1 :", e1.inscrites.map((x) => `${x.evenementId === ev1 ? "ev1" : "ev2"} N${x.niveau} -> ${x.destinataireId ?? "PERSONNE"}`).join(", "));
      const e2 = await evaluerEscalades(depot, ctx, plus2h);
      console.log("evaluation 2 (idempotente) : inscrites", e2.inscrites.length);

      await declarerMode(depot, "SAISON_PLUIES", "Crues en Guinee forestiere", ctx);
      await desactiverRegle(depot, r2.id, ctx);
      const t = await tableauVeille(depot, plus2h);
      const mien = t.evenements.filter((e) => e.evenementId === ev1 || e.evenementId === ev2);
      console.log("tableau : mode", t.mode.mode, "declare", t.mode.declare, "| evenements", mien.map((e) => `${e.statut} esc=${e.escalade?.niveau ?? "-"} sansDest=${e.escalade?.sansDestinataire ?? "-"}`).join(" ; "));
      console.log("tableau : astreintes actives", t.astreintes.length, "regles actives", t.regles.actives, "incoherences", t.regles.incoherences.length, "patrouilles a faire", t.patrouilles.length);
      const audits = await tx.auditLog.groupBy({ by: ["entityType"], where: { userId: "u-cvi" }, _count: true });
      console.log("audits :", audits.map((a) => `${a.entityType}:${a._count}`).sort().join(", "));
      throw new Annulation();
    }, { timeout: 120_000 });
  } catch (e) {
    if (!(e instanceof Annulation)) throw e;
    console.log("transaction annulee");
  }
  console.log("regles restantes :", await prisma.regleEscalade.count(), "astreintes restantes :", await prisma.astreinte.count());
}
main().finally(() => prisma.$disconnect());
