# Référentiel de praticabilité — inventaire de ce qui existe réellement

Relevé le 13/10/2026. Recherche exhaustive dans le code, le schéma, les migrations,
l'historique Git et la base de production.

## La correction à faire d'abord

L'addendum V4.1 énonce : « Les valeurs de praticabilité existent dans le système et doivent
être retrouvées dans le code, le modèle de données, les migrations et les données réelles. »

**Aucun référentiel de praticabilité n'existe**, et l'addendum demandait de le vérifier.
Mesures :

| Recherche | Résultat |
|---|---|
| Colonnes `%pratic%` en production | **0** |
| Types enum `%pratic%` en production | **0** |
| Valeurs d'enum `%pratic%` en production | **0** |
| Occurrences dans le dépôt antérieures au 13/10/2026 | **3, toutes en commentaire** |
| Commits de l'historique Git touchant « praticab » | **uniquement ceux du 13/10/2026** |

Les trois occurrences antérieures disent toutes la même chose, et c'est la piste qui a
permis de trouver quelque chose de réel : **OSM porte un attribut `NATURE` qui décrit la
praticabilité, pas le statut administratif.**

L'addendum dit aussi : « Si les valeurs officielles ne peuvent pas être établies avec
certitude, conserve les valeurs existantes et documente l'incertitude. Ne les invente pas. »
Il n'y a pas de valeurs officielles à conserver. Ce document documente donc l'incertitude et
n'invente rien.

## Ce qui existe réellement : `voirie_locale.nature`

21 valeurs textuelles brutes, issues du lot `A_OSM_RESEAU_ROUTIER 2023-03-08`. Comptées en
production :

| Valeur OSM | Enregistrements | Nature de l'information |
|---|---:|---|
| **Chemin non carrossable** | **102 100** | **praticabilité** |
| **Chemin carrossable** | **69 425** | **praticabilité** |
| Route non classifiée | 41 083 | classement |
| Route résidentielle | 34 929 | fonction |
| Route d'accès | 5 806 | fonction |
| Voie piétonne | 3 672 | usage |
| Route tertiaire | 2 951 | classement |
| Voie rapide | 1 007 | classement |
| Route secondaire | 847 | classement |
| Route primaire | 589 | classement |
| Bretelle voie rapide | 65 | fonction |
| Escaliers | 40 | usage |
| Inconnu | 34 | absence |
| Zone de rencontre | 32 | usage |
| Rue piétonne | 27 | usage |
| Chemin équestre | 14 | usage |
| Bretelle route tertiaire | 11 | fonction |
| Route en construction | 7 | état d'avancement |
| Bretelle route primaire | 7 | fonction |
| Voie cyclable | 5 | usage |
| Bretelle route secondaire | 5 | fonction |
| **Total** | **262 656** | |

**Deux valeurs sur vingt et une portent une praticabilité**, et elles couvrent
**171 525 enregistrements**, soit 65 %. Les dix-neuf autres décrivent un classement, une
fonction ou un usage, pas une possibilité de circuler.

Source dans le code : `backend/scripts/import-voirie-osm.ts`, dont le commentaire dit
explicitement, et dès 2026, que ce regroupement est « INFERE : aucun champ source ne le
porte » et qu'il s'agit d'« une lecture documentée, pas une donnée ».

## Pourquoi « carrossable » n'est PAS la praticabilité demandée

L'addendum pose la distinction juste : « Un tronçon peut être dégradé mais encore
praticable, ou **temporairement impraticable** en raison d'une inondation, d'un
effondrement, d'un ouvrage endommagé ou d'un autre événement. »

Or `carrossable` d'OSM est une propriété **structurelle et permanente** : un sentier n'est
pas carrossable par construction, et il ne le deviendra pas après la saison sèche. Une
latérite, elle, est carrossable et devient impraticable après les pluies.

Les deux notions ne se recouvrent donc pas :

| | Carrossable (OSM) | Praticabilité demandée |
|---|---|---|
| Nature | structurelle, du tracé | **événementielle**, de l'état |
| Change avec la saison | non | **oui** |
| Change après un sinistre | non | **oui** |
| Porte une date de constat | non | **doit en porter une** |
| Mesurée sur | 171 525 voiries locales | 0 tronçon |

**Confondre les deux serait la faute à ne pas commettre.** Un indicateur « praticabilité »
alimenté par `carrossable` dirait qu'un sentier est impraticable — ce qui est vrai mais sans
intérêt — et qu'une route nationale coupée par un pont effondré est praticable, ce qui est
faux et dangereux.

## Ce que je propose, et qui attend votre approbation

La table `referentiel_praticabilites` existe depuis le 13/10/2026 et **sort vide**. La
migration `20261013260000_praticabilite_approbation` y ajoute :

