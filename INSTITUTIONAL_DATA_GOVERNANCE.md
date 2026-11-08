# Gouvernance institutionnelle des données

> Livrable 15 du § B.6. Rassemble les décisions **institutionnelles** du § A.6.6 (D-08) et de la
> partie B, avec ce que le dépôt sait et ce qu'il ne peut pas décider. **Rédigé le 14/10/2026.**
>
> 🔒 Ce document **ne tranche rien** : aucune de ces questions n'est contournable
> techniquement, et le § A.5.12 interdit tout accès à un système tiers sans autorisation écrite.
> Chaque rubrique porte des options et, quand c'est légitime, une **proposition**.

## 1. Rôles — hypothèse d'architecture à faire confirmer

Telle que le § B.1 et le § B.2 la posent :

| Acteur | Rôle supposé | Statut |
|---|---|---|
| **ONR / BDR** | dépositaire de la **nomenclature nationale** et des **statistiques officielles** ; centralisation, harmonisation, diffusion | hypothèse |
| **AGEROUTE** | **gestionnaire opérationnel** des routes dont elle a la charge ; meilleur producteur de données (arbitrage D13) | hypothèse |
| **MIT** | tutelle, atelier BDR de juillet 2026 | fait |
| **Collectivités** | voiries urbaines « si compétence et données » (§ 6) | à préciser |
| **ANASUR** | collecte terrain nationale sur tablettes | hypothèse (§ B.2) |

**Conséquence concrète si l'hypothèse est confirmée** : le Géoportail **s'aligne** sur la
nomenclature ONR (D-06 devient une importation, pas une invention) et **ne duplique pas** la BDR.
Si elle ne l'est pas, D-06 reste une décision d'AGEROUTE seule.

## 2. Les décisions en attente, et leur rang

| # | Décision | Pourquoi elle bloque | Proposition |
|---|---|---|---|
| G-1 | **Nomenclature officielle** des classes (décret D/2017/331) et **codification nationale** | A21, IO-01, et 19 846 km sans valeur d'énumération (D-06) | demander à l'ONR la nomenclature en vigueur avant tout `ALTER TYPE`, irréversible |
| G-2 | **Gouvernance des échanges** BDR et ANASUR Collect : qui autorise, quelle fréquence, quel périmètre | tous les flux IO | convention écrite ; questionnaire ANASUR comme premier acte |
| G-3 | **Double relevé** sur les mêmes routes (ANASUR Collect pour la BDR, AGEROUTE ROAD pour AGEROUTE) | coût et contradictions | poser la question **avant** le pilote corridor, pas après |
| G-4 | **Politique de signalement citoyen** | PAT, Info Route, IO-09 | aucune collecte citoyenne sans politique écrite : anonymisation, modération, responsabilité |
| G-5 | **Hébergement et résidence des données** — loi **L/2016/037/AN** | partie E (services satellitaires), Power BI (D5), tout service externe | aucune donnée ni média d'AGEROUTE vers un service externe sans analyse de localisation ; la production actuelle est sur serveur interne |
| G-6 | **Publication publique** : quel niveau de détail sur la carte publique | `/api/public` sert déjà identité, type, position des ouvrages (décision D9 du 02/09) | formaliser ce que D9 a décidé en pratique |
| G-7 | **Conventions avec flottes partenaires et sociétés minières** (T-16, T-17) | télématique, corridor de Boké | consentement, anonymisation, quotas — avant tout flux |
| G-8 | **Périmètre et ressources du pilote corridor** (D12) | quatre arbitrages attendent sa mesure : D2, D3, D9, D12 | RN1 Conakry – Kindia – Mamou ou corridor de Boké, **par AGEROUTE** |
| G-9 | **ERP et IdP de référence** (D-09) | « aucun second annuaire » (D4) alors que `users` en est un | rattachement sans suppression, jamais bascule |
| G-10 | **Chemin de reprise après sinistre** (D-10) | la chaîne de migrations ne reconstruit pas la base : `pg_dump` est le seul chemin | acter B maintenant, corriger au prochain déploiement autorisé |

## 3. Ce que le dépôt garantit déjà, quelle que soit la gouvernance

| Garantie | Tenue par |
|---|---|
| Aucune donnée importée ne devient officielle sans geste humain | `statutValidation`, 75 tests |
| Aucune détection IA auto-validée | contrainte `media_analyse_coherente` |
| Aucun paramètre normatif appliqué sans approbation datée et signée | `approuveeLe` / `approuveeParId` ; RCI désapprouvée le 14/10 |
| Aucun objet contractuel créé ni modifié | ADR-003, garde-fou TI-01 (17 tests) |
| Aucune suppression physique de patrimoine | `deletedAt` partout |
| Toute écriture auditée | `audit_logs`, 1 506 lignes |
| Aucun secret dans le dépôt, IP de production jamais commitée | `SECURITY_REMEDIATION.md`, 225 commits analysés |

## 4. Ce que ce document ne peut pas dire

Qui, à AGEROUTE, est habilité à signer les conventions des rubriques G-2, G-7 et G-8. Ce n'est
pas une question de données, et elle précède toutes les autres.
