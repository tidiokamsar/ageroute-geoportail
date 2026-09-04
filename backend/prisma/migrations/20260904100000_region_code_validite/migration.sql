-- Region : code officiel et validite temporelle (P5).
--
-- POURQUOI MAINTENANT
--
-- Deux decrets du 20 aout 2026 portent la Guinee de 8 a 10 regions administratives
-- (creation de Siguiri et Beyla) et de 33 a 44 prefectures. La base porte les huit
-- anciennes. Ajouter deux lignes ne suffit pas : sans date de validite, un chantier
-- de 2019 rattache a Kankan coexisterait avec une region Siguiri qui n'existait pas
-- a cette date, et plus rien ne dirait laquelle des deux organisations s'applique.
--
-- REFERENTIEL-ADMINISTRATIF-SPEC.md prevoyait deja `ValidFrom` / `ValidTo` et un
-- code. Le document les presentait comme une precaution ; la reforme les rend
-- necessaires.
--
-- LE CODE VIENT D'UN DECRET, PAS D'UNE CONVENTION INTERNE
--
-- Le decret D/2025/055/PRG/CNRD/SGG du 14 avril 2025 codifie les regions en deux
-- chiffres (Conakry 01, Kindia 02, Boke 03, Mamou 04, Labe 05, Faranah 06, Kankan 07,
-- Nzerekore 08) et les prefectures en trois lettres. Ces codes figurent sur les
-- documents d'identite : ils constituent une cle d'appariement stable, ce que les
-- noms libres n'offrent pas — « Nzerekore », « N'Zerekore » et « Nzérékoré » sont
-- trois chaines differentes et une seule region.
--
-- Aucun code n'est attribue a Siguiri et Beyla dans les sources consultees. Leur
-- colonne reste donc NULLE. Inventer 09 et 10 par symetrie serait exactement le
-- genre de comblement que ce projet passe son temps a defaire.
--
-- POURQUOI TOUT EST NULLABLE
--
-- Les huit regions existantes portent 2 040 troncons, 496 chantiers et 126 ouvrages.
-- Une colonne obligatoire imposerait de remplir immediatement des champs dont
-- certains n'ont pas de valeur connue — le mecanisme qui a produit BITUME partout.
--
-- CETTE MIGRATION N'ECRIT AUCUNE DONNEE
--
-- Les codes et les dates sont poses par scripts/referentiel-regions.ts, rejouable et
-- verifiable seul. Une migration qui cree des regions melangerait structure et
-- donnee de reference, et son annulation deviendrait ambigue.
--
-- REVERSIBILITE
--
--     ALTER TABLE "regions" DROP COLUMN "code", DROP COLUMN "validFrom",
--       DROP COLUMN "validTo", DROP COLUMN "source", DROP COLUMN "sourceDate";

ALTER TABLE "regions" ADD COLUMN IF NOT EXISTS "code"       TEXT;
ALTER TABLE "regions" ADD COLUMN IF NOT EXISTS "validFrom"  TIMESTAMP(3);
ALTER TABLE "regions" ADD COLUMN IF NOT EXISTS "validTo"    TIMESTAMP(3);
ALTER TABLE "regions" ADD COLUMN IF NOT EXISTS "source"     TEXT;
ALTER TABLE "regions" ADD COLUMN IF NOT EXISTS "sourceDate" TIMESTAMP(3);

-- Deux regions peuvent porter le meme nom a des periodes differentes, mais jamais le
-- meme code au meme moment. L'unicite porte donc sur le code seul, qui est stable.
CREATE UNIQUE INDEX IF NOT EXISTS "regions_code_key" ON "regions" ("code")
  WHERE "code" IS NOT NULL;

-- Retrouver les regions en vigueur a une date donnee est la requete que toute
-- lecture historique posera.
CREATE INDEX IF NOT EXISTS "regions_validite_idx" ON "regions" ("validFrom", "validTo");
