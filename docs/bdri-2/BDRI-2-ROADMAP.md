# BDRI 2.0 — Feuille de route

Ordre des lots, et pourquoi il diffère de celui proposé au §48 de la mission.

---

## 1. La dépendance qui commande tout

Le §48 propose : carte → fiches → référentiel → qualité → terrain → analyse →
interopérabilité → design.

C'est l'ordre naturel **quand les données existent**. Les mesures montrent qu'elles
n'existent pas :

- Inspections, ordres de travaux, marchés, signalements, péages : **0 enregistrement**
- Trafic, criticité, coût, préfecture, date d'évaluation : **0 sur 1 690 tronçons**
- Chantiers localisés : **6 sur 488**

Construire les fiches objets (2.2) avant le terrain (2.5) revient à livrer un écran
qui affiche sept rubriques vides. Construire l'aide à la décision (2.6) sur des champs
vides produit un classement qui n'informe de rien.

**Le terrain est le seul lot qui crée de la donnée. Tous les autres en consomment.**

Le §48 autorise explicitement cette révision : « Tu peux modifier cet ordre si l'audit
montre qu'une autre dépendance est plus importante. » La dépendance est la donnée.

---

## 2. Ordre proposé

| Lot | Contenu | Pourquoi ici |
|---|---|---|
| **2.0** | Clôture du socle | Dette de la Phase 3, quelques jours |
| **2.1** | **Terrain et inspections** | Seul lot producteur de données |
| **2.2** | Carte, recherche, navigation | Devient utile dès que le terrain alimente |
| **2.3** | Fiches objets et relations | A enfin quelque chose à afficher |
| **2.4** | Référentiel administratif | Débloque la recherche par lieu ; dépend d'une source externe |
| **2.5** | Qualité des données | Mesure ce que les lots précédents ont produit |
| **2.6** | Analyse et aide à la décision | Exige les données du terrain — donc après 2.1 |
| **2.7** | Interopérabilité | Liens vers les applications métiers |
| **2.8** | Design et accessibilité | En continu, consolidé ici |

Deux changements par rapport au §48 : **le terrain passe de 5<sup>e</sup> à
1<sup>er</sup>**, et **la qualité des données passe après** les lots qui produisent
de la donnée à mesurer.

---

## LOT 2.0 — Clôture du socle

Dette laissée par la Phase 3. Court, sans dépendance, à solder avant d'ouvrir 2.1.

| Élément | État |
|---|---|
| Planifier les sauvegardes (2 lignes de crontab) | Prêt, en attente de validation |
| Mettre la clé de chiffrement à l'abri hors serveur | Décision d'organisation |
| Renommer la fonction « itinéraire » | 1 h — elle trompe l'utilisateur aujourd'hui |
| Intégration continue (`ci.yml` non commité) | Bloqué par le garde-fou de session |
| Vérification avant livraison | À écrire |
| Contrôle automatique base ↔ fichiers | À écrire |
| En-têtes de sécurité du frontend | Risque SharePoint à traiter |

**Estimation : 5 j.**

---

## LOT 2.1 — Terrain et inspections

**Le lot qui débloque tous les autres.**

Un agent ouvre son téléphone, obtient sa position, voit les tronçons proches, en
sélectionne un, saisit les dégradations constatées, photographie, enregistre hors
connexion, synchronise plus tard.

**Ce qui existe déjà** : `InspectionTerrainPage`, `lib/offlineSync.ts`,
`hooks/useOfflineSync.ts`, un service worker, le modèle `Inspection` et
`MatriceDegradation`. **Rien n'a jamais été exercé** — la table est vide.

**Ce qui reste à faire** : éprouver le hors-ligne pour de vrai (coupure réseau,
reprise, conflits, doublons), la géolocalisation avec sa précision affichée, les
photos horodatées et géolocalisées, la synchronisation.

**Le point critique** : le §15 interdit de considérer que « l'application fonctionne
sans réseau » sans test réel. Le mode hors-ligne est le composant le plus difficile à
tester et le plus coûteux à corriger après coup. Il faut un téléphone réel.

**Dépendances** : lot 2.0 pour les sauvegardes — le terrain va enfin produire des
données qu'il serait impardonnable de perdre.
**Risque** : élevé. Le hors-ligne est là où les applications terrain échouent.
**Estimation : 20 j.**

---

## LOT 2.2 — Carte, recherche, navigation

Panneau gauche (recherche, couches, filtres, légende), carte au centre, panneau droit
(fiche), statistiques contextuelles en bas. Recherche universelle, filtres combinés,
légende qui suit les couches actives, statistiques liées à la carte.

