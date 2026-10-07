# Audit d'architecture du dépôt réel

Phase 0, point 41 du master prompt. Tout ce qui suit est mesuré sur le dépôt et sur la
production au 07/10/2026, pas déduit d'une lecture.

## Ce qui existe

```
backend/src   138 fichiers TypeScript      frontend/src  110 fichiers
modèles Prisma            35               migrations               36
tests backend            436               tests frontend          179
```

Stack : React 18, Vite, TypeScript, Tailwind, **Leaflet** côté carte ; Node, Express,
Prisma, PostgreSQL 17 + PostGIS côté serveur. Authentification JWT à rotation,
Argon2id, RBAC, audit, suppression logique.

En production sur `carte.ageroute.gov.gn`, Docker et Traefik.

## Volumes réels

| Table | Lignes |
|---|---|
| `valeurs_qualite` | 1 820 694 |
| `troncons` | 261 387 dont **1 691** au réseau classé |
| `audit_logs` | 1 484 |
| `ouvrages` | 1 172 dont **126** inventoriés par AGEROUTE |
| `chantiers` | 487 |
| `users` | 9 |
| `inspections` | **0** |

Deux chiffres commandent la lecture de tout le reste.

**`valeurs_qualite` porte 1,8 million de lignes.** L'appareil de provenance exigé au
point 14 du master prompt — d'où vient la donnée, quand, par qui, avec quelle méthode,
quelle confiance — existe déjà et fonctionne à l'échelle. Ce n'est pas à construire.

**`inspections` est vide.** Le module de collecte terrain de la V1 n'a jamais servi.
Le point 10 du master prompt demande une application mobile ; il n'y a donc aucun
usage établi à préserver de ce côté, et c'est une liberté rare.

## Ce qui est déjà conforme au master prompt

| Exigence | État |
|---|---|
| 14 Qualité et provenance | `ValeurQualite`, 1,8 M lignes, statut, source, méthode, confiance |
| 30 Sécurité | Helmet, CSP, HSTS, CORS, rate limiting, JWT à rotation, Argon2id, cookies HttpOnly, RBAC |
| 31 Audit | `AuditLog`, 1 484 lignes, before/after, IP |
| 12 Conflits | `OperationSync`, `ConflitSync`, `version`, `clientOperationId` |
| 11 Offline | `clientOperationId` généré avant envoi, idempotence testée |
| 9 Map matching | mesuré, exposé, refuse de conclure sous le seuil |
| 7 PostGIS | index GiST posés, formes distinguées selon l'opérateur |

## Dette technique, mesurée

**Les deux composants géants.** `GeoportailPage.tsx` pèse 72,1 Ko et
`DetailPanel.tsx` 62,7 Ko. Le point 6 du master prompt demande de les découper
progressivement et sans refactor massif ; la consigne est juste.

**La chaîne de migrations ne reconstruit pas une base vierge.** Elle échoue à
`20260702140000_decomptes`. Les 36 migrations décrivent donc l'historique sans
permettre de repartir de zéro, ce qui interdit un environnement de recette propre et
rend tout test de migration dépendant d'une copie de production.

**Quatre rôles pour neuf métiers.** Le système connaît ADMIN, GESTIONNAIRE, INSPECTEUR
et LECTEUR. Les cahiers des charges en décrivent neuf, dont plusieurs se distinguent
par leur **périmètre** et non par leurs droits — « chef de service » valide « son
périmètre ». Il manque un modèle de portée, pas des valeurs d'énumération.

**Les PK ne couvrent qu'un tiers du réseau classé.** 551 tronçons sur 1 691 portent un
intervalle exploitable. Zéro sur les 1 029 routes régionales. Le point 8 du master
prompt exige des PK cohérents ; c'est un chantier de donnée, pas de code.

**Le déploiement ne passe pas par Git.** Le serveur n'est pas un dépôt : les mises en
ligne se font par `git archive` et extraction. Trois builds cassés en une journée ont
eu cette seule cause. Initialiser un dépôt sur le serveur supprimerait cette classe
d'erreur.

## Risques à porter au registre

**La clé de chiffrement des sauvegardes n'a aucune copie hors du serveur.** Les
archives déposées à l'extérieur sont illisibles sans elle. La perte du serveur
entraînerait celle de la base, sauvegardes comprises. C'est le risque le plus grave du
système, et il se solde en copiant 65 octets.

**Un mot de passe ADMIN a circulé en clair** et n'a pas été changé. Un compte nommé
`test.gestionnaire@ageroute.gov.gn` porte le rôle ADMIN en production.

**Sept tronçons hors du territoire guinéen**, 72 km, comptent dans les 21 157 km
publiés. Le prédicat qui les exclut est déployé, le marquage des données reste à faire.

**Dix commits ne sont parvenus sur GitHub qu'aujourd'hui.** L'état déployé n'a existé
que sur une machine pendant deux jours.

## Verdict

Le dépôt est un socle solide et non un prototype. Les fondations que le master prompt
place en priorité absolue — donnée fiable, traçabilité, sécurité — sont posées et
éprouvées à l'échelle.

Ce qui manque n'est pas de l'infrastructure, c'est la chaîne de décision : défaut,
état, traitement, quantité, coût, programmation. Elle n'existe nulle part, et c'est
elle que le pack RAI V3 apporte réellement.

La règle 2 du master prompt — auditer, conserver, étendre, ne pas créer d'architecture
parallèle — est la bonne. Le pack fourni, appliqué tel quel, la violerait : voir
`02_MATRICE_SCHEMA.md`.
