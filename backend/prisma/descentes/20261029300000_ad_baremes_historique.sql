-- RETOUR ARRIERE de `20261029300000_ad_baremes_historique`.
--
-- Supprime les tables `baremes_historique` et `exports_journal`, leurs declencheurs et la fonction `ad_ajout_seul`.
--
-- CE QUI EST PERDU : tout l'historique des modifications et approbations de baremes (valeurs avant et apres, auteurs,
-- motifs) et tout le journal des exports (qui a exporte quoi, empreintes des fichiers remis). Ni l'un ni l'autre ne se
-- reconstitue : l'etat courant d'une ligne de bareme reste dans `baremes_intervention`, mais pas ce qu'elle valait
-- avant ni qui l'a changee ; un fichier deja remis ne pourra plus etre rapproche de son export. Compter avant :
--
--   SELECT (SELECT count(*) FROM baremes_historique) AS historique, (SELECT count(*) FROM exports_journal) AS exports;
--
-- La migration ne seme aucune ligne : toute ligne est donc une perte. La descente REFUSE de s'executer s'il en existe,
-- et exige une sauvegarde verifiee et une autorisation explicite (paragraphe A.5.2) :
--
--     SET LOCAL bdri.perte_autorisee = 'OUI';   -- dans la meme transaction, avant ce script
--
-- Le declencheur refuse les DELETE ligne a ligne ; DROP TABLE n'est pas un DELETE et passe. Aucun bareme, aucun
-- scenario ni aucune donnee patrimoniale n'est touche.
--
-- EXECUTION : dans UNE transaction, jamais en autocommit :
--
--     psql -v ON_ERROR_STOP=1 -1 -f descentes/20261029300000_ad_baremes_historique.sql
--
-- GARDE-TEST: INSERT INTO "baremes_historique" ("baremeId","version","evenement","champsModifies","modifieCalcul","statutApprobation","valeursAvant","valeursApres","auteurEmail","motif") VALUES (1, 2, 'MODIFICATION', ARRAY['coutKmGnf'], true, 'NON_APPROUVE', '{}'::jsonb, '{}'::jsonb, 'garde@local.invalid', 'garde');
-- GARDE-TEST: INSERT INTO "exports_journal" ("type","format","auteurEmail","auteurRole","nbLignes","tailleOctets","empreinteSha256","droitFinancier") VALUES ('reseau_regions', 'csv', 'garde@local.invalid', 'GESTIONNAIRE', 0, 0, repeat('a', 64), false);
--
-- Verifiee par le banc `verifier.sh` : schema identique a celui d'avant la migration, migration reappliquee a
-- l'identique, gardes eprouvees avec des donnees fabriquees.

DO $garde$
DECLARE h bigint; e bigint;
BEGIN
  SELECT count(*) INTO h FROM "baremes_historique";
  SELECT count(*) INTO e FROM "exports_journal";
  IF (h > 0 OR e > 0) AND coalesce(current_setting('bdri.perte_autorisee', true), '') <> 'OUI' THEN
    RAISE EXCEPTION 'DESCENTE REFUSEE : % ligne(s) d''historique de bareme et % ligne(s) de journal d''export seraient detruites. Ni l''historique ni le journal ne se reconstituent. Sauvegarde verifiee et autorisation explicite requises (A.5.2) ; apres quoi : SET LOCAL bdri.perte_autorisee = ''OUI'';', h, e;
  END IF;
END
$garde$;

DROP TRIGGER IF EXISTS exports_journal_ajout_seul ON "exports_journal";
DROP TRIGGER IF EXISTS baremes_historique_ajout_seul ON "baremes_historique";
DROP TABLE IF EXISTS "exports_journal";
DROP TABLE IF EXISTS "baremes_historique";
DROP FUNCTION IF EXISTS ad_ajout_seul();
