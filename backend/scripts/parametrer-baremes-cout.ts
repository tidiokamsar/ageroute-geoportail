/**
 * Rend les baremes de cout identifiables et administrables, SANS TOUCHER A UN SEUL COUT.
 *
 * CE QUE CE SCRIPT FAIT
 *
 *   - donne a chacune des neuf lignes un `code` stable et un `libelle` lisible, pour qu'une
 *     estimation future puisse DIRE quelle ligne de bareme elle a utilisee ;
 *   - inscrit dans `commentaire` ce que la ligne ne dit pas : ni annee de reference, ni
 *     largeur de chaussee ;
 *   - rattache chaque revetement du referentiel a sa famille de cout, quand elle existe.
 *
 * CE QU'IL NE FAIT PAS, ET C'EST L'ESSENTIEL
 *
 * Il ne modifie AUCUN cout, ne renseigne NI `anneeReference` NI `largeurChausseeM`, et
 * n'approuve rien. Les neuf lignes restent en `source = standard_initial` et NON APPROUVEES.
 *
 * Personne ne sait pour quelle annee ni pour quelle largeur ces couts ont ete poses. Les
 * deviner serait inventer exactement la donnee que ce travail cherche a rendre verifiable —
 * et un prix de 3,5 milliards GNF au kilometre accompagne d'une largeur inventee serait plus
 * dangereux qu'un prix sans largeur, parce qu'il aurait l'air complet.
 *
 * TROIS REVETEMENTS N'ONT AUCUNE FAMILLE DE COUT, ET ON LES LAISSE AINSI
 *
 *   BETON_BITUMINEUX, ENDUIT_SUPERFICIEL  ->  bitume
 *   LATERITE, TERRE                       ->  terre_laterite
 *   PAVE                                  ->  pave
 *   BETON, AUTRE, NON_RENSEIGNE           ->  AUCUNE
 *
 * `BETON` est le beton de ciment : revetu mais non bitumineux, et aucun bareme ne le chiffre.
 * Le rattacher a `bitume` lui donnerait un prix qui n'est pas le sien. Un moteur de couts
 * devra donc REFUSER d'estimer une chaussee en beton — le meme refus que le RCI oppose a une
 * composante sans correspondance.
 *
 * IDEMPOTENT
 *
 * Une ligne qui porte deja un `code` est consideree comme administree et n'est pas touchee.
 * Un revetement dont la `familleCout` est deja renseignee non plus : si un gestionnaire a
 * rattache BETON a une famille, c'est sa decision et elle reste.
 *
 * RETOUR ARRIERE
 *
 *     update baremes_intervention set code = null, libelle = null, commentaire = null,
 *            ordre = 0 where source = 'standard_initial';
 *     update referentiel_revetements set "familleCout" = null;
 */
import { AuditAction, Role } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { logAuditTransactionnelle } from "../src/utils/audit";

/** Les trois familles que les baremes connaissent, et les revetements qui s'y rattachent. */
const FAMILLE_PAR_REVETEMENT: Readonly<Record<string, string>> = {
  BETON_BITUMINEUX: "bitume",
  ENDUIT_SUPERFICIEL: "bitume",
  LATERITE: "terre_laterite",
  TERRE: "terre_laterite",
  PAVE: "pave",
  // BETON, AUTRE et NON_RENSEIGNE sont volontairement absents. Voir l'en-tete.
};

const LIBELLE_FAMILLE: Readonly<Record<string, string>> = {
  bitume: "Bitume",
  terre_laterite: "Terre et latérite",
  pave: "Pavés",
};

const LIBELLE_ETAT: Readonly<Record<string, string>> = {
  BON: "bon état",
  MOYEN: "état moyen",
  MAUVAIS: "mauvais état",
  CRITIQUE: "état critique",
};

const LIBELLE_INTERVENTION: Readonly<Record<string, string>> = {
  entretien_periodique: "entretien périodique",
  rehabilitation: "réhabilitation",
  reconstruction: "reconstruction",
};

/** Ordre d'affichage : par famille, puis du moins au plus lourd. */
const POIDS_INTERVENTION: Readonly<Record<string, number>> = {
  entretien_periodique: 1, rehabilitation: 2, reconstruction: 3,
};
const POIDS_FAMILLE: Readonly<Record<string, number>> = {
  bitume: 1, terre_laterite: 2, pave: 3,
};

function lisible(dict: Readonly<Record<string, string>>, cle: string): string {
  return dict[cle] ?? cle;
}

