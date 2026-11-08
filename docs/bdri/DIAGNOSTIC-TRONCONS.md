# Module « Tronçons routiers » — diagnostic initial (lot A)

Établi le 25/10/2026 sur la branche `lot/18-bdri-troncons` (partie de `lot/17-consignes-dt`, à jour de
`lot/03-map-matching` à `4f4fe7d`). Lecture du code seulement : **aucune donnée de production n'a été lue**.

## Le nombre de tronçons

- Le « 1 691 » de l'interface est l'indicateur `troncons_classes`
  (`backend/src/tableau-de-bord/indicateurs.registre.ts`) : tronçons non supprimés dont `sourceReference` est nul
  ou ne commence ni par `voirie_locale:` ni par `hors_territoire:` (`lib/reseau.ts`, `clauseSqlReseauClasse`).
  La table en porte bien davantage (la voirie promue, 261 387 selon les commentaires du code).
- **Non vérifiable ici** : les bases locales `console_bdri_dev` et `replay` contiennent **0 tronçon** ; le jeu
  d'amorçage (`prisma/seed.ts`) en crée 8, sans géométrie. Le chiffre n'est codé en dur que dans un test
  (`dashboard.kpis.test.ts`). Toute mesure sur les vraies données reste à faire avec un accès autorisé.

## Parcours des données

| Couche | Élément |
|---|---|
| Base | table `troncons` (`schema.prisma`, modèle `Troncon`) ; géométrie `geometry(LineString,4326)` hors Prisma ; index GiST planaire `troncons_geom_gist` et index geography |
| API v1 | `backend/src/modules/troncons/` monté sur `/api/troncons` : liste paginée, `/geo`, `/export` (XLSX), `/import` (XLSX), `/:id/fiche`, CRUD, archivage unitaire et groupé, `PATCH /:id/geom` |
| API v2 | recherche (`/v2/troncons-recherche`, `/chemin`), changement d'état d'un corridor, qualité (`/v2/qualite/anomalies`), fiche 360 (portions, programmation), portions, imports pivot, export de sélection, correspondances |
| Écran | `frontend/src/pages/TronconsPage.tsx` sur `EntityListPage` ; fiche `components/TronconFicheModal.tsx` ; panneau du géoportail `pages/geoportail/DetailPanel.tsx` |

## Ce qui fonctionne

- Identité stable : `id` UUID, `code` unique ; archivage logique (`deletedAt`) et restauration groupée.
- Audit transactionnel des écritures CRUD (`logAuditTransactionnelle`), contrôle territorial des écritures.
- Sections homogènes : `Portion` (abscisses en mètres sur la géométrie, versions bitemporelles, lignage
  découpe et fusion, validation séparée).
- Rattachement GPS avec ambiguïté explicite (`geo/appariement.noyau.ts` : PRESELECTION / CHOIX_AGENT /
  NON_RATTACHE, candidats rendus).
- Longueur déclarée (`longueurKm`) et géométrique (`ST_Length(geom::geography)`) distinguées dans la fiche et
  les indicateurs, avec la méthode.

## Écarts constatés

### Référentiel et qualité (lot C)
1. **Aucun registre d'anomalies** : le rapport `/v2/qualite/anomalies` est recalculé à chaque appel et
   « n'écrit rien » ; ni statut, ni auteur, ni historique de décision, ni correction avec ancienne et
   nouvelle valeur.
2. **Contrôles absents** : PK non renseignés (encodés `0 → 0`, les colonnes étant obligatoires), PK de fin
   inférieur au début, écart longueur déclarée / géométrique, attributs non renseignés, tronçon sans
   géométrie. Les doublons ne sont détectés que par égalité binaire stricte des géométries.
3. Trois fonctions pures (`chevauchementsAnormaux`, `rupturesDeContinuite`, `attributsIncoherents`) existent
   sans être branchées au rapport.

### Écran (lot B)
4. Filtres en `useState` : perdus au retour de la carte ; aucune réinitialisation ; pas de filtre revêtement,
   PK, sans géométrie ni `NON_CLASSEE`.
5. « PK manquant » filtré côté client sur une page de 20 lignes : la pagination ment.
6. L'export XLSX ignore les filtres ; l'export de la sélection (CSV/GeoJSON) n'est pas branché sur cette page.
7. Valeurs inconnues rendues de façon incohérente (`0.0 km` en liste, `—` en fiche ; PK et énumérations
   bruts dans la fiche) ; trois vues de détail concurrentes ; défauts et missions chargés mais non affichés ;
   pas d'onglet ordres de travaux ni historique.
8. Le lien « Carte » vers un tronçon sans géométrie échoue sans rien dire.

### Relations (lots D à G)
9. Un chantier ne porte qu'un `tronconId` : pas de chantier sur plusieurs tronçons ou sections.
10. `SessionRoulage` n'a pas de tronçon ; les marqueurs ont une colonne `tronconId` sans clé étrangère.
11. La saisie d'inspection terrain ne propose que les 200 premiers tronçons (`<select>`).

### Import et sécurité (lots H, I)
12. Import XLSX v1 : pas de simulation préalable, mises à jour comptées comme créations.
13. `POST /` et `PUT /:id` écrivent la géométrie **hors transaction et sans audit** (seul `PATCH /:id/geom`
    est audité) ; aucune géométrie n'est contrôlée par `ST_IsValid` à l'écriture.
14. Les schémas de validation refusent `NON_CLASSEE` et `NON_RENSEIGNE`, valeurs pourtant présentes en base.

## Ordre de traitement retenu

C (registre d'anomalies) → B (page et fiche) → I et H (écriture de géométrie, import simulé) → G (chantier
multi-tronçons) → E et F (inspection terrain), chaque lot testé avant le suivant. Les corrections de données
ne sont **jamais** appliquées automatiquement : elles passent par le registre, une prévisualisation et une
décision tracée.
