/**
 * Rattacher les troncons a leur region par intersection geometrique.
 *
 * SANS `--apply`, LE SCRIPT NE FAIT QUE LIRE.
 *
 * CE QUE LA MESURE A ETABLI AVANT D'ECRIRE
 *
 * Rattacher par la geometrie ecrase une region SAISIE par un humain. Avant de le
 * faire, il fallait savoir ce qu'on remplacait. Mesure du 05/09/2026 sur les 1 690
 * troncons du reseau classe :
 *
 *     1 511 concordent avec la geometrie
 *       160 ont 0 % de leur longueur dans la region saisie, et ne traversent
 *           qu'UNE region : ils sont entierement ailleurs
 *         3 en ont moins de 20 %
 *         9 sont a cheval entre deux regions (20 a 50 %)
 *
 * Les desaccords opposaient tous des regions voisines, ce qui suggerait des routes
 * frontalieres. C'etait faux : 160 sur 172 sont des erreurs de saisie franches. Le
 * rattachement geometrique ne detruit donc pas de l'information, il en corrige.
 *
 * Restent 9 troncons reellement a cheval. Pour eux, la region DOMINANTE — celle ou
 * tombe la plus grande part du trace — est un choix defendable, pas une verite. La
 * valeur precedente est conservee dans la trace, avec la part exacte.
 *
 * LE DECOUPAGE UTILISE EST CELUI DE 2016
 *
 * Les limites COD-AB ignorent Siguiri et Beyla, devenues regions le 20 aout 2026. Les
 * troncons qui s'y trouvent tombent donc dans Kankan et Nzerekore. C'est un choix
 * assume : mieux vaut la region d'un decoupage date et coherent qu'une region
 * inventee. Quand des limites posterieures a la reforme seront publiees, il suffira de
 * rejouer ce script.
 *
 * Usage :
 *   tsx scripts/rattacher-troncons-region.ts            (lecture seule)
 *   tsx scripts/rattacher-troncons-region.ts --apply    (ecrit)
 */
import { PrismaClient } from "@prisma/client";
import "dotenv/config";

const prisma = new PrismaClient();

interface Bilan {
  region_nom: string;
  region_id: number;
  a_changer: bigint;
  inchanges: bigint;
}

