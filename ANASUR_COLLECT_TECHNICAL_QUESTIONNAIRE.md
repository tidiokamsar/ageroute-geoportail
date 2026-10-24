# Questionnaire technique — ANASUR Collect

> Livrable 10 du § B.6, exigé par le § B.3 du prompt maître V10. **À adresser à l'ONR, à
> l'ANASUR et au ministère des Infrastructures**, par la voie institutionnelle d'AGEROUTE.
>
> Objet : permettre à AGEROUTE de concevoir un échange de données **sans rien présumer** du
> système, et sans accéder à quoi que ce soit qui n'ait été autorisé.
>
> **Rédigé le 14/10/2026.** Projet de courrier : la formulation finale et l'expéditeur relèvent
> de la direction d'AGEROUTE.

Chaque question porte un numéro pour que les réponses puissent y renvoyer. Une réponse
« non applicable » ou « non communicable » est une réponse utile : elle ferme une hypothèse.

---

## A. Identité du système

| # | Question |
|---|---|
| A1 | Nom complet de l'application et de ses composants (mobile, serveur, administration). |
| A2 | **Éditeur** et **développeur** (s'ils diffèrent), et titulaire des droits. |
| A3 | Version déployée, date de déploiement, calendrier des versions. |
| A4 | Existe-t-il une **fiche technique**, un **guide utilisateur**, un **dictionnaire de données** ? Peuvent-ils être transmis ? |
| A5 | Les **formulaires de relevé** (types de dégradation, gravités, champs) sont-ils documentés ? Sont-ils les mêmes dans les huit protocoles régionaux ? |

## B. Fonctionnement hors ligne

| # | Question |
|---|---|
| B1 | L'application fonctionne-t-elle **sans réseau** ? Pendant combien de temps ? |
| B2 | Où et comment les données sont-elles **stockées localement** sur la tablette ? Sont-elles **chiffrées** ? |
| B3 | Que se passe-t-il en cas de perte de la tablette, de réinstallation, de panne pendant un relevé (**reprise**) ? |

## C. Formats et procédures d'échange

| # | Question |
|---|---|
| C1 | Existe-t-il une **procédure d'export** ? Vers quels formats ? (*Nous ne présumons aucun format.*) |
| C2 | Existe-t-il une **procédure d'import** vers l'application ou vers la BDR ? |
| C3 | Un **exemple d'export anonymisé** peut-il être fourni, sur un échantillon approuvé ? |
| C4 | Les exports portent-ils la **provenance** (auteur, appareil, date, version du formulaire) ? |

## D. Interfaces de programmation

| # | Question |
|---|---|
| D1 | Existe-t-il une **API** ? Si oui : documentation, **authentification**, **versionnement**, quotas. |
| D2 | Existe-t-il un **environnement de test** ou de recette distinct de la production ? |
| D3 | Les appels sont-ils **idempotents** et **journalisés** ? |
| D4 | S'il n'existe pas d'API : quel **mécanisme officiel** d'échange est prévu ou envisagé ? |

## E. Identifiants et modèle

| # | Question |
|---|---|
| E1 | Schéma des **identifiants** : route, tronçon, portion, dégradation, ouvrage. Sont-ils **stables** dans le temps ? |
| E2 | Existe-t-il une **nomenclature nationale** des routes ? Laquelle ? Est-elle celle du décret D/2017/331/PRG/SGG ? |
| E3 | Comment un relevé est-il **rattaché** à une route : identifiant, nom, position, autre ? |
| E4 | Les relevés distinguent-ils **portions homogènes** et **sections de longueur fixe** ? Avec quel pas ? |

## F. Géolocalisation et pièces jointes

| # | Question |
|---|---|
| F1 | **Système de coordonnées** des positions (WGS 84, UTM 28N/29N, autre). |
| F2 | **Précision GPS** enregistrée avec chaque position ? Source (GNSS, réseau) ? |
| F3 | **Horodatage** : heure de l'appareil ou du serveur ? Fuseau ? |
| F4 | **Pièces jointes** : photos, vidéos, formats, taille, géoréférencement, orientation. |
| F5 | Existe-t-il une **méthode de recalage** sur le réseau (map-matching) ? Laquelle ? Côté tablette ou serveur ? |

## G. Validation, rôles et audit

| # | Question |
|---|---|
| G1 | Règles de **validation** d'un relevé : par qui, à quel moment, avec quels statuts ? |
| G2 | **Rôles** dans l'application et au serveur. |
| G3 | Existe-t-il un **journal d'audit** des créations, modifications, suppressions ? |
| G4 | Comment une **correction** après validation est-elle tracée ? |

## H. Synchronisation

| # | Question |
|---|---|
| H1 | **Fréquence** de synchronisation tablette → serveur. |
| H2 | Gestion des **conflits** (même relevé modifié des deux côtés). |
| H3 | Existe-t-il une **preuve de réception** côté tablette ? |

## I. Hébergement et sécurité

| # | Question |
|---|---|
| I1 | **Hébergement** du serveur et **localisation** des données — en regard de la loi L/2016/037/AN. |
| I2 | **Sauvegardes** : fréquence, lieu, restauration testée. |
| I3 | **Rétention** des données et des médias. |
| I4 | Mesures de **sécurité** (chiffrement en transit et au repos, authentification des tablettes). |
| I5 | Procédure en cas d'**incident** de sécurité. |

## J. Droits et gouvernance

| # | Question |
|---|---|
| J1 | **Propriété** des données collectées par les 46 agents : État, ONR, ANASUR, régions ? |
| J2 | **Droits d'accès** d'AGEROUTE aux relevés concernant les routes dont elle a la charge. |
| J3 | Conditions de **réutilisation** et de **portabilité**. |
| J4 | Existe-t-il un **accord institutionnel** autorisant les échanges avec AGEROUTE ? Sinon, quelle procédure pour l'établir ? |

---

## Ce qu'AGEROUTE s'engage à faire des réponses

- Aucune donnée ne sera importée avant une **autorisation écrite** et des **échantillons
  approuvés** (§ B.4).
- Tout import sera **non destructif** : les données importées sont marquées « importées / à
  vérifier » et **n'écrasent jamais** le référentiel d'AGEROUTE.
- Les identifiants source, la méthode de rapprochement, le score, la date et la décision du
  réviseur sont **conservés** pour chaque ligne.
- Le plan de test correspondant est public dans le dépôt : `BDR_IMPORT_ACCEPTANCE_TESTS.md`.
