# Phase 0 — votre demande, mesurée contre le dépôt

Mesuré le 13/10/2026 contre le code réel, et non de mémoire. Chaque ligne est vérifiable.

Vous avez écrit ne pas savoir où nous en sommes. La réponse courte : **la moitié de ce que
vous demandez est déjà là et vient d'être mise en production**, et ce qui manque se réduit à
un manque principal, dont tout le reste dépend.

> Ce document reste dans `docs/rai-v3/`, où dix-huit documents numérotés se suivent déjà.
> Votre prompt demandait `docs/rai/` ; un second arbre à côté du premier rendrait les deux
> introuvables. Si vous préférez l'autre chemin, je déplace l'ensemble.

## Ce qui existe déjà, et que votre demande décrit

| Votre § | Demande | État mesuré | Preuve |
|---|---|---|---|
| 1, 5 | GPS → tronçon → **abscisse locale**, PK facultatif | **fait** | `backend/src/geo/appariement.ts` |
| 5 | Confiance tenant compte de la **séparation** entre candidats | **fait** | `confiance()`, deux facteurs multipliés |
| 5 | Routes parallèles, intersections : candidats au lieu d'un choix | **fait** | drapeau `ambigu`, `candidats()` |
| 5 | **Jamais de rattachement arbitraire** | **fait** | `CONFIANCE_MINIMALE = 0.35`, refus en dessous |
| 5 | `POST /api/v2/geo/match`, `/match/batch` | **fait** | `backend/src/api-v2/geo.routes.ts` |
| 3, 8 | Défaut indépendant du PK, ponctuel/linéaire/surfacique | **fait** | `defauts` + `geom` + `emprise` |
| 8 | Catalogue de défauts **administrable en base** | **fait** | `catalogue_defauts`, 13 types |
| 8 | Gravité et étendue **séparées** | **fait** | `EtendueDefaut`, gravité distincte |
| 8 | Métré depuis les dimensions, **jamais depuis le PK** | **fait** | `MethodeQuantite`, formules portées par le catalogue |
| 10 | Workflow de validation par un tiers, le créateur ne s'approuve pas | **fait** | `backend/src/governance/validation.ts` |
| 10 | Vérification **côté backend**, pas un bouton masqué | **fait** | `validationPermise()` appelée par les routes |
| 10 | Auteur, date, avant, après, motif, validateur, horodatage | **fait** | `validations` + `audit_logs` |
| 10 | Validateur **désigné par domaine**, délégation révocable | **fait** | `backend/src/governance/delegation.ts` |
| 11 | Offline, idempotence par appareil, conflits sans écrasement | **fait** | `operations_sync`, `conflits_sync` |
| 13 | RCI explicable et versionné, **coefficients non officiels** | mécanisme fait | `backend/src/engines/condition.ts` |

Tout cela est **déployé depuis ce matin** : 41 migrations appliquées, 261 387 tronçons
inchangés. Voir `18_DEPLOIEMENT.md`.

## Ce qui manque, par ordre de dépendance

### 1. Les portions homogènes — le manque central

**Il n'existe aucun modèle de portion.** Mesuré : zéro modèle Prisma nommé `Portion`,
`RoadSection`, `SegmentPortion` ou équivalent. Un tronçon porte **un seul** `revetement` et
**un seul** `etat`, pour toute sa longueur.

C'est exactement le problème que décrit votre exemple des 20 km en quatre portions. Et c'est
le verrou : la fiche de portion, les statistiques par revêtement, la qualification en
déplacement et le filtrage cartographique en dépendent tous. Rien d'autre ne mérite d'être
construit avant.

### 2. La praticabilité n'existe pas

Mesuré : le mot n'apparaît qu'**une fois** dans tout le dépôt, dans un commentaire. Aucun
modèle, aucun enum.

Votre §7 a raison d'insister : une piste en latérite peut être en bon état et devenir
impraticable après les pluies. Confondre revêtement, état et praticabilité, c'est perdre
précisément l'information qui décide d'une mission.

### 3. Les référentiels ne sont pas configurables

Un seul catalogue vit en base, `catalogue_defauts`. Le revêtement et l'état sont des **enums
Prisma** : les étendre demande une migration, donc un déploiement.

| Référentiel | Aujourd'hui | Votre §7 demande |
|---|---|---|
| Revêtement | enum, 5 valeurs : `BITUME`, `TERRE`, `LATERITE`, `PAVE`, `NON_RENSEIGNE` | béton bitumineux, enduit superficiel, béton, pavés, latérite, terre, autre, inconnu |
| État de chaussée | enum, 5 valeurs | configurable |
| Praticabilité | **absent** | configurable |
| Accotements, assainissement, signalisation, sécurité | familles de défauts seulement | référentiels propres |

`BITUME` recouvre à lui seul béton bitumineux, enduit superficiel et béton — trois
revêtements dont les coûts de réhabilitation n'ont rien de commun.

### 4. Quatre familles d'actifs manquent

`TypeOuvrage` porte 9 valeurs : `PONT`, `DALOT`, `BUSE`, `RADIER`, `PONCEAU`,
`MUR_SOUTENEMENT`, `TUNNEL`, `PASSERELLE`, `VIADUC`. Votre §9 demande aussi **fossés,
caniveaux, signalisation et glissières**.

### 5. Deux endpoints de contexte

`GET /api/v2/field/current-context` et `GET /api/v2/road-segments/{id}/context` n'existent
pas. Ils sont faciles — mais ils doivent rendre la portion active, donc ils attendent le
point 1.

### 6. La continuité du déplacement n'est pas utilisée

Mesuré : `heading` n'apparaît nulle part. L'appariement pèse l'écart au tracé et la
séparation entre candidats, pas la direction ni la position précédente. Votre §5 la demande
« lorsque ces données sont disponibles », et c'est elle qui tranche proprement les routes
parallèles suivies en roulant.

### 7. Fiche 360° et indicateurs

Absents tous les deux, et tous deux dépendants du point 1 : une fiche de tronçon qui
n'affiche pas ses portions, et des longueurs par revêtement qu'on ne peut pas calculer sans
portions, n'auraient pas de contenu.

## Ce que je ne construirai pas sans une décision de votre part

**Le découpage automatique en continu.** Votre §6 le demande et énonce lui-même la limite :
« le système ne doit pas multiplier les portions pour chaque fluctuation mineure du GPS »,
avec « lissage et seuils configurables ». Ces seuils sont une décision métier — combien de
mètres de dégradation font une portion ? — et les inventer produirait un découpage qui a
l'air officiel. Même raisonnement que pour les coefficients du RCI.

Je construis donc le mécanisme et je laisse les seuils en base, non arbitrés.

**Les coefficients du RCI**, toujours en attente. Sans eux, pas d'état du réseau publiable,
donc pas de priorités de maintenance au sens de votre §4.

## L'ordre que je propose

1. **Les portions homogènes** : modèle, règles de découpage et fusion, détection des
   chevauchements, historique. C'est le verrou.
2. **Praticabilité et référentiels configurables**, dont les portions ont besoin pour porter
   autre chose que trois enums figés.
3. **Les deux endpoints de contexte**, puis le mode terrain qui les consomme.
4. **Fiche 360°** du tronçon et de la portion.
5. **Indicateurs** par revêtement, état et praticabilité, sur données validées seulement.
6. **Continuité dans l'appariement**, et les quatre familles d'actifs manquantes.

Votre §19 demande le parcours complet — localiser, identifier la portion, consulter,
qualifier, proposer, valider, mettre à jour. Les deux extrémités existent déjà : la
localisation et la validation. **Ce qui manque au milieu, c'est la portion.**
