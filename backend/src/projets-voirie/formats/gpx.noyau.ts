/**
 * Lecteur GPX (module Projets de voirie et reseaux). Sans E/S. L'XML est lu par `xml.noyau.ts` : ni DTD, ni entite, ni ressource externe.
 *
 * LU : `wpt` (points), `rte` / `rtept` (une ligne par route), `trk` / `trkseg` / `trkpt` (une ligne par SEGMENT, regroupees en un objet par
 * trace : deux segments ne sont jamais raccordes). Attributs : `name`, `desc`, `cmt`, `src`, `type`, `sym`, `number` ; pour un point de
 * passage seulement, `time` (texte tel quel).
 * Le GPX est en WGS 84 PAR DEFINITION (latitude et longitude en degres decimaux) : aucun CRS n'est lu ni choisi.
 *
 * IGNORE : l'altitude (`ele`, signalee comme pour le KML), les HORODATAGES et les precisions (`time`, `hdop`, `vdop`, `pdop`, `sat`...) des
 * points de route et de trace (avertissement `HORODATAGES_IGNORES`, nombre de points concernes), `metadata`, `extensions`, `link` : aucune
 * ressource externe n'est jamais chargee.
 */

import type { Brut, FormesBrutes } from "../collecteur.noyau";
import { formesVides } from "../collecteur.noyau";
import { ErreurLecture } from "../lecture.types";
import type { Avertissement } from "../lecture.types";
import type { NoeudXml } from "../xml.noyau";
import type { Puits } from "./puits.noyau";

const RE_DEGRES = /^[+-]?\d{1,3}(?:\.\d{1,15})?$/;
const RE_ALTITUDE = /^[+-]?\d{1,6}(?:\.\d{1,10})?$/;

const enfant = (n: NoeudXml, nom: string) => n.enfants.find((e) => e.nom === nom);
const enfants = (n: NoeudXml, nom: string) => n.enfants.filter((e) => e.nom === nom);

function point(n: NoeudXml): Brut {
  const lat = n.attrs.lat, lon = n.attrs.lon;
  const lo = lon !== undefined && RE_DEGRES.test(lon.trim()) ? Number(lon) : NaN;
  const la = lat !== undefined && RE_DEGRES.test(lat.trim()) ? Number(lat) : NaN;
  const ele = enfant(n, "ele")?.texte.trim();
  return ele !== undefined && RE_ALTITUDE.test(ele) ? [lo, la, Number(ele)] : [lo, la];
}

function champsTexte(n: NoeudXml, cles: readonly string[]): Record<string, unknown> {
  const a: Record<string, unknown> = {};
  for (const k of cles) {
    const t = enfant(n, k)?.texte.trim();
    if (t) a[k] = t;
  }
  return a;
}

const CHAMPS_COMMUNS = ["desc", "cmt", "src", "type", "number"] as const;

export interface ResultatGpx { avertissements: Avertissement[]; nbWaypoints: number; nbRoutes: number; nbTraces: number }

/** Parcourt un document GPX et livre waypoints, routes et traces au `col`. */
export function traverserGpx(racine: NoeudXml, col: Puits): ResultatGpx {
  if (racine.nom !== "gpx") throw new ErreurLecture("GPX_INVALIDE", `l'element racine du GPX doit etre « gpx » (lu : « ${racine.nom.slice(0, 40)} »)`);
  let horodatages = 0;
  const r: ResultatGpx = { avertissements: [], nbWaypoints: 0, nbRoutes: 0, nbTraces: 0 };

  for (const n of racine.enfants) {
    if (n.nom === "wpt") {
      col.elementLu();
      r.nbWaypoints++;
      const attrs = champsTexte(n, [...CHAMPS_COMMUNS, "sym"]);
      const t = enfant(n, "time")?.texte.trim();
      if (t) attrs.time = t;
      const nom = enfant(n, "name")?.texte.trim() || null;
      if (nom) attrs.name = nom;
      const formes = formesVides();
      formes.points.push(point(n));
      col.ajouter(nom, attrs, formes, "waypoints");
    } else if (n.nom === "rte") {
      col.elementLu();
      r.nbRoutes++;
      const formes: FormesBrutes = { points: [], lignes: [enfants(n, "rtept").map(point)], polygones: [] };
      for (const p of enfants(n, "rtept")) if (enfant(p, "time")) horodatages++;
      const nom = enfant(n, "name")?.texte.trim() || null;
      const attrs = { ...(nom ? { name: nom } : {}), ...champsTexte(n, CHAMPS_COMMUNS) };
      col.ajouter(nom, attrs, formes, "routes");
    } else if (n.nom === "trk") {
      col.elementLu();
      r.nbTraces++;
      const segments = enfants(n, "trkseg");
      const formes: FormesBrutes = { points: [], lignes: segments.map((s) => enfants(s, "trkpt").map(point)), polygones: [] };
      for (const s of segments) for (const p of enfants(s, "trkpt")) if (enfant(p, "time")) horodatages++;
      if (segments.length === 0) { col.compter("OBJETS_SANS_GEOMETRIE"); continue; }
      const nom = enfant(n, "name")?.texte.trim() || null;
      const attrs: Record<string, unknown> = { ...(nom ? { name: nom } : {}), ...champsTexte(n, CHAMPS_COMMUNS), nbSegments: String(segments.length) };
      col.ajouter(nom, attrs, formes, "traces");
    }
  }
  if (horodatages > 0) {
    r.avertissements.push({ code: "HORODATAGES_IGNORES", message: "Horodatages et precisions GPS des points de route et de trace ignores (seule la position est conservee).", nb: horodatages });
  }
  return r;
}
