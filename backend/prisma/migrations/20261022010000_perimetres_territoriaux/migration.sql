-- PERIMETRES TERRITORIAUX DES COMPTES (paragraphe 7.9, scenario A10 « hors zone »)
--
-- « 403 sur appel direct d'API pour un LECTEUR ou hors zone. » -- scenario A10.
--
-- L'ETAT AVANT : les comptes ne portent aucune region. La seule restriction territoriale est
-- celle des delegations de VALIDATION. Un gestionnaire peut ECRIRE partout : creer, modifier,
-- retirer un troncon, un ouvrage, un point noir, un poste, un chantier, un defaut, une
-- observation ou une portion dans n'importe quelle region (decision D-11 du 20/10/2026).
--
-- CE QUE CETTE MIGRATION FAIT : une table. Un compte peut se voir attribuer une ou plusieurs
-- regions, avec un debut, un terme et une revocation, par un ADMIN qui est trace. Le service
-- (`governance/perimetre.ts`) l'applique aux ecritures des huit domaines.
--
-- LA REGLE PROVISOIRE, ET POURQUOI : RESSERREMENT PAR COMPTE. Un compte SANS aucun perimetre en
-- vigueur garde le comportement d'avant (national). Des qu'il en a un, il n'ecrit que dans ses
-- regions, et un objet de region inconnue lui est refuse. C'est la meme regle que celle des
-- delegations (`governance/delegation.ts`), et pour la meme raison : AGEROUTE n'a pas fourni la
-- liste des comptes et de leur perimetre (D-11, point 2), et exiger un perimetre bloquerait toute
-- ecriture le jour du deploiement. Le nombre de comptes sans perimetre est rendu par l'API pour
-- que cet etat se lise au lieu de se deviner. AUCUN perimetre n'est seme.
--
-- NATURE : additive. Une table, ses index. Aucune ligne existante touchee.

CREATE TABLE IF NOT EXISTS "perimetres_territoriaux" (
  "id"          TEXT PRIMARY KEY,
  "userId"      TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "regionId"    INTEGER NOT NULL REFERENCES "regions"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "debutLe"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Terme. NUL = sans terme.
  "finLe"       TIMESTAMP(3),
  -- Revocation anticipee, conservee : un perimetre revoque a existe.
  "revoqueLe"   TIMESTAMP(3),
  "motif"       TEXT NOT NULL,
  "attribueParId" TEXT NOT NULL REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "perimetre_periode" CHECK ("finLe" IS NULL OR "finLe" > "debutLe"),
  CONSTRAINT "perimetre_motif" CHECK (length(btrim("motif")) > 0),
  -- Personne ne s'attribue un territoire a soi-meme.
  CONSTRAINT "perimetre_pas_soi_meme" CHECK ("attribueParId" <> "userId")
);
CREATE INDEX IF NOT EXISTS "perimetres_territoriaux_userId_idx" ON "perimetres_territoriaux" ("userId");
-- Une seule attribution non revoquee par compte et region : la seconde serait un doublon.
CREATE UNIQUE INDEX IF NOT EXISTS "perimetres_territoriaux_actif_key"
  ON "perimetres_territoriaux" ("userId", "regionId") WHERE "revoqueLe" IS NULL;

COMMENT ON TABLE "perimetres_territoriaux" IS
  'Regions ou un compte peut ecrire (A10). Sans perimetre en vigueur : national, regle provisoire '
  'tant qu''AGEROUTE n''a pas fourni les perimetres (D-11). Aucune ligne semee.';
