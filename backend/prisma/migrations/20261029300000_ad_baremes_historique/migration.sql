-- AIDE A LA DECISION, LOT 6 : HISTORIQUE DES BAREMES ET JOURNAL DES EXPORTS
--
-- Deux tables, en AJOUT SEUL (declencheur) : rien n'est modifie ni supprime dans le patrimoine, les marches, les
-- budgets ni le moteur de programmation.
--
-- 1. `baremes_historique` : l'HISTORIQUE d'une ligne de bareme. Jusqu'ici une ligne etait modifiee SUR PLACE
--    (`version` + 1) sans aucune trace de ce qu'elle valait avant : le moteur de cout cite une ligne par son
--    identifiant, mais personne ne pouvait dire quel prix elle portait la veille, ni qui l'avait change. Chaque
--    modification et chaque approbation ecrit UNE ligne ici, dans la MEME transaction que la mutation (la route le
--    fait ; une panne d'ecriture annule la modification) : valeurs avant et apres, auteur, motif, commentaire, version
--    et statut d'approbation apres l'evenement.
--
--    L'auteur d'une VERSION (la derniere modification qui a change le calcul) sert la separation des taches : celui
--    qui a pose un prix ne l'approuve pas (`AUTO_VALIDATION`, governance/separation-taches.ts).
--
-- 2. `exports_journal` : le JOURNAL des exports gouvernes (qui, quand, type, filtres, perimetre, nombre de lignes,
--    empreinte SHA-256 du fichier remis). Un export de donnees patrimoniales ou financieres doit pouvoir etre retrouve
--    et rapproche du fichier qui circule.
--
-- IMMUTABILITE, PAR DECLENCHEUR. Un historique que l'on peut reecrire n'est pas un historique : DELETE refuse, UPDATE
-- refuse (seul l'effacement du compte auteur, `ON DELETE SET NULL`, peut mettre `auteurId` a NULL ; `auteurEmail`
-- garde alors qui c'etait). Une contrainte CHECK ne regarde qu'une ligne a la fois et l'absence de route de
-- modification ne protege pas d'un acces direct a la base : c'est le declencheur qui tient l'invariant.
--
-- AUCUNE DONNEE SEMEE : les neuf lignes de bareme d'origine n'ont pas d'historique (personne ne sait qui les a posees,
-- `standard_initial`) ; elles n'ont donc pas d'auteur a opposer a l'approbateur, comme les ouvrages importes sans
-- auteur dans `validationPermise`.
--
-- NATURE : additive, idempotente (IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER IF EXISTS). Reversible : voir
-- descentes/20261029300000_ad_baremes_historique.sql.

CREATE TABLE IF NOT EXISTS "baremes_historique" (
  "id"                       SERIAL PRIMARY KEY,
  "baremeId"                 INTEGER NOT NULL REFERENCES "baremes_intervention"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Version de la ligne APRES l'evenement (une modification de libelle ou de commentaire ne la change pas).
  "version"                  INTEGER NOT NULL,
  "evenement"                TEXT NOT NULL,
  "champsModifies"           TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  -- Vrai si au moins un champ qui change le CALCUL (prix, unite, devise, validite, millesime, largeur, source) a change.
  "modifieCalcul"            BOOLEAN NOT NULL DEFAULT false,
  "approbationReinitialisee" BOOLEAN NOT NULL DEFAULT false,
  "statutApprobation"        TEXT NOT NULL,
  "valeursAvant"             JSONB NOT NULL,
  "valeursApres"             JSONB NOT NULL,
  "auteurId"                 TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE SET NULL,
  "auteurEmail"              TEXT NOT NULL,
  "motif"                    TEXT NOT NULL,
  "commentaire"              TEXT,
  -- Horloge du serveur de base de donnees, posee par le declencheur.
  "creeLe"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "baremes_hist_evenement" CHECK ("evenement" IN ('MODIFICATION', 'APPROBATION')),
  CONSTRAINT "baremes_hist_statut" CHECK ("statutApprobation" IN ('APPROUVE', 'NON_APPROUVE')),
  CONSTRAINT "baremes_hist_motif_non_vide" CHECK (length(btrim("motif")) > 0),
  -- Une approbation sans commentaire est une signature sans lecture : refusee en base comme a la porte.
  CONSTRAINT "baremes_hist_approbation_commentee" CHECK ("evenement" <> 'APPROBATION' OR length(btrim(coalesce("commentaire", ''))) > 0),
  CONSTRAINT "baremes_hist_modification_nommee" CHECK ("evenement" <> 'MODIFICATION' OR cardinality("champsModifies") > 0),
  -- Une approbation approuve : le statut qu'elle laisse ne peut pas etre autre chose.
  CONSTRAINT "baremes_hist_approbation_approuve" CHECK ("evenement" <> 'APPROBATION' OR "statutApprobation" = 'APPROUVE'),
  CONSTRAINT "baremes_hist_version_positive" CHECK ("version" >= 1)
);
CREATE INDEX IF NOT EXISTS "baremes_historique_bareme_idx" ON "baremes_historique" ("baremeId", "id" DESC);
CREATE INDEX IF NOT EXISTS "baremes_historique_auteur_idx" ON "baremes_historique" ("auteurId") WHERE "auteurId" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "exports_journal" (
  "id"              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  -- synthese | reseau_regions | interventions | scenario | selection:<table>
  "type"            TEXT NOT NULL,
  "format"          TEXT NOT NULL,
  "auteurId"        TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE SET NULL,
  "auteurEmail"     TEXT NOT NULL,
  "auteurRole"      TEXT NOT NULL,
  "filtres"         JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- { libelle, national, regionIds } : ce que le compte pouvait voir, pas ce qu'il a demande.
  "perimetre"       JSONB NOT NULL DEFAULT '{}'::jsonb,
  "nbLignes"        INTEGER NOT NULL,
  "tailleOctets"    INTEGER NOT NULL,
  -- SHA-256 du fichier tel que remis : permet de rapprocher un fichier qui circule de son export.
  "empreinteSha256" TEXT NOT NULL,
  "droitFinancier"  BOOLEAN NOT NULL,
  "colonnesRetirees" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "creeLe"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "exports_journal_format" CHECK ("format" IN ('csv', 'json', 'geojson')),
  CONSTRAINT "exports_journal_empreinte_hex" CHECK ("empreinteSha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "exports_journal_compteurs" CHECK ("nbLignes" >= 0 AND "tailleOctets" >= 0)
);
CREATE INDEX IF NOT EXISTS "exports_journal_recent_idx" ON "exports_journal" ("creeLe" DESC);
CREATE INDEX IF NOT EXISTS "exports_journal_auteur_idx" ON "exports_journal" ("auteurId", "creeLe" DESC);

CREATE OR REPLACE FUNCTION ad_ajout_seul() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% : DELETE refuse, la table est en ajout seul.', TG_TABLE_NAME
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Seule exception : l'effacement du compte auteur (ON DELETE SET NULL), qui ne touche QUE auteurId.
    IF (to_jsonb(NEW) - 'auteurId') IS DISTINCT FROM (to_jsonb(OLD) - 'auteurId') OR NEW."auteurId" IS NOT NULL THEN
      RAISE EXCEPTION '% : UPDATE refuse, la table est en ajout seul.', TG_TABLE_NAME
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  NEW."creeLe" := CURRENT_TIMESTAMP(3);
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS baremes_historique_ajout_seul ON "baremes_historique";
CREATE TRIGGER baremes_historique_ajout_seul
  BEFORE INSERT OR UPDATE OR DELETE ON "baremes_historique"
  FOR EACH ROW EXECUTE FUNCTION ad_ajout_seul();

DROP TRIGGER IF EXISTS exports_journal_ajout_seul ON "exports_journal";
CREATE TRIGGER exports_journal_ajout_seul
  BEFORE INSERT OR UPDATE OR DELETE ON "exports_journal"
  FOR EACH ROW EXECUTE FUNCTION ad_ajout_seul();

COMMENT ON TABLE "baremes_historique" IS
  'Historique en ajout seul des lignes de bareme : une ligne par modification ou approbation, ecrite dans la meme transaction que la mutation. Valeurs avant et apres, auteur, motif, commentaire, version, statut d''approbation. L''auteur de la version sert la separation des taches (l''approbateur n''est jamais l''auteur).';
COMMENT ON TABLE "exports_journal" IS
  'Journal en ajout seul des exports : qui, quand, type, filtres, perimetre, nombre de lignes, empreinte SHA-256 du fichier remis. Ecrit avant la remise du fichier : pas de fichier sans trace.';
