# AGEROUTE SMART FIELD : état réel par phase, et protocole du pilote

Établi le 25/10/2026. Ce document ne contient aucun résultat de pilote : il n'y en a pas. Les tableaux de mesure sont vides
à dessein.

## 1. État réel des huit phases

| Phase | Ce qui existe (vérifié par tests, voir `TEST_EVIDENCE.md`) | Ce qui manque | État |
|---|---|---|---|
| 1 Socle fiable | Session vide dite et jamais présentée comme relevé ; envoi confirmé retenu ; reprise après redémarrage ; journal injouable dit ; suppression confirmée ; envoi rejoué au retour du réseau, idempotent ; missions limitées à celles que le serveur accepte | File de plusieurs sessions terminées (une seule session locale à la fois) ; aucun essai sur téléphone en roulant | Livré en simulation |
| 2 Assistant de terrain | Préparation (intitulé, profil de précision, contrôles) ; pack de mission hors ligne dit complet ou INCOMPLET ; qualification des segments par les vocabulaires du serveur ; repères ; **observation rapide en deux appuis** avec la position du GPS (file hors ligne existante, validation par un responsable) | Photos dans l'enregistreur (voir ci-dessous) ; checklist adaptative à la mission ; sections « homogènes » au-delà des segments qualifiés | Partiel |
| 3 Capteurs | GPS horodaté ; indice d'irrégularité par accéléromètre (optionnel, expérimental, affiché seulement) ; **rapport des capacités de l'appareil** (GPS, capteurs de mouvement, caméra, stockage, calcul, batterie, réseau), copiable pour la fiche de chaque appareil | Gyroscope non exploité ; indice d'irrégularité jamais étalonné | Partiel |
| 4 IA embarquée | Rien de livré. Aucun jeu d'images guinéen annoté trouvé (`PILOTE-ET-VISION-LOCALE.md`) | Corpus du pilote ; essais de modèles ; décision de licence | **Bloqué par les données** |
| 5 Qualité des relevés | Distance estimée, trace valide, positions fiables (≤ 15 m, provisoire), temps avec signal, interruptions, trous, qualité indicative avec ses raisons ; jamais « inspecté parce que le GPS est passé » | Images exploitables et observations validées ne sont pas encore comptées dans le profil ; portions non couvertes non cartographiées | Partiel |
| 6 Historique et décision | Existe déjà ailleurs : fiche 360 par tronçon, moteur de programmation explicable, rapports bailleur, validation humaine | Historique des inspections par section issu de ces relevés ; rapports automatiques de campagne | Non commencé pour les relevés |
| 7 Pilote | Protocole ci-dessous ; corridor retenu : « RN1 ou Boké » ; outil de route entre deux villes | Le pilote lui-même | **Non fait** |
| 8 Livraison | Tests, build, lint, balayage de secrets verts sur le HEAD | **Aucun déploiement des derniers changements** (accès root, attestation de la DSI) | Non déployé |

**Photos.** Le serveur n'accepte les photos que sur les **défauts** (`/v2/defauts`), pas sur les observations ni sur une
session de roulage. Les joindre à l'enregistreur exige soit de saisir un défaut complet (catalogue, mesures : impossible en
roulant), soit de changer le contrat serveur. Je ne l'ai pas fait. Recommandation : garder les photos dans la page « Défauts
terrain » existante, utilisée à l'arrêt, et décider avec la DSI si une photo rapide rattachée à une observation vaut un
changement de contrat.

## 2. Protocole du pilote

### 2.1 Routes (une section d'environ 20 à 30 km par type, sur le corridor retenu)

| Type | À repérer | Pourquoi |
|---|---|---|
| Bitumée en bon état | Peu d'anomalies : mesure des **fausses alertes** | Témoin |
| Fortement dégradée | Nids-de-poule, faïençage : mesure de la **détection** | Cas favorable à la vision |
| Latérite | Ornières, tôle ondulée, poussière | Aucun jeu d'images connu : c'est le corpus à constituer |
| Problème de drainage | Fossés bouchés, eau stagnante, ouvrages | Observations de type « Assainissement » |

Avant de partir : demander la route entre les deux villes du corridor dans **Tronçons > Route entre deux villes** et noter si le
serveur répond « aucune route continue » (référentiel interrompu : à saisir avant le pilote).

### 2.2 Appareils

Au moins un téléphone d'entrée de gamme, un téléphone récent et une tablette. Pour chacun : ouvrir **Préparer la mission >
Voir les capacités de cet appareil**, copier le rapport JSON dans la fiche. Noter le navigateur et sa version.

### 2.3 Conditions à faire varier

Coupure du réseau pendant la mission (mode avion 10 minutes) ; plein soleil et fin de journée ; température (téléphone dans un
véhicule fermé) ; mission longue (au moins 2 h) ; fermeture de la page puis réouverture ; écran verrouillé 1 minute pendant
l'enregistrement (le trou doit apparaître dans la trace, sans être comblé).

### 2.4 Mesures, et comment les prendre

| Mesure | Comment | À renseigner par mission |
|---|---|---|
| Précision GPS observée | Médiane et 90e percentile de `precisionM` des positions retenues (export GPX ou charge envoyée) | vide |
| Part de positions écartées | « positions écartées » / (retenues + écartées), affichée à l'arrêt | vide |
| Temps avec signal | « Temps avec signal » du profil de complétude | vide |
| Interruptions et trous | Nombre et durée, affichés à l'arrêt | vide |
| Autonomie | Niveau de batterie au départ et à l'arrivée (rapport des capacités), durée, écran allumé | vide |
| Temps par kilomètre | Durée effective / distance estimée | vide |
| Récupération | La session est-elle retrouvée après fermeture, sans doublon à l'envoi ? | oui / non |
| Observations rapides | Nombre posé, nombre reçu par le serveur | vide |
| Détection (si un modèle est essayé) | Sur images annotées par un agent, jamais vues par le modèle : précision, rappel, fausses alertes par km | vide |

**Rien n'est annoncé tant que la case est vide.** Une mesure faite sur un seul appareil ou une seule route est dite « un
essai », pas une performance.

## 3. Évaluation d'un modèle de vision : critères à fixer AVANT l'essai

Ces critères relèvent de l'AGEROUTE ; je ne fixe aucun seuil d'acceptation. À décider : précision et rappel minimaux par type de
défaut, fausses alertes maximales par kilomètre, latence maximale par image sur l'appareil le plus modeste, mémoire, consommation
par heure, licence acceptable (voir `PILOTE-ET-VISION-LOCALE.md`). Un modèle qui n'apporte pas de bénéfice démontré sur le
corpus guinéen n'est pas conservé ; la collecte manuelle reste complète sans lui, et le traitement différé après synchronisation
reste l'option pour les appareils trop modestes.
