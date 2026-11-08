// Banc d'integration : la migration 20261026400000 repare la carte publique sur une base reconstruite.
// Voir tests-integration/README.md. Lancer (DATABASE_URL pointe sur `replay`) :
//   npx tsx tests-integration/extension-unaccent.integration.mts
//
// LE DEFAUT : aucune migration ne creait l'extension `unaccent`, que chantiers.service.ts appelle.
// Sur une base reconstruite par les seules migrations, GET /api/public/carte/geo repondait 500
// (`function unaccent(text) does not exist`).
//
// CE QUE LE BANC FAIT : sur un clone jetable de `replay`, il remet la base dans l'etat d'une base
// reconstruite sans la migration (l'extension est retiree du CLONE), constate le 500 sur la route
// reelle (CONTRE-EPREUVE : le banc sait voir le defaut), applique le fichier migration.sql du depot,
// puis constate 200 et une jointure sans accents qui fonctionne (« Boke » de la source COD-AB contre
// « Boké » du referentiel). Il rejoue enfin la migration : sans effet (c'est le cas en production).
//
// CE QU'IL NE PROUVE PAS : la production (l'extension y existe deja, le banc ne la voit pas) ni les
// droits du role de migration de production (CREATE EXTENSION exige un role proprietaire de la base).
import { readFileSync } from "node:fs";
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure } from "./lib/verdict.ts";

const banc = await ouvrirBancClone("essai_unaccent");
const { prisma } = await banc.imp("lib/prisma");
const { publicRouter } = await banc.imp("modules/public/public.routes");
const { errorHandler } = await banc.imp("middleware/error.middleware");
const express = (await import("express")).default;
const request = (await import("supertest")).default;

const app = express();
app.use("/api/public", publicRouter);
app.use(errorHandler);

const SQL_MIGRATION = readFileSync(
  new URL("../prisma/migrations/20261026400000_extension_unaccent/migration.sql", import.meta.url),
  "utf8",
);
const compter = async (sql: string): Promise<number> => Number((await prisma.$queryRawUnsafe(sql))[0].n);
const presente = async () => (await compter(`SELECT count(*) n FROM pg_extension WHERE extname='unaccent'`)) === 1;

async function main() {
  // Etat d'une base reconstruite sans la migration : on retire l'extension DU CLONE (sans CASCADE :
  // si un objet en depend, le banc s'arrete plutot que de le detruire en silence).
  await prisma.$executeRawUnsafe(`DROP EXTENSION IF EXISTS unaccent`);
  verifier("etat de depart : l'extension unaccent est absente du clone", !(await presente()));

  // Donnees : une region « Boké » avec un chantier, et sa limite officielle ecrite « Boke ».
  await prisma.$executeRawUnsafe(`INSERT INTO regions (nom) VALUES ('Boké')`);
  const regionId = Number((await prisma.$queryRawUnsafe(`SELECT id FROM regions WHERE nom='Boké'`))[0].id);
  await prisma.$executeRawUnsafe(
    `INSERT INTO limites_admin (pcode, niveau, nom, source, geom)
     VALUES ('GN-BANC-1', 1, 'Boke', 'banc', ST_Multi(ST_GeomFromText('POLYGON((-14 10, -13 10, -13 11, -14 11, -14 10))', 4326)))`);
  await prisma.$executeRawUnsafe(
    `INSERT INTO chantiers (id, intitule, entreprise, "regionId", "updatedAt")
     VALUES ('banc-unaccent-1', 'Chantier banc', 'Entreprise banc', ${regionId}, now())`);

  // CONTRE-EPREUVE : sans l'extension, la route reelle repond 500.
  const avant = await request(app).get("/api/public/carte/geo");
  verifier("sans la migration, GET /api/public/carte/geo repond 500 (le defaut est reproduit)", avant.status === 500, { status: avant.status });
  const erreurDeLaBase = await prisma.$queryRawUnsafe(`SELECT unaccent('x')`).then(() => "", (e: Error) => e.message);
  verifier("la cause est bien l'absence de la fonction unaccent", /unaccent/.test(erreurDeLaBase) && /does not exist/.test(erreurDeLaBase), erreurDeLaBase);

  // Application du fichier de migration du depot, tel quel.
  await prisma.$executeRawUnsafe(SQL_MIGRATION);
  verifier("apres la migration, l'extension est creee, dans le schema public", await compter(`SELECT count(*) n FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='unaccent' AND n.nspname='public'`) === 1);

  const apres = await request(app).get("/api/public/carte/geo");
  verifier("apres la migration, GET /api/public/carte/geo repond 200", apres.status === 200, { status: apres.status, corps: apres.body });
  const chantier = (apres.body.chantiers ?? []).find((c: { id: string }) => c.id === "banc-unaccent-1");
  verifier("le chantier est servi, ancre sur la limite « Boke » malgre l'accent de « Boké » (jointure sans accents)",
    !!chantier && typeof chantier.lat === "number" && chantier.lat > 10 && chantier.lat < 11 && chantier.lon > -14 && chantier.lon < -13, chantier);
  verifier("unaccent fait ce que le code attend : « Nzérékoré » devient « nzerekore »", (await prisma.$queryRawUnsafe(`SELECT unaccent(lower('Nzérékoré')) AS v`))[0].v === "nzerekore");

  // Rejeu : c'est la situation de la production (extension deja la). Aucune erreur, rien ne change.
  const avantRejeu = await compter(`SELECT count(*) n FROM pg_extension`);
  let rejeuOk = true;
  try { await prisma.$executeRawUnsafe(SQL_MIGRATION); } catch { rejeuOk = false; }
  verifier("rejouer la migration (extension deja presente, comme en production) ne leve aucune erreur et ne change rien",
    rejeuOk && (await compter(`SELECT count(*) n FROM pg_extension`)) === avantRejeu && await presente());
}

main()
  .catch((e) => { console.error(e); process.exitCode = 2; })
  .finally(async () => { conclure(); await prisma.$disconnect(); await banc.fermer(); });
