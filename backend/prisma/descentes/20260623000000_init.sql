-- RETOUR ARRIERE de `20260623000000_init`.
--
-- Cree les extensions PostGIS, onze types enumeres et neuf tables : users, refresh_tokens, regions, troncons, ouvrages, points_noirs, postes, chantiers, inspections, audit_logs.
--
-- IRREVERSIBLE
--
-- CETTE DESCENTE NE S'EXECUTE JAMAIS : elle refuse et ne modifie rien.
--
-- POURQUOI : la migration init cree tout le patrimoine routier (troncons, ouvrages, points noirs, postes, chantiers, inspections, utilisateurs, journal d'audit). Aucune descente executable n'existe, et il n'y en aura pas : le patrimoine est une donnee d'archive (AGENTS.md, regle 2). Pour revenir a un etat anterieur, restaurer la sauvegarde verifiee ; pour repartir d'une base vide EN DEVELOPPEMENT, recreer la base. Jamais en production.
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 (banc verifier.sh) : elle refuse, et le schema reste inchange.

DO $refus$
BEGIN
  RAISE EXCEPTION 'DESCENTE REFUSEE : la migration init cree tout le patrimoine routier (troncons, ouvrages, points noirs, postes, chantiers, inspections, utilisateurs, journal d''audit). Aucune descente executable n''existe, et il n''y en aura pas : le patrimoine est une donnee d''archive (AGENTS.md, regle 2). Pour revenir a un etat anterieur, restaurer la sauvegarde verifiee ; pour repartir d''une base vide EN DEVELOPPEMENT, recreer la base. Jamais en production.';
END
$refus$;

-- Et la ligne de `_prisma_migrations`, seulement apres une restauration complete :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260623000000_init';
