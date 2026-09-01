# Audit des données tronçons

**Date de mesure** : 1er septembre 2026
**Base** : `console_bdri` en production, accès lecture seule
**Portée** : les 1 690 tronçons non supprimés
**Méthode** : requêtes PostGIS sur la base de production. Aucune donnée n'a été modifiée.

---

## 1. Le constat de départ, et ce qu'il cachait

Le brief posait le problème ainsi : 1 028 tronçons sur 1 690 ont une longueur nulle, et les 7 933 km affichés proviennent des 662 restants.

C'est exact. Mais la mesure montre que ce n'est pas un problème de données abîmées. C'est un import incomplet sur **une seule classe de routes**.

| Classe | Tronçons | Avec longueur | km stockés | km calculés depuis la géométrie |
|---|---:|---:|---:|---:|
| RN — nationales | 621 | **621** (100 %) | 7 840 | 7 824 |
| RU — urbaines | 40 | **40** (100 %) | 36 | 36 |
| RR — régionales | 1 029 | **1** (0,1 %) | 56 | **13 296** |
| **Total** | **1 690** | **662** | **7 933** | **21 156** |

Le champ longueur a été renseigné intégralement pour les nationales et les urbaines, et pas du tout pour les régionales. Une seule exception sur 1 029.

Un champ rempli à 100 % sur deux classes et à 0,1 % sur une troisième n'est pas une dégradation progressive. C'est une étape d'import qui n'a pas été appliquée à la troisième classe.

---

## 2. La géométrie est-elle exploitable ?

Avant de proposer quoi que ce soit à partir de la géométrie, il fallait établir qu'elle vaut mieux que le champ qu'elle prétend remplacer.

| Contrôle | Résultat |
|---|---|
| Système de coordonnées | **1 690 / 1 690 en EPSG:4326**, aucune exception |
| Géométrie absente | **0** |
| Géométrie invalide (`ST_IsValid`) | **0** |
| Géométrie auto-intersectée (`ST_IsSimple`) | 1 (une régionale) |
| Géométries dupliquées | **0** |
| Hors de l'emprise Guinée | **0** |

Le système de coordonnées est homogène et correct, ce qui écarte l'hypothèse d'une confusion d'unités entre degrés et mètres. Les longueurs sont calculées avec `ST_Length(geom::geography)`, qui rend des mètres sur l'ellipsoïde et non des degrés.

### Le test qui tranche

Les 662 tronçons qui portent une longueur permettent de confronter les deux sources :

| Catégorie demandée au §4 | Tronçons |
|---|---:|
| Cohérent (écart ≤ 1 %) | **662** |
| Légèrement différent (1 à 10 %) | **0** |
| Fortement différent (> 10 %) | **0** |
| Longueur nulle, géométrie présente | 1 028 |
| Géométrie absente | 0 |
| Géométrie invalide | 0 |

Aucun écart intermédiaire. Là où les deux valeurs existent, elles concordent à moins de 1 %. Cela veut dire deux choses : la longueur stockée a été calculée depuis cette géométrie, et la géométrie est une source fiable pour la longueur.

---

## 3. La réserve sérieuse : la géométrie régionale est plus grossière

C'est le point qui empêche de conclure trop vite.

| Classe | Densité moyenne | Densité médiane | 1er décile |
|---|---:|---:|---:|
| RN | 12,0 pts/km | 9,6 | 3,6 |
| RU | 26,4 pts/km | — | — |
| **RR** | **2,2 pts/km** | — | — |

Les régionales sont décrites cinq fois plus grossièrement que les nationales. Et 32 d'entre elles n'ont que **deux points** : une ligne droite entre deux extrémités. Une ligne droite mesure une corde, pas une route. Elle sous-estime.

Répartition des kilomètres régionaux par densité :

| Densité | Tronçons | km | Part des km RR |
|---|---:|---:|---:|
| 2 points (ligne droite) | 32 | 19 | 0,1 % |
| moins de 1 pt/km | 10 | 280 | 2,1 % |
| 1 à 5 pts/km | 980 | 12 934 | **97,3 %** |
| 5 pts/km et plus | 7 | 63 | 0,5 % |

