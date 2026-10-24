-- OBSERVATION DE LA TERRE : REGISTRE DES PRODUITS ET PROPOSITIONS DE TELEDETECTION (partie E)
--
-- « Chaque produit porte date, resolution, masque de nuages, incertitude, provenance et licence ;
-- les sorties sont des propositions ou des indicateurs etiquetes, jamais des donnees officielles
-- directes ; tout service payant est une depense a autoriser. » -- partie E du mandat V10.
-- « Module earth_observation_products (produit, source, date, resolution, emprise, licence,
-- version de traitement) ; [...] mesure de la precision de chaque detection contre les constats
-- terrain (le terrain reste juge). » -- paragraphe E.1.
--
-- CE QUE CETTE MIGRATION FAIT
--
--   - `earth_observation_products` : le registre. Un produit sans licence, sans provenance, sans
--     incertitude ou sans version de traitement est REFUSE par la base. Un produit optique porte
--     sa couverture nuageuse ; un produit d'un palier payant (1 a 3) porte la reference de
--     l'autorisation de depense, sinon il est refuse.
--   - `propositions_teledetection` : ce qu'un traitement propose (nouvelle route, coupure
--     probable, vegetation, inondation), localise, rattache au troncon le plus proche si l'appelant
--     l'a demande avec une tolerance explicite. Une proposition est A_VERIFIER ; seul un constat
--     de terrain la CONFIRME ou l'INFIRME, une fois, et ce verdict ne se reprend pas.
--   - `precision_teledetection` : une vue, par type et par methode, de ce que le terrain a dit.
--
-- CE QU'ELLE NE FAIT PAS
--
-- Elle ne telecharge rien et ne traite aucune image : le moteur de changement (rasterio, xarray,
-- API Copernicus) n'est pas dans ce depot, et ses sources restent a choisir. Elle ne seme aucun
-- produit. Une proposition ne modifie JAMAIS un troncon, une portion ni un etat : elle reste une
-- proposition, et le declencheur interdit qu'on la fasse passer pour autre chose.
--
-- NATURE : additive. Deux tables, une vue, un declencheur. Aucune ligne existante touchee.

CREATE TABLE IF NOT EXISTS "earth_observation_products" (
  "id"           TEXT PRIMARY KEY,
  "code"         TEXT NOT NULL,
  "palier"       INTEGER NOT NULL,
  -- Mission ou jeu source, tel que la source le nomme (ex. « Sentinel-2 L2A »).
  "source"       TEXT NOT NULL,
  "nature"       TEXT NOT NULL,
  "dateAcquisition" TIMESTAMP(3) NOT NULL,
  "dateFin"      TIMESTAMP(3),
  "resolutionM"  DOUBLE PRECISION NOT NULL,
  -- Part de l'emprise couverte de nuages, en pourcentage. Obligatoire pour un produit optique ;
  -- sans objet pour le radar, qui voit a travers.
  "couvertureNuagesPct" DOUBLE PRECISION,
  "incertitude"  TEXT NOT NULL,
  -- Identifiant de la scene ou du jeu, ou adresse de la page d'origine.
  "provenance"   TEXT NOT NULL,
  -- Relevee a la source, jamais supposee.
  "licence"      TEXT NOT NULL,
  "versionTraitement" TEXT NOT NULL,
  -- Palier 1 a 3 : la depense doit avoir ete autorisee (paragraphes A.5-6).
  "autorisationDepenseRef" TEXT,
  "emprise"      geometry(Polygon, 4326) NOT NULL,
  "enregistreParId" TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt"    TIMESTAMP(3),

  CONSTRAINT "eo_palier" CHECK ("palier" BETWEEN 0 AND 3),
  CONSTRAINT "eo_nature" CHECK ("nature" IN ('OPTIQUE', 'RADAR', 'ALTIMETRIE', 'PRECIPITATIONS', 'POPULATION', 'INONDATION', 'ROUTES_EXTRAITES')),
  CONSTRAINT "eo_resolution" CHECK ("resolutionM" > 0),
  CONSTRAINT "eo_nuages_bornes" CHECK ("couvertureNuagesPct" IS NULL OR "couvertureNuagesPct" BETWEEN 0 AND 100),
  CONSTRAINT "eo_nuages_optique" CHECK ("nature" <> 'OPTIQUE' OR "couvertureNuagesPct" IS NOT NULL),
  CONSTRAINT "eo_champs_non_vides" CHECK (
    length(btrim("source")) > 0 AND length(btrim("incertitude")) > 0 AND length(btrim("provenance")) > 0
    AND length(btrim("licence")) > 0 AND length(btrim("versionTraitement")) > 0
  ),
  CONSTRAINT "eo_depense_autorisee" CHECK ("palier" = 0 OR length(btrim(coalesce("autorisationDepenseRef", ''))) > 0),
  CONSTRAINT "eo_periode" CHECK ("dateFin" IS NULL OR "dateFin" >= "dateAcquisition"),
  CONSTRAINT "eo_emprise_valide" CHECK (ST_IsValid("emprise"))
);
CREATE UNIQUE INDEX IF NOT EXISTS "earth_observation_products_code_key" ON "earth_observation_products" ("code");
CREATE INDEX IF NOT EXISTS "earth_observation_products_emprise_gist" ON "earth_observation_products" USING gist ("emprise");

