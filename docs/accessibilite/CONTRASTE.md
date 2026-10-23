# Contraste des couleurs : mesure et correction (WCAG 2.1 AA, paragraphe 7.11)

Date des mesures : 23/10/2026. Base de depart : commit f35aff7 (branche lot/03-map-matching).

Le contraste n'avait jamais ete mesure : axe-core sous jsdom ne calcule pas la regle `color-contrast`
(`src/test/accessibilite.ts` la desactive). Ce document consigne une mesure faite dans un navigateur reel,
les corrections, et ce qui reste hors de portee.

## Resultat en bref

| Mesure (37 pages applicatives + 2 pages publiques, theme clair) | Avant | Apres |
|---|---|---|
| Noeuds de texte evalues (WCAG 1.4.3) | 2 207 | 2 197 |
| Noeuds de texte sous le seuil (4,5:1, ou 3:1 pour le grand texte) | 227 | 0 |
| Champs de saisie sans delimitation a 3:1 (WCAG 1.4.11) | 133 | 0 |
| Elements focalisables dont l'indicateur de focus est sous 3:1 (4 pages echantillon, 263 elements) | 120 | 0 |

Le nombre de noeuds evalues varie un peu entre avant et apres : les contenus conditionnels (menus replies, etats
vides) n'apparaissent pas identiquement, et quelques elements changent de statut quand leur couleur change.

## Methode

1. Pile locale jetable, depuis le worktree : clone `essai_a11y` de la base `replay` (schema complet a jour, vide),
   `backend/.env` local (ignore par git, supprime a la fin) avec secrets JWT aleatoires, compte administrateur de
   test aleatoire, `npx tsx prisma/seed.ts` (8 troncons, 4 ouvrages, 1 point noir, 1 chantier), puis SQL
   pour les geometries, 2 postes, 2 marches, 2 bailleurs, 2 signalements, 3 ordres de travaux, 4 inspections
   d'etats differents, 1 programme de patrouille. Backend sur le port 4000, frontend Vite sur le port 5173.
2. Navigateur integre du poste (Chromium 152, fenetre 1440 x 900, theme clair). axe-core 4.14.0 (la dependance du
   frontend) est injecte dans la page, avec UNIQUEMENT la regle `color-contrast` (WCAG 1.4.3).
3. Complements maison, parce qu'axe ne couvre pas tout (scripts archives dans `docs/accessibilite/mesure/`) :
   - fonds en degrade : axe les classe « incomplets » ; on prend le PIRE rapport sur l'ensemble des arrets de
     couleur du degrade (borne basse, pas une moyenne) ;
   - noeuds que axe ne tranche pas (chevauchement, erreur interne sur certains elements flottants de la
     carte) : estimation texte contre fond cumule des ancetres, signalee comme telle dans les resultats ;
   - 1.4.11 composants : pour chaque champ (`input`, `select`, `textarea`, `combobox`), bordure, fond ou anneau du
     champ, sinon du conteneur proche (3 niveaux), contre le fond voisin, seuil 3:1 ;
   - focus : pour chaque element focalisable, couleur de l'anneau (outline ou ombre a etalement) contre le fond
     voisin, seuil 3:1, apres une vraie touche Tab pour armer `:focus-visible`.
4. Les pages sont balayees par navigation interne a l'application (la session reste connectee), avec
   2 a 3,5 secondes d'attente par page.
5. Chaque correction a ete suivie d'une remesure complete des 37 pages.

Reproduire : copier `docs/accessibilite/mesure/*.js` et `node_modules/axe-core/axe.min.js` dans
`frontend/public/__a11y/` (temporaire, jamais commite), charger `mesure.js` puis `outils.js` dans la page, puis
`await __scan(__PAGES, 2500)`, `__resume()`, `__agg()`.

## Ecrans mesures

Pages applicatives (37) : tableau de bord, geoportail (base, panneau de detail ouvert via
`?select=troncon&id=...`, resultats de recherche, creation de troncon, export, mesure), troncons, ouvrages,
chantiers, qualite, Control Tower, Info Route et bulletin, patrouilles, cellule de veille, configuration de la
veille, observation de la Terre, releve en vehicule, enregistrer en roulant, defauts terrain, portions terrain,
inspection terrain, programmation, baremes, rapports, rapport bailleur, administration, securite, points noirs,
postes, marches, inspections, documents, aide a la decision, alertes, ordres de travaux, utilisateurs,
gouvernance, validation des portions, validation des releves terrain, catalogue des defauts, lots d'import.

