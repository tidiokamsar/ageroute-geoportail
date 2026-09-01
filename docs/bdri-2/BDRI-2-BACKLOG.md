# BDRI 2.0 — Backlog

Les dix premiers tickets à forte valeur. Chacun est **fondé sur une mesure**, pas sur
une intention. Estimations en journées-homme pour quelqu'un connaissant le dépôt.

Trois d'entre eux (T1, T2, T3) sont de la dette de Phase 3 : courts, sans dépendance,
et deux protègent des données. Ils passent devant.

---

## T1 · Planifier les sauvegardes

**Problème.** Le script de sauvegarde et sa vérification de restauration sont
installés sur le serveur et **ont été exécutés avec succès** — restauration vérifiée :
28 tables, 1 690 géométries valides, 35 clés étrangères. **Mais rien ne les
déclenche.** Une sauvegarde qui dépend d'un lancement manuel n'existe pas.

**Solution.** Deux lignes de crontab : sauvegarde quotidienne à 3 h, vérification de
restauration le dimanche à 4 h. Les autres sauvegardes du serveur tournent à 2 h et
2 h 30.

**Valeur.** Le risque n°1 du dossier. Aujourd'hui, une panne disque perd tout ce qui
n'a pas été sauvegardé à la main.
**Dépendances.** Aucune. **Risque.** Très faible — les scripts ne modifient jamais la
production.
**Estimation.** 0,5 j.
**Acceptation.** Une sauvegarde apparaît le lendemain matin sans intervention ; le
journal de vérification du dimanche indique « Restauration VERIFIEE ».

---

## T2 · Mettre la clé de chiffrement à l'abri

**Problème.** La clé vit dans `~/.bdri/cle-sauvegarde` sur le serveur source. Si ce
serveur est détruit **et** que la clé n'existe nulle part ailleurs, les archives
chiffrées déposées sur le second serveur sont **irrécupérables**. La sauvegarde ne
protégerait alors pas du scénario qu'elle est censée couvrir.

**Solution.** Décision d'organisation : qui détient une copie, sous quelle forme, avec
quelle procédure de récupération. Ce n'est pas un développement.

**Valeur.** Sans elle, T1 offre une fausse assurance.
**Dépendances.** T1. **Risque.** Aucun techniquement ; le risque est de ne pas le
faire.
**Estimation.** 0,5 j de coordination.
**Acceptation.** Une personne désignée peut produire la clé sans accéder au serveur
source, et une restauration complète a été rejouée depuis la copie distante.

---

## T3 · Renommer la fonction « itinéraire »

**Problème.** `troncons.service.ts` trace une droite entre deux centroïdes et renvoie
la distance à vol d'oiseau. **L'interface l'appelle « itinéraire ».** La distance
affichée n'est pas une distance routière : l'utilisateur est trompé.

**Solution.** Renommer en « distance à vol d'oiseau » dans l'interface et l'infobulle.
Aucun changement de logique.

**Valeur.** Élimine une information fausse dans un référentiel national. Le §16 de la
mission l'interdit explicitement.
**Dépendances.** Aucune. **Risque.** Nul.
**Estimation.** 1 h.
**Acceptation.** Le mot « itinéraire » n'apparaît plus pour désigner ce calcul ; un
test le vérifie.

---

## T4 · Vérification avant livraison

**Problème.** Un déploiement du 1<sup>er</sup> septembre a échoué sur `npm ci` :
`supertest` figurait dans `package.json` sans être dans `package-lock.json`. Sans
conséquence — l'échec précédait la bascule — mais découvert **au déploiement**. Le
même défaut existait sur le lot suivant.

**Solution.** Un script exécuté avant tout transfert : `tsc` backend et frontend,
tests des deux côtés, cohérence `package.json` / `package-lock.json`, `prisma migrate
status`, validation de `nginx.conf` dans un conteneur jetable. Un échec interrompt.

**Valeur.** Trois défauts de cette phase auraient été attrapés : le verrou npm, la
syntaxe Nginx, le `await` racine que `tsc` refuse et que Vitest accepte.
**Dépendances.** Aucune. **Risque.** Faible.
**Estimation.** 2 j.
**Acceptation.** Le script refuse un dépôt dont le verrou est désynchronisé, et le
prouve par un test.

