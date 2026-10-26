-- OBSERVATION DE LA TERRE, LOT 1 (EO-DB) : QUALITE DES METHODES SOUS SEUIL D'ECHANTILLON
--
-- La vue historique `precision_teledetection` rendait un rapport confirmees / jugees sans dire sur combien de
-- verdicts il reposait : 1 confirmee sur 1 jugee donnait « 100 % ». Cette vue-ci porte l'EFFECTIF et dit si
-- l'echantillon est suffisant.
--
-- CE QUE LA VUE DIT : le taux de CONFIRMATION terrain = confirmees / (confirmees + infirmees). Ce n'est PAS la
-- precision statistique d'une methode : il ne voit pas les changements reels que la methode n'a pas detectes
-- (aucun rappel). La precision et le rappel exigent un protocole de reference terrain qui n'existe pas encore :
-- ils ne sont donc pas calcules ici.
--
--   - `tauxConfirmation` est NULL tant qu'aucun verdict n'est rendu (jamais zero : zero verdict n'est pas zero %).
--   - `echantillonSuffisant` = (effectif juge >= seuil). Le seuil est la constante nommee
--     `eo_seuil_echantillon_taux()` : 30, PROVISOIRE (choix de conduite reversible, a fixer par AGEROUTE). La meme
--     valeur existe cote application (`SEUIL_ECHANTILLON_TAUX`, teledetection.noyau.ts) ; un banc verifie
--     qu'elles sont egales.
--   - Les donnees synthetiques sont exclues.
--   - `precision_teledetection` (vue historique) est conservee pour compatibilite.
--
-- NATURE : additive (une fonction, une vue). Aucune donnee touchee. Idempotente.

CREATE OR REPLACE FUNCTION eo_seuil_echantillon_taux() RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$ SELECT 30 $fn$;

COMMENT ON FUNCTION eo_seuil_echantillon_taux() IS
  'PROVISOIRE : effectif minimal de verdicts (CONFIRMEE + INFIRMEE) au-dessous duquel un taux de confirmation n''est pas '
  'presente comme fiable. Valeur de conduite (30), a fixer par AGEROUTE ; doit rester egale a SEUIL_ECHANTILLON_TAUX (teledetection.noyau.ts).';

CREATE OR REPLACE VIEW "qualite_methodes_eo" AS
SELECT "type", "methode", "methodeNom", "methodeVersion",
       count(*)::integer AS "total",
       count(*) FILTER (WHERE "statut" = 'A_VERIFIER')::integer AS "aVerifier",
       count(*) FILTER (WHERE "statut" = 'EN_ATTENTE')::integer AS "enAttente",
       count(*) FILTER (WHERE "statut" = 'NON_CONCLUANTE')::integer AS "nonConcluantes",
       count(*) FILTER (WHERE "statut" = 'CONFIRMEE')::integer AS "confirmees",
       count(*) FILTER (WHERE "statut" = 'INFIRMEE')::integer AS "infirmees",
       count(*) FILTER (WHERE "statut" IN ('CONFIRMEE', 'INFIRMEE'))::integer AS "jugees",
       CASE WHEN count(*) FILTER (WHERE "statut" IN ('CONFIRMEE', 'INFIRMEE')) = 0 THEN NULL
            ELSE (count(*) FILTER (WHERE "statut" = 'CONFIRMEE'))::double precision
                 / (count(*) FILTER (WHERE "statut" IN ('CONFIRMEE', 'INFIRMEE'))) END AS "tauxConfirmation",
       (count(*) FILTER (WHERE "statut" IN ('CONFIRMEE', 'INFIRMEE')) >= eo_seuil_echantillon_taux()) AS "echantillonSuffisant",
       eo_seuil_echantillon_taux() AS "seuilEchantillon"
  FROM "propositions_teledetection"
 WHERE NOT "synthetique"
 GROUP BY "type", "methode", "methodeNom", "methodeVersion";

COMMENT ON VIEW "qualite_methodes_eo" IS
  'Taux de confirmation terrain par type et methode, avec effectif et indicateur d''echantillon suffisant. '
  'Ce n''est pas la precision statistique (aucun rappel). Donnees synthetiques exclues.';