- `approuveeLe` et `approuveeParId`, avec une contrainte interdisant une approbation sans
  approbateur ;
- `description` rendue **obligatoire**, avec au moins vingt caractères, parce que
  « difficile » ne veut rien dire sans dire pour qui et dans quelles conditions ;
- la règle d'usage : une valeur non approuvée peut être portée par une **proposition** de
  terrain, mais **empêche sa validation**.

C'est le seul sens tenable de « faire approuver les valeurs avant leur utilisation
officielle ». Interdire la saisie aurait rendu le référentiel inéprouvable sur le terrain
avant son approbation : on aurait demandé d'approuver à l'aveugle.

**Aucune valeur n'est semée.** Vous devez les fixer, et le tableau ci-dessous donne ce que
la mesure et le cahier permettent de proposer, sans que je l'écrive en base :

| Code proposé | Libellé | Définition métier à valider | Franchissable | Saisonnière |
|---|---|---|---|---|
| `PRATICABLE` | Praticable | Circulable par un véhicule léger en toute saison, sans précaution particulière. | oui | non |
| `PRATICABLE_SAISON_SECHE` | Praticable en saison sèche | Circulable hors période de pluies ; impraticable ou risqué pendant la saison humide. | oui | **oui** |
| `DIFFICILE` | Difficilement praticable | Circulable avec un véhicule adapté ou à vitesse très réduite ; passage incertain. | oui | à préciser |
| `IMPRATICABLE` | Impraticable | Passage impossible pour un véhicule léger, quelle qu'en soit la cause. | **non** | non |
| `COUPE` | Coupé | Interruption constatée : ouvrage effondré, chaussée emportée, inondation. | **non** | non |
| `NON_RENSEIGNE` | Non renseigné | Personne n'a constaté la praticabilité. Distinct d'une praticabilité normale. | — | non |

Trois points sur ce tableau, pour que vous jugiez en connaissance de cause.

**`COUPE` se distingue d'`IMPRATICABLE`** parce que les deux appellent des actions
différentes : un impraticable chronique relève de la programmation d'entretien, un coupé
relève de l'urgence et d'une alerte.

**`DIFFICILE` est la valeur la plus fragile.** Elle demande « pour qui » : un 4×4 et un
camion citerne n'ont pas le même seuil. Si vous la retenez, sa définition doit nommer le
véhicule de référence, sinon deux agents la jugeront différemment.

**`NON_RENSEIGNE` n'est pas une praticabilité**, c'est son absence. Elle existe pour que les
statistiques ne comptent pas l'ignorance comme une bonne nouvelle.

## Les règles de saisie, telles qu'elles sont implémentées

Une praticabilité portée par une portion hérite du cadre des portions, déjà en place :

- **date du constat**, distincte de la date de saisie — une portion relevée lundi et remontée
  vendredi décrit lundi ;
- **source**, qui dit d'où vient l'observation ;
- **confiance**, qui suit celle de l'appariement GPS : qualifier depuis un appariement
  douteux ne produit pas une observation sûre ;
- **validité temporelle** : une requalification crée une nouvelle version et marque
  l'ancienne remplacée, sans jamais l'écraser. L'historique répond donc à « quelle était la
  praticabilité en juin ».

Le drapeau `saisonniere` du référentiel existe pour marquer les valeurs qui ne valent que
pour une période. Il est déclaré sur la valeur, pas déduit : aucun programme ne devine qu'un
libellé ajouté demain est saisonnier.

## Correspondance avec les autres applications

**Aucune comparaison n'est possible aujourd'hui, et il faut le dire.** Le Geoportail n'a
aucune valeur de praticabilité ; l'application mobile est la PWA du même dépôt, donc elle
n'en a pas davantage ; et je n'ai aucun accès à DigitalRoad ni à SharePoint pour y constater
ce qu'ils portent.

Si DigitalRoad porte un vocabulaire de praticabilité, c'est **lui** qui devrait servir de
référence plutôt que celui-ci, et une table de correspondance serait à construire. Je ne
peux pas le vérifier : c'est un blocage d'accès, pas une omission.

## Ce qui reste à faire

- **Votre arbitrage sur les six valeurs ci-dessus**, ou sur une autre liste. Rien n'est semé
  avant.
- **Une décision sur `voirie_locale.nature`** : faut-il dériver une praticabilité initiale du
  `carrossable` pour les 171 525 voiries locales ? Ce serait une donnée **inférée**, à
  marquer comme telle, jamais validée automatiquement. Mon avis : non pour les tronçons
  classés, peut-être pour la voirie locale, et dans tous les cas en proposition.
- **Vérifier DigitalRoad**, dès qu'un accès existe.
