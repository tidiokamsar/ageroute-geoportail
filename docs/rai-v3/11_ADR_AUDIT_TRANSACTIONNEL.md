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

**Le coût est réel et doit être connu avant d'étendre la migration.** Dans un tableau, les
écritures partent ensemble : la ligne retournée par la base n'est pas connue au moment de
construire la trace. Le champ `after` ne peut donc pas être la ligne stockée.

- En **création**, `after` vaut `{ ...data, id }` — l'identifiant étant tiré avant
  l'insertion, ce qui est déjà le cas pour la provenance.
- En **modification**, `after` vaut `{ ...before, ...data }` : l'état **projeté**,
  reconstruit depuis l'état lu et la modification appliquée. Plus lisible qu'un `after`
  réduit au delta, mais les colonnes calculées par la base — `updatedAt` notamment — n'y
  figurent pas.

Pour un journal dont l'objet est de dire **qui** a changé **quoi**, c'est acceptable. Ce
n'en est pas moins une perte de fidélité par rapport au helper historique, qui enregistrait
la ligne telle que la base l'avait rendue. **Cet arbitrage appartient à l'ARB**, et il doit
être tranché avant de migrer les sept services restants, pas après.

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

### Reste à faire

Les sept services non migrés, et l'arbitrage sur la fidélité du champ `after` qui doit le
précéder.
