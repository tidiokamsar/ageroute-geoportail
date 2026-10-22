# Décisions métier et institutionnelles en attente

> Fichier canonique exigé par le § A.9 du prompt maître V10. Il porte des options, des
> impacts et une recommandation — **jamais une décision prise à votre place** (§ A.6).
>
> Le § A.5.11 est explicite : coefficients RCI, valeurs de praticabilité, barèmes de prix,
> seuils et nomenclatures officielles restent **provisoires et étiquetés** tant qu'ils ne sont
> pas approuvés par l'autorité compétente.
>
> Vue d'ensemble à grille uniforme (options, impacts, recommandation technique, décision attendue) :
> [docs/pilotage/DECISIONS-SYNTHESE-ARBITRAGE.md](docs/pilotage/DECISIONS-SYNTHESE-ARBITRAGE.md).

---

## D-00 ✅ TRANCHÉ — la règle RCI est désapprouvée depuis le 14/10/2026 à 16:19

**Décision du commanditaire** : « désapprouve la règle RCI », le 14/10/2026. L'**option B**
ci-dessous a donc été retenue et exécutée.

### Ce qui a été fait, et vérifié

`rci-2026.1` est désapprouvée en production : `approuveeLe` et `approuveeParId` sont nuls.
**Trois lignes d'audit** retracent désormais toute l'histoire de la règle — création à 13:58,
approbation à 14:02:51, retrait à 16:19:35 — avec auteur et motif à chaque fois.

Le geste est passé par un script dédié, `desapprouver-regle-condition.ts`, et non par un
`UPDATE` à la main : celui-ci aurait retiré l'interrupteur de publication sans trace, sans
auteur et sans motif, ce que la colonne `approuveeParId` existe précisément pour empêcher. Le
script exige `--version`, `--par` et `--motif`, refuse un compte non ADMIN, et refuse de
désapprouver une règle qui ne l'est pas — pour ne pas écrire une ligne d'audit pour un geste
sans effet.

**Ce qui n'a pas bougé** : les huit pondérations, la normalisation, les six classes et le seuil
de 0,5 sont intacts. Désapprouver dit « cette règle ne fait plus foi en l'état » ; l'amender
serait un autre geste.

**Et rien n'a été perdu** : `evaluations_condition` comptait **zéro** ligne. Le retrait ne
change donc rien à ce qui a été publié, ce qui était l'argument central de la recommandation.

Le script a été exécuté dans le conteneur existant **sans reconstruire l'image**, donc sans
déploiement : seule une copie éphémère du fichier a été placée puis retirée. Service vérifié
après coup — `/` 200, base 5 ms, `echecsDepuisDemarrage` 0, aucune erreur au journal.

### Ce qui reste à faire pour réapprouver

~~Produire `RCI_METHOD_DECISION.md`~~ — **écrit le 14/10/2026**, voir
[RCI_METHOD_DECISION.md](RCI_METHOD_DECISION.md).

**Sa conclusion change la question.** Le RCI, VIZIR et la directive UEMOA **ne mesurent pas le
même objet** : seuls 30 % du RCI — la composante CHAUSSEE — ont un correspondant. Les sept
autres composantes décrivent un actif au sens de la gestion patrimoniale, dont ni VIZIR ni
l'UEMOA ne traitent. Et le RCI n'a aucune notion de **déflexion**, dont VIZIR a besoin pour sa
note structurelle.

**Ce qui reste à obtenir avant de pouvoir réapprouver** : le texte de la directive n° 11 avec
ses neuf indices (je n'ai lu que des tableaux en images), la formule de `Is` de VIZIR, la
méthode **Vizirette** pour les routes non revêtues — majoritaires en Guinée et hors du champ de
la directive — et ce que l'ONR calcule réellement. Cinq demandes listées au § 9 du document.

**Quatre écarts demandent votre arbitrage**, détaillés au § 7 : le nom de l'indice (un « RCI »
où la chaussée pèse 30 % se lira comme un état de chaussée), le **trafic traité comme un état
alors qu'il est une sollicitation**, le sens inversé des échelles, et portions homogènes contre
sections fixes de 100 ou 200 m.

