/**
 * Lecteur KML (module Projets de voirie et reseaux). Sans E/S.
 *
 * CE QUI EST LU
 *   - `Placemark` partout dans `Document` et `Folder` (imbrication quelconque) ; le chemin des dossiers devient l'attribut
 *     `dossier` ;
 *   - geometries `Point`, `LineString`, `LinearRing` (lu comme ligne), `Polygon` (anneau exterieur et trous),
 *     `MultiGeometry` (recursif) ;
 *   - extension Google Earth : `gx:Track` et `gx:MultiTrack` (`gx:coord` = « lon lat alt ») ;
 *   - attributs : `name`, `description`, `ExtendedData/Data/value`, `ExtendedData/SchemaData/SimpleData` ; les en-tetes
 *     `Schema/SimpleField` sont toleres (ils ne portent que des types) ; les valeurs restent des CHAINES, telles quelles.
 *
 * CE QUI EST IGNORE, AVEC UN AVERTISSEMENT : `NetworkLink`, `GroundOverlay`, `ScreenOverlay`, `PhotoOverlay`, `Model`
 * (aucun chargement distant n'est jamais fait). L'altitude est toujours ignoree.
 *
 * L'XML est lu par `xml.noyau.ts` : ni DTD, ni entite, ni resolution externe.
 */

import { Collecteur, formesVides, type Brut, type FormesBrutes } from "./collecteur.noyau";
import type { Puits } from "./formats/puits.noyau";
import { ErreurLecture } from "./lecture.types";
import type { Avertissement, LimitesLecture, ObjetLu, ResumeLecture } from "./lecture.types";
import { ErreurXml, lireXml, type NoeudXml } from "./xml.noyau";

const IGNORES = new Set(["NetworkLink", "GroundOverlay", "ScreenOverlay", "PhotoOverlay", "Model"]);
const CONTENEURS = new Set(["kml", "Document", "Folder"]);
const PROFONDEUR_GEOMETRIE_MAX = 8;

const estBlanc = (c: number) => c === 32 || c === 10 || c === 13 || c === 9;
/** Un nombre de coordonnee n'a jamais plus de 40 caracteres ; au-dela le champ est illisible (NaN), sans le convertir. */
const CHAMP_MAX = 40;

/**
 * « lon,lat[,alt] » separes par des blancs. Tolere « lon, lat » et « lon ,lat » (blancs autour d'une virgule).
 *
 * BALAYAGE LINEAIRE, SANS EXPRESSION REGULIERE (revue de securite, M1) : l'ancienne version remplacait par expression reguliere
 * les blancs autour des virgules dans tout le contenu : quadratique sur une longue suite d'espaces (80 000 espaces : 8 a 29 s de fil bloque). Ici chaque caractere est lu une fois.
 * Un champ vide (« 1,,2 ») ou illisible donne NaN, que le collecteur refuse.
 */
export function lireCoordonnees(texte: string): Brut[] {
  const n = texte.length;
  const tuples: Brut[] = [];
  let i = 0;
  for (;;) {
    while (i < n && estBlanc(texte.charCodeAt(i))) i++;
    if (i >= n) break;
    const tuple: number[] = [];
    for (;;) {
      while (i < n && estBlanc(texte.charCodeAt(i))) i++;
      const debut = i;
      while (i < n) {
        const c = texte.charCodeAt(i);
        if (estBlanc(c) || c === 44) break;
        i++;
      }
      tuple.push(i === debut || i - debut > CHAMP_MAX ? NaN : Number(texte.slice(debut, i)));
      // Une virgule (eventuellement precedee de blancs) continue le tuple ; sinon le tuple est termine.
      let j = i;
      while (j < n && estBlanc(texte.charCodeAt(j))) j++;
      if (j < n && texte.charCodeAt(j) === 44) { i = j + 1; continue; }
      break;
    }
    tuples.push(tuple);
  }
  return tuples;
}

/** `gx:coord` : « lon lat alt » separes par des blancs (meme balayage lineaire). */
function lireCoordGx(texte: string): Brut {
  const n = texte.length;
  const champs: number[] = [];
  let i = 0;
  while (i < n) {
    while (i < n && estBlanc(texte.charCodeAt(i))) i++;
    const debut = i;
    while (i < n && !estBlanc(texte.charCodeAt(i))) i++;
    if (i > debut) champs.push(i - debut > CHAMP_MAX ? NaN : Number(texte.slice(debut, i)));
  }
  return champs;
}

const enfant = (n: NoeudXml, nom: string) => n.enfants.find((e) => e.nom === nom);
const enfants = (n: NoeudXml, nom: string) => n.enfants.filter((e) => e.nom === nom);

function anneauDe(poly: NoeudXml, bord: "outerBoundaryIs" | "innerBoundaryIs"): Brut[][] {
  const sortie: Brut[][] = [];
  for (const b of enfants(poly, bord)) {
    const ring = enfant(b, "LinearRing");
    const coord = ring ? enfant(ring, "coordinates") : undefined;
    sortie.push(coord ? lireCoordonnees(coord.texte) : []);
  }
  return sortie;
}

