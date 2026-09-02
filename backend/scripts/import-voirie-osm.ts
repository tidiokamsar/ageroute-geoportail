/**
 * P4 — Import de la voirie OpenStreetMap dans `voirie_locale`.
 *
 * SANS `--apply`, LE SCRIPT NE FAIT QUE LIRE.
 *
 * Il analyse le fichier, annonce ce qu'il ecrirait, et s'arrete. C'est la regle de
 * la phase : aucun script ne modifie de donnee metier sans intention explicite.
 *
 * SOURCE
 *
 * Le TSV produit par `scripts/osm-comparison/shp_vers_tsv.py` depuis ROUTE.shp.
 * Sept colonnes : ID, NATURE, NUMERO, NOM, SENS, DATE_MAJ, WKT.
 *
 * CE QUI N'EST PAS IMPORTE, ET POURQUOI
 *
 * L'audit du 02/09/2026 a mesure que trois champs de ROUTE.dbf sont vides ou
 * constants : GESTION et POID_MAX n'ont aucune valeur, CL_ADMIN vaut « Autre » sur
 * les 262 656 objets. Les charger donnerait l'illusion d'une donnee disponible.
 *
 * LE PIEGE DU JEU
 *
 * Le vide n'y est pas une chaine vide mais la valeur « NC ». Le convertisseur
 * l'a deja neutralise ; ce script le revalide plutot que de faire confiance.
 *
 * IDEMPOTENCE
 *
 * `ON CONFLICT (source, sourceId) DO NOTHING` : rejouer l'import n'ajoute rien.
 * Un objet source ne peut entrer deux fois.
 *
 * Usage :
 *   tsx scripts/import-voirie-osm.ts <fichier.tsv>            (lecture seule)
 *   tsx scripts/import-voirie-osm.ts <fichier.tsv> --apply    (ecrit)
 *   ... --exclure SENTIER,PIETON                              (categories a omettre)
 */
import fs from "fs";
import readline from "readline";
import { PrismaClient } from "@prisma/client";
import "dotenv/config";

const prisma = new PrismaClient();

const LOT = "A_OSM_RESEAU_ROUTIER 2023-03-08";
const VIDES = new Set(["", "NC", "N/C", "NULL", "-"]);
const TAILLE_LOT = 2000;

/**
 * Regroupement des 21 valeurs de NATURE.
 *
 * INFERE : aucun champ source ne le porte. OSM decrit la praticabilite
 * (« carrossable » / « non carrossable »), pas le statut administratif. Ce
 * classement est une lecture documentee, pas une donnee.
 */
function categorie(nature: string): string {
  const n = nature.toLowerCase();
  if (/voie rapide|bretelle voie rapide/.test(n)) return "VOIE_RAPIDE";
  if (/primaire/.test(n)) return "PRINCIPALE";
  if (/secondaire/.test(n)) return "SECONDAIRE";
  if (/tertiaire/.test(n)) return "TERTIAIRE";
  if (/non classifi|en construction/.test(n)) return "VOIE_LOCALE";
  if (/r[ée]sidentielle|zone de rencontre/.test(n)) return "RESIDENTIELLE";
  if (/acc[èe]s/.test(n)) return "ACCES";
  if (/chemin carrossable/.test(n)) return "CHEMIN";
  if (/chemin non carrossable/.test(n)) return "SENTIER";
  if (/pi[ée]tonne|escalier|cyclable|[ée]questre/.test(n)) return "PIETON";
  return "INCONNU";
}

const vide = (v: string) => VIDES.has(v.trim().toUpperCase());
const ouNul = (v: string) => (vide(v) ? null : v.trim());

