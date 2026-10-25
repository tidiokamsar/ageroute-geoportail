-- BANC DE PERFORMANCE du rattachement ponctuel (scenario A15 : « rattachement < 300 ms p95 »),
-- au volume de la production.
--
-- POURQUOI. A15 n'avait jamais ete mesure (matrice : NT). La requete de candidats de
-- `geo/appariement.ts` trie par `t.geom <-> point` (plus proche voisin PLANAIRE) et filtre par
-- `t.geom && emprise` ; or `troncons` ne porte qu'un index GiST sur l'expression `geom::geography`
-- (migration `20260901170000`). Ni le tri ni le filtre ne peuvent s'en servir.
--
-- CE QU'IL FAIT, dans une transaction ANNULEE :
--   1. 261 387 troncons synthetiques (le volume de production du 21/10/2026), dont 1 700 du reseau
--      classe (`sourceReference` nul) et le reste en voirie locale, comme en production ;
--   2. 300 positions tirees a moins de 30 m d'un troncon ;
--   3. execute la REQUETE DU SERVICE, recopiee a l'identique, dans ses deux formes employees :
--      reseau classe avec emprise (saisie d'un defaut, `empriseLocale` de 2 km) et tout le reseau
--      sans emprise ; mediane et p95 ;
--   4. pose l'index planaire `troncons_geom_gist` (dans la transaction) et remesure, puis ASSERTE
--      que le premier candidat est le meme avec et sans index (le tri n'en depend pas).
--
-- CE QU'IL NE PROUVE PAS : les durees du serveur de production, ni le cout reseau d'un aller-retour.
-- Les durees sont affichees, non assertees. L'index n'est PAS cree en base : il l'est dans la
-- transaction annulee, pour mesurer ce qu'il apporterait.
--
--   docker exec -i bdri-dev-db psql -U bdri_dev -d <base> -v ON_ERROR_STOP=1 -f - < backend/prisma/tests/appariement.bench.sql

BEGIN;
SELECT setseed(0.17);
INSERT INTO regions (nom) VALUES ('Region du banc appariement');

DO $b$
DECLARE
  t0 timestamptz; r RECORD; c RECORD; u timestamptz; i integer;
  durees double precision[]; med double precision; p95 double precision;
  premiers_sans text[] := ARRAY[]::text[]; premiers_avec text[] := ARRAY[]::text[];
  forme integer; avec_index boolean; ecarts integer := 0;
  reg integer := (SELECT id FROM regions WHERE nom = 'Region du banc appariement');
BEGIN
  t0 := clock_timestamp();
  INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "sourceReference", "updatedAt")
  SELECT 'ta-' || s, 'BA-' || s, 'Troncon ' || s, 'RN', reg, 0.3, 'BITUME', 0, 0.3,
         ST_SetSRID(ST_MakeLine(ST_MakePoint(x, y), ST_MakePoint(x + l * cos(a), y + l * sin(a))), 4326),
         CASE WHEN s <= 1700 THEN NULL ELSE 'voirie_locale:banc-' || s END, CURRENT_TIMESTAMP
    FROM (SELECT s, -15.0 + random() * 7.3 AS x, 7.3 + random() * 5.3 AS y,
                 (50 + random() * 500) / 111320.0 AS l, random() * 2 * pi() AS a
            FROM generate_series(1, 261387) s) q;
  ANALYZE troncons;
  RAISE NOTICE '[1] 261 387 troncons fabriques en %', clock_timestamp() - t0;

  -- Positions a moins de 30 m d'un troncon tire au hasard (moitie reseau classe, moitie voirie).
  CREATE TEMP TABLE positions_banc ON COMMIT DROP AS
  SELECT n, ST_X(p) AS lon, ST_Y(p) AS lat FROM (
    SELECT n, ST_Translate(ST_LineInterpolatePoint(t.geom, random()), (random() - 0.5) * 0.0005, (random() - 0.5) * 0.0005) AS p
      FROM generate_series(1, 300) n
      JOIN LATERAL (SELECT geom FROM troncons WHERE id = 'ta-' || (CASE WHEN n % 2 = 0 THEN 1 + floor(random() * 1700) ELSE 1701 + floor(random() * 259000) END)::integer) t ON true
  ) z;

  FOR avec_index IN SELECT unnest(ARRAY[false, true]) LOOP
    IF avec_index THEN
      t0 := clock_timestamp();
      CREATE INDEX troncons_geom_gist_banc ON troncons USING gist (geom);
      ANALYZE troncons;
      RAISE NOTICE '[4] index planaire pose (dans la transaction) en %', clock_timestamp() - t0;
    END IF;
    FOR forme IN 1..2 LOOP
      durees := ARRAY[]::double precision[];
      FOR r IN SELECT * FROM positions_banc ORDER BY n LOOP
        u := clock_timestamp();
        IF forme = 1 THEN
          -- Saisie d'un defaut : reseau classe, emprise de 2 km (`empriseLocale`).
          EXECUTE format($q$SELECT t.id AS "tronconId", ST_Distance(t.geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS "distanceM",
                  ST_LineLocatePoint(t.geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)) AS fraction, ST_Length(t.geom::geography) AS "longueurM"
             FROM troncons t
            WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL AND ST_GeometryType(t.geom) = 'ST_LineString'
              AND (t."sourceReference" IS NULL OR NOT (t."sourceReference" LIKE 'voirie_locale:%%'))
              AND t.geom && ST_MakeEnvelope($1 - 0.02, $2 - 0.018, $1 + 0.02, $2 + 0.018, 4326)
            ORDER BY t.geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326) LIMIT 5$q$) INTO c USING r.lon, r.lat;
        ELSE
          -- Tout le reseau, sans emprise.
          EXECUTE $q$SELECT t.id AS "tronconId", ST_Distance(t.geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS "distanceM",
                  ST_LineLocatePoint(t.geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)) AS fraction, ST_Length(t.geom::geography) AS "longueurM"
             FROM troncons t
            WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL AND ST_GeometryType(t.geom) = 'ST_LineString'
            ORDER BY t.geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326) LIMIT 5$q$ INTO c USING r.lon, r.lat;
        END IF;
        durees := durees || (extract(epoch FROM clock_timestamp() - u) * 1000);
        IF forme = 2 THEN
          IF avec_index THEN premiers_avec := premiers_avec || c."tronconId"; ELSE premiers_sans := premiers_sans || c."tronconId"; END IF;
        END IF;
      END LOOP;
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY v), percentile_cont(0.95) WITHIN GROUP (ORDER BY v) INTO med, p95 FROM unnest(durees) v;
      RAISE NOTICE '[%] % : 300 positions, mediane % ms, p95 % ms',
        CASE WHEN avec_index THEN 4 ELSE 3 END,
        CASE forme WHEN 1 THEN 'reseau classe + emprise 2 km' ELSE 'tout le reseau, sans emprise' END || CASE WHEN avec_index THEN ' AVEC index planaire' ELSE ' SANS index planaire' END,
        round(med::numeric, 2), round(p95::numeric, 2);
    END LOOP;
  END LOOP;

  FOR i IN 1..300 LOOP
    IF premiers_sans[i] IS DISTINCT FROM premiers_avec[i] THEN ecarts := ecarts + 1; END IF;
  END LOOP;
  IF ecarts <> 0 THEN RAISE EXCEPTION 'Premier candidat different avec et sans index sur % positions', ecarts; END IF;
  RAISE NOTICE '[4] premier candidat identique avec et sans index sur les 300 positions';
  RAISE NOTICE '--- BANC TERMINE ---';
END;
$b$;

ROLLBACK;
