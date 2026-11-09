/**
 * LECTURE DES FORMATS OUVERTS (lot A1) : detection par le contenu, inventaire, puis lecture en deux temps. Sans E/S, sans base.
 * Contrat : docs/projets-voirie/CONTRAT-IMPORT.md.
 *
 *   detecter()   KML, KMZ, GeoJSON, GPX ou CSV, PAR LE CONTENU (l'extension ne sert qu'a un avertissement) ;
 *   inventorier()  couches, entrees d'archive, colonnes, CRS exige ou declare : ne controle aucune coordonnee ;
 *   preparer()   lit le fichier dans un Collecteur (WGS 84) ou, si le CRS choisi est projete, dans un Enregistreur : les coordonnees
 *                SOURCE partent alors a la base (ST_Transform, voir crs.service.ts) et `terminer()` les rejoue dans le Collecteur.
 *
 * Le socle (`lireFichier` : KML et GeoJSON WGS 84) est CONSERVE tel quel ; ce module l'etend sans le modifier.
 */

import { Collecteur } from "../collecteur.noyau";
import { ErreurMetier } from "../erreurs";
import { crsDeclareGeoJson, lireDocumentGeoJson, traverserGeoJson } from "../lecture.geojson.noyau";
import { lireArbreKml, traverserKml, verifierRacineKml } from "../lecture.kml.noyau";
import { CRS_GEOJSON, CRS_KML, PROFONDEUR_JSON_MAX, REGEX_HTML, contenuRefuse, decoderTexte, extensionDe, profondeurJson } from "../lecture.noyau";
import {
  BBOX_GUINEE, ErreurLecture, TAILLE_MAX_OCTETS,
  type Avertissement, type Bbox, type FormatFichier, type InfoCrs, type LimitesLecture, type ObjetLu, type ResumeLecture,
} from "../lecture.types";
import type { NoeudXml } from "../xml.noyau";
import { inspecterCsv, lireCsv, type InventaireCsv, type LimitesCsv, type OptionsCsv, type RejetCsv, type ResultatCsv } from "./csv.noyau";
import {
  EPSG_CIBLE, choisirCrs, libelleCrs, libelleMethode, type ChoixCrs, type MetaCrs, type OrigineCrs, type Plausibilite,
} from "./crs.noyau";
import { proposerChampsJeu, type Mapping, type PropositionJeu } from "./mapping.noyau";
import { Enregistreur, Inventaire, PuitsFiltre, type ChampJeu, type CoucheInventoriee, type Puits, type SommetsBruts } from "./puits.noyau";
import { traverserGpx, type ResultatGpx } from "./gpx.noyau";
import { choisirEntreeKml, estZip, extraireEntree, inspecterZip, typeEntree, type LimitesZip, type TypeEntree } from "./zip.noyau";

export interface OptionsImport {
  couche?: string;
  entreeKml?: string;
  epsgSource?: number;
  confirmerHorsZone?: boolean;
  csv?: OptionsCsv;
  mapping?: Mapping;
}

export interface LimitesImport {
  lecture: LimitesLecture;
  zip: LimitesZip;
  csv: LimitesCsv;
  crsAutorises: readonly number[];
}

export interface EntreeArchiveVue { nom: string; tailleOctets: number; type: TypeEntree }
export interface InfoArchive {
  nbEntrees: number;
  tailleDecompresseeOctets: number;
  kmlPrincipal: string | null;
  entreesKml: string[];
  /** Plusieurs `.kml` sans `doc.kml` : l'utilisateur doit choisir (`entreeKml`). */
  choixRequis: boolean;
  entrees: EntreeArchiveVue[];
}

export interface Detection {
  format: FormatFichier;
  extensionDeclaree: string | null;
  extensionCoherente: boolean;
  archive: InfoArchive | null;
  entreeKml: string | null;
  racine?: NoeudXml;
  doc?: Record<string, unknown>;
  csv?: InventaireCsv;
  avertissements: Avertissement[];
}

