# Intégration aux autres applications AGEROUTE — la BDRI référentiel, pas ERP

**Ticket** : P5-10
**Date** : 2 septembre 2026

---

## 1. Le principe directeur

> La BDRI ne doit pas devenir un ERP. Elle doit devenir le **référentiel
> géographique et patrimonial** auquel les autres applications font référence.

Concrètement : une application métier (ERP, portail des opportunités, GLPI,
future gestion des marchés) qui parle d'un chantier, d'un marché ou d'un projet
**pointe** vers la BDRI ; elle ne **recopie** ni son intitulé, ni ses PK, ni sa
géométrie. Réciproquement, la BDRI ne recopie pas les données métier de ces
applications (montants consolidés, états de paiement, tickets).

La règle de lecture est simple : **la donnée vit là où elle est saisie**. Tout le
reste est une référence datée.

---

## 2. Ce qui existe déjà et va dans ce sens (mesuré)

| Mécanisme existant | Rôle |
|---|---|
| `MarcheChantier` (table de liaison marché↔chantier) | référence croisée sans duplication des montants |
| `Document` rattachable aux tronçons | le document reste un fichier, la BDRI en est l'index |
| `AuditHistoryModal` + `audit_logs` | la traçabilité des décisions existe déjà côté BDRI |
| identifiants UUID stables (`troncons.id` etc.) | clé technique indépendante des sources (cf. `BDRI-REFERENTIEL-NATIONAL.md` §4) |

---

## 3. Le modèle de référence proposé

Une table unique de références externes, minimaliste :

```text
ReferenceExterne
    id            uuid
    objetBdri     ('TRONCON', 'OUVRAGE', 'CHANTIER', 'POINT_NOIR', 'POSTE', 'INSPECTION')
    objetBdriId   uuid       -- clé BDRI visée
    application   ('ERP', 'OPPORTUNITES', 'GLPI', 'MARCHES', 'SIG_INTERNE')
    typeEntite    ('PROJET', 'MARCHE', 'CHANTIER', 'DECOMPTE', 'INSPECTION', 'DOCUMENT', 'TICKET')
    idExterne     text       -- identifiant DANS l'application source
    urlExterne    text?      -- lien direct si l'application expose une URL
    saisiPar      uuid -> User
    createdAt / updatedAt
```

Règles :

- **un pointeur, jamais une copie** : aucun champ métier de l'application source
  n'est stocké (ni montant, ni statut, ni intitulé) ;
- l'unicité `(application, typeEntite, idExterne, objetBdri, objetBdriId)` empêche
  les références dédoublées ;
- les références sont auditées comme toute écriture (règle 3 d'AGENTS.md) ;
- une référence peut être obsolète (l'application source supprime son objet) :
  elle n'est jamais effacée physiquement, elle est marquée.

---

## 4. Ce que chaque application gagne

| Application | Ce qu'elle pointe dans la BDRI | Ce qu'elle ne recopie plus |
|---|---|---|
| ERP / marchés | `chantierId` → emprise géographique, tronçon, PK | intitulés « RN5 PK 24-66 » re-saisis, régions re-déduites |
| Portail des opportunités | localisation des projets sur le réseau | géométries dupliquées |
| GLPI / maintenance | `ouvrageId`, `posteId` pour les interventions | adresses des ouvrages |
| Future app inspections | `inspectionId`, `tronconId` | tracés GPS re-collectés |
| Dashboards de Direction | KPI BDRI par région/tronçon via l'API publique (P4) | exports Excel intermédiaires |

---

## 5. Contrat d'API minimal

Côté BDRI, deux endpoints suffisent au démarrage :

1. `GET /api/references?objet=TRONCON&id=<uuid>` — liste des références externes
   d'un objet (pour l'afficher dans la fiche tronçon/chantier) ;
2. `POST /api/references` — création d'une référence (rôles ADMIN, GESTIONNAIRE ;
   application source authentifiée par jeton dédié le jour où les applications
   écrivent directement).

Et un garde-fou : l'API publique (`/api/public`) reste en lecture géométrique
seule — les références externes ne sortent jamais par l'API non authentifiée.

---

## 6. Décisions attendues

| # | Décision | Décideur |
|---|---|---|
| 1 | Quelles applications pointeront en premier (proposition : ERP marchés, puis GLPI) | DSI + directions métiers |
| 2 | Les applications écrivent-elles leurs références elles-mêmes (jeton dédié) ou via saisie BDRI ? | DSI |
| 3 | Format d'identification stable côté BDRI : UUID technique aujourd'hui, identifiant patrimonial national demain (cf. `BDRI-REFERENTIEL-NATIONAL.md` §4) — trancher le calendrier | Direction Technique |

**Statut** : l'existant est MESURÉ ; le modèle et l'API sont une PROPOSITION ;
l'ordre d'intégration est REQUIRES_BUSINESS_VALIDATION.