Pages publiques : `/carte` (base et panneau d'informations ouvert), `/embed/carte` (rendu vide sans parametres :
0 noeud, non significatif), `/login` (etat normal et etat d'erreur « identifiants incorrects »).

Etats : fenetre « Ajouter » d'un troncon, fiche d'un troncon (EntityDetailModal et fiche 360), historique d'audit,
confirmation d'archivage (annulee, rien n'a ete archive), erreur de connexion, focus clavier (4 a 8 pages).

Details par page, avant correction (violations de texte / champs a moins de 3:1) :
`/` 7/1, geoportail 9/2, troncons 13/5, ouvrages 12/5, chantiers 9/4, qualite 9/1, control-tower 3/1,
info-route 3/1, patrouilles 3/2, veille 5/1, teledetection 3/1, releve 3/7, enregistrer 3/1, defauts terrain
3/3, portions terrain 3/1, programmation 3/12, baremes 12/1, rapports 15/1, administration 4/7, securite 3/1,
points noirs 5/4, postes 6/5, marches 4/4, inspections 8/3, documents 5/5, decision 19/1, alertes 10/4,
rapport bailleur 6/2, ordres de travaux 10/4, utilisateurs 4/2, gouvernance 6/6, inspection terrain 3/6,
validation des portions 3/1, validation des releves 4/1, catalogue des defauts 3/8, imports 3/7,
configuration de la veille 3/12. Apres correction : 0/0 partout.

Une premiere passe sur des donnees plus pauvres avait donne 220 violations de texte et 118 champs ; le jeu de
donnees a ensuite ete enrichi (postes, marches, ordres de travaux, inspections), d'ou 227 et 133 : ce sont les
chiffres de reference.

## Violations avant correction, par cause

| Cause | Couleurs mesurees | Noeuds | Correction |
|---|---|---|---|
| Titres de section de la barre laterale `text-white/40` (sur toutes les pages) | #767f8e sur #1a2942, 3,60:1 | 111 | `text-white/60` (6,2:1 sur navy) |
| `text-gray-400` sur blanc | #9ca3af sur #fff, 2,53:1 | 68 | teinte de texte `gray-300/400/500` = #656c79 |
| `text-gray-400` sur gris-50 | #9ca3af sur #f9fafb, 2,42:1 | 18 | idem |
| `text-slate-400` | #94a3b8 sur #fff, 2,56:1 | 6 | `slate-400/500` = #5e6d82 |
| `text-white/50` sur carte sombre | #8f9daf sur #1e3a5f, 4,14:1 | 4 | `text-white/60` |
| `text-gray-500` sur surface teintee | #6b7280 sur #f5f6f8, 4,47:1 | 4 | `gray-500` = #656c79 |
| `text-gray-500` sur rouge-50 | #6b7280 sur #fef2f2, 4,41:1 | 2 | idem |
| `text-orange-600` | #ea580c sur #fff, 3,55:1 | 2 | `orange-400..600` = #b9460a |
| Valeurs isolees (12 noeuds) | gris 300 (1,41 a 1,47), or en grand chiffre (2,03), gris KPI (2,54), `text-lime-600` (3,08), legende Recharts coloree par serie (3,3 ; 1,98 ; 2,8), `text-red-500` sur rouge-50 (3,44), `text-red-100/70` sur rouge-600 (2,56), gris 500 sur gris-100 (4,39), `text-white/45` (3,66) | 12 | voir la liste des corrections |

## Corrections

A la source, sans toucher a la structure des pages.

