# Confrontation de la BDRI aux sources externes — septembre 2026

**Date** : 3 septembre 2026
**Objet** : découpage administratif officiel, travaux routiers récents, fraîcheur d'OpenStreetMap.
**Portée** : **aucune donnée n'a été modifiée.** Ce document mesure des écarts et nomme des sources.

> Complète `REFERENTIEL-ADMINISTRATIF-SPEC.md`, qui posait la structure cible mais
> concluait : « la Phase 5 ne désigne pas la source ». Ce document en nomme une, et
> montre pourquoi les champs `ValidFrom` / `ValidTo` qu'elle prévoyait ne sont pas
> théoriques — le découpage a changé le 20 août 2026.

Chaque constat porte sa nature : **MESURÉ** (sur notre base ou par requête directe),
**SOURCE_EXTERNE** (publication tierce), **INFÉRÉ** (déduction de ma part),
**INCONNU**, **À_VALIDER** (décision métier AGEROUTE).

---

## 1. Le découpage administratif a changé il y a deux semaines

**SOURCE_EXTERNE.** Deux décrets rendus publics le **20 août 2026** créent deux
régions administratives et onze préfectures.

| | Avant | Après |
|---|---:|---:|
| Régions administratives | 8 | **10** |
| Préfectures | 33 | **44** |

Nouvelles régions : **Siguiri** et **Beyla**.

Nouvelles préfectures, par région de rattachement :

| Région | Préfectures créées |
|---|---|
| Boké | Kamsar |
| Mamou | Timbo |
| Kankan | Tokounou, Dialakoro, Sabadou-Baranama |
| Siguiri | Doko, Siguirini, Kintinian |
| Beyla | Sinko, Kouankan *(orthographié « Kouranka » par une des deux sources)*, Karala |

**MESURÉ — notre base porte 8 régions** (`Conakry, Boké, Kindia, Mamou, Labé,
Faranah, Kankan, Nzérékoré`) plus une neuvième ligne `Non renseigné` qui n'est pas
une région mais un contournement de la contrainte NOT NULL, utilisée par 50 chantiers.

**Le référentiel régional de la BDRI est donc périmé de deux semaines.**

Antériorité utile : le décret **D/2025/055/PRG/CNRD/SGG du 14 avril 2025** avait
codifié les entités — régions en code numérique (Conakry 01, Kindia 02, Boké 03,
Mamou 04, Labé 05, Faranah 06, Kankan 07, Nzérékoré 08), préfectures en code à trois
lettres (Coyah CYA, Dubréka DBK, Kindia KDA, Boké BKE, Labé LBE, Kankan KKA,
Nzérékoré ZKR…). Ces codes figurent sur les documents d'identité. **Ils constituent
une clé d'appariement stable**, ce que les noms libres de la BDRI n'offrent pas.

---

## 2. La source des limites administratives — enfin identifiée

C'est le manque signalé depuis l'audit de phase 4 : sans découpage géographique, 299
chantiers restent non géolocalisables et `regionId` ne peut être qu'une déduction.

**SOURCE_EXTERNE.** Le jeu de référence existe : **Guinea – Subnational
Administrative Boundaries (COD-AB)**, publié sur HDX par OCHA Afrique de l'Ouest et
Centrale.

| | |
|---|---|
| Niveaux | ADM0 à ADM3 (région, préfecture, sous-préfecture), plus ADM4 pour Conakry |
| Formats | shapefile, géodatabase, géoservices |
| Clés | **P-codes**, conçus pour l'appariement entre jeux |
| Dernière revue | **octobre 2024** |

**Limite décisive, INFÉRÉE de la date** : ce jeu est antérieur à la réforme du 20 août
2026. Il porte donc **8 régions et 33 préfectures**, pas 10 et 44. Il permet de
géolocaliser selon l'ancien découpage, pas selon l'actuel.

**À_VALIDER** : AGEROUTE travaille-t-elle sur l'ancien ou le nouveau découpage ? Les
marchés et dossiers antérieurs à août 2026 réfèrent au premier ; l'organisation
administrative actuelle au second. Les deux devront coexister, avec une date de
validité — c'est une décision métier, pas technique.

