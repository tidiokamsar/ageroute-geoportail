# Les dix premiers tickets — BDRI 2.0 Data First

**Date** : 1er septembre 2026
**Classement** : valeur métier × qualité des données disponibles × impact × risque.
**Complète** : `docs/bdri-2/BDRI-2-BACKLOG.md`, qui listait les tickets de la première planification. Les dix ci-dessous les remplacent en tête de file, parce qu'ils s'appuient sur des données mesurées et non sur des hypothèses.

---

## Pourquoi ces dix-là

Sept des dix n'exigent **aucune donnée nouvelle**. Ils exploitent ce que la base
contient déjà et n'utilise pas : des préfixes de code qui nomment leur source, une
géométrie complète qui porte les longueurs manquantes, des intitulés de chantiers qui
contiennent des PK, un journal d'audit qui conserve six postes supprimés.

C'est le critère qui a dominé le classement : à valeur égale, un ticket qui n'attend
personne passe devant un ticket qui attend une source externe.

---

## T1 — Cesser d'annoncer 7 933 km pour un réseau qui en fait 21 156

| | |
|---|---|
| **Problème** | Le chiffre public du réseau national vaut 7 933 km. Il ne compte en réalité que les nationales et les urbaines : 1 028 régionales sur 1 029 n'ont aucune longueur saisie. La géométrie de ces régionales représente 13 296 km supplémentaires. L'indicateur sous-estime le réseau de 63 %. |
| **Solution** | Exposer une longueur **calculée** depuis la géométrie, dans un champ distinct de `longueurKm`, jamais à sa place. Remplacer le total unique par la ventilation RN / RR / RU, avec la mention « calculé » sur toute valeur dérivée. |
| **Données nécessaires** | Aucune. Géométrie complète et valide sur 1 690 / 1 690. |
| **Impact** | Le chiffre le plus visible de l'application cesse d'être faux. |
| **Dépendances** | Aucune. |
| **Risque** | **Faible.** Aucune écriture dans un champ métier. Le risque réel est de communication : le réseau affiché triple, il faut l'expliquer. |
| **Effort** | 2 à 3 jours. |
| **Acceptation** | La carte et le tableau de bord affichent trois lignes au lieu d'une ; toute valeur calculée porte sa mention ; `longueurKm` n'est modifié sur aucune ligne ; les 662 valeurs saisies restent affichées telles quelles. |

---

## T2 — Renseigner la provenance de 1 689 tronçons sur 1 690, sans enquête

| | |
|---|---|
| **Problème** | Aucune donnée de la BDRI ne dit d'où elle vient. Le journal d'audit ne contient **aucune création** pour les 1 690 tronçons. Les six questions du §21 sont sans réponse. |
| **Solution** | Les codes portent leur origine : `GN N*` (551 RN), `*-OSM-*` (70 RN), `RES-*` (1 028 RR). Ajouter un champ source et le renseigner par lot depuis le préfixe. Conserver le code d'import comme référence externe. |
| **Données nécessaires** | Aucune. Le préfixe suffit pour 1 689 lignes ; 1 tronçon reste à qualifier à la main. |
| **Impact** | Première réponse à « d'où vient cette donnée ». Rend interprétable tout ce qui suit. |
| **Dépendances** | Aucune. |
| **Risque** | **Faible.** Ajout de colonne, réversible. Réserve à assumer : le préfixe indique le **lot d'import**, pas la source primaire — `RES-*` reste à identifier auprès d'AGEROUTE. Le champ doit dire « lot d'import », pas « source », tant que ce point n'est pas tranché. |
| **Effort** | 1 à 2 jours. |
| **Acceptation** | 1 689 tronçons portent un lot d'import identifié ; la fiche tronçon l'affiche ; le sens exact du champ est documenté ; aucun code existant n'est modifié. |

---

## T3 — Dire que le revêtement n'est pas une donnée observée