---

## T5 · Contrôle automatique base ↔ fichiers

**Problème.** Deux fichiers sont restés inaccessibles du 29 juin au 1<sup>er</sup>
septembre — un document et une photo d'ouvrage — parce que le volume de stockage avait
été détaché. **Personne ne s'en est aperçu.** L'état actuel : 3 fichiers, 2 référencés,
1 orphelin, 0 référence cassée.

**Solution.** Contrôle bidirectionnel — toute référence en base pointe vers un fichier
présent, tout fichier présent est référencé — exécuté quotidiennement, résultat
consigné.

**Valeur.** Les modules qui téléversent viennent d'être mis en ligne. Trois fichiers
aujourd'hui ; la vérification manuelle deviendra impossible.
**Dépendances.** Aucune. **Risque.** Faible — lecture seule.
**Estimation.** 2 j.
**Acceptation.** Le contrôle détecte une référence cassée introduite volontairement en
recette, et le signale.

---

## T6 · Terrain — hors-ligne éprouvé

**Problème.** `InspectionTerrainPage`, `offlineSync.ts`, `useOfflineSync.ts` et un
service worker existent. **La table `inspections` compte 0 enregistrement : rien n'a
jamais été exercé.** Le §15 interdit de considérer que l'application fonctionne sans
réseau sans test réel.

**Solution.** Éprouver sur un téléphone réel : saisie hors connexion, fermeture de
l'application en cours de saisie, reprise, synchronisation, coupure pendant la
synchronisation, doublons, conflits. Corriger ce que ces essais révéleront.

**Valeur.** **C'est le seul lot qui produit de la donnée.** Sans inspections, les
fiches objets, l'historique et l'aide à la décision n'ont rien à afficher.
**Dépendances.** T1 — le terrain va produire des données qu'il serait impardonnable
de perdre.
**Risque.** **Élevé.** Le hors-ligne est là où les applications terrain échouent, et
les défauts ne se voient qu'en conditions réelles.
**Estimation.** 8 j, dont 2 d'essais sur le terrain.
**Acceptation.** Une inspection saisie en mode avion, l'application fermée puis
rouverte, se retrouve en base après retour du réseau — sans doublon, avec ses photos
et ses coordonnées.

---

## T7 · Précision de localisation des chantiers

**Problème.** 6 chantiers sur 488 ont une géométrie, 4 sont rattachés à un tronçon.
482 s'affichent au centre de leur région **dessinés comme s'ils y étaient**. La carte
montre des chantiers là où il n'y en a pas.

**Solution.** Un champ `precisionLocalisation` à quatre valeurs — précise, linéaire,
approximative, inconnue — et **un rendu qui trahit l'imprécision** : cercle diffus
contre tracé plein, et rien du tout pour « inconnue ».

**Ne déplacer aucun chantier.** Le §21 l'interdit et il a raison : une précision fausse
est plus dangereuse qu'une imprécision affichée.

**Valeur.** Corrige le défaut le plus visible du géoportail, sans inventer une seule
coordonnée.
**Dépendances.** Aucune pour l'affichage. L'alimentation en localisations réelles
relève de l'interconnexion avec l'application de gestion de projets.
**Risque.** Faible.
**Estimation.** 4 j.
**Acceptation.** Un chantier approximatif est visuellement distinguable d'un chantier
précis sans lire l'infobulle.

---

## T8 · Identifiant stable du patrimoine

**Problème.** Les objets portent un UUID technique et, pour les tronçons, un `code`
**déjà instable** : sur `RES-782`, `code` et `nom` sont identiques ; ailleurs ils
suivent des conventions différentes. Aucun des deux ne peut servir de référence
durable, ce qui rend impossible le lien vers les applications métiers (§31).

**Solution.** Un `identifiantPatrimoine` métier, lisible, unique, attribué à la
création et jamais réattribué — `RN3-TR-001245`. Règles de gestion à arbitrer par
AGEROUTE, notamment le cas d'un tronçon scindé.