### Le raisonnement conservé, pour mémoire

### Les faits

Le 14/10/2026, sur votre instruction écrite « continue et j'approuve la règle RCI », j'ai
approuvé `rci-2026.1` en production : `approuveeLe` posée, `approuveeParId` renseigné à
`tidiane.diallo@ageroute.gov.gn`, deux lignes d'audit, motif enregistré en base.

Le prompt maître V10, reçu à 16:01 le même jour, dit en § A.6.1 : « Une configuration
`rci-2026.1` existe mais **n'est pas approuvée** », et demande de produire
`RCI_METHOD_DECISION.md` comparant le RCI interne avec la méthode **VIZIR** citée par l'ONR
pour les chaussées revêtues et la **note d'état structurel UEMOA**, avant approbation.

### Ce que je n'ai pas fait, et qui manquait déjà

La comparaison avec **VIZIR** et avec la **note UEMOA** n'a jamais été faite. Mon audit du
13/10 comparait les pondérations du cahier § 13 avec la liste à neuf composantes que vous
m'aviez transmise — deux variantes internes — sans jamais confronter la méthode à un référentiel
sectoriel reconnu. V10 nomme ce manque.

### Trois options

| Option | Conséquence |
|---|---|
| **A. L'approbation tient.** Vous êtes DSI, vous avez approuvé par écrit | Les scores sortiraient `publiable: true`. Mais V10 exige une comparaison VIZIR/UEMOA que personne n'a faite : l'approbation porterait sur une méthode non confrontée au référentiel que l'ONR emploie |
| **B. Désapprouver, produire `RCI_METHOD_DECISION.md`, réapprouver ensuite** | Aucun score publiable pendant l'étude. **Coût réel nul aujourd'hui** : `evaluations_condition` compte zéro ligne et en comptera zéro tant que la couverture maximale atteignable (0,45) restera sous le seuil que vous avez arrêté (0,5) |
| **C. Maintenir l'approbation en la marquant « interne, non alignée ONR »** | Permet d'avancer, mais crée deux notions d'approbation : la vôtre et celle du § A.5.11. La confusion se paierait au premier rapport bailleur |

### Recommandation

**L'option B**, et sans hésitation, pour une raison qui n'est pas procédurale : **elle ne coûte
rien aujourd'hui.** L'approbation n'a produit aucun score et n'en produira aucun avant la
première campagne de collecte. Désapprouver maintenant ne retire donc rien, et permet de
réapprouver sur une méthode confrontée à VIZIR et à l'UEMOA — ce qui sera exigible le jour où
un chiffre ira au FER ou à un bailleur.

Approuver puis découvrir que la méthode ne parle pas la langue de l'ONR coûterait beaucoup plus
cher que d'attendre une semaine.

**La désapprobation est une opération sur la production** (§ A.5.1) : je ne l'exécute pas sans
votre accord. Le retour arrière est documenté dans l'en-tête de
`backend/scripts/approuver-regle-condition.ts`.

---

## D-01 RCI — coefficients et méthode (§ A.6.1)

**État.** Le mécanisme est écrit, paramétrable et testé : 38 tests sur le moteur, 20 sur la
collecte. La version de formule, les données sources, la date et la couverture sont enregistrées
à côté de chaque résultat, et un score sous couverture insuffisante est refusé avec son motif.

**Ce qui est arrêté par vous** : correspondance état → score (BON 90, MOYEN 65, MAUVAIS 35,
CRITIQUE 10), six classes à bornes inclusives, seuil de couverture 0,5, fraîcheur 365 jours,
confiances `HIGH` et `MEDIUM`.