| | |
|---|---|
| **Problème** | Les 1 690 tronçons valent `BITUME`, sans une seule exception, régionales comprises. La base se contredit elle-même : 29 intitulés de chantiers décrivent des routes « en terre », « piste » ou « latérite », dont *« Route Préfectorale en terre Pita-Maci-Sangareah »*. Le champ est présenté comme une caractéristique du réseau alors qu'il est une valeur d'import. |
| **Solution** | Marquer le champ comme importé non vérifié, à l'affichage comme dans l'API. Ne rien effacer, ne rien remplacer. |
| **Données nécessaires** | Aucune. |
| **Impact** | Un utilisateur cesse de prendre pour un fait ce qui est une valeur par défaut. |
| **Dépendances** | Statut de fiabilité (T4 le pose techniquement). |
| **Risque** | **Faible.** Le risque serait de corriger la valeur : sans source, on remplacerait une supposition par une autre. |
| **Effort** | 1 jour, une fois T4 en place. |
| **Acceptation** | Le revêtement s'affiche avec une mention d'incertitude ; l'API expose le statut ; aucune des 1 690 valeurs n'est modifiée ; les 29 chantiers contradictoires sont listés pour vérification terrain. |

---

## T4 — Dater les constats, sans quoi rien n'est comparable

| | |
|---|---|
| **Problème** | C'est la dimension la plus dégradée de la base : **3 dates métier renseignées sur 4 970 attendues**. `dateDerniereEvaluation` est vide sur 1 690 tronçons, `derniereInspectionDate` sur 126 ouvrages, `dateFinReelle` sur 488 chantiers — dont 312 déclarés terminés. Les 647 tronçons dont l'état est connu ne sont donc pas comparables : un « BON » de cette année et un « BON » d'il y a dix ans occupent la même case. |
| **Solution** | Rendre obligatoires date de constat, méthode et auteur sur les six champs qui alimentent une décision : état, longueur, revêtement, trafic, criticité, coût. Porter le statut **par champ**, pas par enregistrement. |
| **Données nécessaires** | Aucune pour la structure. Les dates passées sont perdues et ne doivent pas être inventées : les constats existants restent non datés, explicitement. |
| **Impact** | Condition de toute priorisation défendable. Sans date, aucun classement n'est justifiable. |
| **Dépendances** | Aucune. |
| **Risque** | **Moyen.** Migration de schéma, donc sauvegarde préalable et validation. Un statut par champ coûte en colonnes : le limiter à six champs, pas vingt-deux. |
| **Effort** | 4 à 6 jours. |
| **Acceptation** | Les six champs portent date, méthode et auteur ; toute saisie nouvelle les exige ; les valeurs anciennes s'affichent comme non datées sans qu'une date leur soit attribuée ; la migration est réversible. |

---

## T5 — Localiser 36 chantiers précisément, à partir de leurs intitulés

| | |
|---|---|
| **Problème** | 482 chantiers sur 488 n'ont aucune position exploitable. Or 36 intitulés contiennent à la fois la route et les PK de début et de fin : `lot 12 : travaux de cantonnage manuel de la route PK24 - PK66 RN5 (42 km)`. |
| **Solution** | Extraire route, PK début et PK fin, et **proposer** l'emprise correspondante par `ST_LineSubstring` sur le tronçon. Les 1 690 tronçons ayant leurs PK renseignés, la projection est directe. Un agent valide ou corrige ; rien n'est appliqué seul. |
| **Données nécessaires** | Aucune. Intitulés et PK déjà en base. |
| **Impact** | Extraction validée sur les 36 intitulés : 14 emprises, 19 rattachements à une route. **Mais aucune ne trouve de tronçon qui la couvre** — voir le risque ci-dessous. Le gain immédiat est une file de propositions instruites, pas des chantiers localisés. |
| **Dépendances** | Aucune pour l'extraction. T4 pour enregistrer la méthode et la date avec la position — sans quoi une emprise déduite d'un intitulé deviendra indistinguable d'un relevé. |
| **Risque** | **Moyen.** Les intitulés sont du texte libre et piègent une extraction naïve : `PK50-Marela (PK103)` mêle un PK et une localité. D'où la validation humaine obligatoire, exigée par le §18. La longueur citée dans 221 intitulés sert de contrôle de cohérence. |
| **Effort** | 5 à 7 jours, interface de validation comprise. |
| **Acceptation** | Les 36 propositions sont présentées avec leur intitulé source ; aucune n'est écrite sans validation ; l'écart entre longueur d'emprise et longueur citée est affiché ; la méthode est enregistrée avec la position. |

---

## T6 — Ne plus afficher comme localisés 50 chantiers qui ne le sont pas

