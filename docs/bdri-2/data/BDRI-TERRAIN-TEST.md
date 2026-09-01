# Test terrain de l'inspection mobile — protocole et résultats

**Date de rédaction** : 1er septembre 2026
**Statut d'exécution** : **NON EXÉCUTÉ**

---

## Avertissement, à lire avant tout le reste

**Ce document ne contient aucun résultat de test terrain, parce qu'aucun n'a été réalisé.**

Le §11 du brief demande de ne considérer la fonction comme terminée qu'après un test
sur téléphone réel. Le §39 pose que la question n'est plus « la fonctionnalité
existe-t-elle » mais « produit-elle une donnée fiable ». Remplir ce document avec des
résultats plausibles violerait les deux.

Je ne dispose pas d'un appareil mobile. Le protocole ci-dessous est donc écrit pour
être exécuté par une personne, et les colonnes de résultat sont vides à dessein.

---

## 1. Ce qui a réellement été vérifié, et par quel moyen

Deux défauts ont été corrigés et couverts par des tests automatisés. Il faut être
précis sur ce que ces tests prouvent et sur ce qu'ils ne prouvent pas.

### Défaut 1 — un doublon par tentative de synchronisation

La version précédente créait l'inspection, envoyait les photos, et ne retirait
l'élément de la file qu'après le succès de **toutes** les photos. Une coupure pendant
l'envoi d'une photo laissait donc l'élément entier en attente, et la synchronisation
suivante **recréait l'inspection**.

Sur le module censé produire la donnée du réseau, chaque reprise fabriquait un doublon.

Le correctif persiste chaque étape réussie : l'identifiant serveur d'abord, puis chaque
photo retirée de la liste dès qu'elle est passée.

### Défaut 2 — la position GPS était perdue

Le formulaire capturait la position, la file locale la transportait, et l'API la
recevait — mais la table `inspections` n'a pas de colonne pour l'accueillir. La donnée
était collectée puis jetée en silence.

Une migration ajoute `lat`, `lon` et `precisionM`. **Elle n'est pas déployée.**

### Ce que les 9 tests automatisés couvrent

| Comportement vérifié |
|---|
| L'inspection et ses photos partent, puis la file se vide |
| La position et sa précision sont transmises dans le corps de la requête |
| Une photo qui échoue ne provoque **pas** de recréation de l'inspection |
| Les photos déjà passées ne sont pas renvoyées |
| L'identifiant serveur est retenu dès la création réussie |
| L'envoi est abandonné après 5 tentatives au lieu de boucler sans fin |
| Une inspection abandonnée est conservée, jamais effacée en silence |
| Rien n'est tenté hors connexion |
| Plusieurs inspections en attente sont traitées |

### Ce qu'ils ne couvrent pas, et ne peuvent pas couvrir

Ces tests remplacent IndexedDB par une `Map` et l'API par une simulation. Ils vérifient
la logique de reprise. Ils ne disent **rien** sur :

- la persistance réelle d'un `Blob` photo dans IndexedDB entre deux ouvertures ;
- la survie de la file quand le système d'exploitation ferme l'application ;
- le comportement du service worker ;
- la précision réelle du GPS sous couvert forestier ou en zone urbaine dense ;
- le comportement sur réseau **dégradé** — le cas le plus fréquent sur le terrain, et
  le plus dur : ni en ligne ni hors ligne, mais lent et intermittent ;
- l'espace de stockage disponible sur un téléphone d'entrée de gamme après plusieurs
  dizaines de photos ;
- l'ergonomie réelle en plein soleil, avec des gants, sur un chantier.

Aucun test sous jsdom ne peut répondre à ces questions. Seul un appareil réel le peut.

---

## 2. Préalable bloquant

**La migration `lat` / `lon` / `precisionM` n'est pas en production.** Vérifié le
1er septembre 2026 en listant les colonnes de la table `inspections` : elles sont
absentes.

Tant qu'elle n'est pas déployée, le test 10 (vérification du GPS) **échouera par
construction**, et les tests 1 à 9 produiront des inspections sans position.

Exécuter le protocole avant ce déploiement ne servirait qu'à re-constater le défaut
déjà connu.