**Ce qui existe** : la carte publique en porte déjà une part — recherche par route et
région, filtre par état, légende à bascule, isolement d'une route. Le géoportail
interne a six couches, mesures, export, partage.

**Ce qui reste** : unifier les deux, la recherche universelle multi-types, les filtres
combinés, le lien carte ↔ statistiques.

**Dépendances** : 2.1 pour que les couches inspections et dégradations aient du
contenu.
**Estimation : 15 j.**

---

## LOT 2.3 — Fiches objets et relations

La fiche universelle du §8 et la navigation entre objets du §9 :
tronçon → ouvrages → inspections → dégradations → ordres de travaux → chantiers.

**Dépendances** : 2.1 et 2.2. Sans inspections ni chantiers localisés, la chaîne de
relations est un maillon unique.
**Estimation : 12 j.**

---

## LOT 2.4 — Référentiel administratif

Région → préfecture → sous-préfecture → commune → localité, avec géométries, et
rattachement spatial contrôlable.

**Bloqué par une dépendance externe** : la source officielle. Voir
`BDRI-2-DATA-MODEL.md` §4. Aucune ligne de code avant qu'elle ne soit obtenue.

**Estimation : 10 j après réception de la source.**

---

## LOT 2.5 — Qualité des données

Centre de qualité, score global, centre des anomalies. Les règles sont déjà écrites
et mesurées dans `DATA-QUALITY-BDRI.md` — il s'agit de les rendre visibles et
actionnables.

**Placé ici, et non en 2.4 comme au §48** : mesurer la qualité avant que le terrain
et le référentiel n'aient produit quoi que ce soit reviendrait à afficher un tableau
de bord dont tous les indicateurs sont à zéro.

**Estimation : 10 j.**

---

## LOT 2.6 — Analyse et aide à la décision

Vues nationale, régionale, préfectorale, communale. Score de priorité **documenté
facteur par facteur**. Scénarios budgétaires.

**Condition d'ouverture, non négociable** : trafic, criticité et coût doivent être
renseignés. Ils sont aujourd'hui à zéro sur 1 690 tronçons. Tant qu'ils le restent,
**ce lot ne doit pas s'ouvrir** — il produirait la formule opaque que le §26 interdit.

**Estimation : 15 j, après alimentation des trois champs.**

---

## LOT 2.7 — Interopérabilité

Liens vers les applications métiers, API versionnée `/api/v1`, exports SIG respectant
les permissions, intégration SharePoint améliorée, partage de vues sans contournement
des droits.

**Dépendances** : identifiants stables (voir `BDRI-2-DATA-MODEL.md` §2) — un lien
vers une application métier doit reposer sur un identifiant qui ne bouge pas.
**Estimation : 12 j.**

---

## LOT 2.8 — Design et accessibilité

Système visuel cohérent, charte cartographique documentée, mise en page d'impression,
accessibilité clavier et contraste.

**En continu dans chaque lot**, consolidé ici. Un design system livré à la fin ne
rattrape pas huit lots construits sans lui.
**Estimation : 8 j.**

---

## 3. Chemin critique

```
2.0 ─┬─► 2.1 (terrain) ─┬─► 2.2 (carte) ─► 2.3 (fiches) ─► 2.7 (interop)
     │                  │
     │                  └─► 2.5 (qualité)
     │
     └─► 2.4 (référentiel administratif) ── bloqué par source externe
                                            │
     alimentation trafic/coût/criticité ────┴─► 2.6 (décision)
```

Deux blocages ne dépendent pas du développement :

- **La source administrative officielle** (INS / Direction Nationale de la
  Cartographie). Sans elle, 2.4 n'ouvre pas.
- **L'alimentation de trafic, criticité et coût.** Sans elle, 2.6 n'ouvre pas.

Ces deux démarches devraient être **engagées maintenant**, en parallèle du lot 2.1.
Ce sont les délais les plus longs du programme, et ils ne coûtent rien à lancer tôt.

---

## 4. Ce que je ne recommande pas

**Ne pas ouvrir 2.6 en attendant.** La tentation sera d'utiliser l'état seul comme
score de priorité. Sur 647 tronçons évalués et 1 043 non évalués, ce score
classerait surtout l'ignorance.

**Ne pas géolocaliser les chantiers par estimation.** 482 chantiers sont au centre de
leur région. Les déplacer « au mieux » créerait une précision fausse, plus dangereuse
que l'imprécision affichée. Le §21 le dit ; la solution est le rattachement au tronçon
depuis la source métier, pas l'interpolation.

**Ne pas construire les six espaces comme six modules techniques.** Ce sont des
regroupements de navigation. Créer six nouveaux modules doublerait la surface de code
pour un gain nul.
