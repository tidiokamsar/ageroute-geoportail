-- RETOUR ARRIERE de `20260624110000_ouvrage_pointnoir_fiche_extension`.
--
-- Ajoute douze colonnes de fiche terrain a ouvrages (ficheNumero, code, dimensions, materiaux, remarques) et points_noirs.pk.
--
-- CE QUI EST PERDU : les champs de la fiche d'inventaire des ouvrages d'art et le PK des points noirs.
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20260624110000_ouvrage_pointnoir_fiche_extension.sql
--
-- GARDE-TEST: INSERT INTO "ouvrages" ("id","nom","type","regionId","updatedAt","ficheNumero") VALUES ('g1','x','PONT',1,now(),'F-1');
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "ouvrages" WHERE num_nonnulls("ficheNumero", "code", "largeurM", "hauteurM", "nbTravees", "longueurTravee", "materiauAppuis", "materiauTablier", "materiauPiles", "materiauAutre", "remarques", "travauxAPrevoir") > 0) + (SELECT count(*) FROM "points_noirs" WHERE num_nonnulls("pk") > 0) INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % ligne(s) portent des champs de fiche ou un PK. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

ALTER TABLE "ouvrages"
  DROP COLUMN IF EXISTS "ficheNumero",
  DROP COLUMN IF EXISTS "code",
  DROP COLUMN IF EXISTS "largeurM",
  DROP COLUMN IF EXISTS "hauteurM",
  DROP COLUMN IF EXISTS "nbTravees",
  DROP COLUMN IF EXISTS "longueurTravee",
  DROP COLUMN IF EXISTS "materiauAppuis",
  DROP COLUMN IF EXISTS "materiauTablier",
  DROP COLUMN IF EXISTS "materiauPiles",
  DROP COLUMN IF EXISTS "materiauAutre",
  DROP COLUMN IF EXISTS "remarques",
  DROP COLUMN IF EXISTS "travauxAPrevoir";
ALTER TABLE "points_noirs"
  DROP COLUMN IF EXISTS "pk";

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260624110000_ouvrage_pointnoir_fiche_extension';