const EXTENSIONS_ATTENDUES: Record<string, FormatFichier> = {
  kml: "KML", kmz: "KMZ", geojson: "GEOJSON", json: "GEOJSON", gpx: "GPX", csv: "CSV", tsv: "CSV", txt: "CSV", psv: "CSV",
};
const ENTREES_VUES_MAX = 200;
/** Couches listees dans la reponse d'inventaire (O6) : la liste est bornee, le total reste annonce ; les couches au-dela restent choisissables par leur identifiant. */
export const COUCHES_REPONSE_MAX = 200;
const CHOIX_FORMATS = "KML, KMZ, GeoJSON, GPX ou tableau delimite (CSV, TSV, TXT)";

function premierOctetUtile(b: Buffer): number {
  let i = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d)) i++;
  return i < b.length ? b[i] : -1;
}

function textePropre(t: string): string { return t.replace(/^﻿/, ""); }

/** Detecte le format PAR LE CONTENU et prepare l'analyse. `inventaire` : un KMZ a plusieurs KML s'inventorie au lieu d'echouer. */
export function detecter(contenu: Buffer, nomFichier: string, opts: OptionsImport, lim: LimitesImport, mode: { inventaire?: boolean } = {}): Detection {
  if (contenu.length === 0) throw new ErreurLecture("FICHIER_VIDE", "le fichier est vide");
  if (contenu.length > TAILLE_MAX_OCTETS) throw new ErreurLecture("FICHIER_TROP_GROS", `fichier de plus de ${TAILLE_MAX_OCTETS} octets`);
  const ext = extensionDe(nomFichier);
  let d: Detection;
  // Une archive contient des octets NUL par nature : ses octets ne passent pas par le controle de contenu texte (seule l'entree KML lue y passe).
  if (estZip(contenu)) d = detecterKmz(contenu, opts, lim, mode.inventaire === true);
  else {
    const refus = contenuRefuse(contenu, ext, true);
    if (refus) throw refus;
    const octet = premierOctetUtile(contenu);
    if (octet === -1) throw new ErreurLecture("FICHIER_VIDE", "le fichier ne contient que des blancs");
    const utf16 = (contenu[0] === 0xff && contenu[1] === 0xfe) || (contenu[0] === 0xfe && contenu[1] === 0xff);
    // Revue de la vague 1, m2 : un contenu UTF-16 (BOM) n'est pas forcement du XML ou du JSON ; son premier caractere utile, une fois decode,
    // decide (un tableau CSV enregistre en UTF-16 par un tableur est lu comme un CSV). Un contenu blanc reste traite par la branche texte (FICHIER_VIDE).
    const premierUtf16 = utf16 ? textePropre(decoderTexte(contenu)).trimStart()[0] : undefined;
    const texteStructure = utf16 ? premierUtf16 === undefined || premierUtf16 === "<" || premierUtf16 === "{" : octet === 0x3c /* < */ || octet === 0x7b /* { */;
    if (texteStructure) {
      const texte = textePropre(decoderTexte(contenu));
      const nettoye = texte.trimStart();
      if (nettoye === "") throw new ErreurLecture("FICHIER_VIDE", "le fichier ne contient que des blancs");
      if (REGEX_HTML.test(nettoye)) throw new ErreurLecture("CONTENU_NON_RECONNU", `contenu non reconnu (page HTML ou script) : deposez un fichier ${CHOIX_FORMATS}`);
      if (nettoye[0] === "<") {
        const racine = lireArbreKml(texte);
        if (racine.nom === "gpx") d = { format: "GPX", extensionDeclaree: ext || null, extensionCoherente: true, archive: null, entreeKml: null, racine, avertissements: [] };
        else {
          verifierRacineKml(racine);
          d = { format: "KML", extensionDeclaree: ext || null, extensionCoherente: true, archive: null, entreeKml: null, racine, avertissements: [] };
        }
      } else if (nettoye[0] === "{") {
        if (profondeurJson(texte) > PROFONDEUR_JSON_MAX) throw new ErreurLecture("JSON_TROP_PROFOND", `imbrication JSON de plus de ${PROFONDEUR_JSON_MAX} niveaux`);
        d = { format: "GEOJSON", extensionDeclaree: ext || null, extensionCoherente: true, archive: null, entreeKml: null, doc: lireDocumentGeoJson(texte), avertissements: [] };
      } else {
        throw new ErreurLecture("FORMAT_NON_SUPPORTE", `contenu non reconnu${ext ? ` (extension .${ext})` : ""} : seuls les formats ${CHOIX_FORMATS} sont pris en charge`);
      }
    } else {
      const csv = inspecterCsv(contenu, opts.csv ?? {}, lim.csv);
      if (!csv) throw new ErreurLecture("FORMAT_NON_SUPPORTE", `contenu non reconnu${ext ? ` (extension .${ext})` : ""} : seuls les formats ${CHOIX_FORMATS} sont pris en charge`);
      d = { format: "CSV", extensionDeclaree: ext || null, extensionCoherente: true, archive: null, entreeKml: null, csv, avertissements: [] };
    }
  }

  const attendu = EXTENSIONS_ATTENDUES[ext];
  if (attendu !== undefined && attendu !== d.format) {
    d.extensionCoherente = false;
    d.avertissements.push({ code: "EXTENSION_INCOHERENTE", message: `L'extension .${ext} annonce du ${attendu} mais le contenu est du ${d.format} : le contenu fait foi.` });
  }
  return d;
}

