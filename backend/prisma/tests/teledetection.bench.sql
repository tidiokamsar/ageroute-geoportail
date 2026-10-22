-- BANC DE PERFORMANCE de l'observation de la Terre (partie E, A30), au volume de la production.
--
-- POURQUOI. Le banc fonctionnel (`observation_terre.test.sql`) tourne sur UN troncon. En
-- production, `troncons` compte 261 387 lignes (compteurs du deploiement du 21/10/2026, voirie
-- locale comprise). Le rattachement d'une proposition au troncon le plus proche, la vue de
-- precision et la vue de coherence n'avaient jamais ete mesures a ce volume.
--
-- CE QU'IL FAIT, dans une transaction ANNULEE :
--   1. fabrique 261 387 troncons synthetiques (segments de 50 a 550 m, graine fixe) sur l'emprise
--      de la Guinee, et un produit radar qui la couvre ;
--   2. depose 8 000 propositions avec la REQUETE DU SERVICE (`deposerPropositions`), recopiee a
--      l'identique, proposition par proposition comme le service : 2 000 sans tolerance, puis
--      2 000 a 50 m, 500 m et 5 000 m (le maximum admis par la route) ;
--   3. ASSERTE que le plan du plus proche voisin passe par l'index `troncons_geom_geography_idx`,
--      et que, sur 40 propositions tirees, le troncon et la distance trouves par l'index sont
--      ceux d'un balayage complet sans index (au centimetre) ;
--   4. pose 2 400 verdicts, puis mesure la vue de precision, la liste A_VERIFIER de la route et la
--      vue de coherence.
--
-- CE QU'IL NE PROUVE PAS : les durees sur le serveur de production (autre machine, autre charge),
-- ni le cout reseau d'un aller-retour Prisma par proposition. Les durees sont AFFICHEES, pas
-- assertees : un plafond de temps dans un banc partage serait une fausse alerte des que le poste
-- est charge. Seuls le plan et l'exactitude sont asserts.
--
--   docker exec -i bdri-dev-db psql -U bdri_dev -d <base> -v ON_ERROR_STOP=1 -f - < backend/prisma/tests/teledetection.bench.sql

BEGIN;
SELECT setseed(0.42);

INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt")
VALUES ('u-bench', 'bench@local.invalid', 'Fixture banc', 'fixture-sans-usage', 'GESTIONNAIRE', CURRENT_TIMESTAMP);
INSERT INTO regions (nom) VALUES ('Region du banc teledetection');

DO $b$
DECLARE
  t0 timestamptz; nb integer; nb2 integer; rat integer; plan text;
  reg integer := (SELECT id FROM regions WHERE nom = 'Region du banc teledetection');
  tol double precision; lot integer; i integer; pid text; g geometry;
  durees double precision[]; med double precision; p95 double precision;
  ecarts integer := 0;
  r RECORD; ri RECORD; rb RECORD;
