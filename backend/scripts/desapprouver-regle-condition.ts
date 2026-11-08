/**
 * Retire l'approbation d'une regle de condition.
 *
 * POURQUOI CE SCRIPT EXISTE, ALORS QUE L'EN-TETE DE L'APPROBATION DISAIT LE CONTRAIRE
 *
 * `approuver-regle-condition.ts` documentait le retour arriere en SQL et ajoutait : « elle doit
 * elle aussi etre auditee, donc elle passe par une decision, pas par ce script ». La decision a
 * ete prise le 14/10/2026 : le prompt maitre V10 (§ A.6.1) exige de comparer la methode du RCI
 * avec **VIZIR** et la **note d'etat structurel UEMOA** avant toute approbation, comparaison
 * que personne n'avait faite.
 *
 * Le geste existe donc maintenant comme geste, et non comme `UPDATE` a la main. Un `UPDATE`
 * aurait retire l'interrupteur de publication sans trace, sans auteur et sans motif — ce que la
 * colonne `approuveeParId` existe precisement pour empecher.
 *
 * CE QU'IL NE FAIT PAS
 *
 * Il ne touche a aucun score. `publiable` est FIGE A L'ECRITURE de chaque evaluation : les
 * scores deja produits gardent le leur, et c'est voulu — un rapport imprime hier ne doit pas
 * changer de sens parce qu'une regle a ete desapprouvee aujourd'hui. Seuls les scores
 * PRODUITS APRES ce geste sortiront non publiables.
 *
 * Il ne modifie ni les poids, ni la normalisation, ni les classes, ni les seuils. Desapprouver
 * dit « cette regle ne fait plus foi en l'etat » ; l'amender est un autre geste.
 *
 * TROIS ARGUMENTS OBLIGATOIRES, comme pour l'approbation. `--motif` est le plus important des
 * trois ici : dans deux ans, « pourquoi a-t-on retire l'approbation » importera davantage que
 * « qui ».
 *
 * USAGE
 *
 *   npx tsx scripts/desapprouver-regle-condition.ts \
 *     --version rci-2026.1 --par <email ADMIN> --motif "..."
 */
import { AuditAction, Role } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { logAuditTransactionnelle } from "../src/utils/audit";

function argument(nom: string): string | null {
  const i = process.argv.indexOf(`--${nom}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function main() {
  const version = argument("version");
  const par = argument("par");
  const motif = argument("motif");

  if (!version || !par || !motif) {
    throw new Error(
      "Arguments obligatoires : --version <version> --par <email> --motif \"<raison>\".\n"
      + "  Retirer une approbation sans motif rendrait la decision inexplicable plus tard.",
    );
  }

  const regle = await prisma.regleCondition.findUnique({ where: { version } });
  if (!regle) throw new Error(`Aucune regle en version ${version}.`);

  if (!regle.approuveeLe) {
    throw new Error(
      `${version} n'est pas approuvee : il n'y a rien a retirer.`
      + " Ce refus evite d'ecrire une ligne d'audit pour un geste sans effet.",
    );
  }

  const auteur = await prisma.user.findUnique({
    where: { email: par },
    select: { id: true, email: true, role: true, actif: true },
  });
  if (!auteur) throw new Error(`Aucun compte avec l'adresse ${par}.`);
  if (!auteur.actif) throw new Error(`Le compte ${par} est desactive.`);
  if (auteur.role !== Role.ADMIN) {
    throw new Error(
      `Le compte ${par} porte le role ${auteur.role}. Retirer l'approbation d'une regle de`
      + " calcul national demande le role ADMIN, comme l'accorder.",
    );
  }

  // Combien de scores ont ete produits sous cette regle ? La reponse ne bloque pas le geste,
  // mais elle doit etre DITE : desapprouver une regle qui a servi a publier des milliers de
  // scores n'a pas la meme portee que desapprouver une regle qui n'a rien produit.
  const evaluations = await prisma.evaluationCondition.count({ where: { regleId: regle.id } });

  const avant = { approuveeLe: regle.approuveeLe, approuveeParId: regle.approuveeParId };

  const maj = await prisma.$transaction(async (tx) => {
    const r = await tx.regleCondition.update({
      where: { version },
      data: { approuveeLe: null, approuveeParId: null },
    });
    await logAuditTransactionnelle(tx, {
      userId: auteur.id,
      action: AuditAction.UPDATE,
      entityType: "RegleCondition",
      entityId: r.id,
      before: avant,
      after: {
        approuveeLe: null,
        approuveeParId: null,
        motif,
        evaluationsDejaProduites: evaluations,
      },
    });
    return r;
  });

  console.log(`Regle ${version} DESAPPROUVEE.`);
  console.log(`  approbation retiree : ${avant.approuveeLe?.toISOString()}`);
  console.log(`  par ${auteur.email} (ADMIN)`);
  console.log(`  motif : ${motif}`);
  console.log("");
  console.log(`  Scores deja produits sous cette regle : ${evaluations}.`);
  if (evaluations === 0) {
    console.log("  Aucun : le retrait ne change donc RIEN a ce qui a ete publie.");
  } else {
    console.log("  Leur `publiable` est FIGE A L'ECRITURE et n'est pas modifie : un rapport");
    console.log("  deja remis ne doit pas changer de sens apres coup. Seuls les scores");
    console.log("  produits desormais sortiront non publiables.");
  }
  console.log("");
  console.log("  Les poids, la normalisation, les classes et les seuils sont INCHANGES.");
  console.log(`  approuveeLe vaut desormais : ${maj.approuveeLe === null ? "null" : "?"}`);
}

main()
  .catch((e) => { console.error("ECHEC :", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
