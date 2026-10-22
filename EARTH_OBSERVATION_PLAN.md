# Plan d'observation de la Terre

> Livrable exigé par le § E.1 du prompt maître V10. Rédigé le 20/10/2026.
> **État** : registre des produits, propositions, verdict du terrain et mesure de précision
> **construits et éprouvés en base** (migration `20261020000000_observation_terre`) ; **cohérence
> entre eux tenue en base et mesurée au volume de la production** depuis le 22/10/2026 (migration
> `20261022000000_teledetection_coherence`, § 7). **Aucune image n'a été téléchargée, aucun
> traitement n'a tourné, aucune dépense n'a été engagée.**

---

## 1. Ce qui est construit, et ce qui ne l'est pas

| Capacité du § E.1 | État | Où |
|---|---|---|
| Module `earth_observation_products` (produit, source, date, résolution, emprise, licence, version de traitement) | **fait** | table `earth_observation_products` ; licence, provenance, incertitude, version obligatoires **en base** ; couverture nuageuse obligatoire pour l'optique ; référence d'autorisation de dépense obligatoire pour les paliers 1 à 3 |
| Propositions localisées rattachées aux tronçons | **fait** | table `propositions_teledetection`, `POST /api/v2/teledetection/propositions` ; rattachement au tronçon le plus proche **seulement si une tolérance est donnée** |
| Le terrain reste juge | **fait** | verdict CONFIRMEE / INFIRMEE, une fois, citant son constat ; la détection est **figée** à l'insertion (déclencheur) |
| Mesure de la précision contre les constats terrain | **fait** | vue `precision_teledetection`, par type et par méthode ; **nulle sans verdict**, pas zéro |
| Export des zones à vérifier comme missions de patrouille (EX-03) | **fait** | `POST /api/v2/teledetection/propositions/:id/verification` : mission SURVEILLANCE en brouillon |
| Cohérence registre / propositions / verdicts | **fait** (22/10) | déclencheur à l'insertion (produit vivant, géométrie dans l'emprise, référence antérieure et couvrante, distance au tronçon **mesurée**, jamais saisie), registre figé dès qu'un produit est cité, aucune suppression physique ; vue `coherence_teledetection` et `GET /api/v2/teledetection/coherence` pour ce qui survient après coup ; section « Cohérence » de l'écran `/teledetection` |
| Couche « alertes satellite » dans la cellule de veille | **fait** (compteur) | `alertesSatelliteAVerifier` sur la vue murale ; l'affichage cartographique des emprises reste à faire |
| **Moteur de changement** (comparaison de deux dates) | **absent** | demande Python (rasterio, xarray) et des images : hors de ce dépôt tant que les sources ne sont pas choisies |
| Procédure d'activation du Copernicus EMS | **absente** | décision institutionnelle (§ E.1) |

## 2. La règle : descendre, jamais téléverser

Le traitement **descend** des produits publics ; il n'**envoie** rien d'AGEROUTE vers un service
externe. Ni les traces, ni les photos, ni le référentiel. La seule information qui sort est une
**requête** : une emprise géographique et une période, l'une et l'autre publiques. Un service qui
exigerait de lui confier des données d'AGEROUTE pour fonctionner relève de l'analyse de
confidentialité et de localisation que la partie E impose, et n'est pas utilisé avant elle.

## 3. Sources du palier 0, telles que le mandat les énumère

Les **licences ne sont pas écrites ici** : elles se relèvent sur la page officielle de chaque source
au moment de l'usage, et le registre refuse tout produit qui n'en porte pas. Les écrire de mémoire
serait affirmer des conditions que personne n'a vérifiées.

| Source (§ E.1) | Nature au registre | Usage visé (§ E.1) | Licence |
|---|---|---|---|
| Sentinel-1 | RADAR | inondations, coupures en saison des pluies (voit à travers les nuages) | à relever à la source |
| Sentinel-2 | OPTIQUE | nouvelles routes et pistes ; végétation sur l'emprise (NDVI) | à relever à la source |
| Copernicus DEM | ALTIMETRIE | pentes, vulnérabilité (R-04) | à relever à la source |
| CHIRPS / GPM IMERG | PRECIPITATIONS | cumul de pluie, bourbiers probables | à relever à la source |
| WorldPop / GHS-POP | POPULATION | accessibilité (RAI) | à relever à la source |
| Copernicus Global Flood Monitoring | INONDATION | cartes d'inondation quasi temps réel | à relever à la source |
| OSM, Microsoft Road Detections, GRIP | ROUTES_EXTRAITES | routes absentes du référentiel | à relever à la source |

Google Earth Engine : **non**, tant que ses conditions d'usage n'ont pas été validées (§ E.1).

## 4. Le cycle d'une proposition

1. Un produit est **enregistré** : sans licence, provenance, incertitude ni version de traitement,
   la base le refuse.
