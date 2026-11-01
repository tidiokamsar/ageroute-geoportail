-- PONT DE DERIVE (banc des descentes uniquement, jamais applique a une base reelle).
--
-- La chaine de migrations ne se rejoue pas depuis une base vide : `20260702110000` cree
-- `marches.id` en TEXT, puis `20260702140000` declare `decomptes."marcheId"` en UUID avec une cle
-- etrangere vers lui, ce que PostgreSQL refuse (docs/phase5/MIGRATIONS-NON-REJOUABLES.md).
--
-- La production porte `uuid` partout : elle a ete amenee a sa forme actuelle par `prisma db push`,
-- l'historique etant marque comme applique apres coup. Ce pont fait la meme chose, et seulement
-- cela, sur la base de reference du banc : il amene `marches.id` et les colonnes qui le referencent
-- au type de production, pour que les migrations suivantes puissent s'appliquer.
--
-- IL NE CORRIGE PAS L'HISTORIQUE. Reecrire `20260702110000`, ajouter une migration de rattrapage
-- conditionnelle ou repartir d'une baseline est une decision d'AGEROUTE (voir le document cite).
-- Ce pont ne rend pas le defaut inoffensif ; il permet seulement de mesurer le reste.
--
-- Il s'execute APRES le test de la descente de `20260702110000`, qui porte donc sur l'etat que cette
-- migration produit, et AVANT les migrations suivantes.

ALTER TABLE "marches_chantiers" DROP CONSTRAINT IF EXISTS "marches_chantiers_marcheId_fkey";
ALTER TABLE "avancement_marche" DROP CONSTRAINT IF EXISTS "avancement_marche_marcheId_fkey";

ALTER TABLE "marches" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "marches" ALTER COLUMN "id" TYPE uuid USING "id"::uuid;
ALTER TABLE "marches" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();

ALTER TABLE "marches_chantiers" ALTER COLUMN "marcheId" TYPE uuid USING "marcheId"::uuid;
ALTER TABLE "avancement_marche" ALTER COLUMN "marcheId" TYPE uuid USING "marcheId"::uuid;

ALTER TABLE "marches_chantiers"
  ADD CONSTRAINT "marches_chantiers_marcheId_fkey"
  FOREIGN KEY ("marcheId") REFERENCES "marches"("id") ON DELETE CASCADE;
ALTER TABLE "avancement_marche"
  ADD CONSTRAINT "avancement_marche_marcheId_fkey"
  FOREIGN KEY ("marcheId") REFERENCES "marches"("id") ON DELETE CASCADE;
