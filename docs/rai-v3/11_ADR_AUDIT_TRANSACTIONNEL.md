# ADR proposé pour les écritures auditables

Date : 12/10/2026  
Statut architectural : proposé ; approbation ARB non documentée.  
État du code : appliqué localement aux principales écritures RAI du lot terrain.

## Contexte

`AGENTS.md` exige une ligne dans `audit_logs` pour chaque écriture. Le helper historique
`logAudit` intercepte les erreurs et permet à la requête métier de réussir même si
l'audit échoue. Pour une validation, un arbitrage de synchronisation ou une modification
du catalogue, cela peut laisser l'état métier modifié sans trace durable.

## Options examinées

1. **Conserver le helper historique.** Cela évite de changer le comportement général,
   mais une panne de journalisation peut laisser une écriture critique sans trace.
2. **Faire échouer `logAudit` globalement.** La requête peut signaler l'échec, mais les
   écritures déjà commitées ne sont pas annulées ; les anciens appels doivent aussi
   être vérifiés pour leur compatibilité.
3. **Écrire l'audit dans la transaction métier.** Une fonction reçoit le client de
   transaction, écrit dans `audit_logs` et laisse l'erreur remonter. La mutation métier
   et son audit réussissent ou sont annulés ensemble.

## Décision proposée

Adopter l'option 3 pour les écritures RAI critiques. La fonction
`logAuditTransactionnelle(tx, params)` est additive ; le helper historique reste en
place pour les modules existants jusqu'à leur migration explicite.

## Conséquences

- L'échec de création de l'audit annule les mutations couvertes par la même transaction.
- Les mutations et événements concernés restent atomiques, y compris les décisions de
  validation, les conflits de synchronisation, les transitions d'état et les changements
  du catalogue.
- La couverture n'inclut pas encore tous les anciens appels à `logAudit`; cette dette
  doit être suivie avant d'affirmer une garantie globale.
- Les tests locaux vérifient les transactions simulées. La base réelle et le déploiement
  ne sont pas vérifiés.

## État détaillé de la couverture locale — 12/10/2026

| Chemin d'écriture | État local observé |
|---|---|
| Décisions/états des défauts, catalogue, synchronisation et arbitrage | audit transactionnel dans les chemins RAI concernés |
| Création/révocation d'appareils | audit dans la transaction ; plafond et révocation utilisent aussi un contrôle atomique |
| Création et transition de mission | audit dans la transaction ; la transition utilise un compare-et-échange |
| CRUD et propagation d'état des inspections | résiduel : `createCrudService` et `propagateEtat` écrivent l'audit après la mutation au moyen du helper fail-soft |
| Ajout/retrait des photos d'inspection | résiduel : `createPhotoService` modifie la liste puis appelle le helper fail-soft ; un échec d'audit ne garantit pas le rollback métier |

La règle de `AGENTS.md` porte sur toutes les écritures. Cette couverture partielle ne
permet donc pas d'affirmer une garantie globale. La prochaine tranche d'audit doit
rendre atomiques les mutations Inspection et leurs lignes d'audit, puis vérifier le
nettoyage du fichier téléversé si la transaction échoue. Les limites de quota photo et
la conservation des fichiers relèvent en plus d'une décision de capacité, documentée
dans la feuille de route.

---

## Première migration explicite — 12/10/2026

Le statut de cet ADR reste **proposé**. Rien ici ne vaut approbation : l'option 3 est
appliquée à **un module de plus**, nommément, et se retire en supprimant un mot.

### Ce qui est migré

**Inspection**, et elle seule, parmi les huit services qui partagent `createCrudService`.
Choisie parce que c'est le seul événement de la base qui produise une valeur réellement
constatée — datée, attribuée, de méthode connue — et parce qu'elle **propage** cet état au
tronçon ou à l'ouvrage inspecté. Une trace perdue y laisse un état patrimonial modifié
sans auteur ni date, sur le champ même qui classe une route pour des travaux.

| Chemin | Avant | Après |
|---|---|---|
| `createCrudService` create / update / remove / restore | audit fail-soft après la mutation | audit dans la transaction, **pour Inspection seule** |
| `createPhotoService` add / remove | liste modifiée puis helper fail-soft | audit dans la transaction, **pour Inspection seule** |
| `propagateEtat` (tronçon et ouvrage) | `update` puis `logAudit`, deux temps | une seule transaction |

Les sept autres services — chantiers, documents, marchés, ouvrages, points noirs, postes,
tronçons — restent sur le helper historique. Un test le vérifie explicitement, et c'est
le test le plus important du lot : basculer leur comportement sans arbitrage
transformerait une panne de journalisation en panne d'écriture sur tout le chemin
patrimonial.

