import L from "leaflet";
import { ETAT_COLORS } from "./types";

/**
 * Représentations cartographiques PAR NATURE (fin des points génériques).
 *
 * Ouvrages d'art : un symbole par type (pont, dalot, buse…), la COULEUR
 *   conservant l'état patrimonial (bon → critique) — les deux informations
 *   se lisent ensemble : la forme dit ce que c'est, la couleur comment ça va.
 * Points noirs : la forme porte la gravité (triangle = forte, losange =
 *   moyenne, point = faible).
 * Chantiers approximatifs : badge carré ≈ — distinct des points mesurés.
 * Postes : péage (barrière) vs pesage (balance).
 *
 * divIcon (DOM) : ces couches comptent quelques centaines d'objets au plus,
 * le rendu vectoriel massif reste réservé aux tronçons (GeoJSON).
 */

export const TYPE_OUVRAGE_GLYPH: Record<string, string> = {
  PONT: "⌒",            // arc unique
  VIADUC: "⌒⌒",         // arcs multiples
  PASSERELLE: "≍",      // passerelle piétonne
  DALOT: "▤",           // dalot (dalle)
  BUSE: "◉",            // buse (tuyau)
  PONCEAU: "◡",         // petit arc
  RADIER: "≈",          // radier (gué aménagé)
  TUNNEL: "∩",          // portique
  MUR_SOUTENEMENT: "▦", // mur (damier)
};

export const TYPE_OUVRAGE_LABEL: Record<string, string> = {
  PONT: "Pont",
  VIADUC: "Viaduc",
  PASSERELLE: "Passerelle",
  DALOT: "Dalot",
  BUSE: "Buse",
  PONCEAU: "Ponceau",
  RADIER: "Radier",
  TUNNEL: "Tunnel",
  MUR_SOUTENEMENT: "Mur de soutènement",
};

function badge(glyph: string, couleur: string, taille = 26, forme: "rond" | "carre" | "triangle" | "losange" = "rond"): L.DivIcon {
  const radius = forme === "rond" ? "50%" : forme === "carre" ? "4px" : forme === "triangle" ? "3px" : "4px";
  const transform =
    forme === "triangle" ? "transform: rotate(45deg);" : forme === "losange" ? "transform: rotate(45deg);" : "";
  const inner = forme === "triangle" || forme === "losange" ? `transform: rotate(-45deg);` : "";
  return L.divIcon({
    className: "bdri-nature-marker",
    iconSize: [taille, taille],
    iconAnchor: [taille / 2, taille / 2],
    html: `<div style="width:${taille}px;height:${taille}px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;
      background:#ffffff;border:2px solid ${couleur};border-radius:${radius};${transform}
      font-size:${taille <= 20 ? 10 : 12}px;line-height:1;color:${couleur};font-weight:700;
      box-shadow:0 1px 3px rgba(0,0,0,.35);">${glyph ? `<span style="${inner}">${glyph}</span>` : ""}</div>`,
  });
}

/** Ouvrage : forme = type, couleur = état patrimonial. */
export function ouvrageIcon(type: string, etat: string): L.DivIcon {
  const couleur = ETAT_COLORS[etat as keyof typeof ETAT_COLORS] ?? "#1a2942";
  return badge(TYPE_OUVRAGE_GLYPH[type] ?? "◆", couleur, 26);
}

/** Point noir : forme = gravité (triangle forte, losange moyenne, point faible). */
export function pointNoirIcon(gravite: string): L.DivIcon {
  if (gravite === "FORTE") return badge("!", "#dc2626", 26, "triangle");
  if (gravite === "MOYENNE") return badge("", "#ea580c", 22, "losange");
  return badge("", "#f59e0b", 14);
}

/** Poste : péage (barrière) ou pesage (balance). */
export function posteIcon(type: string): L.DivIcon {
  const pesage = type === "PESAGE";
  return badge(pesage ? "⚖" : "▮▮", "#7c3aed", 22, "carre");
}

/** Chantier sans géométrie précise : carré ≈ à la couleur du statut. */
export function chantierApproxIcon(couleurStatut: string): L.DivIcon {
  return badge("≈", couleurStatut, 22, "carre");
}
