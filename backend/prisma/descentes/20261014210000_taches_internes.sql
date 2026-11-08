-- RETOUR ARRIERE de `20261014210000_taches_internes`.
--
-- REJOUEE ET VERIFIEE le 22/10/2026 par le banc `verifier.sh` : le schema apres descente differe de
-- celui d'avant par la seule table de vocabulaire conservee, declaree plus bas (RESIDU-ACCEPTE).
--
-- EXECUTE ET VERIFIE le 14/10/2026 en aller-retour sur la base de developpement
-- `postgis/postgis:17-3.5`. Voir `MIGRATION_PLAN.md`.
--
-- CETTE DESCENTE DETRUIT DES DONNEES SI LA TABLE EN PORTE. Elle supprime `taches_internes`
-- entierement : le travail de regie trace par les equipes disparaitrait sans recours, preuves
-- avant/apres comprises.
--
-- COMPTER AVANT, TOUJOURS :
--
--   SELECT count(*) AS taches,
--          count(*) FILTER (WHERE "statut" = 'CLOTUREE') AS cloturees,
--          count(*) FILTER (WHERE "preuveApresChemin" IS NOT NULL) AS avec_preuve
--     FROM taches_internes;
--
-- Si ce comptage n'est pas nul, la descente EXIGE une sauvegarde verifiee et une autorisation
-- explicite (paragraphe A.5.2). Le paragraphe A.5.8 interdit toute suppression silencieuse, et
-- effacer la trace de ce qu'AGEROUTE a execute elle-meme en serait une.
--
-- Au 14/10/2026 la table n'existe pas encore en production, donc la descente ne perd rien. Ce
-- n'est vrai qu'a cette date.
--
-- ORDRE : la table d'abord, son referentiel ensuite -- la cle etrangere l'impose.

DROP TABLE IF EXISTS "taches_internes";

DROP TYPE IF EXISTS "StatutTacheInterne";

-- Le referentiel des natures n'est PAS supprime par defaut.
--
-- C'est un vocabulaire administrable : si quelqu'un y a ajoute des natures propres a AGEROUTE
-- depuis le semis du mandat, les effacer serait une perte invisible, et il n'y a aucune urgence
-- a le faire -- une table de vocabulaire orpheline ne gene rien. Pour le retirer sciemment :
--
--   DROP TABLE IF EXISTS "referentiel_natures_tache";

-- RESIDU-ACCEPTE: (col|con|idx)[|]referentiel_natures_tache[.]|rel[|]referentiel_natures_tache[|]
--
-- (La ligne ci-dessus est lue par le banc `verifier.sh` : elle declare que la table de vocabulaire
-- est LAISSEE EN PLACE, et c'est la seule difference acceptee entre le schema d'avant la migration
-- et celui d'apres cette descente.)
--
-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261014210000_taches_internes';
--
-- Volontairement absente : ce geste doit etre conscient, pas un effet de bord.