---

## 3. Les travaux 2025-2026 : la base tient mieux que craint

**SOURCE_EXTERNE.** Bilan AGEROUTE 2025 : 513 ponts et dalots construits ou
réhabilités, 14 ponts de désenclavement lancés, 279 km d'entretien courant, 109 km de
reprofilage de routes en terre, 6 300 m linéaires de curage.

Axes cités, confrontés à la base :

| Axe annoncé | Linéaire annoncé | Chantiers en base |
|---|---:|---:|
| Labé – Mali (RN8, lots 1-2) | 107 km | 6 |
| Bissikirima – Dinguiraye (RN30) | 75 km | 4 |
| Mamou – Labé (RN5) | 135 km | 4 |
| Kankan – Kérouané – Beyla (RN1) | 260 km | 3 |
| Mamou – Faranah (RN2) | 187 km | 3 |
| Dankakoro – Nafadji | 51 km | 2 |
| Bokaria – Madina Oula (RN13) | 39 km | 1 |
| Boké – Québo (RN12) | 86 km | 1 |
| Lola – N'zoo – Frontière CI (RN2) | — | 1 |
| Tanènè – Koba | 70 km | 1 |
| **Nzérékoré – Yomou – Frontière Libéria (RN11)** | **75 km** | **0** |

**MESURÉ.** Dix des onze axes annoncés sont représentés. Un seul est absent.
Par ailleurs **60 chantiers portent une date en 2025 ou 2026** ; le plus récent début
prévu est en janvier 2026. Le registre des chantiers n'est pas à l'abandon.

### Deux corroborations exactes

**MESURÉ.** Le linéaire de deux axes concorde au kilomètre près entre l'annonce
AGEROUTE et la somme des tronçons en base :

| Axe | Annoncé | En base |
|---|---:|---:|
| RN12 Boké – Québo | 86 km | **86 km** (4 tronçons) |
| RN13 Bokaria – Madina Oula | 39 km | **39 km** (2 tronçons) |

C'est la première concordance externe obtenue sur des longueurs de la BDRI. Elle ne
vaut que pour ces deux axes.

**INFÉRÉ** : pour les autres, le linéaire en base excède l'annonce (RN1 : 1 239 km en
base contre 260 km annoncés) parce que l'annonce vise un tronçon de l'axe, pas l'axe
entier. Ce n'est pas une contradiction.

---

## 4. OpenStreetMap : notre instantané a trois ans et demi

**MESURÉ.** Les dates de source de nos 262 656 voies s'étendent du 8 août 2009 au
**6 mars 2023**. Geofabrik publie un extrait Guinée daté du **2 septembre 2026**.

Comparaison directe par l'API Overpass, données OSM du **3 septembre 2026 à 19h58** :

| Type OSM | OSM aujourd'hui | Notre instantané 2023 | Écart |
|---|---:|---:|---:|
| trunk *(voie rapide)* | 1 073 | 1 072 | +1 |
| primary | 645 | 596 | +49 (+8 %) |
| secondary | 1 421 | 852 | **+569 (+67 %)** |
| tertiary | 2 832 | 2 962 | −130 (−4 %) |
| unclassified | 37 684 | 41 090 | −3 406 (−8 %) |
| residential | 51 761 | 34 961 | **+16 800 (+48 %)** |
| service | 8 668 | 5 806 | **+2 862 (+49 %)** |
| track | 83 568 | 69 425 | +14 143 (+20 %) |
| path | 104 104 | 102 100 | +2 004 (+2 %) |
| footway | 3 386 | 3 758 | −372 (−10 %) |
| **Total** | **295 142** | **262 622** | **+32 520 (+12 %)** |

Contrôle local : sur l'emprise de Kaloum, OSM porte aujourd'hui **527 voies** contre
**442** dans notre instantané — +19 %.

