/**
 * Collecteur commun aux lecteurs KML et GeoJSON : valide les coordonnees, retire l'altitude, applique les limites du
 * contrat (emprise de la Guinee, nombre d'objets), nettoie les lignes et les anneaux, detecte les trace en double, tient les
 * compteurs d'avertissements et calcule le resume. Sans E/S, sans base.
 *
 * REGLE DES REFUS (contrat, section 4) :
 *   - un element hors de la Guinee ou invalide est ECARTE et compte dans un avertissement type ;
 *   - si plus aucun objet ne subsiste, le fichier est REFUSE : FICHIER_VIDE (rien a lire), HORS_GUINEE (tout ce qui a ete
 *     lu est hors du pays : cause habituelle, latitude et longitude inversees), sinon GEOMETRIE_INVALIDE ;
 *   - plus de 50 000 objets : TROP_D_OBJETS, des que la limite est depassee (la lecture s'arrete).
 *
 * Les geometries valides au sens de la lecture (assez de points, anneaux fermes) peuvent encore etre invalides au sens
 * de PostGIS (anneau qui se croise) : elles sont reparees a l'enregistrement (`ST_MakeValid`), avec un avertissement.
 */

import { createHash } from "node:crypto";
import {
  BBOX_GUINEE, ErreurLecture, OBJETS_MAX, SOMMETS_PAR_FICHIER_MAX, SOMMETS_PAR_OBJET_MAX,
  type Avertissement, type Bbox, type CodeAvertissement, type GeometrieLue, type LimitesLecture, type ObjetLu, type Pos, type ResumeLecture, type TypeGeom,
} from "./lecture.types";

/** Coordonnee brute telle que lue : longitude, latitude, altitude facultative ; peut etre NaN. */
export type Brut = readonly number[];

export interface FormesBrutes {
  points: Brut[];
  lignes: Brut[][];
  polygones: Brut[][][];
}

type Motif = "invalide" | "dehors";
interface EtatMembre { alt: boolean; repetes: boolean; fermes: number }

export const formesVides = (): FormesBrutes => ({ points: [], lignes: [], polygones: [] });

const PRECISION = 1e7;
const arrondi = (v: number) => Math.round(v * PRECISION) / PRECISION;

/** `String.prototype.toWellFormed` (Node 20+), absent de la bibliotheque de types ES2022. */
const bienForme = (s: string): string => (s as unknown as { toWellFormed(): string }).toWellFormed();

/** Retire les caracteres NUL (refuses par jsonb) de toute chaine d'une valeur d'attribut. */
export function nettoyerValeur(v: unknown, profondeur = 0): unknown {
  // NUL et substituts isoles sont refuses par jsonb : on retire les premiers et on remplace les seconds.
  if (typeof v === "string") return bienForme(v.includes("\u0000") ? v.replace(/\u0000/g, "") : v);
  if (profondeur > 16) return null;
  if (Array.isArray(v)) return v.map((x) => nettoyerValeur(x, profondeur + 1));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k.replace(/\u0000/g, ""), nettoyerValeur(x, profondeur + 1)]));
  }
  return v;
}

/**
 * Empreinte d'un objet pour le DELTA de versions : SHA-1 du type, de la geometrie NORMALISEE (coordonnees arrondies au
 * centimetre environ par la lecture ; une ligne se lit dans l'un ou l'autre sens) et du nom. Information seulement.
 */
export function empreinteDe(typeGeom: TypeGeom, g: GeometrieLue, nom: string | null, canon: string = chaineCanonique(g)): string {
  return createHash("sha1").update(`${typeGeom}|${g.type}|${canon}#${nom ?? ""}`).digest("hex");
}

/**
 * Ecriture CANONIQUE des coordonnees d'une geometrie : une ligne s'ecrit toujours de son extremite la plus petite (longitude, puis
 * latitude) a la plus grande, donc dans le meme sens quel que soit celui du fichier. Une seule serialisation par objet (le cout
 * de la lecture d'un fichier de 50 000 objets en depend), partagee par la detection des doublons et l'empreinte.
 */
export function chaineCanonique(g: GeometrieLue): string {
  if (g.type === "LineString") {
    const c = g.coordinates;
    const a = c[0], z = c[c.length - 1];
    const cmp = a[0] - z[0] || a[1] - z[1];
    if (cmp > 0) return JSON.stringify(c.slice().reverse());
    if (cmp === 0) {
      // Ligne fermee : les deux sens commencent au meme point, on retient la plus petite des deux ecritures.
      const avant = JSON.stringify(c), arriere = JSON.stringify(c.slice().reverse());
      return arriere < avant ? arriere : avant;
    }
  }
  return JSON.stringify(g.coordinates);
}

