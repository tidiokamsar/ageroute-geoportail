/**
 * Etablit l'etat de connaissance initial des six champs de decision (T3, T4).
 *
 * CE QU'IL FAIT
 *
 * Pour chacun des 1 690 troncons, il enregistre ce que l'on sait de son etat, de sa
 * longueur, de son revetement, de son trafic, de sa criticite et de son cout. Soit
 * 10 140 lignes de qualite decrivant des valeurs dont aucune n'est constatee.
 *
 * CE QU'IL NE FAIT PAS
 *
 * Il ne modifie AUCUNE valeur metier. Il ne corrige pas BITUME, il dit que BITUME
 * n'a jamais ete verifie. La difference est tout le ticket : marquer est possible,
 * corriger ne l'est pas faute de source.
 *
 * MODE PAR DEFAUT : A BLANC
 *
 * Sans `--apply`, rien n'est ecrit.
 *
 * IDEMPOTENT
 *
 * L'ecriture est un upsert sur (entite, enregistrement, champ) : rejouer le script
 * remet les memes valeurs, sans creer de doublon ni empiler de statuts contradictoires.
 *
 * Usage :
 *   tsx scripts/backfill-qualite.ts            # a blanc
 *   tsx scripts/backfill-qualite.ts --apply    # ecrit
 */
import { PrismaClient } from "@prisma/client";
import { qualiteInitialeTroncon, type TronconAQualifier } from "../src/lib/qualite";

const prisma = new PrismaClient();
const APPLIQUER = process.argv.includes("--apply");
const TAILLE_LOT = 100;

async function main() {
  const troncons = (await prisma.troncon.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      etat: true,
      longueurKm: true,
      revetement: true,
      traficMoyenJma: true,
      criticiteStrategique: true,
      coutRehabEstime: true,
      dateDerniereEvaluation: true,
    },
  })) as unknown as TronconAQualifier[];

  const ecritures = troncons.flatMap(qualiteInitialeTroncon);

  const parChampStatut = new Map<string, Map<string, number>>();
  let datees = 0;
  for (const e of ecritures) {
    const m = parChampStatut.get(e.champ) ?? new Map<string, number>();
    m.set(e.statut, (m.get(e.statut) ?? 0) + 1);
    parChampStatut.set(e.champ, m);
    if (e.observedAt) datees++;
  }

  console.log(`${troncons.length} troncons, ${ecritures.length} lignes de qualite`);
  console.log(APPLIQUER ? "MODE ECRITURE" : "MODE A BLANC — aucune ecriture");
  console.log("");
  console.log("champ".padEnd(24) + "statuts");
  console.log("-".repeat(88));
  for (const [champ, statuts] of parChampStatut) {
    const detail = [...statuts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `${s} ${n}`)
      .join("   ");
    console.log(champ.padEnd(24) + detail);
  }
  console.log("-".repeat(88));
  console.log(`valeurs portant une date de constat : ${datees} / ${ecritures.length}`);
  console.log("");

  if (!APPLIQUER) {
    console.log("Relancer avec --apply pour ecrire.");
    return;
  }

  let ecrits = 0;
  for (let i = 0; i < ecritures.length; i += TAILLE_LOT) {
    const lot = ecritures.slice(i, i + TAILLE_LOT);
    await prisma.$transaction(
      lot.map((e) =>
        prisma.valeurQualite.upsert({
          where: {
            entityType_entityId_champ: {
              entityType: e.entityType,
              entityId: e.entityId,
              champ: e.champ,
            },
          },
          create: {
            entityType: e.entityType,
            entityId: e.entityId,
            champ: e.champ,
            statut: e.statut,
            source: e.source ?? null,
            methode: e.methode ?? null,
            observedAt: e.observedAt ?? null,
            confiance: e.confiance ?? null,
            note: e.note ?? null,
          },
          update: {
            statut: e.statut,
            source: e.source ?? null,
            methode: e.methode ?? null,
            observedAt: e.observedAt ?? null,
            confiance: e.confiance ?? null,
            note: e.note ?? null,
          },
        })
      )
    );
    ecrits += lot.length;
    process.stdout.write(`\r  ${ecrits}/${ecritures.length}`);
  }
  console.log("");
  console.log(`${ecrits} lignes de qualite enregistrees.`);
  console.log("Aucune valeur metier n'a ete modifiee.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
