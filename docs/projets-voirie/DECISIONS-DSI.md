# Décisions à prendre par le DSI : module « Projets de voirie et réseaux »

Document de synthèse du 10/11/2026 (branche `feat/vague3-integration`). Il rassemble en un seul endroit les questions laissées ouvertes par les rapports des lots (`docs/reports/`) et par les revues indépendantes, et les décisions que l'architecte a prises seul en vertu de l'instruction du 08/11/2026. Chaque ligne renvoie au document qui la détaille. Aucune de ces décisions ne bloque le déploiement de la vague 1 (commit `0782ea4`).

Lecture : **A** = à trancher avant la préproduction de la vague 3 ; **B** = avant la production de la vague 3 ; **C** = peut attendre l'usage réel.

## 1. Décisions prises par l'architecte, à confirmer ou à renverser

| Sujet | Décision appliquée | Où |
|---|---|---|
| Classe de précision et corridor de comparaison | Une classe A à E n'est pas une précision en mètres. La règle système n'a aucun barème ; sans deux précisions en mètres, le résultat est `RAPPROCHEMENT_INCERTAIN`. Un barème par classe n'existe que dans une règle approuvée par un ADMIN autre que son auteur. | `DECISION-ARCHITECTURALE-2.md` (précisions après revue), `CONTRAT-SOURCES.md` |
| Approbation de sa propre règle de rapprochement | Interdite, même avec dérogation. | `CONTRAT-SOURCES.md` |
| Justification de la configuration nationale | Obligatoire (10 caractères au moins). | `CONTRAT-TERRITOIRES.md` |
| Méthodes d'acquisition | Une seule source de vérité : le référentiel `METHODE_ACQUISITION`. | `CORRECTIFS-REVUE-T1S1.md` (M2) |
| Identité d'un réseau | Concessionnaire et type de réseau configurable (et non la seule famille). | idem (M3) |
| Confidentialité d'une nouvelle version | Elle hérite du niveau le plus restrictif de sa lignée ; seul un ADMIN abaisse un niveau, avec justification. | `CONTRAT-IMPORT.md` section 16, `CONTRAT-EXPORTS.md` section 9 |
| Dérogation d'export | Accordée par un ADMIN à une **autre** personne, nominative, à usage unique, consommée seulement après l'envoi complet. | `CONTRAT-EXPORTS.md` |
| Délai de fabrication d'un export | 45 s par défaut, 50 s au plus, sous le délai de 60 s du mandataire nginx (aucune modification de `nginx.conf`). | idem |
| Dossiers de couverture insuffisante | Un dossier par axe (colonne `identifiant` du mapping, sinon nom normalisé), et non par morceau d'axe ; un axe sans nom garde son dossier ; le détail par morceau reste sur la fiche. | `CORRECTIFS-PILOTE-D4-D7.md` |
| Capacité des calculs | Comptage préalable sans calcul géométrique et refus 422 au-delà des plafonds, jamais un 500 ou un 504 tardif. | idem |
| Classe de précision « inconnue » | Champ absent, jamais une valeur inventée. | défaut D1 du pilote |

## 2. Gouvernance et séparation des tâches

| Niv. | Question | Choix actuel | Où |
|---|---|---|---|
| A | Référentiels et configuration : une écriture ADMIN vaut approbation immédiate. Faut-il un brouillon puis l'approbation d'un second ADMIN, comme pour les règles de conflit ? | approbation immédiate, historisée | `LOT-T1-RAPPORT.md` I.2 |
| A | Documents : le déposant ne valide jamais sa pièce, sans dérogation. Une petite équipe à un seul gestionnaire doit passer par un ADMIN. Acceptable ? | oui, sans dérogation | `LOT-D1-RAPPORT.md` 6.3 |
| B | Un GESTIONNAIRE peut-il bénéficier d'une dérogation d'export ? Faut-il une révocation explicite ? | oui, nommément ; pas de révocation | `LOT-X1-RAPPORT.md` 6.3 |
| B | Retour d'un document `VALIDE` après une erreur constatée | retrait ADMIN ou nouvelle version seulement | `LOT-D1-RAPPORT.md` 6.7 |
| C | Règles de conflit propres à un territoire | non faites (nationales seulement) | `LOT-T1-RAPPORT.md` I.3 |

## 3. Données, territoires et sources

| Niv. | Question | Choix actuel | Où |
|---|---|---|---|
| A | Corridor interrégional : placé sous la nation (comptes nationaux seulement) ou périmètre multi-régions (nouveau modèle) ? | sous la nation | `LOT-T1-RAPPORT.md` I.1 |
| A | Kissidougou : le plan d'axes livré porte 36 axes, le plan d'origine en annonce 31. Demander l'explication et la source CAO (DXF ou LandXML) à l'entreprise. | non expliqué | `RAPPORT-PILOTE-LOCAL.md` (hors dépôt) |
| B | Import des limites administratives officielles et des territoires réels, validation des emprises des corridors réels | aucune donnée réelle dans le dépôt | `LOT-T1-RAPPORT.md` I.5 et I.6 |
| B | Précision typique de chaque méthode d'acquisition, libellés et couleurs définitifs | non renseignés (aucune valeur inventée) | `LOT-T1-RAPPORT.md` I.4 |
| B | « Source de référence » par réseau : toutes les sources autorisées comptent aujourd'hui, le double compte est signalé et non évité | toutes comptent | `CORRECTIFS-REVUE-T1S1.md` (décisions, 1) |
| B | Règles de rapprochement créées par des personnes avant la correction M6 : elles portent le barème posé par défaut ; à revoir une à une | à revoir | idem (décisions, 2) |
| B | Codes de méthode d'acquisition en double (`LEVE_TOPOGRAPHIQUE` et `TOPOGRAPHIE`, codes GNSS) : désactiver par administration ceux à ne plus proposer | tous actifs | idem (décisions, 5) |
| B | Rattachements incohérents laissés par la migration T1 (`NON_RENSEIGNE` sans région, communes homonymes) : requête de contrôle à passer en préproduction | non corrigés (la migration ne se réécrit pas) | `CORRECTIFS-REVUE-T1S1.md` (m5) |
| B | Jeux déposés avant la règle d'héritage de confidentialité : à relever par un ADMIN si nécessaire | niveau d'origine conservé | `LOT-X1-RAPPORT.md` section 8 |
| C | Repointage d'un dossier de divergence après remplacement de la version de référence ; ouverture d'un dossier depuis un rapprochement incertain | non faits | `LOT-S1-RAPPORT.md` 8 |