/** `DATE_MAJ` arrive en texte ; une valeur illisible devient nulle, jamais inventee. */
function dateSource(v: string): Date | null {
  if (vide(v)) return null;
  const d = new Date(v.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

interface Ligne {
  sourceId: string;
  nature: string;
  reference: string | null;
  nom: string | null;
  sens: string | null;
  sourceDate: Date | null;
  categorie: string;
  wkt: string;
}

async function main() {
  const fichier = process.argv[2];
  const appliquer = process.argv.includes("--apply");
  const iExclure = process.argv.indexOf("--exclure");
  const exclues = new Set(
    iExclure > -1 && process.argv[iExclure + 1]
      ? process.argv[iExclure + 1].split(",").map((c) => c.trim().toUpperCase())
      : []
  );

  if (!fichier || !fs.existsSync(fichier)) {
    console.error("Fichier TSV introuvable. Usage : tsx scripts/import-voirie-osm.ts <fichier.tsv> [--apply]");
    process.exit(1);
  }

  console.log(`Source        : ${fichier}`);
  console.log(`Lot d'import  : ${LOT}`);
  if (exclues.size > 0) console.log(`Categories exclues : ${[...exclues].join(", ")}`);
  console.log(appliquer ? "Mode          : ECRITURE" : "Mode          : LECTURE SEULE (ajouter --apply pour ecrire)");
  console.log("");

  const parCategorie = new Map<string, number>();
  let lues = 0;
  let ignorees = 0;
  let ecrites = 0;
  let lot: Ligne[] = [];

  async function viderLot() {
    if (lot.length === 0) return;
    if (appliquer) {
      // Insertion par lot en SQL brut : Prisma ne sait pas ecrire une colonne
      // geometry, et 262 656 createMany unitaires prendraient des heures.
      const valeurs = lot
        .map(
          (l) =>
            `(gen_random_uuid()::text, 'OSM', ${q(l.sourceId)}, ${l.sourceDate ? `'${l.sourceDate.toISOString()}'::timestamp` : "NULL"}, ` +
            `${q(LOT)}, ${q(l.nature)}, ${l.nom ? q(l.nom) : "NULL"}, ${l.reference ? q(l.reference) : "NULL"}, ` +
            `${l.sens ? q(l.sens) : "NULL"}, '${l.categorie}'::"CategorieVoirie", ` +
            `ST_Length(ST_GeomFromText(${q(l.wkt)}, 4326)::geography) / 1000.0, ` +
            `'SOURCE_EXTERNE'::"StatutVoirie", NOW(), NOW(), ST_GeomFromText(${q(l.wkt)}, 4326))`
        )
        .join(",\n");
      const n = await prisma.$executeRawUnsafe(
        `INSERT INTO voirie_locale
           (id, source, "sourceId", "sourceDate", "importLot", nature, nom, reference,
            sens, categorie, "longueurCalculeeKm", statut, "createdAt", "updatedAt", geom)
         VALUES ${valeurs}
         ON CONFLICT (source, "sourceId") DO NOTHING`
      );
      ecrites += n;
    }
    lot = [];
  }

  const flux = readline.createInterface({
    input: fs.createReadStream(fichier, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const ligne of flux) {
    if (!ligne.trim()) continue;
    const c = ligne.split("\t");
    if (c.length < 7) { ignorees++; continue; }

    const nature = c[1].trim();
    const cat = categorie(nature);
    lues++;
    parCategorie.set(cat, (parCategorie.get(cat) ?? 0) + 1);

    if (exclues.has(cat)) { ignorees++; continue; }
    if (!c[6].startsWith("LINESTRING")) { ignorees++; continue; }

    lot.push({
      sourceId: c[0].trim(),
      nature,
      reference: ouNul(c[2]),
      nom: ouNul(c[3]),
      sens: ouNul(c[4]),
      sourceDate: dateSource(c[5]),
      categorie: cat,
      wkt: c[6],
    });

    if (lot.length >= TAILLE_LOT) {
      await viderLot();
      if (appliquer && ecrites % 20000 < TAILLE_LOT) {
        console.log(`  ${ecrites.toLocaleString("fr-FR")} lignes ecrites...`);
      }
    }
  }
  await viderLot();

  console.log("Repartition par categorie :");
  for (const [cat, n] of [...parCategorie.entries()].sort((a, b) => b[1] - a[1])) {
    const marque = exclues.has(cat) ? "  (exclue)" : "";
    console.log(`  ${cat.padEnd(15)} ${n.toLocaleString("fr-FR").padStart(9)}${marque}`);
  }
  console.log("");
  console.log(`Lignes lues      : ${lues.toLocaleString("fr-FR")}`);
  console.log(`Ignorees         : ${ignorees.toLocaleString("fr-FR")}`);

  if (appliquer) {
    const total = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM voirie_locale`;
    console.log(`Lignes ecrites   : ${ecrites.toLocaleString("fr-FR")}`);
    console.log(`Total en base    : ${Number(total[0].n).toLocaleString("fr-FR")}`);
  } else {
    console.log(`A ecrire         : ${(lues - ignorees).toLocaleString("fr-FR")}`);
    console.log("");
    console.log("LECTURE SEULE — rien n'a ete ecrit. Ajouter --apply pour importer.");
  }
}

/** Echappement SQL : uniquement pour des valeurs issues du fichier, jamais de l'API. */
function q(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
