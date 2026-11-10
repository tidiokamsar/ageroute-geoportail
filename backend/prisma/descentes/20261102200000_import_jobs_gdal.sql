-- RETOUR ARRIERE de `20261102200000_import_jobs_gdal`.
--
-- CE QUI EST PERDU :
--   - `projets_voirie_import_jobs` : le journal des jobs de conversion (qui a converti quel fichier, quand, avec quel resultat, sans geometrie).
--     La descente REFUSE de s'executer s'il porte une ligne. Les lignes d'`audit_logs` qui decrivent ces jobs (entite JobImportProjet) NE sont
--     PAS supprimees : le journal est une archive. Les fichiers du spool ne sont pas dans la base (ils expirent seuls).
--   - les trois valeurs GPKG, SHAPEFILE, DXF du type FormatJeuProjet : la descente REFUSE, SANS DEROGATION, si un jeu en porte une (retirer la
--     valeur obligerait a inventer un format de remplacement : decision metier). Les jeux, objets et projets ne sont pas touches.
--
-- GARDE : pour passer outre le refus lie aux jobs, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261102200000_import_jobs_gdal.sql
--
-- GARDE-TEST: SET session_replication_role = replica; INSERT INTO "projets_voirie_import_jobs" ("id","projetId","creeParId","format","nomFichier","sha256","tailleOctets","expireLe") VALUES ('g-ij1','g-p','g-u','GPKG','garde.gpkg','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',3,CURRENT_TIMESTAMP);
-- GARDE-TEST-SANS-DEROGATION: SET session_replication_role = replica; INSERT INTO "projets_voirie_jeux" ("id","projetId","role","nomFichier","format","sha256","tailleOctets","nbObjets","creeParId") VALUES ('g-j3','g-p','AUTRE','garde.gpkg','GPKG','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',1,0,'g-u');

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "projets_voirie_import_jobs";
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % job(s) de conversion dans projets_voirie_import_jobs (journal des conversions GDAL). Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

-- Le type est retire APRES la table des jobs ; la descente refuse (sans derogation) si un jeu porte GPKG, SHAPEFILE ou DXF (tout est annule : une seule transaction).
CREATE FUNCTION pg_temp.retirer_valeurs_enum(p_type text, p_valeurs text[]) RETURNS void
LANGUAGE plpgsql AS $f$
DECLARE
  c record;
  v_n bigint;
  v_labels text;
  v_defaut text;
  v_ancien text := p_type || '_avant_descente';
BEGIN
  FOR c IN
    SELECT n.nspname AS s, cl.relname AS t, a.attname AS col
      FROM pg_attribute a
      JOIN pg_class cl ON cl.oid = a.attrelid AND cl.relkind IN ('r', 'p')
      JOIN pg_namespace n ON n.oid = cl.relnamespace
      JOIN pg_type ty ON ty.oid = a.atttypid
     WHERE ty.typname = p_type AND a.attnum > 0 AND NOT a.attisdropped AND n.nspname = 'public'
  LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I WHERE %I::text = ANY (%L::text[])', c.s, c.t, c.col, p_valeurs) INTO v_n;
    IF v_n > 0 THEN
      RAISE EXCEPTION 'DESCENTE REFUSEE : % ligne(s) de %.% portent une valeur a retirer du type % (%). Aucune valeur de remplacement n''est inventee : decision metier.', v_n, c.t, c.col, p_type, p_valeurs;
    END IF;
  END LOOP;

  SELECT string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) INTO v_labels
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
   WHERE t.typname = p_type AND e.enumlabel <> ALL (p_valeurs);

  EXECUTE format('ALTER TYPE %I RENAME TO %I', p_type, v_ancien);
  EXECUTE format('CREATE TYPE %I AS ENUM (%s)', p_type, v_labels);

  FOR c IN
    SELECT n.nspname AS s, cl.relname AS t, a.attname AS col, a.attrelid AS rel, a.attnum AS num
      FROM pg_attribute a
      JOIN pg_class cl ON cl.oid = a.attrelid AND cl.relkind IN ('r', 'p')
      JOIN pg_namespace n ON n.oid = cl.relnamespace
      JOIN pg_type ty ON ty.oid = a.atttypid
     WHERE ty.typname = v_ancien AND a.attnum > 0 AND NOT a.attisdropped AND n.nspname = 'public'
  LOOP
    SELECT replace(pg_get_expr(d.adbin, d.adrelid), quote_ident(v_ancien), quote_ident(p_type)) INTO v_defaut
      FROM pg_attrdef d WHERE d.adrelid = c.rel AND d.adnum = c.num;
    IF v_defaut IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I DROP DEFAULT', c.s, c.t, c.col);
    END IF;
    EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I TYPE %I USING %I::text::%I', c.s, c.t, c.col, p_type, c.col, p_type);
    IF v_defaut IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I SET DEFAULT %s', c.s, c.t, c.col, v_defaut);
    END IF;
  END LOOP;

  EXECUTE format('DROP TYPE %I', v_ancien);
END
$f$;

-- La table des jobs d'abord : sa colonne `format` porte le type a reconstruire (la descente autorisee doit pouvoir la retirer).
DROP TRIGGER IF EXISTS projets_voirie_import_jobs_troncature ON "projets_voirie_import_jobs";
DROP TRIGGER IF EXISTS projets_voirie_import_jobs_suppression ON "projets_voirie_import_jobs";
DROP TRIGGER IF EXISTS projets_voirie_import_jobs_transition ON "projets_voirie_import_jobs";
DROP TABLE IF EXISTS "projets_voirie_import_jobs";
DROP FUNCTION IF EXISTS projets_voirie_import_jobs_refuse_suppression();
DROP FUNCTION IF EXISTS projets_voirie_import_jobs_transition();
DROP TYPE IF EXISTS "StatutJobImportProjet";

SELECT pg_temp.retirer_valeurs_enum('FormatJeuProjet', ARRAY['GPKG','SHAPEFILE','DXF']);

-- Apres une descente reussie, retirer la ligne de l'historique de Prisma :
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261102200000_import_jobs_gdal';