## 4. Documents et formats d'ingénierie

| Niv. | Question | Choix actuel | Où |
|---|---|---|---|
| B | Tolérance de discrétisation des arcs LandXML | 10 mm (réglable, 1 à 1 000 mm) | `LOT-D1-RAPPORT.md` 6.1 |
| B | Spirales (clothoïdes) | refusées avec un code typé | idem 6.2 |
| B | Types de document obligatoires et fonctions qu'ils débloquent | ceux du lot T1 (deux obligatoires) | idem 6.5 |
| B | Faut-il une pièce `VALIDE` (et pas seulement un jeu autorisé) pour annoncer une fonction disponible ? | non | idem 6.4 |
| C | Conservation des fichiers PDF et DWG eux-mêmes | empreinte seulement | idem 6.6 |

## 5. Exports et tableaux de bord

| Niv. | Question | Choix actuel | Où |
|---|---|---|---|
| A | `RESTREINT_PROJET` exportable sans dérogation ? C'est le niveau par défaut des plans d'axes : le retirer les rend inexportables. | exportable | `LOT-X1-RAPPORT.md` 6.1 |
| B | Valeurs de protection : 50 000 objets, 1 000 000 de sommets, plafond non compressé, 45 s, 10 exports par heure et par compte, 30 tableaux par minute, dérogation de 24 h (7 jours au plus) | valeurs de départ | idem 6.2 et section 8 |
| B | Signature de l'archive (clé de l'organisme) pour un dossier transmis hors d'AGEROUTE | non signée (manifeste SHA-256) | idem 6.4 |
| C | Rétention du journal des exports et des dérogations | illimitée, ajout seul | idem 6.5 |
| C | Attributs des fichiers source dans le GeoJSON exporté | jamais | idem 6.6 |

## 6. Capacité, GDAL et exploitation

| Niv. | Question | Choix actuel | Où |
|---|---|---|---|
| A | Conteneur GDAL `ageroute-geoconv` : hébergement de l'image (environ 600 Mo, empreinte épinglée), cadence de mise à jour, profil seccomp, scan de vulnérabilités, antivirus des fichiers déposés | désactivé par défaut ; conditions non remplies | `LOT-B2-RAPPORT.md` J.2 à J.5 |
| A | Plafonds GDAL de production : 50 000 objets, 25 Mo en entrée, 80 Mo en sortie, 90 s, 2 jobs par compte, 3 par projet, file de 20, 12 créations par heure | valeurs de départ | idem J.1 |
| A | Plafonds de l'analyse 2D, du comptage et de l'analyse persistée (défaut D4 du pilote) : 5 000 objets linéaires et 200 000 sommets par défaut, mesurés sur un poste chargé ; au-delà, refus 422 `ANALYSE_TROP_VOLUMINEUSE` en moins d'une seconde. À fixer après mesure sur le serveur réel (banc `projets-voirie-capacite` avec `PV_CAPACITE_MESURE=1`). | 5 000 / 200 000 | `CORRECTIFS-PILOTE-D4-D7.md` |
| B | Traitement asynchrone des très gros projets (au-delà des plafonds) et borne mémoire de l'analyse 2D sur un très grand plan | refus 422, pas de traitement en tâche de fond | idem, `LOT-X1-RAPPORT.md` section 8 |
| B | Dossiers de couverture regroupés par axe (défaut D7) : deux axes distincts de même nom, sans colonne `identifiant` dans le mapping, sont réunis en un seul dossier | nom normalisé, sinon identifiant mappé | `CORRECTIFS-PILOTE-D4-D7.md` |
| B | Rétention du spool GDAL et droit de purge du backend | 24 h (72 h au plus) | `LOT-B2-RAPPORT.md` J.4 |
| C | Politique d'échec par objet d'un fichier converti | fichier entier refusé | idem J.7 |

## 7. Ce qui reste à la main du responsable, quoi qu'il arrive

- L'étape 9 du script `infra/deployer-console.sh` (`DEPLOYER`) : attestation GLPI (serveur de rebond corrigé, cause de l'arrêt sshd établie, secrets renouvelés). Elle n'est jamais automatisée.
- L'attribution de la clé de module `projets-voirie` aux comptes après le déploiement.
- L'activation de GDAL (`PROJETS_VOIRIE_GDAL=1`), seulement après les décisions de la section 6.
