/**
 * Selection des franchissements promouvables, isolee pour etre testable.
 *
 * Elle vit a part parce qu'elle porte la CLE D'IDENTITE des ouvrages importes, et
 * qu'une cle fausse ne casse rien : elle fait disparaitre des lignes en silence, par
 * ON CONFLICT DO NOTHING. Le 05/09/2026, 349 ponts sur 963 se sont evapores ainsi —
 * la cle retenue etait `numero`, qui porte le numero de la ROUTE et non de l'ouvrage.
 *
 * Le test voisin verifie sur la source reelle que deux ponts ne partagent jamais une
 * cle. C'est la seule garde possible : la base, elle, ne se plaindra jamais.
 */
import fs from "fs";

/** Voies dont un pont porte un enjeu de continuite du reseau structurant. */
export const RESEAU_STRUCTURANT = new Set([
  "Voie rapide", "Bretelle voie rapide", "Route primaire",
  "Route secondaire", "Route tertiaire",
]);

/** Au-dela, ce n'est plus le meme ouvrage. Seuil de la comparaison BDRI/OSM. */
export const SEUIL_DOUBLON_M = 250;

interface Proprietes {
  franchissement?: string;
  nature?: string;
  nom?: string | null;
  numero?: string | null;
  longueurM?: number | null;
  distanceM?: number | null;
}

export interface Retenu {
  cle: string;
  nom: string;
  nomSource: boolean;
  nature: string;
  longueurM: number | null;
  lat: number;
  lon: number;
}

export function lire(fichier: string): { retenus: Retenu[]; exclus: Record<string, number> } {
  const brut = JSON.parse(fs.readFileSync(fichier, "utf8")) as {
    features: { properties: Proprietes; geometry: { type: string; coordinates: number[][] } }[];
  };

  const exclus: Record<string, number> = {
    "gué — absence d'ouvrage": 0,
    "tunnel — buse ou passage couvert": 0,
    "pont hors réseau structurant": 0,
    "doublon d'un ouvrage inventorié": 0,
    "géométrie inutilisable": 0,
  };
  const retenus: Retenu[] = [];

  for (const f of brut.features) {
    const p = f.properties;
    if (p.franchissement === "Gué") { exclus["gué — absence d'ouvrage"]++; continue; }
    if (p.franchissement === "Tunnel") { exclus["tunnel — buse ou passage couvert"]++; continue; }
    if (!RESEAU_STRUCTURANT.has(String(p.nature))) { exclus["pont hors réseau structurant"]++; continue; }
    if ((p.distanceM ?? Infinity) <= SEUIL_DOUBLON_M) { exclus["doublon d'un ouvrage inventorié"]++; continue; }

    /**
     * La source rend une LIGNE, pas un point : le franchissement est le segment de
     * voie qui traverse. C'est plus riche que prevu — la longueur portee par la
     * source est donc mesuree sur ce segment, pas declaree.
     *
     * `Ouvrage.geom` etant un point, on prend le MILIEU DE LA LIGNE et non le
     * centroide : sur un pont courbe, le centroide tombe a cote de l'ouvrage.
     */
    const ligne = f.geometry?.coordinates;
    if (f.geometry?.type !== "LineString" || !Array.isArray(ligne) || ligne.length < 2) {
      exclus["géométrie inutilisable"]++; continue;
    }
    const c = ligne[Math.floor(ligne.length / 2)];
    if (!Array.isArray(c) || c.length < 2) { exclus["géométrie inutilisable"]++; continue; }

    /**
     * La cle est la POSITION, et rien d'autre.
     *
     * Premier jet : le champ `numero` quand il existe, la position sinon. C'etait
     * faux — `numero` porte le numero de la ROUTE, pas de l'ouvrage. 376 ponts
     * retenus n'ont que 27 valeurs distinctes, dont 110 sur « N1 ».
     *
     * Le premier import l'a paye : 963 ponts presentes, 614 ecrits, 349 avales
     * SILENCIEUSEMENT par ON CONFLICT DO NOTHING. Un identifiant qui n'identifie pas
     * ne fait pas echouer, il fait disparaitre.
     *
     * Sept decimales de degre valent environ un centimetre : deux ouvrages distincts
     * ne peuvent pas partager cette cle, et elle reste stable d'un import a l'autre
     * tant que la geometrie source ne bouge pas — contrairement a un index de tableau.
     */
    const cle = `p${c[0].toFixed(7)},${c[1].toFixed(7)}`;

    retenus.push({
      cle,
      nom: p.nom?.trim() || `Pont sur ${p.nature} · ${cle}`,
      nomSource: Boolean(p.nom?.trim()),
      nature: String(p.nature),
      longueurM: p.longueurM ?? null,
      lat: c[1], lon: c[0],
    });
  }
  return { retenus, exclus };
}
