# LOT UX/UI : reconception du module « Lots d'import » (page /imports)

Date : 26/10/2026. Branche : `lot/03-map-matching`. Commit de départ : `dad9695` (aucun commit à la date de ce rapport). Rapport destiné à la revue de l'architecte de supervision.
Source : cahier `Cahier_Lots_Import_AGEROUTE` (version 1.0, projet de spécification) et prompt de mission. Le cahier dit lui-même que ses capacités sont « à confronter au code existant » : c'est ce qui a été fait. **Rien n'est déployé.**

## A. Résumé exécutif

**Constat central de l'audit.** Le workflow cible du cahier (14 états, approbation d'échantillon, autorisation, import final) **n'existe pas dans le code** et n'a pas été inventé. Seule l'étape « réception et contrôle du schéma » existe : un lot naît directement `REJETE` ou `VALIDE_SCHEMA`, sans aucune transition ensuite ; `RECU`, `IMPORTE_TEST` et `IMPORTE` sont inatteignables ; aucune route d'approbation ni d'écriture au référentiel n'existe. L'en-tête de `import.service.ts` l'expliquait déjà : l'application exige un rapprochement des identifiants et un premier échantillon approuvés, qui n'existent pas.

**Ce qui a été fait.**
- Interface refondue autour de **quatre étapes dont l'état vient du serveur** : réception et contrôle réels ; échantillon à valider et import autorisé affichés « Non disponible » avec leur raison, sans bouton. Aucune étape n'est marquée terminée parce qu'on a cliqué.
- **API additive sans migration** : liste filtrée et paginée par curseur, métadonnées (formats, plafonds), sources déjà reçues, détail enrichi (empreinte, importateur nominatif, colonnes reconnues et inconnues, historique d'audit, étapes et actions calculées par le serveur), aperçu borné de lignes.
- **Durcissement de la réception** issu de deux audits indépendants (sécurité, qualité des données) : plafond de lignes, contrôle du format par le contenu, UTF-8 strict, NUL et dates hors plage rejetés au lieu d'un 500, formules neutralisées dans l'export d'erreurs, autorisation écrite de 5 caractères imprimables au moins, file d'attente de réceptions.
- **Le workflow d'approbation n'est pas implémenté** : il suppose des règles métier (séparation des tâches, rôles, seuil d'erreurs bloquantes, échantillon, preuve de l'autorisation écrite) que le cahier laisse à la DSI. Une conception sans implémentation figure dans `docs/imports/RECEPTION-LOTS-IMPORT.md` et en section G.

**État : partiel.** Interface et API livrées et testées (jsdom, navigateur réel sur API simulée, bancs PostGIS) ; parcours de bout en bout contre le vrai serveur en attente de l'agent de recette (section D.4).

## B. Agents mobilisés

| Agent | Contribution | Livrables |
|---|---|---|
| Audit frontend | Cartographie de `/imports`, écarts au cahier, correspondance honnête état serveur vers étapes, défauts d'accessibilité | rapport |
| Audit backend et API | Machine d'états réelle prouvée, H-01 à H-06, conception d'API additive, décisions DSI | rapport ; 54 tests, banc 39/39 exécutés |
| Audit sécurité et qualité | 20 attaques exécutées sur clone (volume, formules, encodage, NUL, concurrence, pool, rôles) | rapport |
| Audit des tests | Matrice AT-01 à AT-16, 10 mutations exécutées, plan de recette | rapport |
| BE-I (backend) | API additive, durcissement, limiteur, nouveau banc | `imports.routes.ts`, `import/*`, `imports-api.integration.mts`, `docs/imports/*` |
| FE-1 | Briques de présentation : étapes, bandeau, badge, états | `components/imports/*` (282 tests) |
| FE-2 | Formulaire de réception et zone de dépôt | 229 tests |
| FE-3 | Liste, filtres, détail, aperçu | 124 tests |
| FE-4 | Assemblage de la page, état dans l'URL, essai navigateur réel | `ImportsPage.tsx`, `pages/imports/useLotsImport.ts` |
| Orchestrateur | Contrat d'API commun, types partagés, arbitrages, intégration, suites complètes | `CONTRAT-API-LOTS-IMPORT.md`, `types.ts` |

## C. Changements réalisés

**Composants et API modifiés.** Backend : `api-v2/imports.routes.ts`, `import/import.service.ts`, `pivot.noyau.ts`, nouveaux `reception.noyau.ts`, `lots.vue.noyau.ts`, `lots.lecture.ts`, `limiteur.ts`. Frontend : `pages/ImportsPage.tsx` réécrite en composition, 8 composants de lots, formulaire, zone de dépôt, indicateur d'étapes, bandeau de gouvernance, badge de statut, états de liste, noyaux purs testés. Routes : `GET /api/v2/imports` (filtres `statut`, `source`, `q`, `du`, `au`, curseur, total), `GET /meta`, `GET /sources`, `GET /:id` enrichi, `GET /:id/apercu`, `POST /` enrichi. Aucune migration, aucun schéma modifié, aucune écriture au référentiel.

**Changements UX/UI réellement implémentés.**
- Bandeau « Recevoir un lot n'est pas importer » avec distinction reçu, validé techniquement, approuvé par le métier, autorisé à écrire, importé, et règles de réception repliables ; indicateur de quatre étapes (`<ol>`, `aria-current`, état et raison fournis par le serveur) ; formulaire à champs explicites avec aides, erreurs de champ, résumé d'erreurs, bouton « Recevoir et contrôler le lot » et phrase qui dit ce qui manque ; zone de dépôt accessible au clavier avec résumé du fichier avant envoi (formats et taille lus dans `/meta`, jamais en dur) ; progression de l'envoi ; états distincts : succès, déjà reçu (avec métadonnées non appliquées), lot rejeté présenté comme un résultat, refus par code, réception non confirmée (le lot a peut-être été enregistré) ; liste en tableau accessible (cartes sous 768 px), filtres statut, source, recherche, « charger plus », « N lots sur M » ; filtres et lot sélectionné dans l'URL ; panneau de détail avec empreinte, métadonnées, compteurs, colonnes reconnues et inconnues (« non calculable » plutôt qu'une liste vide), erreurs, avertissements, aperçu borné et échappé, historique ; erreur de liste distincte du vide ; 403 affiché distinctement.
- Statut `VALIDE_SCHEMA` en ambre « Schéma validé : non appliqué », jamais en vert ; icône et texte en plus de la couleur.

**Règles métier conservées.** La réception n'écrit rien au référentiel (prouvé par comptage de toutes les tables avant et après dans le banc, et par un test qui parcourt les routes montées) ; le déposant est toujours l'utilisateur authentifié ; l'empreinte SHA-256 est calculée côté serveur sur les octets reçus ; un même fichier sous la même source ne crée pas de second lot ; rôles ADMIN et GESTIONNAIRE seulement, vérifiés côté serveur.

**Règles modifiées (changements de contrat à connaître).** Sont maintenant refusés ou rejetés : plus de 20 000 lignes (400) ; fichier non UTF-8 (400, aucun lot) ; contenu incohérent avec le format déclaré (400) ; colonne dupliquée (lot rejeté) ; cellule avec NUL (ligne rejetée, plus de 500) ; date source non ISO, inexistante ou future (ligne rejetée) ; nombres `0x10`, `1e300`, `Infinity` (ligne rejetée) ; CRS `my-4326-fake` ou `EPSG:34326` (lot rejeté) ; autorisation de moins de 5 caractères ou non imprimable (400). Sont maintenant acceptées : les coordonnées 3D. Taille maximale ramenée de 50 à **25 Mo** pour s'aligner sur `client_max_body_size 25m` de nginx (décision réversible de l'orchestrateur). Le filtre `source` est insensible à la casse ; la valeur stockée n'est jamais modifiée.

## D. Vérifications (26/10/2026)

**D.1** Backend `src/import`, route et inventaire des routes : 298 tests réussis ; suite backend complète : 189 fichiers, 3 187 tests réussis ; `tsc` propre.
**D.2** Frontend : pages, hooks, composants d'imports : 15 fichiers, 710 tests réussis ; accessibilité et contraste : 43 réussis ; suite complète : 146 fichiers, 2 881 réussis ; ESLint 0 erreur ; build réussi.
**D.3** Bancs PostGIS : `import` 39/39, `imports-api` 72/72 (dont : référentiel inchangé par toutes les routes, liste et curseur stables sous insertion concurrente, 15 refus 400 sans lot ni 500, rafale de 10 réceptions de 2 500 lignes sans 500 ni 409, un autre utilisateur lit `/meta` en 200 pendant ce temps). Dix mutations de l'API et du service rejouées : toutes tuées. Mutations de la page (couleur de réussite pour un lot non appliqué, branche « colonnes non calculables », garde du clic) : 8 tests échouent comme attendu.
**D.4** Navigateur réel (Chromium, API simulée par interception) : aucun débordement horizontal de la page à 375, 768, 1024, 1280 et 1600 px, dans cinq états ; focus et défilement du détail vérifiés ; une réception = un seul POST ; frappe de recherche = une seule requête. Captures lues par l'orchestrateur : lisibles à 375 et 1280 px. Parcours de bout en bout contre le vrai serveur : **en attente** (`e2e/specs/08-imports.spec.ts`).

## E. Défauts restant à corriger

1. Tableau de liste : entre 1 536 et environ 1 700 px, il défile horizontalement dans son cadre et le bouton « Voir le détail » peut être hors champ au départ.
2. Le formulaire affiche « Schéma validé, non appliqué » (virgule) alors que le reste dit « Schéma validé : non appliqué » ; à aligner (un test l'attend).
3. Sur mobile, une zone de recherche tronquée apparaît sous l'en-tête de l'application (n'est pas de `/imports`).
4. Les lots créés avant cette version n'ont pas d'avertissements calculés ; les lots `REJETE` créés par un CSV déclaré GeoJSON restent en base ; renvoyer les mêmes octets avec le bon format renvoie ce lot rejeté en 200 (aucun moyen de corriger sans modifier un octet) : décision à prendre sur l'unicité `(source, empreinte)` hors lots rejetés.
5. Le limiteur de réceptions est par processus ; plusieurs instances multiplient la limite.
6. Étendue du pays pour les avertissements de coordonnées : provisoire.

## F. Fonctions non testées

Workflow d'approbation, autorisation et import final (n'existent pas) ; lecteur d'écran réel ; Safari, Firefox, WebView ; rendu derrière le vrai nginx (413 à 25 Mo non essayé) ; plusieurs instances du serveur ; fichiers proches de 25 Mo ; 12 réceptions de 8 000 lignes (plafond de 20 000 lignes par lot) ; ouverture réelle de `erreurs.csv` dans Excel ; production.

## G. Décisions pour la DSI (le workflow n'avance pas sans elles)

1. Rôles et séparation des tâches : déposant, validateur métier, responsable du référentiel, auditeur en lecture seule ; l'ADMIN peut-il approuver ?
2. Seuil d'erreurs bloquantes : une seule ligne rejetée bloque-t-elle l'approbation ? Sens exact de « schéma validé ».
3. Taille et sélection de l'échantillon ; mécanisme d'écriture finale, conflits, retour arrière (dépend du rapprochement des identifiants).
4. Preuve de l'autorisation écrite : registre d'autorisations ou simple référence.
5. Source : liste administrable ou texte libre normalisé.
6. Territoire et module sur ces routes : aujourd'hui un GESTIONNAIRE rattaché à une région voit tous les lots et leurs charges brutes ; réception réservée à l'ADMIN ?
7. Conservation du fichier brut et des charges originales (données éventuellement personnelles) ; plafonds en octets et en lignes ; GeoPackage et reprojection UTM.
8. Valeurs provisoires : 20 000 lignes, 25 Mo, 2 réceptions simultanées, 15 s d'attente.

**Prochain lot recommandé :** décision DSI sur la section G, puis conception implémentée du circuit d'approbation d'échantillon (journal de décisions append-only, statut du cahier dérivé par fonction pure, migration additive avec descente) ; avant cela, lancer les parcours de bout en bout de `/imports`.

## H. Commits

Aucun à ce jour ; commits à reporter ici après intégration.
