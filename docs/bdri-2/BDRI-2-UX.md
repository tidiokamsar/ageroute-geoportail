# BDRI 2.0 — Expérience utilisateur

---

## 1. Trois utilisateurs, trois besoins

| Qui | Où | Ce qu'il vient faire |
|---|---|---|
| **L'agent de terrain** | Sur la route, téléphone, réseau faible | Constater et saisir. Le seul qui **produit** de la donnée |
| **Le gestionnaire** | Au bureau, grand écran | Chercher une route, comprendre son état, décider |
| **Le citoyen** | Téléphone, 3G | Savoir dans quel état est la route qu'il va prendre |

Ces trois usages n'appellent pas la même interface. La tentation d'un écran unique
« responsive » les servirait tous mal.

---

## 2. La carte comme point d'entrée

L'organisation cible du §4 — panneau gauche, carte, panneau droit, statistiques en
bas — est retenue **pour le poste de travail**. Sur téléphone, elle ne tient pas : la
Phase 2 l'a mesuré, une feuille dépliée occupait 464 px sur 640 et masquait les
commandes.

| Écran | Disposition |
|---|---|
| **Poste de travail** | Panneau gauche (recherche, couches, filtres, légende) · carte · panneau droit (fiche) · statistiques en bas |
| **Tablette** | Panneaux escamotables, carte prioritaire |
| **Téléphone** | Carte plein écran, recherche flottante, fiche en feuille ancrée en bas, commandes sur le flanc droit |

La disposition téléphone existe déjà sur la carte publique et a été mesurée : feuille
à 349 px sur 640, commandes accessibles au-dessus. **C'est le patron à généraliser**,
pas à réinventer.

---

## 3. Recherche universelle

Un seul champ : « Rechercher dans la BDRI ». Il accepte un numéro de route, un code de
tronçon, un PK, un nom d'ouvrage, une région, une préfecture, une commune.

**Résultats groupés par type**, chacun portant nom, type, localisation, état, et une
action « Afficher sur la carte ».

**Ce qui existe déjà** : la recherche de la carte publique — insensible aux accents,
correspondances en début de nom d'abord, axes les plus longs ensuite, agrégation des
tronçons d'un même axe. **21 tests la couvrent.** C'est la base à étendre, pas à
refaire.

**Ce qui manque** : les types autres que les routes, et la recherche par lieu — cette
dernière **bloquée par l'absence de référentiel administratif**.

**Règle de sécurité** : la recherche ne retourne que ce que l'appelant a le droit de
voir. C'est déjà le cas côté serveur depuis la correction de `/api/search` ; l'écran
ne doit pas le contourner en interrogeant d'autres routes.

---

## 4. Filtres combinés

Région, route, état, type — combinables, avec effet immédiat sur la carte.

**Deux exigences d'honnêteté :**

1. **Afficher les filtres actifs**, toujours visibles, avec un retrait possible.
   L'utilisateur doit savoir pourquoi la carte est vide.
2. **Distinguer « aucun résultat » de « données absentes ».** Filtrer sur « état
   mauvais » dans une région ne renvoie rien : est-ce qu'il n'y a pas de route en
   mauvais état, ou qu'aucune n'a été évaluée ? Sur un réseau dont **62 % des tronçons
   n'ont pas d'état connu**, la différence est capitale.

---

## 5. Fiche universelle

Structure commune à tous les objets : identité, localisation, caractéristiques, état,
photos, documents, historique, objets liés.

**Une rubrique vide ne s'affiche pas comme une rubrique remplie de rien.** Sur les
données actuelles, une fiche de tronçon aurait sept rubriques vides. Deux règles :

- Une rubrique sans contenu **dit pourquoi** : « Aucune inspection enregistrée » et
  non un tableau vide.
- Une rubrique dont la donnée n'est **pas encore collectée** le dit autrement :
  « Trafic non renseigné » plutôt que « 0 véhicules/jour ». **Zéro est une valeur ;
  l'absence n'en est pas une.** C'est le défaut actuel du linéaire : 7 933 km affichés
  sans mention que 61 % des tronçons ont une longueur nulle.

---

## 6. Navigation entre objets

Tronçon → ouvrages → inspections → dégradations → ordres de travaux → chantiers.

La chaîne doit être **parcourable dans les deux sens** : depuis un ouvrage, remonter
au tronçon ; depuis un chantier, atteindre les inspections qui l'ont motivé.

**Le fil d'Ariane porte le contexte**, pas seulement le chemin :
`RN3 › Pont de Kankan › Inspection du 12/03/2026`.

