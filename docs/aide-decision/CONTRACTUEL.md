# Aide à la décision : suivi contractuel (AD-LOT-5)

Branche `feat/aide-decision` (worktree `F:\ageroute-ad`). Contrat : `docs/aide-decision/CONTRAT-AD.md` (§1 principe 6, §4, §5, §7, §9). Cahier §8. Ce document décrit ce qui est construit, ce qui est PROVISOIRE, et ce qui manque. **Rien n'est déployé, rien n'est monté** : le routeur est fourni, l'orchestrateur le monte.

## 1. Ce que c'est, et ce que ce n'est pas

Une **lecture seule** de la copie locale des objets contractuels (`marches`, `decomptes`, `avancement_marche`, `marches_chantiers`, `chantiers`, `troncons`, `programmes_budgetaires`, `bailleurs`, `regions`). DigitalRoad est la source de vérité des marchés, décomptes et paiements (`DATA_SOURCE_OF_TRUTH.md` §2.5) ; il n'est **pas intégré** (B-11) et la copie du Géoportail est **gelée** (ADR-003, B-08), sans clé commune ni date de synchronisation. Aucune intégration n'est simulée : toute réponse porte `source.integree = false`, `source.copieGelee = true`, `fraicheur.derniereSynchronisation = null`, `donneesPartielles.partiel = true` et la phrase « Données contractuelles partielles : source de vérité externe non intégrée (DigitalRoad) ».

Ni migration, ni modification de `schema.prisma`. Aucune écriture, donc aucun audit.

## 2. API

Montage à faire par l'orchestrateur dans `backend/src/api-v2/index.ts` : `apiV2Router.use("/aide-decision", aideDecisionContractuelRouter)` (import depuis `./aide-decision.contractuel.routes`). Il faudra aussi, côté sécurité (lot 7), ajouter les deux routes à `securite/inventaire-acces.test.ts` et à la matrice de `docs/securite/CONTROLE-ACCES.md` (module `marches` ET `decision`, périmètre filtré dans le service).

| Route | Rôle |
|---|---|
| `GET /api/v2/aide-decision/contractuel` | liste des marchés recensés (pagination par curseur), synthèse, contrôles de cohérence, définitions |
| `GET /api/v2/aide-decision/contractuel/marches/:id` | fiche d'un marché, décomptes compris |

**Gardes, dans l'ordre** : `requireAuth` (compte relu en base), `requireModuleAccess("marches")` ET `requireModuleAccess("decision")`, validation de l'entrée (400), `requireTerritoire` sur `regionId` (403 `HORS_PERIMETRE` si un compte régional demande une autre région). Le périmètre des **résultats** est ensuite appliqué par le service, marché par marché. Réponses `Cache-Control: no-store`.

**Paramètres de la liste** : `regionId`, `classe`, `etat`, `statutChantier`, `depuis`, `jusqua` (filtres partagés du contrat §3), plus `statutMarche`, `bailleurId`, `limite` (1 à 100, 25 par défaut) et `curseur`. Les listes se passent séparées par des virgules ou en paramètres répétés. Les clés inconnues (filtres des autres onglets) sont ignorées. Toute valeur mal formée est un **400** `PARAMETRES_INVALIDES` (entier hors bornes, énumération inconnue, date impossible, `depuis` après `jusqua`, paramètre répété ou imbriqué, curseur forgé).

**Sémantique des filtres** : `regionId` = marchés dont une région déduite est celle-là ; `statutChantier`, `classe`, `etat` = « au moins un chantier ou tronçon lié » ; `depuis` / `jusqua` = chevauchement de la période contractuelle [début prévu ou signature, fin prévue] avec la fenêtre, un marché sans aucune date étant **exclu et compté** (`perimetre.exclusParFiltre.sansDate`).

**Curseur** : clé (date de création décroissante, identifiant croissant), stable si un marché est inséré ou retiré entre deux pages ; un curseur qui ne désigne plus rien donne une page vide, jamais la première page. `page.total` est le nombre de marchés du périmètre filtré (jamais un total national pour un compte régional).

**Bornes** : au plus `PLAFOND_MARCHES_ANALYSES = 2000` marchés sont lus par requête ; au-delà, `plafond.tronque = true`, la synthèse et les contrôles portent sur les 2000 plus récents et la réponse le dit. Chantiers et tronçons listés : 20 par marché dans la liste, 200 dans la fiche. Exemples de contrôle : 5.

