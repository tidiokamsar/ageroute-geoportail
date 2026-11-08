/**
 * VALIDATION DE LA SORTIE DU CONTENEUR (lot B2). Sans E/S, sans base. LA SORTIE DU CONTENEUR EST NON FIABLE : un fichier de spool n'est lu qu'apres
 * validation STRICTE contre un schema, et tout ecart refuse le job en entier (jamais de sortie partielle acceptee).
 *
 *   - `statut.json` et `resultat.json` : schemas zod `.strict()` (une cle inconnue est un refus) ; les messages libres du conteneur ne sont jamais
 *     renvoyes (voir `contrat.noyau.ts`) ;
 *   - GeoJSON de couche : lu LIGNE A LIGNE (le conteneur ecrit une Feature par ligne, GDAL `RFC7946=NO`), chaque ligne bornee ; en-tete et pied de
 *     document en liste blanche ; chaque Feature validee contre un schema strict (cles, types de geometrie, profondeur des coordonnees, valeurs finies,
 *     sommets par objet et par fichier, attributs plats) ;
 *   - CRS EXPLICITE : un resultat `wgs84` exige le membre `crs` CRS84 du document, un resultat `brutes` n'en porte aucun ;
 *   - coherence : comptes declares, empreinte et taille du fichier source, format, identifiant du job.
 *
 * Contrat : docs/projets-voirie/CHAINE-GDAL.md section 4 et docs/projets-voirie/CONTRAT-IMPORT.md section 13.
 */

import { z } from "zod";
import type { FormatGdal } from "./contrat.noyau";

/** Refus de la sortie : `code` est un code de `ERREURS_JOB` (SORTIE_INVALIDE, SORTIE_INCOHERENTE, TROP_D_OBJETS, TROP_DE_SOMMETS...). */
export class ErreurSortie extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ErreurSortie";
  }
}

const invalide = (message: string) => new ErreurSortie("SORTIE_INVALIDE", message);
const incoherente = (message: string) => new ErreurSortie("SORTIE_INCOHERENTE", message);

// ------------------------------------------------------------------------------------------------ Schemas

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const entier = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const texteCourt = z.string().max(600);
const codeMajuscule = z.string().regex(/^[A-Z][A-Z0-9_]{2,60}$/);

export const SchemaStatut = z.object({
  jobId: z.string().max(80),
  statut: z.enum(["en_cours", "termine", "echec"]),
  etape: z.string().max(80).nullable(),
  code: codeMajuscule.nullable(),
  message: texteCourt.nullable(),
  debut: z.string().max(40),
  fin: z.string().max(40).nullable(),
  versionWorker: z.string().max(40),
  versionContrat: z.literal(1),
  nbCouches: entier.optional(),
  nbCouchesCibles: entier.optional(),
  couche: z.string().max(200).optional(),
}).strict();
export type StatutWorker = z.infer<typeof SchemaStatut>;

const SchemaAvertissementWorker = z.object({
  code: codeMajuscule,
  message: texteCourt,
  nb: entier.optional(),
  declare: entier.optional(),
  lus: entier.optional(),
}).strict();

const SchemaCoucheResultat = z.object({
  nom: z.string().max(300),
  fichier: z.string().max(100),
  octets: entier,
  nbObjets: entier,
  typesGeometrieReels: z.record(z.string().max(40), entier),
  sommets: entier.optional(),
  emprise: z.array(z.number().finite()).length(4).nullable().optional(),
  crs: z.object({ epsg: z.literal(4326), nom: z.string().max(80) }).strict().nullable(),
  reprojete: z.boolean(),
  crsSource: z.object({ origine: z.enum(["fichier", "demande"]), epsg: z.number().int().min(1).max(999999).nullable(), nom: z.string().max(200).nullable() }).strict().nullable(),
  coordonnees: z.enum(["wgs84", "brutes"]),
  avertissements: z.array(z.string().max(80)).max(100),
}).strict();

export const SchemaDxf = z.object({
  version: z.string().max(40).nullable(),
  codepage: z.string().max(40).nullable(),
  entitesSupportees: z.array(z.string().max(30)).max(10),
  lues: z.record(z.string().max(40), entier),
  ignorees: z.record(z.string().max(40), entier),
  blocs: z.object({ definitions: entier, entitesDansBlocs: entier }).strict(),
  calques: z.array(z.object({ nom: z.string().max(300), lues: entier, ignorees: entier }).strict()).max(1000),
  nbEntitesTotal: entier,
}).strict();
export type InventaireDxf = z.infer<typeof SchemaDxf>;

