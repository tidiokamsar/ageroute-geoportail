# Audit des scripts d'écriture de `backend/scripts/` (règle 3 d'AGENTS.md)

Chantier B du Lot 1, 26/10/2026. **Lecture seule du code** : aucun script n'a été exécuté, aucun n'a été modifié. Seul un utilitaire neuf a été créé : `backend/scripts/lib/audit-script.ts` (et son test `audit-script.test.ts`). Les propositions ci-dessous sont à appliquer par l'orchestrateur.

## 1. Résultat en bref

| | Nombre |
|---|---|
| Scripts de `backend/scripts/` (hors tests et `lib/`) | 38 |
| **Écrivent en base sans ligne dans `audit_logs`** | **29** |
| Écrivent et auditent (`logAuditTransactionnelle`) | 6 : `approuver-regle-condition`, `desapprouver-regle-condition`, `parametrer-baremes-cout`, `peupler-referentiels`, `peupler-regle-condition`, `retrograder-compte` |
| Sans écriture de patrimoine | 3 : `balayer-secrets` (lecture), `outbox-traiter` (passe par `traiterLot`, la file d'envoi), `verifier-derive-schema` (écrit un rapport JSON et crée puis détruit une base de vérification de nom fixe) |

**Écart avec le Lot 0.** Le rapport du Lot 0 comptait « 11 scripts d'écriture sur le patrimoine sans audit ». Je ne reproduis pas ce chiffre : en lisant les 38 scripts, 29 écrivent sans aucune ligne dans `audit_logs`. Le critère du Lot 0 n'est pas donné et je ne sais pas ce que désignait 11. Par lecture : 29 scripts sans ligne dans `audit_logs` ; parmi eux 8 sans simulation par défaut, et 14 qui ne laissent **aucune** autre trace non plus (colonne « Trace actuelle » du § 3). Le chiffre à retenir est **29**, établi par lecture et non par exécution.

Faits utiles à la décision :

- **21 scripts sur 29 sont en simulation par défaut** (`--apply` pour écrire ; `import-ouvrages-doaa` utilise `APPLIQUER=1`). **8 écrivent dès qu'on les lance, sans option** : `import-chantiers-projets`, `import-ouvrages-rn4`, `import-rural-osm`, `merge-osm-routes`, `migrate-legacy-data`, `peupler-catalogue-defauts`, `propagate-etat-rn-osm`, `update-ouvrages-etat-rn4`.
- **Une suppression physique est exécutée** : `generer-propositions-localisation.ts:221` (`deleteMany` des propositions `PROPOSED`, qu'elle recrée ensuite). Ce ne sont pas des entités patrimoniales mais des propositions de travail.
- **Neuf scripts impriment un « retour arrière » qui contient un `delete from` physique**, dont cinq sur du patrimoine ou du référentiel géographique : `promouvoir-voirie-troncons.ts:391` (`troncons`), `promouvoir-franchissements.ts:196` (`ouvrages`), `referentiel-regions.ts:133` (`regions`), `importer-limites-admin.ts:177` (`delete from limites_admin;` sans condition), `appliquer-decoupage-2026.ts:359-363` (`limites_admin` et son archive). Les quatre autres ne visent que `valeurs_qualite` ou, en commentaire, des référentiels d'administration (`extraire-section-pk`, `marquer-troncons-hors-territoire`, `rattacher-chantiers-region`, `peupler-catalogue-defauts`). Contraire à la règle 2 : proposer un archivage logique (`deletedAt`) ou refuser le retour automatique.
- **Racines de la sentinelle PK 0/0 et des longueurs nulles** : `migrate-legacy-data.ts:142,145,146` (`?? 0`), `import-rural-osm.ts:66-67`, `merge-osm-routes.ts:101-102`. Voir `DETECTEURS.md`.
- Trois scripts écrivent **une valeur inventée par défaut** sans la marquer comme telle : `revetement: "BITUME"` (`migrate-legacy-data.ts:143`, `merge-osm-routes.ts:99`), `revetement: "TERRE"` (`import-rural-osm.ts:64`), et un état déduit du « mode » des voisins (`propagate-etat-rn-osm.ts`). Aucun ne laisse de ligne `valeurs_qualite` : la donnée inventée est indiscernable d'une donnée constatée. Le dépôt appelle cette faute « la faute du BITUME » (`schema.prisma`, enum `ClasseRoute`).
- `import-chantiers-projets.ts`, `import-ouvrages-rn4.ts` et `update-ouvrages-etat-rn4.ts` importent le paquet `xlsx`, retiré volontairement du projet (CVE ; `tsconfig.scripts.json` les exclut). **Ils ne peuvent pas s'exécuter en l'état.** Les corriger exige d'abord de porter la lecture Excel sur `exceljs`.
- Scripts à jeu d'écriture réparti en plusieurs transactions (donc non atomiques de bout en bout) : `import-voirie-osm`, `importer-limites-admin` (lots de 25), `backfill-*` (lots), `rattacher-chantiers-localite` (une transaction par chantier), `generer-propositions-localisation` (aucune), et les huit sans simulation (aucune).

## 2. L'utilitaire fourni : `backend/scripts/lib/audit-script.ts`

Brique commune, testée (26 tests Vitest ; rejouée contre PostgreSQL réel dans une transaction annulée : 15 lignes d'audit écrites, un seul identifiant d'exécution, 5 001 identifiants retrouvés dans 11 lignes de lot, rien ne subsiste).

| Fonction | Rôle |
|---|---|
| `creerContexte({script, argv, env, parametres})` | Donne le mode et un `executionId` (UUID). **Simulation par défaut** ; `--dry-run` explicite ; `--apply` ou `APPLIQUER=1` écrivent ; `--apply` avec `--dry-run` est refusé |
| `choisirAuteur(prisma, argv, ecriture)` | En écriture : `--auteur=<email d'un ADMIN actif>` (comme `retrograder-compte.ts`) ou `--auteur-systeme` (`userId` nul, affiché « Système » par l'écran d'audit). Rien d'autre |
| `new JournalScript(contexte, auteur)` | `tracer(tx, {action, entityType, entites})` à appeler **dans la transaction qui porte l'écriture** : une panne d'audit annule l'écriture. `tracerExecution(prisma, "DEBUT"/"FIN", bilan)` : ligne `ScriptExecution` (action `SECURITY_EVENT`, comme le journal de l'APK du Lot 0) |
| Granularité | une ligne par entité jusqu'à 5 000 entités (seuil **provisoire**), au-delà une ligne par lot de 500 qui garde les identifiants et les anciennes valeurs (261 387 lignes d'audit noieraient le journal) |
| Forme des lignes | `after` reste plat, avec une clé réservée `_execution` (`executionId`, `script`, `mode`, `auteur`). Retrouver un lancement : `SELECT * FROM audit_logs WHERE after->'_execution'->>'executionId' = '<uuid>'` |
| Simulation | n'écrit **rien** (testé : aucun appel à la base) ; compte ce qui aurait été tracé |

