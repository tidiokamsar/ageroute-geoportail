/**
 * Approuve une regle de condition. C'est le SEUL geste qui rend un score publiable.
 *
 * POURQUOI L'APPROBATION N'EST PAS UN TAMPON
 *
 * `approuveeLe` est l'interrupteur qui fait passer un score de `publiable: false` a
 * `publiable: true`. Une regle approuvee avec une table de classes trouee, des poids
 * malformes ou une normalisation vide produirait donc des scores PUBLIABLES et FAUX — ce qui
 * est strictement pire que l'etat actuel, ou rien ne sort.
 *
 * Ce script VERIFIE donc la regle avant de l'approuver, et refuse si elle est malformee. Il
 * reutilise `refusClasses()` du moteur, pour que le controle soit exactement celui qui
 * servira au calcul : un second controle redige a part divergerait un jour du premier.
 *
 * CE QU'IL EXIGE, ET POURQUOI CHAQUE ARGUMENT EST OBLIGATOIRE
 *
 *   --version   la regle a approuver. Jamais de defaut : approuver « la derniere » laisserait
 *               un script decider de ce qui fait foi.
 *   --par       le compte qui approuve. Une approbation sans auteur n'est imputable a
 *               personne, et c'est precisement ce que la colonne existe pour empecher.
 *   --motif     la raison. Elle est jointe au journal d'audit : dans deux ans, « qui » ne
 *               suffira pas, il faudra « pourquoi ».
 *
 * CE QU'IL NE FAIT PAS
 *
 * Il ne recalcule aucun score, n'en efface aucun, et ne touche ni aux poids ni aux seuils.
 * Approuver une regle, c'est dire qu'elle fait foi en l'etat ; l'amender est un autre geste.
 *
 * Il refuse aussi de reapprouver une regle deja approuvee : ecraser une date d'approbation
 * ferait perdre la trace de la premiere decision.
 *
 * RETOUR ARRIERE
 *
 *     update regles_condition set "approuveeLe" = null, "approuveeParId" = null
 *       where version = '<version>';
 *
 * Desapprouver est sans danger pour les donnees : les scores deja produits gardent leur
 * `publiable`, qui est fige a l'ecriture. Mais la desapprobation doit elle aussi etre
 * auditee, donc elle passe par une decision, pas par ce script.
 *
 * USAGE
 *
 *   npx tsx scripts/approuver-regle-condition.ts \
 *     --version rci-2026.1 --par tidiane.diallo@ageroute.gov.gn --motif "..."
 */
import { AuditAction, Role } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { logAuditTransactionnelle } from "../src/utils/audit";
import { refusClasses, type ClasseRci } from "../src/engines/condition";

function argument(nom: string): string | null {
  const i = process.argv.indexOf(`--${nom}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

/** Ce qui rend une regle inapte a etre approuvee. Rend null quand elle est apte. */
function refusApprobation(regle: {
  poids: unknown;
  normalisation: unknown;
  classes: unknown;
  couvertureMinimale: unknown;
  fraicheurMaxJours: number | null;
  confiancesAcceptees: string[];
}): string | null {
  const poids = regle.poids;
  if (typeof poids !== "object" || poids === null || Array.isArray(poids)) {
    return "`poids` n'est pas un objet. Aucune composante ne serait ponderee.";
  }
  const entrees = Object.entries(poids as Record<string, unknown>);
  if (entrees.length === 0) return "`poids` est vide : aucune composante ne serait ponderee.";
  for (const [k, v] of entrees) {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      return `le poids de ${k} n'est pas un nombre strictement positif.`;
    }
  }
  const somme = entrees.reduce((s, [, v]) => s + (v as number), 0);
  // Le moteur RENORMALISE, donc une somme differente de 100 ne le casse pas. Mais une regle
  // approuvee dont les poids ne totalisent pas 100 se lirait de travers dans tout rapport :
  // « chaussee 30 » n'y vaudrait pas 30 %. Le refus est donc editorial, pas arithmetique.
  if (Math.abs(somme - 100) > 0.001) {
    return `les poids totalisent ${somme} et non 100. Le moteur renormalise, mais un rapport`
      + " lirait « chaussee 30 » comme 30 %, ce qui serait faux.";
  }

  const norm = regle.normalisation;
  if (typeof norm !== "object" || norm === null || Array.isArray(norm)) {
    return "`normalisation` n'est pas un objet.";
  }
  if (Object.keys(norm as object).length === 0) {
    return "`normalisation` est vide : aucune valeur de source ne serait lisible, donc aucun"
      + " score ne sortirait jamais. Approuver une telle regle serait une promesse vide.";
  }

  if (!Array.isArray(regle.classes)) return "`classes` n'est pas un tableau.";
  const refus = refusClasses(regle.classes as readonly ClasseRci[]);
  if (refus) return `table de classes inapte : ${refus}`;

  const couverture = Number(regle.couvertureMinimale);
  if (!Number.isFinite(couverture) || couverture <= 0 || couverture > 1) {
    return `couvertureMinimale vaut ${regle.couvertureMinimale}, hors de l'intervalle 0-1.`;
  }
  if (regle.fraicheurMaxJours !== null
      && (!Number.isInteger(regle.fraicheurMaxJours) || regle.fraicheurMaxJours <= 0)) {
    return "`fraicheurMaxJours` doit etre un entier positif, ou nul pour ne rien exiger.";
  }
  if (regle.confiancesAcceptees.length === 0) {
    return "`confiancesAcceptees` est vide : aucune confiance ne serait acceptee, donc aucune"
      + " composante retenue.";
  }
  return null;
}