function detecterKmz(contenu: Buffer, opts: OptionsImport, lim: LimitesImport, inventaire: boolean): Detection {
  let racine: NoeudXml | undefined;
  let info: InfoArchive;
  const avertissements: Avertissement[] = [];
  try {
    const inv = inspecterZip(contenu, lim.zip);
    const vues: EntreeArchiveVue[] = inv.entrees.slice(0, ENTREES_VUES_MAX).map((e) => ({ nom: e.nom, tailleOctets: e.tailleOctets, type: typeEntree(e) }));
    const kml = inv.entrees.filter((e) => !e.dossier && extensionDe(e.nom) === "kml");
    info = { nbEntrees: inv.entrees.length, tailleDecompresseeOctets: inv.tailleTotaleOctets, kmlPrincipal: null, entreesKml: kml.map((e) => e.nom), choixRequis: false, entrees: vues };
    let choix;
    try {
      choix = choisirEntreeKml(inv.entrees, opts.entreeKml);
    } catch (e) {
      if (inventaire && e instanceof ErreurLecture && e.code === "KMZ_PLUSIEURS_KML") {
        info.choixRequis = true;
        return { format: "KMZ", extensionDeclaree: null, extensionCoherente: true, archive: info, entreeKml: null, avertissements };
      }
      throw e;
    }
    info.kmlPrincipal = choix.principal.nom;
    const donnees = extraireEntree(contenu, choix.principal);
    if (estZip(donnees)) throw new ErreurLecture("ARCHIVE_IMBRIQUEE", "l'entree KML principale est elle-meme une archive");
    const refus = contenuRefuse(donnees, "kml", true);
    if (refus) throw refus;
    const texte = textePropre(decoderTexte(donnees));
    if (texte.trim() === "") throw new ErreurLecture("FICHIER_VIDE", "l'entree KML principale est vide");
    if (REGEX_HTML.test(texte.trimStart())) throw new ErreurLecture("CONTENU_NON_RECONNU", "l'entree KML principale est une page HTML ou un script");
    racine = lireArbreKml(texte);
    verifierRacineKml(racine);
    const ignorees = inv.entrees.filter((e) => !e.dossier && e !== choix.principal).length;
    if (ignorees > 0) {
      avertissements.push({ code: "ENTREES_ARCHIVE_IGNOREES", message: "Entrees de l'archive non lues (seule l'entree KML principale est decompressee : images, autres KML, ressources).", nb: ignorees });
    }
  } catch (e) {
    if (e instanceof ErreurLecture) throw e;
    // Toute autre exception venue de la lecture binaire (depassement de tampon, etc.) est une archive illisible, jamais un 500.
    throw new ErreurLecture("ARCHIVE_INVALIDE", "archive illisible");
  }
  return { format: "KMZ", extensionDeclaree: null, extensionCoherente: true, archive: info, entreeKml: info.kmlPrincipal, racine, avertissements };
}