| | |
|---|---|
| **Problème** | 50 chantiers sont rattachés à une « région » nommée **« Non renseigné »**. Ce n'est pas une région : c'est un contournement de la contrainte d'obligation. Ces chantiers n'ont aucune localisation, pas même approximative, et les placer au centre d'une zone par défaut inventerait une information. |
| **Solution** | Les sortir de la carte et les lister à part comme « localisation absente ». Distinguer à l'affichage les quatre niveaux réels : précis, linéaire, approximatif régional, absent. Traiter « Non renseigné » comme une anomalie de saisie à corriger, pas comme une valeur. |
| **Données nécessaires** | Aucune. |
| **Impact** | La carte cesse de présenter une absence de donnée comme une position. Exigence directe du §17. |
| **Dépendances** | Aucune. |
| **Risque** | **Faible.** Effet visible : 50 chantiers disparaissent de la carte. C'est l'objectif, il faut l'expliquer. |
| **Effort** | 2 à 3 jours. |
| **Acceptation** | Les 50 n'apparaissent plus sur la carte ; ils restent listés et modifiables ; les quatre niveaux ont un rendu distinct ; aucune localisation approximative n'est présentée comme précise. |

---

## T7 — Déployer le correctif terrain et l'éprouver sur un vrai téléphone

| | |
|---|---|
| **Problème** | Deux défauts sont corrigés mais **non déployés**. Le premier créait un doublon d'inspection à chaque reprise de synchronisation interrompue. Le second jetait la position GPS, faute de colonne pour l'accueillir — vérifié le 1er septembre, `lat`, `lon` et `precisionM` sont absentes de la table en production. Le module censé produire la donnée du réseau compte 1 inspection. |
| **Solution** | Sauvegarder, déployer la migration et les correctifs, vérifier les colonnes, puis exécuter le protocole de test sur appareil réel, tests 13 à 17 compris. |
| **Données nécessaires** | Aucune. |
| **Impact** | Débloque le seul module producteur de données neuves. |
| **Dépendances** | **Autorisation de déploiement** et sauvegarde préalable. |
| **Risque** | **Moyen.** Migration de schéma en production. Les 9 tests automatisés couvrent la logique de reprise, pas la persistance IndexedDB réelle, ni le réseau dégradé, ni le GPS sous couvert forestier. |
| **Effort** | 1 jour de déploiement, 2 à 3 jours de test terrain. |
| **Acceptation** | Les trois colonnes existent ; le test 9 montre exactement 3 inspections et aucun doublon ; le test 10 montre des coordonnées plausibles ; le test 14 — coupure pendant l'envoi de la deuxième photo — passe sur matériel réel ; les résultats sont consignés, échecs compris. |

---

## T8 — Rendre le score de décision transparent au lieu de le rendre crédible

| | |
|---|---|
| **Problème** | Le module de priorisation affiche un score. La mesure est plus sévère que ne le disait le brief : **trois critères sur quatre sont entièrement vides** — trafic, criticité, coût, 0 sur 1 690 — et le quatrième, l'état, vaut `NON_EVALUE` sur 1 043 tronçons, soit 62 %. Aucun des 647 états connus n'est daté. Le score classe donc le réseau sur un seul critère, connu sur 38 % des tronçons, sans qu'on sache de quand il date. |
| **Solution** | Afficher le détail des facteurs — valeur, poids, date, source — et montrer les absences comme absences. Ne plus présenter de score global tant que les facteurs manquent. Indiquer sur chaque tronçon la part de critères réellement disponibles. |
| **Données nécessaires** | Aucune. C'est précisément le fait qu'elles manquent qui doit devenir visible. |
| **Impact** | Empêche une décision d'investissement de s'appuyer sur un chiffre vide. Exigence directe du §9. |
| **Dépendances** | T4 pour les dates. |
| **Risque** | **Faible techniquement, sensible politiquement.** Le module perd son apparence d'outil décisionnel. C'est l'objectif. |
| **Effort** | 3 à 4 jours. |
| **Acceptation** | Chaque score montre ses quatre facteurs et leur état ; un tronçon sans donnée n'est pas classé ; aucun score global n'est présenté comme fiable ; la couverture des critères est affichée. |

---

## T9 — Récupérer les six postes de péage et pesage du journal d'audit

