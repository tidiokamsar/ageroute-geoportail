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
 *   2. Les PK ne forment pas un kilometrage continu par route. Sur la RN5, six
 *      troncons commencent a PK 0, et la somme des intervalles vaut 433 km pour un
 *      PK maximum de 156. 24 designations de route sur 42 ont des PK de depart
 *      dupliques. « RN5 PK24 » ne designe donc pas un point unique.
 *
 *   3. Certains PK tombent hors de l'etendue referencee : le chantier RN38
 *      PK94+300 -> PK135+100 vise une route dont le PK maximum en base est 61,6.
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

  const stats = { emprise: 0, routeSeule: 0, refus: 0, sansRoute: 0 };
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

    if (r.route) {
      candidats = await prisma.$queryRaw<Candidat[]>`
        SELECT id, code, "pkDebut", "pkFin"
        FROM troncons
        WHERE "deletedAt" IS NULL AND nom = ${r.route} AND "pkFin" > "pkDebut"
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
    const motif = tronconId
      ? r.motif
      : `${r.motif} — ${candidats.length} tronçon(s) candidat(s), aucun ne couvre l'emprise à lui seul`;

    if (r.methode === "INTITULE_ROUTE_PK") stats.emprise++;
    else stats.routeSeule++;

    aEcrire.push({
      chantierId: c.id,
      methode: r.methode,
      sourceTexte: c.intitule,
      confiance,
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
