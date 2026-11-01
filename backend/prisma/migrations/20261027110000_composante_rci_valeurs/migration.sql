-- DERIVE DE SCHEMA : LES DEUX DERNIERES VALEURS DE `ComposanteRci`
--
-- LE CONSTAT (25/10/2026, outil `scripts/verifier-derive-schema.ts`) : `schema.prisma` declare `ENVIRONNEMENT` et
-- `AUTRES` dans l'enumeration `ComposanteRci` (commentaire du 13/10/2026), le code les emploie
-- (`engines/condition.ts`, `engines/condition.collecte.ts`), mais la migration `20261013160000_condition_engine` cree le
-- type avec huit valeurs et aucune migration ne l'altere. Sur une base construite par les seules migrations, ecrire une
-- composante `ENVIRONNEMENT` ou `AUTRES` echoue (`invalid input value for enum`).
--
-- IDEMPOTENTE : `ADD VALUE IF NOT EXISTS`. La production, construite par `db push`, les porte probablement deja : dans ce cas
-- la migration ne change rien. Aucune ligne n'est lue ni ecrite.
--
-- NATURE : additive. REVERSIBILITE : voir descentes/20261027110000_composante_rci_valeurs.sql (reconstruction du type, refusee
-- si une ligne porte l'une des deux valeurs).

ALTER TYPE "ComposanteRci" ADD VALUE IF NOT EXISTS 'ENVIRONNEMENT';
ALTER TYPE "ComposanteRci" ADD VALUE IF NOT EXISTS 'AUTRES';