## 3. Les séparations (cahier §8.2, contrat principe 6)

| À ne pas confondre | Traitement |
|---|---|
| marché **recensé** / actif | `synthese.marchesRecenses` compte les lignes de `marches` non supprimées. Aucun total « actifs » n'existe ; la répartition `parStatut` est celle du statut **saisi**. Libellé figé « Marchés recensés ». |
| **contractuel** / engagé | `montants.contractuel` = `marches.montantTotal`, dans la devise du marché. |
| contractuel / **engagé** | `montants.engage` est `NON_DISPONIBLE` (motif `SOURCE_NON_VALIDEE`), **toujours**, y compris dans les agrégats. Jamais dérivé du contractuel, des chantiers, des décomptes ou de `IndicateurReseauHistorique.budgetEngageCumul`. |
| engagé / **décaissé** | `montants.decaisse` = somme de `decomptes.montantGnf` dont le statut saisi est `PAYE`, tous types confondus, en GNF. La réponse dit lesquels (numéros, types, dates) et la fiche liste tous les décomptes avec « dans le décaissé : oui / non ». Sans aucun décompte : `NON_DISPONIBLE` (`AUCUN_DECOMPTE`), jamais `"0"`. |
| **prévisionnel** | programmes budgétaires `RETENU` dont le tronçon est porté par le marché (lien ou chantier) **et par aucun autre marché**. Lien INDIRECT (`etat: PARTIEL`, avertissement). Un programme dont le tronçon est partagé par plusieurs marchés est AMBIGU : imputé à aucun, signalé (`LIEN_AMBIGU`, `programmes.ambigus`). Il n'y a aucune clé marché-programme dans le schéma. |
| avancement **déclaré** / constaté | `avancement.declare` = dernière période de `avancement_marche` (physique réel), plus `avancementDeclarePct` de chaque chantier. `avancement.constate` est `NON_DISPONIBLE` (`AUCUNE_SOURCE_DE_CONSTAT`), toujours : aucune source distincte n'existe (une inspection `POST_TRAVAUX` n'est pas rattachée aux marchés). Jamais une copie du déclaré. |
| état physique / **avancement financier** | `avancement.financier` = `avancementFinancierReel` déclaré, distinct du physique et du décaissé calculé. L'état physique des tronçons (`etat`) n'est que listé, comme constat réseau, et n'entre dans aucun calcul d'avancement. |

Un montant est toujours `{ etat, valeurGnf: string | null, motif, source, avertissement }` (+ `valeurOrigine` pour une devise étrangère, `couverture` pour un agrégat). **GNF en chaîne** : un total dépasse 2^53 (le banc l'éprouve avec 2^53 + 1). Un marché en USD ou EUR n'est **pas converti** (aucun taux documenté) : `valeurGnf` nulle, montant d'origine conservé, exclu des totaux GNF et listé en « autres devises » par bailleur. Un marché sans `montantTotal` est `MONTANT_ABSENT`, jamais 0, et exclu (compté) des totaux.

Ce qui n'existe pas dans la copie et que la réponse dit en clair : **référence du marché** (on lit `chantiers.numContrat` des chantiers liés, étiqueté), **lots** (aucun champ), **entreprise** (portée par les chantiers), **avenants** et **suspensions** (aucune table), **pièces et liens source** (les documents ne portent qu'un tronçon). Le `montantGnf` des chantiers n'est pas exposé : sa nature (contractuelle, engagée, estimée) n'est définie nulle part.

## 4. Relations marché, chantier, tronçon

Qualité de chaque lien, par chantier lié : `DIRECT` (le tronçon est porté par `marches_chantiers.tronconId`), `PAR_CHANTIER` (porté par le seul `chantiers.tronconId`), `MANQUANT` (aucun tronçon non archivé), `AMBIGU` (deux tronçons différents). Pour le marché : qualité des **tronçons** = la plus faible de ses liens, avec les comptes par qualité ; qualité des **chantiers** = `MANQUANT` sans chantier actif, `AMBIGU` si un chantier est rattaché à plusieurs marchés, `DIRECT` sinon. Un chantier ou un tronçon archivé (`deletedAt`) est ignoré et compté (`archivesIgnores`).

## 5. Retard (règle PROVISOIRE, nommée dans la réponse)

