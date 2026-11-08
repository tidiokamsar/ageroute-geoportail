-- Instantane normalise du schema `public` : un objet par ligne, tri deterministe.
--
-- Sert au banc `verifier.sh` : l'instantane d'avant une migration est compare a celui d'apres sa
-- descente. Deux schemas identiques donnent deux instantanes identiques.
--
-- CE QUI EST COMPARE : extensions, types enumeres (valeurs dans l'ordre), tables, vues, sequences,
-- colonnes (type, NOT NULL, defaut), contraintes, index, declencheurs, fonctions, commentaires.
-- Les colonnes sont comparees par NOM, pas par rang : une colonne supprimee puis recreee change de
-- rang sans que le schema change au sens de l'application.
--
-- CE QUI NE L'EST PAS : les donnees, les droits (GRANT), les proprietaires, les statistiques.
-- Les objets installes par une extension (PostGIS, btree_gist) sont exclus : ils ne sont pas les
-- notres.
--
-- Usage : psql -X -At -d <base> -f instantane-schema.sql

SELECT q.ligne
  FROM (SELECT s.kind || '|' || s.nom || '|' || s.detail AS ligne
  FROM (
    SELECT 'ext' AS kind, e.extname::text AS nom, e.extversion::text AS detail
      FROM pg_extension e
     WHERE e.extname <> 'plpgsql'

    UNION ALL
    SELECT 'enum', t.typname::text,
           (SELECT string_agg(v.enumlabel, ',' ORDER BY v.enumsortorder) FROM pg_enum v WHERE v.enumtypid = t.oid)
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typtype = 'e'

    UNION ALL
    SELECT 'rel', c.relname::text, c.relkind::text
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')

    UNION ALL
    SELECT 'col', c.relname || '.' || a.attname,
           format_type(a.atttypid, a.atttypmod)
           || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
           || COALESCE(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), '')
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'v', 'm')
       AND a.attnum > 0 AND NOT a.attisdropped
       AND NOT EXISTS (SELECT 1 FROM pg_depend x WHERE x.objid = c.oid AND x.deptype = 'e')

    UNION ALL
    SELECT 'con', cl.relname || '.' || co.conname, pg_get_constraintdef(co.oid)
      FROM pg_constraint co
      JOIN pg_class cl ON cl.oid = co.conrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace
     WHERE n.nspname = 'public'
       AND NOT EXISTS (SELECT 1 FROM pg_depend x WHERE x.objid = cl.oid AND x.deptype = 'e')

    UNION ALL
    SELECT 'idx', i.tablename || '.' || i.indexname, i.indexdef
      FROM pg_indexes i
      JOIN pg_class c ON c.relname = i.tablename
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = i.schemaname
     WHERE i.schemaname = 'public'
       AND NOT EXISTS (SELECT 1 FROM pg_depend x WHERE x.objid = c.oid AND x.deptype = 'e')

    UNION ALL
    SELECT 'trg', cl.relname || '.' || t.tgname, pg_get_triggerdef(t.oid)
      FROM pg_trigger t
      JOIN pg_class cl ON cl.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal
       AND NOT EXISTS (SELECT 1 FROM pg_depend x WHERE x.objid = cl.oid AND x.deptype = 'e')

    UNION ALL
    SELECT 'fn', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
           regexp_replace(pg_get_functiondef(p.oid), '\s+', ' ', 'g')
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
       AND NOT EXISTS (SELECT 1 FROM pg_depend x WHERE x.objid = p.oid AND x.deptype = 'e')

    UNION ALL
    SELECT 'view', c.relname::text, regexp_replace(pg_get_viewdef(c.oid), '\s+', ' ', 'g')
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'v'
       AND NOT EXISTS (SELECT 1 FROM pg_depend x WHERE x.objid = c.oid AND x.deptype = 'e')

    UNION ALL
    SELECT 'cmt', c.relname || '.' || COALESCE(a.attname, ''), d.description
      FROM pg_description d
      JOIN pg_class c ON c.oid = d.objoid AND d.classoid = 'pg_class'::regclass
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.objsubid AND d.objsubid > 0
     WHERE n.nspname = 'public'
       AND NOT EXISTS (SELECT 1 FROM pg_depend x WHERE x.objid = c.oid AND x.deptype = 'e')
  ) s) q
 ORDER BY q.ligne COLLATE "C";
