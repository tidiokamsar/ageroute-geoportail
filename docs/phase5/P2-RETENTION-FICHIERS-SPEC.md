# Rétention des fichiers téléversés (photos, documents) — spécification de décision

**Ticket** : P2-05
**Date** : 2 septembre 2026
**Nature** : proposition. La décision appartient à AGEROUTE — aucune purge n'est codée ni exécutée.

---

## 1. L'état actuel, mesuré

| Fait | Conséquence |
|---|---|
| Les fichiers photo/document ne sont **jamais supprimés du disque** | tout téléversement s'accumule indéfiniment |
| Depuis P1, photos d'OT et décomptes sont retirés **logiquement** : le fichier reste, la référence disparaît des listes | des fichiers « orphelins » apparaissent progressivement |
| Le volume de sauvegarde inclut ces fichiers (`uploads_*.tar.gz.enc`) | chaque sauvegarde quotidienne grandit sans borne |
| Aucune trace de quelle quantité est réellement référencée | impossible de décider rationnellement sans mesurer |

## 2. Le principe proposé

Le patrimoine routier est une donnée d'archive, mais **l'archive a un coût et une
durée de vie opposable**. La proposition distingue trois statuts de fichier :

```text
REFERENCED   cité par au moins un objet actif      → conservé
ORPHELIN     plus cité nulle part (retrait logique) → conservé X mois, puis purge sur décision
JAMAIS_CITE  téléversé puis jamais associé          → purge après Y jours (défaut : 30)
```

## 3. Spécification minimale

1. **Mesure d'abord** (script en lecture seule, sans `--apply` — même règle que
   tous les scripts du dépôt) : volumétrie référencée / orpheline / jamais
   citée, par année de téléversement. Aucune décision sans ces chiffres.
2. **Purge seulement sur `--apply` explicite**, jamais automatique, exécutée
   par un ADMIN, **audité** (liste des fichiers purgés dans `audit_logs`), et
   précédée d'une sauvegarde complète vérifiée.
3. **Périodes de grâce proposées** : orphelins 12 mois (le retrait logique est
   réversible pendant ce délai — la restauration de l'objet restaure sa photo) ;
   jamais cités 30 jours. **À arbitrer par AGEROUTE.**
4. **Exclusions absolues** : tout fichier lié à un décompte (donnée financière),
   à une inspection (donnée terrain), ou cité par un audit_logs encore dans la
   période légale de conservation.
5. La purge est **physiquement irréversible** : c'est la seule opération du
   dépôt qui sortirait du régime « suppression logique uniquement » — d'où le
   double verrou (mesure/apply + décision humaine).

## 4. Décisions attendues

| # | Décision | Proposition par défaut |
|---|---|---|
| R1 | Période de grâce des orphelins | 12 mois |
| R2 | Délai des jamais cités | 30 jours |
| R3 | Qui peut exécuter une purge | ADMIN, avec co-validation écrite DT |
| R4 | Conservation légale des photos d'inspection/décompte | à dire (juridique/bailleurs) |

**Statut** : l'état des lieux est MESURÉ ; les périodes et le régime de purge
sont une PROPOSITION ; R1–R4 sont REQUIRES_BUSINESS_VALIDATION.
