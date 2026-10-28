/**
 * REPONSES REELLES de l'API de consultation des releves en roulage, copiees pour les tests du frontend.
 *
 * ORIGINE (26/10/2026). L'API du depot (`backend/src/server.ts`, routes `backend/src/api-v2/roulage.routes.ts`) lancee sur le port 3411
 * contre un CLONE jetable de la base locale `replay` (PostgreSQL 17 + PostGIS, migration `20261024100000_sessions_roulage`). Trois releves
 * y ont ete ecrits par le VRAI service d'ecriture (`field/sync.service.appliquer`, donc analyse du serveur, portions, audit) pour un
 * agent d'essai : ECR-1 sur le reseau (deux troncons fabriques, deux reperes, deux segments), ECR-2 hors reseau (un repere et un segment
 * non rattaches), ECR-3 de 25 000 positions (geometrie simplifiee). Les reponses ont ensuite ete lues par une connexion REELLE
 * (`POST /api/auth/login`, puis `GET /api/v2/roulage/sessions[/:id]` avec le jeton), sans aucune interception.
 *
 * SEULE MODIFICATION : les coordonnees de la geometrie sont reduites aux 4 premiers sommets de chaque ligne (la reponse reelle en
 * porte 281 pour ECR-1, 90 pour ECR-2 et 3181 pour ECR-3) pour que le fichier reste lisible. Tous les autres champs, valeurs,
 * identifiants et dates sont ceux de la reponse reelle. Ce sont des donnees SYNTHETIQUES d'essai (aucune donnee de production).
 */

/** `GET /api/v2/roulage/sessions?limite=25` : les trois releves de l'agent d'essai, du plus recent au plus ancien. */
export const LISTE_REELLE = {
  "items": [
    {
      "id": "00000001-0000-4000-8000-000000000002",
      "debutA": "2026-10-25T09:00:00.000Z",
      "finA": "2026-10-25T09:01:29.000Z",
      "dureeS": 89,
      "nbPoints": 90,
      "nbMarqueurs": 1,
      "nbEvenements": 1,
      "tauxRattachement": 0,
      "longueurM": 878,
      "missionId": null,
      "agent": {
        "id": "1c4777b7-2ae8-44d5-af1d-616c53d832cd",
        "nom": "Agent Ecran"
      },
      "nbTronconsTraverses": 0,
      "creeLe": "2026-10-26T12:07:27.313Z"
    },
    {
      "id": "00000001-0000-4000-8000-000000000001",
      "debutA": "2026-10-24T08:00:00.000Z",
      "finA": "2026-10-24T08:04:40.000Z",
      "dureeS": 280,
      "nbPoints": 281,
      "nbMarqueurs": 2,
      "nbEvenements": 2,
      "tauxRattachement": 1,
      "longueurM": 2797,
      "missionId": null,
      "agent": {
        "id": "1c4777b7-2ae8-44d5-af1d-616c53d832cd",
        "nom": "Agent Ecran"
      },
      "nbTronconsTraverses": 2,
      "creeLe": "2026-10-26T12:07:23.248Z"
    },
    {
      "id": "00000001-0000-4000-8000-000000000003",
      "debutA": "2026-10-23T06:00:00.000Z",
      "finA": "2026-10-23T12:56:39.000Z",
      "dureeS": 24999,
      "nbPoints": 25000,
      "nbMarqueurs": 0,
      "nbEvenements": 0,
      "tauxRattachement": 0,
      "longueurM": 18921,
      "missionId": null,
      "agent": {
        "id": "1c4777b7-2ae8-44d5-af1d-616c53d832cd",
        "nom": "Agent Ecran"
      },
      "nbTronconsTraverses": 0,
      "creeLe": "2026-10-26T12:07:31.313Z"
    }
  ],
  "suivant": null,
  "total": 3
};

