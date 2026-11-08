/**
 * RESULTAT DE CONVERSION VALIDE (lot B2) : assemblage, resume sans geometrie, selection de couches, document GeoJSON pour le pipeline commun. Sans E/S.
 *
 * `assembler` ne recoit que des donnees DEJA validees (`sortie.noyau.ts`) ; il ajoute les regles qui dependent des choix de l'utilisateur :
 *   - DXF : les calques deviennent les couches du wizard (`calque:<nom>`), les unites declarees sont controlees contre l'en-tete et le CRS ;
 *   - GeoPackage et Shapefile : une couche par fichier GeoJSON converti (`id` = nom ASCII calcule par le conteneur) ;
 *   - le CRS source (fichier ou demande) de chaque couche, JAMAIS devine : voir `choisirCrsConverti` (formats/crs.noyau.ts).
 */

import type { MetaCrs } from "../formats/crs.noyau";
import type { Avertissement, Bbox } from "../lecture.types";
import { ErreurLecture } from "../lecture.types";
import type { FormatGdal, UniteDxf } from "./contrat.noyau";
import {
  ErreurSortie, controlerResultat, controlerUnitesDxf, slugDeFichier, type AttendusJob, type CoucheValidee, type FeatureValide, type InventaireDxf, type ResultatWorker,
} from "./sortie.noyau";

export interface FamilleCompte { LIGNE: number; POINT: number; POLYGONE: number }

export interface CrsSourceCouche { origine: "fichier" | "demande"; epsg: number | null; nom: string | null }

export interface CoucheConvertie {
  /** Identifiant propose a l'option `couche` : nom ASCII du conteneur (GeoPackage, Shapefile) ou `calque:<nom>` (DXF). */
  id: string;
  nom: string;
  nbObjets: number;
  parTypeGeom: FamilleCompte;
  typesReels: Record<string, number>;
  sommets: number;
  emprise: Bbox | null;
  attributs: string[];
  coordonnees: "wgs84" | "brutes";
  reprojete: boolean;
  crsSource: CrsSourceCouche | null;
  /** Fichier GeoJSON du spool qui porte cette couche (`couches/<slug>.geojson`). */
  slug: string;
  /** Features, seulement quand la couche a ete lue pour l'apercu ou le depot. */
  features?: FeatureValide[];
}

export interface ParametresJob { epsgSource?: number; unitesDxf?: UniteDxf }

export interface IntegriteCouche { slug: string; sha256: string; octets: number }

export interface ConversionValidee {
  format: FormatGdal;
  jobId: string;
  source: { nom: string; octets: number; sha256: string };
  gdal: { version: string; proj: string | null };
  parametres: ParametresJob;
  couches: CoucheConvertie[];
  champsDisponibles: string[];
  dxf: (InventaireDxf & { unitesDeclarees: UniteDxf | null; insunits: number | null }) | null;
  avertissements: Avertissement[];
  integrite: IntegriteCouche[];
  attributsAdaptes: number;
  /** Meta du CRS source (nom, unite) lue dans la base par le service, jamais devinee : sert a `resume.crs`. */
  metaSource?: MetaCrs;
}

/** Libelles FIXES des avertissements du conteneur : le texte libre du conteneur n'est jamais renvoye (donnee non fiable). */
const MESSAGES_AVERTISSEMENT: Readonly<Record<string, string>> = {
  EXTENSION_INCOHERENTE: "L'extension du fichier ne correspond pas à son contenu : le contenu fait foi.",
  ENTREES_ARCHIVE_IGNOREES: "Des entrées de l'archive ne sont pas des Shapefiles et ont été ignorées.",
  FICHIERS_ORPHELINS: "Des fichiers de Shapefile sans fichier .shp ont été ignorés.",
  NOM_FICHIER_RENOMME: "Des noms de fichier de l'archive ont été normalisés.",
  UNITES_ABSENTES: "Les unités du dessin ne sont pas lisibles dans l'en-tête du fichier.",
  COUCHE_SANS_GEOMETRIE_IGNOREE: "Une table sans géométrie a été ignorée.",
  COUCHE_SANS_GEOMETRIE: "Une couche sans géométrie (table d'attributs) a été signalée.",
  COUCHE_NOM_REFUSE: "Une couche dont le nom n'est pas sûr (tiret initial, caractère de contrôle) a été ignorée.",
  CRS_ABSENT: "Aucun système de coordonnées dans le fichier : coordonnées brutes, à confirmer par l'utilisateur.",
  CRS_FOURNI_PAR_LA_DEMANDE: "Le fichier n'a pas de système de coordonnées : celui que vous avez confirmé a été appliqué.",
  CRS_SURCHARGE: "Le système de coordonnées du fichier a été remplacé sur demande explicite.",
  CRS_SANS_CODE_EPSG: "Le système de coordonnées du fichier n'a pas de code EPSG identifiable.",
  COMPTE_DECLARE_DIVERGENT: "Le fichier annonce un nombre d'objets différent de celui lu.",
  COORDONNEES_NON_FINIES: "Des coordonnées non finies ont été relevées par le convertisseur.",
  COORDONNEES_HORS_PLAGE: "Des coordonnées WGS 84 hors de la plage des degrés ont été relevées.",
  GEOMETRIES_NULLES: "Des objets n'ont aucune géométrie après conversion.",
  AVERTISSEMENTS_GDAL: "GDAL a émis des avertissements pendant la conversion (par exemple, altitude ignorée).",
  ANALYSE_GEOMETRIE_PARTIELLE: "Des objets trop volumineux n'ont pas été analysés par le convertisseur.",
  COUCHE_VIDE: "Une couche ne contient aucun objet.",
  DXF_ENTITES_IGNOREES: "Des entités DXF non prises en charge ont été ignorées et comptées.",
  DXF_BLOCS_IGNORES: "Les blocs DXF (insertions et définitions) ne sont pas lus.",
};

