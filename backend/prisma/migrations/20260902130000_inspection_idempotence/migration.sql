-- Idempotence de la synchronisation des inspections (T7).
--
-- LE DEFAUT
--
-- La version d'origine creait l'inspection, envoyait les photos, et ne retirait
-- l'element de la file locale qu'apres le succes de TOUTES les photos. Une coupure
-- pendant l'envoi d'une photo laissait donc l'element complet en attente, et la
-- synchronisation suivante RECREAIT l'inspection. Un doublon par tentative, sur le
-- module cense produire la donnee du reseau.
--
-- POURQUOI LE CORRECTIF CLIENT NE SUFFIT PAS
--
-- Le correctif deja livre persiste l'identifiant serveur des la creation reussie, ce
-- qui supprime la cause la plus frequente. Mais il ne ferme pas tous les cas : si la
-- reponse HTTP se perd en chemin, le client conclut a un echec alors que le serveur a
-- bien enregistre. Il retentera, et rien cote serveur ne s'y oppose.
--
-- Seule une garantie SERVEUR ferme ce cas. `clientInspectionId` est genere par le
-- client AVANT le premier envoi et ne change jamais, quel que soit le nombre de
-- tentatives. L'unicite en base rend la seconde creation impossible ; l'API renvoie
-- alors l'inspection deja creee au lieu d'en fabriquer une seconde.
--
-- POURQUOI NULLABLE
--
-- Les inspections deja en base — une seule au 01/09/2026 — n'en ont pas, et les
-- clients anciens n'en enverront pas. En PostgreSQL, un index unique tolere plusieurs
-- NULL : les enregistrements sans identifiant client coexistent sans se bloquer.
--
-- REVERSIBILITE
--
--     DROP INDEX "inspections_clientInspectionId_key";
--     ALTER TABLE "inspections" DROP COLUMN "clientInspectionId";

ALTER TABLE "inspections"
  ADD COLUMN IF NOT EXISTS "clientInspectionId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "inspections_clientInspectionId_key"
  ON "inspections" ("clientInspectionId");
