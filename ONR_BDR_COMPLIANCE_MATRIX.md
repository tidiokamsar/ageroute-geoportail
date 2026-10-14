# Matrice de conformité ONR / BDR

> Livrable 2 du § B.6, exigé par le § B.5 du prompt maître V10, aux sept colonnes prescrites :
> **domaine · besoin décrit · preuve dans le produit · statut · écart · action et test
> d'acceptation · décision requise**.
>
> Statuts du § A.10 : **TT** terminée et testée · **TP** tests partiels · **PA** partielle ·
> **NT** non testée · **AB** absente · **BL** bloquée · **EA** en attente d'approbation.
>
> 🔒 Règle du § B.5 : « aucune case « À vérifier » ne subsiste : statut prouvé, ou **accès à la
> preuve bloqué et dit** ». Depuis le 14/10 à 14:23 la production est gelée (§ A.5.1) : les
> **taux de remplissage** des colonnes ne sont plus mesurables. Quand c'est le cas, la ligne le dit.

**Dressée le 14/10/2026** contre `schema.prisma`, les 54 migrations, le code et les mesures des
13 et 14/10. Les quatorze domaines sont ceux que le § B.5 impose au minimum.

| Domaine | Besoin décrit par l'ONR | Preuve dans le produit | Statut | Écart | Action et test d'acceptation | Décision requise |
|---|---|---|---|---|---|---|
| **1. Référentiel routier** | référentiel national des axes, routes, tronçons, portions | 261 387 tronçons, 1 691 classés (21 156,6 km) ; `portions` avec exclusion bitemporelle ; `perimetre` (NATIONAL / HORS_TERRITOIRE / VOIRIE_LOCALE) ; provenance `sourceType` | **PA** | **aucun code national** ; `ClasseRoute` sans valeur pour 19 846 km de communautaires ; 48 % du réseau annoncé | IO-01 import ONR → propositions ; test T-01, T-09 | **D-06**, et nomenclature officielle de l'ONR (G-1) |
| **2. Relevés terrain** | campagnes, relevé en roulage, import différé de fichiers terrain | `missions`, `observations`, `defauts`, `medias_defaut` (sha256, cap, précision) ; idempotence `clientOperationId`, 13 tests ; HMM de trace **130/130** ; **import différé** : tables `lots_import` / `lignes_import` avec A28 **par contrainte**, noyau pivot CSV/GeoJSON 24 tests | **TP** | **0 mission, 0 observation** ; roulage non commencé ; orchestration de l'import non écrite, GeoPackage absent | pilote corridor ; T-02 tenu en base ; T-06 idempotence tenue en base | **G-8** périmètre du pilote ; **G-3** double relevé avec ANASUR |
| **3. Sections et portions** | sections fixes 100/200 m, notes par section | `reseau_sections_fixes`, 14 assertions : somme = longueur, portion dominante, aucune saisie au niveau section | **PA** | **note UEMOA absente** — texte de la directive non disponible | U-01 dès réception du texte | **D-01** ; demande P-3 |
| **4. Ouvrages** | fiches, inspections, photos, historique, hydrauliques | `ouvrages` 1 172 l., 13 types (pont, dalot, buse, radier… glissière) ; fiche avec matériaux, travées ; `inspections` ; provenance `doc_dtoaa:` servie `aValider` ; clé d'échange `code Route-Type-PK` **en service** vers DigitalRoad | **PA** | positions héritées de 2016 **non vérifiées** ; fiche d'inspection typée T-04 absente ; historique d'état non structuré (`derniereInspectionDate` seule) | inspection post-travaux typée ; `asset_condition_history` (nom conceptuel § C) | aucune |
| **5. Dégradations** | ponctuelles et linéaires, type × gravité, géolocalisées | `catalogue_defauts` **13 types**, 7 familles, seuils, `coefficientUnitaire` ; `defauts` avec emprise, quantité, méthode, gravité, étendue | **PA** | **13 types contre ≥ 21** (plancher § 7.16) ; revêtu / non revêtu non distingué ; photos de référence par gravité absentes ; **0 défaut** | enrichir le catalogue (table, pas enum) ; A11 déjà TT | validation du catalogue étendu par AGEROUTE |
| **6. État du réseau** | niveau de service, état, ancienneté | `valeurs_qualite` 1 820 694 l. avec `StatutValeur` (OBSERVED / IMPORTED_UNVERIFIED / DERIVED / CONFLICTING) ; RCI écrit, 38 tests | **EA** | RCI **désapprouvé** ; **1 seul** tronçon à état observé (`RES-857`) ; `dateDerniereEvaluation` **nulle partout** | réapprobation après confrontation VIZIR/UEMOA | **D-01** |
| **7. Trafic et essieux** | comptages par campagne, point, période, catégorie, sens, méthode ; charges, agressivité | colonnes `troncons.traficMoyenJma`, `traficDateComptage` — **taux de remplissage non mesurable, production gelée** ; aucune table de campagne, aucun flux | **BL** | aucune source (AI4 Trafic, pesage) ; le RCI exclut `TRAFIC` | IO-06 ; contrat d'import | convention ONR (G-2) |
| **8. Entretien — Treatment Engine** | orientation état → traitement | **`catalogue_traitements` + `conditions_traitement`** créés le 14/10 : 3 traitements, 9 conditions dérivées des barèmes par requête, matrice **fonction** (`UNIQUE NULLS NOT DISTINCT`), 12 assertions. `matrices_degradation` = lois de vieillissement, lues par aucun code | **EA** | durée de vie, effet sur l'indice, fenêtre saisonnière, classe de trafic **nuls** — personne ne les a arrêtés ; aucun traitement approuvé | renseigner et approuver les attributs ; `MAINTENANCE_PROGRAMMING_DESIGN.md` § 4 | approbation des durées et effets par AGEROUTE |
| **9. Coûts — Cost Engine** | estimation technique puis financière traçable | `baremes_intervention` 9 l., `source = standard_initial`, **aucune approuvée** ; `troncons.coutRehabEstime` — **provenance et remplissage non mesurables** | **EA** | millésime et largeur **inconnus** ; aucune classe de précision ; aucun lien métré → coût | estimation qui **refuse** sans ligne de bordereau ; classes ±30 / ±15 / métré | **D-07** |
| **10. Programmation — Programming Engine** | programmes annuels et pluriannuels, scénarios, arbitrage humain | **rien** | **AB** | PPE, PAE, fiche d'intervention, cycle de vie avec statuts reçus de DigitalRoad | § 5 de la conception ; garde-fou de transition `APPROUVÉ → EN_EXÉCUTION` interdit sans message DigitalRoad | **D-07** d'abord ; accès **B-11** pour la boucle de retour |
| **11. Signalements usagers** | points noirs, nids-de-poule, signalements | `points_noirs` ; **`signalements_citoyens`** : canaux PWA / SMS-USSD / agent, qualification, doublons, `numeroPublic` ; statut **`CONVERTI_OT`** | **PA** | le chemin `CONVERTI_OT` mène vers le module **gelé** des ordres de travaux (ADR-003) — chemin à documenter, pas à étendre ; **aucune politique** de signalement citoyen écrite ; IO-09 PAT absent | documenter le chemin de conversion ; dédoublonnage IO-09 | **G-4** politique de signalement |
| **12. Matériaux** | gisements : localisation, type, statut de vérification | **aucune table** — vérifié par motif `gisement\|materiau` sur le schéma | **AB** | tout | import en couche de référence, localisation seulement (§ A.3) | convention ONR |
| **13. Statistiques** | annuaire statistique, exports contrôlés, indicateurs de couverture, qualité, ancienneté | `/api/public/carte/geo` avec `methode`, `calculeeA` ; `couverture.reseau.ts` reproductible (212 ms) ; 3 périmètres nommés | **PA** | aucun extrait au format annuaire ; le tableau de bord ignore portions et qualité ; périmètre pas affiché partout | IO-08 ; S-01 reproductibilité, S-02 périmètre affiché | aucune |
| **14. Gouvernance** | rôles, échanges, propriété, publication | RBAC testé ; audit 1 506 l. ; `DATA_SOURCE_OF_TRUTH.md` ; `INSTITUTIONAL_DATA_GOVERNANCE.md` | **PA** | ABAC par territoire partiel (5 domaines sur 8) ; **aucune convention** AGEROUTE ↔ ONR ; IdP non identifié | questionnaire ANASUR ; convention | **D-08, D-09**, G-1 à G-10 |

