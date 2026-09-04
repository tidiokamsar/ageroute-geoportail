/**
 * Clore un chantier et declarer l'etat de la route qu'il a traitee.
 *
 * SANS `--apply`, LE SCRIPT NE FAIT QUE LIRE.
 *
 * POURQUOI UN SCRIPT PLUTOT QUE L'INTERFACE
 *
 * L'interface sait deja passer un chantier a TERMINE. Ce qu'elle ne fait pas, et
 * c'est le trou constate le 04/09/2026 sur « 2e Boulevard », c'est mettre a jour
 * `valeurs_qualite` : une valeur saisie a la main garde sa ligne de provenance
 * d'origine, et la base continue d'affirmer « absent de la source » pour une valeur
 * que quelqu'un a bel et bien saisie.
 *
 * Ce script fait les deux, et surtout il conserve l'ancien etat dans la trace.
 *
 * CE QU'IL ECRASE, ET POURQUOI C'EST DIFFERENT
 *
 * Les autres scripts de cette serie refusent de remplacer une valeur affirmee : ils
 * ne comblent que des inconnus. Ici c'est l'inverse assume — la fin d'un chantier
 * change reellement l'etat d'une route, et refuser de le refleter figerait la base
 * dans un passe faux.
 *
 * Mais l'ancienne valeur n'est pas perdue : elle est ecrite dans la note de
 * `valeurs_qualite`. Un etat qui passe de MAUVAIS a BON sans inspection est une
 * DECLARATION, et le fait de savoir d'ou il vient est ce qui la rend verifiable.
 *
 * Usage :
 *   tsx scripts/cloturer-chantier.ts --chantier=<uuid>
 *   ... --designation=RN11        (les troncons de cette route changent d'etat)
 *   ... --etat=BON                (defaut BON)
 *   ... --apply
 */
import { PrismaClient } from "@prisma/client";
import "dotenv/config";
import { analyserEtat } from "./lib/promotion";

const prisma = new PrismaClient();

function argument(nom: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${nom}=`));
  return p ? p.slice(nom.length + 3) : undefined;
}

async function main() {
  const chantierId = argument("chantier");
  const designation = argument("designation");
  const etat = analyserEtat(argument("etat") ?? "BON");
  const appliquer = process.argv.includes("--apply");

  if (!chantierId) throw new Error("--chantier=<uuid> est obligatoire.");

  const chantier = await prisma.chantier.findUnique({ where: { id: chantierId } });
  if (!chantier) throw new Error(`Chantier ${chantierId} introuvable.`);

  const troncons = designation
    ? await prisma.troncon.findMany({
        where: { deletedAt: null, nom: designation },
        select: { id: true, code: true, etat: true, longueurKm: true },
        orderBy: { code: "asc" },
      })
    : [];

  console.log("=== Cloture de chantier ===");
  console.log(`Mode : ${appliquer ? "ECRITURE" : "LECTURE SEULE (ajouter --apply)"}`);
  console.log("");
  console.log(`Chantier : ${chantier.intitule.slice(0, 90)}`);
  console.log(`  statut    : ${chantier.statut} (${chantier.avancementPct} %)  ->  TERMINE (100 %)`);
  console.log("");

  if (designation) {
    console.log(`Troncons ${designation} : ${troncons.length}`);
    for (const t of troncons) {
      const change = t.etat !== etat;
      console.log(
        `  ${t.code.padEnd(18)} ${String(t.etat).padEnd(11)} -> ${etat}` +
        `  ${(t.longueurKm ?? 0).toFixed(1)} km` +
        (change && t.etat !== "NON_EVALUE" ? "   << ECRASE UN ETAT EVALUE" : ""),
      );
    }
    console.log("");
  }

  if (!appliquer) {
    console.log("LECTURE SEULE — rien n'a ete ecrit.");
    return;
  }

  const maintenant = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.chantier.update({
      where: { id: chantierId },
      data: {
        statut: "TERMINE",
        avancementPct: 100,
        dateFinReelle: chantier.dateFinReelle ?? maintenant,
      },
    });

    for (const t of troncons) {
      if (t.etat === etat) continue;
      await tx.troncon.update({ where: { id: t.id }, data: { etat } });
      const note =
        `État ${etat} déclaré le ${maintenant.toISOString().slice(0, 10)} à la clôture du chantier `
        + `« ${chantier.intitule.slice(0, 60)} ». Valeur précédente : ${t.etat}. `
        + "Aucune inspection : à confirmer par un relevé de terrain.";
      await tx.valeurQualite.upsert({
        where: { entityType_entityId_champ: { entityType: "Troncon", entityId: t.id, champ: "etat" } },
        create: {
          entityType: "Troncon", entityId: t.id, champ: "etat",
          statut: "IMPORTED_UNVERIFIED", source: "CLOTURE_CHANTIER", methode: "DECLARATION",
          observedAt: maintenant, confiance: "LOW", note,
        },
        update: {
          statut: "IMPORTED_UNVERIFIED", source: "CLOTURE_CHANTIER", methode: "DECLARATION",
          observedAt: maintenant, confiance: "LOW", note,
        },
      });
    }
  });

  console.log("--- Applique ---");
  console.log(`  chantier clos          : 1`);
  console.log(`  troncons passes a ${etat} : ${troncons.filter((t) => t.etat !== etat).length}`);
  console.log("");
  console.log("Retour arriere : les etats precedents figurent dans les notes de");
  console.log("valeurs_qualite (champ 'etat', source 'CLOTURE_CHANTIER').");
}

main()
  .catch((e) => { console.error("ECHEC :", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
