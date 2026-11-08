/**
 * Lecteur CSV / TSV / TXT a coordonnees (module Projets de voirie et reseaux). Sans E/S, sans dependance, JAMAIS d'evaluation de formule.
 *
 * RIEN N'EST DEVINE EN SILENCE (CONTRAT-IMPORT.md, 4.1) :
 *   - encodage : UTF-8 (BOM ou non) ou UTF-16 avec BOM sont reconnus ; tout autre octet non UTF-8 donne ENCODAGE_AMBIGU tant que
 *     l'utilisateur n'a pas DECLARE l'encodage ;
 *   - delimiteur : detecte seulement s'il est le SEUL candidat (`,` `;` tabulation `|`) qui donne le meme nombre de colonnes (au moins 2)
 *     sur toutes les lignes de l'echantillon, sinon DELIMITEUR_AMBIGU ;
 *   - separateur decimal : detecte seulement s'il est sans ambiguite sur les colonnes de coordonnees, sinon SEPARATEUR_DECIMAL_AMBIGU ;
 *   - le CRS n'est PAS lu ici : il est exige de l'utilisateur par l'appelant.
 *
 * FORMULES : toute valeur est lue comme du TEXTE et conservee telle quelle (`=...`, `+...`, `-...`, `@...` n'ont aucun effet : on lit,
 * on n'ecrit pas dans un tableur ; l'export CSV du module neutralise deja ces prefixes).
 *
 * BORNES : lignes, colonnes, taille d'une cellule (2 000 000 de caracteres pour une colonne WKT, 10 000 pour toutes les autres).
 * Analyse en un seul passage caractere par caractere (aucune expression reguliere sur le contenu), lineaire.
 *
 * CE QUI N'EST PAS FAIT : fichier sans ligne d'en-tete, separateur de milliers, plusieurs tables, delimiteur espace, polygones construits a
 * partir de points, plusieurs cles d'axe imbriquees.
 */

import type { Brut, FormesBrutes } from "../collecteur.noyau";
import { ErreurLecture } from "../lecture.types";
import type { Avertissement } from "../lecture.types";
import type { Puits } from "./puits.noyau";
import { ErreurWkt, lireWkt } from "./wkt.noyau";

export type Delimiteur = "," | ";" | "\t" | "|";
export const DELIMITEURS: readonly Delimiteur[] = [",", ";", "\t", "|"];
export type EncodageDeclare = "utf-8" | "iso-8859-1" | "windows-1252";
export type SeparateurDecimal = "." | ",";

export interface OptionsCsv {
  delimiteur?: Delimiteur;
  encodage?: EncodageDeclare;
  separateurDecimal?: SeparateurDecimal;
  colonneX?: string;
  colonneY?: string;
  colonneWkt?: string;
  colonneCle?: string;
  colonneOrdre?: string;
}

export interface LimitesCsv {
  lignesMax: number;
  colonnesMax: number;
  /** Cellule ordinaire, en caracteres. */
  celluleMax: number;
}
export const CELLULE_WKT_MAX = 2_000_000;
export const COLONNE_NOM_MAX = 200;
export const REJETS_MAX = 50;

export interface Texte { texte: string; encodage: string; encodageDetecte: boolean; bom: boolean }

const estUtf8Valide = (b: Buffer): string | null => {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(b); } catch { return null; }
};

/** Decode le fichier ; ne devine JAMAIS un encodage ambigu. */
export function decoderCsv(b: Buffer, declare?: EncodageDeclare): Texte {
  const bomUtf8 = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
  if (declare) {
    if (declare === "utf-8") {
      const t = estUtf8Valide(bomUtf8 ? b.subarray(3) : b);
      if (t === null) throw new ErreurLecture("ENCODAGE_NON_SUPPORTE", "le fichier est declare en UTF-8 mais n'est pas de l'UTF-8 valide");
      return { texte: t, encodage: "utf-8", encodageDetecte: false, bom: bomUtf8 };
    }
    // iso-8859-1 et windows-1252 : l'etiquette `iso-8859-1` du standard Encoding designe windows-1252 (superset), c'est dit dans le contrat.
    return { texte: new TextDecoder("windows-1252").decode(bomUtf8 ? b.subarray(3) : b), encodage: declare, encodageDetecte: false, bom: false };
  }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return { texte: new TextDecoder("utf-16le").decode(b.subarray(2)), encodage: "utf-16le", encodageDetecte: true, bom: true };
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    const permute = Buffer.from(b.subarray(2));
    permute.swap16();
    return { texte: new TextDecoder("utf-16le").decode(permute), encodage: "utf-16be", encodageDetecte: true, bom: true };
  }
  const t = estUtf8Valide(bomUtf8 ? b.subarray(3) : b);
  if (t === null) {
    throw new ErreurLecture("ENCODAGE_AMBIGU", "le fichier n'est ni de l'UTF-8 valide ni de l'UTF-16 avec BOM : ISO-8859-1 et Windows-1252 se confondent, declarez l'encodage (encodage=iso-8859-1 ou windows-1252) ou enregistrez le fichier en UTF-8");
  }
  return { texte: t, encodage: "utf-8", encodageDetecte: true, bom: bomUtf8 };
}