// ------------------------------------------------------------------------------------------------ Inventaire

export interface InfoCsvInventaire {
  delimiteur: string; delimiteurDetecte: boolean; encodage: string; encodageDetecte: boolean; bom: boolean;
  separateurDecimal: "." | "," | null; separateurDecimalDetecte: boolean; nbLignes: number;
  colonnes: { nom: string; exemples: string[] }[]; echantillon: string[][];
}

export interface InventaireFichier {
  format: FormatFichier;
  detection: { methode: "contenu"; extensionDeclaree: string | null; extensionCoherente: boolean };
  archive: InfoArchive | null;
  /** Les `COUCHES_REPONSE_MAX` premieres couches, dans l'ordre du fichier (revue de la vague 1, O6). */
  couches: { id: string; nom: string; nbObjets: number; parTypeGeom: { LIGNE: number; POINT: number; POLYGONE: number } }[];
  /** Nombre TOTAL de couches du fichier ; `couchesTronquees` : la liste ci-dessus n'est pas complete. */
  nbCouches: number;
  couchesTronquees: boolean;
  csv: InfoCsvInventaire | null;
  crs: { normeDuFormat: string | null; declareDansLeFichier: string | null; choixObligatoire: boolean };
  champsDisponibles: string[];
  suggestionsMapping: Record<string, string>;
  avertissements: Avertissement[];
}

const SUGGESTIONS: Record<string, readonly string[]> = {
  nom: ["nom", "name", "libelle", "libellé", "intitule", "intitulé", "designation", "désignation"],
  identifiant: ["id", "identifiant", "code", "ref", "reference", "référence"],
};

export function suggererMapping(colonnes: readonly string[]): Record<string, string> {
  const s: Record<string, string> = {};
  for (const [cible, noms] of Object.entries(SUGGESTIONS)) {
    const c = colonnes.find((x) => noms.includes(x.trim().toLowerCase()));
    if (c) s[cible] = c;
  }
  return s;
}

function parcourirCouches(d: Detection, puits: Puits): ResultatGpx | null {
  if (d.racine === undefined) return null;
  if (d.format === "GPX") return traverserGpx(d.racine, puits);
  traverserKml(d.racine, puits);
  return null;
}

function inventorierCouchesCsv(inv: InventaireCsv): InfoCsvInventaire {
  const sep = inv.separateurDecimalDetecte === "ambigu" ? null : inv.separateurDecimalDetecte;
  return {
    delimiteur: inv.delimiteur, delimiteurDetecte: inv.delimiteurDetecte, encodage: inv.encodage, encodageDetecte: inv.encodageDetecte, bom: inv.bom,
    separateurDecimal: sep, separateurDecimalDetecte: sep !== null, nbLignes: inv.nbLignes,
    colonnes: inv.colonnes.map((nom) => ({ nom, exemples: inv.exemples[nom] ?? [] })), echantillon: inv.echantillon,
  };
}

