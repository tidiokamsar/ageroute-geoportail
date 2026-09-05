/**
 * Rattacher les ouvrages a la region ou ils se trouvent.
 *
 * SANS `--apply`, LE SCRIPT NE FAIT QUE LIRE.
 *
 * POURQUOI IL EXISTE
 *
 * Le redecoupage du 05/09/2026 a cree les regions de Siguiri et de Beyla, et retaille
 * Kankan et Nzerekore d'autant. Les troncons ont suivi — 20 063 rattachements — mais
 * les ouvrages n'avaient pas d'equivalent : leur `regionId` avait ete pose une fois,
 * a l'import, contre les limites d'alors.
 *
 * Mesure apres le redecoupage : 124 ouvrages se trouvent geographiquement dans les
 * deux nouvelles regions tout en restant rattaches a Kankan ou Nzerekore. Un
 * redecoupage que les objets ne suivent pas ne redecoupe rien : le tableau de bord
 * continuerait de compter ces ouvrages dans l'ancienne region.
 *
 * CE QU'IL NE FAIT PAS
 *
 * Il ne touche pas aux ouvrages qui tombent hors de toute limite — mieux vaut un
 * rattachement date qu'une region devinee. Il ne touche pas non plus a ceux dont la
 * region est deja la bonne : `updatedAt` ne doit pas bouger sans raison.
 *
 * PROVENANCE
 *
 * Chaque rattachement ecrit une ligne de qualite marquee DERIVED, avec la region
 * PRECEDENTE dans la note. C'est ce qui permet de revenir en arriere, et c'est ce qui
 * distingue une region deduite d'une region saisie par un agent.
 *
 * Usage :
 *   tsx scripts/rattacher-ouvrages-region.ts            (lecture seule)
 *   tsx scripts/rattacher-ouvrages-region.ts --apply    (ecrit)
 */
import { PrismaClient } from "@prisma/client";
import "dotenv/config";

const prisma = new PrismaClient();

interface Ligne {
  id: string;
  nom: string;
  region_actuelle: string | null;
  region_geographique: string;
  region_id_cible: number;
}