Marché de statut saisi `PLANIFIE`, `EN_COURS` ou `SUSPENDU` : **retard calendaire** si `dateFinPrevue` est passée (jours, jour même exclu) ; **retard physique** si le dernier avancement montre prévu moins réel supérieur à 10 points (haute au-delà de 25) ; **réception provisoire dépassée** et **garantie à moins de 60 jours** en alertes à part. Seuils repris de `modules/marches/alertes.service.ts`, valeur `SEUILS_PROVISOIRES` du noyau. Marché terminé ou soldé : `TERMINE`, non évalué (aucune date de fin réelle). Sans date de fin ni avancement : `NON_EVALUABLE`, jamais « à jour ». **Chaque évaluation porte l'avertissement** : avenants et suspensions ignorés, les dates sont celles du marché initial ; un marché suspendu ou prolongé est compté en retard à tort. L'estimation de pénalité de l'ancien service n'est pas reproduite (aucun barème contractuel validé).

## 6. Contrôles de cohérence

Neuf contrôles, calculés sur les marchés visibles et filtrés (hors `CHANTIER_SANS_MARCHE`, calculé sur les chantiers du périmètre régional et les filtres `regionId` et `statutChantier`). Chacun donne `nombre`, `surTotal` (population examinée, même unité), `nonVerifiables` (donnée manquante : ni conforme ni en anomalie), au plus 5 exemples, et son statut `PROVISOIRE`. Les contrôles à zéro sont **conservés**.

| Code | Unité | Définition |
|---|---|---|
| `MARCHE_SANS_CHANTIER` | marchés | aucun chantier non archivé lié |
| `CHANTIER_SANS_MARCHE` | chantiers | chantier non archivé qu'aucun marché non supprimé ne rattache |
| `CHANTIER_SANS_TRONCON` | chantiers | chantier lié sans tronçon (lien ni chantier) |
| `ASSOCIATION_AMBIGUE` | marchés | tronçon du lien ≠ tronçon du chantier, ou chantier rattaché à plusieurs marchés |
| `BAILLEUR_INCOHERENT` | marchés | bailleur du marché ≠ texte libre du chantier, après normalisation (casse, accents, espaces). **Un sigle et son développé sont signalés à tort.** |
| `DECOMPTE_SUPERIEUR_MARCHE` | marchés | un décompte non rejeté, ou leur cumul, dépasse le montant contractuel (marché en GNF seulement ; USD ou sans montant = non vérifiable). Avenants non modélisés. |
| `DATES_INCOHERENTES` | marchés | fin avant début (marché ou chantier), signature après la fin, réception avant le début, paiement avant émission |
| `AVANCEMENT_HORS_BORNES` | marchés | avancement d'une période, ou d'un chantier, hors de 0 à 100 |
| `REFERENCES_DIVERGENTES` | marchés | plusieurs `numContrat` différents sur les chantiers d'un marché |

Le **détail d'un contrôle ne contient jamais de montant** : un marché masqué (§7) ne fuit rien par ce biais.

## 7. Accès et territoire

| Profil | Résultat (prouvé par `aide-decision.contractuel.routes.test.ts` et par le banc) |
|---|---|
| anonyme | 401 |
| sans module `marches` ou sans module `decision` | 403 (liste et fiche) |
| LECTEUR avec les deux modules | 200, **montants rendus** (voir D-AD5-1) |
| GESTIONNAIRE sans rattachement, ADMIN | national : tout ; `perimetre.national = true` |
| compte **régional** | uniquement les marchés dont une région déduite est dans son périmètre ; jamais de total national ; `perimetre.totalNationalFourni = false` |

**Un marché n'a pas de région** : elle se déduit des chantiers (`chantiers.regionId`) et des tronçons (du lien et du chantier). Règles :
- un compte régional voit un marché si **au moins une** de ses régions déduites est dans son périmètre ;
- si le marché **déborde** du périmètre (une région hors périmètre) ou si un chantier est rattaché à l'entrée « Non renseigné » (qui n'est pas une région), ses **montants sont masqués** (`motif: TERRITOIRE`) et les chantiers et tronçons des autres régions ne sont pas listés (`autresRegionsMasquees`), car un montant de marché ne se ventile pas par région ;
- si le territoire est **impossible à établir** (aucun chantier ni tronçon localisé, chantier archivé seul, seul « Non renseigné »), le marché n'est visible que d'un compte **national** ;
- fiche : inexistant, supprimé, hors périmètre, territoire inconnu et identifiant mal formé donnent **un seul 404, au même corps** ; le dépôt peut sur-ramener des lignes (pré-sélection par région), le noyau décide.