export const SchemaResultat = z.object({
  versionContrat: z.literal(1),
  jobId: z.string().max(80),
  statut: z.enum(["termine", "echec"]),
  code: codeMajuscule.nullable(),
  message: texteCourt.nullable(),
  details: z.record(z.string().max(80), z.unknown()),
  source: z.object({ nom: z.string().max(100), octets: entier, sha256 }).strict().nullable(),
  format: z.object({
    famille: z.enum(["GPKG", "ZIP", "DXF"]), pilote: z.string().max(40), detection: z.literal("contenu"),
    extensionDeclaree: z.string().max(20), extensionCoherente: z.boolean(),
  }).strict().nullable(),
  dxf: SchemaDxf.nullable(),
  couches: z.array(SchemaCoucheResultat).max(50),
  avertissements: z.array(SchemaAvertissementWorker).max(200),
  limitesAppliquees: z.record(z.string().max(80), z.number()),
  mesures: z.object({ dureeMs: entier, etapes: z.array(z.record(z.string().max(80), z.union([z.string().max(100), z.number()]))).max(200), picMemoireWorkerKo: entier }).strict(),
  gdal: z.object({ version: z.string().max(40), proj: z.string().max(40).nullable(), pilotesActifs: z.array(z.string().max(40)).max(20) }).strict(),
}).strict();
export type ResultatWorker = z.infer<typeof SchemaResultat>;
export type CoucheResultat = z.infer<typeof SchemaCoucheResultat>;

/** Analyse un JSON deja decode : refuse tout ce qui ne respecte pas le schema, sans citer de valeur du fichier. */
export function validerStatut(brut: unknown): StatutWorker {
  const r = SchemaStatut.safeParse(brut);
  if (!r.success) throw invalide("statut.json hors contrat");
  return r.data;
}

export function validerResultat(brut: unknown): ResultatWorker {
  const r = SchemaResultat.safeParse(brut);
  if (!r.success) throw invalide("resultat.json hors contrat");
  return r.data;
}

/** Nom de fichier GeoJSON d'une couche : le conteneur nomme `couches/<slug>.geojson`, slug ASCII ; tout autre chemin est refuse (jamais lu). */
const RE_FICHIER_COUCHE = /^couches\/([a-z0-9][a-z0-9_-]{0,63})\.geojson$/;
export function slugDeFichier(fichier: string): string {
  const m = RE_FICHIER_COUCHE.exec(fichier);
  if (!m) throw invalide("chemin de couche hors contrat");
  return m[1];
}

export interface AttendusJob {
  /** Identifiant du dossier du spool de la tentative. */
  spoolId: string;
  format: FormatGdal;
  sha256: string;
  tailleOctets: number;
  objetsMax: number;
  sortieOctetsMax: number;
}

const FAMILLE_DE_FORMAT: Record<FormatGdal, "GPKG" | "ZIP" | "DXF"> = { GPKG: "GPKG", SHAPEFILE: "ZIP", DXF: "DXF" };

/**
 * Controle de coherence d'un resultat `termine` avec ce que le backend a envoye : le conteneur doit avoir traite CE fichier (empreinte et taille),
 * dans le bon format, sous les plafonds demandes, avec des couches nommees de façon unique et un CRS explicite.
 */
