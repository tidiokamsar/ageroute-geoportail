/**
 * Genere des PROPOSITIONS de localisation de chantiers depuis leurs intitules (T5).
 *
 * CE QUE LA MESURE A ETABLI, ET QUI COMMANDE CE SCRIPT
 *
 * L'extraction du texte fonctionne : sur les 36 intitules contenant une route et un
 * PK, elle rend 14 emprises et 19 rattachements a une route seule, et refuse les 3
 * intitules citant deux routes.
 *
 * Le RATTACHEMENT a un troncon, lui, ne fonctionne pas automatiquement. Mesure du
 * 02/09/2026 : sur les 14 emprises extraites, AUCUNE ne trouve un troncon couvrant
 * l'intervalle demande. Zero sur quatorze. Trois causes independantes :
 *
 *   1. Les emprises de chantier font 40 a 55 km, les troncons quelques kilometres.
 *      Chaque emprise chevauche 4 a 36 troncons : il n'y a pas de cible unique.
 *
 *   2. CORRIGE LE 05/09/2026 — cette cause etait mal lue. Les PK ne forment pas un
 *      kilometrage continu par ROUTE, mais ils en forment un par SECTION : les six
 *      troncons de la RN5 qui commencent a PK 0 sont six sections, pas six
 *      incoherences. Mesure : 88 sections sur 90 chainees sans trou ni recouvrement.
 *      « RN5 PK24 » ne designe pas un point unique parce que la SECTION manque a
 *      l'intitule — pas parce que la donnee serait abimee.
 *
 *   3. Certains PK tombent hors de l'etendue referencee : le chantier RN38
 *      PK94+300 -> PK135+100 vise une route dont le PK maximum en base est 61,6.
 *
 * CE QUE LA SECTION CHANGE
 *
 * Le script cherche d'abord les SECTIONS de la route dont l'etendue couvre l'emprise
 * demandee. Quand une seule y suffit, les candidats se restreignent a elle — et la
 * cible devient souvent unique.
 *
 * Mesure sur les 12 chantiers portant une designation et deux PK : 4 se resolvent a
 * une seule section, 5 a deux ou trois. Contre zero auparavant.
 *
 * CONSEQUENCE
 *
 * Ce script n'ecrit AUCUNE geometrie et ne pose AUCUN tronconId. Il enregistre ce que
 * l'intitule dit, la liste des troncons candidats, et laisse un agent trancher. C'est
 * exactement ce que demande le §18 du cahier des charges : ne pas geocoder
 * automatiquement a partir d'une reference ambigue.
 *
 * Une proposition n'est pas une localisation. `chantiers.geom` n'est ecrit qu'a la
 * validation, par l'API, jamais par ce script.
 *
 * Usage :
 *   tsx scripts/generer-propositions-localisation.ts            # a blanc
 *   tsx scripts/generer-propositions-localisation.ts --apply    # ecrit les propositions
 */
import { PrismaClient } from "@prisma/client";
import { extraireReference } from "../src/lib/extraction-pk";

const prisma = new PrismaClient();
const APPLIQUER = process.argv.includes("--apply");

interface Candidat {
  id: string;
  code: string;
  pkDebut: number;
  pkFin: number;
}