/** `GET /api/v2/roulage/sessions/:id` du releve ECR-1 : sur le reseau, deux troncons, deux reperes rattaches, deux segments (portions creees). */
export const DETAIL_REEL_ECR1 = {
  "id": "00000001-0000-4000-8000-000000000001",
  "debutA": "2026-10-24T08:00:00.000Z",
  "finA": "2026-10-24T08:04:40.000Z",
  "dureeS": 280,
  "nbPoints": 281,
  "nbMarqueurs": 2,
  "nbEvenements": 2,
  "tauxRattachement": 1,
  "longueurM": 2797,
  "missionId": null,
  "agent": {
    "id": "1c4777b7-2ae8-44d5-af1d-616c53d832cd",
    "nom": "Agent Ecran"
  },
  "nbTronconsTraverses": 2,
  "creeLe": "2026-10-26T12:07:23.248Z",
  "geometrie": {
    "type": "MultiLineString",
    "coordinates": [
      [
        [
          -13.598178,
          9.64
        ],
        [
          -13.598086,
          9.64
        ],
        [
          -13.597995,
          9.64
        ],
        [
          -13.597904,
          9.64
        ]
      ]
    ]
  },
  "simplifiee": false,
  "marqueurs": [
    {
      "id": "00000161-0000-4000-8000-000000001001",
      "code": "NID_DE_POULE",
      "note": "premier repere",
      "poseA": "2026-10-24T08:00:40.000Z",
      "lat": 9.64,
      "lon": -13.594532909496058,
      "sourcePosition": "TRACE",
      "precisionM": 5,
      "positionPerimee": false,
      "statut": "RATTACHE",
      "motif": null,
      "tronconId": "t-ecr-1",
      "tronconCode": "ECR-1",
      "abscisseM": 600.1
    },
    {
      "id": "00000161-0000-4000-8000-000000001002",
      "code": "NID_DE_POULE",
      "note": null,
      "poseA": "2026-10-24T08:03:50.000Z",
      "lat": 9.64,
      "lon": -13.577220456233574,
      "sourcePosition": "TRACE",
      "precisionM": 5,
      "positionPerimee": false,
      "statut": "RATTACHE",
      "motif": null,
      "tronconId": "t-ecr-2",
      "tronconCode": "ECR-2",
      "abscisseM": 1000.1
    }
  ],
  "evenements": [
    {
      "id": "00000178-0000-4000-8000-000000001001",
      "code": "ETAT_CHAUSSEE",
      "note": null,
      "statutAppareil": "CLOS",
      "qualification": {
        "etat": "MAUVAIS"
      },
      "debutA": "2026-10-24T08:00:20.000Z",
      "finA": "2026-10-24T08:01:10.000Z",
      "statutRattachement": "PORTIONS_CREEES",
      "motif": null,
      "portions": [
        {
          "rang": 0,
          "portionId": "b8e17e83-e36a-4edb-bcae-e6d27de93e6a",
          "tronconId": "t-ecr-1",
          "tronconCode": "ECR-1",
          "tronconNom": "Route ECR-1",
          "debutM": 400,
          "finM": 900.1,
          "sens": "CROISSANT"
        }
      ]
    },
    {
      "id": "00000178-0000-4000-8000-000000001002",
      "code": "ETAT_CHAUSSEE",
      "note": null,
      "statutAppareil": "CLOS",
      "qualification": {
        "etat": "MAUVAIS"
      },
      "debutA": "2026-10-24T08:01:50.000Z",
      "finA": "2026-10-24T08:02:40.000Z",
      "statutRattachement": "PORTIONS_CREEES",
      "motif": null,
      "portions": [
        {
          "rang": 0,
          "portionId": "bcab5959-80f6-4987-b85b-235e63c89298",
          "tronconId": "t-ecr-1",
          "tronconCode": "ECR-1",
          "tronconNom": "Route ECR-1",
          "debutM": 1300.1,
          "finM": 1480.1,
          "sens": "CROISSANT"
        },
        {
          "rang": 1,
          "portionId": "e1727d92-fa5e-4bc6-bb79-5f03c8a24a7e",
          "tronconId": "t-ecr-2",
          "tronconCode": "ECR-2",
          "tronconNom": "Route ECR-2",
          "debutM": 0,
          "finM": 300,
          "sens": "CROISSANT"
        }
      ]
    }
  ],
  "analyse": {
    "compteurs": {
      "rejets": {},
      "alertes": 0,
      "sansPrecision": 0
    },
    "trous": [],
    "interruptions": [],
    "pauses": [],
    "serveur": {
      "parametres": {
        "graphe": false,
        "reseau": "reference",
        "pasMinM": [
          15
        ],
        "distanceMaxM": 50,
        "fenetreRattachementMs": 10000,
        "distanceMaxProjectionM": 50
      },
      "indicateurs": {
        "passages": 2,
        "segments": 1,
        "pointsRecus": 281,
        "pointsRetenus": 141,
        "horsReferentiel": 0,
        "pointsRattaches": 141,
        "segmentsIgnores": 0,
        "segmentsAnalyses": 1,
        "tauxRattachement": 1,
        "distanceParcourueM": 2797,
        "transitionsNonVerifiees": 1
      },
      "avertissements": [
        "1 changement(s) de troncon ne sont pas verifies sur le reseau (le graphe n'est pas utilise) : fournir la tolerance de fusion des extremites pour les verifier, et lire le taux de rattachement avec cette reserve.",
        "1 changement(s) de troncon non verifies sur le reseau (graphe non demande) : lire le taux de rattachement avec cette reserve."
      ]
    }
  },
  "parametres": {
    "provenance": "PROVISOIRE_NON_CALIBRE",
    "versionContrat": 1,
    "seuils": {
      "trouMs": 5000,
      "precisionMaxM": 50,
      "vitesseMaxKmH": 200,
      "deriveHorlogeMs": 2000,
      "coupureSegmentMs": 30000,
      "vitesseMouvementMs": 1,
      "ageFixMaxMarqueurMs": 2000,
      "dureeMinEvenementMs": 1000,
      "fixFigeEchantillons": 10,
      "intervalleAttenduMs": 1000,
      "reancrageApresRejets": 5,
      "refuserSansPrecision": false,
      "distanceMinEvenementM": 10,
      "couvertureMinEvenement": 0.8,
      "budgetLatenceLogicielleMs": 200
    }
  },
  "trace": {
    "nbPoints": 281,
    "pointsDisponibles": true
  }
};

