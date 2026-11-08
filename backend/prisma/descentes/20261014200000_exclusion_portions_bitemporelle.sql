-- RETOUR ARRIERE de `20261014200000_exclusion_portions_bitemporelle`.
--
-- Il restaure la contrainte d'exclusion telle que `20261013180000_portions_homogenes` l'avait
-- creee : sur l'emprise metrique seule, sans l'axe terrain.
--
-- CETTE DESCENTE PEUT ECHOUER, ET C'EST CORRECT.
--
-- La montee remplace une contrainte par une strictement PLUS PERMISSIVE. La descente fait donc
-- l'inverse, et une contrainte plus stricte peut etre refusee par les donnees deja presentes :
-- si la base contient deux versions d'une meme emprise valides a des periodes de terrain
-- disjointes -- exactement ce que la montee autorise -- l'ancienne contrainte les voit comme un
-- doublon et `ADD CONSTRAINT` echoue.
--
-- Un echec ici n'est donc pas un bogue du script : c'est la base qui dit « j'exploite l'axe
-- terrain, vous ne pouvez plus revenir sans choisir quoi perdre ». Le compter AVANT :
--
--   SELECT a."tronconId", a."debutM", a."finM", count(*)
--     FROM portions a
--     JOIN portions b
--       ON b."tronconId" = a."tronconId" AND b.id <> a.id
--      AND numrange(a."debutM"::numeric, a."finM"::numeric, '[)')
--       && numrange(b."debutM"::numeric, b."finM"::numeric, '[)')
--    WHERE a."statutValidation" = 'VALIDE' AND a."remplaceeLe" IS NULL AND a."deletedAt" IS NULL
--      AND b."statutValidation" = 'VALIDE' AND b."remplaceeLe" IS NULL AND b."deletedAt" IS NULL
--    GROUP BY 1, 2, 3;
--
-- Si ce comptage rend des lignes, la descente exige une decision humaine sur ce qui est conserve
-- -- jamais une suppression automatique. Le paragraphe A.5.8 proscrit toute suppression
-- silencieuse de donnees, et choisir a la place de l'agent quelle version du terrain survit en
-- serait une.
--
-- EXECUTE ET VERIFIE le 14/10/2026 en aller-retour sur la base de developpement, avec zero
-- ligne en conflit. Voir `MIGRATION_PLAN.md`.

ALTER TABLE "portions"
  DROP CONSTRAINT IF EXISTS "portion_validee_sans_chevauchement";

ALTER TABLE "portions"
  ADD CONSTRAINT "portion_validee_sans_chevauchement"
  EXCLUDE USING gist (
    "tronconId" WITH =,
    numrange("debutM"::numeric, "finM"::numeric, '[)') WITH &&
  )
  WHERE (
    "statutValidation" = 'VALIDE'
    AND "remplaceeLe" IS NULL
    AND "deletedAt" IS NULL
  );

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261014200000_exclusion_portions_bitemporelle';
--
-- Volontairement absente : ce geste doit etre conscient, pas un effet de bord.