async function main() {
  // Seuls les chantiers sans geometrie : les 6 qui en ont une n'ont rien a proposer.
  const chantiers = await prisma.$queryRaw<{ id: string; intitule: string }[]>`
    SELECT id, intitule FROM chantiers
    WHERE "deletedAt" IS NULL AND geom IS NULL
    ORDER BY intitule
  `;

  const stats = {
    emprise: 0, routeSeule: 0, refus: 0, sansRoute: 0,
    // La section est le vrai gain, et il faut le compter pour ce qu'il est : elle
    // designe QUELLE PARTIE de la route, pas un troncon. Une emprise de 42 km ne
    // tiendra jamais dans un troncon de 13,5 km — attendre une cible unique etait
    // une erreur de lecture. Ce que la section supprime, c'est l'ambiguite sur le
    // kilometrage, pas l'ecart d'echelle.
    sectionUnique: 0, sectionsMultiples: 0, aucuneSection: 0,
  };
  const aEcrire: {
    chantierId: string;
    methode: string;
    sourceTexte: string;
    confiance: "HIGH" | "MEDIUM" | "LOW";
    tronconId: string | null;
    pkDebut: number | null;
    pkFin: number | null;
    longueurCiteeKm: number | null;
    motif: string;
    sectionPk: string | null;
    candidats: number;
  }[] = [];

  for (const c of chantiers) {
    const r = extraireReference(c.intitule);

    if (!r.methode) {
      if (r.routesCitees.length > 1) stats.refus++;
      else stats.sansRoute++;
      continue;
    }

    // Troncons candidats : ceux de la meme route dont l'intervalle PK chevauche celui
    // demande. On ne retient un troncon precis QUE s'il est seul a couvrir toute
    // l'emprise — cas qui ne se presente sur aucun des 14 intitules mesures, mais que
    // le script doit savoir traiter si la donnee s'ameliore.
    let tronconId: string | null = null;
    let candidats: Candidat[] = [];
    let sectionRetenue: string | null = null;
    let sectionsCandidates = 0;

    if (r.route) {
      // Les PK etant relatifs a la section, chercher sur toute la route revient a
      // comparer des kilometrages qui ne se suivent pas. On identifie donc d'abord
      // les sections dont l'etendue couvre l'emprise demandee.
      if (r.pkDebut != null && r.pkFin != null) {
        const sections = await prisma.$queryRaw<{ section: string }[]>`
          SELECT "sectionPk" AS section
          FROM troncons
          WHERE "deletedAt" IS NULL AND nom = ${r.route}
            AND "sectionPk" IS NOT NULL AND "pkFin" > "pkDebut"
          GROUP BY "sectionPk"
          HAVING min("pkDebut") <= ${r.pkDebut}::float8 AND max("pkFin") >= ${r.pkFin}::float8
        `;
        sectionsCandidates = sections.length;
        // Une seule section compatible : c'est elle. Plusieurs, on ne tranche pas —
        // l'intitule ne porte pas la section, et deviner rattacherait le chantier au
        // mauvais endroit de la route sans que personne ne s'en apercoive.
        if (sections.length === 1) sectionRetenue = sections[0].section;
      }

      candidats = await prisma.$queryRaw<Candidat[]>`
        SELECT id, code, "pkDebut", "pkFin"
        FROM troncons
        WHERE "deletedAt" IS NULL AND nom = ${r.route} AND "pkFin" > "pkDebut"
          AND (${sectionRetenue}::text IS NULL OR "sectionPk" = ${sectionRetenue}::text)
          AND (${r.pkDebut}::float8 IS NULL OR ("pkFin" > ${r.pkDebut}::float8 AND "pkDebut" < ${r.pkFin}::float8))
        ORDER BY "pkDebut"
      `;

      if (r.pkDebut != null && r.pkFin != null) {
        const couvrants = candidats.filter((t) => t.pkDebut <= r.pkDebut! && t.pkFin >= r.pkFin!);
        if (couvrants.length === 1) tronconId = couvrants[0].id;
      }
    }

    // Sans troncon unique, la confiance ne peut pas rester haute quoi qu'en dise
    // l'extraction du texte : le texte est clair, la cible ne l'est pas.
    const confiance = tronconId ? r.confiance! : "LOW";
    const section = sectionRetenue
      ? ` — section ${sectionRetenue} identifiée`
      : sectionsCandidates > 1
        ? ` — ${sectionsCandidates} sections compatibles, l'intitulé ne dit pas laquelle`
        : "";
    const motif = tronconId
      ? `${r.motif}${section}`
      : `${r.motif}${section} — ${candidats.length} tronçon(s) candidat(s), aucun ne couvre l'emprise à lui seul`;

    if (r.methode === "INTITULE_ROUTE_PK") {
      stats.emprise++;
      if (sectionRetenue) stats.sectionUnique++;
      else if (sectionsCandidates > 1) stats.sectionsMultiples++;
      else stats.aucuneSection++;
    } else stats.routeSeule++;

    aEcrire.push({
      chantierId: c.id,
      methode: r.methode,
      sourceTexte: c.intitule,
      confiance,
      sectionPk: sectionRetenue,
      tronconId,
      pkDebut: r.pkDebut,
      pkFin: r.pkFin,
      longueurCiteeKm: r.longueurCiteeKm,
      motif,
      candidats: candidats.length,
    });
  }

  console.log(`${chantiers.length} chantiers sans géométrie examinés`);
  console.log(APPLIQUER ? "MODE ECRITURE" : "MODE A BLANC — aucune ecriture");
  console.log("");
  console.log(`  emprise extraite (route + 2 PK)     ${stats.emprise}`);
  console.log(`  rattachement a une route seule      ${stats.routeSeule}`);
  console.log(`  refuses (plusieurs routes citees)   ${stats.refus}`);
  console.log(`  sans route citee                    ${stats.sansRoute}`);
  console.log("");
  const avecTroncon = aEcrire.filter((p) => p.tronconId).length;
  console.log("");
  console.log("  Sur les emprises (route + 2 PK), ce que la section apporte :");
  console.log(`    section unique identifiee          ${stats.sectionUnique}`);
  console.log(`    plusieurs sections compatibles     ${stats.sectionsMultiples}`);
  console.log(`    aucune section ne couvre l'emprise ${stats.aucuneSection}`);
  console.log("");
  console.log(`  propositions rattachees a UN troncon ${avecTroncon}`);
  console.log(`  propositions a trancher par un agent ${aEcrire.length - avecTroncon}`);
  console.log("");
  console.log("AUCUNE geometrie n'est ecrite par ce script.");
  console.log("");

  if (!APPLIQUER) {
    console.log("Relancer avec --apply pour enregistrer les propositions.");
    return;
  }

  // Les propositions deja tranchees ne sont pas ecrasees : la decision d'un agent
  // prime sur une regeneration.
  const dejaDecides = new Set(
    (
      await prisma.propositionLocalisation.findMany({
        where: { statut: { in: ["VALIDATED", "REJECTED"] } },
        select: { chantierId: true },
      })
    ).map((p) => p.chantierId)
  );

  let ecrites = 0;
  for (const p of aEcrire) {
    if (dejaDecides.has(p.chantierId)) continue;
    await prisma.propositionLocalisation.deleteMany({
      where: { chantierId: p.chantierId, statut: "PROPOSED" },
    });
    await prisma.propositionLocalisation.create({
      data: {
        chantierId: p.chantierId,
        statut: "PROPOSED",
        methode: p.methode,
        sourceTexte: p.sourceTexte,
        confiance: p.confiance,
        tronconId: p.tronconId,
        pkDebut: p.pkDebut,
        pkFin: p.pkFin,
        longueurCiteeKm: p.longueurCiteeKm,
        // Le motif etait calcule puis jete : l'agent voyait une confiance LOW sans
        // savoir pourquoi, ni ce qui restait a trancher.
        motif: p.motif,
        sectionPk: p.sectionPk,
        motifRejet: null,
      },
    });
    ecrites++;
  }

  console.log(`${ecrites} propositions enregistrees, ${dejaDecides.size} deja tranchees et laissees intactes.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
