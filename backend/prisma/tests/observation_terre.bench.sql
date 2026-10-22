-- BANC DE PERFORMANCE de l'observation de la Terre (partie E, A30), a VOLUME DE PRODUCTION SYNTHETIQUE.
--
-- Ce qu'il mesure : le depot d'un lot de propositions avec rattachement au troncon le plus proche
-- (la requete du service, a l'identique), avec et sans le controle de coherence ; le plan de la
-- requete de rattachement (index GiST sur geography exige) ; la vue de precision, la vue de
-- coherence et le compteur « alertes satellite » de la vue murale.
--
-- Ce qu'il NE mesure PAS : la production. Le reseau est SYNTHETIQUE : 261 387 segments d'environ
-- 1 km poses sur l'emprise de la Guinee (le nombre de troncons releve en production, PROJECT_STATUS
-- § 3), tires avec une graine fixe. Les durees dependent de ce poste (portable, PostGIS 3.5 en
-- conteneur) : elles se comparent d'une execution a l'autre ici, pas a un engagement de service.
-- Aucun seuil n'est impose : le banc echoue seulement si le plan n'emploie pas l'index ou si un
-- resultat est faux.
--
--   docker exec -i bdri-dev-db psql -U bdri_dev -d <base> -v ON_ERROR_STOP=1 -f - < backend/prisma/tests/observation_terre.bench.sql
--
-- Transaction ANNULEE a la fin : rien ne reste en base.

BEGIN;
SELECT setseed(0.20261022);

INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt")
VALUES ('u-eob', 'eob@local.invalid', 'Fixture banc teledetection', 'fixture-sans-usage', 'GESTIONNAIRE', CURRENT_TIMESTAMP);
INSERT INTO regions (nom) VALUES ('Region du banc teledetection');

-- Reseau synthetique : grille 512 x 511 sur lon -15,0..-7,6 et lat 7,2..12,7, un segment d'environ
-- 1 km par case, d'orientation tiree.
INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt")
SELECT 'bt-' || n, 'BT-' || n, 'Segment synthetique du banc', 'RN',
       (SELECT id FROM regions WHERE nom = 'Region du banc teledetection'), 1, 'BITUME', 0, 1,
       ST_SetSRID(ST_MakeLine(ST_MakePoint(x, y), ST_MakePoint(x + 0.009 * cos(a), y + 0.009 * sin(a))), 4326),
       CURRENT_TIMESTAMP
  FROM (SELECT n,
               -15.0 + 7.4 * ((n % 512) + random()) / 512 AS x,
               7.2 + 5.5 * ((n / 512) + random()) / 511 AS y,
               2 * pi() * random() AS a
          FROM generate_series(0, 261386) AS n) s;
ANALYZE troncons;

INSERT INTO earth_observation_products (id, code, palier, source, nature, "dateAcquisition", "resolutionM", "couvertureNuagesPct", incertitude, provenance, licence, "versionTraitement", emprise, "enregistreParId")
VALUES
  ('pb-ref', 'BENCH-REF', 0, 'Sentinel-2 L2A', 'OPTIQUE', '2026-09-01', 10, 5, 'x', 'banc', 'licence du banc', 'v0', ST_SetSRID(ST_MakeEnvelope(-15.1, 7.1, -7.5, 12.8), 4326), 'u-eob'),
  ('pb-new', 'BENCH-NEW', 0, 'Sentinel-2 L2A', 'OPTIQUE', '2026-10-01', 10, 5, 'x', 'banc', 'licence du banc', 'v0', ST_SetSRID(ST_MakeEnvelope(-15.1, 7.1, -7.5, 12.8), 4326), 'u-eob');

-- Points de detection : la moitie a moins de ~20 m d'un segment (rattachable a 50 m), l'autre
-- moitie tiree au hasard sur l'emprise (le plus souvent a plus de 50 m de tout segment).
CREATE TEMP TABLE pts_banc ON COMMIT DROP AS
SELECT k, CASE WHEN k % 2 = 0
            THEN (SELECT ST_Translate(ST_LineInterpolatePoint(t.geom, 0.5), 0.00015, 0) FROM troncons t WHERE t.id = 'bt-' || ((k * 7919) % 261387))
            ELSE ST_SetSRID(ST_MakePoint(-15.0 + 7.4 * random(), 7.2 + 5.5 * random()), 4326) END AS geom
  FROM generate_series(1, 2000) AS k;

DO $b$
DECLARE
  t0 timestamptz; d_avec double precision; d_sans double precision; duree double precision;
  plan text := ''; ligne text; nb integer; rattachees integer; prec double precision;
  r record;
BEGIN
  -- ---------- 1. Plan de la requete de rattachement ----------
  -- EXPLAIN rend une ligne par noeud : on les concatene toutes (un INTO ne garderait que la premiere).
  FOR ligne IN EXECUTE $q$EXPLAIN (FORMAT TEXT)
    WITH g AS (SELECT ST_SetSRID(ST_MakePoint(-13.6, 9.64), 4326) AS geom)
    SELECT t."id", ST_Distance(t."geom"::geography, g.geom::geography) AS d
      FROM "troncons" t, g
     WHERE t."deletedAt" IS NULL AND t."geom" IS NOT NULL
       AND ST_DWithin(t."geom"::geography, g.geom::geography, 50::double precision)
     ORDER BY d ASC, t."id" ASC LIMIT 1$q$ LOOP plan := plan || ligne || E'