/** Inventaire d'un fichier detecte : AUCUNE coordonnee n'est controlee (un fichier hors Guinee s'inventorie). */
export function inventorier(d: Detection): InventaireFichier {
  const avertissements: Avertissement[] = [...d.avertissements];
  let couches: InventaireFichier["couches"] = [];
  let champs: string[] = [];
  let csv: InfoCsvInventaire | null = null;
  let declare: string | null = null;
  let choixObligatoire = false;

  if (d.format === "KML" || d.format === "KMZ" || d.format === "GPX") {
    if (d.racine !== undefined) {
      const inv = new Inventaire();
      const gpx = parcourirCouches(d, inv);
      couches = inv.liste().map(({ id, nom, nbObjets, parTypeGeom }) => ({ id, nom, nbObjets, parTypeGeom }));
      champs = [...inv.attributs].sort();
      if (gpx) avertissements.push(...gpx.avertissements);
    }
  } else if (d.format === "GEOJSON" && d.doc !== undefined) {
    const inv = new Inventaire();
    traverserGeoJson(d.doc, inv);
    couches = inv.liste().map(({ id, nom, nbObjets, parTypeGeom }) => ({ id, nom, nbObjets, parTypeGeom }));
    champs = [...inv.attributs].sort();
    try {
      const c = crsDeclareGeoJson(d.doc);
      declare = c ? (c.epsg !== null ? `EPSG:${c.epsg}` : c.nom) : null;
      choixObligatoire = c !== null && c.epsg !== null && c.epsg !== EPSG_CIBLE;
    } catch { declare = "illisible"; }
  } else if (d.format === "CSV" && d.csv !== undefined) {
    csv = inventorierCouchesCsv(d.csv);
    champs = [...d.csv.colonnes];
    choixObligatoire = true;
    if (d.csv.renommees > 0) avertissements.push({ code: "COLONNES_RENOMMEES", message: "Colonnes sans nom, en double ou trop longues renommees.", nb: d.csv.renommees });
  }
  const nbCouches = couches.length;
  if (couches.filter((c) => c.nbObjets > 0).length > 1) {
    avertissements.push({ code: "COUCHES_MULTIPLES", message: `Le fichier contient ${nbCouches} couches : sans choix (couche), toutes seraient importees.`, nb: nbCouches });
  }
  const couchesTronquees = nbCouches > COUCHES_REPONSE_MAX;
  if (couchesTronquees) {
    avertissements.push({ code: "COUCHES_TRONQUEES", message: `La liste des couches est limitee a ${COUCHES_REPONSE_MAX} sur ${nbCouches} : les suivantes se choisissent par leur identifiant (c${COUCHES_REPONSE_MAX}, c${COUCHES_REPONSE_MAX + 1}...).`, nb: nbCouches });
    couches = couches.slice(0, COUCHES_REPONSE_MAX);
  }
  return {
    format: d.format,
    detection: { methode: "contenu", extensionDeclaree: d.extensionDeclaree, extensionCoherente: d.extensionCoherente },
    archive: d.archive, couches, nbCouches, couchesTronquees, csv,
    crs: { normeDuFormat: d.format === "CSV" ? null : "EPSG:4326", declareDansLeFichier: declare, choixObligatoire },
    champsDisponibles: champs.slice(0, 500),
    suggestionsMapping: suggererMapping(champs),
    avertissements,
  };
}

// ------------------------------------------------------------------------------------------------ Lecture

export interface InfoCrsImport extends InfoCrs {
  epsgSource: number;
  epsgCible: number;
  uniteSource: string;
  uniteCible: string;
  origine: OrigineCrs;
  transformation: "ST_Transform" | "aucune";
  versionProj: string | null;
  plausibilite: Plausibilite;
}

export interface InfoImportLecture {
  couche: { id: string; nom: string } | null;
  entreeKml: string | null;
  csv: { delimiteur: string; encodage: string; separateurDecimal: string; mode: string; colonnes: ResultatCsv["colonnes"]; nbLignes: number; nbLignesRejetees: number } | null;
  mapping: Mapping;
  rejets: RejetCsv[];
  rejetsTronques: boolean;
}

