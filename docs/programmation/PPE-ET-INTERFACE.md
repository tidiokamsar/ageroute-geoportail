# Programmation pluriannuelle (PPE) minimale et interface du moteur

Rédigé le 26/10/2026, base : commit `f35aff7`. Complète [MOTEUR-PROGRAMMATION.md](MOTEUR-PROGRAMMATION.md) (moteur annuel, §
7.7, A22) qui notait : « Aucune interface utilisateur (frontend) n'a été écrite » et « aucun PPE pluriannuel ». Rien ici
n'est officiel : tout résultat reste **PROVISOIRE, non approuvé** tant que les paramètres du moteur ne sont pas approuvés.

## 1. Ce qui est livré

| Livrable | Où | Nature |
|---|---|---|
| Écran « Moteur de programmation » | `frontend/src/pages/MoteurProgrammationPage.tsx` et `pages/moteur/`, route `/programmation/moteur`, menu Travaux (ADMIN, GESTIONNAIRE) | trois onglets : scénario annuel, plan pluriannuel, fiches figées |
| Volet « Interventions figées » de la Fiche 360° | `frontend/src/components/Fiche360Volets.tsx`, `backend/src/tableau-de-bord/fiche360.service.ts` | lit `fiches_intervention_courantes` ; remplace l'indisponibilité |
| Noyau PPE | `backend/src/programmation/ppe.noyau.ts` | pur, aucun import de base, déterministe |
| Service PPE audité | `ppe.service.ts`, `ppe.depot.ts` | SQL étiqueté, écriture et audit dans la même transaction |
| Routes PPE et praticabilité | `backend/src/api-v2/programmation.ppe.routes.ts`, deux routes dans `programmation.moteur.routes.ts` | corps zod `strict`, aucun PUT, PATCH, DELETE |
| Table `plans_pluriannuels` | migration `20261026300000_plans_pluriannuels` et sa descente | additive, figée par déclencheur |
| Banc PostGIS | `backend/tests-integration/ppe.integration.mts` | oracle indépendant, contre-épreuve |

### 1.1 L'écran