export function controlerResultat(r: ResultatWorker, a: AttendusJob): void {
  if (r.statut !== "termine") throw incoherente("resultat.json n'est pas termine");
  if (r.jobId !== a.spoolId) throw incoherente("le resultat porte un autre identifiant de job");
  if (r.source === null || r.source.sha256 !== a.sha256 || r.source.octets !== a.tailleOctets) {
    throw incoherente("le conteneur n'a pas traite le fichier depose (empreinte ou taille differente)");
  }
  if (r.format === null || r.format.famille !== FAMILLE_DE_FORMAT[a.format]) throw incoherente("le format detecte par le conteneur differe du format attendu");
  if (a.format === "DXF" ? r.dxf === null : r.dxf !== null) throw incoherente("inventaire DXF absent ou inattendu");
  if (r.couches.length === 0) throw incoherente("aucune couche dans un resultat termine");
  const slugs = new Set<string>();
  let total = 0;
  let octets = 0;
  for (const c of r.couches) {
    const slug = slugDeFichier(c.fichier);
    if (slugs.has(slug)) throw invalide("deux couches portent le meme fichier");
    slugs.add(slug);
    total += c.nbObjets;
    octets += c.octets;
    // CRS explicite : coordonnees WGS 84 avec un CRS de sortie, ou coordonnees brutes sans CRS, jamais un melange.
    if ((c.coordonnees === "wgs84") !== (c.crs !== null)) throw incoherente("CRS de sortie incoherent avec le type de coordonnees");
    if (c.coordonnees === "brutes" && c.reprojete) throw incoherente("coordonnees brutes declarees reprojetees");
    if (c.coordonnees === "wgs84" && c.crsSource === null) throw incoherente("coordonnees WGS 84 sans CRS source explicite");
  }
  if (total > a.objetsMax) throw new ErreurSortie("TROP_D_OBJETS", "plus d'objets que le plafond demande");
  if (octets > a.sortieOctetsMax) throw new ErreurSortie("SORTIE_TROP_GROSSE", "sortie plus grosse que le plafond demande");
}

// ------------------------------------------------------------------------------------------------ GeoJSON de couche

export type Pos = [number, number];
export type GeometrieSortie =
  | { type: "Point"; coordinates: Pos }
  | { type: "MultiPoint"; coordinates: Pos[] }
  | { type: "LineString"; coordinates: Pos[] }
  | { type: "MultiLineString"; coordinates: Pos[][] }
  | { type: "Polygon"; coordinates: Pos[][] }
  | { type: "MultiPolygon"; coordinates: Pos[][][] }
  | { type: "GeometryCollection"; geometries: GeometrieSortie[] };

export interface FeatureValide {
  properties: Record<string, string | number | boolean | null>;
  geometry: GeometrieSortie | null;
  /** Valeur de la propriete de regroupement (calque DXF), si demandee. */
  groupe?: string;
}

export interface LimitesCouche {
  sommetsParObjet: number;
  sommetsParFichier: number;
  objetsMax: number;
  /** Longueur maximale d'une ligne du fichier (une Feature). */
  ligneMax: number;
  /** Nombre de proprietes maximal d'une Feature. */
  proprietesMax: number;
}

export const LIMITES_COUCHE_DEFAUT: Pick<LimitesCouche, "ligneMax" | "proprietesMax"> = { ligneMax: 8 * 1024 * 1024, proprietesMax: 500 };

export interface OptionsCouche {
  limites: LimitesCouche;
  /** `wgs84` : le document porte le membre `crs` CRS84 ; `brutes` : il n'en porte aucun. */
  coordonnees: "wgs84" | "brutes";
  /** Nombre d'objets annonce par `resultat.json` : un ecart refuse la couche. */
  nbObjetsDeclare?: number;
  /** Garder les Features en memoire (lecture pour l'apercu et le depot) ; sinon seulement les comptes (inventaire du job). */
  retenir: boolean;
  /** Propriete a regrouper (calque DXF : `Layer`). */
  grouperPar?: string;
  /** Plafond de groupes distincts. */
  groupesMax?: number;
}

export interface GroupeCouche { nb: number; parFamille: { LIGNE: number; POINT: number; POLYGONE: number } }

export interface CoucheValidee {
  nb: number;
  sansGeometrie: number;
  /** Types GeoJSON reels rencontres (compte par type). */
  typesReels: Record<string, number>;
  parFamille: { LIGNE: number; POINT: number; POLYGONE: number };
  sommets: number;
  /** [ouest, sud, est, nord] ou null. */
  emprise: [number, number, number, number] | null;
  attributs: string[];
  groupes: Map<string, GroupeCouche> | null;
  features: FeatureValide[] | null;
  /** Nombre de valeurs d'attribut tronquees ou serialisees (information, jamais un refus). */
  attributsAdaptes: number;
}

const COORD_MAX = 1e9;
const TEXTE_ATTRIBUT_MAX = 10_000;
const COMPLEXE_MAX = 2_000;
const CLE_MAX = 128;
// eslint-disable-next-line no-control-regex
const RE_CONTROLE = /[\u0000-\u001f\u007f-\u009f]/g;
const RE_CRS84 = /^(urn:ogc:def:crs:OGC:1\.3:CRS84|urn:ogc:def:crs:EPSG::4326|CRS84)$/;
const RE_RESOLUTION = /^"(xy|z)_coordinate_resolution": [0-9.eE+-]{1,30},?$/;

