# Synthèse pour arbitrage : sept décisions qui conditionnent la suite

Établie le 22/10/2026. Ce document ne tranche rien. Il met en regard, pour chaque décision restée
ouverte, la question posée, les options, leurs impacts, **ma recommandation technique** (qui n'est
pas une décision de l'AGEROUTE) et la décision précise attendue. Le détail, les mesures et les
sources restent dans [DECISIONS_PENDING.md](../../DECISIONS_PENDING.md) et dans
[RCI_METHOD_DECISION.md](../../RCI_METHOD_DECISION.md) ; en cas de divergence, ces deux fichiers
font foi et celui-ci doit être corrigé.

**Origine des options.** Celles de D-10 et de D-11 sont reprises de `DECISIONS_PENDING.md` ; A et B de D-01
viennent de `RCI_METHOD_DECISION.md` (É-1). Toutes les autres (C de D-01, A et B de D-02, A à C de D-06,
A à C de D-07, A à C de D-09) sont **formulées ici par moi** à partir des constats de ces dossiers :
elles n'ont été soumises à personne à l'AGEROUTE et peuvent être corrigées ou complétées.

**Mise à jour du 23/10/2026.** Le DSI a délégué le choix des options ; la conduite retenue est dans
[DECISIONS-PRISES-SUR-DELEGATION.md](DECISIONS-PRISES-SUR-DELEGATION.md). Elle ne vaut pas approbation officielle.

Règle appliquée partout (V10, § A.5.11) : tant qu'une valeur n'est pas approuvée par l'autorité
compétente, elle reste **provisoire et étiquetée**. Rien de ce qui suit n'a été décidé à la place
de l'AGEROUTE.

| Décision | Sujet | Bloque aujourd'hui | Qui décide |
|---|---|---|---|
| D-01 | RCI : nom, composantes, méthode | publication d'un indice d'état | AGEROUTE, avis ONR |
| D-02 | Praticabilité P1 à P4 | praticabilité opposable (T-07) | AGEROUTE (exploitation) |
| D-06 | Nomenclature des classes | codification nationale, couverture du réseau | AGEROUTE, ONR (décret D/2017/331) |
| D-07 | Barèmes de coût : millésime, largeur | estimation de coûts opposable, programmation PPE/PAE | AGEROUTE, ONR pour les prix unitaires |
| D-09 | ERP et fournisseur d'identité | fédération des comptes | AGEROUTE / DSI |
| D-10 | Chaîne de migrations non rejouable | environnement neuf par `migrate deploy` | DSI, avec autorisation de production |
| D-11 | Validation du patrimoine existant | contrôle territorial d'écriture (5 domaines sur 8) | AGEROUTE |

---

## D-01 RCI : que mesure l'indice, et sur quelle méthode

**Situation.** La règle `rci-2026.1` est désapprouvée depuis le 14/10/2026 (D-00). Aucun score n'a
jamais été publié (`evaluations_condition` : 0 ligne). Aucune des trois méthodes (RCI, VIZIR,
directive UEMOA) n'est calculable aujourd'hui : la couverture maximale atteignable du RCI est de
0,45 pour un seuil de 0,50, VIZIR exige une déflexion qui n'existe pas, la directive exige un relevé
de dégradations que personne n'a fait. Le verrou est la collecte, pas la méthode.

| Option | Effet | Impact |
|---|---|---|
| A. Renommer le RCI en indice **patrimonial** et produire à côté un indice de chaussée aligné sur la directive | deux indices lisibles, chacun avec son périmètre | un second moteur à écrire ; la table de correspondance exige les documents du § 9 de `RCI_METHOD_DECISION.md` |
| B. Restreindre le RCI à la chaussée, déplacer les sept autres composantes vers un indice de risque distinct | cohérent avec le § 7.7 du mandat (indice d'état **et** indice de risque) | refonte des pondérations ; le poids de la chaussée passe de 30 % à 100 % |
| C. Ne publier aucun indice agrégé pour l'instant, seulement les composantes observées | aucun risque de mauvaise lecture | aucun chiffre pour un bailleur ou le FER avant la campagne de collecte |

**Recommandation technique.** A à terme (c'est aussi la recommandation de `RCI_METHOD_DECISION.md`,
É-1), C en attendant, et sortir `TRAFIC` de l'indice d'état (É-2) : c'est une sollicitation, et
comme aucun tronçon ne porte de trafic, le modèle tourne déjà de fait à sept composantes. Les
pondérations vivent en base : changer l'une d'elles est une écriture de données, pas une livraison.

**Décision attendue.** Une fiche signée (modèle : § 10 de `RCI_METHOD_DECISION.md`) arrêtant le nom
et le périmètre de l'indice, ses composantes, et désignant l'approbateur. Préalable côté AGEROUTE :
formuler les cinq demandes du § 9 (directive n° 11, formule de VIZIR, Vizirette, ce que l'ONR
calcule, note d'état structurel guinéenne). Je ne peux pas les mener seul (§ A.5.12).

---

## D-02 Praticabilité : critères d'attribution et tonnage

**Situation.** Les quatre niveaux du § 7.17 (P1 circulation normale, P2 délicate, P3 difficile,
P4 impraticable) sont semés comme **provisoires et non approuvés** (migration
`20261015000000_praticabilite_p1_p4_provisoire`). Le modèle porte cause, date, durée estimée,
tonnage maximal. Il manque tout ce qui rend un niveau opposable.

| Option | Effet | Impact |
|---|---|---|
| A. Approuver les quatre niveaux tels que proposés et fixer les critères | un langage commun sur le terrain (EX-02) | exige les quatre réponses ci-dessous |
| B. Maintenir le provisoire | l'écran et la propagation (carte, alertes, déviations, Info Route) restent éprouvables | aucune restriction n'engage personne ; un P4 provisoire n'a pas valeur de coupure |

**Recommandation technique.** B maintenant. Passer à A seulement quand les quatre points sont
arrêtés, parce qu'un niveau sans critère fait diverger deux agents sur la même piste.

**Décision attendue.** (1) Critères de passage P2 vers P3 vers P4. (2) Le tonnage de P3. (3) Le rôle
autorisé à attribuer et à lever un P4 (c'est un acte d'exploitation, pas une observation). (4) La
durée de validité avant expiration automatique. Format : une fiche de l'exploitation, signée.

---

## D-06 Nomenclature des classes de routes

**Situation (mesures du 14/10).** Routes nationales : concordance (+3,3 %). Préfectorales : -16,3 %.
**Communautaires : la valeur n'existe pas dans le modèle** (19 846 km annoncés, nulle part où les
enregistrer). Urbaines : 36,6 km contre ≈ 2 000. Le réseau saisi représente 48 % du réseau annoncé.

| Option | Effet | Impact |
|---|---|---|
| A. Aligner l'énumération sur le décret D/2017/331 (ajouter `RC`, décider du sort de `RR`) | nomenclature officielle dans le modèle | `ALTER TYPE ADD VALUE` **irréversible** ; migration de données sur 1 029 tronçons ; figerait une nomenclature inventée si le classement officiel n'est pas encore connu |
| B. Garder l'énumération et ajouter une **table de correspondance** vers la nomenclature officielle | aucun geste irréversible, rapprochement possible dès le classement | une couche de plus à maintenir ; les 19 846 km restent sans lieu d'enregistrement |
| C. B maintenant, A quand le classement officiel est reçu | évite d'inventer, ne bloque pas la saisie | deux étapes |

**Recommandation technique.** C. Le tableau de bord doit déjà dire « réseau classé saisi » et non
« réseau national » (§ 7.12), ce qui ne dépend pas de la décision.

**Décision attendue.** Le classement officiel (par l'ONR ou le texte d'application du décret) et
l'accord de l'AGEROUTE sur le sort de `RR` (devient-il `RP` ?). Sans ce classement, aucune des deux
migrations ne doit partir.

---

## D-07 Barèmes de coût : millésime et largeur de chaussée

**Situation.** Neuf barèmes de 350 millions à 3,5 milliards de GNF au kilomètre, conservés comme
valeurs par défaut sur instruction du 14/10, jamais approuvés (`source = standard_initial`). Personne
ne sait pour quelle année ni quelle largeur ils ont été posés. Le moteur de coût **refuse** d'estimer
ce qu'aucune ligne ne couvre (béton, `AUTRE`, `NON_RENSEIGNE`). Les routes `/api/v2/baremes` et
l'écran d'administration permettent de saisir millésime, largeur et approbation sans toucher un coût
par défaut.

| Option | Effet | Impact |
|---|---|---|
| A. L'AGEROUTE fournit millésime, largeur et approbation pour les neuf lignes | estimations opposables | décision de fond, avec l'ONR comme dépositaire des prix unitaires |
| B. Remplacer les neuf lignes par une grille ONR (prix unitaires par largeur) | barème de référence nationale | dépend d'un document que je n'ai pas |
| C. Maintenir en l'état, estimations affichées « provisoires » | rien ne bloque | aucun chiffre ne peut aller dans un rapport bailleur ou un PPE/PAE opposable |

**Recommandation technique.** C maintenant, A pour les lignes dont l'origine est établie, B si l'ONR
publie une grille. Ne jamais suppléer une largeur par défaut : un prix assorti d'une largeur inventée
est plus dangereux qu'un prix sans largeur, parce qu'il a l'air complet.

**Décision attendue.** Par ligne : année de référence, largeur supposée, approbation (qui, quand).
Et la décision de traiter ou non le béton de ciment (aujourd'hui non estimé).

---

## D-09 ERP et fournisseur d'identité de référence

**Situation (mesurée le 14/10).** Aucune fédération n'existe (ni OIDC, ni SAML dans le code).
L'authentification est locale : JWT d'accès de 15 minutes, rafraîchissement rotatif révocable de 7
jours, Argon2id, 799 jetons actifs. L'arbitrage D4 dit « comptes ERP = référence, fédération OIDC,
aucun second annuaire » sans nommer l'ERP ni l'IdP.

| Option | Effet | Impact |
|---|---|---|
| A. Conserver l'authentification locale jusqu'à ce que l'IdP soit nommé | rien ne change | deux annuaires à terme, ce que D4 veut éviter |
| B. Rattachement : chaque compte local se lie à une identité fédérée et garde son historique | bascule sans perte d'audit | exige l'IdP, un accès autorisé par écrit, une interface approuvée |
| C. Recréer les comptes depuis l'ERP | annuaire unique immédiat | casse les 1 506 lignes d'`audit_logs` qui citent les comptes ; contraire au § A.5.8 |

**Recommandation technique.** A maintenant, B dès que l'IdP est nommé. C est à écarter.

**Décision attendue.** Nom de l'ERP, nom de l'IdP, protocole (OIDC ou SAML), et l'autorisation écrite
d'un échange de test. Tant que ces trois points manquent, je n'écris aucun connecteur (aucune
interface inventée).

---

## D-10 Chaîne de migrations : que corriger, et quand

**Situation.** Sur une base vierge, la migration `20260702110000_marches_bailleurs_avancement`
échoue (le type de `marches.id` diffère de celui que la production possède). Mesure du 22/10 : avec
un seul pont de conversion, les 69 migrations s'appliquent de bout en bout, donc le défaut est
localisé sur `marches`. Rien n'a été corrigé dans l'historique.

| Option | Effet | Impact |
|---|---|---|
| A. Corriger le fichier et réparer l'empreinte en production | chaîne rejouable | **écriture dans `_prisma_migrations` en production** : interdite sans autorisation |
| B. Acter que la reconstruction passe par `pg_dump` | aucun risque | reprise après sinistre dépendante des sauvegardes seules |
| C. Migration de référence (squash) | chaîne propre | contredit le § A.5.2 (marquer artificiellement appliqué) ; à écarter |

**Recommandation technique.** B maintenant, A au prochain déploiement déjà autorisé (même si le banc
des descentes est désormais en place).

**Décision attendue.** Le choix A, B ou C par la DSI, et, pour A, l'autorisation d'écriture en
production datée et limitée à ce geste.

---

## D-11 Valider le patrimoine existant

**Situation.** `statutValidation` est nul sur toutes les fiches de tronçons, ouvrages, points noirs
et postes : rien ne les fait passer à `A_VALIDER`. Les comptes ne portent **aucune région**, donc
aucune restriction territoriale d'écriture n'est possible sans donnée d'organisation.

| Option | Effet | Impact |
|---|---|---|
| A. Toute modification par la console passe à `A_VALIDER` | contrôle à deux personnes | la carte filtre sur ce statut : un tronçon modifié disparaîtrait de la carte (régression visible) |
| B. Les modifications deviennent des propositions | modèle de fond, conforme au § 7.5 | plusieurs lots, refonte des écrans de saisie |
| C. Soumission explicite par un gestionnaire | effet immédiat, sans régression | à définir : valide-t-on la géométrie, les attributs, ou les deux ? |

**Recommandation technique.** B à terme, C en attendant ; A à écarter tant que la carte filtre sur
le statut.

**Décision attendue.** Le choix, et, si une restriction d'écriture par région est voulue, la **liste
des comptes avec leur périmètre** (donnée d'organisation à fournir par l'AGEROUTE).

---

## Ce qui reste exécutable sans aucune de ces décisions

Persistance de la topologie du réseau, mesures d'accessibilité et de performance, descentes de
migration, métadonnées ISO 19115, durcissement et tests. Les lots qui exigent l'une des sept
décisions sont signalés `BLOCKED` dans `AUTONOMOUS_EXECUTION_TRACKER.md`.