| | |
|---|---|
| **Problème** | Le module compte 0 ligne et passe pour n'avoir jamais été alimenté. En réalité, **10 postes ont été supprimés le 1er juillet 2026**, et ces 10 se réduisent à **6 sites distincts** — les autres étaient des doublons d'accentuation (« Peage de Kilissi » / « Péage de Kilissi »). La suppression était justifiée ; l'absence de reprise ensuite ne l'est pas. |
| **Solution** | Restaurer les 6 sites dédoublonnés depuis le journal d'audit, avec une orthographe unifiée, et une contrainte d'unicité insensible aux accents pour que le doublon ne revienne pas. |
| **Données nécessaires** | Aucune. Tout est dans `audit_logs.before`. |
| **Impact** | Un module réputé vide obtient une base de départ nominative. |
| **Dépendances** | Aucune. |
| **Risque** | **Moyen, et le risque est dans les attributs, pas dans les sites.** Quatre postes portent une valeur de trafic — Kilissi 3 200, Maférinyah 2 100, Kissidougou 1 500, Linsan 3 200 — et deux une recette mensuelle. Ces valeurs **ne doivent pas être restaurées comme des mesures** : Kilissi et Linsan portent exactement le même chiffre et tous les montants sont ronds, ce qui signe un jeu de démonstration. Restaurer les sites, marquer les valeurs comme non vérifiées, ou les laisser vides. |
| **Effort** | 2 jours. |
| **Acceptation** | 6 postes existent, sans doublon ; l'unicité insensible aux accents est en place ; aucune valeur de trafic n'est présentée comme un comptage ; l'origine « restauré depuis le journal d'audit » est enregistrée. |

---

## T10 — Mesurer la topologie avant de promettre un routage

| | |
|---|---|
| **Problème** | Le réseau n'est pas un réseau. **Aucune extrémité de tronçon ne relie une classe à une autre** : 0 jonction RN ↔ RR, 0 RR ↔ RU, 0 RN ↔ RU. Ce sont trois graphes disjoints, conséquence de trois imports jamais raccordés. Aucun itinéraire ne peut emprunter une nationale puis une régionale. |
| **Solution** | Construire la table de topologie : identifier les nœuds, détecter les intersections géométriques entre classes, raccorder ce qui doit l'être, mesurer les composantes connexes obtenues et la part du réseau couverte par la plus grande. Livrer un rapport chiffré, pas un moteur. |
| **Données nécessaires** | Aucune. 77 % des extrémités coïncident déjà à moins d'un mètre : la base topologique existe à l'intérieur de chaque classe. |
| **Impact** | Condition préalable à tout routage réel. Sans cette mesure, comparer pgRouting, OSRM et GraphHopper n'a pas de sens : les trois échoueraient identiquement. |
| **Dépendances** | Aucune. |
| **Risque** | **Moyen.** Raccorder deux tronçons qui se croisent sans se toucher est une modification de géométrie, donc irréversible sans sauvegarde. Ce ticket **mesure et propose** ; il ne modifie aucune géométrie. |
| **Effort** | 5 à 8 jours pour la mesure et le rapport. |
| **Acceptation** | Le nombre de composantes connexes est établi ; la part du réseau dans la plus grande est chiffrée ; les intersections géométriques inter-classes sont listées ; aucune géométrie n'est modifiée ; une recommandation de moteur est formulée **sur ces chiffres**. |

---

## Ce qui n'entre pas dans les dix, et pourquoi

| Sujet | Motif de report |
|---|---|
| Référentiel administratif (§19) | Le gisement est le plus gros — 299 chantiers, 61 % — mais il attend une décision sur la source officielle. Rien ne peut commencer avant. |
| Trafic, criticité, coût (§6, §7, §8) | Aucune source identifiée. Modéliser avant d'avoir une source produirait un schéma vide de plus. |
| Marchés, ordres de travaux, signalements (§13, §14, §15) | Modules jamais alimentés, aucune trace dans le journal d'audit. Le préalable est un processus métier, pas du code. |
| 41 chantiers `TERMINE` à moins de 100 % | Anomalie réelle mais isolée, sans effet sur une décision. |
| Refonte graphique (§36) | Le §37 l'exclut explicitement du point de départ, et la mesure lui donne raison : l'interface n'est pas le facteur limitant. |
| Choix du moteur de routage (§26) | Dépend de T10. |

---

## Ordre d'exécution suggéré

```
Sans dépendance, immédiat        T1  T2  T6  T9  T10
Migration de schéma              T4  ->  T3  T8
Autorisation de déploiement      T7
Après T4                         T5
```

T1, T2, T6, T9 et T10 peuvent démarrer aujourd'hui, en parallèle, sans attendre aucune
décision ni aucune donnée externe. T4 ouvre T3 et T8. T7 attend une autorisation de
déploiement et une sauvegarde préalable.