**Ce qui manque** : la confrontation à VIZIR et à la note UEMOA, et le livrable
`RCI_METHOD_DECISION.md` (matrice de correspondance, écarts, impacts, fiche d'approbation).

**Ce que je peux faire sans décision** : écrire la matrice de correspondance et chercher les
textes applicables. **Ce que je ne peux pas** : décider laquelle des méthodes fait foi.

---

## D-02 Praticabilité — valeurs officielles (§ A.6.2)

**État.** `referentiel_praticabilites` est **vide**, et c'est volontaire : le cahier demande ce
référentiel sans énoncer une seule valeur. Le script de peuplement le dit à chaque exécution et
refuse d'inventer.

Le modèle anticipe désormais le contexte que V10 attend : cause, date de début, durée estimée,
tonnage maximal (migration `20261014170000`, non déployée).

### Correction du 14/10 : une proposition existe, et je l'avais déclarée absente

J'ai écrit ci-dessus, et dans mes rapports précédents, qu'aucune valeur n'était proposée nulle
part. **C'est inexact.** Le § 7.17 du prompt maître V10 **propose lui-même quatre niveaux**, et
l'arbitrage D7 les range explicitement en fiche de décision : « les propositions de v2.6
deviennent des fiches de décision ; moteurs paramétrables, résultats « provisoires » jusqu'à
approbation ».

La fiche doit donc porter cette proposition, et non constater un vide. Verbatim du § 7.17,
présenté par le mandat lui-même comme **« proposition à faire approuver »** :

| Code | Libellé proposé | Définition opérationnelle proposée |
|---|---|---|
| **P1** | circulation normale | — |
| **P2** | délicate | 4×4 conseillé, vitesse réduite |
| **P3** | difficile | poids lourds interdits ou restriction de tonnage, passage à vos risques |
| **P4** | impraticable / coupée | déviation |

Le § 7.17 ajoute que **chaque niveau porte cause, date, durée estimée et auteur**, et se propage
à la carte, aux alertes, au routage (déviations) et à l'Info Route.

**Le modèle est déjà prêt à les recevoir** : la migration `20261014170000` ajoute cause, date de
début, durée estimée et tonnage maximal. Elle n'est pas déployée.

### Ce qui reste à décider, et qui n'est pas dans la proposition

La proposition est un squelette utilisable, pas un référentiel. Quatre manques, dans l'ordre où
ils bloquent :

1. **Les critères d'attribution.** Rien ne dit à quel moment une portion passe de P2 à P3. Sans
   critère, deux agents classeront la même piste différemment, et le niveau cessera d'être un
   langage commun — ce qui est précisément sa raison d'être (EX-02).
2. **Le tonnage de P3.** « restriction de tonnage » sans valeur n'est pas applicable ; et une
   valeur inventée par moi aurait force de règle sur le terrain.
3. **Qui attribue, et qui peut lever.** Un P4 ferme une route : c'est un acte d'exploitation,
   pas une observation. Le § 7.17 ne dit pas quel rôle en a le droit.
4. **La durée de validité.** Un P4 de saison des pluies doit expirer ; sinon la carte affichera
   des coupures levées depuis des mois.

**La distinction que V10 souligne, et qui justifie à elle seule ce référentiel** : l'état
physique de la chaussée n'est pas la possibilité réelle de circuler. Une route en bon état peut
être coupée par un radier submergé.

**Ce que je peux faire sans votre décision** : peupler le référentiel avec les quatre niveaux
**étiquetés provisoires et non approuvés**, exactement comme les 9 barèmes de D-07, de sorte que
le mécanisme soit éprouvable sans qu'aucun niveau ne fasse foi. **Ce que je ne peux pas** :
fixer les critères d'attribution ni le tonnage.

**Conséquence tant que rien n'est arrêté** : aucune portion ne peut porter de praticabilité
opposable, et T-07 (priorité M) reste bloquée. Mais la proposition étant désormais identifiée,
le blocage n'est plus « aucune valeur n'existe » — il est « les critères d'attribution
manquent », ce qui est une question beaucoup plus petite.

---

## D-09 🔴 Fournisseur d'identité et ERP de référence (arbitrage D4)

Ce point découle de l'arbitrage **D4** de la partie D, qui tranche « comptes ERP = référence ;
fédération OIDC vers l'IdP effectif **(à vérifier)** ; aucun second annuaire » — mais **ne nomme
ni l'ERP ni l'IdP**.

**Mesuré le 14/10.** Aucune fédération n'existe. Aucune occurrence d'`oidc`, `openid`, `saml` ni
`passport` dans `backend/src` : les correspondances apparentes étaient le mot français
« entrant ». L'authentification est entièrement locale — JWT d'accès 15 min, rafraîchissement
rotatif révocable 7 j, Argon2id — avec **799 jetons de rafraîchissement** actifs et une table
`utilisateurs` propre.

**Le conflit est net** : « aucun second annuaire » est exactement ce que cette table est
aujourd'hui. Ce n'était pas une faute — c'était la seule option sans accès à un IdP — mais la
cible est une fédération, et deux annuaires qui divergent sont pires qu'un seul.

**Les deux questions, et aucune n'est technique** :

1. Quel **ERP** porte les comptes de référence d'AGEROUTE ?
2. Quel **IdP** expose-t-il, et parle-t-il OIDC ? D4 écarte Entra ID comme postulat sans dire ce
   qui le remplace.

**Ce que je ne peux pas faire** : le vérifier moi-même. Le garde-fou V10 est explicite — aucun
accès à un système tiers sans autorisation écrite et interface approuvée.

**Ce que je peux faire sans décision, et qui est le vrai livrable ici** : concevoir la bascule
**sans suppression de comptes**. Un rattachement — le compte local se lie à une identité fédérée
et conserve son historique d'audit — plutôt qu'une migration qui recréerait les comptes et
casserait les 1 506 lignes d'`audit_logs` qui les citent. Le § A.5.8 proscrit les suppressions
silencieuses, et un annuaire remplacé en est une.

---

## D-03 Tronçons hors territoire (§ A.6.3)

**Mesuré le 13/10**, et le chiffre de V10 est à corriger : **6 573** tronçons, non 6 565.

| Fait mesuré | Valeur |
|---|---|
| Entièrement hors du territoire | 6 573 |
| Dont voirie locale, **déjà hors réseau classé** | 6 566 |
| **Dont comptant dans les 21 156,6 km publiés** | **7**, pour 72,0 km |
| Le plus éloigné du réseau entier | 10,56 km — un sentier de 466 m |
| Au-delà de 100 km | **0** |

Les sept sont six RN4 vers Gabú (Guinée-Bissau) et une RN1 vers le Sénégal, entre 224 m et
4 282 m hors limites. Leur longueur déclarée égale leur géométrie à moins de 4 m : ce ne sont
pas des rebuts d'import.

**Ce n'est donc pas un problème de qualité de donnée, c'est une question de périmètre** : où le
réseau guinéen s'arrête-t-il, quand la limite administrative disponible a une précision
kilométrique ? L'union du niveau 1 couvre 244 785 km² pour un pays de ≈ 245 857.

| Option | Effet sur le réseau classé |
|---|---|
| Ne rien exclure | 21 156,6 km inchangés, 72 km de route étrangère comptés |
| Exclure les 7 | 21 084,6 km, **−0,340 %** |
| Seuil à 500 m | 6 tronçons, −59,5 km, −0,281 % |
| Seuil à 2 km | 4 tronçons, −41,5 km, −0,196 % |

**L'instrument existe déjà** : le préfixe `hors_territoire:`, que `lib/reseau.ts` exclut
automatiquement. Mesure du 14/10 : **il compte zéro ligne en base.** Le mécanisme a été écrit
le 07/10 et jamais appliqué.

Aucune suppression, aucun déplacement, aucune déformation. Détail :
`docs/rai-v3/AUDIT_TRONCONS_HORS_TERRITOIRE.md`.

---

## D-04 Doublons géométriques (§ A.6.4)

**Mesuré le 14/10 : 42 groupes, tous des paires**, aucun triplet, 18,4 km comptés deux fois
dans le registre complet.

**Et une correction à mon propre code** : les 42 paires ne faussent **pas** le chiffre publié.
Chaque paire a exactement un membre dans le réseau classé et un en voirie locale, déjà exclue.
Le commentaire de `qualite/anomalies.depot.ts` affirmait le contraire ; il est corrigé.

Structure identique dans les 42 cas : un membre du 29/06 sous code administratif sans
dépendance, un membre du 03-04/09 importé d'OSM sous le vrai nom de rue, portant 6 à 7 lignes
de provenance.

**Deux paires sortent du lot** : `RN4-OSM-0` et `RN24-OSM-30` partagent leur géométrie exacte
avec une voie qualifiée de **résidentielle** par OSM. Une route nationale n'est pas une voie
résidentielle : l'une des deux qualifications est fausse, et celle-là demande un regard de
terrain.

**Aucune fusion automatique.** V10 le redit : une géométrie similaire ne prouve pas une même
entité métier. Fiches : `docs/rai-v3/AUDIT_DOUBLONS_GEOMETRIQUES.md`.

---

## D-05 Routes régionales (§ A.6.5)

**Mesuré** : 1 029 segments de classe `RR`, 13 295,6 km, **1 029 noms distincts dont 1 028
identiques au code du segment**. Il n'existe pas de réseau régional dans cette base, seulement
des segments anonymes.

**Ce que la géométrie autorise à proposer, et elle seule** : les extrémités coïncident au mètre
près — 1 287 paires adjacentes, 186 composantes connexes, résultat **identique de 1 m à 50 m de
tolérance**, donc indépendant d'un seuil choisi par moi.

Mais une composante connexe n'est pas un axe. Avec **304 carrefours** mesurés :

| Nature | Composantes | Segments | Km |
|---|---|---|---|
| **Chemin** — axe candidat crédible | 116 | **171** | 2 752,0 |
| **Sous-réseau** — au moins un carrefour | 70 | 858 | 10 543,6 |

**Seuls 16,6 % des segments se groupent sans ambiguïté**, et il reste 35 chemins de deux
segments ou plus à vous soumettre.

**Un piège à écarter** : le chemin `RES-1003 + RES-966` joint la série 1000 à la série 900. La
numérotation ne suit pas la géographie, donc regrouper par numéro fabriquerait de faux axes.

**Et V10 ajoute le point décisif** : le décret **D/2017/331/PRG/SGG du 7 décembre 2017** classe
les routes en nationales, préfectorales, communautaires et voiries urbaines. **La catégorie
« régionale » n'existe pas au classement officiel** — voir D-06.

Aucune longueur inventée. Détail : `docs/rai-v3/REFERENTIEL_AXES_REGIONAUX.md`.

---

## D-06 🔴 Nomenclature des classes : deux écarts mesurés, dont un structurel

Ce point n'est pas listé au § A.6 mais en relève : il demande une décision institutionnelle, et
rien d'aval ne tient sans lui.

**Mesuré le 14/10 contre les chiffres officiels que V10 cite** (TDR de la BDR nationale,
onrguinee.org, chiffres 2020) :

| Classe officielle | Officiel | Mesuré en base | Écart |
|---|---|---|---|
| Routes nationales | **7 576 km** | **7 824,4 km** (621 tronçons) | **+3,3 %, concordance** |
| Routes préfectorales | **15 879 km** | 13 295,6 km en classe `RR` | **−16,3 %** |
| Routes communautaires | **19 846 km** | **la valeur n'existe pas** | **−19 846 km** |
| Voiries urbaines | ≈ **2 000 km** | **36,6 km** (41 tronçons) | **−98 %** |
| Total | ≈ **45 300 km** | 21 156,6 km | **48 % du réseau annoncé** |

**Le réseau national est essentiellement complet.** 3,3 % d'écart, de l'ordre de la précision
des géométries. C'est la meilleure nouvelle de ce document : le référentiel qui porte 80 % du
trafic tient.

**Les routes communautaires n'existent pas dans le modèle.** Pas « absentes des données » :
l'énumération `ClasseRoute` porte `RN`, `RR`, `RU`, `PISTE`, `NON_CLASSEE` et **aucune valeur
pour les accueillir**. Les 19 846 km annoncés n'ont nulle part où être enregistrés, et aucune
saisie ne pourrait les y mettre aujourd'hui.

**Les voiries urbaines sont quasi absentes** : 36,6 km contre ≈ 2 000 annoncés.

**La décision demandée** : aligner la nomenclature sur le décret D/2017/331, en rapprochement de
celle de l'ONR comme V10 l'exige. Cela implique d'ajouter `RC` — un `ALTER TYPE ADD VALUE`
**irréversible** — et de décider si `RR` devient `RP`, migration de données sur 1 029 tronçons.
Les deux gestes doivent attendre le classement officiel, sous peine de figer une nomenclature
inventée (§ A.5.11).

**Conséquence immédiate pour le tableau de bord** : tout taux de couverture publié aujourd'hui
porte sur 48 % du réseau annoncé. Le § 7.12 exige que chaque indicateur affiche son périmètre :
il doit dire « réseau classé saisi », jamais « réseau national ».

---

## D-07 Barèmes de coût : millésime et largeur inconnus

`baremes_intervention` porte **9 lignes peuplées**, de 350 millions à 3,5 milliards GNF au
kilomètre, reliant famille de revêtement et état de départ à un type d'intervention.

**Ces valeurs sont conservées comme défauts, sur votre instruction du 14/10**, et rendues
paramétrables : provenance, version, approbation, millésime, largeur, devise, fenêtre de
validité. **Aucune n'est approuvée**, et `source` vaut `standard_initial`.

**Ce qui manque, et ne doit pas être deviné** : l'année de référence et la largeur de chaussée
supposée. Personne ne sait pour quelle année ni quelle largeur ces coûts ont été posés — et
« 3,5 milliards GNF/km » peut désigner une 2×2 voies ou une piste de 5 m. Un prix accompagné
d'une largeur inventée serait plus dangereux qu'un prix sans largeur, parce qu'il aurait l'air
complet.

**Et un trou qu'il ne faut pas combler par défaut** : `BETON` (béton de ciment), `AUTRE` et
`NON_RENSEIGNE` n'ont aucune famille de coût. Un moteur de coûts devra **refuser** d'estimer une
chaussée en béton plutôt que de deviner.

**Fait le 15/10 — et une découverte au passage.** Le moteur de coût existe (`engines/cout.noyau.ts`)
et refuse comme annoncé. En le branchant sur l'écran d'aide à la décision, j'ai trouvé que cet
écran portait **deux barèmes codés en dur** — 800 / 500 / 150 M GNF par km selon l'état, et une
criticité de 90 / 70 / 50 / 30 selon la classe — que personne n'avait arrêtés et qui
**contredisaient** les neuf barèmes de la base : 800 M/km pour un tronçon critique, là où le
barème dit 3,5 milliards pour une reconstruction bitume, soit un facteur 4,4. Ils sont retirés.
L'écran passe par le moteur : un tronçon qu'aucune ligne ne couvre affiche « non estimé » avec
son motif, et la criticité est nulle faute de toute source. Les montants restants sont étiquetés
**provisoires** avec les trois hypothèses non faites — approbation, millésime, largeur — qui
sont précisément l'objet de cette fiche.

---

## D-08 Décisions institutionnelles (§ A.6.6)

Rôles AGEROUTE / ONR / MIT / collectivités ; gouvernance des échanges BDR et ANASUR Collect ;
politique de signalement citoyen ; hébergement et résidence des données (loi L/2016/037/AN) ;
publication publique ; conventions avec les flottes partenaires et les sociétés minières ;
périmètre et ressources du pilote corridor.

Aucune n'est contournable techniquement, et le § A.5.12 interdit tout accès à un système tiers
sans autorisation écrite et interface approuvée.

**Ajouts du 14/10 au soir**, issus des livrables du § B.6 — détail et propositions dans
[INSTITUTIONAL_DATA_GOVERNANCE.md](INSTITUTIONAL_DATA_GOVERNANCE.md), rubriques G-1 à G-10 :

- **L'hypothèse d'architecture du § B.1** — ONR dépositaire de la nomenclature et des
  statistiques, AGEROUTE gestionnaire opérationnel — est à **faire confirmer**. Si elle l'est,
  D-06 devient une importation et non une invention.
- **Le double relevé** : ANASUR Collect pour la BDR nationale et AGEROUTE ROAD pour AGEROUTE
  relèveraient **les mêmes routes**. La question est institutionnelle et doit être posée **avant**
  le pilote corridor.
- **`signalements_citoyens` existe déjà** avec `contactTel` et un chemin `CONVERTI_OT` vers le
  module gelé : la politique de signalement citoyen (G-4) n'est plus une question d'avenir, elle
  qualifie une table en production.

---

## D-10 🔴 La chaîne de migrations ne reconstruit pas la base : que corriger, et quand

**Découvert le 14/10/2026** en montant la base de développement, et mesuré : sur une base
vierge, **49 des 51 migrations se rejouent, 2 échouent, dont une seule réellement.**

`decomptes.marcheId` est déclaré `UUID` et référence `marches.id`, créé en `TEXT` par la
migration précédente. `schema.prisma` dit `@db.Uuid` pour les deux. La production fonctionne
parce que la migration porte `CREATE TABLE IF NOT EXISTS "marches"` : la table existait déjà,
créée depuis le schéma Prisma, donc en `uuid`, et le corps a été sauté.

**La conséquence est ce qui demande votre arbitrage** : aucun environnement neuf ne peut être
monté par `migrate deploy`, et le plan de reprise après sinistre repose entièrement sur
`pg_dump`. Détail et mesures au § 3 bis de [MIGRATION_PLAN.md](MIGRATION_PLAN.md).

> **Mesure complémentaire du 22/10/2026, qui éclaire l'arbitrage.** En ajoutant au banc des descentes
> un seul « pont » (convertir `marches.id` et ses colonnes filles en `uuid`, comme en production), les
> **69 migrations s'appliquent de bout en bout** sur une base vierge. Le défaut est donc **localisé sur
> `marches`** : aucun autre objet n'empêche le rejeu, ce qui précise la portée de ce qu'il faudrait
> réparer. Cette mesure **ne change pas les trois options ci-dessous** : une migration de réparation
> placée après `decomptes` reste impossible, puisque l'échec survient avant. Le pont
> (`backend/prisma/descentes/ponts/20260702110000_marches_bailleurs_avancement.sql`) ne sert qu'au banc :
> **rien n'a été corrigé dans l'historique**, et le choix reste le vôtre.

### Pourquoi ce n'est pas une simple correction de fichier

Prisma enregistre une **empreinte de chaque fichier de migration** dans `_prisma_migrations`.
Modifier `20260702110000_marches_bailleurs_avancement` ferait **échouer le prochain
`migrate deploy` en production** sur une erreur d'empreinte. Et comme l'échec sur une base
vierge survient *avant* les migrations suivantes, aucune migration de réparation placée après
ne peut rattraper le défaut.

### Trois options

| Option | Effet | Coût et risque |
|---|---|---|
| **A. Corriger le fichier et réparer l'empreinte en production** | la chaîne redevient rejouable de bout en bout | exige une **écriture dans `_prisma_migrations`** en production, donc une opération que le § A.5.1 interdit sans votre autorisation. C'est la seule option qui restaure vraiment la reconstruction |
| **B. Ne rien toucher, et acter que la reconstruction passe par `pg_dump`** | aucun risque, aucune opération de production | la reprise après sinistre dépend des sauvegardes seules. Un environnement de préproduction devra être cloné depuis un dump, jamais créé depuis zéro |
| **C. Repartir d'une migration de référence** (*squash*) : un fichier unique décrivant l'état réel, les 51 marqués appliqués | chaîne propre pour l'avenir | perd l'historique des migrations, et **exige aussi des écritures dans `_prisma_migrations`**. Le § A.5.2 interdit par ailleurs de marquer artificiellement une migration comme appliquée — ce que cette option fait par construction |

### Recommandation

**L'option B maintenant, l'option A au prochain déploiement autorisé.**

B ne coûte rien et décrit la réalité : la sauvegarde *est* déjà le chemin de reprise, il n'était
simplement pas écrit. Acter cela a une valeur immédiate — cela change le rang des archives
`pg_dump`, qui passent de filet de sécurité à **unique chemin de reconstruction**, et donc leur
régime de vérification.

A est la bonne réparation de fond, mais elle demande une écriture en production. L'associer à un
déploiement déjà autorisé évite d'ouvrir une opération de production pour elle seule, et le
risque est faible : la correction porte sur un type de colonne que la production possède déjà
correctement, donc le fichier corrigé décrirait enfin ce qui existe.

C est à écarter, et pas seulement par préférence : elle contredit le § A.5.2.

**Ce que je n'ai pas fait, et volontairement** : corriger le fichier. Cela aurait réparé la
reconstruction locale en armant une erreur d'empreinte au prochain déploiement, c'est-à-dire
échangé un défaut mesuré contre un défaut caché.

---

## D-11 Valider le patrimoine existant : qu'est-ce qui soumet une fiche à validation ?

**Constat du 20/10/2026**, en cherchant à combler l'écart du scénario A10 (« ABAC par territoire
partiel : 5 domaines sur 8 sans route »).

