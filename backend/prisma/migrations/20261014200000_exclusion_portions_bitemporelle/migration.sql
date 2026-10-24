-- LA CONTRAINTE D'EXCLUSION DE `portions` IGNORAIT L'AXE TERRAIN. Correction.
--
-- DECOUVERT EN TESTANT, le 14/10/2026, et c'est la raison d'etre de ce fichier.
--
-- La migration `20261013180000_portions_homogenes` a cree :
--
--   EXCLUDE USING gist ("tronconId" WITH =, numrange("debutM", "finM", '[)') WITH &&)
--     WHERE ("statutValidation" = 'VALIDE' AND "remplaceeLe" IS NULL AND "deletedAt" IS NULL)
--
-- Elle garantit qu'une emprise metrique n'est qualifiee qu'une fois. C'etait juste AVANT que
-- `20261014170000_historisation_bitemporelle` n'ajoute l'axe terrain `valideDu` / `valideAu`.
--
-- LE DEFAUT, ET POURQUOI IL REND L'AXE TERRAIN INUTILISABLE
--
-- Soit une portion [120 m, 400 m) en BON etat du 01/01 au 01/06, reprise ensuite, donc MAUVAIS
-- a partir du 01/06. Ce sont DEUX FAITS QUI NE SE CONTREDISENT PAS : ils portent sur des
-- periodes de terrain disjointes, et les deux sont crus aujourd'hui. Aucun ne remplace l'autre,
-- donc `remplaceeLe` doit rester nul sur les deux.
--
-- La contrainte les refusait pourtant, parce qu'elle ne regarde que l'emprise metrique. Le seul
-- contournement etait de poser `remplaceeLe` sur l'ancienne version -- c'est-a-dire d'employer
-- une date SYSTEME pour exprimer une succession TERRAIN, en confondant precisement les deux axes
-- que l'ADR-007 a separes.
--
-- Et la consequence etait silencieuse : l'axe terrain existait en colonnes, se testait dans
-- `reseau/bitemporel.ts`, mais aucune donnee ne pouvait l'exercer en base. Le defaut n'est
-- apparu qu'en ecrivant le banc d'essai des sections fixes, qui a essaye d'inserer les deux
-- versions.
--
-- LA CORRECTION
--
-- L'exclusion porte desormais sur le COUPLE (emprise metrique, periode de terrain). Deux
-- versions ne se heurtent que si elles se chevauchent SUR LES DEUX AXES.
--
-- BORNES NULLES : `daterange(NULL, NULL, '[)')` est l'intervalle infini, qui chevauche tout.
-- C'est la lecture voulue et c'est la plus prudente -- une portion dont personne ne sait depuis
-- quand elle est vraie revendique implicitement toute l'histoire, et doit donc entrer en
-- conflit avec toute autre version de la meme emprise. Traiter l'inconnu comme un intervalle
-- vide aurait laisse passer des doublons.
--
-- NATURE : additive au sens des donnees. Aucune ligne n'est ecrite, modifiee ni supprimee. La
-- contrainte est remplacee par une STRICTEMENT PLUS PERMISSIVE : tout etat de la base qui
-- satisfaisait l'ancienne satisfait la nouvelle, donc la recreation ne peut pas echouer sur des
-- donnees existantes. `portions` comptait par ailleurs 0 ligne en production au 14/10.
--
-- L'INVERSE SERAIT FAUX, et il faut le dire pour la descente : une base qui exploite le nouvel
-- axe peut contenir deux versions que l'ANCIENNE contrainte refuse. La descente peut donc
-- echouer, legitimement. Voir `prisma/descentes/`.
--
-- DEPEND DE `20261014170000_historisation_bitemporelle`, qui cree `valideDu` et `valideAu`.
-- Les deux doivent etre deployees ensemble, et dans cet ordre.

ALTER TABLE "portions"
  DROP CONSTRAINT IF EXISTS "portion_validee_sans_chevauchement";

ALTER TABLE "portions"
  ADD CONSTRAINT "portion_validee_sans_chevauchement"
  EXCLUDE USING gist (
    "tronconId" WITH =,
    numrange("debutM"::numeric, "finM"::numeric, '[)') WITH &&,
    daterange("valideDu", "valideAu", '[)') WITH &&
  )
  WHERE (
    "statutValidation" = 'VALIDE'
    AND "remplaceeLe" IS NULL
    AND "deletedAt" IS NULL
  );

COMMENT ON CONSTRAINT "portion_validee_sans_chevauchement" ON "portions" IS
  'Une emprise metrique n''est qualifiee qu''une fois PAR PERIODE DE TERRAIN. Le troisieme '
  'operande -- daterange("valideDu","valideAu") -- a ete ajoute le 14/10/2026 : sans lui, deux '
  'versions valides a des periodes disjointes se heurtaient, et l''axe terrain de la '
  'bitemporalite etait inexploitable. Une borne nulle vaut l''infini, donc chevauche tout.';
