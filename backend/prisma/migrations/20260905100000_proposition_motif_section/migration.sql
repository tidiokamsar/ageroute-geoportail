-- Motif et section d'une proposition de localisation (P5).
--
-- LE TROU QUE CETTE MIGRATION COMBLE
--
-- `generer-propositions-localisation.ts` calcule depuis toujours un MOTIF expliquant
-- pourquoi la proposition est ce qu'elle est — « 12 troncons candidats, aucun ne
-- couvre l'emprise a lui seul ». Il ne l'ecrivait nulle part : il l'affichait a la
-- console, puis le jetait.
--
-- L'agent qui ouvre une proposition voyait donc un intitule, deux PK et une confiance
-- LOW, sans jamais savoir POURQUOI elle est basse ni ce qui reste a trancher. La
-- proposition lui demandait de refaire le raisonnement que le script avait deja fait.
--
-- Le manque devient couteux depuis la decouverte des sections du 05/09/2026. Le motif
-- porte maintenant « section 3 identifiee » ou « 3 sections compatibles, l'intitule
-- ne dit pas laquelle » — c'est-a-dire exactement l'information qui reduit le travail
-- de l'agent. La jeter revenait a refaire le diagnostic pour rien.
--
-- POURQUOI UNE COLONNE `sectionPk` A PART, ET PAS SEULEMENT DU TEXTE
--
-- Le motif est une phrase, faite pour etre lue. La section est une cle, faite pour
-- etre filtree et jointe : « montre-moi les propositions dont la section est
-- identifiee » est la requete qu'un chef de service posera pour distribuer le travail.
-- Une phrase ne repond pas a cette question.
--
-- Elle reste nulle quand plusieurs sections conviennent — l'intitule ne portant pas la
-- section, deviner rattacherait le chantier au mauvais endroit de la route sans que
-- personne ne s'en apercoive.
--
-- CE QUE CETTE MIGRATION NE FAIT PAS
--
-- Elle ne touche aucune proposition existante. Les 90 deja enregistrees gardent un
-- motif nul ; il suffit de rejouer le script, qui est idempotent.
--
-- REVERSIBILITE
--
--     ALTER TABLE "propositions_localisation"
--       DROP COLUMN "motif", DROP COLUMN "sectionPk";

ALTER TABLE "propositions_localisation" ADD COLUMN IF NOT EXISTS "motif" TEXT;
ALTER TABLE "propositions_localisation" ADD COLUMN IF NOT EXISTS "sectionPk" TEXT;

-- Distribuer le travail commence par separer ce qui est tranche de ce qui ne l'est
-- pas : les propositions en attente dont la section est connue sont les plus rapides
-- a traiter.
CREATE INDEX IF NOT EXISTS "propositions_statut_section_idx"
  ON "propositions_localisation" ("statut", "sectionPk");
