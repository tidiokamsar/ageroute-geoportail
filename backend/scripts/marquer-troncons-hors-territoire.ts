/**
 * Sortir du reseau classe les troncons situes hors du territoire guineen.
 *
 * SANS `--apply`, LE SCRIPT NE FAIT QUE LIRE.
 *
 * CE QUI A ETE CONSTATE
 *
 * Mesure du 07/10/2026 : 7 troncons du reseau classe ne rencontrent AUCUNE limite
 * administrative guineenne de niveau 1. Six portent le nom « RN4 » et se trouvent vers
 * Gabou, a plus de 200 km au nord-ouest de la region de Kindia ou ils sont declares —
 * vraisemblablement la N4 bissau-guineenne, reprise d'une source cartographique. Le
 * septieme, un « RN1 » de 13 km, est au nord de la frontiere.
 *
 * Deux choses rendaient ce constat serieux. Leur `sourceReference` etait NUL, donc rien
 * ne les distinguait de la donnee validee par AGEROUTE. Et leurs 72,0 km entraient dans
 * les 21 157 publies sur carte.ageroute.gov.gn : le registre routier national
 * comptabilisait des routes d'un autre pays.
 *
 * CE QUE FAIT CE SCRIPT, ET CE QU'IL NE FAIT PAS
 *
 * Il MARQUE, il ne supprime pas. `sourceReference` recoit le prefixe
 * `hors_territoire:`, qui appartient a la liste `PREFIXES_HORS_RESEAU_CLASSE` de
 * lib/reseau.ts : les troncons sortent donc des indicateurs, des exports et de la carte
 * publique, tout en restant en base, consultables et reversibles.
 *
 * C'est l'option retenue par l'agence : ni suppression logique, ni statu quo. Une
 * agence routiere peut legitimement suivre la continuation transfrontaliere d'un axe ;
 * ce qui n'est pas acceptable, c'est qu'elle la compte dans son lineaire national sans
 * le dire.
 *
 * LE CRITERE EST GEOMETRIQUE, PAS TOPONYMIQUE
 *
 * On ne filtre pas sur le nom « RN4 » : `RN4-OSM-0` est au contraire bien en Guinee
 * (9,705 / -13,386). La serie d'import est melangee, et juger sur le nom aurait ecarte
 * un troncon legitime tout en en laissant passer d'autres. Le test est l'absence
 * d'intersection avec les limites officielles, et rien d'autre.
 *
 * Usage :
 *   tsx scripts/marquer-troncons-hors-territoire.ts            (lecture seule)
 *   tsx scripts/marquer-troncons-hors-territoire.ts --apply    (ecrit)
 */
import { PrismaClient } from "@prisma/client";
import { clauseSqlReseauClasse } from "../src/lib/reseau";
import "dotenv/config";

const prisma = new PrismaClient();

const PREFIXE = "hors_territoire:";

interface Ligne {
  id: string;
  code: string;
  nom: string | null;
  classe: string;
  region: string | null;
  km: number;
  lat: number;
  lon: number;
}

