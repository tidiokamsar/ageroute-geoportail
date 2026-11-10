/**
 * Puits : l'interface par laquelle les lecteurs (KML, GeoJSON, GPX, CSV) livrent leurs elements. Le `Collecteur` du socle en est
 * l'implementation de reference ; les autres servent l'inventaire, la transformation de CRS et le choix de couche / le mapping.
 * Sans E/S, sans base.
 *
 *   - `Collecteur`   : valide, arrondit, dedoublonne, calcule le resume (WGS 84 attendu) ;
 *   - `Inventaire`   : ne valide RIEN, compte les couches, les familles de geometrie et les noms d'attributs (un fichier hors Guinee
 *                      s'inventorie quand meme) ;
 *   - `Enregistreur` : garde les elements bruts (coordonnees SOURCE) pour que la base les transforme (ST_Transform), puis les rejoue dans
 *                      le Collecteur avec les coordonnees WGS 84 ; applique les memes plafonds de sommets et d'objets que le Collecteur ;
 *   - `PuitsFiltre`  : ne laisse passer que la couche choisie et applique le mapping du nom ; releve les valeurs distinctes des colonnes
 *                      mappees vers des champs du JEU (proposition, jamais appliquee ici).
 */

import type { Brut, FormesBrutes } from "../collecteur.noyau";
import { ErreurLecture, OBJETS_MAX, SOMMETS_PAR_FICHIER_MAX, SOMMETS_PAR_OBJET_MAX } from "../lecture.types";
import type { CodeAvertissement, LimitesLecture } from "../lecture.types";

export interface Puits {
  compter(code: CodeAvertissement, n?: number): void;
  elementIgnore(nom: string): void;
  elementLu(): void;
  /** `couche` : identifiant de couche propre au lecteur (chemin de dossier KML, `waypoints`, `routes`, `traces`) ; `undefined` : couche unique. */
  ajouter(nom: string | null, attributs: Record<string, unknown>, formes: FormesBrutes, couche?: string, numero?: number): void;
}

const familles = (f: FormesBrutes): { LIGNE: number; POINT: number; POLYGONE: number } => ({
  POINT: f.points.length > 0 ? 1 : 0, LIGNE: f.lignes.length > 0 ? 1 : 0, POLYGONE: f.polygones.length > 0 ? 1 : 0,
});

export interface CoucheInventoriee {
  /** Identifiant stable pour ce fichier : `c0`, `c1`... (ordre d'apparition) ou le nom de la famille GPX. */
  id: string;
  nom: string;
  nbObjets: number;
  parTypeGeom: { LIGNE: number; POINT: number; POLYGONE: number };
  /** Cle interne de la couche (chaine fournie par le lecteur), pour la selection. */
  cle: string;
}

export const COLONNES_INVENTAIRE_MAX = 500;

export class Inventaire implements Puits {
  private readonly couches = new Map<string, CoucheInventoriee>();
  readonly attributs = new Set<string>();
  // Lot D1 : couches d'un LandXML (identifiants stables comme ceux du GPX).
  private readonly nomsGpx: Record<string, string> = { waypoints: "Points de passage (waypoints)", routes: "Routes", traces: "Traces", alignements: "Axes en plan (Alignments)", cgpoints: "Points (CgPoints)" };
  /** Nombre d'elements lus. */
  lus = 0;

  compter(): void { /* sans objet */ }
  elementIgnore(): void { /* sans objet */ }
  elementLu(): void { this.lus++; }

  ajouter(_nom: string | null, attributs: Record<string, unknown>, formes: FormesBrutes, couche?: string): void {
    const cle = couche ?? "";
    let c = this.couches.get(cle);
    if (!c) {
      const k = this.couches.size;
      const gpx = couche !== undefined && couche in this.nomsGpx;
      c = {
        id: gpx ? couche! : `c${k}`,
        nom: gpx ? this.nomsGpx[couche!] : couche === undefined ? "(fichier entier)" : couche === "" ? "(racine du document)" : couche,
        nbObjets: 0, parTypeGeom: { LIGNE: 0, POINT: 0, POLYGONE: 0 }, cle,
      };
      this.couches.set(cle, c);
    }
    const f = familles(formes);
    c.parTypeGeom.POINT += f.POINT; c.parTypeGeom.LIGNE += f.LIGNE; c.parTypeGeom.POLYGONE += f.POLYGONE;
    c.nbObjets += f.POINT + f.LIGNE + f.POLYGONE;
    if (this.attributs.size < COLONNES_INVENTAIRE_MAX) for (const k of Object.keys(attributs)) { this.attributs.add(k); if (this.attributs.size >= COLONNES_INVENTAIRE_MAX) break; }
  }

