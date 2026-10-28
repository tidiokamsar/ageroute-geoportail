# Décisions de conduite prises sur délégation du DSI

Établi le 23/10/2026.

**Origine.** Le DSI de l'AGEROUTE (Tidiane Diallo) m'a délégué par écrit, dans la conversation du
23/10/2026, le choix entre les options des sept décisions D-01, D-02, D-06, D-07, D-09, D-10 et D-11
(« je te laisse le choix, décide, j'ai confiance »). Les options et leurs impacts sont dans
[DECISIONS-SYNTHESE-ARBITRAGE.md](DECISIONS-SYNTHESE-ARBITRAGE.md).

**Ce que cette délégation couvre, et ce qu'elle ne couvre pas.**

- Elle couvre le **choix de la conduite du projet** : quelle option le logiciel suit en attendant.
- Elle ne couvre pas l'**approbation d'une valeur, d'un texte ou d'une nomenclature** qui relève de
  l'AGEROUTE, de l'ONR ou de l'exploitation (barèmes, critères de praticabilité, classement officiel,
  méthode de l'indice, noms de l'ERP et de l'IdP). Je n'en invente aucune (V10, § A.5.11). Là où une
  telle valeur manque, la décision retenue est de **rester provisoire et étiqueté**, et la valeur
  attendue reste attendue.
- Elle ne donne aucune autorisation d'opération en production. Les gestes interdits sans autorisation
  explicite (écriture dans `_prisma_migrations`, déploiement) restent interdits.
- Chaque décision ci-dessous est **réversible** : elle ne crée aucune donnée officielle et aucune
  migration irréversible.

**Compléments du 25/10/2026** (même délégation, voir `CRITERES-VISION.md`) : critères d'acceptation PROVISOIRES d'un modèle de vision
(précision, rappel, fausses alertes par km, latence, mémoire, batterie, taille, effectif) ; pilote **RN1 d'abord, puis Boké** ;
contrat serveur étendu pour joindre une photo à une observation.

## Les sept décisions

| Décision | Choix retenu | Pourquoi | Ce qui change dans le logiciel | Ce qui reste attendu de l'AGEROUTE |
|---|---|---|---|---|
| **D-01** RCI | **C maintenant, A à terme.** Aucun indice agrégé n'est publié. La règle `rci-2026.1` reste désapprouvée. Seules les composantes observées sont montrées. Cible : un indice patrimonial et, à côté, un indice de chaussée aligné sur la directive UEMOA ; `TRAFIC` sortira de l'indice d'état. | Aucune des trois méthodes n'est calculable (couverture maximale 0,45 pour un seuil de 0,50) : publier un chiffre serait inventer. | Rien à livrer maintenant (c'est déjà l'état : 0 ligne dans `evaluations_condition`). Le second moteur est un lot ultérieur, après réception des documents. | Fiche signée (nom, périmètre, composantes, approbateur) ; les 5 demandes du § 9 de `RCI_METHOD_DECISION.md`. |
| **D-02** Praticabilité | **B.** P1 à P4 restent **provisoires et non approuvés**. Un P4 provisoire n'a pas valeur de coupure. | Un niveau sans critère fait diverger deux agents sur la même piste. | Aucun changement. L'affichage « provisoire » est maintenu partout. | Critères de passage P2 vers P4, tonnage de P3, rôle autorisé à attribuer ou lever un P4, durée de validité. |
| **D-06** Classes de routes | **C.** Une **table de correspondance** vers la nomenclature officielle est ajoutée ; l'énumération n'est **pas** modifiée (`ALTER TYPE ADD VALUE` est irréversible). L'alignement viendra avec le classement officiel. Le tableau de bord dit « réseau classé saisi », pas « réseau national ». | Évite de figer une nomenclature inventée ; ne bloque pas la saisie. | Le libellé « réseau classé saisi » existe déjà (indicateurs du tableau de bord). La table de correspondance n'est pas écrite : elle attend le vocabulaire officiel (voir la correction du 24/10). | Le classement officiel (ONR ou texte d'application du décret D/2017/331) ; le sort de `RR`. |
| **D-07** Barèmes de coût | **C.** Les 9 lignes restent `standard_initial`, non approuvées, **estimations affichées « provisoires »**. Aucune largeur par défaut n'est jamais supposée. Le béton de ciment et les cas `AUTRE` et `NON_RENSEIGNE` restent non estimés (refus du moteur). | Un prix assorti d'une largeur inventée est plus dangereux qu'un prix sans largeur. | Aucun changement. Aucun de ces chiffres n'entre dans un rapport bailleur ou un PPE/PAE opposable. | Par ligne : année de référence, largeur, approbation ; faut-il traiter le béton ; grille ONR si elle existe. |
| **D-09** ERP et fournisseur d'identité | **A.** L'authentification locale est conservée. Le rattachement des comptes à une identité fédérée (option B) viendra quand l'IdP sera nommé. La recréation depuis l'ERP (option C) est **écartée** : elle casserait les 1 506 lignes d'audit. | Aucun connecteur ne peut s'écrire sans nom d'IdP ni accès autorisé. | Aucun changement. | Nom de l'ERP, nom de l'IdP, protocole, autorisation écrite d'un échange de test. |
| **D-10** Chaîne de migrations | **B maintenant.** La reconstruction d'un environnement passe par `pg_dump` (sauvegardes testées). L'option A (corriger le fichier et réparer l'empreinte) est **programmée pour un déploiement déjà autorisé**, pas exécutée. L'option C (squash) est **écartée**. | La correction exige une écriture dans `_prisma_migrations` en production : je ne me l'accorde pas. | La migration `20261026400000` (extension `unaccent`) ferme l'un des deux défauts de rejeu ; `marches` reste à traiter par A. | Pour A : une autorisation d'écriture en production datée et limitée à ce geste. |
| **D-11** Valider le patrimoine existant | **C maintenant, B à terme.** Une modification passe à validation par une **soumission explicite d'un gestionnaire**. L'option A est **écartée** : la carte filtre sur le statut, un tronçon modifié disparaîtrait. | Effet immédiat, sans régression visible. | Rien pour l'instant : l'action de soumission n'est pas écrite (voir la correction du 24/10). | La liste des comptes avec leur périmètre régional, si une restriction d'écriture par région est voulue ; ce qu'on valide (géométrie, attributs, les deux) ; le sort d'une fiche soumise vis-à-vis de la carte et de la programmation. |

## Ce qui est livré, ce qui ne l'est pas

Cette décision **ne change aucun code**. Les choix B de D-02, C de D-01, C de D-07 et A de D-09
décrivent l'état actuel.

**Correction du 24/10.** J'avais présenté D-06 et D-11 comme deux lots exécutables sans réponse
externe. Après lecture du code, ils ne le sont pas, et je ne les ai pas écrits :

- **D-06, table de correspondance des classes.** Elle exige un vocabulaire cible, c'est-à-dire la
  nomenclature officielle que l'on attend justement. En figer un ici deviendrait une norme (c'est
  la leçon déjà consignée dans la migration `20261026410000`). La table `correspondances_identifiants`
  existante rapproche des identifiants, pas des classes : elle ne convient pas. À écrire à la réception
  du classement.
- **D-11, soumission explicite.** Passer une fiche à `A_VALIDER` a des effets que le choix C ne
  tranche pas : le moteur de programmation n'accepte qu'un statut nul ou `VALIDE`
  (`programmation/moteur.depot.ts`), donc un tronçon soumis **sortirait de la programmation**, et
  `VALIDE` est terminal (`governance/validation.ts`). Il faut décider, avant d'écrire : ce qu'on
  soumet (géométrie, attributs, ou les deux), et si une fiche en attente reste visible sur la carte
  et dans la programmation.
- **D-01, second indice.** Attend les documents du § 9.

Ce qui reste donc exécutable sans réponse : rien de ces trois points. Les questions D-11 ci-dessus
sont ajoutées aux décisions attendues.

## Comment revenir sur un choix

Chaque ligne se révise en remplaçant l'option retenue ici par une autre, avec la date. Si l'AGEROUTE
rend une décision contraire, la sienne prévaut et ce document est corrigé le jour même.
