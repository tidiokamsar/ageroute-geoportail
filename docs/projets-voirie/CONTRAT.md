# Module « Projets de voirie et réseaux » : contrat d'interface

Statut : contrat de départ du 28/10/2026, commun au backend et au frontend. Branche d'origine : `integration/depuis-vendredi` (commit `b0f17ca`, déployé en production le 28/10/2026, 94 migrations appliquées).

## 1. Besoin

Un projet de voirie urbaine (exemple : voirie de Kissidougou) réunit : le **plan d'axes** de l'entreprise d'exécution (31 axes et tronçons de carrefour), les **réseaux de concessionnaires** (exemple : fibre Orange fournie en KML) et les **limites de route**. Le module doit permettre de charger ces fichiers dans le géoportail, de les afficher sur la carte du projet, et de sortir une analyse : longueurs par type de réseau, par concessionnaire, et **conflits** entre les réseaux et l'emprise des travaux.

Référence visuelle : un panneau latéral (onglets Analyse / Couches, segmentation par secteur, objets, propriétaires), une grande carte (plan ou satellite) avec les réseaux colorés par secteur, une fiche au clic.

## 2. Règles non négociables (AGENTS.md et décisions du 28/10)

1. Aucun secret, aucune donnée de concessionnaire dans le dépôt : les fixtures de test sont **synthétiques** (jamais le KML d'Orange, jamais le plan réel).
2. Suppression logique uniquement (`deletedAt`) ; une version remplacée reste en base.
3. Toute écriture est auditée dans `audit_logs` (création, import, retrait, changement de paramètres, export).
4. Migration Prisma versionnée, additive, **avec descente** dans `backend/prisma/descentes/` ; horodatage `20261030100000_projets_voirie_reseaux` ; jamais `db push`.
5. **Confidentialité** : les données de concessionnaires sont sensibles (tracé d'infrastructure critique). Défaut `RESTREINT`. Jamais dans l'API publique ni dans les exports publics de la carte. Lecture réservée aux comptes qui ont la clé de module `projets-voirie`.
6. Le calcul de conflit est une **aide à la décision**, jamais un verdict : tout résultat porte les hypothèses (largeurs « théoriques » tant qu'elles ne sont pas validées) et les limites (précision de position inconnue, profondeur inconnue).
7. Pas de déploiement : le déploiement se fait par `infra/deployer-console.sh`, validation humaine à l'étape 9.

> **Précision du DSI (28/10/2026)** : les fichiers des concessionnaires sont reçus directement de l'opérateur, l'autorisation d'exploitation est considérée acquise, sans écrit. Le champ de rattachement à une convention (`referenceConvention`) est donc supprimé du contrat et remplacé par `origineFichier`, texte libre facultatif. La confidentialité `RESTREINT` par défaut, les gardes de module, l'audit et l'exclusion de toute route publique restent inchangés.

## 3. Modèle de données (Prisma, base PostGIS 17)

Noms de tables en `snake_case` via `@@map`, colonnes en camelCase comme le reste du schéma. Géométries en `Unsupported("geometry(...,4326)")`, requêtes en SQL brut paramétré (voir `backend/src/lib/sql-parametre.ts`).

- `ProjetVoirie` (`projets_voirie`) : `id` (cuid), `code` (unique, ex. `KISSI-VOIRIE-2026`), `nom`, `commune?`, `prefecture?`, `regionId?`, `description?`, `largeurEmpriseM` (Decimal(6,2), défaut 15), `largeurChausseeM` (Decimal(6,2), défaut 7), `statutParametres` (`THEORIQUE` par défaut | `VALIDE`), `creeParId`, `createdAt`, `updatedAt`, `deletedAt?`.
- `ConcessionnaireReseau` (`concessionnaires_reseau`) : `id`, `nom` (unique, insensible à la casse), `typeReseau` (enum `TypeReseauTiers`: `TELECOM`, `EAU_POTABLE`, `ELECTRICITE`, `ASSAINISSEMENT`, `GAZ_HYDROCARBURES`, `AUTRE`), `contact?`, `deletedAt?`.
- `JeuDonneesProjet` (`projets_voirie_jeux`) : `id`, `projetId`, `role` (enum `RoleJeuProjet`: `AXES_TRAVAUX`, `RESEAU_TIERS`, `LIMITES_ROUTE`, `AUTRE`), `concessionnaireId?` (obligatoire si `RESEAU_TIERS`), `typeReseau?`, `nomFichier`, `format` (`KML` | `GEOJSON`), `sha256`, `nbObjets`, `longueurTotaleM` (somme des longueurs des objets linéaires), `longueurPhysiqueM` (après fusion des tracés superposés), `dateDonnees?` (date de levé ou de fourniture), `origineFichier?` (texte libre, **facultatif**, ne bloque jamais un dépôt : ni simulation, ni écriture, ni avertissement bloquant ; ex. « reçu d'Orange le 24/10/2026 par … »), `precisionDeclareeM?`, `confidentialite` (`RESTREINT` | `INTERNE`, défaut `RESTREINT`), `statut` (`ACTIF` | `REMPLACE` | `RETIRE`), `version` (entier, 1 puis +1 à chaque remplacement du même couple projet/rôle/concessionnaire), `remplaceId?`, `avertissements` (JSON), `creeParId`, `createdAt`, `deletedAt?`. Contrainte : unique `(projetId, sha256)` parmi les jeux non retirés (réponse 409 `JEU_DEJA_CHARGE`).
- `ObjetProjet` (`projets_voirie_objets`) : `id` (bigint auto ou cuid), `jeuId`, `nom?`, `typeGeom` (`LIGNE` | `POINT` | `POLYGONE`), `geom` (`geometry(Geometry,4326)`, index GiST), `longueurM?` (`ST_Length(geom::geography)` pour les lignes), `attributs` (JSONB : tous les champs d'origine, conservés tels quels), `ordre` (entier).

## 4. API (préfixe `/api/v2/projets-voirie`, `requireAuth`, `requireModuleAccess("projets-voirie")`)

Écritures : rôles `ADMIN` et `GESTIONNAIRE`. Lecture : toute personne ayant la clé de module. Chaque route est déclarée dans l'inventaire des accès (`backend/src/securite/inventaire-acces.test.ts`). Erreurs au format habituel `{ error, code, ... }`, codes en majuscules.

| Route | Rôle | Contenu |
|---|---|---|
| `GET /` | lecture | liste des projets (filtre `q`, curseur) avec compteurs de jeux |
| `POST /` | écriture | crée un projet (`code`, `nom`, `commune`, `prefecture`, `largeurEmpriseM`, `largeurChausseeM`) |
| `GET /:id` | lecture | fiche du projet, jeux, paramètres, emprise englobante (`bbox` WGS84) |
| `PATCH /:id` | écriture | nom, description, largeurs (remet `statutParametres` à `THEORIQUE` sauf si `statutParametres: "VALIDE"` est envoyé par un `ADMIN`) |
| `DELETE /:id` | `ADMIN` | retrait logique |
| `GET /concessionnaires` | lecture | liste |
| `POST /concessionnaires` | écriture | crée (`nom`, `typeReseau`, `contact?`) |
| `POST /:id/jeux` | écriture | multipart : `fichier` (+ champs `role`, `concessionnaireId`, `typeReseau`, `dateDonnees`, `origineFichier`, `precisionDeclareeM`, `confidentialite`). Avec `?simuler=true` : lit, valide et renvoie le résumé **sans rien écrire**. Réponse : `{ jeu, resume: { nbObjets, parTypeGeom, longueurTotaleM, longueurPhysiqueM, bbox, attributsDetectes }, avertissements: [{ code, message, nb? }] }` |
| `GET /:id/jeux` | lecture | jeux du projet (sans géométries) |
| `DELETE /:id/jeux/:jeuId` | écriture | retrait logique (`statut: RETIRE`) |
| `GET /:id/carte` | lecture | `?jeux=id1,id2&bbox=ouest,sud,est,nord&zoom=z` : `FeatureCollection` par jeu `{ jeuId, role, concessionnaire, typeReseau, features, tronque }` ; simplification selon le zoom ; plafond 20 000 objets par réponse |
| `GET /:id/analyse` | lecture | analyse et conflits (section 5), paramètres de largeur surchargeables par `?largeurEmpriseM=&largeurChausseeM=` sans les enregistrer |
| `GET /:id/analyse/export.csv` | lecture, audité | un conflit par ligne |

Limites : fichier 25 Mo (aligné sur nginx), 50 000 objets, coordonnées dans l'emprise de la Guinée (longitude -15,2 à -7,5 ; latitude 7,1 à 12,8), altitude ignorée, géométries invalides réparées ou refusées avec un code (`GEOMETRIE_INVALIDE`), formats `KML` et `GeoJSON` seulement (KMZ, Shapefile, DXF : `FORMAT_NON_SUPPORTE`, consigné comme écart). XML : aucune résolution d'entité externe, ni DTD.

## 5. Analyse (`GET /:id/analyse`)

Calcul métrique en projection UTM choisie selon la longitude du centre du projet : EPSG 32628 si longitude < -12, sinon 32629. Largeurs : `largeurChausseeM` et `largeurEmpriseM` du projet, appliquées de part et d'autre de chaque axe (demi-largeurs).

```
{
  "projet": { "id", "code", "nom" },
  "parametres": { "largeurEmpriseM", "largeurChausseeM", "statut": "THEORIQUE|VALIDE", "projection": "EPSG:32629" },
  "axes": { "nb", "longueurM" },
  "reseaux": {
    "parType":          [ { "typeReseau", "longueurPhysiqueM", "nbObjets" } ],
    "parConcessionnaire":[ { "concessionnaireId", "nom", "typeReseau", "longueurPhysiqueM", "longueurSommeM", "nbObjets", "jeuxIds": [] } ]
  },
  "conflits": {
    "total": { "chausseeM", "empriseM", "croisements", "axesTouches", "objetsTouches" },
    "parAxe": [ { "axe", "longueurM", "chausseeM", "empriseM", "croisements", "concessionnaires": [], "objets": [ { "jeuId", "nom", "chausseeM", "empriseM" } ] } ],
    "parConcessionnaire": [ { "concessionnaireId", "nom", "chausseeM", "empriseM", "croisements" } ],
    "croisements": { "type": "FeatureCollection", "features": [] },
    "zones": { "chaussee": "MultiLineString|null", "emprise": "MultiLineString|null", "hors": "MultiLineString|null" }
  },
  "hypotheses": [ "…texte clair des hypothèses…" ],
  "limites": [ "…texte clair des limites…" ]
}
```

Définitions : `longueurPhysiqueM` = longueur de l'union des tracés d'un jeu (un même tracé répété par plusieurs circuits compte une fois) ; `longueurSommeM` = somme des longueurs des objets ; `chausseeM` = longueur du réseau dans la bande axe ± `largeurChausseeM / 2` ; `empriseM` = longueur dans la bande axe ± `largeurEmpriseM / 2` ; `croisements` = points d'intersection réseau x axe. Une analyse sans axes ou sans réseau répond 200 avec des totaux à zéro et une phrase dans `limites`, jamais une erreur.

## 6. Interface (frontend)

- Entrée de menu et clé de module `projets-voirie` (libellé « Projets de voirie »), route `/projets-voirie` (liste, création) et `/projets-voirie/:id` (carte).
- Page projet : carte Leaflet plein cadre (fond plan OpenStreetMap et satellite Esri), panneau latéral à deux onglets : **Analyse** (longueur totale et par type de réseau avec barre colorée, objets, propriétaires, conflits, hypothèses et limites toujours visibles) et **Couches** (une ligne par jeu : case, couleur, concessionnaire, version, date, bouton retirer ; couches de conflit : chaussée, emprise, hors emprise, croisements). Bouton « Ajouter des données » : dialogue de dépôt avec **simulation avant écriture** (résumé, avertissements), puis confirmation. Fiche au clic sur un objet (attributs d'origine). Paramètres de largeur modifiables avec la mention « théorique ». Export CSV des conflits. Centrer sur le projet.
- Couleur par secteur : télécom orange `#ff7900`, eau bleu `#1e66f5`, électricité rouge `#d32f2f`, assainissement vert `#2e7d32`, gaz jaune `#f9a825`, autre gris `#6b7f99` ; axes de travaux bleu marine `#0b2545`. Conflits : chaussée rouge, emprise orange foncé, hors emprise violet, croisements noirs.
- Accessibilité : contrastes conformes au projet (voir `docs/accessibilite/CONTRASTE.md`), navigation clavier (aucun piège), test `axe-core` sur les écrans ; pas d'information portée par la seule couleur (légende textuelle, motifs de trait).
- Aucun réseau de concessionnaire n'est mis en cache hors ligne (pas de service worker, pas de stockage local de géométries).

## 7. Tests exigés

Backend : analyseurs KML et GeoJSON (altitude `0`, extension Google Earth, entités XML refusées, géométrie vide, hors Guinée, fichier trop gros, doublons de tracé), routes (permissions, simulation sans écriture, 409 doublon, retrait logique, audit), analyse avec **cas synthétique de résultat connu** (un tracé à 2 m de l'axe est en chaussée, à 6 m en emprise hors chaussée, à 9 m hors emprise ; croisement perpendiculaire = 1 point ; deux circuits superposés comptés une fois en longueur physique) en test unitaire du noyau et en banc PostGIS (`backend/tests-integration/`), descente de migration rejouée, `inventaire-acces` à jour, `depot-sans-secret` vert.
Frontend : page liste, page projet, panneau d'analyse, dialogue de dépôt (simulation puis confirmation, erreurs), couches, accessibilité (`axe`), rien de stocké hors ligne.