export interface Enregistrements { lignes: string[][]; numeros: number[] }

interface OptionsAnalyse { lignesMax: number; colonnesMax: number; celluleMax: number; /** Echantillon : tolere un guillemet non ferme en fin de texte et ignore la derniere ligne. */ partiel?: boolean }

/** Analyse RFC 4180 : guillemets, `""`, retours a la ligne dans un champ guillemete. Les lignes vides sont ignorees. */
export function analyserEnregistrements(texte: string, delim: Delimiteur, o: OptionsAnalyse): Enregistrements {
  const lignes: string[][] = [];
  const numeros: number[] = [];
  const n = texte.length;
  const d = delim.charCodeAt(0);
  let i = 0;
  let ligne = 1;
  let debutLigne = 1;
  let champs: string[] = [];
  let debutChamp = true;
  let vide = true;
  let courant = "";
  let termine = false;

  const fermerChamp = (): void => {
    if (courant.length > o.celluleMax) throw new ErreurLecture("CSV_CELLULE_TROP_LONGUE", `une cellule depasse ${o.celluleMax} caracteres (ligne ${debutLigne})`);
    champs.push(courant);
    if (champs.length > o.colonnesMax) throw new ErreurLecture("CSV_TROP_DE_COLONNES", `plus de ${o.colonnesMax} colonnes (ligne ${debutLigne})`);
    courant = "";
    debutChamp = true;
  };
  const fermerLigne = (): void => {
    fermerChamp();
    if (!(champs.length === 1 && champs[0] === "" && vide)) {
      if (lignes.length >= o.lignesMax + 1) throw new ErreurLecture("CSV_TROP_DE_LIGNES", `plus de ${o.lignesMax} lignes de donnees`);
      lignes.push(champs);
      numeros.push(debutLigne);
    }
    champs = [];
    vide = true;
    debutLigne = ligne;
  };

  while (i < n) {
    const c = texte.charCodeAt(i);
    if (debutChamp && c === 34 /* " */) {
      // Champ guillemete.
      debutChamp = false;
      vide = false;
      i++;
      let ferme = false;
      while (i < n) {
        const q = texte.charCodeAt(i);
        if (q === 34) {
          if (texte.charCodeAt(i + 1) === 34) { courant += '"'; i += 2; continue; }
          i++; ferme = true; break;
        }
        if (q === 10) ligne++;
        courant += texte[i];
        i++;
        if (courant.length > o.celluleMax) throw new ErreurLecture("CSV_CELLULE_TROP_LONGUE", `une cellule depasse ${o.celluleMax} caracteres (ligne ${debutLigne})`);
      }
      if (!ferme) {
        if (o.partiel) { termine = true; break; }
        throw new ErreurLecture("CSV_STRUCTURE_INVALIDE", `guillemet non ferme (champ commence ligne ${debutLigne})`);
      }
      const apres = i < n ? texte.charCodeAt(i) : -1;
      if (apres !== -1 && apres !== d && apres !== 10 && apres !== 13) {
        throw new ErreurLecture("CSV_STRUCTURE_INVALIDE", `caractere inattendu apres un champ entre guillemets (ligne ${ligne})`);
      }
      continue;
    }
    if (c === d) { vide = false; fermerChamp(); i++; continue; }
    if (c === 13 || c === 10) {
      if (c === 13 && texte.charCodeAt(i + 1) === 10) i++;
      i++;
      ligne++;
      fermerLigne();
      continue;
    }
    debutChamp = false;
    vide = false;
    courant += texte[i];
    i++;
    if (courant.length > o.celluleMax) throw new ErreurLecture("CSV_CELLULE_TROP_LONGUE", `une cellule depasse ${o.celluleMax} caracteres (ligne ${debutLigne})`);
  }
  if (!termine && (champs.length > 0 || courant !== "" || !vide)) fermerLigne();
  if (o.partiel && lignes.length > 1 && texte.length > 0 && !/[\r\n]$/.test(texte)) { lignes.pop(); numeros.pop(); }
  return { lignes, numeros };
}

