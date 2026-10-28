import L from "leaflet";
import type { Layer, Map as CarteLeaflet, Tooltip } from "leaflet";
import type { Coord, ElementNavigable, VueCarte } from "./ordreClavierCarte";

/**
 * Adaptateur Leaflet de la navigation au clavier : repere, parmi les couches posees sur la carte, celles que le controleur parcourt, et en
 * extrait de quoi les ordonner (`ordreClavierCarte.ts`). Tout passe par l'API publique de Leaflet (`eachLayer`, `getTooltip`,
 * `getLatLng(s)`, `getElement`, `fire`) : aucune couche de l'application n'est modifiee ni dupliquee, ce que la page sait deja afficher
 * (infobulle) et ouvrir (gestionnaire de `click`, popup liee) est reutilise tel quel.
 *
 * QUELLES COUCHES. Est parcourue toute couche INTERACTIVE qui porte une infobulle non permanente : trace Leaflet (troncons, chantiers,
 * alertes, voirie, portions), marqueur et cercle-marqueur, y compris ceux d'un groupe de marqueurs quand ils sont affiches individuellement ;
 * plus les icones de groupe elles-memes (Entree zoome, comme au clic). Ne sont PAS concernes : les couches sans infobulle (mesure, dessin,
 * contour, fonds), l'infobulle permanente du marqueur de deplacement d'ouvrage, les elements d'un groupe tant que le groupe est replie
 * (ils n'ont pas d'element DOM : on y accede en zoomant sur le groupe).
 */

/** Une couche Leaflet, avec la partie de son API que l'adaptateur appelle (jamais la meme classe : marqueur, trace, groupe). */
export type CoucheCarte = Layer & {
  options: { interactive?: boolean };
  getTooltip?: () => Tooltip | undefined;
  getLatLng?: () => L.LatLng;
  getLatLngs?: () => unknown;
  getChildCount?: () => number;
  getElement?: () => HTMLElement | SVGElement | undefined;
  isPopupOpen?: () => boolean;
  getPopup?: () => L.Popup | undefined;
};

export interface CandidatCarte extends ElementNavigable {
  couche: CoucheCarte;
  /** Nombre d'elements d'un groupe (genre "groupe" seulement). */
  nbEnfants?: number;
}

const estGroupe = (c: CoucheCarte) => typeof c.getChildCount === "function" && typeof c.getLatLng === "function";

/** Vrai si la couche entre dans le parcours clavier. */
export function estCouvrante(c: CoucheCarte): boolean {
  if (c.options?.interactive === false) return false;
  if (estGroupe(c)) return true;
  const tooltip = typeof c.getTooltip === "function" ? c.getTooltip() : undefined;
  if (!tooltip || tooltip.options?.permanent) return false;
  return typeof c.getLatLng === "function" || typeof c.getLatLngs === "function";
}

function parties(latlngs: unknown): Coord[][] {
  if (!Array.isArray(latlngs) || latlngs.length === 0) return [];
  if (!Array.isArray(latlngs[0])) return [(latlngs as L.LatLng[]).map((p): Coord => [p.lat, p.lng])];
  return latlngs.flatMap(parties);
}

/** Les couches couvertes, sans leur geometrie (leger : sert aussi au retrait des arrets de Tab). */
export function couchesCouvertes(carte: CarteLeaflet): CoucheCarte[] {
  const out: CoucheCarte[] = [];
  carte.eachLayer((l) => {
    const c = l as CoucheCarte;
    if (estCouvrante(c)) out.push(c);
  });
  return out;
}

/** Les couches couvertes avec de quoi les ordonner. */
export function collecterCandidats(carte: CarteLeaflet): CandidatCarte[] {
  const out: CandidatCarte[] = [];
  for (const couche of couchesCouvertes(carte)) {
    const cle = String(L.stamp(couche));
    if (estGroupe(couche)) {
      const p = couche.getLatLng!();
      out.push({ cle, genre: "groupe", point: [p.lat, p.lng], couche, nbEnfants: couche.getChildCount!() });
    } else if (typeof couche.getLatLngs === "function") {
      const lignes = parties(couche.getLatLngs());
      if (lignes.length) out.push({ cle, genre: "ligne", parties: lignes, couche });
    } else if (typeof couche.getLatLng === "function") {
      const p = couche.getLatLng();
      out.push({ cle, genre: "point", point: [p.lat, p.lng], couche });
    }
  }
  return out;
}

export function vueDe(carte: CarteLeaflet): VueCarte {
  const b = carte.getBounds();
  const c = carte.getCenter();
  return { centre: [c.lat, c.lng], sud: b.getSouth(), ouest: b.getWest(), nord: b.getNorth(), est: b.getEast() };
}

/**
 * RETIRE DE LA TABULATION les elements DOM des couches couvertes : le parcours aux fleches les remplace. Rien d'autre n'est touche (les
 * sommets du dessin, le marqueur de deplacement d'ouvrage, le conteneur de la carte, les commandes de zoom restent des arrets de Tab).
 * Retourne le nombre d'attributs reecrits.
 */
export function retirerDeLaTabulation(carte: CarteLeaflet): number {
  let n = 0;
  for (const c of couchesCouvertes(carte)) {
    const el = c.getElement?.();
    if (el && el.getAttribute("tabindex") !== "-1") {
      el.setAttribute("tabindex", "-1");
      n++;
    }
  }
  return n;
}

/** Texte lisible d'un noeud : le `<br>` devient une coupure de phrase (sans elle, deux lignes d'infobulle se collent a la lecture). */
function texteDe(n: Node): string {
  if (n.nodeType === Node.TEXT_NODE) return n.nodeValue ?? "";
  if (n.nodeType !== Node.ELEMENT_NODE) return "";
  if ((n as Element).tagName === "BR") return ". ";
  return Array.from(n.childNodes).map(texteDe).join("");
}

export const normaliser = (s: string) => s.replace(/\s+/g, " ").replace(/\s+\./g, ".").trim();

/**
 * Libelle d'une couche = le texte de son infobulle, tel que la voit la souris. Lu dans le DOM de l'infobulle ouverte (le contenu des
 * `<Tooltip>` de react-leaflet n'existe qu'ouvert), sinon dans le contenu brut quand c'est une chaine.
 */
export function lireLibelle(couche: CoucheCarte): string {
  const tooltip = couche.getTooltip?.();
  if (!tooltip) return "";
  const el = tooltip.getElement?.();
  const lu = el ? normaliser(texteDe(el)) : "";
  if (lu) return lu;
  const contenu = tooltip.getContent?.();
  if (typeof contenu === "string") return normaliser(texteDe(new DOMParser().parseFromString(contenu, "text/html").body));
  if (contenu instanceof Node) return normaliser(texteDe(contenu));
  return "";
}
