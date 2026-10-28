/**
 * Remplit les referentiels du revetement et de l'etat de chaussee.
 *
 * NE REMPLIT PAS LA PRATICABILITE, ET C'EST LE POINT PRINCIPAL
 *
 * Le cahier demande un referentiel de praticabilite sans enoncer UNE SEULE valeur, la ou
 * il liste les huit revetements. Ecrire ici « PRATICABLE / DIFFICILE / IMPRATICABLE » en
 * ferait la norme d'AGEROUTE par defaut, alors que personne ne l'a decidee. Meme regle que
 * pour les coefficients du RCI : le mecanisme attend la decision, il ne la devance pas.
 *
 * Consequence assumee : aucune portion ne pourra porter de praticabilite avant qu'AGEROUTE
 * n'ait rempli cette table. Le script le dit a chaque execution.
 *
 * D'OU VIENNENT LES DEUX VOCABULAIRES REMPLIS
 *
 * Les REVETEMENTS sont les huit du paragraphe 7, repris mot pour mot. Les ETATS sont les
 * cinq deja en usage sur 261 387 troncons : ils ne sont pas proposes, ils sont constates.
 *
 * LE DRAPEAU `bitumineux` EST UNE DECISION, PAS UNE DEDUCTION
 *
 * Le paragraphe 13 demande « longueur bitumee et non bitumee ». Avec un vocabulaire
 * administrable, aucun programme ne peut deviner si un libelle ajoute demain est
 * bitumineux. Les valeurs posees ici sont donc les miennes et se discutent :
 *
 *   beton bitumineux, enduit superficiel  ->  bitumineux
 *   beton de ciment, paves                ->  REVETUS mais NON bitumineux
 *   laterite, terre                       ->  non revetus
 *
 * `BETON` designe le beton de ciment : le cahier liste « beton bitumineux » et « beton »
 * separement, donc le second n'est pas le premier.
 *
 * `critique` ne vaut `true` que pour CRITIQUE. Savoir si MAUVAIS doit compter dans la
 * « longueur critique » du paragraphe 13 est une decision d'AGEROUTE, et l'etendre ici
 * gonflerait un indicateur de 134 a 230 troncons sans que personne l'ait voulu.
 *
 * UNE AMBIGUITE QUE CE SCRIPT NE RESOUT PAS
 *
 * `troncons.revetement` vaut BITUME sur 2 426 lignes. Ce BITUME recouvre indifferemment
 * BETON_BITUMINEUX, ENDUIT_SUPERFICIEL et BETON. Les repartir n'est pas une CONVERSION,
 * c'est un RELEVE : il faut aller voir. Ce script ne touche donc pas `troncons`, qui garde
 * son enum.
 *
 * IDEMPOTENT
 *
 * Une ligne existante n'est JAMAIS modifiee. Si un gestionnaire a renomme un libelle ou
 * change un drapeau, rejouer ce script laisse sa decision en place.
 *
 * RETOUR ARRIERE
 *
 *     delete from referentiel_revetements where source = 'cahier_rai_v3_1_7'
 *       and code not in (select revetement from portions where revetement is not null);
 *     delete from referentiel_etats_chaussee where source = 'usage_production_2026'
 *       and code not in (select etat from portions where etat is not null);
 */
import { AuditAction, Role } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { logAuditTransactionnelle } from "../src/utils/audit";

const SOURCE_REVETEMENT = "cahier_rai_v3_1_7";
const SOURCE_ETAT = "usage_production_2026";

interface Revetement {
  code: string;
  libelle: string;
  ordre: number;
  bitumineux: boolean;
  description: string;
}

/** Les huit du paragraphe 7, dans son ordre. */
const REVETEMENTS: Revetement[] = [
  {
    code: "BETON_BITUMINEUX", libelle: "Béton bitumineux", ordre: 1, bitumineux: true,
    description: "Enrobé à liant hydrocarboné. Compte dans la longueur bitumée.",
  },
  {
    code: "ENDUIT_SUPERFICIEL", libelle: "Enduit superficiel", ordre: 2, bitumineux: true,
    description: "Revêtement bitumineux mince, appliqué en surface. Compte dans la longueur bitumée.",
  },
  {
    code: "BETON", libelle: "Béton de ciment", ordre: 3, bitumineux: false,
    description: "Chaussée rigide à liant hydraulique. Revêtue mais NON bitumineuse.",
  },
  {
    code: "PAVE", libelle: "Pavés", ordre: 4, bitumineux: false,
    description: "Pavés ou blocs posés. Revêtue mais non bitumineuse.",
  },
  {
    code: "LATERITE", libelle: "Latérite", ordre: 5, bitumineux: false,
    description: "Piste en latérite compactée. Non revêtue.",
  },
  {
    code: "TERRE", libelle: "Terre", ordre: 6, bitumineux: false,
    description: "Piste en terre naturelle. Non revêtue.",
  },
  {
    code: "AUTRE", libelle: "Autre", ordre: 7, bitumineux: false,
    description: "Revêtement connu mais hors de cette liste. À requalifier dès que possible.",
  },
  {
    code: "NON_RENSEIGNE", libelle: "Non renseigné", ordre: 8, bitumineux: false,
    description:
      "Personne n'a relevé le revêtement. DISTINCT d'« Autre » : ici on ne sait pas, "
      + "là on sait que ce n'est aucun des sept précédents.",
  },
];