* **Scénario annuel** : année, intitulé, enveloppe en GNF (champ **vide au départ**, aucune valeur proposée, saisie
  refusée si ce n'est pas un entier de 1 à 18 chiffres), région, classe de route, version des paramètres (« choix
  automatique » laisse le serveur désigner ; avec plusieurs versions provisoires et aucune approuvée il refuse de choisir
  et l'écran affiche ce refus). Le montant part en **chaîne de chiffres**. Résultat : totaux, puis lecture **ligne par
  ligne** ; chaque ligne s'ouvre sur sa justification : phrase du moteur, entrées (longueur et son origine), facteurs
  (poids, disponibilité, valeur, donnée brute, origine, note), formules, projection de dégradation, traitement et sa
  condition, coût et son calcul, barème, priorité, enveloppe avant et après, motif d'exclusion, version des
  paramètres et étiquette. « Rejouer » recalcule depuis les seules entrées stockées et dit si le texte est identique
  octet pour octet. « Figer » exige une **confirmation** (modale : immuable, pas de marché ni d'engagement, étiquette
  héritée) ; la source de financement est facultative et jamais déduite ; les empreintes SHA-256 complètes sont affichées.
* **Résultat vide** : quand aucune ligne n'est retenue, l'écran le dit en alerte avec le motif principal, le nombre de
  facteurs disponibles par tronçon, le minimum requis, ce qu'il manque au moins et les facteurs absents (avec leur note).
  Le calcul vient des lignes (`diagnostiquerSansRetenue`, testé), le minimum des paramètres. L'écran n'offre pas de
  « baisser le minimum » : c'est un acte de paramétrage audité, hors de cet écran.
* **« PROVISOIRE, non approuvé »** : bandeau de page tant qu'aucune version des paramètres n'est approuvée (avant tout
  calcul), bandeau de résultat avec les motifs, étiquette sur chaque ligne. L'étiquette vient du serveur.
* **Plan pluriannuel** : première année, 2 à 5 années, une enveloppe saisie par année (0 valide), même périmètre. Résultat :
  synthèse par année (enveloppe, engagé, reste, candidats examinés, retenues), lignes de chaque année à la demande, liste des
  tronçons retenus sur l'horizon, rejeu. L'écran dit « méthode gloutonne et déterministe, sans optimisation ».
* **Fiches figées** : liste filtrable (année, statut), détail : empreinte figée et **vérification recalculée par le
  serveur** (« recalculée à l'identique » ou « ÉCART »), étiquette figée, justification, cycle de vie en ajout seul, contenu
  complet. L'écran ne saisit aucun statut (la transition de statut depuis l'interface n'est pas livrée).

### 1.2 Le volet Fiche 360°

`voletProgrammation` ajoute `interventionsFigees` : `{ disponible: true, total, tronque, plafond (100), fiches }` avec, par
fiche : référence, année, version des paramètres, empreinte SHA-256, statut courant, date du statut, traitement, montant (chaîne),
étiquette figée dans la fiche, historique complet des statuts (origine comprise). Si la table n'existe pas (code PostgreSQL
42P01), `{ disponible: false, motif }` : toute autre erreur remonte, jamais avalée en « aucune fiche ». Aucune fiche : « Aucune
intervention n'a été figée pour ce tronçon. Ce n'est pas une absence de besoin ».

## 2. Le plan pluriannuel : méthode et limites

**Méthode : gloutonne et déterministe, année par année. Aucune optimisation, aucun PLNE.** Pour chaque année saisie,
`construireScenario` (le noyau annuel inchangé) est appelé sur les candidats **non retenus les années précédentes**. Un tronçon
retenu une année n'est jamais réutilisé ; un tronçon écarté pour budget reste candidat l'année suivante.

* Les enveloppes sont **saisies** (2 à 5, `MAX_ANNEES_PPE` : borne explicite, la conception dit « glissant 3 à 5 ans »). Rien
  n'est réparti, rien n'est reporté (un reste n'est pas une enveloppe), rien n'est indexé. 0 est une saisie valide.
* L'état d'un tronçon non retenu **n'est pas projeté** d'une année à l'autre.
* Les barèmes de chaque année sont ceux dont la fenêtre de validité couvre cette année, tels quels.
* Pas d'enveloppe par source, d'équité régionale minimale, de continuité d'itinéraire, de fenêtre saisonnière : seuls des
  plafonds régionaux annuels optionnels, saisis.
* Plafond de 500 candidats (`MAX_CANDIDATS_PPE`) : chaque année porte son scénario complet. **Choix de protection, non mesuré.**
* **Un plan ne crée aucune fiche** : les fiches se figent depuis un scénario annuel (`fiches_intervention.scenarioId`). Le PPE
  est donc une vue de planification, pas un « PAE dérivé du PPE » au sens de la conception (§ 5.1) : l'arbitrage manuel tracé
  et la dérivation du PAE ne sont pas livrés.
* Étiquette : le plan est PROVISOIRE dès qu'une année l'est ; chaque motif est repris, préfixé par son année.

**Déterminisme.** Aucune horloge ni hasard ; entrées sérialisées dans un ordre normalisé (`entreesPpeVersJson`) ; l'ordre des
tableaux d'entrée n'a aucune influence (chaque scénario annuel a un ordre total). Mêmes entrées, même texte, mêmes empreintes.

**Table `plans_pluriannuels`** : entrées et résultat canoniques, empreintes SHA-256 **vérifiées par CHECK** (le texte stocké est
celui qui a été scellé), colonnes dénormalisées (début, nombre d'années, version, enveloppe totale, engagé, compteurs, étiquette)
dont des CHECK exigent qu'elles disent la même chose que les textes (un CHECK qui vaudrait NULL est neutralisé par `coalesce`).
**Déclencheur** : seule la suppression logique (`deletedAt` de NULL vers une date) est permise ; ni UPDATE, ni DELETE, ni retour
arrière de la suppression. La migration ne sème **aucune ligne**. Descente : refuse s'il existe un plan, exige
`bdri.perte_autorisee`.

## 3. D-02 : la praticabilité

`GET /api/v2/programmation/moteur/praticabilite` lit `referentiel_praticabilites` (valeurs actives) :

* aucune valeur approuvée : **« non branchée : aucune valeur approuvée (D-02) »**, avec le nombre de valeurs déclarées (4 niveaux
  P1 à P4 provisoires dans `replay`) et « aucun critère n'est inventé » ; les alertes sont vides même si une portion porte un niveau non approuvé ;
* au moins une valeur approuvée : **branchée en lecture**. Le moteur lit les portions **courantes et validées** (jamais une
  proposition, jamais une version remplacée ou supprimée) portant un niveau approuvé **non franchissable** (colonne
  `franchissable`, déclarée par AGEROUTE) et **signale** les lignes retenues concernées
  (`GET .../simulations/:id/praticabilite`, idem pour un plan). C'est un signal, pas une règle : **aucun tronçon n'est écarté ni
  reclassé**, parce que le critère d'attribution d'un niveau au programme n'est pas arrêté (D-02). Un test prouve que le plan
  calculé avant et après le branchement a la même empreinte.

## 4. Paramètres provisoires et ce qui reste à approuver

Aucun paramètre nouveau n'est introduit. Le PPE utilise les `parametres_programmation` existants (version d'amorçage
`prog-provisoire-1`, **sans source**, jamais approuvée : pondérations, correspondance état vers risque, plafonds, classes de
trafic, minimum de facteurs, horizon, seuil). Bornes nouvelles, **choix de protection et non règles métier** : 2 à 5 années,
500 candidats par plan, 100 fiches par volet. À approuver, sans changement depuis le document du moteur : D-01 (état, poids,
forme de l'agrégation), D-07 (barèmes), D-02 (critère d'attribution d'un niveau de praticabilité au programme), catalogue des
traitements, matrices de dégradation. **Approuver les paramètres seuls ne rend pas un scénario officiel** (barème, catalogue et
matrices comptent aussi).

## 5. Ce qui n'est PAS vérifié

* **Aucune donnée de production.** Les bancs tournent sur un clone de `replay` (vide) avec des fixtures écrites pour eux.
  Le résultat sur le réseau réel est **inconnu** : il dépend des facteurs disponibles (aujourd'hui, très probablement tous les
  tronçons écartés faute de facteurs ; l'écran l'explique).
* Volumes et durées : 500 candidats par plan et 3000 par scénario ne sont pas mesurés ; un plan de 5 ans sur 500 candidats porte
  jusqu'à 2500 lignes justifiées dans un seul texte, taille non mesurée.
* L'oracle valide l'arithmétique et le chaînage, **pas le bien-fondé métier** des coefficients.
* Le glouton annuel chaîné n'est pas un optimum pluriannuel ; aucune comparaison avec une solution optimale n'a été faite.
* La transition de statut des fiches depuis l'écran n'est pas livrée (l'API existe).
* L'écran n'a été éprouvé qu'en jsdom (React Testing Library, axe-core) : **ni rendu navigateur, ni contraste, ni lecteur d'écran,
  ni mobile**. axe n'évalue pas le contraste sous jsdom.
* Aucune lecture des statuts DigitalRoad (B-11) : les statuts à partir de TRANSMIS ne sont jamais alimentés.
* La descente a été exécutée sur le banc `verifier.sh` (schéma avant égal à après, aller-retour, garde), sur un clone vide.

## 6. Vérifications

```
cd backend && npx tsc --noEmit -p . && npx vitest run
DATABASE_URL=postgresql://<utilisateur>:<motdepasse>@127.0.0.1:5434/replay npx tsx tests-integration/ppe.integration.mts
docker exec <conteneur> bash <chemin>/prisma/descentes/verifier.sh --seulement 20261026300000_plans_pluriannuels
cd ../frontend && npx tsc --noEmit && npm run lint && npx vitest run && npm run build
```

**Contre-épreuve du noyau (faite à la main, restaurée ensuite).** Mutation M1 : ne plus retenir les tronçons déjà retenus
(`retenusAvant.set` neutralisé) : 11 tests Vitest échouent (calculs à la main, oracle, routes) et 5 vérifications du banc
(plan différent de l'oracle, tronçon retenu deux fois dans le texte stocké en SQL). Mutation M2 : reporter le reste d'une
année sur l'enveloppe suivante : 4 tests Vitest échouent et 3 vérifications du banc. Le banc contient en outre sa propre
contre-épreuve : trois plans falsifiés (tronçon reretenu, années permutées, engagé décalé d'un franc) doivent être signalés par
l'oracle, et le plan authentique ne doit pas l'être.