BEGIN
  -- ---------- 1. Le reseau ----------
  t0 := clock_timestamp();
  INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt")
  SELECT 'tb-' || s, 'BENCH-' || s, 'Troncon du banc ' || s, 'RN', reg, 0.3, 'BITUME', 0, 0.3,
         ST_SetSRID(ST_MakeLine(ST_MakePoint(x, y), ST_MakePoint(x + l * cos(a), y + l * sin(a))), 4326), CURRENT_TIMESTAMP
    FROM (SELECT s, -15.0 + random() * 7.3 AS x, 7.3 + random() * 5.3 AS y,
                 (50 + random() * 500) / 111320.0 AS l, random() * 2 * pi() AS a
            FROM generate_series(1, 261387) s) q;
  ANALYZE troncons;
  RAISE NOTICE '[1] 261 387 troncons fabriques et indexes en %', clock_timestamp() - t0;

  INSERT INTO earth_observation_products (id, code, palier, source, nature, "dateAcquisition", "resolutionM", incertitude, provenance, licence, "versionTraitement", emprise, "enregistreParId")
  VALUES ('pb', 'BENCH-S1', 0, 'Sentinel-1 GRD', 'RADAR', '2026-10-02', 10, 'banc', 'scene-banc', 'licence de banc, aucune image', 'v0',
          ST_SetSRID(ST_MakeEnvelope(-15.1, 7.2, -7.6, 12.7), 4326), 'u-bench');

  -- ---------- 2. Le depot, requete du service a l'identique ----------
  FOR lot IN 0..3 LOOP
    tol := CASE lot WHEN 0 THEN NULL WHEN 1 THEN 50 WHEN 2 THEN 500 ELSE 5000 END;
    durees := ARRAY[]::double precision[];
    t0 := clock_timestamp();
    FOR i IN 1..2000 LOOP
      pid := 'pb-' || lot || '-' || i;
      g := ST_SetSRID(ST_MakePoint(-15.0 + random() * 7.3, 7.3 + random() * 5.3), 4326);
      DECLARE u timestamptz := clock_timestamp(); BEGIN
        WITH g AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON(ST_AsGeoJSON(g)), 4326) AS geom),
        proche AS (
          SELECT t."id", ST_Distance(t."geom"::geography, g.geom::geography) AS d
            FROM "troncons" t, g
           WHERE tol::double precision IS NOT NULL AND t."deletedAt" IS NULL AND t."geom" IS NOT NULL
             AND ST_DWithin(t."geom"::geography, g.geom::geography, tol::double precision)
           ORDER BY d ASC, t."id" ASC LIMIT 1
        )
        INSERT INTO "propositions_teledetection"
          ("id", "produitId", "produitReferenceId", "type", "methode", "score", "geom", "tronconId", "distanceTronconM", "creeParId")
        SELECT pid, 'pb', NULL, 'INONDATION', 'banc v0', NULL::double precision, g.geom,
               (SELECT "id" FROM proche), (SELECT d FROM proche), 'u-bench'
          FROM g;
        durees := durees || (extract(epoch FROM clock_timestamp() - u) * 1000);
      END;
    END LOOP;
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY v), percentile_cont(0.95) WITHIN GROUP (ORDER BY v)
      INTO med, p95 FROM unnest(durees) v;
    SELECT count(*) FILTER (WHERE "tronconId" IS NOT NULL) INTO rat FROM propositions_teledetection WHERE id LIKE 'pb-' || lot || '-%';
    RAISE NOTICE '[2] 2 000 propositions, tolerance % m : % au total, mediane % ms, p95 % ms, % rattachees',
      coalesce(tol::text, 'aucune'), clock_timestamp() - t0, round(med::numeric, 2), round(p95::numeric, 2), rat;
  END LOOP;
  ANALYZE propositions_teledetection;

  -- ---------- 3. Le plan, et l'exactitude contre un balayage complet ----------
  plan := '';
  FOR r IN EXECUTE $q$EXPLAIN (FORMAT TEXT)
    SELECT t."id", ST_Distance(t."geom"::geography, g::geography) AS d
      FROM "troncons" t, (SELECT ST_SetSRID(ST_MakePoint(-13.6, 9.6), 4326) AS g) x
     WHERE t."deletedAt" IS NULL AND t."geom" IS NOT NULL AND ST_DWithin(t."geom"::geography, g::geography, 500)
     ORDER BY d, t."id" LIMIT 1$q$ LOOP
    plan := plan || r."QUERY PLAN" || E'\n';
  END LOOP;
  IF position('troncons_geom_geography_idx' IN plan) = 0 THEN
    RAISE EXCEPTION 'Le plus proche voisin ne passe pas par l''index geography :%', E'\n' || plan;
  END IF;
  RAISE NOTICE '[3] plan du plus proche voisin : index troncons_geom_geography_idx utilise';

  -- Balayage complet : index interdits pour la seule requete de controle.
  t0 := clock_timestamp();
  FOR ri IN SELECT p.id, p.geom, p."tronconId", p."distanceTronconM"
              FROM propositions_teledetection p WHERE p.id LIKE 'pb-2-%' ORDER BY p.id LIMIT 40 LOOP
    -- Requete DYNAMIQUE : une requete statique PL/pgSQL garderait le plan mis en cache avec index.
    SET LOCAL enable_indexscan = off; SET LOCAL enable_bitmapscan = off;
    EXECUTE $q$SELECT t."id", ST_Distance(t."geom"::geography, $1::geography) AS d
      FROM "troncons" t
     WHERE t."deletedAt" IS NULL AND t."geom" IS NOT NULL AND ST_DWithin(t."geom"::geography, $1::geography, 500)
     ORDER BY d, t."id" LIMIT 1$q$ INTO rb USING ri.geom;
    RESET enable_indexscan; RESET enable_bitmapscan;
    IF (rb.id IS DISTINCT FROM ri."tronconId")
       OR (rb.id IS NOT NULL AND abs(rb.d - ri."distanceTronconM") > 0.01) THEN
      ecarts := ecarts + 1;
    END IF;
  END LOOP;
  IF ecarts <> 0 THEN RAISE EXCEPTION 'Index et balayage complet divergent sur % propositions sur 40', ecarts; END IF;
  RAISE NOTICE '[3] 40 propositions a 500 m : index = balayage complet (troncon et distance au cm), controle en %', clock_timestamp() - t0;

  -- ---------- 4. Verdicts, puis lectures ----------
  t0 := clock_timestamp();
  UPDATE propositions_teledetection SET statut = CASE WHEN random() < 0.6 THEN 'CONFIRMEE' ELSE 'INFIRMEE' END,
         "verifieeParId" = 'u-bench', "motifVerdict" = 'constat de banc', "constatRef" = 'banc:' || id
   WHERE id IN (SELECT id FROM propositions_teledetection WHERE id LIKE 'pb-%' ORDER BY id LIMIT 2400);
  RAISE NOTICE '[4] 2 400 verdicts poses (declencheur de garde compris) en %', clock_timestamp() - t0;

  t0 := clock_timestamp();
  SELECT sum(total), sum(confirmees + infirmees) INTO nb, nb2 FROM precision_teledetection WHERE methode = 'banc v0';
  IF nb <> 8000 OR nb2 <> 2400 THEN RAISE EXCEPTION 'Precision : 8 000 / 2 400 attendus, % / % recus', nb, nb2; END IF;
  RAISE NOTICE '[4] vue precision_teledetection sur 8 000 propositions : %', clock_timestamp() - t0;

  t0 := clock_timestamp();
  SELECT count(*) INTO nb FROM (SELECT id FROM propositions_teledetection WHERE statut = 'A_VERIFIER' ORDER BY "createdAt" DESC LIMIT 500) s;
  RAISE NOTICE '[4] liste A_VERIFIER de la route (500 premieres) : %', clock_timestamp() - t0;

  t0 := clock_timestamp();
  SELECT count(*) INTO nb FROM coherence_teledetection;
  IF nb <> 0 THEN RAISE EXCEPTION 'Coherence : 0 anomalie attendue sur le jeu du banc, % recues', nb; END IF;
  RAISE NOTICE '[4] vue coherence_teledetection sur 8 000 propositions et 261 387 troncons : 0 anomalie, %', clock_timestamp() - t0;

  RAISE NOTICE '--- BANC TERMINE : plan et exactitude asserts, durees ci-dessus ---';
END;
$b$;

ROLLBACK;