CREATE TABLE IF NOT EXISTS "propositions_teledetection" (
  "id"          TEXT PRIMARY KEY,
  "produitId"   TEXT NOT NULL REFERENCES "earth_observation_products"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- Produit de la date de reference, pour une detection par comparaison de deux dates.
  "produitReferenceId" TEXT REFERENCES "earth_observation_products"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "type"        TEXT NOT NULL,
  -- Nom et version de la methode qui a produit la proposition : la precision se mesure par methode.
  "methode"     TEXT NOT NULL,
  -- Score rendu par la methode, s'il en rend un. Ce n'est pas une probabilite d'exactitude.
  "score"       DOUBLE PRECISION,
  "geom"        geometry(Geometry, 4326) NOT NULL,
  "tronconId"   TEXT REFERENCES "troncons"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "distanceTronconM" DOUBLE PRECISION,
  "statut"      TEXT NOT NULL DEFAULT 'A_VERIFIER',
  "verifieeParId" TEXT REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "verifieeLe"  TIMESTAMP(3),
  "motifVerdict" TEXT,
  -- Le constat de terrain qui fonde le verdict, et la mission de verification depechee.
  "constatRef"  TEXT,
  "missionId"   TEXT REFERENCES "missions"("id") ON UPDATE CASCADE ON DELETE SET NULL,
  "creeParId"   TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "pt_type" CHECK ("type" IN ('NOUVELLE_ROUTE', 'COUPURE_PROBABLE', 'VEGETATION', 'INONDATION')),
  CONSTRAINT "pt_statut" CHECK ("statut" IN ('A_VERIFIER', 'CONFIRMEE', 'INFIRMEE')),
  CONSTRAINT "pt_score" CHECK ("score" IS NULL OR "score" BETWEEN 0 AND 1),
  CONSTRAINT "pt_methode" CHECK (length(btrim("methode")) > 0),
  CONSTRAINT "pt_rattachement" CHECK (("tronconId" IS NULL) = ("distanceTronconM" IS NULL)),
  CONSTRAINT "pt_geom_valide" CHECK (ST_IsValid("geom") AND NOT ST_IsEmpty("geom")),
  CONSTRAINT "pt_deux_dates" CHECK ("produitReferenceId" IS NULL OR "produitReferenceId" <> "produitId"),
  -- Un verdict porte son auteur, son heure, son motif et son constat ; une proposition a verifier
  -- n'en porte aucun.
  CONSTRAINT "pt_verdict_complet" CHECK (
    ("statut" = 'A_VERIFIER' AND "verifieeParId" IS NULL AND "verifieeLe" IS NULL AND "motifVerdict" IS NULL AND "constatRef" IS NULL)
    OR ("statut" <> 'A_VERIFIER' AND "verifieeParId" IS NOT NULL AND "verifieeLe" IS NOT NULL
        AND length(btrim(coalesce("motifVerdict", ''))) > 0 AND length(btrim(coalesce("constatRef", ''))) > 0)
  )
);
CREATE INDEX IF NOT EXISTS "propositions_teledetection_statut_idx" ON "propositions_teledetection" ("statut");
CREATE INDEX IF NOT EXISTS "propositions_teledetection_troncon_idx" ON "propositions_teledetection" ("tronconId");
CREATE INDEX IF NOT EXISTS "propositions_teledetection_geom_gist" ON "propositions_teledetection" USING gist ("geom");