'; END LOOP;
  IF plan NOT LIKE '%troncons_geom_geography_idx%' THEN
    RAISE EXCEPTION 'Le rattachement n''emploie pas l''index GiST sur geography : %', plan;
  END IF;
  RAISE NOTICE '1. Plan du rattachement : index troncons_geom_geography_idx EMPLOYE';

  -- ---------- 2. Depot de 1 000 propositions, controle de coherence ACTIF ----------
  t0 := clock_timestamp();
  FOR r IN SELECT k, geom FROM pts_banc WHERE k <= 1000 LOOP
    WITH g AS (SELECT r.geom AS geom),
    proche AS (
      SELECT t."id", ST_Distance(t."geom"::geography, g.geom::geography) AS d
        FROM "troncons" t, g
       WHERE t."deletedAt" IS NULL AND t."geom" IS NOT NULL
         AND ST_DWithin(t."geom"::geography, g.geom::geography, 50::double precision)
       ORDER BY d ASC, t."id" ASC LIMIT 1)
    INSERT INTO "propositions_teledetection" ("id", "produitId", "produitReferenceId", "type", "methode", "score", "geom", "tronconId", "distanceTronconM", "creeParId")
    SELECT 'pbn-' || r.k, 'pb-new', 'pb-ref', 'NOUVELLE_ROUTE', 'banc-v1', 0.5, g.geom, (SELECT "id" FROM proche), (SELECT d FROM proche), 'u-eob' FROM g;
  END LOOP;
  d_avec := extract(epoch FROM clock_timestamp() - t0) * 1000;

  -- ---------- 3. Meme depot, controle de coherence DESACTIVE (cout du declencheur) ----------
  EXECUTE 'ALTER TABLE propositions_teledetection DISABLE TRIGGER propositions_teledetection_coherence';
  t0 := clock_timestamp();
  FOR r IN SELECT k, geom FROM pts_banc WHERE k > 1000 LOOP
    WITH g AS (SELECT r.geom AS geom),
    proche AS (
      SELECT t."id", ST_Distance(t."geom"::geography, g.geom::geography) AS d
        FROM "troncons" t, g
       WHERE t."deletedAt" IS NULL AND t."geom" IS NOT NULL
         AND ST_DWithin(t."geom"::geography, g.geom::geography, 50::double precision)
       ORDER BY d ASC, t."id" ASC LIMIT 1)
    INSERT INTO "propositions_teledetection" ("id", "produitId", "produitReferenceId", "type", "methode", "score", "geom", "tronconId", "distanceTronconM", "creeParId")
    SELECT 'pbn-' || r.k, 'pb-new', 'pb-ref', 'NOUVELLE_ROUTE', 'banc-v1', 0.5, g.geom, (SELECT "id" FROM proche), (SELECT d FROM proche), 'u-eob' FROM g;
  END LOOP;
  d_sans := extract(epoch FROM clock_timestamp() - t0) * 1000;
  EXECUTE 'ALTER TABLE propositions_teledetection ENABLE TRIGGER propositions_teledetection_coherence';

  SELECT count(*) FILTER (WHERE "tronconId" IS NOT NULL) INTO rattachees FROM propositions_teledetection WHERE id LIKE 'pbn-%';
  IF rattachees < 1000 THEN RAISE EXCEPTION 'Rattachement faux : % rattachees, au moins 1 000 attendues (points a ~16 m)', rattachees; END IF;
  RAISE NOTICE '2. Depot de 1 000 propositions avec rattachement a 50 m : % ms au total, % ms par proposition (controle de coherence actif)', round(d_avec::numeric, 0), round((d_avec / 1000)::numeric, 2);
  RAISE NOTICE '3. Meme depot sans le controle de coherence : % ms (cout du declencheur : % ms par proposition)', round(d_sans::numeric, 0), round(((d_avec - d_sans) / 1000)::numeric, 3);
  RAISE NOTICE '   Rattachees : % sur 2 000 (les 1 000 points poses pres d''un segment, plus ceux que le hasard a mis a moins de 50 m)', rattachees;

  -- Verdicts sur 600 propositions : 400 confirmees, 200 infirmees.
  UPDATE propositions_teledetection
     SET statut = CASE WHEN substr(id, 5)::integer % 3 = 0 THEN 'INFIRMEE' ELSE 'CONFIRMEE' END,
         "verifieeParId" = 'u-eob', "motifVerdict" = 'verdict du banc', "constatRef" = 'constat-banc'
   WHERE id LIKE 'pbn-%' AND substr(id, 5)::integer <= 600;

  -- ---------- 4. Lectures ----------
  t0 := clock_timestamp();
  SELECT "precision" INTO prec FROM precision_teledetection WHERE methode = 'banc-v1';
  duree := extract(epoch FROM clock_timestamp() - t0) * 1000;
  IF abs(prec - 400.0 / 600.0) > 1e-9 THEN RAISE EXCEPTION 'Precision fausse : %', prec; END IF;
  RAISE NOTICE '4. Vue precision_teledetection : % ms (precision 0,667 sur 600 verdicts, juste)', round(duree::numeric, 1);

  t0 := clock_timestamp();
  SELECT count(*) INTO nb FROM propositions_teledetection WHERE statut = 'A_VERIFIER';
  duree := extract(epoch FROM clock_timestamp() - t0) * 1000;
  RAISE NOTICE '5. Compteur « alertes satellite » (A_VERIFIER) : % ms (% propositions)', round(duree::numeric, 1), nb;

  t0 := clock_timestamp();
  SELECT count(*) INTO nb FROM coherence_teledetection;
  duree := extract(epoch FROM clock_timestamp() - t0) * 1000;
  IF nb <> 0 THEN RAISE EXCEPTION 'coherence_teledetection non vide (%)', nb; END IF;
  RAISE NOTICE '6. Vue coherence_teledetection : % ms sur 2 000 propositions, 0 anomalie', round(duree::numeric, 1);
  RAISE NOTICE '--- BANC TERMINE (reseau synthetique de 261 387 segments, transaction annulee) ---';
END $b$;

ROLLBACK;
