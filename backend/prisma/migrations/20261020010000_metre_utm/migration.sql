-- METRE EN PROJECTION METRIQUE UTM (paragraphe 7.1, scenario A5)
--
-- « Calculs metriques (longueurs, surfaces, distances, tampons) : projection en UTM 28N
-- (EPSG:32628) ou UTM 29N (EPSG:32629) selon la longitude (la Guinee chevauche les deux fuseaux,
-- limite a 12 deg O), ou geography pour les distances simples. Jamais de calcul de longueur ou de
-- surface en degres. » -- paragraphe 7.1, verrouille.
-- A5 : « Surface/longueur calculee en projection metrique, ecart < 1 % sur geometries de test
-- connues. »
--
-- CE QUE CETTE MIGRATION FAIT : deux fonctions.
--
--   - `epsg_utm(geom)` : le fuseau UTM de la geometrie, choisi par la longitude de son point
--     interieur (`ST_PointOnSurface`, qui tombe DANS la geometrie, contrairement au centroide
--     d'une forme concave). Formule standard : fuseau = floor((lon + 180) / 6) + 1, hemisphere nord
--     326xx, sud 327xx. Pour la Guinee : 32628 a l'ouest de 12 deg O, 32629 a partir de 12 deg O.
--     Elle n'est pas restreinte a la Guinee : un troncon hors territoire (il y en a 6 573, classes
--     et conserves) recoit son propre fuseau au lieu d'un fuseau faux.
--   - `metre_utm(geom)` : longueur (m) et surface (m2) dans ce fuseau, avec l'EPSG employe et, pour
--     controle, les memes grandeurs sur l'ellipsoide (`geography`). L'ecart relatif est rendu, il
--     n'est pas cache : c'est lui que A5 borne a 1 %.
--
-- UNE GEOMETRIE A CHEVAL SUR 12 DEG O est calculee dans le fuseau de son point interieur. Pres de
-- la limite, la deformation d'un fuseau voisin reste faible (de l'ordre du dix-millieme a quelques
-- millièmes) ; le banc d'essai le mesure de part et d'autre de la limite au lieu de le supposer.
--
-- NATURE : additive. Deux fonctions IMMUTABLE, aucune table.

CREATE OR REPLACE FUNCTION epsg_utm(g geometry) RETURNS integer
LANGUAGE sql IMMUTABLE STRICT AS $fn$
  SELECT CASE WHEN ST_Y(p) >= 0 THEN 32600 ELSE 32700 END
         + LEAST(60, GREATEST(1, floor((ST_X(p) + 180) / 6)::integer + 1))
    FROM (SELECT ST_PointOnSurface(ST_Transform(ST_SetSRID(g, COALESCE(NULLIF(ST_SRID(g), 0), 4326)), 4326)) AS p) s;
$fn$;

CREATE OR REPLACE FUNCTION metre_utm(g geometry)
RETURNS TABLE ("epsg" integer, "longueurM" double precision, "surfaceM2" double precision,
               "longueurGeodesiqueM" double precision, "surfaceGeodesiqueM2" double precision,
               "ecartLongueur" double precision, "ecartSurface" double precision)
LANGUAGE sql IMMUTABLE STRICT AS $fn$
  WITH src AS (SELECT ST_Transform(ST_SetSRID(g, COALESCE(NULLIF(ST_SRID(g), 0), 4326)), 4326) AS w),
  m AS (
    SELECT epsg_utm(w) AS e, w FROM src
  ),
  v AS (
    SELECT e,
           -- Longueur : celle des lignes, ou le perimetre des surfaces (ST_Perimeter).
           CASE WHEN ST_Dimension(w) = 2 THEN ST_Perimeter(ST_Transform(w, e)) ELSE ST_Length(ST_Transform(w, e)) END AS lm,
           ST_Area(ST_Transform(w, e)) AS sm,
           CASE WHEN ST_Dimension(w) = 2 THEN ST_Perimeter(w::geography) ELSE ST_Length(w::geography) END AS lg,
           ST_Area(w::geography) AS sg
      FROM m
  )
  SELECT e, lm, sm, lg, sg,
         CASE WHEN lg > 0 THEN abs(lm - lg) / lg END,
         CASE WHEN sg > 0 THEN abs(sm - sg) / sg END
    FROM v;
$fn$;

COMMENT ON FUNCTION epsg_utm(geometry) IS
  'Fuseau UTM (EPSG 326xx / 327xx) du point interieur de la geometrie. Guinee : 32628 a l''ouest de 12 deg O, 32629 au-dela (paragraphe 7.1).';
COMMENT ON FUNCTION metre_utm(geometry) IS
  'Longueur et surface en projection UTM, avec les grandeurs geodesiques de controle et l''ecart relatif (scenario A5 : < 1 %).';
