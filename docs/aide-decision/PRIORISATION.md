# Priorisation explicable des interventions (lot AD-3, backend)

Branche `feat/aide-decision`. Ce document décrit le moteur de priorité technique expliquée du module d'aide à la décision : ce qu'il calcule, ce qu'il refuse de calculer, comment il s'étend au moteur de programmation v2 existant (il n'en est pas un second), et la forme exacte des réponses. Tout ce qui est écrit ici comme « mesuré » ou « prouvé » a été exécuté (voir le rapport du lot) ; le reste est dit non vérifié. Tous les poids, seuils et plafonds sont PROVISOIRES et sans source (décision D-01 ouverte) : aucun n'est une règle officielle.

## 1. Principes (cahier, paragraphes 6.1 à 6.4)

- Une donnée absente n'est pas un zéro, et ne classe jamais une intervention « en faible priorité » en silence.
- Le classement est reproductible : mêmes entrées, même ordre, même empreinte SHA-256.
- Une priorité calculée n'est pas une décision, une estimation de coût n'est pas un engagement : chaque réponse porte la mention « consultatif, non engageant » (`avertissement`).
- Le module est en lecture seule sur le patrimoine. Il n'écrit que les versions de paramètres (par le mécanisme du moteur) et l'audit.

## 2. Une extension du moteur v2, pas un second moteur

| Besoin | Réutilisé | Fichier |
|---|---|---|
| Normalisation de l'état, de l'importance de l'axe (trafic), de la sécurité (points noirs) | les facteurs que `calculerRisque` évalue (une seule normalisation dans le dépôt) | `engines/risque.noyau.ts` (non modifié) |
| Coût estimé | `choisirTraitement` et `estimer` | `engines/traitement.noyau.ts`, `engines/cout.noyau.ts` |
| Ordre d'arbitrage coût-efficacité | le rang du simulateur lui-même : `construireScenario` avec une enveloppe illimitée | `programmation/scenario.noyau.ts` (non modifié) |
| Divergence de longueur | le détecteur de qualité `LONGUEUR_ECART_GEOMETRIE` et ses seuils provisoires | `qualite/detecteurs.noyau.ts` |
| Paramètres : version, auteur, approbation, audit, immuabilité | `parametres_programmation`, `creerParametres`, `approuverParametres` | `programmation/moteur.service.ts` (non modifié) |
| Canonique et empreinte | `canonique`, `sha256Hex` | `programmation/canonique.ts` |

Ajouts : `priorite.parametres.ts` (bloc de paramètres), `priorite.noyau.ts` (calcul pur), `priorite.requete.ts` (lecture des paramètres de requête), `priorite.depot.ts` (SQL en lecture seule), `priorite.service.ts`, `api-v2/aide-decision.interventions.routes.ts`. Une seule modification de fichier existant : `parametres.noyau.ts`, additive (voir 5).

Les trois scoreurs que l'audit avait trouvés (`lib/priorisation.ts` V1, le moteur v2, le scoreur de `DecisionPage.tsx`) ne sont pas augmentés d'un quatrième : l'API ci-dessous est la seule source que l'écran doit lire. Le V1 et le scoreur du client sont à retirer (voir 11).

## 3. Deux classements, deux noms

| | `prioriteTechnique` | `ordreArbitrage` |
|---|---|---|
| Question | quel tronçon a le plus besoin d'être examiné | que retenir en premier sous une enveloppe budgétaire |
| Dépend du coût | non | oui : risque attendu / coût en milliards de GNF |
| Source | critères du cahier 6.2 (hors coût) | le simulateur (`construireScenario`) |
| Tronçon critique et cher | reste en tête | peut être classé après un tronçon moyen et bon marché |
| Absent quand | l'état n'est pas évalué, ou la couverture est trop faible | le simulateur ne sait pas classer la ligne (`motifAbsence`) |

Le simulateur utilise l'ordre d'arbitrage. La priorité technique ne dépend jamais du coût : multiplier tous les prix par dix ne change aucun rang technique (testé). Un tronçon que le simulateur ne classe pas a `ordreArbitrage.rang = null` et dit pourquoi ; il n'est pas « dernier ».

## 4. Les critères (cahier 6.2)

Sept critères sont déclarés (`modele.criteres` dans chaque réponse). Valeurs normalisées sur 0 à 100, arrondies à 4 décimales avant agrégation.

| Code | Cahier | Disponibilité | Source | Normalisation | Prudence |
|---|---|---|---|---|---|
| `ETAT_GRAVITE` | État / gravité | disponible | `troncons.etat` (statut de la valeur dans `valeurs_qualite`) | `etatVersRisque` des paramètres (BON 10, MOYEN 35, MAUVAIS 65, CRITIQUE 90 par défaut) | NON_EVALUE n'est pas un état : exclusion `ETAT_NON_EVALUE`. La gravité des défauts n'est pas modélisée. |
| `IMPORTANCE_AXE` | Importance de l'axe | partiel | `troncons.traficMoyenJma` (date du comptage affichée), à défaut `criticiteStrategique` (provenance non documentée) | trafic / plafond × 100 borné, ou criticité telle quelle sur 0 à 100 | La classe de route n'est PAS convertie en importance. |
| `SECURITE_CRITICITE` | Sécurité / criticité | disponible sous condition | `points_noirs` rattachés au tronçon et CONFIRMÉS | nombre / plafond × 100 borné | voir 6 |
| `ACCESSIBILITE_SERVICE` | Accessibilité / service | NON DISPONIBLE | aucune | sans objet | Aucune donnée structurée : critère déclaré, jamais inventé. Poids d'amorçage nul. |
| `URGENCE_TEMPORELLE` | Urgence temporelle | disponible sous condition | `inspections` (date, état observé) | ancienneté de la dégradation connue / plafond × 100 borné | voir 7 |
| `COUT_EFFICACITE` | Coût / efficacité | disponible | barèmes, matrice de dégradation | ratio du simulateur | Rôle `ARBITRAGE` : pas un poids de la priorité technique. |
| `MATURITE_FAISABILITE` | Maturité / faisabilité | NON DISPONIBLE | aucune | sans objet | Critère déclaré, jamais inventé. Poids d'amorçage nul. |

Formule : `score = somme(poids × valeur) / somme(poids)` sur les critères pondérés ET disponibles. Les `points` d'un critère valent `poids × valeur / somme des poids disponibles` ; leur somme redonne le score à l'arrondi près.

Poids d'amorçage (PROVISOIRES, sans source) : état 40, importance 25, sécurité 20, urgence 15, accessibilité 0, maturité 0. Couverture minimale 0,3.

## 5. Données absentes : score incomplet, exclusions, jamais un zéro

Pour chaque tronçon :

1. Chaque critère pondéré est soit disponible (valeur, points, provenance), soit manquant avec sa raison (`criteresManquants`).
2. `couverture` = part du poids total portée par les critères disponibles (0 à 1).
3. L'état est le seul critère ESSENTIEL (même avec un poids nul). Sans état évalué : ligne EXCLUE, `exclusion.code = ETAT_NON_EVALUE`, `score = null`, `rang = null`. Elle n'est ni classée bonne ni classée faible : elle n'est pas classée. Les lignes exclues sont listées APRÈS les lignes classées, avec leur motif.
4. `couverture` inférieure à la couverture minimale : ligne EXCLUE, `COUVERTURE_INSUFFISANTE`.
5. Sinon, le score est calculé sur les critères disponibles. Si `couverture < 1`, `scoreIncomplet = true` et `statut = "INCOMPLET"` : il classe sur ce qui est connu, et la liste de ce qui manque est rendue avec lui. Ce n'est pas comparable terme à terme à un score complet ; les deux sont dans le même ordre et le statut les distingue (filtre `statutScore`).
6. Un poids nul exclut un critère explicitement (il n'apparaît pas dans les contributions) ; un poids non nul sur un critère sans donnée (accessibilité, maturité) le rend manquant sur toutes les lignes, avec la raison.

Sur la base de production actuelle, la plupart des tronçons auront un score incomplet ou seront exclus : c'est l'état des données (état renseigné sur une minorité de tronçons, trafic et criticité vides, inspections peu nombreuses), pas un défaut du calcul. Cette affirmation sur la production n'est pas vérifiée ici (aucune donnée de production n'a été lue).

Paramètres associés : `couvertureMinimale`, `registrePointsNoirsMinimum`, `urgenceAnciennetePlafondJours`, `poids`, `validiteDe`, `validiteA`.

## 6. « Zéro point noir » ou « registre non fiable » (correction du constat d'audit n° 2)

L'ancienne lecture (`chargerCandidats`) donnait la valeur 0 à tout tronçon sans point noir dès que le registre national n'était pas vide : un tronçon dont personne n'a jamais relevé les points noirs descendait en silence. Règle retenue (`resoudreSecurite`, testée sur ses quatre cas) :

| Cas | Code | Valeur |
|---|---|---|
| au moins un point noir CONFIRMÉ rattaché au tronçon | `POINTS_NOIRS_CONFIRMES` | ce nombre |
| aucun, et le registre de la RÉGION compte au moins `registrePointsNoirsMinimum` points confirmés | `ZERO_REGISTRE_EXPLOITE` | 0 (une donnée : « aucun point noir enregistré », le registre n'est pas prouvé exhaustif, la note le dit) |
| aucun, et le registre de la région est plus petit | `REGISTRE_NON_EXPLOITE` | critère ABSENT, listé dans `criteresManquants` ; jamais 0 |
| source illisible | `SOURCE_ILLISIBLE` | critère ABSENT |

Confirmé = statut de validation nul ou `VALIDE`. Une alerte `A_VALIDER` ou `A_CORRIGER` reste distincte d'un risque validé : elle ne compte ni dans le score ni dans le registre, mais elle est dite dans la note. `REJETE` et les points supprimés ne comptent nulle part.

La granularité est la région, la plus fine que la base permette (un point noir porte une région, un tronçon seulement quand il y a été rattaché). Le minimum (défaut 5, PROVISOIRE, sans source) est un paramètre de la version. C'est une règle de conduite réversible et à faire valider par le métier ; elle ne prouve pas que le registre d'une région est complet.

## 7. Urgence temporelle

Lecture retenue du cahier (« ancienneté du défaut, évolution observée ») : l'ancienneté de la DÉGRADATION CONNUE, lue dans l'historique des inspections. La « série courante » est la suite ininterrompue, jusqu'au dernier constat, d'inspections à l'état MAUVAIS ou CRITIQUE ; son début est la date de la première. Valeur = jours entre ce début et la date de référence, divisés par `urgenceAnciennetePlafondJours` (défaut 730, PROVISOIRE), × 100, borné. Si la dernière inspection n'est pas dégradée, la valeur est 0 : c'est un constat (la note cite l'inspection), pas une absence. Sans inspection datée exploitable : critère absent.

Les constats postérieurs à la date de référence, de date invalide ou sans état (NON_EVALUE) sont écartés et comptés dans la note. À date égale, le pire état de la journée est le dernier (ordre total indépendant de l'ordre des entrées).

Cette lecture diffère de la formule du brief du lot (« ancienneté du dernier constat »), qui mesure la fraîcheur de l'information et non l'urgence ; la fraîcheur est rendue à part (`dernierConstat`). Décision d'architecte demandée (voir 12).

## 7 bis. Reproductibilité

Tri total : score décroissant (en dix-millièmes entiers), puis code, puis identifiant, comparés par unité de code UTF-16 sans locale ; les exclues par motif, code, identifiant. Aucune horloge dans le noyau (la date de référence est un paramètre, renvoyée dans `dateReference`), aucun hasard, additions dans l'ordre fixe des critères, arrondis à 4 décimales. Mêmes entrées dans un autre ordre (candidats, barèmes, catalogue, matrices, constats) donnent la même sortie canonique octet pour octet (testé sur le texte canonique complet).

`empreinte` est le SHA-256 de la PROJECTION canonique de décision (`projectionEmpreinte`) : modèle, paramètres (version, approbation, bloc), date de référence, et pour chaque ligne toutes les valeurs de décision (identifiant, rang, score, couverture, contributions, critères manquants, motif d'exclusion codé, ordre d'arbitrage, coût et barème, longueurs, localisation, version du modèle et des paramètres). Les phrases explicatives (notes, motifs) n'y entrent pas : elles sont dérivées des valeurs. Raison : hacher les 8 Mo de texte d'un classement de 3 000 lignes coûtait plus que le classement ; la projection garde la garantie utile (un fait, un poids ou une date qui change fait changer l'empreinte, testé). Elle porte sur le classement ENTIER de la sélection, pas sur la page : deux pages d'un même classement ont la même empreinte. La date de référence est la date du serveur (UTC) : l'empreinte change d'un jour à l'autre si une valeur dépend du jour (urgence, âge du constat).

## 8. Paramètres versionnés

Le bloc `priorite` est une clé OPTIONNELLE des `valeurs` d'une version de `parametres_programmation` : aucune table, aucune migration. La contrainte `pp_valeurs_completes` n'exige que les dix clés du risque et admet une clé de plus (testé). Une version porte donc : les valeurs du risque + le bloc de priorité.

| Exigence du cahier | Où |
|---|---|
| version | `version` de la ligne |
| période de validité | `priorite.validiteDe` / `validiteA` (hors validité : résultat PROVISOIRE avec le motif) |
| auteur | `creeParId` de la ligne (session, jamais le corps) |
| statut d'approbation | `approuveeLe` / `approuveeParId` ; PROVISOIRE tant que nul |
| historique | `audit_logs` (CREATE, VALIDATE), liste des versions dans la fiche |
| immuabilité | déclencheur de la base : les valeurs d'une version ne changent pas (prouvé par le banc) |

Choix de la version : celle que demande `parametresId`, sinon la version approuvée la plus récente, sinon l'unique version existante ; plusieurs versions provisoires sans approbation donnent `422 PARAMETRES_A_PRECISER` (le moteur ne choisit pas « la dernière créée »). Une version sans bloc (la version semée) est calculée avec le bloc d'amorçage du code, et la réponse le dit (`blocOrigine = AMORCAGE_CODE`, motif de provisoire).

Séparation des tâches : l'approbation est déléguée à `moteur.service.approuverParametres(client, id, ctx)`, point d'accroche du lot 7 (refus d'approuver sa propre version). Les routes de ce lot n'ajoutent aucune logique d'approbation ; elles transmettent le rôle de la session (`ctx.role`). Approuver une version approuve TOUTES ses valeurs, risque et priorité (un seul enregistrement immuable).

Changements additifs de `parametres.noyau.ts` : import de `priorite.parametres.ts`, champ optionnel `priorite?` de `ValeursParametres`, et `validerValeurs` accepte la clé `priorite` (validée avec toutes ses erreurs) en plus des dix clés. Le jeu d'amorçage semé par la migration est inchangé (testé).

## 9. API (préfixe `/api/v2/aide-decision`, module `decision`)

Montage par l'orchestrateur : `import { aideDecisionInterventionsRouter } from "./aide-decision.interventions.routes"` puis `router.use("/aide-decision", aideDecisionInterventionsRouter)`.

Ordre des gardes : authentification, module `decision`, rôle, ressource désignée (404 identique), validation des entrées (400), service. Les lectures ne sont pas auditées. En-têtes `Cache-Control: private, no-cache`.

| Route | Rôle | Contenu |
|---|---|---|
| `GET /interventions` | tout compte avec le module | liste classée, curseur, filtres |
| `GET /interventions.geojson?bbox=` | idem | carte |
| `GET /interventions/:id` | idem | fiche |
| `GET /priorites/parametres` | idem | versions et bloc de priorité |
| `POST /priorites/parametres` | ADMIN, GESTIONNAIRE | nouvelle version provisoire |
| `POST /priorites/parametres/:id/approuver` | ADMIN | approbation |
| `POST /priorites/parametres/:id/desapprouver` | ADMIN | retrait, `{ motif }` obligatoire |

### Filtres de `GET /interventions` et `.geojson`

`regionId`, `classe` (RN, RR, RU, PISTE, NON_CLASSEE), `etat` (BON, MOYEN, MAUVAIS, CRITIQUE, NON_EVALUE), `depuis` / `jusqua` (AAAA-MM-JJ, sur la date du dernier constat ; une intervention sans constat daté est écartée quand une borne est donnée), `parametresId`. Listes : `a,b`, `a=..&a=..` ou `a[]=..`. Ces filtres RESTREIGNENT les candidats AVANT le classement : le rang est celui de la sélection (sans filtre, celui du périmètre du compte). `limite` : 1 à 100 (défaut 25) pour la liste ; 1 à 1000 (défaut 300) pour la carte. `curseur` : jeton rendu par `page.prochainCurseur`. `statutScore` (CALCULE, INCOMPLET, EXCLU) : filtre d'AFFICHAGE après classement, les rangs ne changent pas. `statutChantier` est accepté et NON APPLIQUÉ (aucune donnée) : il est renvoyé dans `filtres.nonAppliques` avec la raison. Non disponibles faute de données structurées : préfecture, axe, bailleur, gravité, type d'intervention (contrat, paragraphe 3). Tout paramètre inconnu ou mal formé donne 400.

### Réponse de `GET /interventions`

```
{
  data: LigneIntervention[],
  page: { limite, prochainCurseur: string | null, aSuivant: boolean },
  total: number,            // taille de la SELECTION du compte (son périmètre, filtres compris), jamais un total national pour un compte régional
  totalAffiche: number,     // après statutScore
  resume: { candidats, classes, complets, incomplets, exclus, parMotifExclusion: { [code]: number } },
  perimetre: { national: boolean, regions: number[] | null },
  filtres: { appliques: {...}, nonAppliques: [{ filtre, valeurs, raison }] },
  modele: { id, version, formule, arbitrage, criteres: [{ code, libelle, role, disponibilite, source, normalisation, prudence, poids, ponderee }], regles: {...}, limites: string[] },
  parametres: { id, version, source, auteurId, creeLe, motif, approuveeLe, approuveeParId, etiquette, blocOrigine: "VERSION" | "AMORCAGE_CODE", validite: { de, a, horsValidite } },
  dateReference: "AAAA-MM-JJ", provisoire: boolean, motifsProvisoire: string[], avertissement: string, empreinte: string  // SHA-256 de la projection canonique de decision du classement ENTIER (voir 7 bis)
}
```

`LigneIntervention` :

```
{
  id, objet: { type: "TRONCON", id, code, nom },
  regionId, regionNom, classe, prefecture,
  etatPhysique,                                    // BON | MOYEN | MAUVAIS | CRITIQUE | NON_EVALUE | null
  dernierConstat: { date: "AAAA-MM-JJ" | null, source: "inspections.dateInspection" | "troncons.dateDerniereEvaluation" | null, ageJours: number | null },
  prioriteTechnique: {
    statut: "CALCULE" | "INCOMPLET" | "EXCLU", rang: number | null, score: number | null, scoreIncomplet: boolean, couverture: number,
    contributions: [{ critere, libelle, poids, poidsPct, valeurNormalisee: number | null, points: number | null, brut, provenance: string | null, note }],
    criteresManquants: [{ critere, libelle, poids, raison }],
    exclusion: { code: "ETAT_NON_EVALUE" | "COUVERTURE_INSUFFISANTE" | "AUCUN_CRITERE_PONDERE", motif } | null
  },
  ordreArbitrage: { rang: number | null, ratioPointsParMilliardGnf: string | null, risqueCourant: number | null, risqueAttendu: number | null, motifAbsence: { code, detail } | null },
  confiance: { niveau: "HIGH" | "MEDIUM" | "LOW" | null, statutEtat: string | null, source: string | null, observeLe: string | null },
  completude: number,                              // = prioriteTechnique.couverture
  sources: { troncon: { type, confiance }, etat: string | null },
  coutEstime: { montantGnf: string, devise, unite, classePrecision, margePct, provisoire, hypothesesManquantes: string[], traitement: { code, libelle },
                bareme: { id, code, typeIntervention, coutKmGnf: string, anneeReference, largeurChausseeM, approuve, version, source, validDe, validA }, longueurM, calcul } | null,
  coutNonEstimable: { code, motif } | null,       // exactement un des deux est non nul
  longueur: { metierKm: number | null, metierDerivee: boolean | null, geometriqueM: number | null, utiliseeM: number | null, longueurOrigine: "LONGUEUR_KM" | "GEOMETRIE" | null,
              divergence: { signalee: boolean, ecartRelatif: number | null, seuilRelatif, seuilAbsoluMinKm, statutSeuil: "PROVISOIRE" } },
  localisation: "valide" | "invalide", localisationMotif: string | null,
  provisoire: boolean, modeleVersion: string, parametresVersion: string
}
```

Les montants sont des chaînes de chiffres. Les lignes sont dans l'ordre total : classées (rang croissant), puis exclues (par motif, code, identifiant). Pagination par curseur à clé (position dans cet ordre) : stable, sans doublon ni saut ; un curseur d'une autre version de paramètres donne 400 `CURSEUR_INCOMPATIBLE`.

### Réponse de `GET /interventions.geojson`

`FeatureCollection` avec, en plus : `total` (nombre d'interventions à géométrie exploitable dans l'emprise, avant plafond), `tronque`, `limite`, `ordrePlafonnement` (texte), `bbox`, `horsGeometrie` (interventions de la sélection sans géométrie exploitable : elles restent dans la liste, avec `localisation: "invalide"`, et ne sont PAS sur la carte), `selection`, `filtres`, `parametresVersion`, `provisoire`, `motifsProvisoire`, `avertissement`, `dateReference`, `empreinte`. Chaque `Feature` : `id`, `geometry` (LineString simplifiée à ~1 pixel pour 2 000 pixels de large), `properties: { id, code, nom, rang, score, scoreIncomplet, statutScore, etatPhysique, classe, regionId, couverture, rangArbitrage }`. `bbox` obligatoire (`ouest,sud,est,nord`), côté de 10 degrés au plus. Le rang est celui de la liste (un seul classement, pas un classement local à la zone). Ordre de plafonnement : rang de priorité technique croissant, puis les non classées.

### Réponse de `GET /interventions/:id`

`{ intervention: LigneIntervention, motif: string, limites: string[], modele, parametres, fiches: [{ id, reference, scenarioId, annee, parametresVersion, statut, rangStatut, statutDepuis, figeLe, figeParId, transitionsPossibles: string[] }], historique: { recalculs: { disponible: false, raison }, decisions: [{ ficheId, rang, de, vers, origine, motif, auteurId, enregistreLe }], parametres: [{ version, creeLe, auteurId, approuveeLe, approuveeParId, utilisee }] }, actions: { disponibles: [], nonDisponibles: [...], raison }, provisoire, motifsProvisoire, avertissement, dateReference, empreinte }`.

Actions : `disponibles` est VIDE et la raison est dite. Aucun workflow n'existe pour une intervention candidate : le cycle de vie du moteur (BROUILLON, PROPOSE, ARBITRE, APPROUVE) ne s'applique qu'aux fiches figées depuis un scénario retenu (`POST /programmation/moteur/simulations/:id/fiches`). Examiner, affecter, proposer à la programmation, reporter et rejeter avec motif ne sont pas implémentés et n'ont pas été inventés. Les décisions humaines sont les statuts des fiches figées du tronçon ; l'historique des recalculs n'existe pas (le classement est calculé à la volée et non enregistré).

### Paramètres

`GET /priorites/parametres` : `{ data: [...] }`, chaque version avec `id, version, source, valeurs, motif, creeParId, createdAt, approuveeLe, approuveeParId, provisoire, etiquette, modeleVersion, priorite: { present, origine, bloc, raison }`.

`POST /priorites/parametres` (201) : corps strict `{ version, motif?, baseParametresId?, priorite: { poids?: {6 critères}, validiteDe?, validiteA?, couvertureMinimale?, registrePointsNoirsMinimum?, urgenceAnciennetePlafondJours? } }`. Les valeurs du risque sont reprises de la version de base (par défaut celle que le moteur choisirait), le bloc de priorité part de l'amorçage et reçoit les surcharges. Valeurs incohérentes : 422 avec TOUTES les erreurs. Version existante : 409 `VERSION_EXISTANTE`. L'auteur est celui de la session (un champ `creeParId` dans le corps donne 400). Audit CREATE dans la même transaction. Approbation et retrait : 409 `BLOC_PRIORITE_ABSENT` pour une version sans bloc ; audit VALIDATE / UPDATE.

## 10. Accès et territoire

`requireAuth`, `requireModuleAccess("decision")`, périmètre régional (`regionsVisibles`). Un compte régional ne voit que les tronçons de ses régions ; `total`, `selection`, `resume` et `horsGeometrie` sont ceux de son périmètre ; un `regionId` hors périmètre donne 403 `HORS_PERIMETRE`. `GET /interventions/:id` : tronçon d'une autre région, inconnu, supprimé, non candidat (à valider, voirie promue) ou d'identifiant mal formé répondent le MÊME 404 `{ error: "intervention introuvable", code: "INTROUVABLE" }`. Les versions de paramètres sont des réglages nationaux, non filtrés (comme `/programmation/moteur/parametres`).

## 11. Performance

Calcul à la volée, sur un instantané unique (transaction en lecture répétable), borné à `MAX_CANDIDATS` = 3 000 tronçons (plafond du moteur) : au-delà, 422 `PERIMETRE_TROP_LARGE` avec la consigne de restreindre (région, classe, état), pas de classement partiel. Le réseau classé (~2 000 tronçons) tient sous le plafond. Aucun cache : un classement périmé serait un classement faux. Mesure du banc `aide-decision-priorites.integration.mts` (3 000 candidats générés dans une TRANSACTION ANNULÉE du clone jetable, 5 passes après une passe à blanc, poste de développement chargé par d'autres processus, donc des durées pessimistes et dispersées) : lecture SQL des faits 2,7 s en médiane (min 2,5 s, max 3,1 s) ; calcul du noyau 2,0 s (1,3 à 2,4 s) ; service complet pour une page de 25 lignes 4,9 s en médiane (4,3 à 6,3 s), réponse de 79 Ko. À titre de comparaison, le coeur de la requête SQL (jointures latérales, longueur géodésique et validité de géométrie sur 3 000 lignes) s'exécute en 0,4 s dans PostgreSQL seul (`EXPLAIN ANALYZE`, transaction annulée sur `replay`) : le reste est le transport Prisma et les autres jointures. Avant l'optimisation du hachage (projection au lieu du texte entier), le noyau seul mesurait 2,7 à 6,8 s (médiane 3,9 s) sur une exécution précédente du banc, dans des conditions de charge comparables mais non identiques. Ces durées ne sont PAS celles d'un serveur de production et aucun seuil du cahier n'est prouvé ; un écran qui appelle la liste puis la carte paie deux calculs complets (pas de cache). Si cela devient gênant, la piste est un cache de classement invalidé par une empreinte de version des données d'entrée, pas un cache à durée fixe.

## 12. Limites, décisions ouvertes, modifications hors périmètre

Limites : tronçons seulement (pas d'ouvrages d'art) ; poids, seuils et plafonds provisoires et sans source ; deux critères du cahier sans donnée ; pas de gravité des défauts ; la granularité régionale du registre des points noirs ne prouve pas son exhaustivité ; pas d'historique de recalcul ; pas d'axe routier en base.

Décisions de l'architecte : (a) lecture de l'urgence (voir 7) ; (b) minimum du registre des points noirs et sa granularité ; (c) poids d'amorçage et couverture minimale ; (d) les rangs sont ceux de la sélection filtrée (filtres avant classement) ; (e) un compte régional peut-il créer une version de paramètres nationale (comme aujourd'hui côté moteur) ?

**Modification faite par la revue du 27/10/2026** (elle était demandée hors périmètre du lot 3) : `moteur.depot.chargerCandidats` relève maintenant les trois comptes (points noirs confirmés du tronçon, alertes non confirmées, confirmés du registre de la région) et applique `resoudreSecurite` avec le `registrePointsNoirsMinimum` de la version de paramètres (`blocEffectif(parametres).bloc`), au lieu de l'ancien `CASE WHEN EXISTS (registre non vide) ... ELSE NULL` qui donnait 0 à tout tronçon sans point noir. La construction du candidat (longueur métier ou géométrique avec son origine, trafic, criticité) est la fonction unique `candidatDepuisMesures` de `priorite.noyau.ts`, appelée par la liste et par le chargement du simulateur, du moteur v2 et du plan pluriannuel. Le simulateur et la liste classent donc les mêmes tronçons de la même façon (`moteur.depot.candidats.test.ts` et le banc `aide-decision-priorites`). Les bancs `programmation`, `ppe` et `aide-decision-scenarios`, dont l'oracle SQL comptait les points noirs rattachés au tronçon, reçoivent maintenant 5 points « de registre » par région pour que le zéro soit une donnée. Conséquence : un tronçon d'une région au registre non exploité n'a plus de facteur sécurité et est souvent écarté `RISQUE_NON_CALCULABLE` par le simulateur, comme la liste l'indique déjà. À retirer après recette : `lib/priorisation.ts` (V1) et le scoreur de `DecisionPage.tsx`.