- `frontend/tailwind.config.js` : bloc `theme.extend.textColor`. Seul l'utilitaire `text-*` change ; `bg-*` et
  `border-*` gardent la palette Tailwind, donc aplats et filets ne bougent pas. Chaque valeur est la teinte
  d'origine assombrie (meme teinte, luminosite reduite) jusqu'a 4,5:1 sur le PIRE fond ou elle se pose (blanc, gris-50,
  fond applicatif #f4f6f8, gris-100, `--muted` #eef1f4, et le -50 de sa famille). Un seul changement corrige des
  centaines d'usages sans toucher a un fichier de page : `text-gray-300/400/500` (469 usages), `slate`, `red`,
  `orange`, `amber`, `yellow`, `lime`, `green`, `emerald`, `teal`, `blue`, `purple`.
- `frontend/src/index.css` : variables de theme.
  - `--muted-foreground` #6b7280 -> #5b6472 (4,26:1 sur `--muted` et 4,46:1 sur `--background` : sous le seuil).
  - `--input` #d1d5db -> #7b828e (bordure de champ : 1,47:1 -> 3,87:1 sur blanc).
  - `--ring` #f5a623 -> #1a2942 (anneau de focus : 2,03:1 -> 14,6:1 sur blanc). `--sidebar-ring` reste or, sur navy.
  - Regle `:is(input, select, textarea)[class~="border-gray-200" | "border-gray-300" | "border-slate-200" |
    "border"...]` : bordure en `var(--input)`. Les champs des pages posent leur bordure en classes brutes et ne
    passent pas par `<Input>` ; seuls ceux dont la bordure de base est l'un de ces gris changent, donc erreur
    (`border-red-*`), transparent et focus (`focus:border-navy`) restent la main de la page.
  - Regle `:focus-visible` globale (outline 2 px, decalage 2 px, `!important`). Le code compte 52 usages de
    `outline-none` et 44 anneaux navy a 20 ou 30 % (environ 1,4:1), quasi invisibles.
- `frontend/src/lib/contraste.ts` (nouveau) : formule WCAG et `assombrirPour`. Utilise par `KpiCard` et
  `DecisionPage` : une couleur d'accent choisie pour un aplat (or, cyan, gris) est assombrie pour le CHIFFRE ; la
  barre et le halo gardent la couleur d'origine.
- Classes de couleur de composants (sans toucher a la logique) :
  `Sidebar`, `LongueurReseauCard`, `DashboardPage`, `DecisionPage`, `DataTable`, `DetailPanel` : `text-white/30..50`
  -> `/60` ou `/70`. `AlertesPage` : sous-titre `text-red-100/70` -> `text-white` sur rouge-600.
  `RapportsPage` : couleurs de graphique prises dans `symbology.ts` (source unique de l'echelle d'etat) au lieu
  de teintes Tailwind a 1,98:1 a 3,3:1, libelles de legende en gris neutre. `GeoportailPage` (une classe) :
  `bg-red-500 text-white` (3,76:1) -> `bg-red-600 ... hover:bg-red-700`. `DecisionPage` : pastilles de rang
  `bg-orange-400/amber-400 text-white` (2,26:1 et 1,67:1) -> `-700`. `DetailPanel` : fin du degrade d'en-tete
  #2d4a6b -> #2a4666. `GouvernancePage` : 3 `<select>` avec `border-gray-300` mais sans `border` : pas de
  bordure du tout, champ invisible sur fond blanc. `RechercheRoute` (carte publique) : `ring-black/5` -> `ring-slate-500`.

Les deux derniers defauts (pastilles de rang, bouton rouge du geoportail) n'etaient pas atteints par la mesure
dynamique : c'est le balayage statique du test qui les a trouves.

## Garde-fou durable

`frontend/src/styles/contraste.test.ts` (11 tests, sans navigateur) :

- chaque paire de jetons de TEXTE du theme >= 4,5:1 (foreground/background, card, popover, primary, secondary,
  accent, muted, destructive, barre laterale, les 5 etats texte/fond, succes/avertissement/danger/info) ;
- chaque paire de jetons de COMPOSANT >= 3:1 (bordure de champ, anneau de focus, 5 traits d'etat) ;
- couleurs de marque (blanc sur navy et navy2, navy sur or, or sur navy) ; blanc a 60 % sur navy, navy2 et le degrade
  des cartes sombres ;
- toute classe `text-<famille>-<teinte>` employee dans `src/**/*.tsx`, resolue avec la palette EFFECTIVE (Tailwind plus
  les surcharges de `textColor`), >= 4,5:1 sur blanc, gris-50, fond applicatif, gris-100, muted et le -50 de sa
  famille (le -100 pour les teintes 700 et plus) ; les teintes claires (luminance > 0,5) sont supposees posees sur fond
  sombre et ne sont pas jugees ;
- tout `text-white` pose avec un `bg-<famille>-<teinte>` dans la meme liste de classes >= 4,5:1.

Contre-epreuves :
1. Tests integres : une paire volontairement mauvaise (#9ca3af sur blanc) est detectee (2,54:1) ; la palette
   Tailwind d'origine est detectee defaillante (`text-gray-400`, `text-amber-700`) ; `bg-orange-400 text-white` est
   detecte, `bg-red-600 text-white` non.
2. Contre-epreuve reelle, executee le 23/10/2026 : remise a leur ancienne valeur de `--muted-foreground` (#6b7280),
   `--input` (#d1d5db), `--ring` (#f5a623) et de `gray` 300/400/500 dans `tailwind.config.js`. Resultat : 3 tests sur 11
   echouent, avec par exemple `muted-foreground (#6b7280) sur muted (#eef1f4) = 4.26:1 < 4.5:1`,
   `ring (#f5a623) sur card (#ffffff) = 2.03:1 < 3:1`, et la liste des fichiers portant `text-gray-400`. Les valeurs
   corrigees ont ete restaurees ensuite.

`frontend/src/lib/contraste.test.ts` (8 tests) verifie le calcul lui-meme (noir sur blanc 21:1, anciens gris sur blanc
2,54:1 et 4,83:1, or 2,03:1, `assombrirPour`).

## Violations restantes

Aucune sur les 37 pages, les 2 pages publiques et les etats listes plus haut, avec les donnees de test.

Reserves honnetes sur ce zero :
- Le chiffre porte sur les pages telles qu'elles se rendent avec 8 troncons, 4 ouvrages et quelques lignes par
  table. Une table remplie de donnees reelles peut exposer des couleurs dependant de la donnee (par exemple une valeur
  d'etat peu courante) que le balayage statique du test couvre en partie seulement.
- Les noeuds estimes (degrades, noeuds que axe ne tranche pas) sont juges par une borne basse maison, pas par axe :
  ils sont signales comme tels dans les scripts (`src: "degrade"` ou `"maison"`).

## Pages d'autres agents : mesurees, non modifiees

Mesurees avec leurs donnees de test, sans toucher a leur code (seuls les jetons du theme les ont changees) :
`EnregistrementRoulagePage` (avant : 3 violations dont 3 de la barre laterale, 1 champ ; apres : 0/0),
`DefautTerrainPage` (3, 3 champs ; apres 0/0), `ProgrammationPage` (3, 12 champs ; apres 0/0), fiche 360 d'un troncon
(`TronconFicheModal`, 0 violation avant et apres l'ouverture). La page de conflits de synchronisation n'existe pas
dans cette base. A mesurer par leurs auteurs une fois leurs pages stabilisees, en etat reel : badge « Hors-ligne » de
`DefautTerrainPage` et `InspectionTerrainPage` (`text-amber-100` / `text-amber-200` sur navy teinte, non rendu en
ligne), et `ProgrammationPage` (graphique Recharts : la `<Legend>` y est coloree par serie, sans le formatter neutre ajoute a `RapportsPage` ; a verifier avec les couleurs reelles de ses series).

## Ce qui n'est PAS mesure

- Theme sombre : `tokens.css` definit `[data-theme="dark"]`, mais rien dans l'application ne l'active (aucun
  commutateur, aucune lecture de `prefers-color-scheme`). Inatteignable, donc non mesure ; ses valeurs ne sont pas
  non plus couvertes par le test. A traiter le jour ou le theme sombre est branche.
- Survol et etat actif : non mesures dynamiquement (l'outil de pilotage du navigateur ne permet pas de forcer
  `:hover`). Les combinaisons `hover:bg-* hover:text-*` ne sont pas verifiees une a une. Le test couvre les
  paires de jetons (`accent`/`accent-foreground`, `sidebar-accent`), pas les survols ecrits en classes brutes.
- Etat desactive : exempte par WCAG 1.4.3 (composant inactif). Non mesure.
- Etat d'erreur : mesure sur la connexion (message `text-red-600` -> #d32222, 5,2:1) ; ailleurs, couvert seulement par
  le balayage statique des classes `text-red-*`.
- Texte pose sur photo, sur les tuiles de la carte, ou sur un fond raster : axe et nos estimations ne le jugent pas.
  Concerne les etiquettes et popups Leaflet, la galerie de photos, le fond du geoportail. Les couleurs ecrites en
  dur dans `style={{ color: "#..." }}` ou en options Leaflet ne sont couvertes que si elles se retrouvent a l'ecran
  d'une page mesuree.
- Pages et etats non atteints : popups et infobulles Leaflet ouverts, liste deroulante Radix ouverte, toasts, vues
  d'impression et PDF, formulaires avec valeurs invalides, fiche 360 avec portions et photos, ecran « Enregistrer en
  roulant » en cours d'enregistrement, hors-ligne.
- Petits ecrans : tout a ete mesure a 1440 x 900. Les elements `hidden md:block` ou propres au mobile (375 px) n'ont pas
  ete rendus ; la carte publique, pensee pour le mobile, n'a donc ete mesuree que sur sa version large.
- Usage au lecteur d'ecran, ordre de lecture, clarte des libelles : hors de portee d'une mesure automatique.
- Daltonisme : non simule ; le projet double deja la couleur d'etat par une forme (`EtatBadge`).
- Les ecarts entre navigateurs (rendu des couleurs, anticrenelage) ne sont pas mesures : un seul moteur (Chromium 152).
