-- Controle d'acces territorial (A10, « 403 hors zone ») : le perimetre regional d'un compte.
--
-- Un compte peut etre rattache a une ou plusieurs regions. Tant qu'il n'en a AUCUNE, son perimetre
-- est NATIONAL : c'est le comportement d'avant, et l'ecran d'administration compte ces comptes
-- pour que l'etat se lise (meme regle de resserrement que les delegations de validation). Des
-- qu'une region lui est rattachee, ses ecritures sur les huit domaines (troncons, ouvrages, points
-- noirs, postes, chantiers, defauts, observations, portions) sont refusees hors de ses regions.
--
-- Aucun rattachement n'est seme : c'est une donnee d'organisation, fournie par AGEROUTE (D-11).
-- Additive.

CREATE TABLE IF NOT EXISTS "perimetres_comptes" (
  "userId"       TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  "regionId"     INTEGER NOT NULL REFERENCES "regions"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "accordeParId" TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "accordeLe"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "perimetres_comptes_pkey" PRIMARY KEY ("userId", "regionId")
);
CREATE INDEX IF NOT EXISTS "perimetres_comptes_regionId_idx" ON "perimetres_comptes" ("regionId");

COMMENT ON TABLE "perimetres_comptes" IS
  'Perimetre regional d''un compte (A10). Aucune ligne = perimetre national. Donnee d''organisation fournie par AGEROUTE, jamais semee.';
