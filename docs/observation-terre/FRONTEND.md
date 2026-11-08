# Observation de la Terre : notes du frontend

Ce document consigne ce que l'ecran fait volontairement autrement qu'attendu, et ce qui reste a verifier au merge ou au deploiement.
Il decrit l'etat du code a la date de la correction des constats de la relecture independante (EO-FIX-FRONT) ; il ne remplace pas
`CONTRAT-API-UI.md`.

## Limites connues (comportement inchange)

### Pas de regroupement de marqueurs (clustering)

La carte des propositions (`components/observation-terre/CarteObservationTerre.tsx`) ne regroupe pas les marqueurs. Le Geoportail utilise
`react-leaflet-cluster` (`GeoportailPage.tsx`, `FranchissementsLayer.tsx`) ; ce module ne l'utilise pas. La seule parade a l'encombrement est le
plafond `PLAFOND_MARQUEURS = 300` (`lib/teledetectionCarte.ts`) : au-dela, les propositions les moins prioritaires ne sont pas dessinees, et la
carte le dit (« N propositions non affichees, zoomez »). Un clustering supposerait de decider ce que « regrouper » veut dire pour des statuts et
des priorites differents : choix de produit non pris.

### Feuille de style de Leaflet

Dans CE worktree, `frontend/index.html` charge `leaflet.css` depuis `https://unpkg.com/leaflet@1.9.4/dist/leaflet.css`. Le depot principal l'a deja
remplace par un import local dans les composants de carte. Au merge, verifier que `CarteObservationTerre` importe bien `leaflet/dist/leaflet.css`,
ou que l'import des autres cartes du depot principal suffit a la charger sur la page `/teledetection`. Sans l'un ou l'autre, la carte
s'affiche sans style (tuiles eclatees, controles non positionnes).

### Politique de securite du contenu (CSP) de `nginx.conf`

Le `Content-Security-Policy` du serveur par defaut de `frontend/nginx.conf` n'autorise :

- ni `https://server.arcgisonline.com` en `img-src` : le fond **satellite**, fond par defaut de la carte (et le fond « plan clair »), vient de ce domaine.
  Seul le bloc `/embed/` l'autorise, et il ne concerne pas la page `/teledetection` ;
- ni `unpkg.com` (`style-src`) : `index.html` y charge `leaflet.css` (voir ci-dessus).

Aujourd'hui cette CSP n'atteint pas le navigateur pour les pages HTML (constat du 06/10/2026 consigne dans `nginx.conf` : `try_files` bascule dans
`location = /index.html`, dont l'`add_header` remplace les en-tetes herites). **Si elle devient effective, le fond satellite casse** (tuiles bloquees)
et, tant que la feuille de style vient d'unpkg, la carte perd son style. Avant de rendre la CSP effective : ajouter `https://server.arcgisonline.com`
a `img-src`, et servir `leaflet.css` localement. Ce fichier n'est pas modifie par ce chantier (hors perimetre).

### Ecarts avec la capture de reference

Choix assumes, pour l'exactitude des informations montrees :

- la carte est plus etroite que sur la capture (colonne de gauche d'une grille a trois colonnes) ;
- le tableau des sources occupe toute la largeur sous les trois colonnes ;
- l'apercu de la proposition est l'image « apres » seule ; la comparaison avant/apres est un onglet distinct ;
- la liste des propositions n'affiche pas de vignette image (une icone indique seulement si un apercu existe) ;
- la decision passe par un formulaire a **motif obligatoire**, pas par des boutons directs (le serveur exige le motif ; un verdict cite aussi un constat) ;
- le libelle est « Taux de confirmation terrain », pas « Precision vs terrain » : le taux est calcule depuis les effectifs (confirmees / (confirmees + infirmees)),
  il n'est pas une precision statistique et l'ecran le dit.

## Apercus d'image : etats

`useApercu` (`lib/teledetectionHooks.ts`) distingue : `aucun` (pas d'URL), `chargement`, `pret`, `indisponible` (404 `APERCU_INDISPONIBLE` : le fournisseur
n'a rien rendu), `illisible` (reponse 200 dont le contenu n'est pas une image, par exemple la page HTML de repli de l'application) et `erreur` (tout le reste).

Les apercus sont demandes en `responseType: "blob"` : axios fournit alors AUSSI le corps des erreurs sous forme de `Blob`. `lireApercu`
(`lib/teledetectionApi.ts`) relit ce Blob en JSON avant de classer l'erreur ; sans cela, le code stable du serveur est perdu et l'etat « indisponible »
n'est jamais atteint. Les tests de ce point utilisent un vrai `Blob` (`teledetectionApi.apercu.test.ts`, environnement node) : jsdom ne le rend pas fidelement.

## Session expiree (401)

Le client `lib/api.ts` tente un rafraichissement du jeton sur 401 ; si le rafraichissement echoue, il redirige vers `/login`. L'ecran n'ajoute rien : il affiche
« Votre session a expire » seulement si l'erreur lui parvient (cas d'un 401 repete apres un rafraichissement reussi, sans redirection). C'est le comportement de
toutes les pages du depot ; il n'y a pas de redirection propre a ce module.
