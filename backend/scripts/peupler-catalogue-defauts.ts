/**
 * Peuple le catalogue des types de defaut depuis le referentiel de reference
 * (`src/field/catalogue-defauts.referentiel.ts`) : les treize types du cahier des charges
 * RAI V3.1 (section 7.2) et les dix-huit que le paragraphe 7.4 du mandat V10 ajoute.
 * Idempotent : cree les types absents sans JAMAIS modifier une ligne deja administree.
 *
 * POURQUOI CE SCRIPT ET PAS UN SEED PRISMA NI UNE MIGRATION
 *
 * Le catalogue est une DONNEE METIER ADMINISTRABLE, pas une donnee d'infrastructure : le
 * cahier des charges exige qu'il soit administrable, et le champ `source` de chaque ligne dit
 * d'ou elle vient. Un seed Prisma se rejoue a chaque `prisma migrate reset` et reconstruirait
 * le catalogue en ecrasant ce que l'administration a retenu ; une migration ferait de meme a
 * chaque environnement neuf. Ce script, lui, NE MODIFIE JAMAIS une ligne existante : si un
 * gestionnaire a retire la profondeur des mesures obligatoires du NID_POULE, ou restreint
 * l'applicabilite d'un type, rejouer ce script laisse sa decision en place.
 *
 * LA LISTE N'EST PLUS ICI, ET C'EST VOULU
 *
 * Elle vit dans un module sans import, teste : nombre de types (>= 21, paragraphe 7.16),
 * revetu et non revetu representes, codes de production intacts, coherence unite / mesures.
 * Un script n'est pas teste ; un module l'est. Le script ne fait plus que l'ecriture.
 *
 * LES PARENTS : un type decline (drainage obstrue, stagnation...) cite son parent par CODE
 * dans le referentiel ; le script resout l'identifiant en base, que le parent soit cree par
 * ce passage ou deja present.
 *
 * RETOUR ARRIERE
 *
 *     delete from catalogue_defauts where source in ('cahier_des_charges_rai_v3_1_7_2', 'mandat_v10_7_4')
 *       and id not in (select "catalogueId" from defauts where "catalogueId" is not null);
 *
 * La garde sur les defauts existants est necessaire : supprimer une ligne referencee par un
 * defaut violerait la cle etrangere, et un defaut sans ligne de catalogue n'a plus ni unite
 * ni mesures requises.
 */
import type { FamilleDefaut, MesureDefaut, UniteDefaut } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { TYPES_DEFAUT } from "../src/field/catalogue-defauts.referentiel";

async function main() {
  let crees = 0;
  let dejaPresents = 0;
  const idsParCode = new Map<string, number>();

  // Les parents d'abord : le referentiel les liste avant leurs declinaisons, mais on ne s'y
  // fie pas -- deux passages, et le second resout les parents crees par le premier.
  const ordonnes = [...TYPES_DEFAUT].sort((a, b) => Number(!!a.parentCode) - Number(!!b.parentCode));

  for (const t of ordonnes) {
    const existante = await prisma.catalogueDefaut.findUnique({ where: { code: t.code } });
    if (existante) {
      // Une ligne existante est une donnee administree, meme si son libelle, son applicabilite
      // ou ses mesures different encore de la valeur proposee par le referentiel.
      idsParCode.set(t.code, existante.id);
      dejaPresents++;
      continue;
    }
    const parentId = t.parentCode ? idsParCode.get(t.parentCode) ?? null : null;
    if (t.parentCode && parentId === null) {
      throw new Error(`parent ${t.parentCode} introuvable pour ${t.code} : le referentiel est incoherent`);
    }
    const creee = await prisma.catalogueDefaut.create({
      data: {
        code: t.code,
        libelle: t.libelle,
        famille: t.famille as FamilleDefaut,
        unite: t.unite as UniteDefaut,
        mesuresRequises: t.mesuresRequises as MesureDefaut[],
        graviteMax: t.graviteMax,
        description: t.description,
        applicabilite: t.applicabilite,
        source: t.source,
        parentId,
      },
    });
    idsParCode.set(t.code, creee.id);
    crees++;
  }

  const total = await prisma.catalogueDefaut.count();
  console.log(`Catalogue des défauts : ${crees} créés, ${dejaPresents} déjà présents et inchangés, ${total} lignes au total (référentiel : ${TYPES_DEFAUT.length}).`);
}

main()
  .catch((e) => { console.error("ECHEC :", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
