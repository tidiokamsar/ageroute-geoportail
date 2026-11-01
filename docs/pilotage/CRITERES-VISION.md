# Critères d'acceptation d'un modèle de vision, ordre du pilote, photo des observations

Établi le 25/10/2026 **sur délégation du DSI** (« n'en fixe aucun » devient « fais-le », message du 25/10/2026). Ce sont des
décisions de conduite : réversibles, datées, **provisoires**. Elles ne valent pas norme de l'AGEROUTE ni de l'ONR.

## 1. Critères d'acceptation (provisoires, non calibrés)

Aucune mesure guinéenne ne les fonde : ce sont des points de départ choisis pour qu'un modèle soit **utile à un agent** sans le
gêner. Ils sont codés dans `frontend/src/lib/evaluationVision.ts` (`CRITERES_PROVISOIRES`, provenance `PROVISOIRE_NON_CALIBRE`) et
éprouvés par `evaluationVision.test.ts` (16 tests sur des cas calculables à la main).

| Critère | Seuil de départ | Pourquoi ce seuil de départ |
|---|---|---|
| Précision (vrais positifs / détections) | au moins 0,70 | Trois alertes sur dix fausses font déjà perdre confiance à l'agent qui doit les écarter |
| Rappel (vrais positifs / défauts annotés) | au moins 0,60 | Un modèle qui manque quatre défauts sur dix reste utile comme aide, jamais comme preuve d'absence |
| Fausses alertes par kilomètre parcouru | au plus 2 | Une alerte à écarter toutes les 500 m reste supportable en roulant |
| Latence, 95e centile, sur l'appareil le plus modeste | au plus 1 500 ms par image | Permet une image toutes les 2 s sans file d'attente |
| Mémoire de pointe | au plus 300 Mo | Doit cohabiter avec la carte et la collecte sur un téléphone d'entrée de gamme |
| Surconsommation de batterie | au plus 10 points de pourcentage par heure | Une mission de 2 h ne doit pas vider le téléphone à cause du modèle |
| Poids du modèle à télécharger | au plus 30 Mo | Téléchargement possible avec une connexion faible, avant le départ |
| Effectif de l'essai | au moins 300 images inédites, au moins 100 annotations par classe | En dessous, précision et rappel ne signifient rien |

**Règles qui ne se négocient pas** (elles sont dans le code) :

- Les images d'essai sont **annotées par un agent** et **jamais vues** par le modèle à l'entraînement : l'appelant l'atteste, sinon
  précision, rappel, fausses alertes et effectif sont « non mesuré ».
- Une case **non mesurée n'est jamais conforme** : un modèle n'est « acceptable » que si TOUT est mesuré ET atteint.
- Un modèle qui ne détecte rien a un rappel nul et une précision **non définie**, pas 100 %.
- « Acceptable » veut dire : **autorisé à suggérer**. Un agent confirme toujours ; une détection n'est jamais un défaut confirmé.
- Le modèle est conservé seulement s'il apporte un bénéfice **démontré** par rapport à la collecte manuelle seule (temps par
  kilomètre, sans baisse du rappel des défauts validés par un humain). Sinon la collecte manuelle reste complète, et le traitement
  différé après synchronisation reste l'option pour les appareils trop modestes.

**Révision** : après la première mesure du pilote, par une décision datée qui dit quel seuil change et pourquoi.

## 2. Ordre du pilote : RN1 d'abord, Boké ensuite

Choix de conduite : **RN1 (Conakry – Coyah – Kindia – Mamou) en premier, puis le corridor de Boké** (Boké – Sangarédi –
Télimélé).

- RN1 : la plus proche de la DSI (logistique, essais répétés à la journée), la plus fréquentée, elle réunit au moins une section
  bitumée en bon état et des sections dégradées ; c'est le meilleur terrain pour régler la collecte, les appareils et la mesure du
  temps par kilomètre.
- Boké : la latérite et les problèmes de drainage y sont attendus (non vérifié) ; il vient une fois la méthode rodée sur RN1.
- À vérifier avant de partir, pour chaque corridor : la route entre les deux villes dans **Tronçons > Route entre deux villes**
  (le référentiel doit être continu ; sinon, saisir les tronçons manquants d'abord).

Réversible : si la DSI préfère l'inverse, il suffit de l'écrire ici avec la date.

## 3. Photo rapide rattachée à une observation : contrat serveur changé

Décision exécutée : le contrat est **étendu**, pas modifié.

- **Nouveau** : `POST /api/v2/observations/:id/photos` (multipart : `photo`, et facultativement `lat`+`lon` par paire, `precisionM`,
  `cap`, `capturedA`). La table `medias_observation` existait déjà : **aucune migration**.
- **Inchangé** : le lot de synchronisation `POST /v2/sync/push` et son schéma strict. La création de l'observation part d'abord ;
  les photos partent après, une par une, retirées de la file locale à chaque confirmation du serveur.
- Mêmes règles que les photos de défaut : plafond par objet (30) et de disque, SHA-256 unique (renvoi après réponse perdue : 200, rien
  de créé), 404 identique pour « inexistante » et « pas à vous », contrôle territorial, écriture auditée.
- **Corrigé en route** : le service de fichiers `GET /photos/:nom` ne résolvait pas les photos d'observation (le fichier aurait été
  téléversé puis servi en 404). Il les sert maintenant à l'auteur, aux missions de l'agent et aux responsables.
- Le responsable voit les photos dans **Validation des relevés > Observations**, avec date, position, précision et empreinte.
- Limites : JPG, PNG, WebP, 8 Mo, cinq photos par observation côté téléphone ; aucune compression ; une photo prise sans position
  valide est jointe sans position, jamais avec une position inventée.
- **Déploiement** : route et service de fichiers sont du code serveur, à déployer ; sans migration.