2. Un traitement, hors dépôt, produit des géométries. Elles sont **déposées** en un lot, avec la
   méthode (nom et version) et, si l'appelant le décide, une tolérance de rattachement.
3. Chaque proposition est **A_VERIFIER**. La cellule de veille en voit le compte.
4. Une mission de **vérification** peut être dépêchée (EX-03).
5. Le terrain rend son **verdict**, en citant son constat. Le verdict ne se reprend pas.
6. La **précision** de la méthode se lit dans la vue, par type.

Une proposition **ne modifie jamais** un tronçon, une portion ni un état. Une route nouvelle
confirmée par le terrain devient une donnée du référentiel par le circuit ordinaire de proposition
et de validation, pas par la télédétection.

## 5. Ce qui est volontairement absent

- **Aucun seuil de score** : un score est ce que la méthode rend, pas une probabilité d'exactitude.
  La précision se mesure après coup, contre le terrain.
- **Aucune tolérance de rattachement par défaut** : sans tolérance donnée, rien n'est rattaché.
- **Aucun produit semé.**
- **Aucune dépense** : les paliers 1 à 3 exigent une référence d'autorisation, et aucun n'est
  utilisé.

## 6. Décisions attendues

| Décision | Par qui | Ce qu'elle débloque |
|---|---|---|
| Choix des sources du palier 0 et relevé de leurs licences | AGEROUTE / DSI | premier produit au registre |
| Hébergement du traitement (poste, serveur, compte Copernicus Data Space) | DSI | moteur de changement |
| Corridor pilote | AGEROUTE | emprise des premières requêtes |
| Procédure d'activation Copernicus EMS | AGEROUTE, voie institutionnelle | cartographie rapide après catastrophe |
| Paliers 1 à 3 | AGEROUTE, autorisation de dépense | rien avant un cas d'usage mesuré au pilote |

## 7. Cohérence et mesure au volume de la production (22/10/2026)

### Ce que la base refuse désormais

| Incohérence | Pourquoi elle fausse la précision | Où |
|---|---|---|
| Proposition hors de l'emprise de son produit | une détection ne vient que de ce que l'image couvre | déclencheur `propositions_teledetection_coherence`, et le service qui nomme les rangs fautifs (`HORS_EMPRISE`) |
| Référence d'une comparaison de deux dates non antérieure, retirée, ou qui ne couvre pas la géométrie | ce n'est plus une détection de changement | idem ; noyau `verifierReference` |
| Distance au tronçon saisie au lieu d'être mesurée (écart > 1 cm) | le rattachement serait affirmé, pas calculé | déclencheur |
| Modification de la provenance, de la licence ou de l'emprise d'un produit cité | la précision se rapporterait à un autre produit | déclencheur `earth_observation_products_garde` |
| Suppression physique d'un produit | règle 2 d'`AGENTS.md` | idem |

**La nature n'est pas contrainte** : une référence optique d'avant la crue comparée à un radar
d'après est une méthode courante de cartographie des inondations. Une première version de la
migration l'interdisait ; le banc existant l'a fait échouer, et c'était la règle qui avait tort.

### Ce que la vue signale, sans rien corriger

`HORS_EMPRISE` et `REFERENCE_INCOHERENTE` (lignes antérieures au déclencheur, **bloquantes**) ;
`PRODUIT_RETIRE_EN_ATTENTE`, `TRONCON_RETIRE`, `MISSION_SANS_VERDICT` (mission terminée ou annulée,
proposition encore à vérifier), `VERDICT_AVANT_FIN_MISSION` (**à examiner**).

### Mesures (banc `backend/prisma/tests/teledetection.bench.sql`, poste de développement)

261 387 tronçons synthétiques (le volume de la production au 21/10/2026), 8 000 propositions
déposées par la **requête du service recopiée à l'identique**, une par une :

| Tolérance | Médiane | p95 | Rattachées / 2 000 |
|---|---|---|---|
| aucune | 1,57 ms | 12,19 ms | 0 |
| 50 m | 1,85 ms | 11,81 ms | 33 |
| 500 m | 2,12 ms | 12,95 ms | 899 |
| 5 000 m (maximum admis) | 4,69 ms | 15,73 ms | 2 000 |

Plan du plus proche voisin : **index `troncons_geom_geography_idx` employé** (asserté). Exactitude :
sur 40 propositions, troncon et distance trouvés par l'index **identiques** à un balayage complet
sans index (au centimètre ; asserté). 2 400 verdicts posés en 1,1 s ; vue de précision 37 ms ;
liste « à vérifier » de la route 14 ms ; vue de cohérence 102 ms, 0 anomalie.

**Ce que ces chiffres ne disent pas** : la durée sur le serveur de production (autre machine, autre
charge), le coût d'un aller-retour Prisma par proposition, ni un réseau réel (segments tirés au
hasard, non connectés). Les durées sont affichées, non assertées : un plafond de temps dans un banc
partagé serait une fausse alerte dès que le poste est chargé.
