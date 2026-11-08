-- INDEX TRIGRAMME SUR troncons.code ET troncons.nom (A20 : recherche < 300 ms)
--
-- LE CONSTAT DU 23/10/2026 (banc backend/tests-integration/perf, 261 387 troncons)
--
-- `GET /api/search?q=...` (et le complement serveur de la recherche du geoportail, qui n'interroge
-- le serveur qu'a partir de 3 caracteres) cherche par `ILIKE '%q%'` sur `troncons.code` et
-- `troncons.nom`, via Prisma `contains` + `mode: insensitive`. Un `ILIKE '%...%'` ne sert aucun
-- index btree : sur le registre complet, c'est un parcours sequentiel de toute la table
-- (voir EXPLAIN dans docs/performance/MESURES-A15-A20.md). Une requete dont aucun troncon ne
-- repond parcourt tout avant de rendre ses zero resultat (2,5 s en EXPLAIN ANALYZE, 0,1 ms avec
-- l'index) ; une requete tres frequente s'arrete tot grace au `LIMIT 5`, ce qui masque le probleme
-- a qui ne teste que des mots courants.
--
-- LE CORRECTIF : deux index GIN `gin_trgm_ops`, partiels sur `deletedAt IS NULL` (la route filtre
-- toujours les troncons supprimes logiquement). Le planificateur combine les deux par BitmapOr.
--
-- LIMITE CONNUE : un motif de moins de 3 caracteres ne produit aucun trigramme exploitable ; il
-- retombe sur le parcours sequentiel (borne par le LIMIT 5 quand le motif est frequent, complet
-- quand il est absent). Le geoportail n'interroge le serveur qu'a partir de 3 caracteres ;
-- la recherche globale de l'en-tete part de 2.
--
-- EXTENSION : `pg_trgm` est une extension livree avec PostgreSQL (contrib) et marquee « de
-- confiance » : le proprietaire de la base peut la creer sans etre superutilisateur. A verifier sur
-- la base de production AVANT deploiement (`SELECT * FROM pg_available_extensions WHERE name = 'pg_trgm'`).
--
-- NATURE : additive, une extension et deux index (7 Mo et 12 Mo pour 261 387 lignes). La construction
-- prend un verrou en ECRITURE sur `troncons` (lectures libres) : 21 s et 18 s sur le poste de mesure,
-- charge par d'autres processus -- a faire hors des heures de saisie.
--
-- REVERSIBILITE : voir backend/prisma/descentes/20261023210000_recherche_troncons_trigramme.sql.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "troncons_code_trgm_idx" ON "troncons" USING GIN ("code" gin_trgm_ops) WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "troncons_nom_trgm_idx" ON "troncons" USING GIN ("nom" gin_trgm_ops) WHERE "deletedAt" IS NULL;
