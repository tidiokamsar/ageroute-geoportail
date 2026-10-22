-- RETOUR ARRIERE de `20261015000000_praticabilite_p1_p4_provisoire`.
--
-- Retire les quatre lignes semees -- et SEULEMENT elles, par leur source. Une ligne ajoutee ou
-- approuvee par AGEROUTE depuis le semis porte une autre source ou une approbation, et n'est pas
-- touchee.
--
-- CE QUE CETTE DESCENTE PEUT DETRUIRE : si des portions portent deja P1-P4, la cle etrangere
-- `portions.praticabilite -> referentiel_praticabilites(code)` est en ON DELETE SET NULL : les
-- portions perdraient leur niveau SANS ERREUR. Compter avant :
--
--   SELECT praticabilite, count(*) FROM portions
--    WHERE praticabilite IN ('P1','P2','P3','P4') GROUP BY 1;
--
-- Si ce comptage n'est pas nul, la descente exige une sauvegarde verifiee et une autorisation
-- explicite (paragraphe A.5.2) : effacer en silence le niveau de praticabilite d'une portion est
-- precisement la suppression que le paragraphe A.5.8 interdit.

DELETE FROM "referentiel_praticabilites"
 WHERE "code" IN ('P1', 'P2', 'P3', 'P4')
   AND "source" = 'mandat_v10_proposition'
   AND "approuveeLe" IS NULL;

-- Le commentaire de table decrit les quatre lignes semees (P1-P4, proposition non approuvee) : sans
-- elles il serait faux. La table n'en portait aucun avant cette migration.
COMMENT ON TABLE "referentiel_praticabilites" IS NULL;

-- Verifiee le 22/10/2026 par le banc `verifier.sh` : schema identique a celui d'avant, apres ajout
-- de la remise a zero du commentaire de table que la premiere version oubliait.

-- Et retirer la ligne de `_prisma_migrations` :
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261015000000_praticabilite_p1_p4_provisoire';