async function main() {
  const appliquer = process.argv.includes("--apply");

  /**
   * Un ouvrage est un POINT : `ST_Intersects` avec un polygone suffit, et un point ne
   * peut pas tomber dans deux regions a la fois — les limites ne se recouvrent pas,
   * ce que le redecoupage a verifie. Pas besoin de departager par surface commune,
   * contrairement aux troncons qui sont des lignes et peuvent chevaucher.
   */
  const aChanger = await prisma.$queryRawUnsafe<Ligne[]>(`
    SELECT o.id, o.nom,
           ra.nom AS region_actuelle,
           la.nom AS region_geographique,
           rc.id  AS region_id_cible
      FROM ouvrages o
      JOIN limites_admin la
        ON la.niveau = 1 AND ST_Intersects(o.geom, la.geom)
      JOIN regions rc
        ON unaccent(lower(rc.nom)) = unaccent(lower(la.nom))
      LEFT JOIN regions ra ON ra.id = o."regionId"
     WHERE o."deletedAt" IS NULL AND o.geom IS NOT NULL
       AND (o."regionId" IS NULL OR o."regionId" <> rc.id)
     ORDER BY la.nom, o.nom
  `);

  const orphelins = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`
    SELECT count(*) AS n FROM ouvrages o
     WHERE o."deletedAt" IS NULL AND o.geom IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM limites_admin la
                        WHERE la.niveau = 1 AND ST_Intersects(o.geom, la.geom))
  `);

  const parRegion = new Map<string, { n: number; depuis: Map<string, number> }>();
  for (const l of aChanger) {
    const e = parRegion.get(l.region_geographique) ?? { n: 0, depuis: new Map() };
    e.n += 1;
    const d = l.region_actuelle ?? "(aucune)";
    e.depuis.set(d, (e.depuis.get(d) ?? 0) + 1);
    parRegion.set(l.region_geographique, e);
  }

  console.log("=== Rattachement des ouvrages a leur region ===");
  console.log(`Mode : ${appliquer ? "ECRITURE" : "LECTURE SEULE (ajouter --apply)"}`);
  console.log("");

  if (aChanger.length === 0) {
    console.log("Aucun ouvrage a rattacher : chacun est deja dans sa region.");
  } else {
    console.log(`${aChanger.length} ouvrages a rattacher :`);
    for (const [region, e] of [...parRegion].sort((a, b) => b[1].n - a[1].n)) {
      const origines = [...e.depuis].map(([d, n]) => `${n} depuis ${d}`).join(", ");
      console.log(`  ${region.padEnd(14)} ${String(e.n).padStart(4)}   (${origines})`);
    }
  }
  console.log("");
  console.log(`Ouvrages hors de toute limite : ${Number(orphelins[0].n)} — laisses tels quels.`);
  console.log("");

  if (!appliquer || aChanger.length === 0) {
    if (!appliquer) console.log("LECTURE SEULE — rien n'a ete ecrit.");
    return;
  }

  const maintenant = new Date();
  await prisma.$transaction(
    async (tx) => {
      for (const l of aChanger) {
        await tx.$executeRawUnsafe(
          `UPDATE ouvrages SET "regionId" = $2, "updatedAt" = now() WHERE id = $1`,
          l.id, l.region_id_cible,
        );
        // La region PRECEDENTE dans la note : c'est elle qui rend le retour arriere
        // possible, et sans elle la trace ne dirait pas ce qui a change.
        await tx.$executeRawUnsafe(
          `INSERT INTO valeurs_qualite
             (id, "entityType", "entityId", champ, statut, source, methode, "observedAt",
              confiance, note, "createdAt", "updatedAt")
           VALUES (gen_random_uuid()::text, 'Ouvrage', $1, 'regionId', 'DERIVED'::"StatutValeur",
                   'Decoupage 2026 + COD-AB / OCHA', 'INTERSECTION_GEOMETRIQUE', $2::timestamp,
                   'MEDIUM'::"NiveauConfiance", $3, now(), now())
           ON CONFLICT ("entityType", "entityId", champ) DO UPDATE
             SET statut = EXCLUDED.statut, source = EXCLUDED.source,
                 methode = EXCLUDED.methode, "observedAt" = EXCLUDED."observedAt",
                 note = EXCLUDED.note, "updatedAt" = now()`,
          l.id, maintenant,
          `Region deduite par intersection avec les limites de niveau 1 apres le `
          + `redecoupage de 2026. Region precedente : ${l.region_actuelle ?? "aucune"}.`,
        );
      }
    },
    { timeout: 300_000, maxWait: 60_000 },
  );

  // Recompter la table plutot que faire confiance a la boucle : c'est le seul
  // controle qui distingue « j'ai voulu ecrire » de « la base a ecrit ».
  const restants = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`
    SELECT count(*) AS n FROM ouvrages o
      JOIN limites_admin la ON la.niveau = 1 AND ST_Intersects(o.geom, la.geom)
      JOIN regions rc ON unaccent(lower(rc.nom)) = unaccent(lower(la.nom))
     WHERE o."deletedAt" IS NULL AND o.geom IS NOT NULL
       AND (o."regionId" IS NULL OR o."regionId" <> rc.id)
  `);

  console.log("--- Applique ---");
  console.log(`  ouvrages rattaches      : ${aChanger.length}`);
  console.log(`  restant a rattacher     : ${Number(restants[0].n)}  (0 attendu)`);
  console.log("");
  console.log("Retour arriere : la region precedente figure dans la note de");
  console.log("valeurs_qualite (champ 'regionId').");
}

main()
  .catch((e) => { console.error("ECHEC :", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
