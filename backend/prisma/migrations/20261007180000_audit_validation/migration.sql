-- Trois actions d'audit manquantes : VALIDATE, REJECT, SYNC_CONFLICT.
--
-- POURQUOI
--
-- Le point 31 du master prompt RAI V3 enumere ce qui doit etre audite : CREATE,
-- UPDATE, DELETE, RESTORE, VALIDATE, REJECT, LOGIN, SECURITY_EVENT, SYNC_CONFLICT.
-- L'enumeration en portait six sur neuf.
--
-- Ce n'est pas une lacune cosmetique. La validation d'une observation est l'acte qui
-- fait passer une PROPOSITION au rang de donnee officielle : c'est exactement ce
-- qu'un auditeur vient relire. L'enregistrer sous UPDATE la noierait parmi les
-- modifications ordinaires, et il faudrait relire les champs pour la distinguer.
--
-- POURQUOI PAS DE TRANSACTION
--
-- PostgreSQL interdit d'UTILISER une valeur d'enumeration dans la transaction qui
-- l'ajoute. Prisma enveloppe chaque migration dans une transaction ; les trois ajouts
-- y survivent, mais aucune ecriture ne doit s'en servir avant la fin de la migration.
-- Rien ici n'en ecrit : la migration ajoute, elle n'emploie pas.
--
-- IF NOT EXISTS : rejouable sans erreur, contrairement a un ADD VALUE nu.
--
-- REVERSIBILITE
--
-- Aucune. PostgreSQL ne sait pas retirer une valeur d'enumeration. C'est sans
-- consequence : une valeur inutilisee ne coute rien, et la retirer casserait toute
-- ligne d'audit qui la porte — or une ligne d'audit ne se reecrit pas.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'VALIDATE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'REJECT';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SYNC_CONFLICT';
