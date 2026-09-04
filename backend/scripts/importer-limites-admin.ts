/**
 * Importer les limites administratives officielles (COD-AB / OCHA).
 *
 * SANS `--apply`, LE SCRIPT NE FAIT QUE LIRE.
 *
 * LA SOURCE
 *
 * « Guinea - Subnational Administrative Boundaries », publie par OCHA Field
 * Information Services Section sur HDX, archive gin_admin_boundaries.geojson.zip,
 * mise a jour le 26/01/2026. Trois niveaux : 8 regions, 34 prefectures, 340
 * sous-prefectures.
 *
 * POURQUOI LE GEOJSON ET PAS LE SHAPEFILE
 *
 * Ni GDAL ni pyshp ne sont disponibles sur les machines du projet — l'audit OSM de
 * septembre avait deja du lire un SHP en Python pur. Le GeoJSON evite ce detour :
 * c'est du JSON, et PostGIS le lit nativement avec ST_GeomFromGeoJSON.
 *
 * CE QUE CE SCRIPT NE FAIT PAS
 *
 * Il ne rattache AUCUN troncon ni chantier. Charger un referentiel et s'en servir sont
 * deux actes distincts : le premier est verifiable seul, le second est une decision
 * qui deplace des actifs entre regions. Le rattachement fait l'objet d'un script
 * separe.
 *
 * Il ne corrige pas non plus le decoupage. La source decrit l'etat d'AVANT la reforme
 * du 20 aout 2026 — elle ignore Siguiri et Beyla. `validOn` et `validTo` sont
 * conserves tels quels pour que cette limite reste lisible.
 *
 * Usage :
 *   tsx scripts/importer-limites-admin.ts <archive.zip>            (lecture seule)
 *   tsx scripts/importer-limites-admin.ts <archive.zip> --apply    (ecrit)
 */
import fs from "fs";
import { execFileSync } from "child_process";
import { PrismaClient } from "@prisma/client";
import "dotenv/config";

const prisma = new PrismaClient();

const SOURCE = "OCHA FISS — Guinea Subnational Administrative Boundaries (COD-AB), HDX";

/** Fichier de l'archive, et niveau administratif correspondant. */
const NIVEAUX = [
  { fichier: "gin_admin1.geojson", niveau: 1, cle: "adm1", parent: null },
  { fichier: "gin_admin2.geojson", niveau: 2, cle: "adm2", parent: "adm1" },
  { fichier: "gin_admin3.geojson", niveau: 3, cle: "adm3", parent: "adm2" },
] as const;

interface Entite {
  pcode: string;
  niveau: number;
  nom: string;
  parentPcode: string | null;
  validOn: string | null;
  validTo: string | null;
  geometry: unknown;
}

/**
 * Lit un membre d'archive ZIP sans dependance.
 *
 * Node n'a pas de lecteur ZIP en bibliotheque standard, et ajouter une dependance
 * pour un import ponctuel serait disproportionne. `unzip -p` ecrit sur la sortie
 * standard ; il est present sur le serveur comme dans l'image du backend.
 */
