-- AGEROUTE ROAD : les quatre familles d'actifs manquantes, et leur etendue.
--
-- CE QUI MANQUAIT
--
-- `TypeOuvrage` portait neuf valeurs. Le cahier demande aussi les fosses, les caniveaux,
-- la signalisation et les glissieres : on ne pouvait donc inventorier ni un fosse ni une
-- glissiere, alors que ce sont les actifs les plus nombreux d'un reseau routier.
--
-- POURQUOI UNE ETENDUE, ET PAS SEULEMENT QUATRE VALEURS D'ENUM
--
-- Les quatre sont LINEAIRES, contrairement aux neuf precedents. `ouvrages.geom` est un
-- `geometry(Point,4326)` : y ranger un fosse de deux kilometres le reduirait a une epingle,
-- et le metre d'un curage de fosse serait alors impossible a etablir depuis le patrimoine.
--
-- D'ou `abscisseDebutM` / `abscisseFinM`, MEME REFERENCE QUE LES PORTIONS : des metres
-- depuis le debut de la geometrie du troncon. Le PK reste la, complementaire, mais il n'est
-- pas calculable sur les 1 029 troncons regionaux, et faire dependre l'inventaire du PK
-- aurait rendu la voirie regionale inventoriable nulle part.
--
-- `geom` RESTE LE POINT DE REPERAGE, celui qu'on epingle sur la carte. Pour un actif
-- lineaire, `geomLigne` dit l'etendue, et les ABSCISSES font autorite sur les deux : si le
-- trace de reference est corrige, la ligne se recalcule depuis elles, jamais l'inverse.
--
-- LES QUATRE AJOUTS D'ENUM SONT DEFINITIFS
--
-- PostgreSQL n'a pas de `ALTER TYPE ... DROP VALUE`. Troisieme fois dans ce socle, apres
-- `AuditAction` le 7 octobre et `DomaineValidation` ce matin. Sans consequence, mais le
-- rollback ne rend pas la base a son etat d'origine au sens strict.
--
-- CETTE MIGRATION EST ADDITIVE ET N'ECRIT AUCUNE LIGNE.
-- Les 1 172 ouvrages existants gardent leurs abscisses nulles : aucun n'est lineaire.

-- `IF NOT EXISTS` rend la migration rejouable si elle s'interrompait entre deux valeurs.
-- PostgreSQL 12 et au-dela acceptent plusieurs ADD VALUE par transaction, et la base de
-- production est en 17.
ALTER TYPE "TypeOuvrage" ADD VALUE IF NOT EXISTS 'FOSSE';
ALTER TYPE "TypeOuvrage" ADD VALUE IF NOT EXISTS 'CANIVEAU';
ALTER TYPE "TypeOuvrage" ADD VALUE IF NOT EXISTS 'SIGNALISATION';
ALTER TYPE "TypeOuvrage" ADD VALUE IF NOT EXISTS 'GLISSIERE';

ALTER TABLE "ouvrages"
  ADD COLUMN "abscisseDebutM" DOUBLE PRECISION,
  ADD COLUMN "abscisseFinM"   DOUBLE PRECISION,
  ADD COLUMN "geomLigne"      geometry(LineString,4326);

-- Index spatial, que Prisma ne sait pas declarer. Meme raison que `portions_geom_gist` :
-- sans lui, afficher les actifs lineaires d'une emprise balaie la table.
CREATE INDEX "ouvrages_geomLigne_gist" ON "ouvrages" USING GIST ("geomLigne");

-- Trouver les actifs lineaires d'un troncon est la requete que l'ecran de terrain posera.
CREATE INDEX "ouvrages_tronconId_abscisseDebutM_idx"
  ON "ouvrages"("tronconId", "abscisseDebutM");

-- LES DEUX ABSCISSES VONT ENSEMBLE OU PAS DU TOUT.
--
-- Une seule des deux decrirait une etendue dont on ignore une borne, ce qui n'est ni un
-- point ni une ligne. Mieux vaut refuser que stocker un objet dont personne ne saura dire
-- ce qu'il couvre.
ALTER TABLE "ouvrages"
  ADD CONSTRAINT "ouvrage_etendue_complete"
  CHECK (("abscisseDebutM" IS NULL) = ("abscisseFinM" IS NULL));

ALTER TABLE "ouvrages"
  ADD CONSTRAINT "ouvrage_etendue_ordonnee"
  CHECK ("abscisseDebutM" IS NULL OR "abscisseFinM" > "abscisseDebutM");

ALTER TABLE "ouvrages"
  ADD CONSTRAINT "ouvrage_etendue_non_negative"
  CHECK ("abscisseDebutM" IS NULL OR "abscisseDebutM" >= 0);

-- UNE ETENDUE EXIGE UN TRONCON.
--
-- Des abscisses se mesurent le long d'une geometrie de reference : sans troncon, elles ne
-- designent rien. Un actif lineaire non rattache garde donc sa seule position `geom`, ce
-- qui est honnete, plutot que des bornes flottantes.
ALTER TABLE "ouvrages"
  ADD CONSTRAINT "ouvrage_etendue_exige_troncon"
  CHECK ("abscisseDebutM" IS NULL OR "tronconId" IS NOT NULL);