export function avertissementsDuConteneur(r: ResultatWorker): Avertissement[] {
  const vus = new Map<string, Avertissement>();
  for (const a of r.avertissements) {
    const message = MESSAGES_AVERTISSEMENT[a.code] ?? "Avertissement du convertisseur.";
    const existant = vus.get(a.code);
    const nb = (existant?.nb ?? 0) + (a.nb ?? 0);
    vus.set(a.code, { code: a.code as Avertissement["code"], message, ...(nb > 0 ? { nb } : {}) });
  }
  return [...vus.values()];
}

export interface CoucheLue { v: CoucheValidee; sha256: string; octets: number }

export interface EntreeAssemblage {
  format: FormatGdal;
  resultat: ResultatWorker;
  attendus: AttendusJob;
  parametres: ParametresJob;
  /** Couches du spool lues et validees, par nom de fichier (`slug`). */
  lues: ReadonlyMap<string, CoucheLue>;
  /** `$INSUNITS` lu dans l'inventaire du conteneur (DXF) ; `null` si absent. */
  insunits: number | null;
  /** Unite du CRS source choisi (`metre`, `degre`), pour controler les unites d'un DXF. */
  uniteCrsSource: string | null;
}

/** Assemble le resultat valide : controle de coherence, couches du wizard, avertissements, integrite. Leve `ErreurSortie` en cas d'incoherence. */
export function assembler(e: EntreeAssemblage): ConversionValidee {
  const r = e.resultat;
  controlerResultat(r, e.attendus);
  const couches: CoucheConvertie[] = [];
  const integrite: IntegriteCouche[] = [];
  let adaptes = 0;
  const champs = new Set<string>();

  let dxf: ConversionValidee["dxf"] = null;
  if (e.format === "DXF") {
    const inv = r.dxf!;
    if (e.parametres.unitesDxf === undefined) throw new ErreurLecture("CRS_REQUIS", "les unites du DXF doivent etre declarees (unitesDxf) : elles ne sont jamais devinees");
    if (e.uniteCrsSource === null) throw new ErreurLecture("CRS_REQUIS", "le CRS du DXF doit etre confirme (epsgSource) : il n'est jamais devine");
    controlerUnitesDxf(e.parametres.unitesDxf, e.insunits, e.uniteCrsSource);
    dxf = { ...inv, unitesDeclarees: e.parametres.unitesDxf, insunits: e.insunits };
  }

  for (const c of r.couches) {
    const slug = slugDeFichier(c.fichier);
    const lue = e.lues.get(slug);
    if (!lue) continue; // couche non lue (selection) : seule son identite est connue
    integrite.push({ slug, sha256: lue.sha256, octets: lue.octets });
    adaptes += lue.v.attributsAdaptes;
    for (const a of lue.v.attributs) champs.add(a);
    if (lue.octets !== c.octets) throw new ErreurSortie("SORTIE_INCOHERENTE", "taille du fichier de couche differente de celle annoncee");

    if (e.format === "DXF") {
      for (const [nomCalque, g] of [...(lue.v.groupes ?? new Map()).entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        couches.push({
          id: `calque:${nomCalque}`, nom: nomCalque, nbObjets: g.nb, parTypeGeom: { ...g.parFamille }, typesReels: lue.v.typesReels, sommets: lue.v.sommets,
          emprise: lue.v.emprise, attributs: lue.v.attributs, coordonnees: c.coordonnees, reprojete: c.reprojete, crsSource: c.crsSource, slug,
          ...(lue.v.features ? { features: lue.v.features.filter((f) => f.groupe === nomCalque) } : {}),
        });
      }
    } else {
      couches.push({
        id: slug, nom: c.nom, nbObjets: lue.v.nb, parTypeGeom: { ...lue.v.parFamille }, typesReels: lue.v.typesReels, sommets: lue.v.sommets,
        emprise: lue.v.emprise, attributs: lue.v.attributs, coordonnees: c.coordonnees, reprojete: c.reprojete, crsSource: c.crsSource, slug,
        ...(lue.v.features ? { features: lue.v.features } : {}),
      });
    }
  }
  const avert = avertissementsDuConteneur(r);
  if (adaptes > 0) avert.push({ code: "ATTRIBUTS_ADAPTES" as Avertissement["code"], message: "Des valeurs d'attribut trop longues ou structurées ont été tronquées ou converties en texte.", nb: adaptes });
  if (dxf && dxf.nbEntitesTotal > 0 && Object.values(dxf.lues).reduce((a, b) => a + b, 0) !== [...e.lues.values()].reduce((a, l) => a + l.v.nb, 0)) {
    avert.push({ code: "COMPTE_DXF_DIVERGENT" as Avertissement["code"], message: "Le nombre d'entités DXF retenues diffère du nombre d'objets convertis." });
  }
  return {
    format: e.format, jobId: r.jobId, source: r.source!, gdal: { version: r.gdal.version, proj: r.gdal.proj }, parametres: e.parametres,
    couches, champsDisponibles: [...champs].sort().slice(0, 500), dxf, avertissements: avert, integrite, attributsAdaptes: adaptes,
  };
}

// ------------------------------------------------------------------------------------------------ Resume (sans geometrie)

export interface CoucheResume {
  id: string; nom: string; nbObjets: number; parTypeGeom: FamilleCompte; typesReels: Record<string, number>; sommets: number; emprise: Bbox | null;
  attributs: string[]; coordonnees: "wgs84" | "brutes"; reprojete: boolean; crsSource: CrsSourceCouche | null; slug: string;
}

export interface ResumeJob {
  format: FormatGdal;
  source: { nom: string; octets: number; sha256: string };
  gdal: { version: string; proj: string | null };
  couches: CoucheResume[];
  champsDisponibles: string[];
  dxf: ConversionValidee["dxf"];
  avertissements: Avertissement[];
  integrite: IntegriteCouche[];
}

/** Ce que le job conserve en base et montre a l'API : comptes, CRS, calques, avertissements. JAMAIS une coordonnee d'objet (l'emprise globale est un resume). */
export function resumer(c: ConversionValidee): ResumeJob {
  return {
    format: c.format, source: c.source, gdal: c.gdal,
    couches: c.couches.map(({ features: _f, ...reste }) => reste),
    champsDisponibles: c.champsDisponibles, dxf: c.dxf, avertissements: c.avertissements, integrite: c.integrite,
  };
}

// ------------------------------------------------------------------------------------------------ Selection et document

/**
 * Selection de couches pour le pipeline : `couche` absent = toutes les couches non vides (avertissement `COUCHES_MULTIPLES` si plusieurs) ;
 * inconnu = `COUCHE_INTROUVABLE`. Plusieurs couches de CRS source differents refusent la selection (`CRS_MULTIPLES`) : le CRS n'est jamais "moyenne".
 */
export function selectionner(couches: readonly CoucheConvertie[], demandee: string | undefined): CoucheConvertie[] {
  let choisies: CoucheConvertie[];
  if (demandee !== undefined) {
    const c = couches.find((x) => x.id === demandee);
    if (!c) throw new ErreurLecture("COUCHE_INTROUVABLE", `la couche « ${demandee.slice(0, 40)} » n'existe pas dans ce fichier (couches : ${couches.map((x) => x.id.slice(0, 40)).slice(0, 20).join(", ") || "aucune"})`);
    choisies = [c];
  } else choisies = couches.filter((x) => x.nbObjets > 0);
  const epsgs = new Set(choisies.map((c) => `${c.crsSource?.epsg ?? "?"}|${c.coordonnees}`));
  if (epsgs.size > 1) {
    throw new ErreurLecture("CRS_MULTIPLES", "les couches du fichier n'ont pas le meme systeme de coordonnees source : choisissez une couche (option couche), le CRS n'est jamais deduit pour un melange");
  }
  return choisies;
}

/**
 * Document GeoJSON (WGS 84, `FeatureCollection`) des couches choisies, que le pipeline commun lit comme n'importe quel GeoJSON : MEME collecteur,
 * memes limites de sommets, memes controles de zone et de geometrie. Plusieurs couches : la couche d'origine est conservee dans `_couche`.
 */
export function documentGeoJson(choisies: readonly CoucheConvertie[]): Record<string, unknown> {
  const multiple = choisies.length > 1;
  const features: unknown[] = [];
  for (const c of choisies) {
    for (const f of c.features ?? []) {
      features.push({ type: "Feature", geometry: f.geometry, properties: multiple ? { ...f.properties, _couche: c.nom } : f.properties });
    }
  }
  return { type: "FeatureCollection", features };
}