function collecterGeometries(n: NoeudXml, formes: FormesBrutes, profondeur: number): boolean {
  if (profondeur > PROFONDEUR_GEOMETRIE_MAX) return false;
  let trouve = false;
  switch (n.nom) {
    case "Point": {
      const c = enfant(n, "coordinates");
      if (c) { const t = lireCoordonnees(c.texte); formes.points.push(t[0] ?? [NaN, NaN]); trouve = true; }
      break;
    }
    case "LineString":
    case "LinearRing": {
      const c = enfant(n, "coordinates");
      if (c) { formes.lignes.push(lireCoordonnees(c.texte)); trouve = true; }
      break;
    }
    case "Polygon": {
      const ext = anneauDe(n, "outerBoundaryIs");
      if (ext.length) { formes.polygones.push([ext[0], ...anneauDe(n, "innerBoundaryIs")]); trouve = true; }
      break;
    }
    case "Track": {
      formes.lignes.push(enfants(n, "coord").map((c) => lireCoordGx(c.texte)));
      trouve = true;
      break;
    }
    case "MultiTrack":
    case "MultiGeometry": {
      for (const e of n.enfants) trouve = collecterGeometries(e, formes, profondeur + 1) || trouve;
      break;
    }
    default:
      break;
  }
  return trouve;
}

/** Attributs d'un Placemark : champs de base puis donnees etendues (chaines). */
function attributsDe(pm: NoeudXml, dossier: string[]): { nom: string | null; attributs: Record<string, unknown> } {
  const entrees: Record<string, unknown> = {};
  const nomNoeud = enfant(pm, "name");
  const nom = nomNoeud ? nomNoeud.texte.trim() || null : null;
  const description = enfant(pm, "description");
  if (nom !== null) entrees.name = nom;
  if (description && description.texte.trim() !== "") entrees.description = description.texte;
  if (dossier.length) entrees.dossier = dossier.join(" / ");
  const poser = (cle: string, valeur: string) => {
    let k = cle;
    // Une donnee etendue qui porte le nom d'un champ deja pose (ou `__proto__`) ne l'ecrase pas.
    if (k === "__proto__" || Object.prototype.hasOwnProperty.call(entrees, k)) k = `${cle} (donnees etendues)`;
    entrees[k] = valeur;
  };
  for (const ed of enfants(pm, "ExtendedData")) {
    for (const d of enfants(ed, "Data")) {
      const cle = d.attrs.name;
      if (!cle) continue;
      const v = enfant(d, "value");
      poser(cle, (v ? v.texte : d.texte).trim());
    }
    for (const sd of enfants(ed, "SchemaData")) {
      for (const s of enfants(sd, "SimpleData")) {
        const cle = s.attrs.name;
        if (cle) poser(cle, s.texte.trim());
      }
    }
  }
  return { nom, attributs: entrees };
}

/** Verifie que la racine du document XML est celle d'un KML (ou d'un fragment KML). */
export function verifierRacineKml(racine: NoeudXml): void {
  if (racine.nom !== "kml" && racine.nom !== "Document" && racine.nom !== "Folder" && racine.nom !== "Placemark") {
    throw new ErreurLecture("FORMAT_NON_SUPPORTE", `fichier XML non reconnu comme KML (element racine « ${racine.nom} ») : seuls les formats KML, KMZ, GeoJSON, GPX et CSV sont pris en charge`);
  }
}

/** Parcourt l'arbre KML et livre chaque Placemark au `col` (la couche d'un Placemark est le chemin de ses dossiers, « » a la racine). */
export function traverserKml(racine: NoeudXml, col: Puits): void {
  const visiter = (n: NoeudXml, dossier: string[]): void => {
    if (n.nom === "Placemark") {
      col.elementLu();
      const formes = formesVides();
      let aGeometrie = false;
      for (const e of n.enfants) aGeometrie = collecterGeometries(e, formes, 0) || aGeometrie;
      if (!aGeometrie) { col.compter("OBJETS_SANS_GEOMETRIE"); return; }
      const { nom, attributs } = attributsDe(n, dossier);
      col.ajouter(nom, attributs, formes, dossier.join(" / "));
      return;
    }
    if (IGNORES.has(n.nom)) { col.elementIgnore(n.nom); return; }
    if (!CONTENEURS.has(n.nom)) return;
    let chemin = dossier;
    if (n.nom === "Folder") {
      const nomDossier = enfant(n, "name")?.texte.trim();
      if (nomDossier) chemin = [...dossier, nomDossier];
    }
    for (const e of n.enfants) visiter(e, chemin);
  };
  visiter(racine, []);
}

/** Analyse le texte XML d'un KML (sans DTD ni entite). */
export function lireArbreKml(texte: string): NoeudXml {
  try {
    return lireXml(texte);
  } catch (e) {
    if (e instanceof ErreurXml) throw new ErreurLecture(e.code, e.message);
    throw e;
  }
}

export function lireKml(texte: string, limites?: LimitesLecture): { objets: ObjetLu[]; avertissements: Avertissement[]; resume: ResumeLecture } {
  const racine = lireArbreKml(texte);
  verifierRacineKml(racine);
  const col = new Collecteur(limites);
  traverserKml(racine, col);
  return col.terminer();
}