### Une conséquence que cet ADR n'avait pas enregistrée

L'option 3 décrivait « une fonction reçoit le client de transaction ». La fabrique CRUD
utilise la **forme tableau** de `$transaction`, et ce choix est documenté : le commit
`4eb1525` a d'abord essayé la forme interactive, qui retrouvait le modèle par son nom
dérivé de l'entité. Cela compilait, fonctionnait, et court-circuitait le délégué injecté
dans la fabrique ; `crud-factory.test.ts` s'est mis à échouer parce qu'il ne voyait plus
l'appel qu'il vérifie. Le test avait raison.

`logAuditTransactionnelle` exige donc la forme interactive, inutilisable ici. D'où
`construireAudit`, qui prépare l'écriture sans l'exécuter, sur le même motif que
`construireSaisies` pour la provenance.

**Le coût était réel.** Dans un tableau, les écritures partent ensemble : la ligne
retournée par la base n'est pas connue au moment de construire la trace. Le champ `after`
ne pouvait donc pas être la ligne stockée — seulement un état **projeté**, reconstruit
depuis l'état lu et la modification appliquée, sans les colonnes calculées par la base.

### Arbitrage rendu le 13/10/2026 : la fidélité

**Décision : `after` doit être la ligne telle que la base l'a rendue.** Un journal dont le
contenu diffère de l'état réel est un journal dont il faut se méfier, et s'en méfier coûte
plus cher que l'atomicité ne rapporte.

La forme **interactive** est donc utilisée par les modules migrés, et le piège de `4eb1525`
est évité autrement : le délégué n'est plus retrouvé par un nom dérivé de l'entité, il est
**désigné par l'appelant** (`delegueTransactionnel: (tx) => tx.inspection`). Aucun nom
n'est deviné, le délégué injecté reste celui que l'appelant indique, et un test vérifie
qu'on passe bien par lui. Une fabrique configurée avec `auditTransactionnel` sans délégué
**lève au montage du module**, pas à la première écriture.

Deux pièges découverts en l'implémentant :

**La provenance devait suivre.** `construireSaisies` écrivait sur le client de base. En
forme interactive, ces écritures cessaient donc silencieusement de faire partie de la
transaction, alors qu'elles y étaient. Elle accepte désormais un client. Le défaut n'aurait
rien cassé aujourd'hui — `CHAMPS_SUIVIS` ne couvre que Tronçon, Ouvrage et Chantier, et
Inspection n'en fait pas partie — mais il aurait mordu à la migration suivante, celle où
personne n'y aurait repensé. Un test l'éprouve donc sur une entité réellement suivie.

**`createPhotoService` et `propagateEtat` restent en forme tableau**, délibérément : leur
`after` est un résumé choisi (`{ filename }`, `{ etat, source }`) et non une ligne de base.
Il n'y a aucune fidélité à y restaurer.

### Ce que les tests prouvent, et ce qu'ils ne prouvent pas

18 tests ajoutés. Ils vérifient que l'écriture d'audit est bien **placée dans** le tableau
passé à `$transaction`, qu'un échec d'audit fait désormais échouer l'appel au lieu d'être
avalé, et que sans l'option **rien n'a changé**.

Ils ne prouvent pas que PostgreSQL annule la mutation : `$transaction` est simulé par
`Promise.all`, donc la mutation du faux modèle a déjà eu lieu quand l'audit échoue. Le
rollback est une propriété de la base, pas du code. La limite était déjà énoncée plus
haut ; elle reste entière.

Deux mocks ont dû être corrigés parce qu'ils étaient infidèles, et dans les deux cas le
mock avait tort, pas le code : l'un rendait la ligne vivante au lieu d'une copie, si bien
que `before` aliasait la ligne que `update` modifiait ensuite ; l'autre ne fournissait pas
le constructeur d'audit que la fabrique importe désormais.

### Les deux points restants, fermés le 13/10/2026

**La ligne de qualité rejoint la transaction.** `construireQualite` prépare l'écriture sans
l'exécuter, comme `construireSaisies` et `construireAudit`, et la propagation ouvre
désormais **une seule** transaction de trois écritures : l'état, sa trace et sa provenance.
`enregistrerQualite` passe par le même constructeur, pour qu'il n'existe qu'une définition
de la forme de cette écriture.

Un défaut est apparu en restructurant, et il ne se voyait pas : **la ligne de qualité
s'écrivait hors des gardes `if (before)`**. Quand la cible était introuvable, aucun état
n'était propagé et une ligne de qualité était pourtant écrite, affirmant une provenance de
relevé terrain pour une valeur jamais posée. Regrouper les trois écritures sous une seule
garde ferme le cas par construction plutôt que par vigilance. Un test le défend.

