-- APPLICABILITE D'UN TYPE DE DEFAUT : REVETU, NON_REVETU, TOUS (paragraphe 7.16, etoile)
--
-- Le paragraphe 7.16 fixe le plancher du catalogue : « >= 21 types, revetu / non revetu ». La
-- distinction n'existait pas dans la table : une tole ondulee pouvait etre relevee sur une
-- chaussee bitumee sans que rien ne le signale. En Guinee la majorite du reseau n'est pas
-- revetue ; c'est precisement la ou le catalogue des treize types, pense pour la chaussee
-- revetue, laissait l'agent sans mot juste.
--
-- CE QUE CETTE MIGRATION FAIT : une colonne, a defaut TOUS, en TEXTE contraint et non en
-- enumeration -- lecon D-06, ALTER TYPE ADD VALUE est irreversible. Les treize lignes de
-- production recoivent TOUS, ce qui ne change rien a leur comportement : la restriction est
-- posee ensuite par le script de peuplement, type par type, et reste modifiable dans
-- l'administration.
--
-- CE QU'ELLE NE FAIT PAS : semer les dix-huit nouveaux types. Le catalogue est une donnee
-- metier administrable, semee par `scripts/peupler-catalogue-defauts.ts`, idempotent, qui ne
-- touche jamais une ligne existante. La base de developpement a zero ligne dans cette table :
-- les treize types de production n'ont jamais ete une migration, et les suivants ne le sont
-- pas davantage.
--
-- NATURE : additive, une colonne avec defaut. Aucune ligne modifiee.

ALTER TABLE "catalogue_defauts"
  ADD COLUMN IF NOT EXISTS "applicabilite" TEXT NOT NULL DEFAULT 'TOUS';

ALTER TABLE "catalogue_defauts"
  DROP CONSTRAINT IF EXISTS "catalogue_applicabilite_connue";
ALTER TABLE "catalogue_defauts"
  ADD CONSTRAINT "catalogue_applicabilite_connue"
  CHECK ("applicabilite" IN ('REVETU', 'NON_REVETU', 'TOUS'));

COMMENT ON COLUMN "catalogue_defauts"."applicabilite" IS
  'Sur quel type de chaussee ce defaut a un sens : REVETU, NON_REVETU ou TOUS (paragraphe 7.16). '
  'Permet de refuser une tole ondulee sur une chaussee bitumee. Modifiable dans l''administration.';