/**
 * Nettoie EN PLACE les attributs d'un objet (l'objet appartient au lecteur) : pas de copie par objet sur un fichier de 50 000.
 * Une valeur ou une cle modifiee est posee par `defineProperty` : une cle `__proto__` d'un fichier reste une donnee, jamais le prototype.
 */
function nettoyerAttributs(o: Record<string, unknown>): Record<string, unknown> {
  const poser = (k: string, v: unknown) => Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
  for (const k of Object.keys(o)) {
    const v = o[k];
    const w = typeof v === "string" ? nettoyerValeur(v) : v && typeof v === "object" ? nettoyerValeur(v, 1) : v;
    if (k.includes("\u0000")) {
      delete o[k];
      poser(k.replace(/\u0000/g, ""), w);
    } else if (w !== v) poser(k, w);
  }
  return o;
}

/** Element ecarte (hors de la Guinee ou geometrie inexploitable) : rapport BORNE a 50 elements, le nombre exact est dans les avertissements. */
export interface ElementEcarte {
  /** Numero de l'element dans le fichier (1 = premier Placemark, Feature, point de passage ou ligne lue). */
  element: number;
  nom: string | null;
  code: "COORDONNEES_HORS_ZONE" | "GEOMETRIE_INVALIDE";
}
export const ECARTES_MAX = 50;

export class Collecteur {
  readonly objets: ObjetLu[] = [];
  /** Elements ecartes, du premier au cinquantieme (voir ElementEcarte). */
  readonly ecartes: ElementEcarte[] = [];
  private readonly c: Record<CodeAvertissement, number> = {
    ALTITUDE_IGNOREE: 0, ELEMENTS_HORS_GUINEE: 0, GEOMETRIES_INVALIDES_IGNOREES: 0, ANNEAUX_FERMES: 0, ELEMENTS_KML_IGNORES: 0,
    OBJETS_SANS_GEOMETRIE: 0, POINTS_REPETES_RETIRES: 0, TRACES_DOUBLES: 0, OBJETS_SANS_NOM: 0, GEOMETRIES_REPAREES: 0,
    GEOMETRIES_VIDES_IGNOREES: 0, TRACES_SUPERPOSES: 0,
  };
  private readonly ignores = new Map<string, number>();
  private readonly vus = new Set<string>();
  private readonly attributs = new Map<string, number>();
  private readonly parType: Record<TypeGeom, number> = { LIGNE: 0, POINT: 0, POLYGONE: 0 };
  private ouest = Infinity; private sud = Infinity; private est = -Infinity; private nord = -Infinity;
  /** Elements lus (valides ou non) : distingue un fichier vide d'un fichier dont tout est ecarte. */
  private lus = 0;
  private sommetsFichier = 0;
  private readonly sommetsObjetMax: number;
  private readonly sommetsFichierMax: number;

  constructor(limites: LimitesLecture = {}) {
    this.sommetsObjetMax = limites.sommetsParObjet ?? SOMMETS_PAR_OBJET_MAX;
    this.sommetsFichierMax = limites.sommetsParFichier ?? SOMMETS_PAR_FICHIER_MAX;
  }

  compter(code: CodeAvertissement, n = 1): void { this.c[code] += n; }

  elementIgnore(nom: string): void {
    this.c.ELEMENTS_KML_IGNORES += 1;
    this.ignores.set(nom, (this.ignores.get(nom) ?? 0) + 1);
  }

  /** Un Placemark ou une Feature lu, qu'il porte une geometrie exploitable ou non. */
  elementLu(): void { this.lus += 1; }