**INFÉRÉ, et c'est une réserve importante** : l'appariement entre nos catégories et
les types OSM n'est pas exact. Notre source n'était pas de l'OSM brut mais un produit
dérivé francophone (`NATURE` : « résidentielle », « non classifié »…), et le
classement en onze catégories est une lecture documentée, pas une donnée. Les écarts
négatifs — tertiary, unclassified, footway — s'expliquent vraisemblablement par des
requalifications plutôt que par des suppressions, ce qui **interdit de lire ce tableau
type par type**. Le total, lui, est robuste.

---

## 5. Ce que cela appelle, et ce que cela n'autorise pas

**Ce qui est établi**

1. Le référentiel régional est périmé depuis le 20 août 2026 (8 régions au lieu de 10).
2. La source des limites administratives existe et est nommée — mais elle décrit
   l'ancien découpage.
3. Le registre des chantiers couvre 10 des 11 grands axes 2025 ; RN11 Nzérékoré –
   Yomou manque.
4. Notre instantané OSM accuse 3 ans et demi de retard, soit +12 % d'objets.

**Ce qui ne doit pas en découler automatiquement**

Rien de tout cela n'autorise une correction automatique. En particulier :

- **Ne pas renommer ni renuméroter les régions existantes.** 1 690 tronçons, 487
  chantiers et 126 ouvrages y sont rattachés par `regionId`. Ajouter Siguiri et Beyla
  est additif ; redécouper Kankan et Nzérékoré déplacerait des actifs, ce qui est une
  décision métier datée.
- **Ne pas réimporter OSM par-dessus l'existant.** 350 voies portent désormais un
  tronçon du patrimoine ; un réimport naïf casserait ce rattachement. Un rafraîchissement
  doit être différentiel et préserver `tronconId`.
- **Ne pas créer le chantier RN11 manquant** sur la foi d'un article de presse. Une
  publication n'est pas un dossier de marché.

**À_VALIDER par AGEROUTE**

| Question | Pourquoi elle bloque |
|---|---|
| Ancien ou nouveau découpage comme référence ? | Les deux coexisteront ; il faut une date de validité |
| Les 50 chantiers en « Non renseigné » relèvent de quelles régions ? | Correction de saisie, pas algorithme |
| RN11 Nzérékoré – Yomou : chantier réel à enregistrer ? | Seul un dossier de marché fait foi |
| Rafraîchir OSM à l'extrait 2026-09-02 ? | +32 520 objets ; impose un import différentiel |

---

## Sources

- Décrets du 20 août 2026 — [Journal de Conakry](https://journaldeconakry.com/decoupage-administratif-guinee-deux-regions-onze-prefectures/), [Accent Guinée](https://www.accentguinee.com/decoupage-territoiriel-beyla-et-siguiri-eriges-en-regions-administratives-de-nouvelles-prefectures-creees-decret/)
- Décret D/2025/055 du 14 avril 2025, codification — [Africa Guinée](https://www.africaguinee.com/guinee-voici-les-codes-attribues-aux-regions-et-aux-prefectures/), [Guinée114](https://www.guinee114.com/2025/04/15/guinee-codification-des-regions-administratives-et-prefectures-decret/)
- Subdivisions — [Wikipédia](https://fr.wikipedia.org/wiki/Subdivision_de_la_Guin%C3%A9e), [Institut National de la Statistique](https://www.stat-guinee.org/)
- Limites administratives — [Guinea Subnational Administrative Boundaries, HDX/OCHA](https://data.humdata.org/dataset/guinea-geodatabase)
- Bilan routier 2025 et programme 2026 — [Guinéenews](https://guineenews.org/2025/12/31/reseau-routier-national-des-centaines-de-kilometres-realises-en-2025-et-de-grands-chantiers-annonces-pour-2026-par-lageroute-guineesa/), [AGEROUTE Guinée](https://ageroute.gov.gn/?p=5153)
- Extrait OSM Guinée — [Geofabrik](https://download.geofabrik.de/africa/guinea.html) · comptages par [API Overpass](https://overpass-api.de/)
