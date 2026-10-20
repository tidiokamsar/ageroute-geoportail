-- BANC D'ESSAI du metre UTM (paragraphe 7.1, scenario A5 : ecart < 1 % sur geometries connues).
--
-- Geometries de test CONNUES, et pourquoi elles le sont :
--   - un carre de 100 m x 100 m CONSTRUIT EN UTM 28N (donc exactement 10 000 m2 dans ce plan),
--     puis ramene en WGS 84 : on doit retrouver 10 000 m2 a l'arrondi pres ;
--   - le meme en UTM 29N ;
--   - une ligne de 1 km construite en UTM 28N ;
--   - des geometries de 1 km2 et de 1 000 km2 en WGS 84, de part et d'autre de 12 deg O, comparees
--     au calcul geodesique sur l'ellipsoide (geography), qui sert de reference independante.
--
--   docker exec -i bdri-dev-db psql -U bdri_dev -d <base> -v ON_ERROR_STOP=1 -f - < backend/prisma/tests/metre_utm.test.sql

BEGIN;

DO $t$
DECLARE r record; carre geometry; ligne geometry; v double precision;
BEGIN
  -- ---------- Choix du fuseau ----------
  IF epsg_utm(ST_SetSRID(ST_MakePoint(-13.7, 9.5), 4326)) <> 32628 THEN RAISE EXCEPTION 'Conakry devrait etre en 32628'; END IF;
  IF epsg_utm(ST_SetSRID(ST_MakePoint(-8.8, 7.75), 4326)) <> 32629 THEN RAISE EXCEPTION 'Nzerekore devrait etre en 32629'; END IF;
  IF epsg_utm(ST_SetSRID(ST_MakePoint(-12.05, 10.0), 4326)) <> 32628 THEN RAISE EXCEPTION '-12,05 devrait etre en 32628'; END IF;
  IF epsg_utm(ST_SetSRID(ST_MakePoint(-12.0, 10.0), 4326)) <> 32629 THEN RAISE EXCEPTION '-12,00 (limite) devrait etre en 32629'; END IF;
  IF epsg_utm(ST_SetSRID(ST_MakePoint(-11.95, 10.0), 4326)) <> 32629 THEN RAISE EXCEPTION '-11,95 devrait etre en 32629'; END IF;
  -- Une geometrie sans SRID est tenue pour du WGS 84 (convention du stockage, paragraphe 7.1).
  IF epsg_utm(ST_MakePoint(-13.7, 9.5)) <> 32628 THEN RAISE EXCEPTION 'SRID absent mal traite'; END IF;
  -- Hemisphere sud : 327xx, et non un fuseau nord faux.
  IF epsg_utm(ST_SetSRID(ST_MakePoint(-13.7, -9.5), 4326)) <> 32728 THEN RAISE EXCEPTION 'Hemisphere sud mal traite'; END IF;
  RAISE NOTICE 'Fuseau : 32628 a l''ouest de 12 deg O, 32629 a partir de 12 deg O ; sud en 327xx';

  -- ---------- Carre de 100 m construit en UTM 28N, pres de Conakry ----------
  carre := ST_Transform(ST_SetSRID(ST_MakeEnvelope(250000, 1050000, 250100, 1050100), 32628), 4326);
  SELECT * INTO r FROM metre_utm(carre);
  IF r.epsg <> 32628 THEN RAISE EXCEPTION 'Carre 28N : fuseau %', r.epsg; END IF;
  IF abs(r."surfaceM2" - 10000) > 0.01 THEN RAISE EXCEPTION 'Carre 28N : 10 000 m2 attendus, recu %', r."surfaceM2"; END IF;
  IF abs(r."longueurM" - 400) > 0.001 THEN RAISE EXCEPTION 'Carre 28N : perimetre 400 m attendu, recu %', r."longueurM"; END IF;
  IF r."ecartSurface" >= 0.01 THEN RAISE EXCEPTION 'Carre 28N : ecart a l''ellipsoide %', r."ecartSurface"; END IF;
  RAISE NOTICE 'Carre 28N : % m2 (geodesique % m2, ecart % %%)', round(r."surfaceM2"::numeric, 3), round(r."surfaceGeodesiqueM2"::numeric, 1), round((r."ecartSurface" * 100)::numeric, 4);

  -- ---------- Le meme en UTM 29N, pres de Nzerekore ----------
  carre := ST_Transform(ST_SetSRID(ST_MakeEnvelope(480000, 857000, 480100, 857100), 32629), 4326);
  SELECT * INTO r FROM metre_utm(carre);
  IF r.epsg <> 32629 THEN RAISE EXCEPTION 'Carre 29N : fuseau %', r.epsg; END IF;
  IF abs(r."surfaceM2" - 10000) > 0.01 THEN RAISE EXCEPTION 'Carre 29N : 10 000 m2 attendus, recu %', r."surfaceM2"; END IF;
  IF r."ecartSurface" >= 0.01 THEN RAISE EXCEPTION 'Carre 29N : ecart a l''ellipsoide %', r."ecartSurface"; END IF;
  RAISE NOTICE 'Carre 29N : % m2, ecart a l''ellipsoide % %%', round(r."surfaceM2"::numeric, 3), round((r."ecartSurface" * 100)::numeric, 4);

  -- ---------- Ligne de 1 km construite en UTM 28N ----------
  ligne := ST_Transform(ST_SetSRID(ST_MakeLine(ST_MakePoint(250000, 1050000), ST_MakePoint(251000, 1050000)), 32628), 4326);
  SELECT * INTO r FROM metre_utm(ligne);
  IF abs(r."longueurM" - 1000) > 0.001 THEN RAISE EXCEPTION 'Ligne : 1 000 m attendus, recu %', r."longueurM"; END IF;
  IF r."surfaceM2" <> 0 THEN RAISE EXCEPTION 'Ligne : surface non nulle %', r."surfaceM2"; END IF;
  IF r."ecartLongueur" >= 0.01 THEN RAISE EXCEPTION 'Ligne : ecart a l''ellipsoide %', r."ecartLongueur"; END IF;
  RAISE NOTICE 'Ligne 1 km : % m, ecart a l''ellipsoide % %%', round(r."longueurM"::numeric, 4), round((r."ecartLongueur" * 100)::numeric, 4);

  -- ---------- De part et d'autre de la limite, en WGS 84 ----------
  FOR r IN SELECT * FROM (VALUES (-12.05), (-11.95)) AS x(lon) LOOP
    SELECT * INTO r FROM metre_utm(ST_SetSRID(ST_MakeEnvelope(r.lon - 0.0045, 10.0, r.lon + 0.0045, 10.009), 4326));
    IF r."ecartSurface" >= 0.01 THEN RAISE EXCEPTION 'Pres de 12 deg O : ecart %', r."ecartSurface"; END IF;
    RAISE NOTICE 'Pres de 12 deg O, fuseau % : ~1 km2, ecart a l''ellipsoide % %%', r.epsg, round((r."ecartSurface" * 100)::numeric, 4);
  END LOOP;

  -- ---------- Grande surface : environ 1 000 km2 dans le Fouta Djallon ----------
  SELECT * INTO r FROM metre_utm(ST_SetSRID(ST_MakeEnvelope(-12.6, 10.9, -12.31, 11.19), 4326));
  IF r."ecartSurface" >= 0.01 THEN RAISE EXCEPTION 'Grande surface : ecart %', r."ecartSurface"; END IF;
  RAISE NOTICE 'Environ % km2 : ecart a l''ellipsoide % %%', round((r."surfaceM2" / 1e6)::numeric), round((r."ecartSurface" * 100)::numeric, 4);

  -- ---------- Pourquoi jamais en degres ----------
  SELECT ST_Area(carre) INTO v;
  IF v > 1 THEN RAISE EXCEPTION 'Le calcul en degres devrait rendre une valeur absurde (< 1), recu %', v; END IF;
  RAISE NOTICE 'Le meme carre « en degres » : % -- une valeur sans unite, d''ou l''interdit du paragraphe 7.1', v;

  RAISE NOTICE '--- TOUTES LES ASSERTIONS PASSENT ---';
END;
$t$;

ROLLBACK;