Le périmètre est relu en base à chaque requête (`perimetres_comptes`). Retirer toutes les régions d'un compte le rend national (D-11, comportement déjà documenté ; le banc en fait une contre-épreuve).

## 8. Fraîcheur

`fraicheur.derniereMiseAJour` = plus récente `updatedAt` rencontrée (marché, décompte) ou `createdAt` d'avancement ; `perime = true` au-delà de 90 jours (seuil PROVISOIRE, cahier 14.2, nommé dans la réponse). Cela ne mesure **pas** l'écart avec DigitalRoad, dont la date de synchronisation est inconnue.

## 9. Frontend

`frontend/src/components/decision/onglets/OngletContractuel.tsx` (export nommé, reçoit `{ filtres, onFiltres }`), composants dans `components/decision/contractuel/`, noyau pur et appels dans `lib/aideDecisionContractuel.ts` et `lib/aideDecisionContractuelApi.ts`. Tableau des marchés (légende, `scope`, noms accessibles uniques, défilement horizontal dans une région focalisable), synthèse, contrôles avec lien vers la fiche, fiche en panneau latéral (focus sur le titre, Échap ferme, le focus revient à la ligne), bandeau permanent de données partielles. États : chargement (`role="status"`), vide (message qui ne conclut pas « aucun marché n'existe »), erreur (`role="alert"` et « Réessayer »), **accès refusé** (état dédié, ni vide ni panne, jamais retenté), données périmées, actualisation échouée (les données restent). Les montants sont des chaînes groupées sans `Number`. Le filtre « statut du marché » est local à l'onglet.

`parametresContractuel` sérialise les filtres du module (listes séparées par des virgules). **À remplacer par `serialiserFiltres` du shell (lot 1) à l'intégration** : même sortie attendue. `MarchesPage` (saisie de la copie gelée, modales de modification) n'est pas réutilisée : l'onglet est en lecture seule ; ses libellés de statut et sa palette ont inspiré les pastilles.

## 10. Vérifications

Backend (depuis `backend/`) : `npx vitest run src/aide-decision/contractuel src/api-v2/aide-decision.contractuel` (noyau, filtres, service, routes). Banc : `DATABASE_URL=postgresql://<utilisateur>:<mot de passe>@127.0.0.1:5434/replay npx tsx tests-integration/aide-decision-contractuel.integration.mts` (clone `essai_ad_l5_contractuel`, créé puis détruit). Frontend (depuis `frontend/`) : `npx vitest run src/components/decision/onglets/OngletContractuel src/components/decision/contractuel src/lib/aideDecisionContractuel`.

## 11. Limites, et décisions que le métier doit prendre

- **D-AD5-1 (D-C1-1 reste ouverte)** : le modèle n'a pas de « droit financier ». Règle la plus prudente appliquée : le module `marches` est exigé ET vaut droit financier. Tout compte qui a les modules `marches` et `decision` (LECTEUR compris) lit les montants. Quand une décision créera un droit plus fin, `droitFinancierDe` (`contractuel.service.ts`) est le seul point à changer ; sans ce droit, aucun montant ne sort (testé au niveau du service, non atteignable par les routes aujourd'hui).
- **D-AD5-2** : marché multi-régional pour un compte régional, visible aux montants masqués (choix retenu), ou invisible ? Un montant de marché ne se ventile pas par région.
- **D-AD5-3** : source de vérité de l'« engagé » (B-08) ; définition de « marché actif » ; sort de `Chantier.bailleur` (texte libre) face à `Marche.bailleurId` ; nature de `RETENUE_GARANTIE` dans le décaissé ; seuils de retard, de garantie et de péremption ; traitement des marchés en devise étrangère (taux).
- **Manques de schéma (aucune migration ici)** : référence de marché, lots, avenants et suspensions (dates, durées), source de constat d'avancement, clé marché-programme, clé DigitalRoad, pièces. Les ajouter est une décision qui touche l'ADR-003 (gel).
- **Non prouvé** : la production (volumes réels, données réelles), l'exactitude de la copie face à DigitalRoad, la pertinence des seuils. Le dépôt lit au plus 2000 marchés par requête : aux volumes actuels c'est largement suffisant, sinon l'agrégation doit passer en SQL.