Pas d'énumération `AuditAction` nouvelle (`CREATE`, `UPDATE`, `SECURITY_EVENT` existent). Les paramètres du lancement ne doivent contenir aucune URL de connexion ni secret (le test vérifie que la ligne de fin n'en porte pas).

### Recette commune (les quatre blocs reviennent dans chaque diff)

```ts
// Bloc A, en tete du script
import { JournalScript, choisirAuteur, creerContexte } from "./lib/audit-script";

// Bloc B, a la place de la lecture de --apply / APPLIQUER / de l'absence d'option
const { contexte, mode } = creerContexte({ script: "<nom-du-script>", argv: process.argv, env: process.env, parametres: { /* options du lancement */ } });
const appliquer = mode.ecriture;

// Bloc C, au debut de main() (echoue AVANT tout calcul long si --apply sans --auteur)
const auteur = await choisirAuteur(prisma, process.argv, appliquer);
const journal = new JournalScript(contexte, auteur);
// ... juste avant la premiere ecriture, apres le « return » de la simulation :
await journal.tracerExecution(prisma, "DEBUT");

// Bloc D, a la fin, avant les console.log du bilan
await journal.tracerExecution(prisma, "FIN", { ecrits });
```

Les écritures en **forme tableau** (`prisma.$transaction([...])`) ne peuvent pas recevoir `tx` : les convertir en forme interactive (`prisma.$transaction(async (tx) => { ... })`, déjà celle de `cloturer-chantier`, `declarer-revetement-par-etat`, `requalifier-lot-promotion`). Les lots sont petits (25 à 500), le coût est un aller-retour par instruction.

## 3. Tableau des 29 scripts

