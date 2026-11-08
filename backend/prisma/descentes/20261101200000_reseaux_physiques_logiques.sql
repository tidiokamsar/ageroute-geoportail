-- RETOUR ARRIERE de `20261101200000_reseaux_physiques_logiques`.
--
-- CE QUI EST PERDU : TOUS les descripteurs d'objets (nature, type, classe de precision, precisions, methode, date de constat, niveau de
-- confiance, profondeur, altitude, reference verticale, motif) et TOUTES les relations entre objets (circuit porte par infrastructure,
-- equipement dans chambre), y compris les propositions refusees et les relations validees par des personnes. Ce sont des DECISIONS HUMAINES
-- et des donnees CONFIDENTIELLES (reseaux de tiers) : les perdre efface la memoire de la qualification des reseaux. Les jeux de donnees, les
-- objets, les projets, les concessionnaires (migration 20261030100000) et les dossiers de conflit (migration 20261031100000) ne sont PAS
-- touches : le jeu garde sa nature declaree (`natureObjets`) et sa classe de precision.
--
-- GARDE : la descente REFUSE de s'executer si l'une des deux tables porte au moins une ligne. Pour passer outre, apres sauvegarde verifiee et
-- autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- Les lignes de `audit_logs` qui decrivent ces operations (entites ReseauObjetDescripteur, ReseauRelation, AssociationsReseau) ne sont PAS
-- supprimees : le journal est une trace d'archive.
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261101200000_reseaux_physiques_logiques.sql
--
-- GARDE-TEST: INSERT INTO "reseau_objets_descripteurs" ("objetId","jeuId","justification","declareParId") VALUES (999001,'g-j','descripteur de garde pour la descente','g-u');
-- GARDE-TEST: INSERT INTO "reseau_relations" ("id","projetId","typeRelation","sourceObjetId","cibleObjetId","origine","creeParId") VALUES ('g-r','g-p','PORTE_PAR',999001,999002,'AUTOMATIQUE','g-u');

DO $garde$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "reseau_objets_descripteurs") + (SELECT count(*) FROM "reseau_relations") INTO n;
  IF n > 0 AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % ligne(s) dans les tables des reseaux physiques et circuits logiques (descripteurs d''objets, relations). Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', n;
  END IF;
END
$garde$;

-- Declencheurs (les tables partent avec, mais on les retire d'abord pour que l'ordre soit lisible).
DROP TRIGGER IF EXISTS reseau_relations_troncature ON "reseau_relations";
DROP TRIGGER IF EXISTS reseau_relations_suppression ON "reseau_relations";
DROP TRIGGER IF EXISTS reseau_relations_controle ON "reseau_relations";
DROP TRIGGER IF EXISTS reseau_objets_descripteurs_troncature ON "reseau_objets_descripteurs";
DROP TRIGGER IF EXISTS reseau_objets_descripteurs_suppression ON "reseau_objets_descripteurs";
DROP TRIGGER IF EXISTS reseau_objets_descripteurs_controle ON "reseau_objets_descripteurs";

-- La table qui en reference d'autres d'abord.
DROP TABLE IF EXISTS "reseau_relations";
DROP TABLE IF EXISTS "reseau_objets_descripteurs";

-- La fonction SQL lit les deux tables : elle part apres elles (une fonction `LANGUAGE sql` n'est pas liee a ses tables).
DROP FUNCTION IF EXISTS reseau_nature_effective(BIGINT);
DROP FUNCTION IF EXISTS reseau_relation_controle();
DROP FUNCTION IF EXISTS reseau_descripteur_controle();
DROP FUNCTION IF EXISTS reseau_refuse_suppression();
DROP FUNCTION IF EXISTS reseau_refuse_troncature();

DROP TYPE IF EXISTS "StatutQualiteObjet";
DROP TYPE IF EXISTS "NiveauConfianceObjet";
DROP TYPE IF EXISTS "OrigineRelationReseau";
DROP TYPE IF EXISTS "StatutRelationReseau";
DROP TYPE IF EXISTS "TypeRelationReseau";

-- Apres une descente reussie, retirer la ligne de l'historique de Prisma :
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261101200000_reseaux_physiques_logiques';