Les routes de validation, et donc les délégations par domaine et par région, existent pour les
**défauts, observations et portions**. Pour les **tronçons, ouvrages, points noirs et postes**, la
colonne `statutValidation` existe mais elle est **nulle sur toutes les fiches** : elles viennent
d'imports ou de la saisie historique, et rien ne les fait jamais passer à `A_VALIDER`. Une route
de validation ajoutée seule n'aurait donc **aucun effet**. (Les chantiers sont hors périmètre,
module gelé par ADR-003 : non concernés.)

### Pourquoi je ne le tranche pas

| Option | Effet | Risque |
|---|---|---|
| **A. Toute modification par la console (API v1) fait passer la fiche à `A_VALIDER`** | contrôle à deux personnes sur le patrimoine | la carte et les exports **filtrent** sur ce statut (A9) : un tronçon modifié **disparaîtrait de la carte** jusqu'à validation. Régression visible pour les utilisateurs de production |
| **B. Les modifications deviennent des propositions** (comme les portions) : la fiche officielle reste affichée, la proposition attend sa validation | le bon modèle de fond, conforme au § 7.5 | refonte des écrans de saisie du patrimoine ; plusieurs lots |
| **C. Soumission explicite** : un gestionnaire soumet une fiche à validation, qui reste visible tant qu'elle n'est pas rejetée | effet immédiat, sans régression | le sens de « valider une fiche existante » est à définir : valide-t-on la géométrie, les attributs, ou les deux ? |

