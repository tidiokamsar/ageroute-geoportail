/**
 * Renseigne retroactivement la provenance des troncons depuis leur code (T2).
 *
 * POURQUOI CE SCRIPT PLUTOT QU'UNE MIGRATION
 *
 * Une migration doit modifier la structure, pas deviner des valeurs. Separer les deux
 * permet de rejouer ce remplissage, de le verifier a blanc, et de le refaire si les
 * regles de deduction evoluent — sans toucher au schema ni bloquer un deploiement.
 *
 * CE QU'IL ECRIT, ET CE QU'IL N'ECRIT PAS
 *
 * Il ecrit UNIQUEMENT les quatre colonnes de provenance ajoutees par la migration
 * 20260902100000. Il ne touche a aucune donnee metier : ni longueur, ni revetement,
 * ni etat, ni geometrie.
 *
 * MODE PAR DEFAUT : A BLANC
 *
 * Sans `--apply`, le script montre ce qu'il ferait et n'ecrit rien. C'est le mode a
 * utiliser en premier, y compris quand on croit savoir ce qu'il va faire.
 *
 * IDEMPOTENT
 *
 * Un troncon dont la provenance est deja identique est laisse tel quel. Rejouer le
 * script ne produit donc aucune ecriture, et la date de la deduction d'origine est
 * preservee.
 *
 * Usage :
 *   tsx scripts/backfill-provenance.ts            # a blanc, n'ecrit rien
 *   tsx scripts/backfill-provenance.ts --apply    # ecrit
 */
import { PrismaClient } from "@prisma/client";
import { planifierProvenance } from "../src/lib/provenance";

const prisma = new PrismaClient();
const APPLIQUER = process.argv.includes("--apply");

// Ecrire 1 690 lignes une par une ouvrirait 1 690 transactions. Par paquets, la duree
// reste de l'ordre de la seconde et la charge sur la base reste faible.
const TAILLE_LOT = 200;

async function main() {
  const troncons = await prisma.troncon.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      code: true,
      sourceType: true,
      sourceReference: true,
      sourceConfidence: true,
    },
    orderBy: { code: "asc" },
  });

  const plan = planifierProvenance(troncons);

  console.log(`${plan.total} troncons examines`);
  console.log(APPLIQUER ? "MODE ECRITURE" : "MODE A BLANC — aucune ecriture");
  console.log("");
  console.log("famille".padEnd(14) + "troncons".padStart(10) + "a ecrire".padStart(10) + "  motif");
  console.log("-".repeat(100));
  for (const r of plan.parReference) {
    console.log(
      r.reference.padEnd(14) +
        String(r.total).padStart(10) +
        String(r.aEcrire).padStart(10) +
        "  " +
        r.motif
    );
  }
  console.log("-".repeat(100));
  console.log(`total a ecrire : ${plan.aEcrire.length}`);
  console.log("");

  if (!APPLIQUER) {
    console.log("Relancer avec --apply pour ecrire.");
    return;
  }
  if (plan.aEcrire.length === 0) {
    console.log("Rien a ecrire : la provenance est deja a jour.");
    return;
  }

  const detecteLe = new Date();
  let ecrits = 0;
  for (let i = 0; i < plan.aEcrire.length; i += TAILLE_LOT) {
    const lot = plan.aEcrire.slice(i, i + TAILLE_LOT);
    await prisma.$transaction(
      lot.map(({ id, provenance }) =>
        prisma.troncon.update({
          where: { id },
          data: {
            sourceType: provenance.sourceType,
            sourceReference: provenance.sourceReference,
            sourceConfidence: provenance.sourceConfidence,
            sourceDetectedAt: detecteLe,
          },
        })
      )
    );
    ecrits += lot.length;
    process.stdout.write(`\r  ${ecrits}/${plan.aEcrire.length}`);
  }
  console.log("");
  console.log(`${ecrits} troncons renseignes.`);

  const restants = await prisma.troncon.count({ where: { deletedAt: null, sourceType: null } });
  console.log(
    restants === 0
      ? "Tous les troncons portent desormais une provenance."
      : `${restants} troncons restent sans provenance (dont l'enregistrement d'essai).`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
