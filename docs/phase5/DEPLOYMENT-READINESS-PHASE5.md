# État de livraison — Phase 5

**Date** : 2 septembre 2026

## 1. Ce qui est prêt

| Élément | Emplacement | État |
|---|---|---|
| Scripts d'analyse (6) | `infra/phase5/*.sh` | reproductibles, lecture seule, testés sur la sauvegarde du jour |
| Extracteur CHEMIN | `infra/osm/extraire-chemin-wkt.py` | testé (171 570 entités) |
| Outil de visualisation | `infra/phase5/visualisation-res.html` + `exporter-carto.sh` | opérationnel sur le serveur (`~/phase5-resultats/carto/`), hors production |
| Rapports et spécifications (12) | `docs/phase5/*.md` | livrés |
| Données mesurées (4 TSV) | `docs/phase5/donnees/` | versionnées dans le dépôt |
| Registre de vérité | `docs/phase5/REGISTRE-VERITE-BDRI.md` | livré, maintenable |

## 2. Ce qui n'est PAS fait — et ne devait pas être fait

- aucun déploiement, aucune écriture en production (vérifié : les scripts
  n'exécutent que des `SELECT`/`CREATE TABLE` **dans le conteneur d'analyse**) ;
- aucune fusion, correction, import, reclassement, géocodage ;
- aucun choix de moteur de routage ;
- aucune migration de base (aucune n'était nécessaire : la Phase 5 n'ajoute que
  scripts et documentation).

## 3. Environnement d'analyse laissé en place

| Élément | Emplacement | Destin |
|---|---|---|
| Conteneur `phase5-analyse` | serveur applicatif (gec) | **conservé** pour les validations à venir (décisions D1–D8) ; destruction : `docker rm -f phase5-analyse` |
| Données OSM chargées | idem (osm_classe, osm_chemin) | réutilisable tel quel |
| Résultats bruts | `~/phase5-resultats/` (gec) | copiés dans le dépôt (`docs/phase5/donnees/`) pour ce qui est versionné |
| Dump déchiffré | /tmp du serveur | **effacé** en fin de `preparer-analyse.sh` |
| Clé de sauvegarde | `~/.bdri/cle-sauvegarde` (gec) | n'a jamais quitté le serveur |

## 4. Prérequis pour rejouer

1. accès SSH au serveur applicatif (gec) et au dépôt de sauvegardes (ageroutedb) ;
2. `~/osm-classe.tsv` (Phase 4) et `~/phase5/osm-chemin.tsv` (extraction CHEMIN) ;
3. `infra/phase5/preparer-analyse.sh` puis les scripts d'analyse dans l'ordre.

## 5. Prochaine étape recommandée

Réunion de décision D1–D3 (périmètre + statut RES-* + OSM manquant) autour de
la visualisation (`visualisation-res.html`) et du registre — puis seulement
ouvrir la Phase 6 (topologie, référentiel administratif, intégrations).