/** Releve ECR-2 : hors reseau. Repere et segment NON RATTACHES avec leur motif, taux de rattachement a 0, avertissement du serveur. */
export const DETAIL_REEL_ECR2 = {
  "id": "00000001-0000-4000-8000-000000000002",
  "debutA": "2026-10-25T09:00:00.000Z",
  "finA": "2026-10-25T09:01:29.000Z",
  "dureeS": 89,
  "nbPoints": 90,
  "nbMarqueurs": 1,
  "nbEvenements": 1,
  "tauxRattachement": 0,
  "longueurM": 878,
  "missionId": null,
  "agent": {
    "id": "1c4777b7-2ae8-44d5-af1d-616c53d832cd",
    "nom": "Agent Ecran"
  },
  "nbTronconsTraverses": 0,
  "creeLe": "2026-10-26T12:07:27.313Z",
  "geometrie": {
    "type": "MultiLineString",
    "coordinates": [
      [
        [
          -13.6,
          9.9
        ],
        [
          -13.599909,
          9.9
        ],
        [
          -13.599818,
          9.9
        ],
        [
          -13.599727,
          9.9
        ]
      ]
    ]
  },
  "simplifiee": false,
  "marqueurs": [
    {
      "id": "00000161-0000-4000-8000-000000002001",
      "code": "NID_DE_POULE",
      "note": "premier repere",
      "poseA": "2026-10-25T09:00:20.000Z",
      "lat": 9.9,
      "lon": -13.598177636498686,
      "sourcePosition": "TRACE",
      "precisionM": 5,
      "positionPerimee": false,
      "statut": "NON_RATTACHE",
      "motif": "AUCUN_POINT_RATTACHE_A_PROXIMITE",
      "tronconId": null,
      "tronconCode": null,
      "abscisseM": null
    }
  ],
  "evenements": [
    {
      "id": "00000178-0000-4000-8000-000000002001",
      "code": "ETAT_CHAUSSEE",
      "note": null,
      "statutAppareil": "CLOS",
      "qualification": null,
      "debutA": "2026-10-25T09:00:20.000Z",
      "finA": "2026-10-25T09:01:00.000Z",
      "statutRattachement": "NON_RATTACHE",
      "motif": "AUCUN_POINT_RATTACHE_AU_DEBUT",
      "portions": []
    }
  ],
  "analyse": {
    "compteurs": {
      "rejets": {},
      "alertes": 0,
      "sansPrecision": 0
    },
    "trous": [],
    "interruptions": [],
    "pauses": [],
    "serveur": {
      "parametres": {
        "graphe": false,
        "reseau": "reference",
        "pasMinM": [
          15
        ],
        "distanceMaxM": 50,
        "fenetreRattachementMs": 10000,
        "distanceMaxProjectionM": 50
      },
      "indicateurs": {
        "passages": 0,
        "segments": 1,
        "pointsRecus": 90,
        "pointsRetenus": 45,
        "horsReferentiel": 1,
        "pointsRattaches": 0,
        "segmentsIgnores": 0,
        "segmentsAnalyses": 1,
        "tauxRattachement": 0,
        "distanceParcourueM": 878,
        "transitionsNonVerifiees": 0
      },
      "avertissements": [
        "Moins de la moitie des points sont expliques par le reseau choisi : verifier le reseau (classe ou complet), la zone et la distance maximale."
      ]
    }
  },
  "parametres": {
    "provenance": "PROVISOIRE_NON_CALIBRE",
    "versionContrat": 1,
    "seuils": {
      "trouMs": 5000,
      "precisionMaxM": 50,
      "vitesseMaxKmH": 200,
      "deriveHorlogeMs": 2000,
      "coupureSegmentMs": 30000,
      "vitesseMouvementMs": 1,
      "ageFixMaxMarqueurMs": 2000,
      "dureeMinEvenementMs": 1000,
      "fixFigeEchantillons": 10,
      "intervalleAttenduMs": 1000,
      "reancrageApresRejets": 5,
      "refuserSansPrecision": false,
      "distanceMinEvenementM": 10,
      "couvertureMinEvenement": 0.8,
      "budgetLatenceLogicielleMs": 200
    }
  },
  "trace": {
    "nbPoints": 90,
    "pointsDisponibles": true
  }
};