const estObjet = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function famille(type: string): "LIGNE" | "POINT" | "POLYGONE" | null {
  switch (type) {
    case "Point": case "MultiPoint": return "POINT";
    case "LineString": case "MultiLineString": return "LIGNE";
    case "Polygon": case "MultiPolygon": return "POLYGONE";
    default: return null;
  }
}

/**
 * Validateur POUSSE ligne par ligne (le lecteur de fichier alimente `ligne`, puis appelle `terminer`). Ainsi la meme logique sert un fichier lu en flux
 * et un texte de test.
 */
export class ValidateurCouche {
  private etat: "debut" | "entete" | "objets" | "pied" | "fin" = "debut";
  private nb = 0;
  private sansGeometrie = 0;
  private sommets = 0;
  private crsVu = false;
  private readonly types: Record<string, number> = {};
  private readonly parFamille = { LIGNE: 0, POINT: 0, POLYGONE: 0 };
  private readonly bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  private readonly attributs = new Set<string>();
  private readonly groupes: Map<string, GroupeCouche> | null;
  private readonly features: FeatureValide[] | null;
  private adaptes = 0;

  constructor(private readonly o: OptionsCouche) {
    this.groupes = o.grouperPar !== undefined ? new Map() : null;
    this.features = o.retenir ? [] : null;
  }

  ligne(brut: string): void {
    const l = brut.endsWith("\r") ? brut.slice(0, -1) : brut;
    if (l.length > this.o.limites.ligneMax) throw invalide("ligne de GeoJSON trop longue");
    switch (this.etat) {
      case "debut":
        if (l !== "{") throw invalide("document GeoJSON mal forme (debut)");
        this.etat = "entete";
        return;
      case "entete": this.entete(l); return;
      case "objets":
        if (l === "]") { this.etat = "pied"; return; }
        this.objet(l);
        return;
      case "pied":
        if (l === "}") { this.etat = "fin"; return; }
        throw invalide("document GeoJSON mal forme (pied)");
      case "fin":
        if (l.trim() === "") return;
        throw invalide("contenu apres la fin du document GeoJSON");
    }
  }

  private entete(l: string): void {
    if (l === '"type": "FeatureCollection",') return;
    if (l === '"features": [') { this.etat = "objets"; return; }
    if (RE_RESOLUTION.test(l)) return;
    const crs = /^"crs": \{ "type": "name", "properties": \{ "name": "([^"\\]{1,100})" \} \},$/.exec(l);
    if (crs) {
      if (!RE_CRS84.test(crs[1])) throw new ErreurSortie("SORTIE_INCOHERENTE", "CRS du document GeoJSON different de WGS 84");
      this.crsVu = true;
      return;
    }
    throw invalide("en-tete GeoJSON inattendu");
  }

  private objet(l: string): void {
    if (!l.startsWith('{"type":"Feature"')) throw invalide("ligne inattendue parmi les objets GeoJSON");
    if (this.nb >= this.o.limites.objetsMax) throw new ErreurSortie("TROP_D_OBJETS", "plus d'objets que le plafond");
    const texte = l.endsWith(",") ? l.slice(0, -1) : l;
    let f: unknown;
    try { f = JSON.parse(texte); } catch { throw invalide("objet GeoJSON illisible"); }
    this.nb++;
    this.feature(f);
  }

  private feature(f: unknown): void {
    if (!estObjet(f) || f.type !== "Feature") throw invalide("objet qui n'est pas une Feature");
    for (const k of Object.keys(f)) if (k !== "type" && k !== "properties" && k !== "geometry" && k !== "id") throw invalide("cle inattendue dans une Feature");
    const props = this.proprietes(f.properties);
    let geometrie: GeometrieSortie | null = null;
    if (f.geometry === null || f.geometry === undefined) this.sansGeometrie++;
    else geometrie = this.geometrie(f.geometry, 0);

    // comptes
    if (geometrie) {
      this.types[geometrie.type] = (this.types[geometrie.type] ?? 0) + 1;
      for (const fam of this.famillesDe(geometrie)) this.parFamille[fam]++;
    } else this.types.null = (this.types.null ?? 0) + 1;

    let groupe: string | undefined;
    if (this.groupes) {
      const v = this.o.grouperPar !== undefined ? props[this.o.grouperPar] : undefined;
      groupe = typeof v === "string" && v !== "" ? v.slice(0, 300) : "(sans calque)";
      let g = this.groupes.get(groupe);
      if (!g) {
        if (this.groupes.size >= (this.o.groupesMax ?? 1000)) throw invalide("trop de groupes (calques) distincts");
        g = { nb: 0, parFamille: { LIGNE: 0, POINT: 0, POLYGONE: 0 } };
        this.groupes.set(groupe, g);
      }
      g.nb++;
      if (geometrie) for (const fam of this.famillesDe(geometrie)) g.parFamille[fam]++;
    }
    if (this.features) this.features.push({ properties: props, geometry: geometrie, ...(groupe !== undefined ? { groupe } : {}) });
  }