export interface ChoixDelimiteur { delimiteur: Delimiteur; detecte: boolean }

/** Delimiteur : celui qui est declare, sinon l'unique candidat coherent sur l'echantillon. Aucun candidat : null (ce n'est pas du CSV). */
export function choisirDelimiteur(texte: string, declare?: Delimiteur): ChoixDelimiteur | null {
  if (declare) return { delimiteur: declare, detecte: false };
  // Echantillon : les 100 premieres lignes physiques au plus (et 256 Ko), pour que le choix ne depende pas de la taille du fichier.
  let fin = Math.min(texte.length, 262_144);
  for (let i = 0, nl = 0; i < fin; i++) if (texte.charCodeAt(i) === 10 && ++nl >= 100) { fin = i + 1; break; }
  const echantillon = fin < texte.length ? texte.slice(0, fin) : texte;
  const coherents: { d: Delimiteur; colonnes: number }[] = [];
  for (const d of DELIMITEURS) {
    let rec: Enregistrements;
    try {
      rec = analyserEnregistrements(echantillon, d, { lignesMax: 100, colonnesMax: 500, celluleMax: 100_000, partiel: echantillon.length < texte.length });
    } catch { continue; }
    const l = rec.lignes;
    if (l.length < 2) continue;
    const h = l[0].length;
    if (h < 2) continue;
    if (l.every((r) => r.length === h)) coherents.push({ d, colonnes: h });
  }
  if (coherents.length === 0) return null;
  if (coherents.length > 1) {
    throw new ErreurLecture("DELIMITEUR_AMBIGU", `plusieurs delimiteurs sont coherents (${coherents.map((c) => JSON.stringify(c.d)).join(", ")}) : declarez le delimiteur`);
  }
  return { delimiteur: coherents[0].d, detecte: true };
}

/** Noms de colonnes : vides renommes `colonne_N`, doublons suffixes ` (2)`, longueur bornee. */
export function normaliserEntetes(brut: string[]): { colonnes: string[]; renommees: number } {
  const vus = new Map<string, number>();
  const colonnes: string[] = [];
  let renommees = 0;
  brut.forEach((b, k) => {
    let nom = b.trim();
    if (nom.length > COLONNE_NOM_MAX) { nom = nom.slice(0, COLONNE_NOM_MAX); renommees++; }
    if (nom === "") { nom = `colonne_${k + 1}`; renommees++; }
    const cle = nom.toLowerCase();
    const deja = vus.get(cle) ?? 0;
    vus.set(cle, deja + 1);
    if (deja > 0) { nom = `${nom} (${deja + 1})`; renommees++; vus.set(nom.toLowerCase(), 1); }
    colonnes.push(nom);
  });
  return { colonnes, renommees };
}

const RE_POINT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const RE_VIRGULE = /^[+-]?(?:\d+(?:,\d*)?|,\d+)$/;

/** Lit un nombre avec le separateur declare ; NaN si le texte n'est pas EXACTEMENT un nombre (jamais de separateur de milliers). */
export function lireNombre(s: string, sep: SeparateurDecimal): number {
  const t = s.trim();
  if (t.length === 0 || t.length > 40) return NaN;
  if (sep === ".") return RE_POINT.test(t) ? Number(t) : NaN;
  return RE_VIRGULE.test(t) ? Number(t.replace(",", ".")) : NaN;
}

/**
 * Separateur decimal lu sur des valeurs : `.` si seuls des points decimaux apparaissent, `,` si seules des virgules, `null` s'il n'y a
 * aucune partie decimale (entiers : sans importance), `"ambigu"` si les deux apparaissent.
 */
export function detecterSeparateurDecimal(valeurs: Iterable<string>): SeparateurDecimal | null | "ambigu" {
  let point = 0, virgule = 0;
  for (const v of valeurs) {
    const t = v.trim();
    if (/^[+-]?\d+\.\d+$/.test(t)) point++;
    else if (/^[+-]?\d+,\d+$/.test(t)) virgule++;
    if (point > 0 && virgule > 0) return "ambigu";
  }
  return point > 0 ? "." : virgule > 0 ? "," : null;
}

