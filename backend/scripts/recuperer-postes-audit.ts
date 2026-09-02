/**
 * Recupere les postes de peage et de pesage depuis le journal d'audit (T9).
 *
 * CE QUE LE JOURNAL CONSERVE
 *
 * La table `postes` compte 0 ligne et passait pour n'avoir jamais ete alimentee. Le
 * journal conserve pourtant DIX suppressions du 01/07/2026, qui se reduisent a SIX
 * sites distincts — les autres etaient des doublons d'accentuation (« Peage de
 * Kilissi » et « Péage de Kilissi »).
 *
 * La suppression etait justifiee : elle retirait des doublons. L'absence de reprise
 * ensuite ne l'est pas.
 *
 * CE QUI EST REPRIS
 *
 * Le site : nom, type, statut, region. Rien d'autre.
 *
 * CE QUI N'EST PAS REPRIS, ET POURQUOI
 *
 * Quatre postes portaient une valeur de trafic, deux une recette mensuelle :
 *
 *     Peage de Kilissi                3 200 v/j   285 000 000 GNF
 *     Peage de Maferinyah             2 100 v/j   198 000 000 GNF
 *     Poste de pesage de Kissidougou  1 500 v/j
 *     Poste de pesage de Linsan       3 200 v/j
 *
 * Ces valeurs ne sont PAS restaurees comme des mesures. Trois indices vont contre :
 * Kilissi et Linsan portent exactement la meme valeur ; tous les montants sont ronds
 * a la centaine ou au million ; aucun de ces postes n'avait de coordonnees.
 *
 * C'est la signature d'un jeu de demonstration, pas d'une campagne de comptage. Les
 * restaurer remplirait de fiction un module aujourd'hui vide — precisement ce que le
 * §41 interdit. Elles sont conservees dans le journal, ou elles restent consultables,
 * et reportees en note sur le poste recupere.
 *
 * PENDING_VALIDATION
 *
 * Un site recupere n'est pas un site confirme. `recoveryStatus` reste en attente
 * jusqu'a ce qu'un agent tranche.
 *
 * Usage :
 *   tsx scripts/recuperer-postes-audit.ts            # a blanc
 *   tsx scripts/recuperer-postes-audit.ts --apply    # ecrit
 */
import { PrismaClient } from "@prisma/client";
import { normaliserNom, dedoublonnerParNom, porteDesAccents } from "../src/lib/dedoublonnage";

const prisma = new PrismaClient();
const APPLIQUER = process.argv.includes("--apply");

interface PosteSupprime {
  nom: string;
  type: string;
  statut: string;
  regionId: number;
  traficJma: number | null;
  recettesMensuellesGnf: string | null;
}

async function main() {
  const entrees = await prisma.auditLog.findMany({
    where: { entityType: "Poste", action: "DELETE" },
    select: { before: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`${entrees.length} suppressions de postes dans le journal d'audit`);

  // Dedoublonnage insensible aux accents et a la casse, en preferant l'orthographe
  // accentuee — plus proche de la forme correcte.
  const supprimes = entrees
    .map((e) => e.before as unknown as PosteSupprime | null)
    .filter((b): b is PosteSupprime => !!b?.nom);

  const sites = dedoublonnerParNom(
    supprimes,
    (p) => p.nom,
    (candidat, retenu) => porteDesAccents(candidat.nom) && !porteDesAccents(retenu.nom)
  );
  console.log(`${sites.length} sites distincts apres dedoublonnage`);
  console.log(APPLIQUER ? "MODE ECRITURE" : "MODE A BLANC — aucune ecriture");
  console.log("");
  console.log("site".padEnd(34) + "type".padEnd(9) + "statut".padEnd(15) + "trafic (non repris)");
  console.log("-".repeat(84));
  for (const s of sites) {
    console.log(
      s.nom.padEnd(34) +
        s.type.padEnd(9) +
        s.statut.padEnd(15) +
        (s.traficJma != null ? `${s.traficJma} v/j` : "—")
    );
  }
  console.log("-".repeat(84));
  console.log("");

  if (!APPLIQUER) {
    console.log("Relancer avec --apply pour recuperer les sites.");
    console.log("Les valeurs de trafic et de recettes ne seront PAS restaurees.");
    return;
  }

  // Les postes deja presents ne sont pas dupliques : la contrainte d'unicite
  // insensible aux accents posee par la migration l'interdirait de toute facon, mais
  // mieux vaut ne pas compter dessus pour un message d'erreur lisible.
  const existants = await prisma.poste.findMany({ where: { deletedAt: null }, select: { nom: true } });
  const dejaLa = new Set(existants.map((p) => normaliserNom(p.nom)));

  let crees = 0;
  for (const s of sites) {
    if (dejaLa.has(normaliserNom(s.nom))) {
      console.log(`  deja present, ignore : ${s.nom}`);
      continue;
    }

    const noteTrafic =
      s.traficJma != null || s.recettesMensuellesGnf != null
        ? ` Le journal portait un trafic de ${s.traficJma ?? "?"} v/j` +
          (s.recettesMensuellesGnf ? ` et une recette de ${s.recettesMensuellesGnf} GNF/mois` : "") +
          `. Valeurs NON reprises : deux postes portaient exactement 3 200, tous les montants etaient ronds, ` +
          `et aucun n'avait de coordonnees — signature d'un jeu de demonstration, pas d'une campagne de comptage.`
        : "";

    await prisma.poste.create({
      data: {
        nom: s.nom,
        type: s.type as never,
        statut: s.statut as never,
        regionId: s.regionId,
        // Ni trafic ni recettes : voir l'en-tete.
        traficJma: null,
        recettesMensuellesGnf: null,
        historicalRecovered: true,
        recoveredFrom: "AUDIT_LOG",
        recoveryStatus: "PENDING_VALIDATION",
      },
    });
    crees++;
    if (noteTrafic) console.log(`  ${s.nom} —${noteTrafic}`);
  }

  console.log("");
  console.log(`${crees} sites recuperes, en attente de validation.`);
  console.log("Aucune valeur de trafic ni de recette n'a ete restauree.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
