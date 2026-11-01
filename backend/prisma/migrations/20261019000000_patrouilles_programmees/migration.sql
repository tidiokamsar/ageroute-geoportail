-- PATROUILLES PROGRAMMEES (paragraphe 7.17, EX-03)
--
-- « Type de mission recurrent avec itineraire obligatoire et periodicite par classe d'axe
-- (ex. RN strategiques hebdomadaires en saison des pluies), executees en mode roulage ; taux de
-- couverture de patrouille, retards, ecarts d'itineraire ; dispatch d'une patrouille de
-- verification sur un signalement citoyen ou une alerte capteur, avec prise en compte tracee. »
--
-- UN PROGRAMME ENGENDRE DES MISSIONS, IL N'EN EST PAS UNE. Les missions existent, avec leur
-- cycle de vie teste (`field/missions.regles.ts`), leurs traces et leurs observations. Une
-- patrouille programmee est donc un PROGRAMME -- itineraire, periodicite, mois actifs -- et
-- chaque passage est une mission ordinaire qui le cite. Rien n'est duplique.
--
-- RIEN N'EST SEME, ET C'EST VOULU. Le mandat donne un EXEMPLE (« RN strategiques hebdomadaires
-- en saison des pluies »), pas une norme. La periodicite, les mois actifs et les itineraires
-- sont saisis par AGEROUTE. Les saisons, en particulier, ne sont pas codees : elles different
-- selon les regions de Guinee, et fixer « juin a octobre » ici serait inventer un calendrier.
-- Les mois actifs sont une liste de mois (1 a 12) ; vide, le programme vaut toute l'annee.
--
-- LA COUVERTURE se calcule en base, par `couverture_patrouille(mission, tolerance_m)` : pour
-- chaque troncon de l'itineraire, la longueur passant a moins de `tolerance_m` d'une trace de la
-- mission, mesuree par echantillonnage geodesique (voir la fonction). La tolerance par defaut est 30 m -- le rayon minimal que le paragraphe 7.3 fixe
-- lui-meme pour le rattachement GPS, R = max(30 m, 2 x precision). Elle est un parametre, pas une
-- constante cachee. Aucun seuil « couvert / non couvert » n'est pose : la fonction rend des
-- longueurs et des taux, la decision reste a qui lit.
--
-- NATURE : additive. Deux tables, deux colonnes nullables sur `missions`, une fonction. Aucune
-- ligne existante modifiee.

-- PostgreSQL refuse une sous-requete dans un CHECK : l'absence de doublon passe par une fonction
-- IMMUTABLE, qui y est admise.
CREATE OR REPLACE FUNCTION mois_actifs_valides(mois INTEGER[]) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT mois <@ ARRAY[1,2,3,4,5,6,7,8,9,10,11,12]
     AND cardinality(mois) = (SELECT count(DISTINCT m) FROM unnest(mois) AS m)
     AND array_position(mois, NULL) IS NULL;
$fn$;