  liste(): CoucheInventoriee[] { return [...this.couches.values()]; }
}

interface Enregistre { nom: string | null; attributs: Record<string, unknown>; formes: FormesBrutes; couche?: string; numero: number }

/** Coordonnees brutes d'un fichier, a plat, dans l'ordre de `rejouer`. `invalide[i]` : valeur illisible (remplacee par 0 a l'envoi). */
export interface SommetsBruts { x: Float64Array; y: Float64Array; invalide: Uint8Array }

/** Valeur absolue au-dela de laquelle une coordonnee n'est plus une coordonnee (aucun CRS du module n'y arrive). */
const COORDONNEE_MAX = 1e9;

export class Enregistreur implements Puits {
  private readonly elements: Enregistre[] = [];
  private sommetsFichier = 0;
  /** Elements lus jusqu'ici : le numero d'un element ecarte doit rester celui du FICHIER, meme si l'element est rejoue plus tard. */
  private lusLocal = 0;
  private readonly sommetsObjetMax: number;
  private readonly sommetsFichierMax: number;

  constructor(private readonly cible: Puits & { }, limites: LimitesLecture = {}) {
    this.sommetsObjetMax = limites.sommetsParObjet ?? SOMMETS_PAR_OBJET_MAX;
    this.sommetsFichierMax = limites.sommetsParFichier ?? SOMMETS_PAR_FICHIER_MAX;
  }

  compter(code: CodeAvertissement, n?: number): void { this.cible.compter(code, n); }
  elementIgnore(nom: string): void { this.cible.elementIgnore(nom); }
  elementLu(): void { this.lusLocal++; this.cible.elementLu(); }

  ajouter(nom: string | null, attributs: Record<string, unknown>, formes: FormesBrutes, couche?: string): void {
    let sommets = formes.points.length;
    for (const l of formes.lignes) sommets += l.length;
    for (const p of formes.polygones) for (const a of p) sommets += a.length;
    if (sommets > this.sommetsObjetMax) throw new ErreurLecture("TROP_DE_SOMMETS", `un objet porte ${sommets} sommets (maximum ${this.sommetsObjetMax}) : decoupez ce trace`);
    this.sommetsFichier += sommets;
    if (this.sommetsFichier > this.sommetsFichierMax) throw new ErreurLecture("TROP_DE_SOMMETS", `le fichier depasse ${this.sommetsFichierMax} sommets : decoupez-le`);
    if (this.elements.length >= OBJETS_MAX) throw new ErreurLecture("TROP_D_OBJETS", `plus de ${OBJETS_MAX} objets dans le fichier : decoupez-le`);
    this.elements.push({ nom, attributs, formes, couche, numero: this.lusLocal });
  }

  get nbElements(): number { return this.elements.length; }

  private static parcourir(f: FormesBrutes, visiter: (b: Brut, remplacer: (v: Brut) => void) => void, ecrire?: { points: Brut[]; lignes: Brut[][]; polygones: Brut[][][] }): void {
    f.points.forEach((b, k) => visiter(b, (v) => { if (ecrire) ecrire.points[k] = v; }));
    f.lignes.forEach((l, i) => l.forEach((b, k) => visiter(b, (v) => { if (ecrire) (ecrire.lignes[i] ??= [])[k] = v; })));
    f.polygones.forEach((p, i) => p.forEach((a, j) => a.forEach((b, k) => visiter(b, (v) => { if (ecrire) ((ecrire.polygones[i] ??= [])[j] ??= [])[k] = v; }))));
  }