/** Releve ECR-3 : 25 000 positions, geometrie SIMPLIFIEE (3 181 sommets rendus au lieu de 25 000), aucun repere ni segment. */
export const DETAIL_REEL_ECR3 = {
  "id": "00000001-0000-4000-8000-000000000003",
  "debutA": "2026-10-23T06:00:00.000Z",
  "finA": "2026-10-23T12:56:39.000Z",
  "dureeS": 24999,
  "nbPoints": 25000,
  "nbMarqueurs": 0,
  "nbEvenements": 0,
  "tauxRattachement": 0,
  "longueurM": 18921,
  "missionId": null,
  "agent": {
    "id": "1c4777b7-2ae8-44d5-af1d-616c53d832cd",
    "nom": "Agent Ecran"
  },
  "nbTronconsTraverses": 0,
  "creeLe": "2026-10-26T12:07:31.313Z",
  "geometrie": {
    "type": "MultiLineString",
    "coordinates": [
      [
        [
          -13.47266,
          9.950017
        ],
        [
          -13.472612,
          9.950089
        ],
        [
          -13.472664,
          9.950098
        ],
        [
          -13.472616,
          9.950276
        ]
      ]
    ]
  },
  "simplifiee": true,
  "marqueurs": [],
  "evenements": [],
  "analyse": {
    "compteurs": {
      "rejets": {},
      "alertes": 0,
      "sansPrecision": 0
    },
    "trous": [],
    "interruptions": [],
    "pauses": [],
    "serveur": {
      "parametres": {
        "graphe": false,
        "reseau": "reference",
        "pasMinM": [
          30
        ],
        "distanceMaxM": 50,
        "fenetreRattachementMs": 10000,
        "distanceMaxProjectionM": 50
      },
      "indicateurs": {
        "passages": 0,
        "segments": 1,
        "pointsRecus": 25000,
        "pointsRetenus": 606,
        "horsReferentiel": 1,
        "pointsRattaches": 0,
        "segmentsIgnores": 0,
        "segmentsAnalyses": 1,
        "tauxRattachement": 0,
        "distanceParcourueM": 18921,
        "transitionsNonVerifiees": 0
      },
      "avertissements": [
        "Moins de la moitie des points sont expliques par le reseau choisi : verifier le reseau (classe ou complet), la zone et la distance maximale."
      ]
    }
  },
  "parametres": {
    "provenance": "PROVISOIRE_NON_CALIBRE",
    "versionContrat": 1,
    "seuils": {
      "trouMs": 5000,
      "precisionMaxM": 50,
      "vitesseMaxKmH": 200,
      "deriveHorlogeMs": 2000,
      "coupureSegmentMs": 30000,
      "vitesseMouvementMs": 1,
      "ageFixMaxMarqueurMs": 2000,
      "dureeMinEvenementMs": 1000,
      "fixFigeEchantillons": 10,
      "intervalleAttenduMs": 1000,
      "reancrageApresRejets": 5,
      "refuserSansPrecision": false,
      "distanceMinEvenementM": 10,
      "couvertureMinEvenement": 0.8,
      "budgetLatenceLogicielleMs": 200
    }
  },
  "trace": {
    "nbPoints": 25000,
    "pointsDisponibles": true
  }
};