CREATE TABLE IF NOT EXISTS "programmes_patrouille" (
  "id"       TEXT PRIMARY KEY,
  "code"     TEXT NOT NULL,
  "libelle"  TEXT NOT NULL,
  -- Classe d'axe visee, pour le regroupement et les statistiques : l'enum existant des
  -- troncons, reutilise tel quel (aucune valeur ajoutee). Ce n'est pas une regle d'attribution.
  "classeAxe" "ClasseRoute",
  "regionId"  INTEGER REFERENCES "regions"("id") ON UPDATE CASCADE ON DELETE SET NULL,

  -- Saisie par AGEROUTE, jamais par defaut.
  "periodiciteJours" INTEGER NOT NULL,
  -- Mois ou le programme est actif (1 = janvier). Vide : toute l'annee.
  "moisActifs" INTEGER[] NOT NULL DEFAULT '{}',

  "responsableId" TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "creeParId"     TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "actif"     BOOLEAN NOT NULL DEFAULT true,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "programme_periodicite_positive" CHECK ("periodiciteJours" BETWEEN 1 AND 366),
  -- Chaque mois entre 1 et 12, sans doublon ni NULL.
  CONSTRAINT "programme_mois_valides" CHECK (mois_actifs_valides("moisActifs")),
  CONSTRAINT "programme_libelle_non_vide" CHECK (length(btrim("libelle")) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "programmes_patrouille_code_key" ON "programmes_patrouille" ("code");
CREATE INDEX IF NOT EXISTS "programmes_patrouille_actif_idx" ON "programmes_patrouille" ("actif") WHERE "deletedAt" IS NULL;

-- L'ITINERAIRE OBLIGATOIRE : une liste ORDONNEE de troncons. Une liste et non une geometrie
-- dessinee, pour que la couverture se mesure troncon par troncon sur le referentiel, et qu'un
-- itineraire suive le reseau au lieu de le croiser.
CREATE TABLE IF NOT EXISTS "programme_troncons" (
  "programmeId" TEXT NOT NULL REFERENCES "programmes_patrouille"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  "tronconId"   TEXT NOT NULL REFERENCES "troncons"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "ordre"       INTEGER NOT NULL,
  PRIMARY KEY ("programmeId", "tronconId"),
  CONSTRAINT "programme_troncon_ordre_positif" CHECK ("ordre" >= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS "programme_troncons_ordre_key" ON "programme_troncons" ("programmeId", "ordre");

-- Une mission cite le programme qu'elle execute, ou le signalement qu'elle verifie.
ALTER TABLE "missions"
  ADD COLUMN IF NOT EXISTS "programmeId"   TEXT REFERENCES "programmes_patrouille"("id") ON UPDATE CASCADE ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "signalementId" TEXT REFERENCES "signalements_citoyens"("id") ON UPDATE CASCADE ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "missions_programmeId_idx" ON "missions" ("programmeId");
CREATE INDEX IF NOT EXISTS "missions_signalementId_idx" ON "missions" ("signalementId");

-- ===== Couverture d'une mission de patrouille =====
--
-- Pour chaque troncon de l'itineraire du programme de la mission : sa longueur, la longueur
-- passant a moins de `tolerance_m` d'une trace de la mission, et le taux. Plus, sur une ligne a
-- part (tronconId NULL), les kilometres de trace parcourus HORS de l'itineraire -- l'ecart.
--
-- METHODE : ECHANTILLONNAGE, PAS D'OVERLAY. Chaque ligne est decoupee en segments d'au plus
-- `pas` metres (`ST_Segmentize` en geography) ; un segment compte comme couvert si son milieu
-- est a moins de `tolerance_m` de la trace (`ST_DWithin` en geography, exact). Une premiere
-- version calculait `ST_Intersection(troncon, tampon de la trace)` : sous GEOS 3.9, elle a rendu
-- une ligne VIDE pour un troncon que la trace suivait exactement et que le tampon couvrait
-- (`ST_Covers` vrai) -- fragilite connue de l'overlay sur des lignes colineaires. Le banc
-- d'essai garde ce cas precis. Precision : un demi-pas a chaque entree ou sortie de la zone.
-- `pas` = min(10 m, tolerance / 2), pour qu'un segment ne soit jamais plus long que la zone.
CREATE OR REPLACE FUNCTION couverture_patrouille(mission_id TEXT, tolerance_m DOUBLE PRECISION DEFAULT 30)
RETURNS TABLE (
  "tronconId"  TEXT,
  "ordre"      INTEGER,
  "longueurM"  DOUBLE PRECISION,
  "couvertM"   DOUBLE PRECISION,
  "taux"       DOUBLE PRECISION
)
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  pas DOUBLE PRECISION;
BEGIN
  IF tolerance_m IS NULL OR tolerance_m <= 0 THEN
    RAISE EXCEPTION 'couverture_patrouille : la tolerance doit etre strictement positive (recu : %)', tolerance_m
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  pas := LEAST(10, tolerance_m / 2);

  RETURN QUERY
  WITH m AS (
    SELECT mi."programmeId" AS programme_id FROM "missions" mi WHERE mi."id" = mission_id
  ),
  -- ST_Collect et non ST_Union : aucune operation d'overlay.
  trace_mission AS (
    SELECT ST_Collect(tr."geom") AS g FROM "traces" tr WHERE tr."missionId" = mission_id AND tr."geom" IS NOT NULL
  ),
  itin AS (
    SELECT pt."tronconId" AS troncon_id, pt."ordre" AS ordre_t, t."geom" AS geom_t
      FROM "programme_troncons" pt
      JOIN m ON m.programme_id = pt."programmeId"
      JOIN "troncons" t ON t."id" = pt."tronconId"
  ),
  itin_geom AS (
    SELECT ST_Collect(geom_t) AS g FROM itin WHERE geom_t IS NOT NULL
  ),
  seg_troncon AS (
    SELECT i.troncon_id, d.geom AS s
      FROM itin i
      CROSS JOIN LATERAL ST_DumpSegments(ST_Segmentize(i.geom_t::geography, pas)::geometry) d
     WHERE i.geom_t IS NOT NULL
  ),
  couv AS (
    SELECT st.troncon_id, SUM(ST_Length(st.s::geography)) AS couv_m
      FROM seg_troncon st CROSS JOIN trace_mission tm
     WHERE tm.g IS NOT NULL
       AND ST_DWithin(ST_LineInterpolatePoint(st.s, 0.5)::geography, tm.g::geography, tolerance_m)
     GROUP BY st.troncon_id
  ),
  par_troncon AS (
    SELECT i.troncon_id, i.ordre_t,
           COALESCE(ST_Length(i.geom_t::geography), 0) AS long_m,
           COALESCE(c.couv_m, 0) AS couv_m
      FROM itin i LEFT JOIN couv c ON c.troncon_id = i.troncon_id
  ),
  seg_trace AS (
    SELECT d.geom AS s
      FROM trace_mission tm
      CROSS JOIN LATERAL ST_DumpSegments(ST_Segmentize(tm.g::geography, pas)::geometry) d
     WHERE tm.g IS NOT NULL
  ),
  hors AS (
    -- La trace qui passe a plus de `tolerance_m` de tout troncon de l'itineraire : l'ecart.
    SELECT COALESCE(SUM(ST_Length(sg.s::geography)), 0) AS hors_m
      FROM seg_trace sg CROSS JOIN itin_geom ig
     WHERE ig.g IS NULL
        OR NOT ST_DWithin(ST_LineInterpolatePoint(sg.s, 0.5)::geography, ig.g::geography, tolerance_m)
  )
  SELECT p.troncon_id, p.ordre_t, p.long_m, LEAST(p.couv_m, p.long_m),
         CASE WHEN p.long_m > 0 THEN LEAST(p.couv_m, p.long_m) / p.long_m ELSE NULL END
    FROM par_troncon p
  UNION ALL
  -- Ligne d'ecart : tronconId NULL, longueur = metres de trace hors itineraire.
  SELECT NULL::TEXT, NULL::INTEGER, h.hors_m, NULL::DOUBLE PRECISION, NULL::DOUBLE PRECISION FROM hors h
  ORDER BY 2 NULLS LAST;
END;
$fn$;

COMMENT ON TABLE "programmes_patrouille" IS
  'Patrouilles programmees (paragraphe 7.17, EX-03). Un programme engendre des missions '
  'SURVEILLANCE ordinaires. Periodicite, mois actifs et itineraire sont saisis par AGEROUTE : '
  'rien n''est seme, le mandat ne donne qu''un exemple.';
COMMENT ON FUNCTION couverture_patrouille(TEXT, DOUBLE PRECISION) IS
  'Couverture d''une mission de patrouille, troncon par troncon, et metres de trace hors itineraire '
  '(ligne a tronconId NULL). Tolerance par defaut 30 m, le rayon minimal du paragraphe 7.3. '
  'Aucun seuil couvert / non couvert : des longueurs et des taux.';