**Le fichier téléversé est nettoyé sur tout échec d'enregistrement.** Les trois
gestionnaires de photos — inspections, ouvrages, ordres de travaux — appelaient leur
service et laissaient toute erreur partir à `next(err)` : le fichier restait sur le disque
sans ligne en base pour le référencer. Le cas le plus courant était banal, un identifiant
inconnu rendant 404 après l'écriture des octets ; ouvrages et ordres de travaux n'avaient
aucun nettoyage du tout.

**Cette migration rendait le défaut plus probable** : depuis que l'audit des photos
d'inspection rejoint la transaction, une panne de journalisation fait lever là où l'erreur
était avalée. Un chemin d'erreur rare devient un chemin normal, et c'est exactement ce que
cet ADR demandait de vérifier avant d'étendre la migration.

Le nettoyage est porté par `supprimerTeleversementNonEnregistre`, partagée par les trois,
et commandée par un **drapeau** et non par le simple `catch` : nettoyer dans tout `catch`
supprimerait un fichier **déjà référencé** si l'écriture a réussi et que seule la réponse a
échoué. La photo existerait alors dans la liste et plus sur le disque, ce qui est pire que
l'orphelin corrigé. Un test défend cette distinction.

## Tronçon et Ouvrage migrés — 13/10/2026

Les deux services qui ont une provenance suivie, donc les premiers à éprouver réellement le
mécanisme : `CHAMPS_SUIVIS` couvre huit champs de Tronçon et quatre d'Ouvrage, si bien que
chaque écriture entraîne des lignes de provenance qui doivent rejoindre la transaction.
Inspection, migrée avant eux, n'a aucun champ suivi et ne testait pas ce point.

Les photos d'Ouvrage passent aussi à l'audit transactionnel.

**Restent sur le helper historique** : chantiers, documents, marchés, points noirs et
postes. Cinq, et non plus sept.

### Un trou plus grave trouvé en migrant : la géométrie

`updateGeomOnly` écrivait le tracé d'un tronçon et **n'auditait rien**. Le contrôleur ne
lui transmettait même pas l'identifiant de l'utilisateur, pourtant vérifié juste au-dessus.

Le tracé n'est pas un champ décoratif : il commande la carte, la longueur géométrique,
l'appariement GPS et donc le linéaire publié. Il pouvait être remplacé sans qu'on puisse
dire par qui ni quand. C'est la règle 3 d'`AGENTS.md` manquée sur le champ le plus
conséquent de la base — et cela n'avait rien à voir avec l'audit fail-soft : il n'y avait
simplement aucun audit.

L'écriture est désormais une transaction unique : lecture du résumé de l'ancien tracé,
écriture du nouveau, audit. Le résumé est lu **dans** la transaction — le lire avant de
l'ouvrir laisserait une fenêtre où une autre édition s'intercale, et l'audit comparerait à
un état qui n'a jamais précédé celui-ci.

**La géométrie elle-même n'est pas journalisée.** Un tronçon porte couramment des milliers
de points ; les recopier à chaque édition gonflerait une table qui doit rester consultable.
Le nombre de points et la longueur suffisent à repérer ce qui compte : un tracé remplacé
par un tracé plus grossier, ou amputé de dizaines de kilomètres. Sept tests le défendent,
dont celui qui vérifie que la trace reste bornée.

### Une conséquence de performance, non mesurée

`importXlsx`, pour Tronçon comme pour Ouvrage, boucle **ligne par ligne** sur `base.create`
ou `base.update`. Chaque ligne ouvrait jusqu'ici une transaction en forme tableau ; elle
ouvre maintenant une transaction interactive, soit deux allers-retours supplémentaires
(`BEGIN`, `COMMIT`) par ligne.

Ce qu'on peut affirmer sans mesure : la boucle est **séquentielle**, donc une seule
transaction est ouverte à la fois et la pression sur le pool de connexions ne change pas.
Le coût est de la latence, pas de la contention.

Ce qu'on ne peut pas affirmer : son ampleur. Le réseau de référence compte 1 691 tronçons,
donc un import complet représente de l'ordre de 1 700 transactions interactives. **À
mesurer sur la base réelle avant déploiement.** Je n'ai pas d'accès pour le faire.

Si la mesure est mauvaise, la bonne réponse n'est pas de revenir en arrière : c'est de
grouper l'import, qui n'avait de toute façon aucune raison d'écrire ligne par ligne. Et
l'atomicité est précisément la plus utile ici — un import qui écrit 1 700 lignes en perdant
quelques audits est le pire des cas.

## Les cinq derniers migrés — 13/10/2026

