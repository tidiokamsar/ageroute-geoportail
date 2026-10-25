# Pilote (phase 7) et vision locale (phase 4) : ce qui est décidé, ce qui est cherché, ce qui est vérifié

Établi le 25/10/2026. Les sources web citées ont été lues par recherche, pas téléchargées.

## 1. Pilote : corridor retenu

Le DSI a indiqué le 25/10/2026 que le corridor du pilote est décidé : **« RN1 ou Boké »**. La phrase ne dit pas lequel passe
en premier, ni si les deux sont retenus ; je les consigne tous les deux comme **corridors retenus pour le pilote** et je n'en
choisis pas l'ordre à la place de l'AGEROUTE.

- **RN1 (Conakry, Coyah, Kindia, Mamou)** : Coyah, Kindia et Mamou sont dans la liste de villes de la console.
- **Boké** : Boké, Boffa, Fria, Gaoual et, depuis le 25/10, **Sangarédi** (11°06′N 13°46′W, Wikipédia) y sont. Le corridor
  Sangarédi–Télimélé cité par le DSI est de ce côté.

**Ce que le logiciel apporte déjà pour ce pilote** : la route entre deux villes (tous ses tronçons dans l'ordre, sur le
réseau, avec changement d'état de l'ensemble), l'enregistreur de relevé en roulant, le pack de mission hors ligne.

**Ce qui n'est pas vérifié** : que le référentiel de production contienne une route CONTINUE sur ces corridors. Le serveur
dit « aucune route continue » quand le référentiel est interrompu ; je n'ai pas interrogé la production (lecture de la
base refusée par le contrôle de permissions). Le premier geste du pilote est donc de demander la route Conakry–Mamou, puis
Sangarédi–Télimélé, et de lire la réponse.

**Quatre types de route à couvrir** (énoncés par le rapport de Z.AI) : bonne route, route dégradée, latérite, drainage.
Aucun jeu d'images n'existe encore pour eux ; c'est l'objet du pilote.

## 2. Vision locale : existe-t-il des images annotées de Guinée ?

**Réponse mesurée : je n'en ai trouvé aucune.** Recherche faite le 25/10/2026 : aucun jeu public d'images de routes
**guinéennes** annotées en dégradations n'apparaît. Ce qui existe est étranger au contexte (routes revêtues, pays d'Asie, d'Europe,
d'Amérique du Nord), à utiliser au mieux comme point de départ, pas comme preuve de performance en Guinée.

| Source | Contenu | Licence annoncée | Utilité pour la Guinée |
|---|---|---|---|
| RDD2022 (Arya et al., figshare 21431547, 12,36 Go) | 47 420 images, plus de 55 000 dégradations : fissures longitudinales, transversales, faïençage, nids-de-poule. **Japon, Inde, Tchéquie, Norvège, États-Unis, Chine** | CC BY-SA 4.0 selon l'article et le dépôt GitHub ; **CC BY 4.0 selon la page figshare** : à lever avant tout usage | Point de départ pour nids-de-poule et fissures sur revêtement. Aucune image de latérite ni de piste. |
| Road Damage Dataset : nids-de-poule, fissures, plaques d'égout (Kaggle, article PMC13181123) | 2 009 images annotées, format YOLO, prises en février-mars 2025 | À lire sur la page du jeu | Origine géographique non vérifiée par moi. |
| Bangladesh Road Damage Detection Dataset (Mendeley, ktnx66vtmc) | Images annotées de routes du Bangladesh | À lire sur la page du jeu | Routes de pays chaud en développement, proches par l'aspect de certaines routes guinéennes ; non vérifié. |
| Mapillary (images de rue collaboratives) | Images géolocalisées, CC BY-SA | CC BY-SA | **Couverture de la Guinée non vérifiée** ; images non annotées en dégradations. |

**Ce que je n'ai pas fait** : aucun téléchargement (12 Go pour RDD2022 : à confirmer avec vous, avec le lieu de stockage), aucun
entraînement, aucune mesure de performance. Un modèle entraîné sur ces jeux serait annoncé « non évalué en Guinée ».

**Points de droit à faire valider** : la clause « partage dans les mêmes conditions » (CC BY-SA) s'applique aux adaptations du
jeu ; son effet sur un modèle entraîné avec ces images n'est pas tranché par ce document. La divergence CC BY / CC BY-SA de
RDD2022 est à lever auprès des auteurs.

## 3. Plan proposé, sans rien inventer

1. **Pilote d'abord** : collecter avec l'enregistreur (photos géolocalisées prises par les agents) sur les corridors retenus et
   les quatre types de route. Sans ces images, pas de modèle fiable pour la latérite.
2. **Annotation** par des agents, avec le catalogue de défauts existant (les défauts restent relevés et validés par leur propre
   processus : la vision ne remplace pas la saisie).
3. **Modèle** : départ sur RDD2022 (si la licence est levée), puis ajustement sur le corpus guinéen ; évaluation sur des images
   guinéennes jamais vues, avec le taux d'erreur publié tel qu'il sort, quel qu'il soit.
4. Le résultat d'un modèle ne devient jamais un défaut confirmé : c'est une suggestion à valider.

**Bloqué par** : le corpus guinéen (pilote), la décision de licence, l'espace de stockage des images.
