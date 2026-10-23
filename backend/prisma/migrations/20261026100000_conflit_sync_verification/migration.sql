-- DEMANDE DE VERIFICATION SUR UN CONFLIT DE SYNCHRONISATION (scenario A8)
--
-- Un responsable qui ne peut pas trancher un conflit (les deux versions lui paraissent plausibles, ou il
-- faut appeler l'agent) n'avait que deux gestes : retenir la version du serveur, ou celle du telephone.
-- Aucun des deux ne dit « je ne sais pas encore ». Il fallait choisir, ou laisser le conflit sans trace
-- de ce qui avait ete tente.
--
-- Cette demande NE TRANCHE PAS : `resolution` reste nulle, le conflit reste ouvert, les deux versions
-- restent conservees (payloadLocal, payloadServeur) et l'operation du telephone reste en CONFLIT. Elle
-- consigne seulement qui a demande une verification, quand, et pourquoi.
--
-- NATURE : additive. Trois colonnes nulles, aucune ligne existante n'est modifiee, aucune valeur inventee.
-- La coherence est tenue par la base : une demande porte toujours son auteur.

ALTER TABLE "conflits_sync"
  ADD COLUMN "verificationDemandeeA" TIMESTAMP(3),
  ADD COLUMN "verificationDemandeeParId" TEXT,
  ADD COLUMN "verificationMotif" TEXT;

ALTER TABLE "conflits_sync"
  ADD CONSTRAINT "conflit_verification_porte_son_auteur"
  CHECK ("verificationDemandeeA" IS NULL OR "verificationDemandeeParId" IS NOT NULL);