  private famillesDe(g: GeometrieSortie): Set<"LIGNE" | "POINT" | "POLYGONE"> {
    const s = new Set<"LIGNE" | "POINT" | "POLYGONE">();
    if (g.type === "GeometryCollection") { for (const x of g.geometries) for (const fam of this.famillesDe(x)) s.add(fam); } else {
      const fam = famille(g.type);
      if (fam) s.add(fam);
    }
    return s;
  }

  private proprietes(p: unknown): Record<string, string | number | boolean | null> {
    const sortie: Record<string, string | number | boolean | null> = {};
    if (p === null || p === undefined) return sortie;
    if (!estObjet(p)) throw invalide("proprietes qui ne sont pas un objet");
    const cles = Object.keys(p);
    if (cles.length > this.o.limites.proprietesMax) throw invalide("trop de proprietes dans une Feature");
    for (const cle of cles) {
      if (cle === "__proto__") { this.adaptes++; continue; }
      const k = cle.replace(RE_CONTROLE, "?").slice(0, CLE_MAX);
      if (k === "") { this.adaptes++; continue; }
      const v = p[cle];
      let val: string | number | boolean | null;
      if (v === null || typeof v === "boolean") val = v;
      else if (typeof v === "number") { if (!Number.isFinite(v)) throw invalide("valeur numerique non finie"); val = v; }
      else if (typeof v === "string") {
        if (v.length > TEXTE_ATTRIBUT_MAX) { val = v.slice(0, TEXTE_ATTRIBUT_MAX); this.adaptes++; } else val = v;
      } else {
        // Liste ou objet (champ JSON, liste de chaines) : serialise en texte borne, jamais conserve comme structure.
        let s = "";
        try { s = JSON.stringify(v) ?? ""; } catch { s = ""; }
        val = s.length > COMPLEXE_MAX ? s.slice(0, COMPLEXE_MAX) : s;
        this.adaptes++;
      }
      sortie[k] = val;
      if (this.attributs.size < 500) this.attributs.add(k);
    }
    return sortie;
  }

