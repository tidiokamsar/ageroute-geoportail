-- RETOUR ARRIERE de `20261013220000_portions_ecriture`.
--
-- Ajoute la valeur PORTION au type DomaineValidation, portions.clientOperationId et son index unique.
--
-- CE QUI EST PERDU : les cles d'idempotence des portions (un envoi rejoue creerait un doublon). La valeur PORTION n'est retiree que si aucune delegation ne la porte.
--
-- GARDE : la descente REFUSE de s'executer si des donnees seraient detruites. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261013220000_portions_ecriture.sql
--
-- GARDE-TEST: INSERT INTO "portions" ("id","tronconId","debutM","finM","origine","creeParId","updatedAt","clientOperationId") VALUES ('g1','t',0,10,'IMPORT','u',now(),'c-1');
-- GARDE-TEST-SANS-DEROGATION: INSERT INTO "delegations_validation" ("id","domaine","validateurId","delegueParId","updatedAt") VALUES ('g2','PORTION','u','u',now());
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 sur une base de developpement vide (banc verifier.sh), dont le schema est celui que rejoue la CHAINE de migrations, pas celui de la production : le schema apres descente est identique a celui d'avant la migration, et la migration se reapplique ensuite a l'identique. Garde eprouvee avec une donnee fabriquee.

-- PostgreSQL ne sait pas retirer une valeur d'une enumeration : il faut reconstruire le type.
-- Cette fonction est temporaire (schema pg_temp) et disparait avec la session.
CREATE FUNCTION pg_temp.retirer_valeurs_enum(p_type text, p_valeurs text[]) RETURNS void
LANGUAGE plpgsql AS $f$
DECLARE
  c record;
  v_n bigint;
  v_labels text;
  v_defaut text;
  v_ancien text := p_type || '_avant_descente';
BEGIN
  -- Refuser si une valeur a retirer est portee par une ligne : aucune valeur de remplacement n'est
  -- inventee ici, le choix appartient a AGEROUTE.
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

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "portions" WHERE num_nonnulls("clientOperationId") > 0) INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % portion(s) portent une cle d''idempotence. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

DROP INDEX IF EXISTS "portions_clientOperationId_key";
ALTER TABLE "portions"
  DROP COLUMN IF EXISTS "clientOperationId";
SELECT pg_temp.retirer_valeurs_enum('DomaineValidation', ARRAY['PORTION']);

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261013220000_portions_ecriture';