/** Element ecarte, avec un message fixe (jamais de coordonnee recopiee). */
export interface ElementEcarteVue { element: number; nom: string | null; code: string; message: string }
const MESSAGES_ECARTES: Record<string, string> = {
  COORDONNEES_HORS_ZONE: "Coordonnees hors de l'emprise de la Guinee (ou hors de la plage des degres) : l'element est ecarte et jamais stocke.",
  GEOMETRIE_INVALIDE: "Geometrie inexploitable (ligne de moins de deux points, anneau degenere, coordonnee illisible) : l'element est ecarte.",
};

export interface ResultatImport {
  format: FormatFichier;
  /** Elements ecartes, 50 au plus (le nombre exact est dans les avertissements ELEMENTS_HORS_GUINEE et GEOMETRIES_INVALIDES_IGNOREES). */
  ecartes: ElementEcarteVue[];
  crs: InfoCrsImport;
  objets: ObjetLu[];
  avertissements: Avertissement[];
  resume: ResumeLecture;
  importInfo: InfoImportLecture;
  propositionsJeu: Partial<Record<ChampJeu, PropositionJeu>>;
  archive: InfoArchive | null;
  detection: { extensionDeclaree: string | null; extensionCoherente: boolean };
}

export interface Transformes { lon: ArrayLike<number>; lat: ArrayLike<number> }

export interface Preparation {
  format: FormatFichier;
  choixCrs: ChoixCrs;
  besoinTransformation: boolean;
  /** Coordonnees source a transformer par la base, si `besoinTransformation`. */
  sommets: SommetsBruts | null;
  terminer(meta: MetaCrs, versionProj: string | null, transformes?: Transformes): ResultatImport;
}

function justification(format: FormatFichier, choix: ChoixCrs, meta: MetaCrs): string {
  if (choix.transformer && choix.origine === "declare_dans_le_fichier") {
    return `CRS ${libelleCrs(meta)} declare par le fichier et confirme par l'utilisateur (liste blanche) : coordonnees en ${meta.unite} transformees en WGS 84 (EPSG:4326, degres) par PostGIS ST_Transform (PROJ), puis controlees contre l'emprise nationale.`;
  }
  if (choix.transformer) {
    return `CRS ${libelleCrs(meta)} choisi par l'utilisateur (liste blanche) : coordonnees en ${meta.unite} transformees en WGS 84 (EPSG:4326, degres) par PostGIS ST_Transform (PROJ), puis controlees contre l'emprise de la Guinee. Aucune transformation n'est faite sans ce choix.`;
  }
  if (choix.origine === "choisi_par_utilisateur") return "CRS EPSG:4326 (WGS 84) choisi par l'utilisateur pour ce fichier : coordonnees lues telles quelles, sans transformation.";
  if (format === "GPX") return "La norme GPX 1.1 impose WGS 84 (latitude et longitude en degres decimaux) : les coordonnees sont lues telles quelles, sans reprojection.";
  if (format === "GEOJSON") return CRS_GEOJSON.justification;
  return CRS_KML.justification;
}

/**
 * Lit le fichier. Pour un CRS projete, la lecture s'arrete a l'enregistrement des coordonnees source : `besoinTransformation` est vrai,
 * l'appelant les transforme (crs.service.ts) puis appelle `terminer`. Pour WGS 84, `terminer` ne demande aucune transformation.
 */