  private position(b: Brut, etat: EtatMembre): Pos | Motif {
    const lon = b[0], lat = b[1];
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) return "invalide";
    if (b.length > 2 && Number.isFinite(b[2]) && b[2] !== 0) etat.alt = true;
    const [w, s, e, n] = BBOX_GUINEE;
    if (lon < w || lon > e || lat < s || lat > n) return "dehors";
    // Le tuple lu appartient au collecteur : il est arrondi et tronque EN PLACE (pas de second tableau par sommet).
    const m = b as number[];
    m[0] = arrondi(lon);
    m[1] = arrondi(lat);
    if (m.length > 2) m.length = 2;
    return m as unknown as Pos;
  }

  private ligne(brut: Brut[], etat: EtatMembre): Pos[] | Motif {
    const sortie: Pos[] = [];
    let dehors = false;
    for (const b of brut) {
      const p = this.position(b, etat);
      if (p === "invalide") return "invalide";
      if (p === "dehors") { dehors = true; continue; }
      const prec = sortie[sortie.length - 1];
      if (prec && prec[0] === p[0] && prec[1] === p[1]) { etat.repetes = true; continue; }
      sortie.push(p);
    }
    if (dehors) return "dehors";
    return sortie.length < 2 ? "invalide" : sortie;
  }

  private anneau(brut: Brut[], etat: EtatMembre): Pos[] | Motif {
    const r = this.ligne(brut, etat);
    if (typeof r === "string") return r;
    const a = r[0], z = r[r.length - 1];
    if (a[0] !== z[0] || a[1] !== z[1]) { r.push([a[0], a[1]]); etat.fermes += 1; }
    return r.length < 4 ? "invalide" : r;
  }

  /**
   * Ajoute les objets d'un Placemark ou d'une Feature : un objet par famille de geometrie (points, lignes, polygones).
   * `nom` et `attributs` sont communs aux objets issus du meme element.
   */
  ajouter(nom: string | null, attributs: Record<string, unknown>, formes: FormesBrutes, _couche?: string, numero?: number): void {
    // Plafond de sommets, compte sur la matiere BRUTE (avant tout traitement) : refus avant de construire quoi que ce soit de gros.
    let sommets = formes.points.length;
    for (const l of formes.lignes) sommets += l.length;
    for (const p of formes.polygones) for (const a of p) sommets += a.length;
    if (sommets > this.sommetsObjetMax) {
      throw new ErreurLecture("TROP_DE_SOMMETS", `un objet porte ${sommets} sommets (maximum ${this.sommetsObjetMax}) : decoupez ce trace`);
    }
    this.sommetsFichier += sommets;
    if (this.sommetsFichier > this.sommetsFichierMax) {
      throw new ErreurLecture("TROP_DE_SOMMETS", `le fichier depasse ${this.sommetsFichierMax} sommets : decoupez-le`);
    }
    const sain = nettoyerAttributs(attributs);
    const nomPropre = nom === null ? null : (nettoyerValeur(nom) as string).trim() || null;
    const etat: EtatMembre = { alt: false, repetes: false, fermes: 0 };
    let invalides = 0, dehors = 0;
    const motif = (m: Motif) => { if (m === "invalide") invalides += 1; else dehors += 1; };

    const points: Pos[] = [];
    for (const b of formes.points) { const p = this.position(b, etat); if (typeof p === "string") motif(p); else points.push(p); }
    const lignes: Pos[][] = [];
    for (const l of formes.lignes) { const r = this.ligne(l, etat); if (typeof r === "string") motif(r); else lignes.push(r); }
    const polygones: Pos[][][] = [];
    for (const poly of formes.polygones) {
      const [ext, ...trous] = poly;
      const e = ext ? this.anneau(ext, etat) : "invalide";
      if (typeof e === "string") { motif(e); continue; }
      const anneaux: Pos[][] = [e];
      // Un trou illisible est ecarte sans perdre le polygone.
      for (const t of trous) { const r = this.anneau(t, etat); if (typeof r !== "string") anneaux.push(r); }
      polygones.push(anneaux);
    }

    this.c.GEOMETRIES_INVALIDES_IGNOREES += invalides;
    this.c.ELEMENTS_HORS_GUINEE += dehors;
    if ((invalides > 0 || dehors > 0) && this.ecartes.length < ECARTES_MAX) {
      this.ecartes.push({ element: numero ?? this.lus, nom: nomPropre, code: dehors > 0 ? "COORDONNEES_HORS_ZONE" : "GEOMETRIE_INVALIDE" });
    }
    this.c.ANNEAUX_FERMES += etat.fermes;
    if (etat.repetes) this.c.POINTS_REPETES_RETIRES += 1;

    const candidats: { typeGeom: TypeGeom; geometrie: GeometrieLue }[] = [];
    if (points.length === 1) candidats.push({ typeGeom: "POINT", geometrie: { type: "Point", coordinates: points[0] } });
    else if (points.length > 1) candidats.push({ typeGeom: "POINT", geometrie: { type: "MultiPoint", coordinates: points } });
    if (lignes.length === 1) candidats.push({ typeGeom: "LIGNE", geometrie: { type: "LineString", coordinates: lignes[0] } });
    else if (lignes.length > 1) candidats.push({ typeGeom: "LIGNE", geometrie: { type: "MultiLineString", coordinates: lignes } });
    if (polygones.length === 1) candidats.push({ typeGeom: "POLYGONE", geometrie: { type: "Polygon", coordinates: polygones[0] } });
    else if (polygones.length > 1) candidats.push({ typeGeom: "POLYGONE", geometrie: { type: "MultiPolygon", coordinates: polygones } });

    if (candidats.length === 0) return;
    if (etat.alt) this.c.ALTITUDE_IGNOREE += 1;
    if (nomPropre === null) this.c.OBJETS_SANS_NOM += candidats.length;
    for (const k of Object.keys(sain)) this.attributs.set(k, (this.attributs.get(k) ?? 0) + 1);

    for (const { typeGeom, geometrie } of candidats) {
      if (this.objets.length >= OBJETS_MAX) throw new ErreurLecture("TROP_D_OBJETS", `plus de ${OBJETS_MAX} objets dans le fichier : decoupez-le`);
      const canon = chaineCanonique(geometrie);
      const cle = geometrie.type + canon;
      if (this.vus.has(cle)) this.c.TRACES_DOUBLES += 1; else this.vus.add(cle);
      this.etendre(geometrie);
      this.parType[typeGeom] += 1;
      this.objets.push({ nom: nomPropre, typeGeom, geometrie, attributs: sain, empreinte: empreinteDe(typeGeom, geometrie, nomPropre, canon), ordre: this.objets.length });
    }
  }

  private etendre(g: GeometrieLue): void {
    const visiter = (c: unknown): void => {
      if (typeof (c as number[])[0] === "number") {
        const [x, y] = c as Pos;
        if (x < this.ouest) this.ouest = x; if (x > this.est) this.est = x;
        if (y < this.sud) this.sud = y; if (y > this.nord) this.nord = y;
      } else for (const s of c as unknown[]) visiter(s);
    };
    visiter(g.coordinates);
  }

  /** Termine la lecture : refuse un fichier sans objet, sinon rend objets, avertissements et resume. */
  terminer(): { objets: ObjetLu[]; avertissements: Avertissement[]; resume: ResumeLecture } {
    if (this.objets.length === 0) {
      const ecartes = this.c.ELEMENTS_HORS_GUINEE + this.c.GEOMETRIES_INVALIDES_IGNOREES;
      if (ecartes === 0) {
        throw new ErreurLecture("FICHIER_VIDE", this.lus === 0
          ? "le fichier ne contient aucun objet (aucun Placemark ni aucune entite)"
          : "le fichier ne contient aucun objet portant une geometrie");
      }
      if (this.c.GEOMETRIES_INVALIDES_IGNOREES === 0) {
        throw new ErreurLecture("HORS_GUINEE", "tous les objets sont hors de la Guinee (longitude -15,2 a -7,5 ; latitude 7,1 a 12,8) : verifiez l'ordre longitude, latitude et le systeme de coordonnees (WGS 84)");
      }
      throw new ErreurLecture("GEOMETRIE_INVALIDE", "aucune geometrie exploitable : lignes de moins de deux points, anneaux degeneres ou coordonnees illisibles (des valeurs hors de -180/180 et -90/90 indiquent souvent des coordonnees projetees en metres au lieu de degres WGS 84)");
    }
    const a: Avertissement[] = [];
    const ajout = (code: CodeAvertissement, message: string, nb: number) => { if (nb > 0) a.push({ code, message, nb }); };
    ajout("ALTITUDE_IGNOREE", "L'altitude est ignoree : les analyses sont planes.", this.c.ALTITUDE_IGNOREE);
    ajout("ELEMENTS_HORS_GUINEE", "Elements ecartes car hors de l'emprise de la Guinee.", this.c.ELEMENTS_HORS_GUINEE);
    ajout("GEOMETRIES_INVALIDES_IGNOREES", "Geometries ecartees car inexploitables (ligne de moins de deux points, anneau degenere, coordonnees illisibles).", this.c.GEOMETRIES_INVALIDES_IGNOREES);
    ajout("ANNEAUX_FERMES", "Anneaux de polygone non fermes dans le fichier : fermes automatiquement.", this.c.ANNEAUX_FERMES);
    ajout("POINTS_REPETES_RETIRES", "Lignes dont des sommets consecutifs identiques ont ete retires.", this.c.POINTS_REPETES_RETIRES);
    ajout("TRACES_DOUBLES", "Objets dont la geometrie est identique a celle d'un objet precedent (meme trace repete) : la longueur physique ne les compte qu'une fois.", this.c.TRACES_DOUBLES);
    ajout("OBJETS_SANS_GEOMETRIE", "Elements du fichier sans geometrie, ignores.", this.c.OBJETS_SANS_GEOMETRIE);
    if (this.c.ELEMENTS_KML_IGNORES > 0) {
      const noms = [...this.ignores.entries()].map(([n, k]) => `${n} (${k})`).join(", ");
      a.push({ code: "ELEMENTS_KML_IGNORES", message: `Elements KML non pris en charge, ignores : ${noms}.`, nb: this.c.ELEMENTS_KML_IGNORES });
    }
    ajout("OBJETS_SANS_NOM", "Objets sans nom.", this.c.OBJETS_SANS_NOM);

    const bbox: Bbox | null = this.objets.length ? [this.ouest, this.sud, this.est, this.nord] : null;
    const attributsDetectes = [...this.attributs.entries()]
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
      .slice(0, 50)
      .map(([nom, nb]) => ({ nom, nb }));
    return {
      objets: this.objets,
      avertissements: a,
      resume: { nbObjets: this.objets.length, parTypeGeom: { ...this.parType }, bbox, attributsDetectes },
    };
  }
}
