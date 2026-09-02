-- P1-01 : suppression logique des decomptes et bailleurs.
--
-- Un decompte est une donnee financiere d'archive (paiements, retenues) : le
-- supprimer physiquement detruit l'historique decaisse d'un marche. Un bailleur
-- est une donnee de reference citee par l'historique des marches. Les deux
-- suivent desormais la regle du reste du patrimoine : deletedAt, jamais DELETE.
--
-- Pas de colonnes deletedBy/deleteReason : le mecanisme d'audit (audit_logs,
-- action DELETE + userId + before) porte deja cette information pour toutes les
-- autres entites — diverger ici creerait deux conventions concurrentes.
ALTER TABLE "decomptes" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "decomptes_deletedAt_idx" ON "decomptes"("deletedAt");

ALTER TABLE "bailleurs" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "bailleurs_deletedAt_idx" ON "bailleurs"("deletedAt");