export function preparer(d: Detection, opts: OptionsImport, lim: LimitesImport): Preparation {
  const declare = d.format === "GEOJSON" && d.doc ? crsDeclareGeoJson(d.doc) : null;
  const choix = choisirCrs(d.format, opts.epsgSource, declare, lim.crsAutorises);

  // Couches : inventaire d'abord (la selection se fait par identifiant), puis lecture filtree.
  let couche: { id: string; nom: string } | null = null;
  let coucheCle: string | undefined;
  let nbCouches = 1;
  if (d.format === "KML" || d.format === "KMZ" || d.format === "GPX") {
    const inv = new Inventaire();
    parcourirCouches(d, inv);
    const liste = inv.liste();
    nbCouches = liste.filter((c) => c.nbObjets > 0).length;
    if (opts.couche !== undefined) {
      const c: CoucheInventoriee | undefined = liste.find((x) => x.id === opts.couche);
      if (!c) throw new ErreurLecture("COUCHE_INTROUVABLE", `la couche « ${opts.couche.slice(0, 40)} » n'existe pas dans ce fichier (couches : ${liste.map((x) => x.id).join(", ") || "aucune"})`);
      couche = { id: c.id, nom: c.nom };
      coucheCle = c.cle;
    }
  } else if (opts.couche !== undefined) {
    if (opts.couche !== "c0") throw new ErreurLecture("COUCHE_INTROUVABLE", `ce format n'a qu'une couche, « c0 » (demande : « ${opts.couche.slice(0, 40)} »)`);
    couche = { id: "c0", nom: d.format === "CSV" ? "Table CSV" : "(fichier entier)" };
  }

  const reel = new Collecteur(lim.lecture);
  const enr = choix.transformer ? new Enregistreur(reel, lim.lecture) : null;
  let sommetsBruts: SommetsBruts | null = null;
  const filtre = new PuitsFiltre(enr ?? reel, { couche: coucheCle, mapping: opts.mapping });

  let gpx: ResultatGpx | null = null;
  let csv: ResultatCsv | null = null;
  const mapping: Mapping = opts.mapping ?? {};
  if (d.format === "CSV") {
    // Colonnes du mapping : validees contre l'en-tete avant toute lecture.
    for (const col of Object.values(mapping)) {
      if (!d.csv!.colonnes.includes(col)) throw new ErreurLecture("MAPPING_COLONNE_INTROUVABLE", `la colonne « ${col.slice(0, 80)} » du mapping n'existe pas dans le fichier`);
    }
    csv = lireCsv(d.csv!, opts.csv ?? {}, lim.csv, filtre);
    if (choix.origine === "choisi_par_utilisateur" && !choix.transformer && csv.maxAbsCoordonnee > 180) {
      throw new ErreurLecture("CRS_INCOHERENT", `le CRS declare est geographique (EPSG:${choix.epsg}, degres) mais les coordonnees atteignent ${Math.round(csv.maxAbsCoordonnee)} : ce sont probablement des metres d'un CRS projete (par exemple EPSG:32629 pour l'UTM 29N). Aucun CRS n'est devine : choisissez le bon epsgSource`);
    }
  } else if (d.format === "GEOJSON") {
    traverserGeoJson(d.doc!, filtre);
  } else {
    gpx = parcourirCouches(d, filtre);
  }
  if (d.format !== "CSV") {
    for (const col of Object.values(mapping)) {
      if (!filtre.attributsVus.has(col)) throw new ErreurLecture("MAPPING_COLONNE_INTROUVABLE", `l'attribut « ${col.slice(0, 80)} » du mapping n'existe sur aucun objet de la couche`);
    }
  }

  if (enr) sommetsBruts = enr.sommets();

  return {
    format: d.format,
    choixCrs: choix,
    besoinTransformation: choix.transformer,
    sommets: sommetsBruts,
    terminer(meta, versionProj, transformes) {
      if (enr) {
        if (!transformes) throw new Error("coordonnees transformees manquantes");
        enr.rejouer(transformes.lon, transformes.lat, sommetsBruts!.invalide);
      }
      const res = reel.terminer();
      const avertissements: Avertissement[] = [...d.avertissements, ...res.avertissements];
      if (gpx) avertissements.push(...gpx.avertissements);
      if (csv) avertissements.push(...csv.avertissements);
      if (d.format !== "CSV" && opts.couche === undefined && nbCouches > 1) {
        avertissements.push({ code: "COUCHES_MULTIPLES", message: `Le fichier contient ${nbCouches} couches : toutes sont importees (choisissez une couche pour n'en importer qu'une).`, nb: nbCouches });
      }
      if (choix.origine === "choisi_par_utilisateur") {
        avertissements.push({ code: "CRS_CHOISI_PAR_UTILISATEUR", message: `Le CRS source (EPSG:${choix.epsg}) a ete choisi par l'utilisateur : il n'est pas verifie par le fichier.` });
      }
      const { propositions, avertissements: avMapping } = proposerChampsJeu(mapping, filtre.valeurs);
      avertissements.push(...avMapping);

      const nbHors = res.avertissements.find((a) => a.code === "ELEMENTS_HORS_GUINEE")?.nb ?? 0;
      // Un CRS projete confirme par l'utilisateur, declare ou non par le fichier, reste soumis a la confirmation hors zone.
      const confirmationApplicable = d.format === "CSV" || choix.origine === "choisi_par_utilisateur" || choix.origine === "declare_dans_le_fichier";
      const confirmationRequise = confirmationApplicable && nbHors > 0;
      if (confirmationRequise && !opts.confirmerHorsZone) {
        throw new ErreurMetier(409, "CONFIRMATION_HORS_ZONE_REQUISE",
          `${nbHors} element(s) tombent hors de l'emprise de la Guinee apres application du CRS EPSG:${choix.epsg} : verifiez le CRS choisi. Pour importer les autres elements en ecartant ceux-la, envoyez confirmerHorsZone=true.`,
          { nbElementsHorsZone: nbHors, nbObjets: res.resume.nbObjets });
      }
      const plausibilite: Plausibilite = {
        zoneAttendue: { nom: "Guinee", bbox: [...BBOX_GUINEE] as Bbox },
        empriseResultat: res.resume.bbox, nbElementsHorsZone: nbHors, nbObjets: res.resume.nbObjets,
        statut: nbHors > 0 ? "PARTIELLEMENT_HORS_ZONE" : "CONFORME", confirmationRequise, confirmee: confirmationRequise && opts.confirmerHorsZone === true,
      };
      const geo = choix.epsg === EPSG_CIBLE;
      const crs: InfoCrsImport = {
        source: geo ? "WGS84 (EPSG:4326)" : libelleCrs(meta),
        cible: "EPSG:4326",
        methode: libelleMethode(choix.transformer, versionProj),
        justification: justification(d.format, choix, meta),
        epsgSource: choix.epsg, epsgCible: EPSG_CIBLE, uniteSource: geo ? "degre" : meta.unite, uniteCible: "degre",
        origine: choix.origine, transformation: choix.transformer ? "ST_Transform" : "aucune", versionProj: choix.transformer ? versionProj : null,
        plausibilite,
      };
      return {
        format: d.format, crs, objets: res.objets, avertissements, resume: res.resume,
        ecartes: reel.ecartes.map((x) => ({ element: x.element, nom: x.nom, code: x.code, message: MESSAGES_ECARTES[x.code] })),
        importInfo: {
          couche, entreeKml: d.entreeKml,
          csv: csv ? {
            delimiteur: d.csv!.delimiteur, encodage: d.csv!.encodage, separateurDecimal: csv.separateurDecimal, mode: csv.mode, colonnes: csv.colonnes,
            nbLignes: csv.nbLignes, nbLignesRejetees: csv.nbLignesRejetees,
          } : null,
          mapping, rejets: csv?.rejets ?? [], rejetsTronques: csv?.rejetsTronques ?? false,
        },
        propositionsJeu: propositions, archive: d.archive,
        detection: { extensionDeclaree: d.extensionDeclaree, extensionCoherente: d.extensionCoherente },
      };
    },
  };
}