---

## 7. Charte cartographique

Le §22 demande de ne pas utiliser de couleurs arbitraires. **La charte existe déjà**
et sert la carte publique — il s'agit de la documenter, pas de l'inventer.

| Objet | Encodage | Source |
|---|---|---|
| État de chaussée | Vert `#16a34a` · lime `#84cc16` · orange `#f97316` · rouge `#dc2626` · gris `#9ca3af` | `ETAT_COLORS` |
| Chantiers | Trait tireté, couleur par statut | `CHANTIER_COLORS` |
| Points noirs | Cercle rouge `#dc2626` | Constante |
| Numéros de route | Écusson blanc bordé de navy | Vocabulaire de la signalisation routière |

**Trois règles pour l'étendre :**

1. **Une dimension, un canal visuel.** La couleur porte l'état, la forme porte le
   type, le tireté porte le statut. Deux significations sur un même canal les rendent
   toutes deux illisibles.
2. **L'imprécision doit se voir.** Un chantier localisé approximativement ne se dessine
   pas comme un chantier localisé précisément. Cercle diffus contre tracé plein.
3. **Le gris signifie « non évalué », jamais « bon ».** Sur 62 % des tronçons, c'est la
   valeur la plus fréquente : elle ne doit pas se confondre avec une bonne nouvelle.

---

## 8. Légende intelligente

La légende n'affiche que les couches actives — déjà le cas sur la carte publique, où
elle ne liste que les états réellement présents dans les données.

**À étendre** : ne pas montrer une entrée pour une couche vide. Une légende annonçant
« Péages / Pesages » quand la table compte **0 enregistrement** promet ce qui n'existe
pas.

---

## 9. Carte et statistiques liées

« 488 chantiers » cliquable filtre la carte. « 32 ouvrages critiques » les affiche.

**Le lien va dans les deux sens** : déplacer la carte met à jour les statistiques,
qui portent alors sur l'emprise visible. Il faut alors dire lesquelles :
« 47 tronçons dans la vue » et non « 47 tronçons ».

---

## 10. Terrain — la contrainte qui prime

L'agent est debout, au soleil, avec une main, sur un réseau instable.

| Contrainte | Conséquence de conception |
|---|---|
| Une seule main | Tout ce qui est fréquent tient dans le pouce, en bas de l'écran |
| Plein soleil | Contrastes élevés ; le gris clair sur blanc est illisible dehors |
| Réseau instable | Le hors-ligne est le mode **par défaut**, pas un mode dégradé |
| Gants, doigts humides | Cibles d'au moins 44 px |
| Batterie | Pas d'animation continue, GPS sollicité à la demande |

**La saisie doit survivre à la fermeture de l'application.** Un formulaire perdu parce
que le téléphone s'est verrouillé est un formulaire qui ne sera pas ressaisi — et une
inspection perdue est une donnée que personne ne recollectera.

**Afficher la précision GPS** (« ± 12 m ») et refuser d'enregistrer une position
manifestement mauvaise. Une coordonnée à ± 500 m rattachée à un tronçon précis crée
une donnée fausse, plus coûteuse que pas de donnée.

---

## 11. Espace public

La carte publique refondue en Phase 2 sert de référence : recherche, chiffres du
réseau, filtre par état, géolocalisation, isolement d'une route, écussons de route,
disposition téléphone d'abord.

**Ce qui reste** : l'accueil du §39 — comprendre en quelques secondes l'état du réseau
national, puis « Explorer la carte ».

**La limite ne bouge pas** : trois couches en champs réduits. Ni entreprise, ni
bailleur, ni montant, ni contrat, ni PK, ni trafic. Cette réduction est faite
explicitement dans le contrôleur — elle doit le rester à chaque ajout.

---

## 12. Accessibilité

Objectif de plancher, à tenir dès maintenant plutôt qu'à rattraper au lot 2.8 :

- **Clavier** : tout ce qui se clique s'atteint au clavier, avec un focus visible.
- **Contraste** : 4,5:1 minimum pour le texte. Le gris clair des libellés secondaires
  est à vérifier.
- **Libellés** : chaque commande porte un nom accessible — déjà fait sur la carte
  publique (« Zoomer », « Afficher ma position », « Effacer la recherche »).
- **Mouvement réduit** : `prefers-reduced-motion` respecté — déjà le cas pour les
  recentrages de carte.
- **La couleur n'est jamais seule** porteuse d'information : l'état apparaît aussi en
  texte dans la fiche, pas seulement par la teinte du tracé.
