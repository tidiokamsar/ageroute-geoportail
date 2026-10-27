-- FICHE D'INSPECTION TERRAIN : CONSTAT, METHODE, SECTION, MISSION, VALIDATION (BDRI, lot F)
--
-- Ajoute a `inspections` ce qu'une fiche de terrain doit pouvoir dire sans le cacher dans un texte libre :
--   * `constatDefauts` distingue « aucun defaut observe » de « non inspecte », d'« inconnu » et de « non
--     applicable » : quatre situations que `defautsConstates` vide confondait toutes ;
--   * `methodeObservation` et `conditionsObservation` : une appreciation VISUELLE reste identifiee comme telle
--     (aucun IRI, aucune portance ne se deduit d'ici) ;
--   * la SECTION observee : une portion existante, ou un intervalle d'abscisses en metres (une inspection peut
--     porter sur une partie du troncon ; elle ne cree pas de troncon de reference) ;
--   * la MISSION de rattachement ;
--   * `statutValidation` : l'avis d'un responsable, journalise dans `validations`.
--
-- NATURE : additive. Colonnes NULLABLES, sans valeur par defaut : les inspections existantes gardent exactement ce
-- qu'elles disaient, et rien n'est deduit pour elles (une ancienne inspection n'est pas « aucun defaut observe »).
-- REVERSIBILITE : voir backend/prisma/descentes/20261027120000_inspection_terrain_complements.sql.

ALTER TABLE "inspections"
  ADD COLUMN IF NOT EXISTS "constatDefauts"        TEXT,
  ADD COLUMN IF NOT EXISTS "methodeObservation"    TEXT,
  ADD COLUMN IF NOT EXISTS "conditionsObservation" TEXT,
  ADD COLUMN IF NOT EXISTS "missionId"             TEXT REFERENCES "missions"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS "portionId"             TEXT REFERENCES "portions"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS "debutM"                DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "finM"                  DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "statutValidation"      "StatutValidation";

ALTER TABLE "inspections"
  ADD CONSTRAINT "inspection_constat_connu" CHECK ("constatDefauts" IS NULL OR "constatDefauts" IN ('DEFAUTS_RELEVES','AUCUN_DEFAUT_OBSERVE','NON_INSPECTE','INCONNU','NON_APPLICABLE')),
  ADD CONSTRAINT "inspection_methode_connue" CHECK ("methodeObservation" IS NULL OR "methodeObservation" IN ('VISUELLE_A_PIED','VISUELLE_EN_VEHICULE','AUTRE')),
  ADD CONSTRAINT "inspection_section_bornes" CHECK (("debutM" IS NULL) = ("finM" IS NULL)),
  ADD CONSTRAINT "inspection_section_ordre" CHECK ("debutM" IS NULL OR ("debutM" >= 0 AND "finM" > "debutM")),
  ADD CONSTRAINT "inspection_section_une_definition" CHECK ("portionId" IS NULL OR "debutM" IS NULL);

CREATE INDEX IF NOT EXISTS "inspections_missionId_idx" ON "inspections" ("missionId");
CREATE INDEX IF NOT EXISTS "inspections_statutValidation_idx" ON "inspections" ("statutValidation");