export interface InventaireCsv {
  delimiteur: Delimiteur;
  delimiteurDetecte: boolean;
  encodage: string;
  encodageDetecte: boolean;
  bom: boolean;
  colonnes: string[];
  renommees: number;
  nbLignes: number;
  echantillon: string[][];
  exemples: Record<string, string[]>;
  separateurDecimalDetecte: SeparateurDecimal | null | "ambigu";
  table: Enregistrements;
}

/** Decode, choisit le delimiteur, analyse toutes les lignes et releve l'inventaire. `null` : le contenu n'est pas un tableau delimite. */
export function inspecterCsv(contenu: Buffer, o: OptionsCsv, lim: LimitesCsv): InventaireCsv | null {
  const t = decoderCsv(contenu, o.encodage);
  const choix = choisirDelimiteur(t.texte, o.delimiteur);
  if (!choix) return null;
  const rec = analyserEnregistrements(t.texte, choix.delimiteur, { lignesMax: lim.lignesMax, colonnesMax: lim.colonnesMax, celluleMax: CELLULE_WKT_MAX });
  if (rec.lignes.length < 1) return null;
  const { colonnes, renommees } = normaliserEntetes(rec.lignes[0]);
  if (colonnes.length < 2) return null;
  const donnees = rec.lignes.slice(1);
  const exemples: Record<string, string[]> = {};
  const echant = donnees.slice(0, 200);
  colonnes.forEach((nom, k) => {
    const vus: string[] = [];
    for (const r of echant) {
      const v = (r[k] ?? "").trim();
      if (v !== "" && !vus.includes(v)) { vus.push(v.length > 100 ? `${v.slice(0, 100)}...` : v); if (vus.length === 3) break; }
    }
    exemples[nom] = vus;
  });
  const valeursNumeriques: string[] = [];
  for (const r of echant) for (const c of r) if (c.length <= 40) valeursNumeriques.push(c);
  return {
    delimiteur: choix.delimiteur, delimiteurDetecte: choix.detecte, encodage: t.encodage, encodageDetecte: t.encodageDetecte, bom: t.bom,
    colonnes, renommees, nbLignes: donnees.length,
    echantillon: donnees.slice(0, 5).map((r) => r.map((c) => (c.length > 100 ? `${c.slice(0, 100)}...` : c))),
    exemples, separateurDecimalDetecte: detecterSeparateurDecimal(valeursNumeriques),
    table: { lignes: donnees, numeros: rec.numeros.slice(1) },
  };
}

export interface RejetCsv { ligne: number; code: string; message: string }

export interface ResultatCsv {
  mode: "points" | "lignes" | "wkt";
  colonnes: { x?: string; y?: string; wkt?: string; cle?: string; ordre?: string };
  separateurDecimal: SeparateurDecimal;
  separateurDecimalDetecte: boolean;
  nbLignes: number;
  nbLignesRejetees: number;
  rejets: RejetCsv[];
  rejetsTronques: boolean;
  /** Plus grande valeur absolue lue dans les colonnes de coordonnees (controle de coherence avec un CRS geographique). */
  maxAbsCoordonnee: number;
  avertissements: Avertissement[];
}

const manquante = (colonnes: string[], nom: string | undefined, role: string): number => {
  if (!nom) throw new ErreurLecture("CSV_COLONNES_REQUISES", `la colonne ${role} n'est pas designee`);
  const k = colonnes.indexOf(nom);
  if (k < 0) throw new ErreurLecture("CSV_COLONNE_INTROUVABLE", `la colonne « ${nom.slice(0, 80)} » (${role}) n'existe pas dans le fichier`);
  return k;
};

/**
 * Construit les elements d'un CSV (points, lignes par cle, ou WKT) dans le `puits`. Les attributs sont toutes les colonnes NON VIDES
 * (sauf la colonne WKT), en chaines. Les lignes inexploitables sont rejetees une a une, avec leur numero dans le fichier.
 */
