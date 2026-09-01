/**
 * Les segments de tronçons RN issus de la fusion OSM (merge-osm-routes.ts, code
 * contenant "-OSM-") n'ont pas d'evaluation d'etat propre (la source OSM ne porte
 * pas cette information). Ils font neanmoins partie de la MEME route physique que
 * les autres segments deja evalues sous le meme nom (ex: tous les "RN4") : on leur
 * attribue donc l'etat le plus frequent (mode) parmi les segments deja evalues de
 * cette route - une inference raisonnable de continuite, pas une estimation au hasard.
 *
 * Usage : tsx scripts/propagate-etat-rn-osm.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const targets = await prisma.troncon.findMany({
    where: { classe: "RN", etat: "NON_EVALUE", code: { contains: "-OSM-" }, deletedAt: null },
    select: { id: true, nom: true, code: true },
  });
  console.log(`Segments a completer : ${targets.length}`);

  const byNom = new Map<string, typeof targets>();
  for (const t of targets) {
    if (!byNom.has(t.nom)) byNom.set(t.nom, []);
    byNom.get(t.nom)!.push(t);
  }

  let updated = 0;
  const skipped: string[] = [];

  for (const [nom, segs] of byNom) {
    const siblings = await prisma.troncon.findMany({
      where: { nom, etat: { not: "NON_EVALUE" }, deletedAt: null },
      select: { etat: true },
    });
    if (siblings.length === 0) {
      skipped.push(nom);
      continue;
    }
    const counts: Record<string, number> = {};
    for (const s of siblings) counts[s.etat] = (counts[s.etat] || 0) + 1;
    const mode = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];

    for (const seg of segs) {
      await prisma.troncon.update({ where: { id: seg.id }, data: { etat: mode as never } });
      updated++;
    }
    console.log(`  ${nom} : ${segs.length} segment(s) -> ${mode} (deduit de ${siblings.length} segment(s) connu(s))`);
  }

  console.log(`\nTotal mis a jour : ${updated}`);
  if (skipped.length) console.log(`Routes sans aucun segment evalue (ignorees) : ${skipped.join(", ")}`);
}

main()
  .catch((err) => {
    console.error("Erreur :", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