interface Etat {
  code: string;
  libelle: string;
  ordre: number;
  critique: boolean;
  description: string;
}

/** Les cinq en usage sur 261 387 troncons, du meilleur au pire. */
const ETATS: Etat[] = [
  { code: "BON", libelle: "Bon", ordre: 1, critique: false, description: "Aucune dégradation significative." },
  { code: "MOYEN", libelle: "Moyen", ordre: 2, critique: false, description: "Dégradations localisées, circulation normale." },
  { code: "MAUVAIS", libelle: "Mauvais", ordre: 3, critique: false, description: "Dégradations étendues. Compte-t-il dans la longueur critique ? Décision AGEROUTE." },
  { code: "CRITIQUE", libelle: "Critique", ordre: 4, critique: true, description: "Chaussée hors d'usage ou dangereuse. Compte dans la longueur critique." },
  {
    code: "NON_EVALUE", libelle: "Non évalué", ordre: 5, critique: false,
    description:
      "Aucune évaluation. N'est PAS un état : c'est l'absence d'état, et ne doit jamais "
      + "être compté comme un bon état ni comme un mauvais.",
  },
];

async function main() {
  const auteur = await prisma.user.findFirst({
    where: { role: Role.ADMIN, actif: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true },
  });
  if (!auteur) {
    throw new Error("Aucun compte ADMIN actif : impossible d'attribuer un auteur. Créez d'abord un administrateur.");
  }

  let creesRevetement = 0;
  let creesEtat = 0;

  for (const r of REVETEMENTS) {
    // Une ligne existante est une donnee administree, meme si son libelle differe de la
    // valeur proposee ici.
    if (await prisma.referentielRevetement.findUnique({ where: { code: r.code } })) continue;
    await prisma.$transaction(async (tx) => {
      const creee = await tx.referentielRevetement.create({
        data: { ...r, source: SOURCE_REVETEMENT },
      });
      await logAuditTransactionnelle(tx, {
        userId: auteur.id,
        action: AuditAction.CREATE,
        entityType: "ReferentielRevetement",
        entityId: creee.code,
        after: creee,
      });
    });
    creesRevetement++;
  }

  for (const e of ETATS) {
    if (await prisma.referentielEtatChaussee.findUnique({ where: { code: e.code } })) continue;
    await prisma.$transaction(async (tx) => {
      const creee = await tx.referentielEtatChaussee.create({
        data: { ...e, source: SOURCE_ETAT },
      });
      await logAuditTransactionnelle(tx, {
        userId: auteur.id,
        action: AuditAction.CREATE,
        entityType: "ReferentielEtatChaussee",
        entityId: creee.code,
        after: creee,
      });
    });
    creesEtat++;
  }

  const totalRevetement = await prisma.referentielRevetement.count();
  const totalEtat = await prisma.referentielEtatChaussee.count();
  const totalPraticabilite = await prisma.referentielPraticabilite.count();

  console.log(`Revêtements : ${creesRevetement} créés, ${totalRevetement} au total (auteur ${auteur.email}).`);
  console.log(`États de chaussée : ${creesEtat} créés, ${totalEtat} au total.`);
  console.log(`Praticabilités : ${totalPraticabilite}. VOLONTAIREMENT VIDE.`);
  console.log("  Le cahier demande ce référentiel sans énoncer aucune valeur.");
  console.log("  Aucune portion ne pourra porter de praticabilité avant qu'AGEROUTE l'ait rempli.");
  console.log("Les 2 426 tronçons à BITUME ne sont pas convertis : BITUME recouvre");
  console.log("  BETON_BITUMINEUX, ENDUIT_SUPERFICIEL et BETON. Les répartir est un relevé,");
  console.log("  pas une conversion. `troncons.revetement` garde son enum.");
}

main()
  .catch((e) => { console.error("ECHEC :", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