Chantiers, documents, marchés, points noirs et postes. **Les huit services qui partagent
`createCrudService` sont désormais migrés**, ainsi que les deux qui utilisent
`createPhotoService`.

Quatre étaient mécaniques : aucun appel d'audit hors fabrique. Marchés en avait neuf —
six dans son service, trois dans les décomptes — et a demandé un traitement cas par cas :

| Site | Forme | Pourquoi |
|---|---|---|
| `attachChantier`, `setAvancement`, `deleteBailleur`, `remove` d'un décompte | tableau | l'audit n'enregistre qu'un résumé choisi, pas une ligne de base |
| `createBailleur`, `updateBailleur`, `create` et `update` d'un décompte | interactive | `after` doit être la ligne rendue, identifiant auto-incrémenté compris |
| `detachChantier` | interactive | voir ci-dessous |

`detachChantier` convertissait l'erreur du `delete` en 404 par un `.catch()`. Englober la
transaction dans ce `catch` aurait transformé **un échec d'audit en « liaison
introuvable »**, ce qui enverrait chercher au mauvais endroit. L'existence est donc
vérifiée *dans* la transaction, et le 404 reste précis.

Les six imports dynamiques `await import("../../utils/audit")` ont disparu : ils n'avaient
aucune raison d'être — `utils/audit` n'importe que `lib/prisma`, il n'y avait pas de cycle
à contourner.

### Un audit financier qui échouait probablement en silence

`decomptes.service.ts` auditait `after: created`, et un décompte porte `montantGnf` en
**BigInt**. `JSON.stringify({ montantGnf: 12345n })` lève
`TypeError: Do not know how to serialize a BigInt` — vérifié, c'est un fait de langage.

`logAudit` étant fail-soft, l'échec était **avalé** : le décompte s'écrivait, sa trace non,
et seul le compteur `audit.echecsDepuisDemarrage` de `/api/health` montait. Personne ne le
regardait.

**Je n'ai pas pu confirmer que cela se produit en production** : il faudrait lire ce
compteur, et je n'ai pas d'accès. Mais la correction est juste dans les deux cas, et elle
était **nécessaire avant de migrer** : l'audit passant dans la transaction, un échec de
sérialisation ne serait plus avalé — il casserait l'écriture financière.

`normaliserPourJson` convertit les BigInt en **chaîne**, dans les trois aides d'audit. En
chaîne et non en nombre : un montant en francs guinéens peut dépasser
`Number.MAX_SAFE_INTEGER`, et le modèle le déclare en BigInt précisément pour cela.
Convertir en nombre perdrait de la précision en silence sur les gros montants, ce qu'un
journal financier ne doit pas faire. Le périmètre est volontairement étroit : seuls les
BigInt, car un nettoyage profond générique coûterait à chaque écriture et risquerait
d'abîmer ce qui marche.

**À vérifier de votre côté** : `audit.echecsDepuisDemarrage` sur `/api/health`. S'il est
non nul, c'est probablement là.

### Deux choses que cette migration laisse derrière elle

**Les branches fail-soft des deux fabriques sont devenues du code mort.** Tous leurs
appelants passent désormais l'option. Les laisser invite quelqu'un à instancier sans elle
et à retrouver le comportement avalé sans s'en apercevoir.

La conclusion logique serait de **supprimer l'option** et de rendre
`delegueTransactionnel` obligatoire : la garantie deviendrait structurelle, vérifiée par le
compilateur, au lieu de dépendre d'une configuration. Je ne l'ai pas fait, parce que cela
supprime l'échappatoire que cet ADR documente comme l'option 1, et que **cet ADR reste
proposé**. C'est une décision d'ARB, pas une conséquence mécanique.

**Dix-huit appels fail-soft subsistent, hors fabrique CRUD** :

| Service | Appels | Nature |
|---|---|---|
| `auth.service.ts` | 7 | connexion, déconnexion, jetons — événements de sécurité |
| `ordres-travaux/ot.service.ts` | 7 | ordres de travaux et leurs photos |
| `users.service.ts` | 3 | comptes |
| `admin/settings.service.ts` | 1 | paramètres |

Ils n'étaient pas dans la liste résiduelle de cet ADR, qui ne couvrait que les chemins du
lot terrain. Les événements d'authentification méritent un examen à part : une trace de
connexion perdue n'a pas les mêmes conséquences qu'une trace de patrimoine perdue, et
faire échouer une connexion parce que le journal est en panne enfermerait les utilisateurs
dehors.

### Reste à faire

Les dix-huit appels ci-dessus, en commençant par décider si l'authentification doit suivre
la même règle — ce n'est pas évident. Supprimer les branches mortes des fabriques, si l'ARB
tranche. Et mesurer l'import avant de déployer.
