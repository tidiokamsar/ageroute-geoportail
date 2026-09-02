/**
 * Recalcule le niveau de localisation des chantiers (T6).
 *
 * `statutLocalisation` est une valeur DERIVEE : elle se deduit entierement de la
 * geometrie, du troncon, des PK et de la region. Elle n'est jamais saisie a la main,
 * et ce script la remet en coherence apres un import ou une correction.
 *
 * Il ne modifie AUCUNE des donnees dont il derive : ni geometrie, ni troncon, ni PK,
 * ni region. Il ne fait que classer.
 *
 * Usage :
 *   tsx scripts/reclasser-localisation.ts            # a blanc
 *   tsx scripts/reclasser-localisation.ts --apply    # ecrit
 */
import { PrismaClient } from "@prisma/client";
import { localisationDe } from "../src/lib/localisation";

const prisma = new PrismaClient();
const APPLIQUER = process.argv.includes("--apply");

interface LigneChantier {
  id: string;
  tronconId: string | null;
  pkDebut: number | null;
  pkFin: number | null;
  region: string | null;
  aGeometrie: boolean;
  statutActuel: string;
}

async function main() {
  // La geometrie passe par SQL brut : Prisma ne sait pas lire une colonne geometry.
  const chantiers = await prisma.$queryRaw<LigneChantier[]>`
    SELECT c.id, c."tronconId", c."pkDebut", c."pkFin", r.nom AS region,
           (c.geom IS NOT NULL) AS "aGeometrie",
           c."statutLocalisation"::text AS "statutActuel"
    FROM chantiers c
    LEFT JOIN regions r ON r.id = c."regionId"
    WHERE c."deletedAt" IS NULL
  `;

  const parStatut = new Map<string, { total: number; aEcrire: number }>();
  const aEcrire: { id: string; statut: string }[] = [];

  for (const c of chantiers) {
    const loc = localisationDe({
      aGeometrie: c.aGeometrie,
      tronconId: c.tronconId,
      pkDebut: c.pkDebut,
      pkFin: c.pkFin,
      regionNom: c.region,
    });
    const s = parStatut.get(loc.statut) ?? { total: 0, aEcrire: 0 };
    s.total++;
    if (c.statutActuel !== loc.statut) {
      s.aEcrire++;
      aEcrire.push({ id: c.id, statut: loc.statut });
    }
    parStatut.set(loc.statut, s);
  }

  console.log(`${chantiers.length} chantiers examines`);
  console.log(APPLIQUER ? "MODE ECRITURE" : "MODE A BLANC — aucune ecriture");
  console.log("");
  console.log("niveau".padEnd(18) + "chantiers".padStart(11) + "a ecrire".padStart(11));
  console.log("-".repeat(40));
  for (const [statut, s] of [...parStatut].sort((a, b) => b[1].total - a[1].total)) {
    console.log(statut.padEnd(18) + String(s.total).padStart(11) + String(s.aEcrire).padStart(11));
  }
  console.log("-".repeat(40));

  const horsCarte = parStatut.get("NONE")?.total ?? 0;
  console.log(`chantiers retires de la carte : ${horsCarte}`);
  console.log("");

  if (!APPLIQUER) {
    console.log("Relancer avec --apply pour ecrire.");
    return;
  }
  if (aEcrire.length === 0) {
    console.log("Rien a ecrire : les niveaux sont deja a jour.");
    return;
  }

  // Groupe par statut : quatre requetes au lieu de 488.
  const parValeur = new Map<string, string[]>();
  for (const e of aEcrire) {
    parValeur.set(e.statut, [...(parValeur.get(e.statut) ?? []), e.id]);
  }
  for (const [statut, ids] of parValeur) {
    await prisma.chantier.updateMany({
      where: { id: { in: ids } },
      data: { statutLocalisation: statut as never },
    });
    console.log(`  ${statut} : ${ids.length}`);
  }
  console.log("");
  console.log(`${aEcrire.length} chantiers reclasses. Aucune donnee source modifiee.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