export function lireCsv(inv: InventaireCsv, o: OptionsCsv, lim: LimitesCsv, puits: Puits): ResultatCsv {
  const { colonnes } = inv;
  const wkt = o.colonneWkt !== undefined;
  if (wkt && (o.colonneX !== undefined || o.colonneY !== undefined)) {
    throw new ErreurLecture("CSV_COLONNES_REQUISES", "colonneWkt est incompatible avec colonneX et colonneY : choisissez une seule forme de coordonnees");
  }
  if (!wkt && o.colonneX === undefined && o.colonneY === undefined) {
    throw new ErreurLecture("CSV_COLONNES_REQUISES", "designez les colonnes de coordonnees (colonneX et colonneY) ou une colonne WKT (colonneWkt) : rien n'est devine");
  }
  const ix = wkt ? -1 : manquante(colonnes, o.colonneX, "X");
  const iy = wkt ? -1 : manquante(colonnes, o.colonneY, "Y");
  const iw = wkt ? manquante(colonnes, o.colonneWkt, "WKT") : -1;
  const lignesMode = !wkt && o.colonneCle !== undefined;
  if (wkt && (o.colonneCle !== undefined || o.colonneOrdre !== undefined)) {
    throw new ErreurLecture("CSV_COLONNES_REQUISES", "colonneCle et colonneOrdre ne s'appliquent pas a une colonne WKT");
  }
  if (!lignesMode && o.colonneOrdre !== undefined) throw new ErreurLecture("CSV_COLONNES_REQUISES", "colonneOrdre exige colonneCle");
  const ic = lignesMode ? manquante(colonnes, o.colonneCle, "cle") : -1;
  const io = lignesMode && o.colonneOrdre !== undefined ? manquante(colonnes, o.colonneOrdre, "ordre") : -1;

  // Separateur decimal : declare, sinon lu sur les colonnes de coordonnees SEULEMENT, jamais devine s'il est ambigu.
  let sep: SeparateurDecimal = ".";
  let detecte = false;
  if (!wkt) {
    if (o.separateurDecimal) sep = o.separateurDecimal;
    else {
      const valeurs: string[] = [];
      for (const r of inv.table.lignes) { valeurs.push(r[ix] ?? "", r[iy] ?? ""); }
      const d = detecterSeparateurDecimal(valeurs);
      if (d === "ambigu") throw new ErreurLecture("SEPARATEUR_DECIMAL_AMBIGU", "les colonnes de coordonnees melangent le point et la virgule decimaux : declarez separateurDecimal");
      if (d !== null) { sep = d; detecte = true; }
    }
  }

  const rejets: RejetCsv[] = [];
  let nbRejets = 0;
  const rejeter = (ligne: number, code: string, message: string) => { nbRejets++; if (rejets.length < REJETS_MAX) rejets.push({ ligne, code, message }); };
  let maxAbs = 0;
  const suivi = (v: number) => { if (Number.isFinite(v) && Math.abs(v) > maxAbs) maxAbs = Math.abs(v); };

  const attributsDe = (r: string[], exclure: Set<number>): Record<string, unknown> => {
    const a: Record<string, unknown> = {};
    for (let k = 0; k < colonnes.length; k++) {
      if (exclure.has(k)) continue;
      const v = r[k] ?? "";
      if (v === "") continue;
      if (v.length > lim.celluleMax) throw new ErreurLecture("CSV_CELLULE_TROP_LONGUE", `une cellule de la colonne « ${colonnes[k].slice(0, 80)} » depasse ${lim.celluleMax} caracteres`);
      Object.defineProperty(a, colonnes[k], { value: v, writable: true, enumerable: true, configurable: true });
    }
    return a;
  };

  const lignes = inv.table.lignes;
  const numeros = inv.table.numeros;

  if (!lignesMode) {
    const exclure = new Set<number>(wkt ? [iw] : []);
    for (let k = 0; k < lignes.length; k++) {
      const r = lignes[k];
      const numero = numeros[k];
      let formes: FormesBrutes;
      if (wkt) {
        const brut = r[iw] ?? "";
        if (brut.trim() === "") { rejeter(numero, "WKT_ABSENT", "cellule WKT vide"); continue; }
        try { formes = lireWkt(brut); } catch (e) {
          if (e instanceof ErreurWkt) { rejeter(numero, "WKT_INVALIDE", e.message); continue; }
          throw e;
        }
        for (const b of [...formes.points, ...formes.lignes.flat(), ...formes.polygones.flat(2)]) { suivi(b[0]); suivi(b[1]); }
      } else {
        const sx = r[ix] ?? "", sy = r[iy] ?? "";
        if (sx.trim() === "" || sy.trim() === "") { rejeter(numero, "COORDONNEES_ABSENTES", "coordonnee X ou Y vide"); continue; }
        const x = lireNombre(sx, sep), y = lireNombre(sy, sep);
        if (!Number.isFinite(x) || !Number.isFinite(y)) { rejeter(numero, "COORDONNEES_ILLISIBLES", `coordonnee illisible avec le separateur decimal « ${sep} »`); continue; }
        suivi(x); suivi(y);
        formes = { points: [[x, y] as Brut], lignes: [], polygones: [] };
      }
      puits.elementLu();
      puits.ajouter(null, attributsDe(r, exclure), formes);
    }
  } else {
    const groupes = new Map<string, { numero: number; ligne: string[]; pts: { x: number; y: number; ordre: number; pos: number }[] }>();
    for (let k = 0; k < lignes.length; k++) {
      const r = lignes[k];
      const numero = numeros[k];
      const cle = (r[ic] ?? "").trim();
      if (cle === "") { rejeter(numero, "CLE_ABSENTE", "valeur de la colonne cle vide"); continue; }
      const sx = r[ix] ?? "", sy = r[iy] ?? "";
      if (sx.trim() === "" || sy.trim() === "") { rejeter(numero, "COORDONNEES_ABSENTES", "coordonnee X ou Y vide"); continue; }
      const x = lireNombre(sx, sep), y = lireNombre(sy, sep);
      if (!Number.isFinite(x) || !Number.isFinite(y)) { rejeter(numero, "COORDONNEES_ILLISIBLES", `coordonnee illisible avec le separateur decimal « ${sep} »`); continue; }
      let ordre = k;
      if (io >= 0) {
        const so = (r[io] ?? "").trim();
        ordre = lireNombre(so, sep);
        if (!Number.isFinite(ordre)) { rejeter(numero, "ORDRE_ILLISIBLE", "valeur de la colonne ordre illisible"); continue; }
      }
      suivi(x); suivi(y);
      let g = groupes.get(cle);
      if (!g) { g = { numero, ligne: r, pts: [] }; groupes.set(cle, g); }
      g.pts.push({ x, y, ordre, pos: k });
    }
    for (const [cle, g] of groupes) {
      if (g.pts.length < 2) { rejeter(g.numero, "LIGNE_TROP_COURTE", `la cle « ${cle.slice(0, 60)} » n'a qu'un point : une ligne en exige deux`); continue; }
      g.pts.sort((p, q) => p.ordre - q.ordre || p.pos - q.pos);
      // Attributs : la cle, le nombre de points, et les colonnes dont la valeur est identique sur toutes les lignes du groupe.
      const attributs: Record<string, unknown> = {};
      const premiere = g.pts[0].pos;
      const toutes = g.pts.map((p) => lignes[p.pos]);
      for (let c = 0; c < colonnes.length; c++) {
        if (c === ix || c === iy || c === io) continue;
        const v = lignes[premiere][c] ?? "";
        if (v === "" || !toutes.every((r) => (r[c] ?? "") === v)) continue;
        if (v.length > lim.celluleMax) throw new ErreurLecture("CSV_CELLULE_TROP_LONGUE", `une cellule de la colonne « ${colonnes[c].slice(0, 80)} » depasse ${lim.celluleMax} caracteres`);
        Object.defineProperty(attributs, colonnes[c], { value: v, writable: true, enumerable: true, configurable: true });
      }
      Object.defineProperty(attributs, "nbPoints", { value: String(g.pts.length), writable: true, enumerable: true, configurable: true });
      puits.elementLu();
      puits.ajouter(cle, attributs, { points: [], lignes: [g.pts.map((p) => [p.x, p.y] as Brut)], polygones: [] });
    }
  }

  const avertissements: Avertissement[] = [];
  if (nbRejets > 0) avertissements.push({ code: "LIGNES_CSV_REJETEES", message: lignesMode ? "Lignes ou cles du CSV rejetees (voir resume.import.rejets)." : "Lignes du CSV rejetees (voir resume.import.rejets).", nb: nbRejets });
  if (inv.renommees > 0) avertissements.push({ code: "COLONNES_RENOMMEES", message: "Colonnes sans nom, en double ou trop longues renommees.", nb: inv.renommees });
  return {
    mode: wkt ? "wkt" : lignesMode ? "lignes" : "points",
    colonnes: { x: o.colonneX, y: o.colonneY, wkt: o.colonneWkt, cle: o.colonneCle, ordre: o.colonneOrdre },
    separateurDecimal: sep, separateurDecimalDetecte: detecte,
    nbLignes: lignes.length, nbLignesRejetees: nbRejets, rejets, rejetsTronques: nbRejets > rejets.length, maxAbsCoordonnee: maxAbs, avertissements,
  };
}