Colonnes : **Simulation** = simulation par défaut ; **Trace actuelle** = ce qui reste hors `audit_logs` (VQ = ligne `valeurs_qualite`, avec ou sans l'ancienne valeur) ; **Risque production** = mon évaluation, fondée sur ce que le code fait et non sur une exécution.

| # | Script | Tables écrites | Réversibilité | Suppr. physique | Idempotent | Simulation | Trace actuelle | Risque prod |
|---|---|---|---|---|---|---|---|---|
| 1 | `appliquer-decoupage-2026` | `limites_admin` (insert, update), **DDL** `limites_admin_archive` | archive, mais l'archive est ré-alimentée à chaque rejeu | `delete` dans le retour imprimé (archive) | non (archive dupliquée) | oui (`--apply`) | archive des lignes touchées | élevé (référentiel de frontières) |
| 2 | `backfill-provenance` | `troncons` (4 colonnes de provenance) | non : ancienne provenance perdue | non | oui | oui | aucune | moyen |
| 3 | `backfill-qualite` | `valeurs_qualite` (upsert, 6 champs × tous les tronçons) | non : écrase les lignes existantes | non | oui, mais **écrase** | oui | aucune | élevé (environ 1,6 M d'upserts, soit 6 champs × 261 387 tronçons d'après les comptes du dépôt, non vérifié sur la production, en lots de 100 ; écrase les statuts relevés depuis) |
| 4 | `cloturer-chantier` | `chantiers`, `troncons.etat`, `valeurs_qualite` | partielle : état précédent des tronçons en note VQ ; statut du chantier perdu | non | oui | oui | VQ avec ancienne valeur (tronçons) | moyen |
| 5 | `declarer-revetement-par-etat` | `troncons.revetement`, `valeurs_qualite` | oui (SQL imprimé + identifiants) | non | oui (seulement `NON_RENSEIGNE`) | oui | VQ + liste d'identifiants imprimée | moyen |
| 6 | `extraire-section-pk` | `troncons.sectionPk`, `valeurs_qualite` | non si une section existait (écrasée) | non | oui | oui | VQ sans ancienne valeur | faible |
| 7 | `generer-propositions-localisation` | `propositions_localisation` (create, `deleteMany`) | non | **oui** (`:221`, propositions `PROPOSED`) | oui | oui | aucune | moyen |
| 8 | `import-chantiers-projets` | `chantiers` (create) ; **montants, entreprises** | non | non | **non** (doublons au rejeu) | **non** | aucune | élevé ; **inexécutable** (`xlsx`) |
| 9 | `import-ouvrages-doaa` | `ouvrages` (create + UPDATE geom) | non scriptée | non | oui (`sourceReference`) | oui (`APPLIQUER=1`) | provenance sur la ligne | faible |
| 10 | `import-ouvrages-rn4` | `ouvrages` (create + geom) | non | non | **non** | **non** | aucune | élevé ; **inexécutable** (`xlsx`) |
| 11 | `import-rural-osm` | `troncons` (create + geom) : `TERRE`, PK 0/0 | non | non | **non** (code unique : plante au premier doublon, après écritures partielles) | **non** | aucune | élevé |
| 12 | `import-voirie-osm` | `voirie_locale` (insert) | non scriptée (table de source, insertion seule) | non | oui (`ON CONFLICT DO NOTHING`) | oui | lot d'import | faible |
| 13 | `importer-limites-admin` | `limites_admin` (upsert qui **écrase**) | « `delete from limites_admin;` » | **oui** (retour imprimé, sans condition) | oui, mais écrase | oui | aucune | élevé |
| 14 | `marquer-troncons-hors-territoire` | `troncons` (provenance), `valeurs_qualite` | **non, contrairement à ce que dit le retour** : il remet la provenance à NULL, l'ancienne est perdue | `delete` VQ imprimé | oui | oui | VQ sans ancienne valeur | élevé (change la définition du réseau classé) |
| 15 | `merge-osm-routes` | `troncons` (create + geom) : `BITUME`, PK 0/0 | non | non | partielle (par recouvrement) | **non** | aucune | élevé |
| 16 | `migrate-legacy-data` | `regions`, `troncons`, `ouvrages`, `points_noirs`, `postes`, `chantiers` | non | non | troncons oui (`upsert`, `update: {}`), **les autres non** | **non** | aucune | élevé (migration de reprise ; valeurs par défaut inventées) |
| 17 | `peupler-catalogue-defauts` | `catalogue_defauts` (create seulement) | `delete` en commentaire | non | oui | **non** | aucune | faible |
| 18 | `promouvoir-franchissements` | `ouvrages` (insert), `valeurs_qualite` | `delete from ouvrages` imprimé | **oui** (retour imprimé) | oui | oui | VQ | moyen |
| 19 | `promouvoir-voirie-troncons` | `troncons` (insert), `voirie_locale` (update), `valeurs_qualite` | `delete from troncons` imprimé, par motif de texte du lot | **oui** (retour imprimé) | oui | oui | VQ + motif « Lot » en observations | élevé (jusqu'à 262 656 créations) |
| 20 | `propagate-etat-rn-osm` | `troncons.etat` (**état déduit du mode des voisins**) | non | non | oui (cible consommée) | **non** | aucune | élevé (état inventé, indiscernable) |
| 21 | `rattacher-chantiers-localite` | `chantiers.regionId`, `valeurs_qualite` | oui (note VQ « auparavant Non renseigné ») | non | oui | oui | VQ | faible |
| 22 | `rattacher-chantiers-region` | `chantiers.regionId`, `valeurs_qualite` | oui (SQL imprimé) | non | oui | oui | VQ | faible |
| 23 | `rattacher-ouvrages-region` | `ouvrages.regionId`, `valeurs_qualite` | texte (région précédente en note) | non | oui | oui | VQ avec ancienne région | moyen (écrase une région saisie) |
| 24 | `rattacher-troncons-region` | `troncons.regionId`, `valeurs_qualite` | texte (région précédente en note) | non | oui | oui | VQ avec ancienne région | moyen (écrase une région saisie ; GEOS, voir `DETECTEURS.md`) |
| 25 | `reclasser-localisation` | `chantiers.statutLocalisation` (dérivé) | recalcul | non | oui | oui | aucune | faible |
| 26 | `recuperer-postes-audit` | `postes` (create) | non scriptée | non | oui (par nom) | oui | marqueurs `historicalRecovered` | faible |
| 27 | `referentiel-regions` | `regions` (update de code, create) | `delete from regions` imprimé | **oui** (retour imprimé) | oui | oui | aucune | faible |
| 28 | `requalifier-lot-promotion` | `troncons` (état, revêtement), `valeurs_qualite` | rejouer avec les anciennes valeurs, qu'il ne conserve pas | non | oui | oui | VQ (note) | élevé (changement de masse sur un lot) |
| 29 | `update-ouvrages-etat-rn4` | `ouvrages.etat` (`updateMany` par numéro de fiche) | non | non | oui, écrase | **non** | aucune | élevé ; **inexécutable** (`xlsx`) |

## 4. Propositions par script

Numéros de ligne : état du dépôt au 26/10/2026. **Dans chaque diff, les blocs A, B, C, D sont ceux du § 2** ; seuls sont détaillés la ligne du mode, la ligne de trace, et les particularités. `journal.tracer` va dans la transaction qui écrit, juste après l'écriture.

### Groupe 1 : déjà en simulation, il manque la trace

**1. `appliquer-decoupage-2026.ts`** (mode ligne 148 ; transaction lignes 236-325)
```diff
-  const appliquer = process.argv.includes("--apply");
+  const { contexte, mode } = creerContexte({ script: "appliquer-decoupage-2026", argv: process.argv, env: process.env, parametres: { regionsDeduites } });
+  const appliquer = mode.ecriture;
@@ dans prisma.$transaction(async (tx) => {  // apres le dernier UPDATE (promotions)
+      // L'archive est ecrite dans la meme transaction avec now() : ses lignes sont exactement celles touchees.
+      const touchees = await tx.$queryRawUnsafe<{ pcode: string; niveau: number; parentPcode: string | null; source: string }[]>(
+        `SELECT pcode, niveau, "parentPcode", source FROM limites_admin_archive WHERE "archiveA" = now()`);
+      await journal.tracer(tx, { action: "UPDATE", entityType: "LimiteAdmin",
+        entites: touchees.map((t) => ({ id: t.pcode, before: { niveau: t.niveau, parentPcode: t.parentPcode, source: t.source } })) });
+      if (regionsDeduites) await journal.tracer(tx, { action: "CREATE", entityType: "LimiteAdmin", entites: REGIONS_NOUVELLES.map((r) => ({ id: r.pcode, after: { nom: r.nom, niveau: 1 } })) });
```
Particularités : (a) l'archive est ré-alimentée à chaque rejeu (`INSERT INTO limites_admin_archive ... SELECT` sans garde, ligne 245) : ajouter `AND NOT EXISTS (SELECT 1 FROM limites_admin_archive a WHERE a.pcode = l.pcode)` sinon l'archive d'origine est noyée par l'état déjà modifié et le retour imprimé devient ambigu ; (b) `CREATE TABLE IF NOT EXISTS limites_admin_archive` (ligne 241) est un DDL hors migration : le déplacer dans une migration idempotente avec descente (modèle `20261027100000`).

**2. `backfill-provenance.ts`** (mode ligne 35 : `const APPLIQUER = ...`; écriture lignes 86-100, forme tableau)
```diff
-const APPLIQUER = process.argv.includes("--apply");
+const { contexte, mode } = creerContexte({ script: "backfill-provenance", argv: process.argv, env: process.env });
+const APPLIQUER = mode.ecriture;
@@ boucle des lots (ligne ~86)
-    await prisma.$transaction(
-      lot.map(({ id, provenance }) => prisma.troncon.update({ where: { id }, data: { ... } }))
-    );
+    await prisma.$transaction(async (tx) => {
+      for (const { id, provenance } of lot) {
+        await tx.troncon.update({ where: { id }, data: { sourceType: provenance.sourceType, sourceReference: provenance.sourceReference, sourceConfidence: provenance.sourceConfidence, sourceDetectedAt: detecteLe } });
+      }
+      await journal.tracer(tx, { action: "UPDATE", entityType: "Troncon", entites: lot.map(({ id, provenance }) => ({
+        id, before: avant.get(id), after: { sourceType: provenance.sourceType, sourceReference: provenance.sourceReference, sourceConfidence: provenance.sourceConfidence } })) });
+    });
```
Pour `before` : `avant = new Map(troncons.map((t) => [t.id, { sourceType: t.sourceType, sourceReference: t.sourceReference, sourceConfidence: t.sourceConfidence }]))`, déjà lus ligne 41-49. Cela corrige le défaut « ancienne provenance perdue ».

**3. `backfill-qualite.ts`** (mode ligne 33 ; upsert lignes 86-120, forme tableau)
Même conversion. **Avant d'écrire**, ajouter une lecture des lignes existantes pour ne plus écraser un statut relevé depuis (le script ne lit pas `valeurs_qualite` aujourd'hui : l'écrasement est constaté à la lecture du code, non par exécution) :
```diff
+  const existantes = await prisma.valeurQualite.findMany({ where: { entityType: "Troncon", champ: { in: [...champsSuivis] } }, select: { entityId: true, champ: true, statut: true } });
+  const dejaLa = new Set(existantes.map((e) => `${e.entityId}|${e.champ}`));
+  const aEcrireVQ = ecritures.filter((e) => !dejaLa.has(`${e.entityId}|${e.champ}`));   // ne plus ecraser
```
(`champsSuivis` = les six champs de `qualiteInitialeTroncon`). Décision de l'architecte : « ne plus écraser » change le comportement documenté (« remet les mêmes valeurs ») ; à trancher. Trace : `journal.tracer(tx, { action: "CREATE", entityType: "ValeurQualite", entites: ... })` par lot ; volume de l'ordre du million, donc granularité « lot ».

**4. `cloturer-chantier.ts`** (mode ligne 48 ; transaction lignes 88-118)
```diff
@@ await prisma.$transaction(async (tx) => {   // apres chantier.update, dans la boucle des tronçons
+    await journal.tracer(tx, { action: "UPDATE", entityType: "Chantier", entites: [{ id: chantierId,
+      before: { statut: chantier.statut, avancementPct: chantier.avancementPct, dateFinReelle: chantier.dateFinReelle },
+      after: { statut: "TERMINE", avancementPct: 100 } }] });
@@ apres la boucle
+    await journal.tracer(tx, { action: "UPDATE", entityType: "Troncon", entites: troncons.filter((t) => t.etat !== etat).map((t) => ({ id: t.id, before: { etat: t.etat }, after: { etat } })) });
```
Corrige : le statut précédent du chantier n'est aujourd'hui qu'affiché.

**5. `declarer-revetement-par-etat.ts`** (mode ligne 59 ; transaction ligne 118-170)
Après `majTroncons` (ligne 123) : `await journal.tracer(tx, { action: "UPDATE", entityType: "Troncon", entites: ids.map((id) => ({ id, before: { revetement: "NON_RENSEIGNE" }, after: { revetement } })) });`. Le retour imprimé reste valable ; la liste d'identifiants imprimée devient redondante avec l'audit.

**6. `extraire-section-pk.ts`** (mode ligne 60 ; écriture lignes 113-135, forme tableau)
Conversion interactive comme le n° 2. `before: { sectionPk: t.sectionPk }` (déjà lu ligne 64), `after: { sectionPk: t.section }`. Le retour imprimé (`update troncons set "sectionPk" = null`) ne restaure pas la section d'un tronçon qui en avait déjà une (le script la remplace quand elle diffère de celle lue dans le code) : l'audit corrige cela.

**7. `generer-propositions-localisation.ts`** (mode ligne 54 ; boucle lignes 217-244, aucune transaction)
```diff
   for (const p of aEcrire) {
     if (dejaDecides.has(p.chantierId)) continue;
-    await prisma.propositionLocalisation.deleteMany({ where: { chantierId: p.chantierId, statut: "PROPOSED" } });
-    await prisma.propositionLocalisation.create({ data: { ... } });
+    await prisma.$transaction(async (tx) => {
+      const supprimees = await tx.propositionLocalisation.findMany({ where: { chantierId: p.chantierId, statut: "PROPOSED" }, select: { id: true } });
+      await tx.propositionLocalisation.deleteMany({ where: { chantierId: p.chantierId, statut: "PROPOSED" } });
+      const creee = await tx.propositionLocalisation.create({ data: { ... } });
+      await journal.tracer(tx, { action: "DELETE", entityType: "PropositionLocalisation", entites: supprimees.map((s) => ({ id: s.id })) });
+      await journal.tracer(tx, { action: "CREATE", entityType: "PropositionLocalisation", entites: [{ id: creee.id, after: { chantierId: p.chantierId, methode: p.methode, tronconId: p.tronconId } }] });
+    });
```
Rend le remplacement atomique et auditable. Décision : remplacer le `deleteMany` par un marquage logique (champ `deletedAt` s'il existe sur le modèle ; à vérifier au schéma) plutôt qu'une suppression physique.

**9. `import-ouvrages-doaa.ts`** (mode ligne 30 : `const appliquer = process.env.APPLIQUER === "1"`, ligne 119)
```diff
-const appliquer = process.env.APPLIQUER === "1";
+const { contexte, mode } = creerContexte({ script: "import-ouvrages-doaa", argv: process.argv, env: process.env });
+const appliquer = mode.ecriture;
@@ entourer create + UPDATE geom (lignes 119-135) d'une transaction
-      const cree = await prisma.ouvrage.create({ ... });
-      await prisma.$executeRaw`UPDATE ouvrages SET geom = ...`;
+      const cree = await prisma.$transaction(async (tx) => {
+        const c = await tx.ouvrage.create({ ... });
+        await tx.$executeRaw`UPDATE ouvrages SET geom = ST_SetSRID(ST_MakePoint(${l.lon}, ${l.lat}), 4326) WHERE id = ${c.id}`;
+        await journal.tracer(tx, { action: "CREATE", entityType: "Ouvrage", entites: [{ id: c.id, after: { code: l.code, type: l.type, sourceReference } }] });
+        return c;
+      });
```
Corrige aussi l'orphelin possible (ouvrage créé sans géométrie si le second ordre échoue).

**12. `import-voirie-osm.ts`** (mode ligne 91 ; insertion lignes 130-137)
Table source (`voirie_locale`), insertion seule, idempotente. Trace : **une ligne de lot** par `viderLot()`, sans identifiants (les identifiants sont générés par la base) : `journal.tracer(prisma, { action: "CREATE", entityType: "VoirieLocale", entites: lot.map((l) => ({ id: l.sourceId })) })`, après l'`INSERT` et avec le même `executionId`. Au-delà de 5 000 entités le journal bascule seul en lignes de lot. Ce script n'est pas dans une transaction globale : une panne laisse des lots écrits ; la ligne `FIN` absente le dit.

**13. `importer-limites-admin.ts`** (mode ligne 103 ; écriture lignes 133-155, forme tableau)
Conversion interactive. **Capturer l'ancien contenu avant l'upsert**, qui écrase `geom` : `SELECT pcode, niveau, nom, "parentPcode", source, ST_AsEWKT(geom) FROM limites_admin WHERE pcode = ANY($1)` stocké dans `before` (la géométrie encodée peut être lourde : ne garder que `md5(ST_AsBinary(geom))` dans l'audit et archiver la géométrie complète dans une table d'archive comme le n° 1). Remplacer l'instruction de retour `delete from limites_admin;` par « restaurer depuis l'archive ».

**14. `marquer-troncons-hors-territoire.ts`** (mode ligne 62 ; transaction lignes 129-170)
```diff
@@ dans la boucle for (const c of candidats), avant l'UPDATE (ligne 135)
+        const avant = (await tx.$queryRawUnsafe<{ sourceReference: string | null; sourceType: string | null; sourceConfidence: string | null }[]>(
+          `SELECT "sourceReference", "sourceType"::text AS "sourceType", "sourceConfidence"::text AS "sourceConfidence" FROM troncons WHERE id = $1`, c.id))[0];
@@ apres l'INSERT valeurs_qualite
+        await journal.tracer(tx, { action: "UPDATE", entityType: "Troncon", entites: [{ id: c.id, before: avant, after: { sourceReference: `${PREFIXE}${c.code}`, sourceType: "IMPORT_CODE_PATTERN" } }] });
```
Corrige le retour arrière imprimé, **inexact** aujourd'hui (il met `sourceType` et `sourceReference` à NULL alors que l'ancienne valeur existait peut-être). Le retour devient « rejouer `before` depuis `audit_logs` ».

**18. `promouvoir-franchissements.ts`** (mode ligne 57 ; insertion lignes 94-130, forme tableau)
Conversion interactive. Les identifiants sont générés par la base (`gen_random_uuid()`) : récupérer ceux qui viennent d'être créés par `SELECT id FROM ouvrages WHERE "sourceDetectedAt" = $maintenant AND "sourceReference" LIKE 'ouvrage_osm:%'` après le lot, puis `journal.tracer(tx, { action: "CREATE", entityType: "Ouvrage", entites: ... })`. Remplacer le retour `delete from ouvrages where "sourceReference" like 'ouvrage_osm:%'` (ligne 196) par `update ouvrages set "deletedAt" = now() where ...` (règle 2).

**19. `promouvoir-voirie-troncons.ts`** (mode ligne 118 ; transaction par tuile, lignes 62-205)
Dans `promouvoirTuile`, après `crees` : lire les `id` créés `SELECT id FROM troncons WHERE observations LIKE '%Lot ' || $lot || '.%' AND "sourceDetectedAt" = $maintenant` et tracer en `CREATE` / `Troncon` ; tracer aussi `voirie_locale` en `UPDATE` (ancien `statut = SOURCE_EXTERNE`, `tronconId = NULL`). Le volume (jusqu'à 262 656) bascule en lignes de lot. Remplacer le retour imprimé `delete from troncons where observations like '%Lot ...%'` (ligne 391) par un archivage logique et supprimer la condition portée par un motif de texte libre : elle supprimerait aussi tout tronçon dont les observations contiennent la même chaîne.

**21, 22. `rattacher-chantiers-localite.ts`** (mode ligne 124 ; lignes 178-199) et **`rattacher-chantiers-region.ts`** (ligne 157 ; lignes 214-232)
Après `chantier.update` : `await journal.tracer(tx, { action: "UPDATE", entityType: "Chantier", entites: [{ id, before: { regionId: <ancienne> }, after: { regionId: <nouvelle> } }] })`. Le n° 21 utilise la forme tableau `prisma.$transaction([update, upsert])` : conversion interactive.

**23. `rattacher-ouvrages-region.ts`** (mode ligne 48 ; transaction lignes 110-135)
Après `UPDATE ouvrages` : tracer `Ouvrage`, `before: { regionId: l.region_actuelle }` (le nom est lu ligne ~58 ; ajouter l'id `ra.id AS region_id_actuelle` à la requête de la ligne 50-60 pour auditer l'identifiant).

**24. `rattacher-troncons-region.ts`** (mode ligne 56 ; écriture lignes 153-176, forme tableau)
Conversion interactive ; ajouter `d.actuelle` (déjà dans le CTE `dominante`, ligne 137) au `SELECT` de la ligne 146 pour que `before: { regionId: actuelle }` soit l'identifiant et non le seul nom. Le registre compte 261 387 tronçons d'après `anomalies.depot.ts` et chacun peut changer : trace en lots au-delà de 5 000.

**25. `reclasser-localisation.ts`** (mode ligne 19 ; `updateMany` ligne ~91)
Dérivé, recalculable. `updateMany` regroupe plusieurs identifiants : tracer avec `before: { statutLocalisation: <statutActuel> }` (déjà lu dans `LigneChantier.statutActuel`) pour chaque `ids` du groupe, dans une transaction interactive.

**26. `recuperer-postes-audit.ts`** (mode ligne 49 ; création ligne 123)
Entourer `poste.create` d'une transaction et tracer `CREATE` / `Poste` (`after: { nom, type, regionId }`). Le script lit déjà `audit_logs` (ligne 61) : l'ajouter à l'audit boucle proprement.

**27. `referentiel-regions.ts`** (mode ligne 66 ; transaction lignes 98-125)
Dans la transaction, après chaque `update` : `CREATE`/`UPDATE` / `Region` avec `before: { code: null }`. Remplacer le retour imprimé `delete from regions where nom in (...)` (ligne 133) par « marquer la région non en vigueur » (`validTo`), la table portant déjà `validFrom`/`validTo`.

**28. `requalifier-lot-promotion.ts`** (mode ligne 52 ; transaction lignes 160-195)
**Lire d'abord l'ancien état** : `SELECT id, etat, revetement FROM troncons WHERE id = ANY($1)` avant le `UPDATE` de la ligne 161, puis `journal.tracer(tx, { action: "UPDATE", entityType: "Troncon", entites: avant.map((a) => ({ id: a.id, before: { etat: a.etat, revetement: a.revetement }, after: { etat, revetement } })) })`. Aujourd'hui le retour dit « rejouer avec les valeurs précédentes » que le script ne conserve pas.

### Groupe 2 : sans simulation, il faut aussi la porte `--apply`

Pour ces huit scripts, le diff ajoute la porte avant la première écriture ; le script devient en simulation par défaut. **Rupture de compatibilité** : tout appel existant (documentation, cron, `package.json`) devra passer `--apply --auteur=...`. `grep` à faire avant (hors périmètre de ce chantier).

**8. `import-chantiers-projets.ts`** (écriture ligne 138 ; **n'a ni option ni idempotence**)
```diff
+import { JournalScript, choisirAuteur, creerContexte } from "./lib/audit-script";
+const { contexte, mode } = creerContexte({ script: "import-chantiers-projets", argv: process.argv, env: process.env, parametres: {} });
@@ avant la boucle d'ecriture (ligne ~124)
+  if (!mode.ecriture) { console.log(`SIMULATION : ${rows.length} chantiers seraient crees. Ajouter --apply --auteur=<email>.`); return; }
+  const auteur = await choisirAuteur(prisma, process.argv, true);
+  const journal = new JournalScript(contexte, auteur);
+  await journal.tracerExecution(prisma, "DEBUT");
@@ dans la boucle
-      await prisma.chantier.create({ data: { ... } });
+      const existe = r.numContrat ? await prisma.chantier.findFirst({ where: { numContrat: r.numContrat, deletedAt: null }, select: { id: true } }) : null;
+      if (existe) { continue; }   // idempotence : un numero de contrat identifie un chantier
+      await prisma.$transaction(async (tx) => {
+        const c = await tx.chantier.create({ data: { ... } });
+        await journal.tracer(tx, { action: "CREATE", entityType: "Chantier", entites: [{ id: c.id, after: { intitule: r.intitule, numContrat: r.numContrat } }] });
+      });
```
Le script lit un fichier Excel avec `xlsx` : **à porter sur `exceljs` avant tout lancement**. Les montants (`montantGnf`) et entreprises sont des données de marché : l'audit est ici obligatoire, pas facultatif. Idempotence : la clé `numContrat` est une hypothèse (peut être absente) ; sans clé, rejouer duplique.

**10. `import-ouvrages-rn4.ts`** (écriture lignes 152 et 176) : même porte, même conversion `xlsx`. Idempotence par la clé `(ficheNumero, code)` ou `code` avant `create`. `create` + `UPDATE geom` dans une transaction (aujourd'hui un ouvrage peut rester sans géométrie), puis `tracer` `CREATE` / `Ouvrage`.

**11. `import-rural-osm.ts`** (écriture lignes 57 et 70)
Porte `--apply` ; `create` + `UPDATE geom` dans une transaction ; `tracer` `CREATE` / `Troncon`. Idempotence : `const dejaLa = await tx.troncon.findUnique({ where: { code } })` puis `continue`, au lieu de laisser la contrainte d'unicité interrompre le script à mi-parcours. **Ne plus écrire `revetement: "TERRE"` ni `pkDebut: 0, pkFin: 0` comme des valeurs** : écrire la provenance (`sourceType`, `sourceReference`) et une ligne `valeurs_qualite` `UNKNOWN` pour `revetement` et `pkDebut`/`pkFin`, comme le fait `promouvoir-voirie-troncons` (lignes 291-330). Le PK 0/0 est la sentinelle que les détecteurs signalent.

**15. `merge-osm-routes.ts`** (écriture lignes 92 et 106) : mêmes remarques (`BITUME` et PK 0/0 inventés ; transaction `create` + geom ; porte `--apply` ; trace `CREATE` / `Troncon`). Le rapport final existe déjà : l'imprimer aussi en simulation.

**16. `migrate-legacy-data.ts`** (écritures aux lignes 80, 90, 134, 151, 170, 185, 203, 215, 233, 245, 263, 279)
Porte `--apply` avant `migrateRegions()` ; une transaction par entité (`create` + geom) ; trace `CREATE` pour chaque table (`Region`, `Troncon`, `Ouvrage`, `PointNoir`, `Poste`, `Chantier`). Corriger l'idempotence : seuls les tronçons sont des `upsert` ; `ouvrage.create`, `pointNoir.create`, `poste.create`, `chantier.create` dupliquent au rejeu. Les trois `?? 0` des lignes 142, 145, 146 (longueur et PK) devraient devenir `null` si le modèle l'accepte, ou être accompagnés d'une ligne `valeurs_qualite` `UNKNOWN` (colonnes non nulles : décision de schéma). Script de **reprise unique** : sa place est probablement dans un dossier d'archives, pas à côté des scripts d'exploitation.

**17. `peupler-catalogue-defauts.ts`** (création ligne 62)
Porte `--apply` ; `catalogueDefaut.create` dans une transaction avec `tracer` `CREATE` / `CatalogueDefaut` (`after: { code, famille }`). Même modèle que `peupler-referentiels.ts` (déjà audité : lignes 147-155).

**20. `propagate-etat-rn-osm.ts`** (écriture ligne 45)
```diff
+import { JournalScript, choisirAuteur, creerContexte } from "./lib/audit-script";
@@ main()
+  const { contexte, mode } = creerContexte({ script: "propagate-etat-rn-osm", argv: process.argv, env: process.env });
+  const auteur = await choisirAuteur(prisma, process.argv, mode.ecriture);
+  const journal = new JournalScript(contexte, auteur);
@@ dans la boucle byNom, remplacer la boucle d'UPDATE (lignes 44-47)
-    for (const seg of segs) {
-      await prisma.troncon.update({ where: { id: seg.id }, data: { etat: mode as never } });
-      updated++;
-    }
+    if (mode.ecriture) {
+      await prisma.$transaction(async (tx) => {
+        for (const seg of segs) await tx.troncon.update({ where: { id: seg.id }, data: { etat: modeEtat as never } });
+        await journal.tracer(tx, { action: "UPDATE", entityType: "Troncon", entites: segs.map((s) => ({ id: s.id, before: { etat: "NON_EVALUE" }, after: { etat: modeEtat } })) });
+        for (const seg of segs) await tx.valeurQualite.upsert({ /* statut IMPORTED_UNVERIFIED, methode DEDUCTION_MODE_VOISINS, confiance LOW */ });
+      });
+    }
+    updated += segs.length;
```
(la variable `mode` du script, le mode statistique des états voisins, est à renommer `modeEtat` pour ne pas entrer en collision avec `mode` d'`audit-script`.) **Risque** : écrit un état déduit de l'état des voisins ; sans ligne `valeurs_qualite` il est indiscernable d'une inspection (le drapeau « état déclaré » de la carte n'est posé que par `valeurs_qualite`). La ligne `valeurs_qualite` est le point critique, plus que l'audit.

**29. `update-ouvrages-etat-rn4.ts`** (écriture ligne 74)
Porte `--apply` ; **remplacer `updateMany` par une lecture puis des `update` unitaires** pour connaître l'ancien état et les identifiants touchés (`updateMany` par `ficheNumero` peut toucher plusieurs ouvrages portant le même numéro de fiche sur d'autres routes) ; `tracer` `UPDATE` / `Ouvrage` avec `before: { etat }`. `xlsx` : à porter sur `exceljs`.

### Groupe 3 : scripts déjà audités (aucune modification d'audit)

`approuver-regle-condition`, `desapprouver-regle-condition`, `parametrer-baremes-cout`, `peupler-referentiels`, `peupler-regle-condition`, `retrograder-compte` appellent `logAuditTransactionnelle` dans la transaction qui écrit, avec un auteur ADMIN. Ils ne passent pas par l'utilitaire. Pour uniformiser (identifiant d'exécution, simulation par défaut), ajouter seulement les blocs A à D ; `approuver`/`desapprouver`/`retrograder` sont des actes uniques sans simulation, et leur garde (ADMIN, motif) vaut mieux qu'un `--apply`.

## 5. Ordre d'application suggéré

1. Les quatre à valeur inventée ou écrasement sans trace : **20** (`propagate-etat-rn-osm`), **14** (`marquer-troncons-hors-territoire`, retour faux), **28** (`requalifier-lot-promotion`), **3** (`backfill-qualite`, écrase).
2. Les huit sans simulation (groupe 2), après avoir cherché leurs appelants.
3. Les retours arrière à suppression physique (**18, 19, 27, 13**) : remplacer par l'archivage logique.
4. Le reste du groupe 1 (mécanique : blocs A à D et une ligne `tracer`).
5. Ne lancer aucun script sur la production sans l'accord humain prévu par la règle 5 d'`AGENTS.md`.

## 6. Décisions nécessaires de l'architecte

1. **Audit obligatoire en écriture, sans option de contournement** (recommandé) ou `--audit` facultatif ? Le Lot 0 posait la question. Recommandation : obligatoire ; l'utilitaire refuse `--apply` sans `--auteur` ou `--auteur-systeme`.
2. **Auteur** : un ADMIN nominatif (recommandé pour tout ce qui change des données de marché ou des états) ou « Système » (`userId` nul) ? L'écran d'audit affiche déjà « Système » quand `userId` est nul (`modules/audit/audit.routes.ts:80`).
3. **Granularité** : une ligne par entité jusqu'à 5 000, par lot au-delà. Seuil provisoire.
4. **Rupture de compatibilité** des huit scripts sans simulation : accepter que ces lancements passent en simulation par défaut.
5. **`backfill-qualite`** : ne plus écraser les lignes existantes ? (change le comportement documenté).
6. **`xlsx`** : porter les trois scripts concernés sur `exceljs`, ou les retirer du dépôt (`migrate-legacy-data` et les imports de reprise sont des actes uniques déjà joués ; les garder dans `scripts/` leur donne l'allure d'outils d'exploitation).
7. **Suppression physique dans les retours arrière** imprimés : remplacer par l'archivage logique (règle 2), au risque de rendre le retour moins simple.
