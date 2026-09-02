# Gestion de la clé de sauvegarde BDRI — décision requise

**Ticket** : P5-13
**Date** : 2 septembre 2026
**Nature** : procédure opérationnelle. Aucun code. La décision appartient à AGEROUTE.

---

## 1. L'état des lieux, mesuré

| Élément | État | Preuve |
|---|---|---|
| Clé de chiffrement des sauvegardes | existe en **un seul exemplaire** : `~/.bdri/cle-sauvegarde` sur le serveur applicatif (conteneurs `console-bdri-*`), propriété de l'utilisateur applicatif | vérifié le 02/09/2026 |
| Sauvegardes chiffrées | déposées sur un second serveur (`ageroute-depots/bdri-sauvegardes`, hôte `ageroutedb`), rétention 14 jours | `etat-sauvegardes-bdri.sh` |
| Copie de la clé sur le second serveur | **inexistante** | vérifié le 02/09/2026 |
| Copie de la clé hors site | **inexistante** | vérifié le 02/09/2026 |
| Procédure de restauration | éprouvée — la Phase 5 restaure et analyse une sauvegarde complète ce jour même | `preparer-analyse.sh`, `recouvrement-osm-bdri.sh` (Phase 4) |
| Clé dans Git / documentation / logs | **jamais** — conforme à la règle | vérifié |

Le risque est donc précis : **la perte du serveur applicatif entraîne la perte
définitive de toutes les sauvegardes**, quiexistent toujours mais deviennent
indéchiffrables. Un chiffrement sans plan de continuité de la clé n'est pas une
sauvegarde, c'est une destruction différée.

Le scénario n'est pas hypothétique : panne disque, incendie, ransomware chiffrant le
serveur y compris `~/.bdri`, erreur humaine. Dans chacun de ces cas, les sauvegardes
chiffrées du dépôt distant restent intactes et inutilisables.

---

## 2. Ce qui ne doit jamais être fait

Quelle que soit l'option retenue :

- **jamais** la clé dans le dépôt Git (public ou privé) ;
- **jamais** la clé dans un document, un wiki, un ticket, un e-mail ;
- **jamais** la clé affichée dans un log ou une sortie de script ;
- **jamais** la clé stockée en clair sur une machine de bureau connectée en permanence.

---

## 3. Les options, avec leurs avantages et leurs coûts réels

### Option A — Coffre-fort physique (procédure papier)

La clé est imprimée/scellée et déposée dans le coffre-fort de la Direction Générale,
avec un pli scellé en duplicate chez un second responsable.

| Avantages | Coûts / risques |
|---|---|
| Aucune dépendance technique | Rotation de clé lente (aller-retour physique) |
| Survit à tout compromission numérique | Le pli peut être oublié lors d'un changement de coffre/responsable |
| Simple à auditer pour un auditeur externe | Test de restauration périodique nécessite un accès physique |

### Option B — Gestionnaire de secrets partagé (coffre numérique)

Un coffre du type Vaultwarden/Bitwarden (auto-hébergé sur le serveur des opportunités)
ou KeePassXC avec fichier répliqué, contenant la clé, accessible à deux responsables
nommés, protégé par mot de passe maître fort + 2FA.

| Avantages | Coûts / risques |
|---|---|
| Test de restauration facile et fréquent | Le coffre devient un actif critique à sécuriser lui-même |
| Rotation de clé rapide | Deux mots de passe maîtres à transmettre lors des départs |
| Historique d'accès si Vaultwarden | Dépendance à un service auto-hébergé à maintenir |

### Option C — Second emplacement sécurisé (réplication de la clé chiffrée)

La clé est chiffrée une seconde fois (GPG) pour chacun des deux responsables, et ces
versions GPG sont déposées sur le serveur de sauvegardes. La clé « nue » ne quitte
jamais son serveur ; seules ses versions ré-chiffrées, inutilisables sans les clés
privées des responsables, sont répliquées.

| Avantages | Coûts / risques |
|---|---|
| La clé en clair reste en un seul endroit | Nécessite de la rigueur GPG (peu d'usagers habitués) |
| Répliquée par construction | La perte des clés privées GPG = perte des sauvegardes (il faut alors aussi sauvegarder les clés GPG — le problème se déplace) |
| Aucun nouveau service à maintenir | Vérification périodique des clés GPG indispensable |

### Option D — Mécanisme institutionnel

AGEROUTE formalise par note de service : le/la DSI détient la clé, le/la Directeur
Technique en détient une copie scellée, la Direction Générale connaît l'emplacement
des deux. La procédure inclut un test de restauration trimestriel consigné.

| Avantages | Coûts / risques |
|---|---|
| Pérennité institutionnelle (survit aux personnes) | Fonctionne seulement si la note est réellement appliquée |
| Compatible avec un audit externe | Le test trimestriel est le premier truc abandonné en période de charge |

---

## 4. Ce que la Phase 5 recommande (recommandation, pas décision)

**Combiner A et D** : un pli scellé en coffre (option A) comme garant de dernier
recours, et une note de service instituant le test de restauration trimestriel avec
deux détenteurs nommés (option D). L'option B est la meilleure techniquement mais
ajoute un service à maintenir ; elle devient pertinente le jour où AGEROUTE gère
plusieurs coffres de secrets (elle en a déjà besoin pour les `.env` des applications).

Dans tous les cas, trois mesures immédiates, sans attendre la décision :

1. **Consigner la procédure de restauration complète** (elle existe et a été éprouvée :
   `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 ... -pass file:~/.bdri/cle-sauvegarde`
   puis `pg_restore`) — un nouveau responsable doit pouvoir la exécuter sans deviner.
2. **Un test de restauration trimestriel** sur une machine de développement, consigné
   dans un journal (date, sauvegarde testée, résultat). C'est ce test qui transforme
   une sauvegarde supposée en sauvegarde prouvée.
3. **Une alerte sur l'absence de sauvegarde** : le script de sauvegarde est déjà
   bavard sur les échecs ; s'assurer que quelqu'un reçoit ces échecs (courriel hebdo
   de l'état des sauvegardes, pas seulement un log local).

---

## 5. La question à trancher par AGEROUTE

> Qui, outre le serveur, détient la capacité de déchiffrer les sauvegardes BDRI,
> sous quelle forme, et à quelle fréquence le prouve-t-on ?

Tant que cette question n'a pas de réponse écrite, la chaîne de sauvegarde repose
entièrement sur un seul serveur et un seul disque.

**Statut des affirmations de ce document** : l'état des lieux est MESURÉ (vérifications
du 02/09/2026) ; les options sont une analyse ; la décision est REQUIRES_BUSINESS_VALIDATION.
