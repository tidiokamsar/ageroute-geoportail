-- RETOUR ARRIERE de `20261104100000_completude_documentaire` (lot D1).
--
-- CE QUI EST PERDU :
--   - `documents_projet_voirie` et son historique : les documents du dossier des projets (types, statuts, versions, references, empreintes des
--     fichiers, liens vers les jeux, validations) ; aucun fichier n'est perdu (le lot n'en stocke aucun) ;
--   - le parametre `roleJeu` des trois types de document systeme (PLAN_AXES, RESEAU_CONCESSIONNAIRE, LIMITES_ROUTE), qui reviennent en version 1 ;
--     une ligne d'historique MIGRATION de la descente s'ajoute a leur historique (ajout seul) ;
--   - la valeur LANDXML du type FormatJeuProjet.
--   Les lignes d'`audit_logs` (entite DocumentProjetVoirie) ne sont PAS supprimees : le journal est une archive.
--
-- La descente REFUSE de s'executer si un document existe. Pour passer outre, apres sauvegarde verifiee et autorisation explicite (A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- Elle REFUSE, MEME AVEC CETTE AUTORISATION, si un jeu porte le format LANDXML (retirer la valeur du type obligerait a inventer un format de
-- remplacement : decision metier). Un type de document systeme modifie depuis par un administrateur (version superieure a 2, ou acteur) garde
-- ses parametres : la descente ne touche que les lignes que la migration a ecrites.
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261104100000_completude_documentaire.sql
--
-- GARDE-TEST: SET session_replication_role = replica; INSERT INTO "users" ("id","email","nomComplet","passwordHash","role","updatedAt") VALUES ('g-u','g@local.invalid','x','x','GESTIONNAIRE',now()); INSERT INTO "documents_projet_voirie" ("id","projetId","ligneeId","version","typeCode","titre","statut","creeParId","derniereActionParId") VALUES ('g-d','g-p','g-d',1,'AUTRE','Document de garde','ATTENDU','g-u','g-u');
-- GARDE-TEST-SANS-DEROGATION: SET session_replication_role = replica; INSERT INTO "users" ("id","email","nomComplet","passwordHash","role","updatedAt") VALUES ('g-u2','g2@local.invalid','x','x','GESTIONNAIRE',now()); INSERT INTO "projets_voirie_jeux" ("id","projetId","role","natureObjets","nomFichier","format","sha256","tailleOctets","nbObjets","creeParId") VALUES ('g-j','g-p','AXES_TRAVAUX','AXE','garde.xml','LANDXML','0000000000000000000000000000000000000000000000000000000000000000',1,0,'g-u2');

DO $garde$
DECLARE n bigint; l bigint;
BEGIN
  SELECT (SELECT count(*) FROM "documents_projet_voirie") + (SELECT count(*) FROM "documents_projet_voirie_historique") INTO n;
  SELECT count(*) INTO l FROM "projets_voirie_jeux" WHERE "format"::text = 'LANDXML';
  IF l > 0 THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % jeu(x) au format LANDXML. Retirer la valeur du type obligerait a inventer un format de remplacement : decision metier, pas une autorisation.', l;
  END IF;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % ligne(s) de documents de projet ou de leur historique. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

-- ===== Tables du lot (l'historique, qui reference les documents, d'abord) =====
DROP TRIGGER IF EXISTS documents_projet_voirie_historique_troncature ON "documents_projet_voirie_historique";
DROP TRIGGER IF EXISTS documents_projet_voirie_historique_ajout_seul ON "documents_projet_voirie_historique";
DROP TRIGGER IF EXISTS documents_projet_voirie_troncature ON "documents_projet_voirie";
DROP TRIGGER IF EXISTS documents_projet_voirie_suppression ON "documents_projet_voirie";
DROP TRIGGER IF EXISTS documents_projet_voirie_remplacement_verifie ON "documents_projet_voirie";
DROP TRIGGER IF EXISTS documents_projet_voirie_historiser ON "documents_projet_voirie";
DROP TRIGGER IF EXISTS documents_projet_voirie_controle ON "documents_projet_voirie";
DROP TABLE IF EXISTS "documents_projet_voirie_historique";
DROP TABLE IF EXISTS "documents_projet_voirie";
DROP FUNCTION IF EXISTS documents_projet_voirie_refuse();
DROP FUNCTION IF EXISTS documents_projet_voirie_remplacement_verifie();
DROP FUNCTION IF EXISTS documents_projet_voirie_historiser();
DROP FUNCTION IF EXISTS documents_projet_voirie_controle();
DROP FUNCTION IF EXISTS documents_projet_voirie_transition_admise(text, text);
DROP TYPE IF EXISTS "StatutDocumentProjetVoirie";

-- ===== Referentiel TYPE_DOCUMENT : retour des trois valeurs systeme en version 1, sans roleJeu (lignes ecrites par la migration seulement) =====
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT v."id", v."code", v."parametres" FROM "referentiels_voirie" v
     WHERE v."domaine" = 'TYPE_DOCUMENT' AND v."code" IN ('PLAN_AXES', 'RESEAU_CONCESSIONNAIRE', 'LIMITES_ROUTE')
       AND v."creeParId" IS NULL AND v."approuveParId" IS NULL AND v."version" = 2 AND v."parametres" ? 'roleJeu'
  LOOP
    UPDATE "referentiels_voirie" SET "parametres" = r."parametres" - 'roleJeu', "version" = 1 WHERE "id" = r."id";
    INSERT INTO "referentiels_voirie_historique" ("referentielId", "action", "version", "avant", "apres")
      VALUES (r."id", 'MIGRATION', 1, jsonb_build_object('code', r."code", 'parametres', r."parametres", 'version', 2),
              jsonb_build_object('code', r."code", 'parametres', r."parametres" - 'roleJeu', 'version', 1, 'source', 'descente 20261104100000 : roleJeu retire'));
  END LOOP;
END $$;

-- ===== Valeur LANDXML de FormatJeuProjet : type reconstruit (meme helper que les descentes des lots B2 et S1) =====
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

SELECT pg_temp.retirer_valeurs_enum('FormatJeuProjet', ARRAY['LANDXML']);

-- Apres une descente reussie, retirer la ligne de l'historique de Prisma :
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261104100000_completude_documentaire';
