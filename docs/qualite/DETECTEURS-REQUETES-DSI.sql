-- Requetes de lecture des detecteurs de qualite des troncons, a lancer PAR LA DSI.
--
-- LECTURE SEULE : tout est dans une transaction READ ONLY, annulee a la fin. Rien n'est ecrit.
-- Ce fichier n'a PAS ete lance contre la production (hors perimetre du chantier). Il a ete execute
-- contre la base locale `replay` (vide) pour verifier que le SQL est valide ; aucune duree n'est
-- connue pour 261 387 troncons.
--
-- Usage (a adapter a l'acces de la DSI) :
--   psql "$DATABASE_URL" -v region_id=NULL -f DETECTEURS-REQUETES-DSI.sql      (national)
--   psql "$DATABASE_URL" -v region_id=7    -f DETECTEURS-REQUETES-DSI.sql      (une region)
-- Commencer par une REGION : les requetes 3 a 6 lisent les geometries. Les seuils ecrits ici sont les
-- seuils PROVISOIRES de backend/src/qualite/detecteurs.noyau.ts (voir DETECTEURS.md) ; les changer ici
-- sans les changer la-bas donne des comptes differents de ceux de la route.

\set ON_ERROR_STOP on
BEGIN READ ONLY;
SET LOCAL statement_timeout = '300s';

-- 1. Comptes simples (PK, longueur, geometrie nulle ou vide, etat) -------------------------------
SELECT count(*)                                                                                     AS troncons_actifs,
       count(*) FILTER (WHERE "pkDebut" = 0 AND "pkFin" = 0)                                        AS pk_sentinelle_zero,
       count(*) FILTER (WHERE "pkDebut" NOT IN ('NaN','Infinity','-Infinity')
                          AND "pkFin"   NOT IN ('NaN','Infinity','-Infinity')
                          AND "pkFin" < "pkDebut" AND NOT ("pkDebut" = 0 AND "pkFin" = 0))          AS pk_fin_inferieur_debut,
       count(*) FILTER (WHERE "pkDebut" IN ('NaN','Infinity','-Infinity')
                           OR "pkFin"   IN ('NaN','Infinity','-Infinity'))                          AS pk_absent,
       count(*) FILTER (WHERE "pkDebut" NOT IN ('NaN','Infinity','-Infinity')
                          AND "pkFin"   NOT IN ('NaN','Infinity','-Infinity')
                          AND ("pkDebut" < 0 OR "pkFin" < 0))                                       AS pk_negatif,
       count(*) FILTER (WHERE "longueurKm" <= 0 OR "longueurKm" IN ('NaN','Infinity'))              AS longueur_non_positive,
       count(*) FILTER (WHERE geom IS NULL)                                                         AS geom_absente,
       count(*) FILTER (WHERE geom IS NOT NULL AND ST_IsEmpty(geom))                                AS geom_vide,
       count(*) FILTER (WHERE etat = 'NON_EVALUE')                                                  AS etat_non_evalue,
       count(*) FILTER (WHERE etat = 'NON_EVALUE' AND "dateDerniereEvaluation" IS NOT NULL)         AS etat_date_sans_etat,
       count(*) FILTER (WHERE etat <> 'NON_EVALUE' AND "dateDerniereEvaluation" IS NULL)            AS etat_sans_date_evaluation,
       count(*) FILTER (WHERE etat <> 'NON_EVALUE' AND "dateDerniereEvaluation" > now() + interval '1 day') AS etat_date_future
  FROM troncons
 WHERE "deletedAt" IS NULL
   AND (:region_id::int IS NULL OR "regionId" = :region_id::int);

-- 2. Les 1 029 « PK 0/0 » : de quelle source viennent-ils ? (a lire avec la requete 1) -----------------
SELECT coalesce(split_part("sourceReference", ':', 1), '(sans reference)') AS famille_source,
       classe::text AS classe, count(*) AS n, round(sum("longueurKm")::numeric, 1) AS km_declares
  FROM troncons
 WHERE "deletedAt" IS NULL AND "pkDebut" = 0 AND "pkFin" = 0
   AND (:region_id::int IS NULL OR "regionId" = :region_id::int)
 GROUP BY 1, 2 ORDER BY n DESC;

-- 3. Chevauchements et trous de PK sur une meme (route, section) --------------------------------------
-- Seuils provisoires : chevauchement > 0,05 km ; trou > 0,5 km.
WITH base AS (
  SELECT id, code, nom, "sectionPk", "regionId", "pkDebut", "pkFin",
         max("pkFin") OVER (PARTITION BY nom, "sectionPk" ORDER BY "pkDebut", "pkFin", id
                            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS fin_precedente
    FROM troncons
   WHERE "deletedAt" IS NULL AND "sectionPk" IS NOT NULL
     AND "pkDebut" NOT IN ('NaN','Infinity','-Infinity') AND "pkFin" NOT IN ('NaN','Infinity','-Infinity')
     AND "pkDebut" >= 0 AND "pkFin" >= 0 AND "pkFin" >= "pkDebut" AND NOT ("pkDebut" = 0 AND "pkFin" = 0)
)
SELECT CASE WHEN fin_precedente - "pkDebut" > 0.05 + 1e-9 THEN 'PK_CHEVAUCHEMENT' ELSE 'PK_TROU' END AS code,
       nom, "sectionPk", code AS troncon, "regionId", "pkDebut", "pkFin", fin_precedente,
       round((GREATEST(fin_precedente - "pkDebut", "pkDebut" - fin_precedente))::numeric, 3) AS ecart_km
  FROM base
 WHERE (fin_precedente - "pkDebut" > 0.05 + 1e-9 OR "pkDebut" - fin_precedente > 0.5 + 1e-9)
   AND (:region_id::int IS NULL OR "regionId" = :region_id::int)
 ORDER BY ecart_km DESC LIMIT 200;

-- 4. Longueur declaree contre longueur geodesique (ecart > 10 % ET >= 50 m) ------------------------------
SELECT count(*) AS longueur_ecart_geometrie
  FROM (
    SELECT t."longueurKm" AS declaree, ST_Length(t.geom::geography) / 1000.0 AS geom_km
      FROM troncons t
     WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL AND NOT ST_IsEmpty(t.geom)
       AND t."longueurKm" > 0 AND (:region_id::int IS NULL OR t."regionId" = :region_id::int)
  ) m
 WHERE geom_km >= 0.00001
   AND abs(declaree - geom_km) / geom_km > 0.10 + 1e-9 AND abs(declaree - geom_km) >= 0.05 - 1e-9;

-- 5. Geometries invalides et de longueur nulle (< 1 cm) ---------------------------------------------------
SELECT count(*) FILTER (WHERE NOT ST_IsValid(geom))                                      AS geom_invalide,
       count(*) FILTER (WHERE ST_SRID(geom) = 4326 AND ST_Length(geom::geography) < 0.01) AS geom_longueur_nulle
  FROM troncons
 WHERE "deletedAt" IS NULL AND geom IS NOT NULL AND NOT ST_IsEmpty(geom)
   AND (:region_id::int IS NULL OR "regionId" = :region_id::int);

-- 6. Doublons de geometrie STRICTS (egalite binaire) ----------------------------------------------------------
-- Les jumeaux inverses et les quasi-doublons ne sont vus que par la route (voir DETECTEURS.md).
SELECT count(*) AS groupes, coalesce(sum(n) - count(*), 0) AS troncons_en_trop
  FROM (SELECT count(*) AS n FROM troncons t
         WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL AND NOT ST_IsEmpty(t.geom) AND ST_IsValid(t.geom)
           AND (:region_id::int IS NULL OR t."regionId" = :region_id::int)
         GROUP BY ST_AsBinary(t.geom) HAVING count(*) > 1) d;

ROLLBACK;