async function main() {
  const appliquer = process.argv.includes("--apply");

  const niveau1 = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*) AS n FROM limites_admin WHERE niveau = 1`,
  );
  if (Number(niveau1[0].n) === 0) {
    throw new Error("Aucune limite de niveau 1 en base. Lancer d'abord importer-limites-admin.ts.");
  }

  // La region DOMINANTE : celle ou tombe la plus grande part du trace. Un troncon qui
  // traverse une limite appartient a plusieurs regions ; il faut bien en choisir une,
  // et la plus longue portion est le seul critere qui ne depende pas de l'ordre des
  // lignes.
  const bilan = await prisma.$queryRawUnsafe<Bilan[]>(`
    WITH dominante AS (
      SELECT DISTINCT ON (t.id) t.id, t."regionId" AS actuelle, l.nom AS ocha
        FROM troncons t
        JOIN limites_admin l ON l.niveau = 1 AND ST_Intersects(t.geom, l.geom)
       WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL
       ORDER BY t.id, ST_Length(ST_Intersection(t.geom, l.geom)::geography) DESC
    )
    SELECT r.nom AS region_nom, r.id AS region_id,
           count(*) FILTER (WHERE d.actuelle IS DISTINCT FROM r.id) AS a_changer,
           count(*) FILTER (WHERE d.actuelle = r.id)                AS inchanges
      FROM dominante d
      JOIN regions r ON unaccent(lower(r.nom)) = unaccent(lower(d.ocha))
     GROUP BY r.nom, r.id
     ORDER BY 3 DESC
  `);

  const aChanger = bilan.reduce((s, b) => s + Number(b.a_changer), 0);
  const inchanges = bilan.reduce((s, b) => s + Number(b.inchanges), 0);

  const orphelins = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`
    SELECT count(*) AS n FROM troncons t
     WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM limites_admin l WHERE l.niveau = 1 AND ST_Intersects(t.geom, l.geom)
       )
  `);

  console.log("=== Rattachement des troncons a leur region ===");
  console.log(`Mode : ${appliquer ? "ECRITURE" : "LECTURE SEULE (ajouter --apply)"}`);
  console.log("");
  console.log("Region              a changer    inchanges");
  for (const b of bilan) {
    console.log(
      `  ${b.region_nom.padEnd(16)} ${String(Number(b.a_changer)).padStart(9)} ` +
      `${String(Number(b.inchanges)).padStart(12)}`,
    );
  }
  console.log(`  ${"TOTAL".padEnd(16)} ${String(aChanger).padStart(9)} ${String(inchanges).padStart(12)}`);
  console.log("");
  console.log(`Troncons hors de toute limite : ${Number(orphelins[0].n)} — laisses tels quels.`);
  console.log("");
  console.log("Le decoupage utilise est celui de 2016 : Siguiri et Beyla n'y sont pas,");
  console.log("leurs troncons tombent dans Kankan et Nzerekore.");
  console.log("");

  if (!appliquer || aChanger === 0) {
    console.log(appliquer ? "Rien a changer." : "LECTURE SEULE — rien n'a ete ecrit.");
    return;
  }

  const maintenant = new Date();
  let ecrits = 0;

  // Region par region : chaque transaction reste bornee, et un echec n'annule que la
  // region en cours. Sur 261 386 troncons, un bloc unique tiendrait un verrou long
  // pendant que l'application sert la carte.
  for (const b of bilan) {
    if (Number(b.a_changer) === 0) continue;

    const modifies = await prisma.$queryRawUnsafe<{ id: string; ancienne: string | null; part: number }[]>(`
      WITH dominante AS (
        SELECT DISTINCT ON (t.id) t.id, t."regionId" AS actuelle, l.nom AS ocha,
               ST_Length(ST_Intersection(t.geom, l.geom)::geography)
                 / NULLIF(ST_Length(t.geom::geography), 0) AS part
          FROM troncons t
          JOIN limites_admin l ON l.niveau = 1 AND ST_Intersects(t.geom, l.geom)
         WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL
         ORDER BY t.id, ST_Length(ST_Intersection(t.geom, l.geom)::geography) DESC
      )
      SELECT d.id, ra.nom AS ancienne, d.part
        FROM dominante d
        JOIN regions r ON unaccent(lower(r.nom)) = unaccent(lower(d.ocha))
        LEFT JOIN regions ra ON ra.id = d.actuelle
       WHERE r.id = $1 AND d.actuelle IS DISTINCT FROM r.id
    `, b.region_id);

    for (let i = 0; i < modifies.length; i += 500) {
      const lot = modifies.slice(i, i + 500);
      await prisma.$transaction([
        prisma.$executeRawUnsafe(
          `UPDATE troncons SET "regionId" = $2, "updatedAt" = now() WHERE id = ANY($1::text[])`,
          lot.map((m) => m.id), b.region_id,
        ),
        ...lot.map((m) =>
          prisma.valeurQualite.upsert({
            where: { entityType_entityId_champ: { entityType: "Troncon", entityId: m.id, champ: "regionId" } },
            create: {
              entityType: "Troncon", entityId: m.id, champ: "regionId",
              statut: "DERIVED", source: "COD-AB / OCHA (limites 2016)",
              methode: "INTERSECTION_GEOMETRIQUE", observedAt: maintenant, confiance: "MEDIUM",
              note: noteDe(m.ancienne, b.region_nom, m.part),
            },
            update: {
              statut: "DERIVED", source: "COD-AB / OCHA (limites 2016)",
              methode: "INTERSECTION_GEOMETRIQUE", observedAt: maintenant, confiance: "MEDIUM",
              note: noteDe(m.ancienne, b.region_nom, m.part),
            },
          }),
        ),
      ], { timeout: 300_000, maxWait: 60_000 });
      ecrits += lot.length;
    }
    console.log(`  ${b.region_nom.padEnd(16)} ${String(modifies.length).padStart(7)} rattaches`);
  }

  console.log("");
  console.log("--- Applique ---");
  console.log(`  troncons rattaches      : ${ecrits}`);
  console.log(`  lignes valeurs_qualite  : ${ecrits}`);
  console.log("");
  console.log("Retour arriere : les regions precedentes figurent dans les notes de");
  console.log("valeurs_qualite (champ 'regionId', methode 'INTERSECTION_GEOMETRIQUE').");
}

/** La note conserve l'ancienne region ET la part de trace : c'est ce qui permet de juger. */
function noteDe(ancienne: string | null, nouvelle: string, part: number | null): string {
  const pct = part == null ? "?" : Math.round(part * 100);
  const base =
    `Région déduite par intersection avec les limites COD-AB (OCHA, géométries 2016). `
    + `${pct} % du tracé tombe dans ${nouvelle}.`;
  if (!ancienne) return `${base} Aucune région n'était renseignée auparavant.`;
  if (ancienne === "Non renseigné") return `${base} Auparavant « Non renseigné ».`;
  return `${base} Valeur précédente : ${ancienne} — remplacée car le tracé n'y tombe pas majoritairement.`;
}

main()
  .catch((e) => { console.error("ECHEC :", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