-- ===== Le terrain juge une fois, et seulement cela peut changer =====
--
-- Seules transitions admises : A_VERIFIER -> CONFIRMEE ou INFIRMEE, et le rattachement d'une
-- mission de verification (une fois). Tout le reste -- geometrie, type, methode, score, produit,
-- rattachement au troncon -- est fige a l'insertion : modifier une detection apres coup fausserait
-- la mesure de precision. Aucune suppression.
CREATE OR REPLACE FUNCTION propositions_teledetection_garde() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'propositions_teledetection : suppression refusee, la mesure de precision en depend'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."produitId" IS DISTINCT FROM OLD."produitId" OR NEW."produitReferenceId" IS DISTINCT FROM OLD."produitReferenceId"
     OR NEW."type" IS DISTINCT FROM OLD."type" OR NEW."methode" IS DISTINCT FROM OLD."methode"
     OR NEW."score" IS DISTINCT FROM OLD."score" OR NOT ST_Equals(NEW."geom", OLD."geom")
     OR NEW."tronconId" IS DISTINCT FROM OLD."tronconId" OR NEW."distanceTronconM" IS DISTINCT FROM OLD."distanceTronconM"
     OR NEW."creeParId" IS DISTINCT FROM OLD."creeParId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'propositions_teledetection : la detection est figee ; seuls le verdict et la mission changent'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."statut" <> 'A_VERIFIER' AND (
       NEW."statut" IS DISTINCT FROM OLD."statut" OR NEW."verifieeParId" IS DISTINCT FROM OLD."verifieeParId"
       OR NEW."verifieeLe" IS DISTINCT FROM OLD."verifieeLe" OR NEW."motifVerdict" IS DISTINCT FROM OLD."motifVerdict"
       OR NEW."constatRef" IS DISTINCT FROM OLD."constatRef") THEN
    RAISE EXCEPTION 'propositions_teledetection : le verdict du terrain (%) ne se reprend pas', OLD."statut"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."missionId" IS NOT NULL AND NEW."missionId" IS DISTINCT FROM OLD."missionId" THEN
    RAISE EXCEPTION 'propositions_teledetection : la mission de verification est deja rattachee'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."statut" <> 'A_VERIFIER' AND OLD."statut" = 'A_VERIFIER' THEN
    NEW."verifieeLe" := CURRENT_TIMESTAMP(3);
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS propositions_teledetection_garde ON "propositions_teledetection";
CREATE TRIGGER propositions_teledetection_garde
  BEFORE UPDATE OR DELETE ON "propositions_teledetection"
  FOR EACH ROW EXECUTE FUNCTION propositions_teledetection_garde();

-- ===== Ce que le terrain a dit, par type et par methode =====
--
-- precision = confirmees / (confirmees + infirmees). Nulle tant qu'aucune n'est jugee : une
-- methode sans verdict n'a pas de precision, elle n'a pas une precision de zero.
CREATE OR REPLACE VIEW "precision_teledetection" AS
SELECT "type", "methode",
       count(*)::integer AS "total",
       count(*) FILTER (WHERE "statut" = 'A_VERIFIER')::integer AS "aVerifier",
       count(*) FILTER (WHERE "statut" = 'CONFIRMEE')::integer AS "confirmees",
       count(*) FILTER (WHERE "statut" = 'INFIRMEE')::integer AS "infirmees",
       CASE WHEN count(*) FILTER (WHERE "statut" <> 'A_VERIFIER') = 0 THEN NULL
            ELSE (count(*) FILTER (WHERE "statut" = 'CONFIRMEE'))::double precision
                 / (count(*) FILTER (WHERE "statut" <> 'A_VERIFIER')) END AS "precision"
  FROM "propositions_teledetection"
 GROUP BY "type", "methode";

COMMENT ON TABLE "earth_observation_products" IS
  'Registre des produits d''observation de la Terre (partie E). Licence, provenance, incertitude, version '
  'de traitement obligatoires ; couverture nuageuse pour l''optique ; autorisation de depense pour les paliers 1 a 3.';
COMMENT ON TABLE "propositions_teledetection" IS
  'Propositions issues de la teledetection, A_VERIFIER jusqu''au verdict du terrain, qui ne se reprend pas. '
  'Une proposition ne modifie jamais le referentiel.';