**Valeur.** Prérequis de l'interopérabilité et de tout historique durable.
**Dépendances.** Arbitrage métier sur les règles.
**Risque.** Moyen — une règle mal choisie se paie longtemps.
**Estimation.** 5 j après arbitrage.
**Acceptation.** Un objet renommé, déplacé et supprimé logiquement conserve son
identifiant ; un test le vérifie.

---

## T9 · Historique de l'état par objet

**Problème.** `Troncon.etat` ne porte que la valeur actuelle. Le §12 veut
« 2024 bon, 2025 moyen, 2026 mauvais ». `AuditLog` conserve les modifications mais
c'est un journal technique, pénible et fragile à rejouer.
`IndicateurReseauHistorique` agrège à l'échelle du réseau, pas par objet.

**Solution.** Un modèle `EtatPatrimoineHistorique` en écriture seule, alimenté à
chaque changement d'état, portant la source du constat.

**Valeur.** Donne à la BDRI sa dimension patrimoniale — l'évolution, pas seulement
l'instantané. C'est ce qui distingue un référentiel d'un catalogue.
**Dépendances.** **T6.** Sans inspections, il n'y aura rien à historiser.
**Risque.** Faible.
**Estimation.** 5 j.
**Acceptation.** La fiche d'un tronçon inspecté deux fois montre deux états datés.

---

## T10 · Engager la demande du référentiel administratif

**Problème.** `prefecture` et `commune` existent au schéma depuis juillet ; **rien ne
les écrit — 0 sur 1 690.** Seules les 8 régions sont modélisées, sans géométrie. La
recherche « Kankan → Kissidougou » est donc impossible, Kissidougou étant une
préfecture.

**Solution.** Ce ticket **n'est pas un développement**. C'est l'engagement d'une
démarche auprès de l'Institut National de la Statistique et de la Direction Nationale
de la Cartographie pour obtenir le découpage officiel **avec ses géométries** —
préfectures, sous-préfectures, communes, localités.

**Valeur.** Débloque la recherche par lieu, l'analyse territoriale et le rattachement
administratif — soit trois chapitres entiers de la vision.
**Dépendances.** Aucune technique. **Tout dépend d'un tiers.**
**Risque.** **Le délai.** C'est le plus long du programme, et il ne coûte rien de le
lancer maintenant.
**Estimation.** 1 j de préparation ; délai d'obtention inconnu.
**Acceptation.** Une demande formelle est partie, avec les exigences écrites : les
quatre niveaux, les polygones, une date de validité, un caractère officiel.

---

## Ordre et raisonnement

```
T1 ─► T2          protéger les données avant d'en produire
T3, T4, T5        dette courte, sans dépendance
T10               démarche externe : à lancer tôt, elle est longue
   │
T6 ─┬─► T9        le terrain produit ; l'historique enregistre
    └─► T7, T8    affichage honnête et identité durable
```

**T1 à T5 : 5 jours** pour solder la dette et protéger l'existant.
**T6 : 8 jours** pour ouvrir le robinet de données.
**T7 à T9 : 14 jours** pour ce qui s'appuie dessus.
**T10 : 1 jour**, à lancer immédiatement — le reste est du délai administratif.

---

## Ce qui n'est délibérément pas dans ces dix tickets

| Sujet | Pourquoi pas maintenant |
|---|---|
| Aide à la décision (§26) | Trafic, criticité et coût sont vides sur 1 690 tronçons. Le score classerait l'ignorance |
| Référentiel administratif — l'import | Bloqué par T10. Écrire l'import avant d'avoir la source, c'est coder contre un format inconnu |
| pgRouting | La connexité du réseau n'est pas mesurée. Voir `BDRI-2-ARCHITECTURE.md` §3 |
| GeoServer, services OGC | Aucun consommateur externe identifié. 2 306 objets ne le justifient pas |
| Refonte du design system | Utile, mais aucun utilisateur n'attend cela avant des données |
| Modules signalisation, équipements | Cinq modules sont déjà vides |