async function main() {
  const appliquer = process.argv.includes("--apply");

  /**
   * Les candidats : dans le reseau classe aujourd'hui, et hors de toute limite.
   *
   * Le `NOT EXISTS` plutot qu'une jointure negative : un troncon peut traverser
   * plusieurs regions, et on veut savoir s'il n'en rencontre AUCUNE, pas compter
   * celles qu'il rencontre.
   */
  const candidats = await prisma.$queryRawUnsafe<Ligne[]>(`
    SELECT t.id, t.code, t.nom, t.classe::text AS classe, r.nom AS region,
           round((ST_Length(t.geom::geography) / 1000)::numeric, 1)::float8 AS km,
           round(ST_Y(ST_PointOnSurface(t.geom))::numeric, 3)::float8 AS lat,
           round(ST_X(ST_PointOnSurface(t.geom))::numeric, 3)::float8 AS lon
      FROM troncons t
      LEFT JOIN regions r ON r.id = t."regionId"
     WHERE t."deletedAt" IS NULL
       AND t.geom IS NOT NULL
       AND ${clauseSqlReseauClasse('t."sourceReference"')}
       AND NOT EXISTS (
         SELECT 1 FROM limites_admin la
          WHERE la.niveau = 1 AND ST_Intersects(la.geom, t.geom)
       )
     ORDER BY t.nom, t.code
  `);

  const avant = await prisma.$queryRawUnsafe<{ troncons: bigint; km: number }[]>(`
    SELECT count(*) AS troncons,
           round(COALESCE(SUM(ST_Length(geom::geography) / 1000), 0)::numeric, 1)::float8 AS km
      FROM troncons
     WHERE "deletedAt" IS NULL AND geom IS NOT NULL
       AND ${clauseSqlReseauClasse()}
  `);

  console.log("=== Troncons hors du territoire guineen ===");
  console.log(`Mode : ${appliquer ? "ECRITURE" : "LECTURE SEULE (ajouter --apply)"}`);
  console.log("");
  console.log(`Reseau classe actuel : ${Number(avant[0].troncons)} troncons, ${avant[0].km} km`);
  console.log("");

  if (candidats.length === 0) {
    console.log("Aucun troncon du reseau classe hors des limites. Rien a faire.");
    return;
  }

  const kmTotal = Math.round(candidats.reduce((s, c) => s + c.km, 0) * 10) / 10;
  console.log(`A sortir du reseau classe : ${candidats.length} troncons, ${kmTotal} km`);
  console.log("");
  console.log("  code              nom     classe  region declaree   km      position");
  for (const c of candidats) {
    console.log(
      `  ${c.code.padEnd(17)} ${String(c.nom ?? "").padEnd(7)} ${c.classe.padEnd(6)} ` +
      `${String(c.region ?? "(aucune)").padEnd(16)} ${String(c.km).padStart(5)}   ${c.lat} / ${c.lon}`
    );
  }
  console.log("");
  console.log(`Apres : ${Number(avant[0].troncons) - candidats.length} troncons, ` +
              `${Math.round((avant[0].km - kmTotal) * 10) / 10} km`);
  console.log("");

  if (!appliquer) {
    console.log("LECTURE SEULE — rien n'a ete ecrit.");
    console.log("");
    console.log("Le critere est geometrique : aucune intersection avec une limite de");
    console.log("niveau 1. Il ne juge pas sur le nom — RN4-OSM-0, lui, est bien en Guinee.");
    return;
  }

  const maintenant = new Date();
  await prisma.$transaction(
    async (tx) => {
      for (const c of candidats) {
        await tx.$executeRawUnsafe(
          `UPDATE troncons
              SET "sourceReference" = $2,
                  "sourceType" = 'IMPORT_CODE_PATTERN'::"SourceType",
                  "sourceConfidence" = 'LOW'::"NiveauConfiance",
                  "sourceDetectedAt" = $3::timestamp,
                  "updatedAt" = now()
            WHERE id = $1`,
          c.id, `${PREFIXE}${c.code}`, maintenant,
        );
        // La provenance dit POURQUOI, pas seulement QUE. Sans la raison, un lecteur
        // futur ne saura pas si le marquage releve d'une mesure ou d'une opinion.
        await tx.$executeRawUnsafe(
          `INSERT INTO valeurs_qualite
             (id, "entityType", "entityId", champ, statut, source, methode, "observedAt",
              confiance, note, "createdAt", "updatedAt")
           VALUES (gen_random_uuid()::text, 'Troncon', $1, 'sourceReference',
                   'DERIVED'::"StatutValeur", 'Limites administratives COD-AB / OCHA',
                   'INTERSECTION_GEOMETRIQUE', $2::timestamp, 'MEDIUM'::"NiveauConfiance",
                   $3, now(), now())
           ON CONFLICT ("entityType", "entityId", champ) DO UPDATE
             SET statut = EXCLUDED.statut, source = EXCLUDED.source,
                 methode = EXCLUDED.methode, "observedAt" = EXCLUDED."observedAt",
                 note = EXCLUDED.note, "updatedAt" = now()`,
          c.id, maintenant,
          `Sorti du reseau classe : la geometrie ne rencontre aucune limite `
          + `administrative guineenne de niveau 1. Position ${c.lat} / ${c.lon}, `
          + `${c.km} km, region declaree ${c.region ?? "aucune"}. Le troncon reste en `
          + `base et reste consultable.`,
        );
      }
    },
    { timeout: 300_000, maxWait: 60_000 },
  );

  // Recompter la table, pas la boucle : seul moyen de distinguer « j'ai voulu ecrire »
  // de « la base a ecrit ».
  const apres = await prisma.$queryRawUnsafe<{ troncons: bigint; km: number }[]>(`
    SELECT count(*) AS troncons,
           round(COALESCE(SUM(ST_Length(geom::geography) / 1000), 0)::numeric, 1)::float8 AS km
      FROM troncons
     WHERE "deletedAt" IS NULL AND geom IS NOT NULL
       AND ${clauseSqlReseauClasse()}
  `);
  const restants = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`
    SELECT count(*) AS n FROM troncons t
     WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL
       AND ${clauseSqlReseauClasse('t."sourceReference"')}
       AND NOT EXISTS (SELECT 1 FROM limites_admin la
                        WHERE la.niveau = 1 AND ST_Intersects(la.geom, t.geom))
  `);

  console.log("--- Applique ---");
  console.log(`  troncons marques        : ${candidats.length}`);
  console.log(`  reseau classe           : ${Number(apres[0].troncons)} troncons, ${apres[0].km} km`);
  console.log(`  restant hors territoire : ${Number(restants[0].n)}  (0 attendu)`);
  console.log("");
  console.log("Retour arriere :");
  console.log(`  update troncons set "sourceReference" = null, "sourceType" = null,`);
  console.log(`         "sourceConfidence" = null, "sourceDetectedAt" = null`);
  console.log(`   where "sourceReference" like '${PREFIXE}%';`);
  console.log(`  delete from valeurs_qualite where "entityType" = 'Troncon'`);
  console.log(`    and champ = 'sourceReference' and methode = 'INTERSECTION_GEOMETRIQUE';`);
}

main()
  .catch((e) => { console.error("ECHEC :", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
