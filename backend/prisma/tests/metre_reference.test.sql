-- BANC ENGENDRE depuis backend/src/geo/geometries-reference.ts : NE PAS MODIFIER A LA MAIN.
--   REGENERER_BANC_METRE=1 npx vitest run src/geo/geometries-reference.banc.test.ts
--
-- Ce qu'il prouve (paragraphe 7.1, scenario A5) : sur chaque geometrie de reference, `metre_utm`
-- choisit le fuseau attendu et retrouve la surface et la longueur de DEFINITION au millionieme
-- (a 1 % pour une geometrie calculee dans le fuseau voisin de celui ou elle est definie, ce qui
-- est l'exigence de A5). Le noyau TypeScript `utm.noyau.ts` est eprouve sur les memes
-- coordonnees par `utm.noyau.test.ts`.
--
--   docker exec -i bdri-dev-db psql -U bdri_dev -d <base> -v ON_ERROR_STOP=1 -f - < backend/prisma/tests/metre_reference.test.sql

DO $t$
DECLARE r RECORD; m RECORD; n integer := 0;
BEGIN
  FOR r IN SELECT * FROM (VALUES
  ('CARRE_100M_28N', 32628, 32628, 10000, 400, 1e-6, '{"type":"Polygon","coordinates":[[[-13.7242540791,9.5869102373],[-13.7233429879,9.5869068823],[-13.7233396062,9.5878111357],[-13.7242506998,9.587814491],[-13.7242540791,9.5869102373]]]}'),
  ('CARRE_1KM_29N', 32629, 32629, 1000000, 4000, 1e-6, '{"type":"Polygon","coordinates":[[[-9.3014849384,10.403128307],[-9.2923491148,10.4031367703],[-9.2923575362,10.4121810008],[-9.3014936229,10.41217253],[-9.3014849384,10.403128307]]]}'),
  ('TRIANGLE_28N', 32628, 32628, 60000, 1200, 1e-6, '{"type":"Polygon","coordinates":[[[-14.0877300102,9.9498020361],[-14.0849934409,9.9497945604],[-14.0877199693,9.9534194148],[-14.0877300102,9.9498020361]]]}'),
  ('TROUE_29N', 32629, 32629, 37500, 1000, 1e-6, '{"type":"Polygon","coordinates":[[[-8.8176377855,9.7701044084],[-8.8158141698,9.7701034265],[-8.8158131749,9.7719123566],[-8.8176368005,9.7719133387],[-8.8176377855,9.7701044084]],[[-8.8169535589,9.7707823902],[-8.8169533117,9.7712346227],[-8.8164974062,9.7712343772],[-8.816497654,9.7707821447],[-8.8169535589,9.7707823902]]]}'),
  ('L_CONCAVE_28N', 32628, 32628, 50000, 1200, 1e-6, '{"type":"Polygon","coordinates":[[[-13.1704427673,10.8500436098],[-13.1676994053,10.8500272916],[-13.1676938983,10.8509312357],[-13.1695228113,10.8509421182],[-13.1695118069,10.8527500081],[-13.1704262696,10.8527554462],[-13.1704427673,10.8500436098]]]}'),
  ('LIGNE_1KM_29N', 32629, 32629, 0, 1000, 1e-6, '{"type":"LineString","coordinates":[[-9,10.8554812216],[-8.990850594,10.8554810856]]}'),
  ('LIGNE_BRISEE_28N', 32628, 32628, 0, 1000, 1e-6, '{"type":"LineString","coordinates":[[-13.6335068914,9.4961406111],[-13.6307600727,9.499746821],[-13.6307421025,9.5042679404]]}'),
  ('A_CHEVAL_12W', 32628, 32628, 6000000, 14000, 1e-6, '{"type":"Polygon","coordinates":[[[-12.0363630104,9.9379173741],[-11.9817016784,9.9374287003],[-11.9816187419,9.9464606792],[-12.0362815704,9.9469498058],[-12.0363630104,9.9379173741]]]}'),
  ('A_CHEVAL_12W_EST', 32628, 32629, 8000000, 18000, 0.01, '{"type":"Polygon","coordinates":[[[-11.9999218084,9.9375925803],[-11.9270431954,9.9369311286],[-11.9269587627,9.9459626464],[-11.9998393707,9.946624711],[-11.9999218084,9.9375925803]]]}')
  ) AS v(code, epsg_definition, epsg_attendu, surface, longueur, tolerance, gj) LOOP
    SELECT * INTO m FROM metre_utm(ST_SetSRID(ST_GeomFromGeoJSON(r.gj), 4326));
    IF m.epsg <> r.epsg_attendu THEN
      RAISE EXCEPTION '% : fuseau % attendu, % rendu', r.code, r.epsg_attendu, m.epsg;
    END IF;
    IF r.surface > 0 AND abs(m."surfaceM2" - r.surface) / r.surface > r.tolerance THEN
      RAISE EXCEPTION '% : surface % m2 attendue (tolerance %), % rendue', r.code, r.surface, r.tolerance, m."surfaceM2";
    END IF;
    IF abs(m."longueurM" - r.longueur) / r.longueur > r.tolerance THEN
      RAISE EXCEPTION '% : longueur % m attendue (tolerance %), % rendue', r.code, r.longueur, r.tolerance, m."longueurM";
    END IF;
    RAISE NOTICE '% : EPSG %, % m2, % m (ecart a l''ellipsoide %)', r.code, m.epsg, round(m."surfaceM2"::numeric, 3),
      round(m."longueurM"::numeric, 3), round(coalesce(m."ecartSurface", m."ecartLongueur")::numeric, 5);
    n := n + 1;
  END LOOP;
  IF n <> 9 THEN RAISE EXCEPTION 'Geometries eprouvees : 9 attendues, %', n; END IF;
  RAISE NOTICE '--- TOUTES LES ASSERTIONS PASSENT (% geometries) ---', n;
END;
$t$;