  private position(p: unknown): Pos {
    if (!Array.isArray(p) || (p.length !== 2 && p.length !== 3)) throw invalide("position de longueur incorrecte");
    const x = p[0], y = p[1];
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > COORD_MAX || Math.abs(y) > COORD_MAX) {
      throw invalide("coordonnee non finie ou aberrante");
    }
    if (p.length === 3 && (typeof p[2] !== "number" || !Number.isFinite(p[2]))) throw invalide("altitude non finie");
    this.sommets++;
    if (this.sommets > this.o.limites.sommetsParFichier) throw new ErreurSortie("TROP_DE_SOMMETS", "plus de sommets que le plafond du fichier");
    const b = this.bbox;
    if (x < b[0]) b[0] = x;
    if (y < b[1]) b[1] = y;
    if (x > b[2]) b[2] = x;
    if (y > b[3]) b[3] = y;
    return [x, y];
  }

  private suite(c: unknown, profondeur: number, compte: { n: number }): unknown {
    if (!Array.isArray(c)) throw invalide("coordonnees qui ne sont pas un tableau");
    if (profondeur === 0) { compte.n++; return this.position(c); }
    return c.map((x) => this.suite(x, profondeur - 1, compte));
  }

  private geometrie(g: unknown, niveau: number): GeometrieSortie {
    if (!estObjet(g) || typeof g.type !== "string") throw invalide("geometrie illisible");
    for (const k of Object.keys(g)) if (k !== "type" && k !== "coordinates" && k !== "geometries") throw invalide("cle inattendue dans une geometrie");
    const avant = this.sommets;
    let sortie: GeometrieSortie;
    const prof: Record<string, number> = { Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3 };
    if (g.type === "GeometryCollection") {
      if (niveau >= 2 || !Array.isArray(g.geometries) || g.geometries.length > 1000) throw invalide("collection de geometries hors contrat");
      sortie = { type: "GeometryCollection", geometries: g.geometries.map((x) => this.geometrie(x, niveau + 1)) };
    } else if (Object.prototype.hasOwnProperty.call(prof, g.type)) {
      if (g.geometries !== undefined) throw invalide("membre geometries sur une geometrie simple");
      sortie = { type: g.type, coordinates: this.suite(g.coordinates, prof[g.type], { n: 0 }) } as GeometrieSortie;
    } else throw invalide("type de geometrie hors contrat");
    if (this.sommets - avant > this.o.limites.sommetsParObjet) throw new ErreurSortie("TROP_DE_SOMMETS", "un objet depasse le plafond de sommets");
    return sortie;
  }

  terminer(): CoucheValidee {
    if (this.etat !== "fin") throw invalide("document GeoJSON incomplet ou tronque");
    if (this.o.coordonnees === "wgs84" && !this.crsVu) throw new ErreurSortie("SORTIE_INCOHERENTE", "CRS absent du document GeoJSON alors que le resultat annonce WGS 84");
    if (this.o.coordonnees === "brutes" && this.crsVu) throw new ErreurSortie("SORTIE_INCOHERENTE", "CRS present dans un document annonce comme coordonnees brutes");
    if (this.o.nbObjetsDeclare !== undefined && this.o.nbObjetsDeclare !== this.nb) {
      throw incoherente(`${this.nb} objet(s) lu(s) pour ${this.o.nbObjetsDeclare} declare(s)`);
    }
    const b = this.bbox;
    return {
      nb: this.nb, sansGeometrie: this.sansGeometrie, typesReels: this.types, parFamille: this.parFamille, sommets: this.sommets,
      emprise: Number.isFinite(b[0]) ? [b[0], b[1], b[2], b[3]] : null,
      attributs: [...this.attributs].sort(), groupes: this.groupes, features: this.features, attributsAdaptes: this.adaptes,
    };
  }
}

/** Valide un texte complet (tests, petits fichiers) en le decoupant en lignes. */
export function validerCoucheTexte(texte: string, o: OptionsCouche): CoucheValidee {
  const v = new ValidateurCouche(o);
  for (const l of texte.split("\n")) v.ligne(l);
  return v.terminer();
}

// ------------------------------------------------------------------------------------------------ DXF : unites et coherence

/**
 * Unites declarees par l'utilisateur contre l'en-tete du DXF et contre le CRS choisi. AUCUNE mise a l'echelle n'est faite : un dessin dont les unites
 * ne sont pas celles du CRS est refuse (conflit), jamais converti en silence.
 *   - `metre`  : compatible avec un CRS en metres ; l'en-tete doit etre absent, 0 (sans unite) ou 6 (metres) ;
 *   - `degre`  : compatible avec un CRS geographique (EPSG:4326) ; l'en-tete doit etre absent ou 0 (le DXF n'a pas d'unite angulaire).
 */
/** Unite declaree contre l'unite du CRS choisi (`metre` pour un CRS projete en metres, `degre` pour EPSG:4326). Aucune mise a l'echelle. */
export function controlerUniteContreCrs(unite: "metre" | "degre", uniteCrs: string): void {
  if ((unite === "metre") !== (uniteCrs === "metre")) throw new ErreurSortie("DXF_UNITES_CONFLIT", "unites declarees incompatibles avec l'unite du CRS choisi");
}

export function controlerUnitesDxf(unite: "metre" | "degre", insunits: number | null, uniteCrs: string): void {
  controlerUniteContreCrs(unite, uniteCrs);
  if (insunits === null || insunits === 0) return;
  if (unite === "metre" && insunits === 6) return;
  throw new ErreurSortie("DXF_UNITES_CONFLIT", "unites declarees differentes de l'en-tete du DXF");
}

/** Code de l'API pour une erreur de validation : un code de `ERREURS_JOB` (SORTIE_INVALIDE, SORTIE_INCOHERENTE, TROP_D_OBJETS, TROP_DE_SOMMETS, DXF_UNITES_CONFLIT...). */
export const codeDeErreurSortie = (e: unknown): string => (e instanceof ErreurSortie ? e.code : "SORTIE_INVALIDE");
