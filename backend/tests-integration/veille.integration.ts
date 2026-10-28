// Banc d'integration PostGIS : voir tests-integration/README.md. Lancer : npx tsx tests-integration/veille.integration.ts
import "./lib/garde";
// Verification d'integration de la cellule de veille contre `replay`, transaction ANNULEE.
import { PrismaClient } from "@prisma/client";
import { declarer, ajouterEntree } from "../src/exploitation/main-courante.service";
import { creerAstreinte, creerRegle, declarerMode, evaluerEscalades, tableauVeille, desactiverRegle, RefusVeille } from "../src/exploitation/veille.service";
import { verifier, conclure } from "./lib/verdict";

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

      const vide = await evaluerEscalades(depot, ctx);
      verifier("sans aucune regle, rien n'est escalade et le service le dit (sansRegle), en mode NORMAL", vide.sansRegle === true && vide.inscrites.length === 0 && vide.mode === "NORMAL", vide);

      const ev1 = (await declarer(depot, { typeCode: "COUPURE", sourceCode: "PATROUILLE", texte: "Radier", point: [-13.6, 9.64] }, ctx)).evenementId;
      const ev2 = (await declarer(depot, { typeCode: "ACCIDENT", sourceCode: "PATROUILLE", texte: "Accident", point: [-13.5, 9.7] }, ctx)).evenementId;
      await ajouterEntree(depot, ev2, { nature: "STATUT", statut: "PRIS_EN_COMPTE", texte: "vu" }, ctx);

      // Delais saisis PAR L'ESSAI. ouvertLe = maintenant : on evalue "dans 2 heures".
      await creerRegle(depot, { typeCode: null, mode: "TOUS", niveau: 1, delaiMinutes: 30 }, ctx);
      const r2 = await creerRegle(depot, { typeCode: null, mode: "TOUS", niveau: 2, delaiMinutes: 90 }, ctx);
      try { await creerRegle(depot, { typeCode: null, mode: "TOUS", niveau: 2, delaiMinutes: 60 }, ctx); verifier("ERREUR : doublon de regle", false); }
      catch (e) { verifier("deux regles actives pour le meme niveau sont refusees (REGLE_EXISTANTE)", e instanceof RefusVeille && e.code === "REGLE_EXISTANTE", e instanceof RefusVeille ? e.code : String(e)); }

      const plus2h = new Date(Date.now() + 2 * 3600_000);
      await creerAstreinte(depot, { userId: "u-ast", niveau: 1, debut: new Date(Date.now() - 3600_000), fin: new Date(Date.now() + 6 * 3600_000) }, ctx);

      const e1 = await evaluerEscalades(depot, ctx, plus2h);
      // A +2 h : ev1 (ouvert, jamais pris en compte) depasse les deux delais (30 et 90 min) ; ev2, pris en compte, n'escalade pas.
      // Une seule astreinte, de niveau 1 : le niveau 2 n'a personne, et le dit.
      const lignes1 = e1.inscrites.map((x) => `${x.evenementId === ev1 ? "ev1" : "ev2"} N${x.niveau} -> ${x.destinataireId ?? "PERSONNE"}`).join(", ");
      verifier("a +2 h : ev1 monte au niveau 1 (agent d'astreinte) puis au niveau 2 (PERSONNE, sans inventer de destinataire) ; ev2 pris en compte n'escalade pas", lignes1 === "ev1 N1 -> u-ast, ev1 N2 -> PERSONNE", lignes1);
      const e2 = await evaluerEscalades(depot, ctx, plus2h);
      verifier("une seconde evaluation est idempotente : rien de nouveau n'est inscrit", e2.inscrites.length === 0, e2.inscrites.length);

      await declarerMode(depot, "SAISON_PLUIES", "Crues en Guinee forestiere", ctx);
      await desactiverRegle(depot, r2.id, ctx);
      const t = await tableauVeille(depot, plus2h);
      const mien = t.evenements.filter((e) => e.evenementId === ev1 || e.evenementId === ev2);
      const t1 = mien.find((e) => e.evenementId === ev1), t2 = mien.find((e) => e.evenementId === ev2);
      verifier("le tableau montre le mode SAISON_PLUIES comme DECLARE", t.mode.mode === "SAISON_PLUIES" && t.mode.declare === true, t.mode);
      verifier("ev1 reste OUVERT au niveau d'escalade 2, sans destinataire (meme apres desactivation de la regle 2)", t1?.statut === "OUVERT" && t1.escalade?.niveau === 2 && t1.escalade?.sansDestinataire === true, t1);
      verifier("ev2 est PRIS_EN_COMPTE et sans escalade", t2?.statut === "PRIS_EN_COMPTE" && !t2.escalade, t2);
      verifier("1 astreinte active, 1 regle active (la 2e est desactivee), 0 incoherence, 0 patrouille a faire", t.astreintes.length === 1 && t.regles.actives === 1 && t.regles.incoherences.length === 0 && t.patrouilles.length === 0, { astreintes: t.astreintes.length, regles: t.regles.actives, incoherences: t.regles.incoherences.length, patrouilles: t.patrouilles.length });
      const audits = await tx.auditLog.groupBy({ by: ["entityType"], where: { userId: "u-cvi" }, _count: true });
      const aud = audits.map((a) => `${a.entityType}:${a._count}`).sort().join(", ");
      verifier("toute ecriture est auditee : astreinte 1, main courante 3, escalades 2, mode 1, regles 3 (2 creations et 1 desactivation)", aud === "Astreinte:1, EntreeMainCourante:3, Escalade:2, ModeVeille:1, RegleEscalade:3", aud);
      throw new Annulation();
    }, { timeout: 120_000 });
  } catch (e) {
    if (!(e instanceof Annulation)) throw e;
    console.log("transaction annulee");
  }
  verifier("rien ne subsiste apres l'annulation (0 regle, 0 astreinte)", (await prisma.regleEscalade.count()) === 0 && (await prisma.astreinte.count()) === 0);
  conclure();
}
main().catch((e) => { console.error(e); process.exitCode = 2; }).finally(() => prisma.$disconnect());