async function main() {
  const version = argument("version");
  const par = argument("par");
  const motif = argument("motif");

  if (!version || !par || !motif) {
    throw new Error(
      "Arguments obligatoires : --version <version> --par <email> --motif \"<raison>\".\n"
      + "  Aucun n'a de valeur par defaut : approuver « la derniere regle » laisserait un"
      + " script decider de ce qui fait foi.",
    );
  }

  const regle = await prisma.regleCondition.findUnique({ where: { version } });
  if (!regle) {
    const connues = await prisma.regleCondition.findMany({ select: { version: true } });
    throw new Error(
      `Aucune regle en version ${version}.`
      + (connues.length
        ? ` Versions connues : ${connues.map((r) => r.version).join(", ")}.`
        : " La table est vide : lancez d'abord `npm run condition:regle:seed`."),
    );
  }

  if (regle.approuveeLe) {
    throw new Error(
      `${version} est deja approuvee le ${regle.approuveeLe.toISOString().slice(0, 10)}.`
      + " Ecraser cette date ferait perdre la trace de la premiere decision.",
    );
  }

  const approbateur = await prisma.user.findUnique({
    where: { email: par },
    select: { id: true, email: true, role: true, actif: true },
  });
  if (!approbateur) throw new Error(`Aucun compte avec l'adresse ${par}.`);
  if (!approbateur.actif) throw new Error(`Le compte ${par} est desactive.`);
  if (approbateur.role !== Role.ADMIN) {
    throw new Error(
      `Le compte ${par} porte le role ${approbateur.role}. Approuver une regle de calcul`
      + " national demande le role ADMIN.",
    );
  }

  const refus = refusApprobation(regle);
  if (refus) {
    throw new Error(
      `REGLE INAPTE A L'APPROBATION : ${refus}\n`
      + "  Approuver une regle malformee produirait des scores PUBLIABLES et FAUX, ce qui est"
      + " pire que l'etat actuel ou rien ne sort.",
    );
  }

  const approuvee = await prisma.$transaction(async (tx) => {
    const maj = await tx.regleCondition.update({
      where: { version },
      data: { approuveeLe: new Date(), approuveeParId: approbateur.id },
    });
    await logAuditTransactionnelle(tx, {
      userId: approbateur.id,
      action: AuditAction.UPDATE,
      entityType: "RegleCondition",
      entityId: maj.id,
      before: { approuveeLe: null, approuveeParId: null },
      after: { approuveeLe: maj.approuveeLe, approuveeParId: maj.approuveeParId, motif },
    });
    return maj;
  });

  const poids = approuvee.poids as Record<string, number>;
  console.log(`Regle ${version} APPROUVEE le ${approuvee.approuveeLe?.toISOString()}`);
  console.log(`  par ${approbateur.email} (ADMIN)`);
  console.log(`  motif : ${motif}`);
  console.log("");
  console.log("  Composantes ponderees :");
  for (const [k, v] of Object.entries(poids)) console.log(`    ${k.padEnd(14)} ${v} %`);
  console.log(`  Couverture minimale : ${approuvee.couvertureMinimale}`);
  console.log(`  Fraicheur maximale  : ${approuvee.fraicheurMaxJours} jours`);
  console.log(`  Confiances acceptees : ${approuvee.confiancesAcceptees.join(", ")}`);
  console.log("");
  console.log("  CE QUE L'APPROBATION CHANGE : les scores produits sous cette regle sortiront");
  console.log("  desormais avec publiable = true, au lieu de porter « NON APPROUVEE ».");
  console.log("");
  console.log("  CE QU'ELLE NE CHANGE PAS : il n'y a toujours AUCUN score, et il n'y en aura");
  console.log("  aucun tant que la collecte n'aura pas tourne. La couverture maximale");
  console.log("  atteignable est 0,45 pour un seuil a 0,5 : le moteur refuse donc chaque");
  console.log("  score, avec COUVERTURE_INSUFFISANTE. Le verrou est la COLLECTE.");
}

main()
  .catch((e) => { console.error("ECHEC :", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