**Bilan : 0 TT, 1 TP, 7 PA, 3 EA, 1 BL, 2 AB.** Aucune case « à vérifier » ; trois lignes
portent un **accès à la preuve bloqué et dit** (remplissage de colonnes, production gelée).

## Ce que la matrice établit

- **Le socle patrimonial existe et est testé** ; **aucun moteur décisionnel ne l'est**. Les
  domaines 8 à 10 sont vides, et le § 7.7 l'explique autant que le code : ils n'ont rien à
  calculer tant que les domaines 2 et 6 sont à zéro observation.
- **Deux domaines sont en attente d'approbation, pas de développement** (6 et 9) : le mécanisme
  existe, les paramètres ne font pas foi.
- **Une seule clé d'échange est en service**, vers DigitalRoad (domaine 4) — le modèle à
  généraliser vers l'ONR.
- **Le signalement citoyen existe** (domaine 11), ce que les rapports antérieurs omettaient ;
  son chemin de conversion vers les ordres de travaux touche la frontière D1 et doit être
  documenté comme tel.

## Ce qui la débloque

| Réponse ou décision | Lignes qu'elle fait avancer |
|---|---|
| Nomenclature officielle et codification (G-1, D-06) | 1, 3, 13 |
| Texte de la directive 11/2009 (P-3) | 3, 6 |
| Millésime et largeur des barèmes (D-07) | 9, 10 |
| Formats L²R (P-2) | 2, 3, 7, 10, 13 |
| Premier export approuvé (ONR ou ANASUR) | 1, 2, 7, 12 |
| Pilote corridor (G-8) | 2, 6, puis 8 à 10 |