Les lignes droites ne pèsent que 19 km : ce sont des tronçons courts, leur effet sur le total est négligeable. Le vrai sujet est la bande à 1–5 pts/km, qui porte 97 % des kilomètres régionaux.

### Combien la grossièreté coûte-t-elle en longueur ?

Plutôt que d'estimer, j'ai mesuré. J'ai dégradé la géométrie des nationales — celle qui est bien décrite — jusqu'à la densité des régionales, et observé la longueur perdue.

| Tolérance de simplification | Densité obtenue | Longueur conservée |
|---|---:|---:|
| 0,0005° | 1,6 pt/km | **99,09 %** |
| 0,001° | 1,1 pt/km | 98,31 % |
| 0,002° | 0,7 pt/km | 97,00 % |
| 0,005° | 0,4 pt/km | 94,44 % |
| 0,01° | 0,3 pt/km | 91,98 % |

À 1,6 point par kilomètre — soit **en dessous** de la densité moyenne des régionales — on conserve 99,09 % de la longueur. Il faut descendre à 0,3 pt/km, une densité que presque aucune régionale n'atteint, pour perdre 8 %.

**Conclusion mesurée** : la grossièreté de la géométrie régionale coûte de l'ordre de 1 % de longueur. Les 13 296 km sont une sous-estimation de quelques dizaines de kilomètres, pas une erreur de facteur.

### La limite de ce test, qu'il faut énoncer

Ce test simplifie une géométrie qui a d'abord été finement numérisée. Il mesure donc la perte due à la **réduction** de sommets. Une géométrie numérisée grossièrement dès l'origine peut être différente : elle peut ignorer un virage réel au lieu de le lisser.

Le test donne donc une borne, pas une certitude. Il établit que la sinuosité des routes guinéennes à cette échelle est faible, ce qui rend le biais faible — mais il ne remplace pas une comparaison avec un tracé de référence indépendant.

---

## 4. La longueur doit-elle être calculée ou saisie ?

La question du §3 mérite une réponse explicite, parce qu'elle détermine le correctif.

Les deux valeurs ne répondent pas à la même question :

- **La longueur géométrique** est la longueur du tracé numérisé. Elle est reproductible, vérifiable, et se recalcule seule quand le tracé est corrigé.
- **La longueur métier** est celle qui figure aux marchés, aux ordres de service, aux décomptes. C'est elle qui engage financièrement. Elle peut légitimement différer : bornage administratif, section non traitée, arrondi contractuel.

Aujourd'hui la base a **un seul champ pour ces deux notions**, et les 662 valeurs présentes sont manifestement géométriques — d'où la concordance à 1 %.

**Recommandation** : ne pas écraser, ne pas fusionner. Distinguer.

- `longueurKm` reste la valeur métier, saisie, autoritative, souvent vide — et c'est normal qu'elle soit vide tant que personne ne l'a établie.
- Une valeur calculée est exposée à côté, dérivée de la géométrie, jamais saisie.
- L'écart entre les deux devient un indicateur de qualité, pas une erreur à corriger.

C'est aussi ce qui évite le piège du §41 : présenter une valeur calculée comme une donnée métier réelle.

---

## 5. Ce que cela change pour le réseau affiché

Le chiffre public passe de 7 933 km à environ 21 156 km. Ce n'est pas une correction cosmétique, c'est un changement de nature de l'indicateur.

Aujourd'hui, « 7 933 km » désigne en réalité **le réseau national renseigné**, pas le réseau. Il faut donc soit renommer l'indicateur, soit publier la ventilation.

**Recommandation** : afficher trois chiffres au lieu d'un.

| Indicateur | Valeur | Base |
|---|---:|---|
| Réseau national (RN) | 7 840 km | longueur métier saisie, 621/621 |
| Réseau régional (RR) | ~13 296 km | **calculé**, longueur métier absente |
| Réseau urbain (RU) | 36 km | longueur métier saisie, 40/40 |

Et ne jamais présenter le total régional sans la mention « calculé ».

---

## 6. Le revêtement : une valeur d'import, et la preuve est interne

Les 1 690 tronçons portent `BITUME`. Une seule valeur distincte sur tout le réseau, sans aucune exception.

Un champ à valeur unique sur 1 690 lignes, incluant les 1 029 régionales, n'est pas une observation. C'est un défaut d'import.