function lireMembre(archive: string, membre: string): string {
  return execFileSync("unzip", ["-p", archive, membre], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function extraire(archive: string): Entite[] {
  const entites: Entite[] = [];
  for (const n of NIVEAUX) {
    const brut = JSON.parse(lireMembre(archive, n.fichier)) as {
      features: { properties: Record<string, unknown>; geometry: unknown }[];
    };
    for (const f of brut.features) {
      const p = f.properties;
      const pcode = String(p[`${n.cle}_pcode`] ?? "").trim();
      const nom = String(p[`${n.cle}_name`] ?? "").trim();
      // Une entite sans code ni nom n'est pas une entite : la charger creerait une
      // ligne que rien ne permettrait jamais de retrouver.
      if (!pcode || !nom) continue;
      entites.push({
        pcode,
        niveau: n.niveau,
        nom,
        parentPcode: n.parent ? String(p[`${n.parent}_pcode`] ?? "").trim() || null : null,
        validOn: p.valid_on ? String(p.valid_on).slice(0, 10) : null,
        validTo: p.valid_to ? String(p.valid_to).slice(0, 10) : null,
        geometry: f.geometry,
      });
    }
  }
  return entites;
}

async function main() {
  const archive = process.argv[2];
  const appliquer = process.argv.includes("--apply");

  if (!archive || !fs.existsSync(archive)) {
    throw new Error("Usage : tsx scripts/importer-limites-admin.ts <archive.zip> [--apply]");
  }

  const entites = extraire(archive);
  const parNiveau = new Map<number, number>();
  for (const e of entites) parNiveau.set(e.niveau, (parNiveau.get(e.niveau) ?? 0) + 1);

  console.log("=== Import des limites administratives ===");
  console.log(`Archive : ${archive}`);
  console.log(`Source  : ${SOURCE}`);
  console.log(`Mode    : ${appliquer ? "ECRITURE" : "LECTURE SEULE (ajouter --apply)"}`);
  console.log("");
  console.log(`  niveau 1 (régions)          ${parNiveau.get(1) ?? 0}`);
  console.log(`  niveau 2 (préfectures)      ${parNiveau.get(2) ?? 0}`);
  console.log(`  niveau 3 (sous-préfectures) ${parNiveau.get(3) ?? 0}`);
  console.log(`  total                       ${entites.length}`);
  console.log("");

  const validites = new Set(entites.map((e) => e.validOn).filter(Boolean));
  console.log(`Validité des géométries : ${[...validites].join(", ") || "non renseignée"}`);
  console.log("Ce jeu décrit le découpage d'AVANT la réforme du 20 août 2026 :");
  console.log("il ignore Siguiri et Beyla, devenues régions.");
  console.log("");

  if (!appliquer) {
    console.log("LECTURE SEULE — rien n'a ete ecrit.");
    return;
  }

  let ecrites = 0;
  // Par lots : les geometries de niveau 3 sont volumineuses, et une transaction
  // unique sur 382 polygones detaillees tiendrait un verrou inutilement long.
  for (let i = 0; i < entites.length; i += 25) {
    const lot = entites.slice(i, i + 25);
    await prisma.$transaction(
      lot.map((e) =>
        prisma.$executeRawUnsafe(
          `INSERT INTO limites_admin
             (pcode, niveau, nom, "parentPcode", "validOn", "validTo", source, "sourceDate", geom)
           VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8::date,
                   ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($9), 4326)))
           ON CONFLICT (pcode) DO UPDATE SET
             niveau = EXCLUDED.niveau, nom = EXCLUDED.nom,
             "parentPcode" = EXCLUDED."parentPcode",
             "validOn" = EXCLUDED."validOn", "validTo" = EXCLUDED."validTo",
             source = EXCLUDED.source, "sourceDate" = EXCLUDED."sourceDate",
             geom = EXCLUDED.geom`,
          e.pcode, e.niveau, e.nom, e.parentPcode, e.validOn, e.validTo,
          SOURCE, e.validOn, JSON.stringify(e.geometry),
        ),
      ),
      { timeout: 120_000 },
    );
    ecrites += lot.length;
  }

  const invalides = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*) AS n FROM limites_admin WHERE geom IS NULL OR NOT ST_IsValid(geom)`,
  );

  console.log("--- Applique ---");
  console.log(`  entites ecrites          : ${ecrites}`);
  console.log(`  geometries invalides     : ${Number(invalides[0].n)}`);
  console.log("");
  console.log("Aucun troncon ni chantier n'a ete rattache : charger un referentiel et");
  console.log("s'en servir sont deux actes distincts.");
  console.log("");
  console.log("Retour arriere :  delete from limites_admin;");
}

main()
  .catch((e) => { console.error("ECHEC :", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
