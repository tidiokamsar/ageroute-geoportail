# Options d'interopérabilité avec la BDR nationale et ANASUR Collect

> Livrable 11 du § B.6, exigé par le § B.4 du prompt maître V10 : « trois options à documenter
> **sans en choisir** avant l'audit ». **Rédigé le 14/10/2026.**
>
> 🔒 « Sans mécanisme officiel : processus manuel sécurisé et traçable ; **n'invente pas une
> API**. » Aucune des trois options n'est présentée ici comme existante côté ONR ou ANASUR.

## 0. Ce qui est commun aux trois options, et déjà en place

Quelle que soit l'option retenue, l'import entre par le **contrat d'import unique**
(`ROAD_SURVEY_IMPORT_SPEC.md`) et sort par le **format pivot ouvert** du § 7.15 — CSV +
GeoPackage + GeoJSON, SRID 4326, documentés. Le pivot ne dépend d'aucune réponse de l'ONR :
c'est pourquoi il est la première chose à construire.

Et côté Géoportail, trois mécanismes **existent et sont testés** qui serviront aux trois options :
l'idempotence par `clientOperationId` (13 tests), le statut `A_VALIDER` par défaut qui empêche
toute donnée importée d'être officielle sans geste humain (75 tests), et `conflits_sync` qui
conserve les deux versions d'un conflit.

---

## Option A — Échange de fichiers contrôlé

| Rubrique | Contenu |
|---|---|
| **Principe** | export documenté par la source, déposé dans un **dépôt sécurisé**, validé contre un schéma, importé avec rapport, provenance et rapprochement des identifiants |
| **Prérequis** | un format d'export documenté (question C1 du questionnaire) ; un dépôt sécurisé (SFTP institutionnel ou SharePoint, B-12) ; des **échantillons approuvés** |
| **Coûts** | les plus faibles : aucun développement côté source ; côté Géoportail, un validateur de schéma et l'importateur du pivot |
| **Sécurité** | repose sur le dépôt : chiffrement en transit, comptes nominatifs, journal des dépôts. **Empreinte de chaque fichier** conservée avec le lot |
| **Responsabilités** | la source répond du contenu, AGEROUTE de l'import et du rapprochement ; le **rapport d'import** est la pièce contradictoire |
| **Fréquence, latence** | par campagne ; latence de jours à semaines — compatible avec des relevés de dégradations, pas avec de l'information routière |
| **Risques** | fichier modifié à la main entre export et dépôt (→ empreinte) ; schéma qui change sans préavis (→ validation stricte, rejet motivé) ; **double relevé** sur les mêmes routes par ANASUR et par AGEROUTE (institutionnel, D-08) |
| **Tests d'acceptation** | `BDR_IMPORT_ACCEPTANCE_TESTS.md` en entier, dont l'**idempotence** (même lot deux fois) |

**Quand elle suffit** : tant que l'échange est périodique. C'est aussi la seule option
réalisable **aujourd'hui**, dès qu'un export existe.

---

## Option B — API officielle

| Rubrique | Contenu |
|---|---|
| **Principe** | API **authentifiée, versionnée, idempotente, journalisée**, avec environnement de test, quotas et reprises |
| **Prérequis** | **qu'elle existe** (question D1) — rien ne l'établit aujourd'hui ; un environnement de test (D2) ; une convention d'accès (J4) |
| **Coûts** | développement d'un client derrière l'interface d'adaptateur, bouchons, tests de contrat ; coût côté source inconnu |
| **Sécurité** | jetons nominatifs à rotation, **aucun secret dans le dépôt**, journal des appels des deux côtés |
| **Responsabilités** | contrat d'interface versionné ; toute rupture de version est un incident, pas une surprise |
| **Fréquence, latence** | continue ou quotidienne ; latence de minutes — la seule option compatible avec l'exploitation (§ 7.17) |
| **Risques** | dépendance à la disponibilité d'un tiers ; **API supposée** là où il n'y en a pas — le garde-fou V10 l'interdit, et ce document ne la suppose pas |
| **Tests d'acceptation** | ceux de A, plus : rejeu d'un appel sans effet de bord, panne de réseau en cours d'appel, changement de version |

**Quand elle devient nécessaire** : quand la fréquence d'échange dépasse ce qu'une campagne de
fichiers peut porter — information routière, praticabilité, incidents.

---

## Option C — Passerelle institutionnelle

| Rubrique | Contenu |
|---|---|
| **Principe** | un mécanisme **fourni ou approuvé** par l'ONR ou le ministère, qu'AGEROUTE consomme sans le construire |
| **Prérequis** | qu'il soit décidé et financé par l'institution ; une **gouvernance des données** écrite (`INSTITUTIONAL_DATA_GOVERNANCE.md`) |
| **Coûts** | portés par l'institution ; côté Géoportail, un adaptateur de plus derrière la même interface |
| **Sécurité** | celle de la passerelle, à auditer ; AGEROUTE reste responsable de ce qu'elle importe |
| **Responsabilités** | les plus claires des trois : l'institution répond de la passerelle, chaque partie de ses données |
| **Fréquence, latence** | celles de la passerelle |
| **Risques** | **délai institutionnel** ; passerelle conçue pour la BDR et non pour l'exploitation ; AGEROUTE réduite à un simple fournisseur |
| **Tests d'acceptation** | ceux de A et B, plus un test de **souveraineté** : les données d'AGEROUTE restent récupérables en pivot ouvert à tout moment |

---

## Sans mécanisme officiel — ce qui s'applique en attendant

Un **processus manuel sécurisé et traçable**, et rien d'autre :

1. demande écrite d'AGEROUTE, autorisation écrite de la source ;
2. remise d'un fichier sur support ou dépôt institutionnel, **empreinte** relevée à la remise ;
3. import en **environnement de test** d'abord — celui qui existe depuis le 14/10 ;
4. rapport d'import et de rapprochement, revue humaine ;
5. import en production **seulement après autorisation distincte**.

C'est l'option A sans l'automatisation, et elle respecte déjà tous les critères du § B.4.

---

## Comparaison, sans choix

| Critère | A fichiers | B API | C passerelle |
|---|---|---|---|
| Réalisable aujourd'hui | **oui**, dès qu'un export existe | non — aucune API établie | non — décision institutionnelle |
| Compatible exploitation temps quasi réel | non | **oui** | selon la passerelle |
| Dépendance à un tiers | faible | forte | très forte |
| Risque de supposer ce qui n'existe pas | nul | **le plus élevé** | moyen |
| Clarté des responsabilités | bonne | bonne | **la meilleure** |

**Proposition** — et c'est une proposition, pas un choix : construire le **pivot ouvert et
l'importateur** maintenant, parce qu'ils servent aux trois ; traiter A comme chemin immédiat ;
n'ouvrir B qu'à la réponse à D1 ; et porter C en D-08 comme question à poser à l'ONR. Le choix
appartient à l'audit et aux autorités, comme le § B.4 l'exige.
