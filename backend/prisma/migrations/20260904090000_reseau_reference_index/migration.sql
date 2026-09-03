-- Distinguer le reseau de reference de la voirie promue (P4).
--
-- POURQUOI CETTE MIGRATION EXISTE
--
-- La promotion nationale porte `troncons` de 2 040 a environ 264 000 lignes. Le
-- registre peut le supporter ; la vue d'ensemble publique, non.
--
-- Mesure du 03/09/2026 : `/api/public/carte/geo` sert TOUS les troncons d'un coup,
-- sans emprise — 3,0 Mo bruts pour 2 040. Les 262 306 voies restantes representent
-- 132 Mo de GeoJSON. Le corps de reponse atteindrait environ 135 Mo, et la carte
-- publique cesserait de fonctionner, en premier lieu sur les connexions mobiles de
-- Guinee.
--
-- Or elle n'a pas besoin de les peindre : la couche voirie, cadree par emprise
-- au-dela du zoom 12, les affiche deja — et depuis le 3 septembre chacune s'ouvre en
-- fiche et renvoie a son troncon. Ce qui manquait n'etait pas l'affichage.
--
-- LA DISTINCTION N'EST PAS UN MASQUAGE
--
-- Une voie promue EST un actif du patrimoine : elle compte au registre, sort dans
-- les exports, peut porter des chantiers et des inspections. Ce que cet index
-- permet, c'est seulement de servir la vue d'ensemble sans transporter 132 Mo.
--
-- Le discriminant est `sourceReference`, que le script de promotion renseigne a
-- 'voirie_locale:<id>'. Il dit d'ou vient l'enregistrement, ce qui est exactement la
-- question posee.
--
-- POURQUOI UN INDEX PARTIEL
--
-- Sans lui, servir le reseau de reference imposerait un parcours des 264 000 lignes
-- pour en retenir 2 000. L'index partiel ne porte que les lignes du reseau de
-- reference : PostgreSQL le retient pour une requete dont la clause WHERE implique
-- son predicat.
--
-- L'index sur voirie_locale("tronconId") sert la jointure inverse — la fiche d'une
-- voie doit dire quel troncon la porte, et la contrainte de cle etrangere creee en
-- septembre n'indexe que la colonne referencee.
--
-- REVERSIBILITE
--
--     DROP INDEX "troncons_reseau_reference_idx";
--     DROP INDEX "voirie_locale_tronconId_idx";
--
-- Aucune donnee n'est ecrite, aucune colonne ajoutee.

CREATE INDEX IF NOT EXISTS "troncons_reseau_reference_idx"
  ON "troncons" ("deletedAt")
  WHERE "sourceReference" IS NULL OR "sourceReference" NOT LIKE 'voirie_locale:%';

CREATE INDEX IF NOT EXISTS "voirie_locale_tronconId_idx"
  ON "voirie_locale" ("tronconId")
  WHERE "tronconId" IS NOT NULL;