/** `GET /api/v2/roulage/sessions` par un AUTRE agent : liste vide honnete (200, total 0). */
export const LISTE_REELLE_AUTRE_AGENT = {
  "items": [],
  "suivant": null,
  "total": 0
};

/** Corps du 404 du detail (releve d'un autre agent, inexistant, supprime ou identifiant mal forme : un seul corps). */
export const CORPS_404_REEL = {
  "error": "Releve introuvable",
  "code": "RELEVE_INTROUVABLE"
};

/** `GET /api/v2/roulage/sessions?depuis=2026-10-24T00:00:00.000Z&jusqua=2026-10-24T23:59:59.999Z` : instants ISO avec fuseau, acceptes (200). */
export const LISTE_REELLE_FILTREE = {
  "items": [
    {
      "id": "00000001-0000-4000-8000-000000000001",
      "debutA": "2026-10-24T08:00:00.000Z",
      "finA": "2026-10-24T08:04:40.000Z",
      "dureeS": 280,
      "nbPoints": 281,
      "nbMarqueurs": 2,
      "nbEvenements": 2,
      "tauxRattachement": 1,
      "longueurM": 2797,
      "missionId": null,
      "agent": {
        "id": "1c4777b7-2ae8-44d5-af1d-616c53d832cd",
        "nom": "Agent Ecran"
      },
      "nbTronconsTraverses": 2,
      "creeLe": "2026-10-26T12:07:23.248Z"
    }
  ],
  "suivant": null,
  "total": 1
};

