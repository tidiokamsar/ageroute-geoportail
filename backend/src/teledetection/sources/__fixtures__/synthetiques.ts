/**
 * JEUX FABRIQUES (synthetique: true) : cas limites qu'aucune reponse reelle n'a produits le jour de la
 * capture (couverture nuageuse absente, emprise invalide, 429, pagination longue, doublons).
 *
 * Chaque objet porte `synthetique: true` et part d'un item REEL copie puis altere sur UN point,
 * nomme dans la fonction. Rien ici n'est presente comme une reponse de fournisseur ; aucune vue de
 * production n'en depend (contrat API §9).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SYNTHETIQUE = true as const;

function itemReel(fichier: string, indice = 0): any {
  const doc = JSON.parse(readFileSync(join(__dirname, fichier), "utf8"));
  return JSON.parse(JSON.stringify(doc.reponse.features[indice]));
}

const marque = <T extends object>(o: T): T & { synthetique: true } => ({ ...o, synthetique: SYNTHETIQUE });

export const itemCdseReel = () => itemReel("cdse-stac-s2-l2a.json", 0);
export const itemCdseRadarReel = () => itemReel("cdse-stac-s1-grd.json", 0);
export const itemEarthSearchReel = () => itemReel("earth-search-s2-l2a.json", 0);

/** Optique dont le fournisseur ne donne pas `eo:cloud_cover`. */
export function sansNuages(base = itemCdseReel()): any {
  const c = marque(base);
  delete c.properties["eo:cloud_cover"];
  return c;
}

/** Optique avec une couverture nuageuse absurde (hors 0-100). */
export function nuagesHorsBornes(valeur = 140, base = itemCdseReel()): any {
  const c = marque(base);
  c.properties["eo:cloud_cover"] = valeur;
  return c;
}

/** Optique a 0 % de nuages (vrai zero annonce : doit rester 0, pas devenir null). */
export function zeroNuagesAnnonce(base = itemCdseReel()): any {
  const c = marque(base);
  c.properties["eo:cloud_cover"] = 0;
  return c;
}

/** Emprise dont l'anneau n'est pas ferme. */
export function empriseNonFermee(base = itemCdseReel()): any {
  const c = marque(base);
  c.geometry = { type: "Polygon", coordinates: [c.geometry.coordinates[0].slice(0, -1)] };
  return c;
}

export function empriseAbsente(base = itemCdseReel()): any {
  const c = marque(base);
  delete c.geometry;
  return c;
}

/** Emprise d'aire nulle (quatre fois le meme point). */
export function empriseDegeneree(base = itemCdseReel()): any {
  const c = marque(base);
  c.geometry = { type: "Polygon", coordinates: [[[-14, 10], [-14, 10], [-14, 10], [-14, 10]]] };
  return c;
}

/** Position hors du globe (latitude 95). */
export function empriseHorsGlobe(base = itemCdseReel()): any {
  const c = marque(base);
  c.geometry = { type: "Polygon", coordinates: [[[-14, 95], [-13, 95], [-13, 96], [-14, 95]]] };
  return c;
}

export function dateIllisible(base = itemCdseReel()): any {
  const c = marque(base);
  c.properties.datetime = "hier";
  c.properties.start_datetime = "hier"; // sinon la lecture se replie, a raison, sur start_datetime
  return c;
}

export function collectionInconnue(base = itemCdseReel()): any {
  const c = marque(base);
  c.collection = "sentinel-3-olci";
  return c;
}

/** Radar en mode EW : la table de resolution ne couvre que IW GRDH, donc la resolution est indeterminable. */
export function radarModeEw(base = itemCdseRadarReel()): any {
  const c = marque(base);
  c.properties["sar:instrument_mode"] = "EW";
  c.properties["product:type"] = "EW_GRDM_1S";
  c.id = c.id.replace("_IW_GRDH_", "_EW_GRDM_");
  return c;
}

/** Radar qui annonce a tort une couverture nuageuse : elle doit etre ignoree (null). */
export function radarAvecNuagesParErreur(base = itemCdseRadarReel()): any {
  const c = marque(base);
  c.properties["eo:cloud_cover"] = 12;
  return c;
}

/** Actif dont l'adresse porte une signature et un identifiant : rien de tout cela ne doit rester. */
export function lienSigne(base = itemEarthSearchReel()): any {
  const c = marque(base);
  c.assets.thumbnail.href = "https://utilisateur:motdepasse@sentinel-cogs.s3.us-west-2.amazonaws.com/preview.jpg?sig=ABCDEF123456&se=2026-10-26&x=1#fragment";
  return c;
}

export function sansIdentifiant(base = itemCdseReel()): any {
  const c = marque(base);
  delete c.id;
  return c;
}

/** Copie d'un item sous un autre identifiant et une autre date (pagination longue, doublons). */
export function variante(base: any, id: string, datetime: string, nuages?: number): any {
  const c = marque(JSON.parse(JSON.stringify(base)));
  c.id = id;
  c.properties.datetime = datetime;
  c.properties.start_datetime = datetime;
  c.properties.end_datetime = datetime;
  if (nuages !== undefined) c.properties["eo:cloud_cover"] = nuages;
  return c;
}

export interface LienSuivantSynthetique { href: string; methode?: "GET" | "POST"; body?: object; merge?: boolean }

/** Page STAC fabriquee : `features`, plus un lien « next » si demande. */
export function page(features: any[], suivant?: LienSuivantSynthetique, extra: Record<string, unknown> = {}): any {
  const links: any[] = [{ rel: "root", href: "https://stac.dataspace.copernicus.eu/v1/" }];
  if (suivant) {
    links.push({ rel: "next", method: suivant.methode ?? "POST", href: suivant.href, body: suivant.body, merge: suivant.merge, type: "application/geo+json" });
  }
  return { synthetique: SYNTHETIQUE, type: "FeatureCollection", features, links, numberReturned: features.length, ...extra };
}

/** Corps d'erreur d'un fournisseur qui renvoie, par maladresse, le jeton recu. */
export function erreurQuiRepeteLeJeton(jeton: string): any {
  return { synthetique: SYNTHETIQUE, code: "RATE_LIMIT_EXCEEDED", message: `You have exceeded your rate limit (Authorization: Bearer ${jeton}; access_token=${jeton})` };
}
