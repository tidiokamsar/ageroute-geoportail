/**
 * Lecteur GeoJSON (module Projets de voirie et reseaux). Sans E/S.
 *
 * Accepte `FeatureCollection`, `Feature` isolee, geometrie nue et `GeometryCollection` (decoupee comme un MultiGeometry KML).
 * RFC 7946 : WGS 84, longitude puis latitude. Un membre `crs` qui n'est pas WGS 84 (CRS84 ou EPSG:4326) est REFUSE
 * (CRS_NON_SUPPORTE) plutot que lu de travers. L'altitude (troisieme valeur) est ignoree. Les proprietes deviennent les
 * attributs tels quels ; `name`, `nom`, `Name`, `NAME`, `NOM` ou `title` (premiere chaine non vide) donne le nom.
 */

import { Collecteur, formesVides, type Brut, type FormesBrutes } from "./collecteur.noyau";
import { ErreurLecture } from "./lecture.types";
import type { Avertissement, ObjetLu, ResumeLecture } from "./lecture.types";

const CLES_NOM = ["name", "nom", "Name", "NAME", "NOM", "title"];
const PROFONDEUR_GEOMETRIE_MAX = 8;
const CRS_ADMIS = [/^urn:ogc:def:crs:ogc:1\.3:crs84$/i, /^urn:ogc:def:crs:epsg::?4326$/i, /^epsg:4326$/i, /^crs84$/i];

type Json = unknown;
const estObjet = (v: Json): v is Record<string, Json> => !!v && typeof v === "object" && !Array.isArray(v);
const estPosition = (v: Json): v is number[] => Array.isArray(v) && v.length >= 2 && v.every((x) => typeof x === "number");

function verifierCrs(doc: Record<string, Json>): void {
  const crs = doc.crs;
  if (crs === undefined || crs === null) return;
  const nom = estObjet(crs) && estObjet(crs.properties) && typeof crs.properties.name === "string" ? crs.properties.name : null;
  if (nom === null || !CRS_ADMIS.some((r) => r.test(nom.trim()))) {
    throw new ErreurLecture("CRS_NON_SUPPORTE", `systeme de coordonnees « ${nom ?? "illisible"} » non pris en charge : seul WGS 84 (longitude, latitude) est admis dans ce lot ; les systemes projetes (EPSG choisi par l'utilisateur ou points de controle) sont prevus au lot suivant`);
  }
}

function coordonnees(v: Json): Brut[] {
  return Array.isArray(v) ? v.map((p) => (estPosition(p) ? p : [NaN, NaN])) : [];
}

/** Ajoute une geometrie GeoJSON aux formes. Rend vrai si elle est reconnue (meme vide ou invalide : le collecteur tranche). */
function collecter(g: Json, formes: FormesBrutes, profondeur: number): boolean {
  if (!estObjet(g) || profondeur > PROFONDEUR_GEOMETRIE_MAX) return false;
  const c = g.coordinates;
  switch (g.type) {
    case "Point": formes.points.push(estPosition(c) ? c : [NaN, NaN]); return true;
    case "MultiPoint": for (const p of coordonnees(c)) formes.points.push(p); return Array.isArray(c);
    case "LineString": formes.lignes.push(coordonnees(c)); return true;
    case "MultiLineString": if (!Array.isArray(c)) return false; for (const l of c) formes.lignes.push(coordonnees(l)); return true;
    case "Polygon": if (!Array.isArray(c)) return false; formes.polygones.push(c.map(coordonnees)); return true;
    case "MultiPolygon":
      if (!Array.isArray(c)) return false;
      for (const p of c) formes.polygones.push(Array.isArray(p) ? p.map(coordonnees) : []);
      return true;
    case "GeometryCollection": {
      let ok = false;
      if (Array.isArray(g.geometries)) for (const s of g.geometries) ok = collecter(s, formes, profondeur + 1) || ok;
      return ok;
    }
    default: return false;
  }
}

function nomDe(props: Record<string, Json>): string | null {
  for (const k of CLES_NOM) {
    const v = props[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

export function lireGeoJson(texte: string): { objets: ObjetLu[]; avertissements: Avertissement[]; resume: ResumeLecture } {
  let doc: Json;
  try {
    doc = JSON.parse(texte);
  } catch (e) {
    throw new ErreurLecture("JSON_INVALIDE", `JSON illisible : ${e instanceof Error ? e.message.slice(0, 120) : "erreur de syntaxe"}`);
  }
  if (!estObjet(doc) || typeof doc.type !== "string") {
    throw new ErreurLecture("FORMAT_NON_SUPPORTE", "document JSON qui n'est pas du GeoJSON (membre « type » absent)");
  }
  verifierCrs(doc);

  const col = new Collecteur();
  const traiter = (f: Record<string, Json>): void => {
    col.elementLu();
    const formes = formesVides();
    const geometrie = f.geometry;
    const reconnue = geometrie === null || geometrie === undefined ? false : collecter(geometrie, formes, 0);
    if (!reconnue) { col.compter("OBJETS_SANS_GEOMETRIE"); return; }
    const props = estObjet(f.properties) ? f.properties : {};
    const attributs: Record<string, unknown> = Object.fromEntries(Object.entries(props));
    if (f.id !== undefined && f.id !== null && !("id" in attributs)) attributs.id = f.id;
    col.ajouter(nomDe(props), attributs, formes);
  };

  switch (doc.type) {
    case "FeatureCollection": {
      if (!Array.isArray(doc.features)) throw new ErreurLecture("FORMAT_NON_SUPPORTE", "FeatureCollection sans tableau « features »");
      for (const f of doc.features) {
        if (estObjet(f) && f.type === "Feature") traiter(f);
        else col.compter("OBJETS_SANS_GEOMETRIE");
      }
      break;
    }
    case "Feature": traiter(doc); break;
    case "Point": case "MultiPoint": case "LineString": case "MultiLineString": case "Polygon": case "MultiPolygon": case "GeometryCollection":
      traiter({ type: "Feature", geometry: doc, properties: {} });
      break;
    default:
      throw new ErreurLecture("FORMAT_NON_SUPPORTE", `type GeoJSON « ${doc.type} » non pris en charge`);
  }
  return col.terminer();
}
