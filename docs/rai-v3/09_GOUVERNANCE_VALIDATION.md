# Gouvernance : observation ou import n'est pas donnée officielle

Décision du 07/10/2026, sur instruction : généraliser à tous les objets du géoportail la
règle établie pour les défauts.

## Les deux manques qui la motivent

**81 ouvrages DTOAA sont publics sans marqueur de validation.** 78 en confiance HIGH,
tous en état `NON_EVALUE`. Pour qui consulte la carte, un ouvrage relevé sur le terrain
et un ouvrage lu dans un PDF se présentent à l'identique.

**7 tronçons hors du territoire guinéen, 72 km, sont comptés dans les 21 157 km
publiés.** Leur exclusion s'écrit `sourceReference LIKE 'hors_territoire:%'`. Un préfixe
de chaîne n'est pas un statut : il ne porte ni pays, ni motif, ni date, ni validateur, et
une faute de frappe le rend muet sans que rien ne le signale.

## Deux axes, et non un

| Question | Où elle vit | Valeurs |
|---|---|---|
| Cet objet est-il officiel ? | `statutValidation` | `A_VALIDER` `VALIDE` `REJETE` `A_CORRIGER` |
| Compte-t-il dans les chiffres nationaux ? | `troncons.perimetre` | `NATIONAL` `HORS_TERRITOIRE_NATIONAL` `VOIRIE_LOCALE` |

Les confondre serait une faute. Un tronçon malien à la frontière est une donnée
parfaitement juste et hors périmètre national. Le marquer `REJETE` dirait qu'il n'existe
pas ; il existe, il n'est simplement pas guinéen. Et il doit rester dans le fond
cartographique, sans quoi la carte s'arrête net à la frontière.

Les trois réseaux que vous distinguez se lisent donc directement :

- **réseau géographique chargé** : toutes les lignes, périmètre quelconque ;
- **réseau national publié** : `perimetre` nul ou `NATIONAL` ;
- **KPI nationaux** : la même clause, et c'est la seule qui alimente un chiffre public.

## Un seul état d'attente

Votre flux DTOAA passe par « IMPORTÉS » puis « À VALIDER » ; celui des défauts par
« PROPOSÉ ». Ce sont la même position dans la chaîne : un objet qui attend la décision
d'un tiers habilité.

Garder deux noms obligerait chaque requête de l'application à écrire
`IN ('IMPORTE','PROPOSE')`, et un oubli quelque part laisserait passer pour officiel ce
qui ne l'est pas. L'origine est une information, pas un état : elle va dans
`Validation.source`.

## Un historique, pas un dernier état

`Validation` est une table polymorphe (`entityType` + `entityId`), comme `audit_logs` et
`valeurs_qualite` qui suivent déjà ce motif dans ce dépôt.

Des colonnes `validePar` et `valideA` ne retiendraient que la **dernière** décision. Or
un objet peut être renvoyé en correction puis représenté plusieurs fois, et la chaîne qui
dit comment une donnée est devenue officielle est précisément ce qu'un audit demande à
voir. Chaque entité porte en plus une colonne `statutValidation` dénormalisée, pour
filtrer et indexer sans jointure ; les deux s'écrivent dans la même transaction.

## La règle est tenue par le code, en un seul endroit

`backend/src/governance/validation.ts`, 27 tests. Elle était écrite deux fois — une pour
les observations, une pour les défauts. Deux copies auraient divergé, et la divergence
aurait été invisible : chacune aurait continué de passer ses propres tests pendant que
l'une laissait valider ce que l'autre refusait.

Ce qu'elle garantit :

- seuls `ADMIN` et `GESTIONNAIRE` tranchent, et un rôle inconnu tombe du côté restreint ;
- **nul ne valide ce qu'il a produit**, quel que soit son rôle, `ADMIN` compris ;
- `VALIDE` ne revient jamais en arrière, car une donnée officielle a pu être lue, citée,
  chiffrée, inscrite dans un marché ;
- `REJETE` est terminal, `A_CORRIGER` porte la boucle de reprise ; les confondre ferait
  disparaître des objets réels pour un motif de forme ;
- un refus sans commentaire est refusé.

**Le cas qui méritait réflexion : l'auteur inconnu.** Les 81 ouvrages DTOAA viennent d'un
document, pas d'une personne. Faire jouer la séparation des rôles sans auteur à opposer
les rendrait *invalidables* — donc éternellement non officiels et pourtant publics, c'est
exactement le problème qu'on corrige. La séparation ne s'applique donc que lorsqu'un
auteur est identifié, et ce choix est testé pour qu'il ne se perde pas.

## Ce que la migration fait, et ce qu'elle ne fait pas

`20261007200000_gouvernance_defauts` : 4 tables, 8 types, des colonnes **ajoutées** à
5 tables. Aucun `DROP`, aucune colonne modifiée, aucune donnée touchée.

**`statutValidation` est nullable et sans valeur par défaut sur les tables existantes.**
Un `DEFAULT 'A_VALIDER'` aurait basculé d'un seul coup les 261 387 tronçons et les 1 691
du réseau classé en « non officiels ». `NULL` dit « pas encore soumis au circuit », ce qui
n'est pas `A_VALIDER` qui dit « en attente d'une décision ».

**La conséquence doit être dite franchement.** Après cette migration, aucun objet du
patrimoine n'est marqué validé. Basculer les indicateurs publiés sur « validé seulement »
réduirait le réseau affiché à zéro. Ce basculement est une décision séparée, qui suppose
une campagne de validation, et la migration ne la prend pas.

`defauts.statutValidation` porte en revanche bien `DEFAULT 'A_VALIDER'` : la table est
vide, et tout défaut naît proposition. La règle est tenue par la colonne, non par la
bonne volonté de l'appelant.

**Aucune donnée n'est renseignée par la migration.** Le classement des 7 tronçons et la
mise en `A_VALIDER` des 81 ouvrages passent par des scripts dédiés, auditables et
réversibles, pas par un `UPDATE` noyé dans une migration de schéma.

## Ce qui reste à décider

**Le préfixe `sourceReference` reste la source de vérité pour l'instant.** Le code
d'exclusion déployé (`clauseSqlReseauClasse`) lit les préfixes, et il sert la carte
publique. Je recommande de renseigner `perimetre` depuis les préfixes — la correspondance
est déterministe —, de laisser les deux en place le temps d'une version, puis de basculer
les requêtes. Remplacer les deux d'un coup sur une base qui sert des données réelles
n'apporterait rien qu'un risque.

**Les 21 157 km seront à recalculer** après classement des 7 tronçons. L'écart attendu est
de 72 km, soit 0,34 %.
