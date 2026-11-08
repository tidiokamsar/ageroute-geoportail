# RCI : méthode, correspondances et fiche d'approbation

> Livrable exigé par le § A.6.1 du prompt maître V10 : « compare sans les confondre le RCI
> interne, la méthode **VIZIR** mentionnée par l'ONR pour les chaussées revêtues, la **note
> d'état structurel UEMOA** et les méthodes éventuellement appliquées par l'ONR ; recherche les
> textes et guides applicables ; produis `RCI_METHOD_DECISION.md` (matrice de correspondance,
> écarts, impacts, fiche d'approbation) ».
>
> **Statut de la règle au 14/10/2026 : `rci-2026.1` est DÉSAPPROUVÉE**, à 16:19, sur votre
> instruction et en application de ce paragraphe. Aucun score n'avait été produit.
>
> **Aucune valeur de ce document n'est une norme approuvée** (§ A.5.11).

Rédigé le 14/10/2026. Les sources sont citées ; ce que je n'ai pas pu vérifier est dit comme
tel.

---

## 1. La conclusion, d'abord

**Le RCI, VIZIR et la directive UEMOA ne mesurent pas le même objet.** Ce n'est pas un écart de
coefficients, c'est un écart de périmètre, et il explique à lui seul pourquoi une
« correspondance » terme à terme est impossible.

| Méthode | Ce qu'elle mesure | Portée |
|---|---|---|
| **VIZIR** | l'état de la **chaussée** : type de dégradation, gravité, étendue → indice de surface `Is`, puis note de qualité **des structures** en l'associant à la **déflexion** | chaussées souples |
| **Directive n° 11 UEMOA** | **neuf indices de dégradation** de chaussée, un par type, croisant extension et gravité | chaussées **à structure hydrocarbonée uniquement** |
| **RCI `rci-2026.1`** | l'état d'un **tronçon comme actif**, par huit composantes pondérées dont la chaussée ne pèse que **30 %** | tout tronçon, revêtu ou non |

Le RCI inclut le drainage, les ouvrages, la signalisation, la sécurité, le trafic, l'historique
et les incidents. **VIZIR et l'UEMOA n'ont aucun équivalent pour ces sept composantes.** À
l'inverse, le RCI n'a **aucune notion de déflexion**, dont VIZIR a besoin pour sa note
structurelle — et AGEROUTE n'en possède aucune mesure.

**Ils sont donc complémentaires et non concurrents.** La décision à prendre n'est pas « lequel
choisir » mais « comment les faire coexister sans confusion ».

---

## 2. Un fait que le mandat ne mentionne pas : la Guinée n'est pas membre de l'UEMOA

L'UEMOA réunit **huit États** : Bénin, Burkina Faso, Côte d'Ivoire, Guinée-Bissau, Mali, Niger,
Sénégal, Togo. La **Guinée-Conakry n'en fait pas partie** — elle n'a pas le franc CFA mais le
franc guinéen, ce que le § A.2 du mandat rappelle lui-même.

**Conséquence, et elle change la nature de la décision.** La directive n° 11/2009/CM/UEMOA ne
lie pas juridiquement la Guinée. S'aligner sur elle serait un **choix de comparabilité
régionale**, pas une obligation réglementaire.

Ce choix a néanmoins une valeur forte, et trois raisons le recommandent :

1. **Les bailleurs** (Banque mondiale, BAD, UE) lisent les indicateurs de la sous-région dans
   ce vocabulaire. Un état de réseau exprimé autrement demande une traduction à chaque dossier.
2. **L'ONR emploierait les outils L²R**, qui sont précisément ceux déployés par l'UEMOA pour
   appliquer la directive (§ 5 ci-dessous). Parler la langue de la BDR nationale revient alors
   à parler celle de la directive.
3. **Les méthodes existent et sont éprouvées** depuis 1965 ; les réinventer coûterait sans rien
   gagner.

Mais le dire franchement évite un malentendu coûteux : présenter un alignement UEMOA comme une
mise en conformité réglementaire serait inexact.

---

## 3. VIZIR, ce qui est établi

**Source** : P. Autret et J.-L. Brousse, « VIZIR — méthode d'évaluation des chaussées souples »,
*Bulletin de liaison des laboratoires des Ponts et Chaussées*, spécial XVII, décembre 1994,
ISBN 2-7208-1150-5 (notice TRID 01238634). Méthode antérieure : *Vizir, méthode assistée par
ordinateur pour l'estimation des besoins en entretien d'un réseau routier*, LCPC, décembre 1991.

| Élément | Contenu vérifié |
|---|---|
| Objet | évaluation, qualification et hiérarchisation d'un réseau de **chaussées souples** |
| Caractérisation | **type** de dégradation × **gravité** × **étendue** |
| Niveaux de gravité | **trois**, pour chaque type de dégradation |
| Indice de section | **indice de surface `Is`** |
| Note structurelle | `Is` **associé à la déflexion** → note de qualité des structures |
| Apport décisionnel | distinguer l'**origine** des dégradations : **structurelle** ou **de surface seulement** |
| Antériorité | 85 000 km du réseau national français, 1965-1967 ; à l'étranger depuis 1974, « essentiellement en Afrique et en Asie » |

**Et une variante qui compte beaucoup pour la Guinée** : **Vizirette** (ou *Viziret*), pour les
**routes non revêtues** — Autret et Brousse, *BLPC* n° 213, janvier-février 1998. Le réseau
guinéen étant « en grande majorité non revêtu » (§ A.2 du mandat : ≈ 2 780 km revêtus sur
7 576 km de nationales, soit 37 %), **Vizirette est au moins aussi pertinente que VIZIR**, et le
§ A.6.1 ne la mentionne pas.

**Ce que je n'ai pas pu vérifier** : la formule exacte de `Is`, son échelle et ses classes. Une
source secondaire indique une échelle de notes où « 5, 6 et 7 correspondent à un état de surface
fortement dégradé », ce qui suggère une échelle **1 à 7 croissante avec la dégradation** —
**l'inverse du sens du RCI**, où 100 est le meilleur état. À confirmer sur le texte original
avant toute conversion.

---

## 4. La directive n° 11 de l'UEMOA, ce qui est établi

**Source** : Directive n° 11/2009/CM/UEMOA du 25 septembre 2009, portant harmonisation des
stratégies d'entretien routier dans les États membres ; et P. Lepert (Logiroad), « L'UEMOA
engage une politique routière concertée et harmonisée », *RGRA* n° 971, mars 2020.

| Élément | Contenu vérifié |
|---|---|
| Nombre d'indices | **neuf indices de dégradation** |
| Périmètre | chaussées **à structure hydrocarbonée** ; les chaussées béton « pourront être produites par la suite » |
| **Exclusion explicite** | « La directive de l'UEMOA **ne concerne pas les routes non revêtues** » |
| Familles couvertes | « les trois familles habituelles » |
| Mode de calcul | **un indice par dégradation**, en **croisant extension et gravité** par une matrice définie dans la directive |
| Sectionnement | notes d'état **par tronçon de longueur fixe**, paramétrable, « généralement **100 ou 200 mètres** » |
| Remontée | valeurs annuelles des indices des États vers le **SIR communautaire** |
| Écart avec VIZIR | sur les routes revêtues, « une méthode qui **n'est que légèrement différente** » |

**Ce que je n'ai pas pu lire** : la liste nominative des neuf indices et leurs matrices
extension × gravité. L'article de référence les présente en **tableaux sous forme d'images**, et
le texte de la directive demande à être obtenu auprès de la Commission de l'UEMOA ou de l'ONR.
**Je ne les invente pas** (§ A.5.11).

**Le sectionnement est l'écart le plus structurant pour nous.** La directive note l'état par
**sections de longueur fixe** de 100 ou 200 m. Le modèle BDRI, lui, repose sur des **portions
homogènes** de longueur variable, délimitées par le changement de caractéristiques. Les deux
sont défendables, mais ils ne s'agrègent pas sans règle de conversion — et le § 15 du mandat
parle justement de « sections fixes **dérivées** », ce qui est la bonne direction : la portion
homogène fait foi, la section fixe est un produit de restitution.

---

## 5. L'écosystème L²R, et pourquoi il relie tout

L'UEMOA a équipé ses huit États membres de la chaîne **L²R** (Logiroad), financée par le
10ᵉ FED : `L2R Mesure` (relevé visuel sur tablette Android, un bouton par couple
dégradation × gravité, position GPS), `L2R Base` (base de données routière), `L2R Programme`
(calcul des notes d'état par section fixe et préprogrammes pluriannuels), `L2R Uni` / UniBox
(laser et accéléromètre → **IRI**).

Le § B.1 du mandat V10 cite « l'écosystème **L²R / Logiroad** » autour de la BDR nationale. **Si
l'ONR emploie bien L²R, alors la question « quelle méthode » et la question « comment alimenter
la BDR » sont la même question**, et la réponse est : produire les indices de la directive n° 11.

**À vérifier auprès de l'ONR**, et c'est le point à mettre au questionnaire : quelle version de
L²R, quelle nomenclature de dégradations, quel sectionnement, quel format d'échange, et quels
indices sont effectivement calculés aujourd'hui.

**Observation importante sur `L2R Mesure`** : un bouton par couple dégradation × gravité, sur
tablette, position GPS automatique. C'est **exactement l'écran de roulage** décrit au § 7.13 du
mandat — six à neuf gros boutons, appui simple ou double pour la gravité. La convergence n'est
pas fortuite : c'est la forme que prend un relevé en véhicule. Notre écran devrait donc pouvoir
**exporter au format attendu par la directive**, ce qui est un argument de conception, pas
seulement d'interopérabilité.

---

## 6. Matrice de correspondance

Composante par composante, ce que chaque méthode en dit.

| Composante `rci-2026.1` | Poids | VIZIR | Directive n° 11 | Verdict |
|---|---|---|---|---|
| **CHAUSSEE** | 30 % | **oui** : `Is`, type × gravité × étendue | **oui** : neuf indices | **correspondance possible**, voir § 7 |
| DRAINAGE | 15 % | non | non | sans équivalent |
| OUVRAGES | 15 % | non | non | sans équivalent |
| SIGNALISATION | 10 % | non | non | sans équivalent |
| SECURITE | 10 % | non | non | sans équivalent |
| TRAFIC | 10 % | — (entrée, pas composante) | — (entrée) | **confusion de nature**, voir § 7 |
| HISTORIQUE | 5 % | non | non | sans équivalent |
| INCIDENTS | 5 % | non | non | sans équivalent |
| *(absent du RCI)* | — | **déflexion / portance** | — | **manque au RCI**, et aucune donnée |
| *(absent du RCI)* | — | — | **IRI** (par UniBox) | **manque au RCI** ; T-01 l'anticipe |

**Seuls 30 % du RCI ont un correspondant.** Les 70 % restants décrivent un actif routier au sens
de la gestion patrimoniale (ISO 55000), pas une chaussée.

---

## 7. Les quatre écarts qui demandent une décision

### É-1 — Le RCI n'est pas un indice de chaussée, et son nom le laisse croire

« Indice de Condition Routière » appliqué à un tronçon où la chaussée pèse 30 % se lira comme un
état de chaussée par quiconque vient du métier. Dans un rapport bailleur, un « RCI de 65 »
comparé à une « note VIZIR » comparerait deux choses différentes.

**Options** : renommer le RCI en indice **patrimonial** et produire **à côté** un indice de
chaussée aligné sur la directive ; ou restreindre le RCI à la chaussée et déplacer les sept
autres composantes vers un indice de risque distinct.

**Recommandation** : la première. Le § 7.7 du mandat demande déjà un indice d'état **et** un
indice de risque/criticité séparés — les sept composantes non-chaussée relèvent largement du
second.

### É-2 — Le trafic est une sollicitation, pas un état

`rci-2026.1` pondère `TRAFIC` à 10 % **comme une composante d'état**. Or ni VIZIR ni la
directive ne traitent le trafic comme un état : c'est une **entrée** du modèle de dégradation et
de priorisation. Une route très circulée n'est pas en plus mauvais état de ce seul fait.

Et la conséquence pratique est déjà visible : aucun tronçon ne porte de donnée de trafic, donc
cette composante est systématiquement exclue et son poids redistribué. **Le modèle fonctionne
aujourd'hui comme un modèle à sept composantes sur 90 points**, ce que personne n'a décidé.

**Recommandation** : sortir `TRAFIC` de l'indice d'état et l'employer là où il appartient — la
priorisation et les matrices de dégradation, qui le portent déjà comme `classeTrafic`.

### É-3 — Le sens de l'échelle est inversé

Le RCI va de 0 à 100, **100 étant le meilleur état** (`sensCroissant: true`). L'échelle de
VIZIR semble croître avec la dégradation. Toute conversion doit donc inverser, et une inversion
implicite est la faute la plus facile à commettre et la plus difficile à voir.

**Recommandation** : si une correspondance est publiée, elle doit l'être sous forme de **table
explicite** classe par classe, jamais de formule, et la table doit porter le sens de chaque
échelle dans son en-tête.

### É-4 — Portions homogènes contre sections fixes

Voir § 4. **Recommandation** : la portion homogène reste la donnée de référence ; les sections
fixes de 100 ou 200 m sont **dérivées** pour la restitution à la BDR, avec la règle d'agrégation
écrite et testée.

---

## 8. Impacts chiffrés, mesurés

| Fait mesuré le 14/10/2026 | Valeur |
|---|---|
| Scores produits sous `rci-2026.1` | **0** |
| Tronçons du réseau classé | 1 691 |
| Dont portant un état de chaussée déclaré | **649**, soit 38,4 % |
| Dont portant un état **réellement observé** | **1** (`RES-857`) |
| `dateDerniereEvaluation` renseignée | **0 sur 261 387** |
| Couverture maximale atteignable du RCI | **0,45**, pour un seuil arrêté à 0,50 |
| Mesures de déflexion | **aucune** |
| Mesures d'IRI | **aucune** |

**Aucune des trois méthodes n'est calculable aujourd'hui.** Le RCI refuse par couverture
insuffisante ; VIZIR exige une déflexion qui n'existe pas ; la directive exige un relevé de
dégradations par extension et gravité que personne n'a fait.

**Le verrou est donc la collecte, pas la méthode.** C'est la raison la plus solide pour ne pas se
presser d'approuver : une méthode arrêtée aujourd'hui serait arrêtée sans aucune donnée pour
l'éprouver.

---

## 9. Ce qu'il reste à obtenir

| # | À obtenir | Auprès de | Pourquoi |
|---|---|---|---|
| 1 | Texte de la **directive n° 11/2009/CM/UEMOA** avec ses neuf indices et leurs matrices | Commission UEMOA ou ONR | je n'ai lu que des tableaux en images |
| 2 | **VIZIR** : formule de `Is`, échelle, classes, seuils | université Gustave Eiffel (ex-LCPC/Ifsttar) | nécessaire à toute table de correspondance |
| 3 | **Vizirette / Viziret** (*BLPC* n° 213, 1998) | idem | le réseau guinéen est majoritairement non revêtu, et la directive ne le couvre pas |
| 4 | Ce que l'**ONR calcule réellement** : version de L²R, nomenclature, sectionnement, indices | ONR | détermine si « méthode » et « alimentation de la BDR » sont une seule question |
| 5 | Existence d'une **note d'état structurel** propre à la Guinée | ONR / MIT | le § A.6.1 la cite ; je n'en ai trouvé aucune trace publique |

Le § A.5.12 interdit tout accès à un système tiers sans autorisation écrite : ces cinq points
sont des **demandes à formuler**, pas des recherches que je peux mener seul.

---

## 10. Fiche d'approbation

**Rien à signer aujourd'hui.** Cette fiche existe pour que l'approbation, quand elle viendra,
porte sur des éléments nommés.

| Élément | À arrêter | Statut |
|---|---|---|
| Nom et périmètre de l'indice | indice patrimonial ou indice de chaussée (É-1) | **à décider** |
| Composantes et pondérations | huit actuelles, ou sept après sortie du trafic (É-2) | **à décider** |
| Correspondance état → score | BON 90, MOYEN 65, MAUVAIS 35, CRITIQUE 10 | arrêtée le 13/10, **conservée** |
| Six classes, bornes inclusives | 0-19 … 90-100 | arrêtée le 13/10, **conservée** |
| Seuil de couverture | 0,50 | arrêté le 13/10, **conservé** |
| Fraîcheur | 365 jours | arrêtée le 14/10, **à reconfirmer** |
| Confiances acceptées | `HIGH`, `MEDIUM` | arrêtées le 14/10, **à reconfirmer** |
| Table de correspondance vers la directive | — | **impossible** sans le point 1 du § 9 |
| Alignement UEMOA | choix de comparabilité, non obligation (§ 2) | **à décider** |
| Approbateur | autorité compétente, à désigner (§ A.6.6) | **à désigner** |

**Le mécanisme est prêt et ne demande aucun développement pour accueillir ces décisions** :
pondérations, correspondance, classes, seuils, fraîcheur et confiances vivent en base dans
`regles_condition`, sous un interrupteur d'approbation audité. Changer une pondération est une
écriture de données, pas une livraison de code. C'est ce qui permet d'attendre sans rien bloquer.

---

## 11. Ce que ce document n'établit pas

Il ne contient aucune valeur de VIZIR ni de la directive que je n'aie pu vérifier, et aucune
table de correspondance numérique — elle demanderait les deux textes originaux.

Les descriptions de VIZIR et de la directive s'appuient sur une notice bibliographique (TRID,
IFSTTAR) et un article de revue professionnelle rédigé par l'éditeur des outils L²R. Ce sont des
sources sérieuses mais **secondaires** : elles ne remplacent pas les textes, et un article écrit
par un fournisseur mérite d'être lu en gardant cela en tête.

Enfin, il ne dit rien des méthodes réellement appliquées par l'ONR aujourd'hui, faute d'accès.