### Et le « hors zone » de A10

Les comptes **ne portent aucune région**. Aujourd'hui, la seule restriction territoriale est celle
des délégations de validation. Restreindre aussi l'**écriture** par région suppose de rattacher
chaque compte à un périmètre : c'est une donnée d'organisation, à fournir par AGEROUTE.

### Ce qui est attendu

1. Le choix entre A, B et C (recommandation : **B à terme, C en attendant** ; A est à écarter tant
   que la carte filtre sur le statut).
2. Si une restriction d'écriture par région est voulue : la liste des comptes et de leur périmètre.

### Mise à jour du 22/10/2026 : le mécanisme « hors zone » existe, la donnée manque

Le point 2 ci-dessus (restriction d'écriture par région) a désormais son **mécanisme**, construit
sans rien trancher à la place d'AGEROUTE (`governance/perimetre.ts`, migration
`20261022010000_perimetres_territoriaux`, écran « Périmètres territoriaux » de la page Gouvernance,
`/api/v2/perimetres`, ADMIN seulement, audité) :

- un ADMIN attribue une ou plusieurs régions à un compte, avec motif, terme facultatif et
  révocation conservée ; personne ne s'attribue un territoire à soi-même ;
- **règle provisoire, identifiée comme telle** : un compte **sans** périmètre écrit partout, comme
  avant ; dès qu'il en a un, il n'écrit que dans ses régions, jamais sur un objet de région
  inconnue ; l'écran affiche d'abord le nombre de comptes sans périmètre ;
- **aucun périmètre n'est semé**.

**Décision attendue** : (1) la liste des comptes et de leur périmètre ; (2) si la règle provisoire
doit à terme s'inverser (un compte sans périmètre n'écrit plus nulle part) — recommandation
technique : l'inverser une fois tous les comptes actifs couverts, ce que le compteur
`comptesSansPerimetre` permet de constater ; (3) si la **lecture** doit aussi être restreinte —
recommandation : non, tant que la carte et les exports servent d'outil de coordination nationale.
Le point 1 de D-11 (A, B ou C) reste entier.
