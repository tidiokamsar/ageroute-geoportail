/**
 * Lecteur WKT BORNE (colonne de geometrie d'un CSV). Sans E/S, sans dependance, jamais d'evaluation.
 *
 * ADMIS : POINT, LINESTRING, POLYGON, MULTIPOINT, MULTILINESTRING, MULTIPOLYGON, en 2D ; Z lu (altitude, ignoree plus loin), M ignore ;
 * `EMPTY` refuse. REFUSE : prefixe `SRID=` (le CRS est choisi par l'utilisateur, jamais lu dans une cellule), GEOMETRYCOLLECTION,
 * CURVEPOLYGON et autres types. Les coordonnees sont lues avec le point comme separateur decimal (le WKT n'a pas d'autre forme).
 *
 * Cout lineaire : un seul passage par expression reguliere STICKY a alternatives disjointes (pas de retour arriere).
 */

import type { Brut, FormesBrutes } from "../collecteur.noyau";

export class ErreurWkt extends Error {
  constructor(message: string) { super(message); this.name = "ErreurWkt"; }
}

const JETON = /\s*(?:([A-Za-z]+)|([(),])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?))/y;

interface Jeton { type: "mot" | "ponct" | "nombre"; v: string }

function jetons(texte: string): Jeton[] {
  const sortie: Jeton[] = [];
  JETON.lastIndex = 0;
  let fin = 0;
  for (;;) {
    JETON.lastIndex = fin;
    const m = JETON.exec(texte);
    if (!m) break;
    fin = JETON.lastIndex;
    if (m[1] !== undefined) sortie.push({ type: "mot", v: m[1].toUpperCase() });
    else if (m[2] !== undefined) sortie.push({ type: "ponct", v: m[2] });
    else sortie.push({ type: "nombre", v: m[3] });
  }
  // Tout ce qui n'est ni espace ni jeton est une erreur (pas de caractere ignore en silence).
  if (texte.slice(fin).trim() !== "") throw new ErreurWkt("caractere inattendu dans le WKT");
  return sortie;
}

const TYPES = new Set(["POINT", "LINESTRING", "POLYGON", "MULTIPOINT", "MULTILINESTRING", "MULTIPOLYGON"]);

/** Lit un WKT et rend ses formes (points, lignes, polygones). Leve ErreurWkt sinon. */
export function lireWkt(texte: string): FormesBrutes {
  const t = texte.trim();
  if (/^SRID\s*=/i.test(t)) throw new ErreurWkt("prefixe SRID= refuse : le CRS se choisit pour tout le fichier (epsgSource)");
  const j = jetons(t);
  let i = 0;
  const suivant = (): Jeton => { if (i >= j.length) throw new ErreurWkt("WKT tronque"); return j[i++]; };
  const attendre = (p: string) => { const x = suivant(); if (x.type !== "ponct" || x.v !== p) throw new ErreurWkt(`« ${p} » attendu`); };
  const aSuivant = (p: string) => i < j.length && j[i].type === "ponct" && j[i].v === p;

  const typeJ = suivant();
  if (typeJ.type !== "mot" || !TYPES.has(typeJ.v)) throw new ErreurWkt(`type de geometrie non pris en charge (${typeJ.type === "mot" ? typeJ.v.slice(0, 30) : "?"})`);
  let dim = "";
  if (i < j.length && j[i].type === "mot") {
    const d = j[i].v;
    if (d === "EMPTY") throw new ErreurWkt("geometrie vide (EMPTY)");
    if (d === "Z" || d === "M" || d === "ZM") { dim = d; i++; } else throw new ErreurWkt(`mot inattendu « ${d.slice(0, 20)} »`);
  }
  if (i < j.length && j[i].type === "mot" && j[i].v === "EMPTY") throw new ErreurWkt("geometrie vide (EMPTY)");

  const coord = (): Brut => {
    const v: number[] = [];
    while (i < j.length && j[i].type === "nombre") v.push(Number(j[i++].v));
    if (v.length < 2 || v.length > 4) throw new ErreurWkt("coordonnee de 2 a 4 nombres attendue");
    // Z lu ; M seul (3 valeurs avec dim M) ou 4e valeur ignores.
    if (dim === "M" && v.length === 3) return [v[0], v[1]];
    return v.length >= 3 ? [v[0], v[1], v[2]] : [v[0], v[1]];
  };
  const liste = (): Brut[] => {
    attendre("(");
    const c: Brut[] = [coord()];
    while (aSuivant(",")) { i++; c.push(coord()); }
    attendre(")");
    return c;
  };
  const listes = (): Brut[][] => {
    attendre("(");
    const r: Brut[][] = [liste()];
    while (aSuivant(",")) { i++; r.push(liste()); }
    attendre(")");
    return r;
  };

  const f: FormesBrutes = { points: [], lignes: [], polygones: [] };
  switch (typeJ.v) {
    case "POINT": attendre("("); f.points.push(coord()); attendre(")"); break;
    case "LINESTRING": f.lignes.push(liste()); break;
    case "POLYGON": f.polygones.push(listes()); break;
    case "MULTIPOINT": {
      attendre("(");
      for (;;) {
        if (aSuivant("(")) { i++; f.points.push(coord()); attendre(")"); } else f.points.push(coord());
        if (aSuivant(",")) { i++; continue; }
        break;
      }
      attendre(")");
      break;
    }
    case "MULTILINESTRING": for (const l of listes()) f.lignes.push(l); break;
    case "MULTIPOLYGON": {
      attendre("(");
      f.polygones.push(listes());
      while (aSuivant(",")) { i++; f.polygones.push(listes()); }
      attendre(")");
      break;
    }
  }
  if (i !== j.length) throw new ErreurWkt("texte apres la fin de la geometrie");
  return f;
}