Ordre à respecter :

1. sauvegarde préalable de la base ;
2. déploiement de la migration et des correctifs de synchronisation ;
3. vérification que les trois colonnes existent ;
4. **puis** exécution du protocole ci-dessous.

---

## 3. Protocole

**Matériel** : un téléphone Android d'entrée ou milieu de gamme — pas un appareil haut
de gamme, qui masquerait les problèmes de mémoire et de stockage.

**Compte** : un compte réel de rôle `GESTIONNAIRE`, pas un compte ADMIN.

**Lieu** : un tronçon réel, hors zone de couverture si possible.

**Règle** : consigner ce qui se passe, y compris et surtout quand cela ne fonctionne pas.

| # | Test | Attendu | Résultat | Observations |
|---|---|---|---|---|
| 1 | Créer une inspection **avec** réseau | l'inspection apparaît côté serveur dans la minute | | |
| 2 | Couper le réseau (mode avion) | l'application reste utilisable, un indicateur signale le mode hors ligne | | |
| 3 | Créer **3 inspections** hors ligne | les 3 sont visibles dans la file locale | | |
| 4 | Ajouter **2 photos** à chacune | les 6 photos sont conservées localement | | |
| 5 | **Fermer** complètement l'application | — | | |
| 6 | **Redémarrer** l'application | les 3 inspections et les 6 photos sont **toujours là** | | |
| 7 | Rétablir le réseau | la synchronisation démarre seule | | |
| 8 | Observer la synchronisation | les 3 inspections partent, la file se vide | | |
| 9 | **Vérifier l'absence de doublons** côté serveur | exactement 3 inspections, pas 4, pas 6 | | |
| 10 | **Vérifier le GPS** | `lat`, `lon` et `precisionM` sont renseignés et plausibles | | |
| 11 | **Vérifier les photos** | les 6 sont présentes et lisibles | | |
| 12 | **Vérifier le journal d'audit** | les créations sont tracées avec le bon auteur | | |

### Tests complémentaires, qui manquent au §12 et qui comptent

| # | Test | Pourquoi il est nécessaire | Résultat |
|---|---|---|---|
| 13 | Créer une inspection en **réseau dégradé** (2G, une barre) | c'est le cas réel le plus fréquent, et celui que ni « en ligne » ni « hors ligne » ne représente | |
| 14 | Couper le réseau **pendant** l'envoi de la 2ᵉ photo, puis reprendre | c'est exactement le scénario qui produisait le doublon | |
| 15 | Laisser une inspection en échec **5 fois** | vérifier l'abandon propre, sans boucle et sans effacement | |
| 16 | Saisir sous **couvert forestier** | mesurer la précision réellement obtenue, pas celle annoncée | |
| 17 | Remplir le stockage (30+ photos) | vérifier le comportement quand IndexedDB refuse d'écrire | |

Le test 14 est le plus important de tous : il rejoue précisément le défaut corrigé, sur
du matériel réel. C'est lui qui validera ou invalidera le correctif.

---

## 4. Critères de clôture

La fonction ne peut être déclarée terminée que si :

- les tests 1 à 12 passent, **et**
- les tests 13 à 17 sont exécutés et leurs résultats consignés, **et**
- le test 9 montre exactement 3 inspections, **et**
- le test 10 montre des coordonnées plausibles avec leur précision.

Un seul échec sur les tests 9, 10 ou 14 rouvre le sujet.

---

## 5. Ce qui reste à décider avant le terrain

| Question | Pourquoi elle se pose |
|---|---|
| Quelle précision GPS minimale accepter ? | une position à ±50 m sur un tronçon de 2 km ne localise rien |
| Que faire d'une inspection abandonnée ? | elle est conservée, mais personne n'est aujourd'hui prévenu |
| Combien de photos par inspection ? | aucune limite n'est fixée, le stockage du téléphone en fixera une brutalement |
| Qui inspecte, et selon quel plan ? | 1 690 tronçons, 5 comptes actifs, 1 inspection en base |

La dernière question est la plus lourde et n'est pas technique. Le module fonctionne ;
il n'a pas d'utilisateurs. Aucun correctif ne réglera cela.