  /** Sommets a plat, dans l'ordre de `rejouer`. */
  sommets(): SommetsBruts {
    let n = 0;
    for (const e of this.elements) Enregistreur.parcourir(e.formes, () => { n++; });
    const x = new Float64Array(n), y = new Float64Array(n), invalide = new Uint8Array(n);
    let k = 0;
    for (const e of this.elements) {
      Enregistreur.parcourir(e.formes, (b) => {
        const a = b[0], o = b[1];
        if (!Number.isFinite(a) || !Number.isFinite(o) || Math.abs(a) > COORDONNEE_MAX || Math.abs(o) > COORDONNEE_MAX) invalide[k] = 1;
        else { x[k] = a; y[k] = o; }
        k++;
      });
    }
    return { x, y, invalide };
  }

  /** Rejoue chaque element dans la cible avec les coordonnees transformees (longitude, latitude), l'altitude brute etant conservee. */
  rejouer(lon: ArrayLike<number>, lat: ArrayLike<number>, invalide: Uint8Array): void {
    let k = 0;
    for (const e of this.elements) {
      const f = e.formes;
      const sortie: FormesBrutes = { points: [], lignes: [], polygones: [] };
      const suivant = (b: Brut): Brut => {
        const i = k++;
        if (invalide[i] || !Number.isFinite(lon[i]) || !Number.isFinite(lat[i])) return [NaN, NaN];
        return b.length > 2 ? [lon[i], lat[i], b[2]] : [lon[i], lat[i]];
      };
      sortie.points = f.points.map(suivant);
      sortie.lignes = f.lignes.map((l) => l.map(suivant));
      sortie.polygones = f.polygones.map((p) => p.map((a) => a.map(suivant)));
      this.cible.ajouter(e.nom, e.attributs, sortie, e.couche, e.numero);
    }
  }
}

/** Champs du JEU que le mapping peut alimenter (valeur unique de la colonne), voir mapping.noyau.ts. */
export interface FiltreEtMapping {
  /** Cle interne de la couche a garder ; `undefined` : toutes. */
  couche?: string;
  mapping?: Readonly<Record<string, string>>;
}

export const CHAMPS_JEU = ["typeReseau", "concessionnaire", "classePrecision", "precisionHorizontaleM", "precisionVerticaleM", "methode", "dateDonnees", "dateConstat", "natureObjets", "methodeAcquisition"] as const;
export type ChampJeu = (typeof CHAMPS_JEU)[number];

export class PuitsFiltre implements Puits {
  /** Valeurs distinctes lues par champ du jeu (3 au plus : au-dela, c'est « plusieurs »). */
  readonly valeurs = new Map<ChampJeu, Map<string, number>>();
  readonly attributsVus = new Set<string>();
  ecartes = 0;
  transmis = 0;

  constructor(private readonly cible: Puits, private readonly f: FiltreEtMapping) {}

  compter(code: CodeAvertissement, n?: number): void { this.cible.compter(code, n); }
  elementIgnore(nom: string): void { this.cible.elementIgnore(nom); }
  elementLu(): void { this.cible.elementLu(); }

  ajouter(nom: string | null, attributs: Record<string, unknown>, formes: FormesBrutes, couche?: string): void {
    if (this.f.couche !== undefined && (couche ?? "") !== this.f.couche) { this.ecartes++; return; }
    this.transmis++;
    if (this.attributsVus.size < COLONNES_INVENTAIRE_MAX) for (const k of Object.keys(attributs)) this.attributsVus.add(k);
    const m = this.f.mapping;
    let nomFinal = nom;
    if (m) {
      if (m.nom !== undefined) {
        const v = attributs[m.nom];
        if (v !== undefined && v !== null && String(v).trim() !== "") nomFinal = String(v).trim();
      }
      for (const champ of CHAMPS_JEU) {
        const col = m[champ];
        if (col === undefined) continue;
        const v = attributs[col];
        if (v === undefined || v === null) continue;
        const s = String(v).trim();
        if (s === "") continue;
        let d = this.valeurs.get(champ);
        if (!d) { d = new Map(); this.valeurs.set(champ, d); }
        if (d.size < 3 || d.has(s)) d.set(s, (d.get(s) ?? 0) + 1);
      }
    }
    this.cible.ajouter(nomFinal, attributs, formes, couche);
  }
}
