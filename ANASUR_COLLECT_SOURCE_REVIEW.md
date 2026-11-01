# Revue des sources sur ANASUR Collect

> Livrable 9 du § B.6, fondé sur le § B.2 du prompt maître V10. **Rédigé le 14/10/2026.**
>
> 🔒 Règle du § B.2, reprise mot pour mot tant qu'aucune preuve n'existe :
> **« éditeur / développeur non confirmé par les sources publiques consultées »**.

## 1. Ce que les sources publiques établissent

Le ministère des Infrastructures a publié les **8 et 9 juillet 2026** les informations d'un
atelier national de renforcement des capacités sur la BDR :

| Fait annoncé | Source |
|---|---|
| Formation et certification de **46 agents** | infrastructures.gov.gn, 08/07/2026 |
| Harmonisation des méthodes de collecte dans les **huit régions** | idem |
| Remise de **46 tablettes Android avec cartes SIM data** | idem |
| Utilisation annoncée de l'application **ANASUR Collect** | idem |
| **Huit protocoles régionaux** | communiqué de clôture |

Pages à conserver : `https://infrastructures.gov.gn/2026/07/08/` et
`https://infrastructures.gov.gn/cloture-de-latelier-national-de-renforcement-des-capacites-sur-la-banque-de-donnees-routieres-bdr/`.

**Ces deux pages ont été lues le 14/10 au soir**, et elles confirment le § B.2 sur tous les
points : 46 agents, 46 tablettes Android avec SIM data, huit régions, application ANASUR
Collect, huit protocoles régionaux (page du 08/07 ; la page du 09/07 parle d'harmonisation sans
nommer les protocoles). Le ministre Facinet Sylla a présidé, le directeur général de l'ANASUR,
Alpha Sekou Bangoura, a pris la parole.

**Et elles établissent deux absences qui comptent** :

- **l'éditeur et le développeur** d'ANASUR Collect sont **absents des deux pages** — la formule
  du § B.2 reste donc la seule exacte ;
- **l'ONR et AGEROUTE sont absents des deux articles.** L'atelier BDR de juillet 2026 associe le
  ministère et l'ANASUR ; ni l'office qui porte la BDR nationale depuis 2018 (L²R Base), ni le
  gestionnaire opérationnel ne sont cités. Ce silence est une information : il rend la question
  du **double relevé** (D-08) plus pressante, et il interdit de présumer que la collecte ANASUR
  alimente L²R Base.

## 2. Ce que ces sources n'établissent PAS

Elles confirment **l'initiative et l'équipement**. Elles ne documentent :

- ni l'**éditeur** ni le **développeur** — *non confirmés par les sources publiques consultées* ;
- ni l'**architecture** ;
- ni les **formats** d'export ou d'import ;
- ni les **API** ;
- ni le **protocole de synchronisation** ;
- ni le **modèle de données**.

## 3. Hypothèses à ne pas faire

Le § B.2 les nomme, et ce document les écarte explicitement :

| Hypothèse tentante | Statut |
|---|---|
| ANASUR Collect a été développé par Logiroad | **non établi** |
| ANASUR Collect remplace L²R Mesure | **non établi** |
| ANASUR Collect se connecte à L²R ou partage sa base | **non établi** |
| ANASUR Collect expose une API | **non établi** — et le garde-fou V10 interdit d'en supposer une |

**Interdit** : tenter de contourner l'application, d'extraire des données protégées ou d'accéder à
des API non autorisées.

## 4. Hypothèse de travail d'architecture — à valider avec les autorités

Telle que le § B.2 la formule, et **comme cible, pas comme conclusion juridique** :

| Système | Rôle supposé |
|---|---|
| BDR / ONR | centralisation, harmonisation, analyse et diffusion nationales |
| **ANASUR Collect** | collecte terrain nationale sur tablettes |
| Géoportail | référentiel géospatial et patrimoine géré par AGEROUTE |
| AGEROUTE ROAD | missions, patrouilles, roulage, inspections, propositions |
| DigitalRoad | contractuel et financier |
| SharePoint | documentaire |

Cette répartition pose une question que seules les autorités peuvent trancher : **deux outils de
collecte terrain coexisteraient** — ANASUR Collect pour la BDR nationale, AGEROUTE ROAD pour
AGEROUTE. Le § 7.15 répond par l'interopérabilité (IO-01, IO-02) et non par l'exclusion ; mais
la question du **double relevé sur les mêmes routes** est institutionnelle, et elle est portée
en D-08.

## 5. Ce qui en découle pour le dépôt

- **Aucune ligne de code** ne doit présumer d'ANASUR Collect. Vérifié le 14/10 : aucune
  occurrence d'`anasur` dans `backend/src` hors ce garde-fou.
- Le **questionnaire technique** (`ANASUR_COLLECT_TECHNICAL_QUESTIONNAIRE.md`) est la seule
  action possible aujourd'hui, et c'est précisément celle qui débloquerait un jour A28.
- Le **contrat d'import unique** (`ROAD_SURVEY_IMPORT_SPEC.md`) est conçu pour recevoir un
  export ANASUR **quel que soit son format**, par le pivot ouvert — sans rien supposer.