La base contient sa propre contradiction. Parmi les intitulés de chantiers :

| Ce que l'intitulé du chantier indique | Chantiers |
|---|---:|
| « en terre », « piste », « latérite » | **29** |
| « bitume », « béton bitumineux », « BB » | 55 |
| « béton armé », « pavage », « pavé » | 38 |

Un exemple textuel : *« Travaux de réhabilitation de la Route Préfectorale en terre Pita-Maci-Sangareah longue de 85 km »*.

Une route décrite « en terre » dans un intitulé de marché, alors que le champ revêtement du réseau dit `BITUME` partout. Les deux ne peuvent être vrais.

**Recommandation** : `BITUME` doit être requalifié en valeur non vérifiée, sans être effacé. Voir le statut de fiabilité repris dans `BDRI-DATA-QUALITY-REPORT.md`. Ne pas le remplacer par une autre supposition.

---

## 7. Provenance : ce que la base sait, et ce qu'elle ignore

| Question | Réponse de la base |
|---|---|
| Qui a modifié un tronçon ? | 1 155 entrées d'audit, un seul compte |
| Quand ? | 23 juin (1 107), 24 juin (11), 29 juin (23), 1er juillet (2), 23 juillet (12) |
| Qui a **créé** les 1 690 tronçons ? | **Aucune entrée d'audit** |
| D'où viennent-ils ? | **La base ne le sait pas** |
| Quelle date de validité ? | **Aucun champ** |

Les créations n'ont laissé aucune trace : les tronçons sont entrés par un chemin qui n'écrit pas dans le journal d'audit — import direct ou amorçage.

C'est le manque le plus structurant de cet audit. La base peut dire qui a touché une donnée, jamais d'où elle vient. Tant que ce champ n'existe pas, aucune des questions du §21 du brief n'a de réponse.

---

## 8. Ce que je propose, et ce que je ne propose pas

### Je ne propose pas

- d'écraser une longueur existante — les 662 sont cohérentes, il n'y a rien à corriger ;
- d'écrire une longueur calculée dans `longueurKm` — cela ferait passer un calcul pour une donnée métier ;
- de remplacer `BITUME` par une autre valeur — je n'ai aucune source pour le faire ;
- de corriger la géométrie auto-intersectée sans l'avoir regardée.

### Je propose

| # | Action | Fondement mesuré | Risque |
|---|---|---|---|
| 1 | Exposer une longueur calculée **à côté** de la longueur saisie | concordance à 1 % sur 662 tronçons | nul, aucune écriture |
| 2 | Publier la ventilation RN / RR / RU au lieu d'un total unique | l'écart 7 933 / 21 156 s'explique entièrement par la classe | nul |
| 3 | Ajouter un statut de fiabilité par champ | `BITUME` unique sur 1 690, contredit par 29 intitulés | schéma, réversible |
| 4 | Ajouter source et date de validité aux tronçons | zéro trace de création dans l'audit | schéma, réversible |
| 5 | Examiner la régionale auto-intersectée | 1 cas identifié | nul, examen |

Les actions 3 et 4 touchent le schéma et relèvent donc de la règle de validation préalable. Les actions 1, 2 et 5 ne modifient aucune donnée.

---

## 9. Requêtes de contrôle

Toutes les mesures de ce document se rejouent avec :

```sql
-- Ventilation par classe
SELECT classe, count(*),
       count(*) FILTER (WHERE "longueurKm" > 0) AS avec_longueur,
       ROUND(SUM("longueurKm")::numeric, 0) AS km_stockes,
       ROUND(SUM(ST_Length(geom::geography)/1000)::numeric, 0) AS km_calcules
FROM troncons WHERE "deletedAt" IS NULL GROUP BY classe;

-- Concordance stocké / calculé
SELECT count(*) FILTER (WHERE abs("longueurKm" - ST_Length(geom::geography)/1000)
                            / "longueurKm" <= 0.01) AS coherent
FROM troncons WHERE "deletedAt" IS NULL AND "longueurKm" > 0;

-- Densité de description
SELECT classe, ROUND(AVG(ST_NPoints(geom)/(ST_Length(geom::geography)/1000))::numeric,1)
FROM troncons WHERE "deletedAt" IS NULL GROUP BY classe;
```
