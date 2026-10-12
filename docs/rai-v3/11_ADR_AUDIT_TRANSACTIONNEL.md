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
