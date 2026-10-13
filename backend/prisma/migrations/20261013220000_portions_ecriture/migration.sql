-- AGEROUTE ROAD : ce qu'il manquait pour ECRIRE des portions.
--
-- Deux ajouts, et l'un des deux est definitif.
--
-- 1. `PORTION` DANS `DomaineValidation`
--
-- Une portion de terrain est une PROPOSITION jusqu'a validation par un tiers. Le mecanisme
-- existe depuis le 13/10 (`governance/validation.ts`, `governance/delegation.ts`), mais son
-- enum de domaines ne connaissait pas les portions : aucun validateur ne pouvait etre
-- designe pour elles, et `validationPermise` aurait refuse toute decision avec
-- ENTITE_NON_VALIDABLE.
--
-- CE `ALTER TYPE ADD VALUE` EST IRREVERSIBLE. PostgreSQL n'a pas de
-- `ALTER TYPE ... DROP VALUE`. Meme situation que les trois valeurs ajoutees a
-- `AuditAction` le 7 octobre : sans consequence, une valeur d'enum que personne n'ecrit ne
-- coute rien, mais le retour arriere ne rend pas la base a son etat d'origine au sens
-- strict et le pretendre serait faux.
--
-- 2. `clientOperationId` SUR `portions`
--
-- Cle d'idempotence generee par l'APPAREIL avant tout envoi, comme sur `observations` et
-- `defauts`. Sans elle, une reponse perdue en zone blanche fait renvoyer l'operation et
-- cree une seconde portion sur la meme emprise. Deux portions proposees sur les memes
-- metres ne violent pas la contrainte d'exclusion, qui ne porte que sur le valide : le
-- doublon passerait donc sans bruit jusqu'a l'arbitrage, ou quelqu'un perdrait du temps a
-- comprendre pourquoi la meme chose est dite deux fois.
--
-- OPTIONNELLE, et c'est voulu : une portion creee depuis la console n'en a pas besoin.
-- UNIQUE, pour que la base refuse le doublon meme si le service oublie de verifier.
--
-- CETTE MIGRATION EST ADDITIVE ET N'ECRIT AUCUNE LIGNE.

-- `ADD VALUE IF NOT EXISTS` rend la migration rejouable sur une base ou elle aurait ete
-- appliquee partiellement. Meme forme que `20261007180000_audit_validation`.
ALTER TYPE "DomaineValidation" ADD VALUE IF NOT EXISTS 'PORTION';

ALTER TABLE "portions" ADD COLUMN "clientOperationId" TEXT;

CREATE UNIQUE INDEX "portions_clientOperationId_key"
  ON "portions"("clientOperationId");