const COMMENTAIRE_DEFAUT =
  "Valeur par défaut héritée du 06/07/2026, conservée telle quelle. ANNÉE DE RÉFÉRENCE ET "
  + "LARGEUR DE CHAUSSÉE INCONNUES : elles n'ont pas été inventées. À arrêter par AGEROUTE "
  + "avant que ce barème serve à une estimation publiable.";

async function main() {
  const auteur = await prisma.user.findFirst({
    where: { role: Role.ADMIN, actif: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true },
  });
  if (!auteur) throw new Error("Aucun compte ADMIN actif : impossible d'attribuer un auteur.");

  const baremes = await prisma.baremeIntervention.findMany({ orderBy: { id: "asc" } });
  let completes = 0;
  let intacts = 0;

  for (const b of baremes) {
    if (b.code) { intacts++; continue; }

    const code = `${b.familleRevetement}.${b.etatDepart}.${b.typeIntervention}`.toUpperCase();
    const libelle =
      `${lisible(LIBELLE_FAMILLE, b.familleRevetement)}, `
      + `${lisible(LIBELLE_ETAT, b.etatDepart)} — `
      + `${lisible(LIBELLE_INTERVENTION, b.typeIntervention)}`;
    const ordre = (POIDS_FAMILLE[b.familleRevetement] ?? 9) * 10
      + (POIDS_INTERVENTION[b.typeIntervention] ?? 9);

    await prisma.$transaction(async (tx) => {
      const maj = await tx.baremeIntervention.update({
        where: { id: b.id },
        data: { code, libelle, ordre, commentaire: COMMENTAIRE_DEFAUT },
      });
      await logAuditTransactionnelle(tx, {
        userId: auteur.id,
        action: AuditAction.UPDATE,
        entityType: "BaremeIntervention",
        entityId: String(maj.id),
        before: { code: null, libelle: null, ordre: b.ordre, commentaire: null },
        after: { code: maj.code, libelle: maj.libelle, ordre: maj.ordre },
      });
    });
    completes++;
  }

  const revetements = await prisma.referentielRevetement.findMany({ orderBy: { ordre: "asc" } });
  let rattaches = 0;
  let sansFamille = 0;
  let dejaAdministres = 0;

  for (const r of revetements) {
    if (r.familleCout !== null) { dejaAdministres++; continue; }
    const famille = FAMILLE_PAR_REVETEMENT[r.code];
    if (!famille) { sansFamille++; continue; }

    await prisma.$transaction(async (tx) => {
      const maj = await tx.referentielRevetement.update({
        where: { code: r.code },
        data: { familleCout: famille },
      });
      await logAuditTransactionnelle(tx, {
        userId: auteur.id,
        action: AuditAction.UPDATE,
        entityType: "ReferentielRevetement",
        entityId: maj.code,
        before: { familleCout: null },
        after: { familleCout: maj.familleCout },
      });
    });
    rattaches++;
  }

  const approuves = await prisma.baremeIntervention.count({ where: { approuveLe: { not: null } } });

  console.log(`Barèmes : ${completes} complétés, ${intacts} déjà administrés et inchangés.`);
  console.log(`Revêtements : ${rattaches} rattachés à une famille de coût,`);
  console.log(`  ${sansFamille} laissés SANS famille, ${dejaAdministres} déjà administrés.`);
  console.log("");
  console.log("AUCUN COÛT N'A ÉTÉ MODIFIÉ.");
  console.log(`Barèmes approuvés : ${approuves} sur ${baremes.length}.`);
  console.log("  Les neuf lignes restent en source = standard_initial et NON APPROUVÉES :");
  console.log("  un prix est une décision, et 3,5 milliards GNF au kilomètre doit être");
  console.log("  imputable à quelqu'un.");
  console.log("");
  console.log("NI ANNÉE DE RÉFÉRENCE NI LARGEUR DE CHAUSSÉE N'ONT ÉTÉ RENSEIGNÉES.");
  console.log("  Personne ne sait pour quelle année ni quelle largeur ces coûts ont été");
  console.log("  posés. Un prix accompagné d'une largeur inventée serait plus dangereux");
  console.log("  qu'un prix sans largeur, parce qu'il aurait l'air complet.");
  console.log("");
  console.log("BETON, AUTRE et NON_RENSEIGNE n'ont AUCUNE famille de coût.");
  console.log("  Le béton de ciment est revêtu mais non bitumineux, et aucun barème ne le");
  console.log("  chiffre. Un moteur de coûts devra REFUSER d'estimer, pas deviner.");
}

main()
  .catch((e) => { console.error("ECHEC :", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
