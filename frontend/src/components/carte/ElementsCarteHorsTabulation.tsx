import { useEffect } from "react";
import { useMap } from "react-leaflet";

/**
 * Selecteur des elements de carte que Leaflet rend tabulables : les icones de marqueur (dont celles des groupes de `react-leaflet-cluster`) et les
 * traces SVG interactifs. Ceux qui portent deja `tabindex="-1"` sont exclus : le correctif ne reecrit pas deux fois le meme attribut.
 */
export const SELECTEUR_ELEMENTS_TABULABLES = ".leaflet-marker-icon:not([tabindex='-1']), path.leaflet-interactive:not([tabindex='-1'])";

/**
 * RETIRE DE LA TABULATION les marqueurs et les traces de la carte Leaflet qui la contient (a placer comme enfant de `<MapContainer>`), y compris
 * ceux ajoutes apres coup (un `MutationObserver` rejoue le correctif a chaque ajout de calque). Le conteneur de la carte (fleches, + et -), les
 * boutons de zoom et la liste ou la recherche de la page restent des arrets de Tab.
 *
 * POURQUOI C'EST NECESSAIRE (mesure dans Chromium, cartes d'Aide a la decision et du Geoportail, donnees synthetiques) :
 *  - une icone de marqueur Leaflet est un `div tabindex="0"` des que `keyboard` vaut `true` (valeur par defaut de `L.Marker`, y compris pour les
 *    icones de groupe de `react-leaflet-cluster`) ;
 *  - un trace SVG (`path.leaflet-interactive`) n'a AUCUN attribut `tabindex`, mais devient un arret de Tab quand un tooltip lui est lie : depuis
 *    Leaflet 1.9, `bindTooltip` pose des ecouteurs `focus` et `blur` sur l'element (le tooltip s'ouvre au focus), et Chromium rend focalisable un
 *    element SVG qui porte un ecouteur `focus`. Un trace SANS tooltip n'est pas un arret de Tab (verifie : les propositions d'Observation de la
 *    Terre ne le sont pas, ses polylignes de chantier le sont des que la couche est affichee).
 *  Avec le reseau classe (environ 1 700 troncons), la page devient inutilisable au clavier : tout ce qui suit la carte dans le DOM est a des
 *  centaines d'appuis sur Tab.
 *
 * QUAND L'UTILISER, ET QUAND NE PAS L'UTILISER. Retirer un arret de Tab est une perte si cet arret est la SEULE voie clavier vers une fonction. Ne
 * l'utiliser que si, pour chaque element retire, soit il n'a aucune action ni information au clavier, soit la fonction est offerte autrement :
 *  - l'Entree sur un marqueur ou un trace Leaflet n'ouvre rien tant que l'application n'ecoute que `click` (Leaflet ne convertit pas l'Entree en
 *    clic : il emet `keypress`, que seules les popups ecoutent) ; l'action est donc a offrir ailleurs. La carte d'Aide a la decision le fait avec
 *    une liste alternative (un bouton par intervention affichee) et la recherche ;
 *  - le tooltip qui s'ouvre au focus est une INFORMATION (nom, etat) que ce correctif supprime pour le clavier : elle doit exister autrement
 *    (liste, recherche, fiche). Les groupes de marqueurs ont une action (Entree zoome ou deploie le groupe, `clusterkeypress`) : a conserver s'il
 *    n'y a pas d'autre voie vers elle.
 * Le Geoportail (`pages/GeoportailPage.tsx`) n'offrait ni liste ni action sur Entree pour ses marqueurs et ses traces (la fiche s'ouvre au clic ou
 * par la recherche d'un nom) : il n'utilise donc PAS ce composant, mais `NavigationClavierCarte` (un seul arret de Tab, fleches entre les
 * elements, Entree pour ouvrir la fiche), qui retire les arrets en offrant a la place la voie clavier qu'ils portaient.
 *
 * Sans effet hors navigateur (pas de `MutationObserver`) et sans conteneur lisible : rien n'est touche.
 */
export function ElementsCarteHorsTabulation() {
  const map = useMap();
  useEffect(() => {
    const c = map.getContainer?.();
    if (!c || typeof MutationObserver === "undefined") return;
    const corriger = () => c.querySelectorAll<Element>(SELECTEUR_ELEMENTS_TABULABLES).forEach((e) => e.setAttribute("tabindex", "-1"));
    corriger();
    const o = new MutationObserver(corriger);
    o.observe(c, { childList: true, subtree: true });
    return () => o.disconnect();
  }, [map]);
  return null;
}
