-- Section de référencement kilométrique (P5).
--
-- CE QUE CETTE COLONNE REVELE
--
-- Le referencement PK de la BDRI etait tenu pour inexploitable. BDRI-CHANTIERS-
-- GEOLOCALISATION.md l'ecrit noir sur blanc : « sur la RN5, six troncons commencent
-- a PK 0 ; la somme des intervalles vaut 433 km pour un PK maximum de 156 », et
-- « sur les 14 emprises extraites, zero trouve un troncon qui la couvre ».
--
-- C'etait faux, et la mesure du 05/09/2026 le montre. Les PK ne sont pas globaux sur
-- l'axe : ils sont RELATIFS A UNE SECTION, et chaque section repart de zero.
--
--     GN N0001 0        0,0 -> 16,7     GN N0001 1-1054   0,0 ->  5,8
--     GN N0001 0-1567  16,7 -> 33,3     GN N0001 1        5,8 -> 15,2
--                                       GN N0001 1-1055  15,2 -> 17,8
--
-- Verifie sur tout le reseau : 88 sections sur 90 sont chainees sans trou ni
-- recouvrement a moins de 500 m pres, soit 549 troncons sur 551. Les deux restantes
-- n'ont qu'un seul troncon. Et les 551 intervalles concordent avec la longueur reelle
-- du trace a moins de 5 % — 13,5 km d'intervalle moyen pour 13,5 km de geometrie.
--
-- Le referencement n'est donc pas casse. Il est coherent, et rien dans le schema ne
-- declarait la cle qui le rend lisible. Tout consommateur supposant un kilometrage
-- global produisait du non-sens — c'est ce qui a fait echouer la projection des
-- emprises de chantiers.
--
-- CE QUE LA SECTION DEBLOQUE, MESURE
--
-- Sur les 12 chantiers dont l'intitule porte une designation et deux PK : 4 se
-- resolvent a UNE SEULE section — donc directement localisables — et 5 a deux ou
-- trois, ce qu'un agent tranche sur piece. Contre zero auparavant.
--
-- POURQUOI NULLABLE, ET POURQUOI PAS D'EXTRACTION ICI
--
-- 261 386 troncons existent, dont la voirie promue qui n'a pas de section : une
-- colonne obligatoire imposerait d'inventer une valeur. Elle reste donc nulle par
-- defaut, et le script scripts/extraire-section-pk.ts la renseigne — rejouable,
-- verifiable, et trace comme DERIVED dans valeurs_qualite puisqu'elle est LUE dans le
-- code et non saisie.
--
-- REVERSIBILITE
--
--     DROP INDEX "troncons_section_pk_idx";
--     ALTER TABLE "troncons" DROP COLUMN "sectionPk";

ALTER TABLE "troncons" ADD COLUMN IF NOT EXISTS "sectionPk" TEXT;

-- Retrouver les troncons d'une section, ordonnes par PK, est la requete que posera
-- toute projection d'emprise et tout futur calcul d'itineraire.
CREATE INDEX IF NOT EXISTS "troncons_section_pk_idx"
  ON "troncons" ("nom", "sectionPk", "pkDebut")
  WHERE "sectionPk" IS NOT NULL;
