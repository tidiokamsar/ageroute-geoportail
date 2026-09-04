/**
 * Extraire la section de referencement kilometrique depuis le code du troncon.
 *
 * SANS `--apply`, LE SCRIPT NE FAIT QUE LIRE.
 *
 * CE QUE CETTE EXTRACTION CORRIGE
 *
 * Le referencement PK etait tenu pour inexploitable. BDRI-CHANTIERS-GEOLOCALISATION.md
 * l'ecrit : « sur la RN5, six troncons commencent a PK 0 ; la somme des intervalles
 * vaut 433 km pour un PK maximum de 156 », et « sur les 14 emprises extraites, zero
 * trouve un troncon qui la couvre ».
 *
 * La mesure du 05/09/2026 dit autre chose. Les PK ne sont pas globaux sur l'axe : ils
 * sont RELATIFS A UNE SECTION, et chaque section repart de zero. A l'interieur d'une
 * section, ils s'enchainent parfaitement — 88 sections sur 90 sans trou ni
 * recouvrement a moins de 500 m, soit 549 troncons sur 551.
 *
 * Le referencement n'etait pas casse : la cle qui le rend lisible n'etait declaree
 * nulle part. Elle etait pourtant dans le code depuis le debut.
 *
 * LE FORMAT, ET SON PIEGE
 *
 *     GN N0001 3-1216   ->  route 0001, section 3
 *     GN N000110-1042   ->  route 0001, section 10   (l'espace manque)
 *
 * L'espace avant la section est inconstant. Le decoupage par espaces echoue donc sur
 * les sections a deux chiffres — et les fait disparaitre silencieusement, ce qui est
 * pire qu'une erreur. On retire l'espace avant de lire.
 *
 * POURQUOI DERIVED ET NON OBSERVED
 *
 * La section est LUE dans une chaine, pas saisie ni relevee. C'est une inference sur
 * une convention de codage — solide, verifiee sur 549 troncons, mais une inference.
 * Si un jour un code deroge a la convention, la trace dira d'ou venait la valeur.
 *
 * Usage :
 *   tsx scripts/extraire-section-pk.ts            (lecture seule)
 *   tsx scripts/extraire-section-pk.ts --apply    (ecrit)
 */
import { PrismaClient } from "@prisma/client";
import "dotenv/config";

const prisma = new PrismaClient();

/**
 * Lit la section dans un code « GN N#### <section>[-<id>] ».
 *
 * Rend null plutot que de deviner : un code hors convention ne doit pas recevoir une
 * section approximative, il doit rester sans section et se voir.
 */
export function sectionDuCode(code: string): string | null {
  if (!code.startsWith("GN N")) return null;
  // L'espace avant la section manque parfois ; on l'enleve partout avant de lire.
  const reste = code.slice(4).replace(/ /g, "");
  const m = reste.match(/^\d{4}(\d+)/);
  return m ? String(Number(m[1])) : null;
}

async function main() {
  const appliquer = process.argv.includes("--apply");

  const troncons = await prisma.troncon.findMany({
    where: { deletedAt: null, code: { startsWith: "GN N" } },
    select: { id: true, code: true, nom: true, sectionPk: true, pkDebut: true, pkFin: true },
  });

  const lus = troncons
    .map((t) => ({ ...t, section: sectionDuCode(t.code) }))
    .filter((t) => t.section !== null);
  const sansSection = troncons.length - lus.length;
  const aEcrire = lus.filter((t) => t.sectionPk !== t.section);

  console.log("=== Extraction de la section de référencement ===");
  console.log(`Mode : ${appliquer ? "ECRITURE" : "LECTURE SEULE (ajouter --apply)"}`);
  console.log("");
  console.log(`Troncons au format « GN N… » : ${troncons.length}`);
  console.log(`  section lisible            : ${lus.length}`);
  console.log(`  code hors convention       : ${sansSection}`);
  console.log(`  a ecrire                   : ${aEcrire.length}`);
  console.log("");

  // Repartition, pour que le resultat se verifie d'un coup d'oeil.
  const parRoute = new Map<string, Set<string>>();
  for (const t of lus) {
    if (!parRoute.has(t.nom)) parRoute.set(t.nom, new Set());
    parRoute.get(t.nom)!.add(t.section!);
  }
  const top = [...parRoute.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 8);
  console.log("Sections par désignation (les huit plus découpées) :");
  for (const [nom, sections] of top) {
    console.log(`  ${nom.padEnd(6)} ${String(sections.size).padStart(2)} sections`);
  }
  console.log("");

  if (aEcrire.length === 0) {
    console.log("Rien a ecrire.");
    return;
  }
  if (!appliquer) {
    console.log("LECTURE SEULE — rien n'a ete ecrit.");
    return;
  }

  const maintenant = new Date();
  const note =
    "Section lue dans le code du tronçon (« GN N0001 3-1216 » → section 3). "
    + "Les PK ne sont pas globaux sur l'axe : chaque section repart de zéro. "
    + "Inférence sur une convention de codage, vérifiée sur 549 tronçons — pas une saisie.";

  let ecrits = 0;
  // Par lots : une transaction unique sur 551 mises a jour tiendrait un verrou long
  // sur `troncons` pendant que l'application sert la carte.
  for (let i = 0; i < aEcrire.length; i += 100) {
    const lot = aEcrire.slice(i, i + 100);
    await prisma.$transaction([
      ...lot.map((t) =>
        prisma.troncon.update({ where: { id: t.id }, data: { sectionPk: t.section } }),
      ),
      ...lot.map((t) =>
        prisma.valeurQualite.upsert({
          where: { entityType_entityId_champ: { entityType: "Troncon", entityId: t.id, champ: "sectionPk" } },
          create: {
            entityType: "Troncon", entityId: t.id, champ: "sectionPk",
            statut: "DERIVED", source: "CODE_TRONCON", methode: "LECTURE_CONVENTION",
            observedAt: maintenant, confiance: "MEDIUM", note,
          },
          update: {
            statut: "DERIVED", source: "CODE_TRONCON", methode: "LECTURE_CONVENTION",
            observedAt: maintenant, confiance: "MEDIUM", note,
          },
        }),
      ),
    ]);
    ecrits += lot.length;
  }

  console.log("--- Applique ---");
  console.log(`  troncons renseignes     : ${ecrits}`);
  console.log(`  lignes valeurs_qualite  : ${ecrits}`);
  console.log("");
  console.log("Retour arriere :");
  console.log(`  update troncons set "sectionPk" = null;`);
  console.log(`  delete from valeurs_qualite where "entityType"='Troncon' and champ='sectionPk';`);
}

if (process.argv[1]?.includes("extraire-section-pk")) {
  main()
    .catch((e) => { console.error("ECHEC :", e instanceof Error ? e.message : e); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
