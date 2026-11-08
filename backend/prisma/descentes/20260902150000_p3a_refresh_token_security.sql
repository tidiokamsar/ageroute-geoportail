-- RETOUR ARRIERE de `20260902150000_p3a_refresh_token_security`.
--
-- Ajoute tokenHash, familyId, revokedAt, replacedById, reuseDetectedAt a refresh_tokens, calcule les empreintes, remplace l'index unique, SUPPRIME les colonnes token et revoked et ajoute la valeur SECURITY_EVENT a AuditAction.
--
-- IRREVERSIBLE
--
-- CETTE DESCENTE NE S'EXECUTE JAMAIS : elle refuse et ne modifie rien.
--
-- POURQUOI : cette migration a remplace les jetons de rafraichissement STOCKES EN CLAIR par leur empreinte SHA-256, puis supprime les colonnes token et revoked. L'empreinte ne permet pas de retrouver le jeton, et recreer une colonne de jetons en clair serait une REGRESSION DE SECURITE que seule AGEROUTE peut decider. Les jetons sont de toute facon ephemeres (7 jours) : apres un retour arriere de code, les utilisateurs se reconnectent. Chemin de retour : restaurer la sauvegarde verifiee.
--
-- EXECUTEE ET VERIFIEE le 22/10/2026 (banc verifier.sh) : elle refuse, et le schema reste inchange.

DO $refus$
BEGIN
  RAISE EXCEPTION 'DESCENTE REFUSEE : cette migration a remplace les jetons de rafraichissement STOCKES EN CLAIR par leur empreinte SHA-256, puis supprime les colonnes token et revoked. L''empreinte ne permet pas de retrouver le jeton, et recreer une colonne de jetons en clair serait une REGRESSION DE SECURITE que seule AGEROUTE peut decider. Les jetons sont de toute facon ephemeres (7 jours) : apres un retour arriere de code, les utilisateurs se reconnectent. Chemin de retour : restaurer la sauvegarde verifiee.';
END
$refus$;

-- Et la ligne de `_prisma_migrations`, seulement apres une restauration complete :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260902150000_p3a_refresh_token_security';
