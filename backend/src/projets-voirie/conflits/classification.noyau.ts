/**
 * CLASSIFICATION INITIALE, CLE STABLE ET EMPREINTE DE MESURE (noyau pur).
 *
 * La classification initiale est celle du contrat (section 4, premieres lignes) : un conflit calcule entre dans le dossier en
 * `A_INVESTIGUER` ou en `POTENTIEL`, jamais plus haut. Aucun statut humain (confirme, infirme, traitement decide, cloture) n'est
 * produit par un calcul.
 */

import { createHash } from "node:crypto";
import { PAS_CELLULE_DEG, type ClassePrecision, type Mesure, type TypeConflit } from "./types.noyau";

export type StatutInitial = "A_INVESTIGUER" | "POTENTIEL";
export type MotifInvestigation = "PRECISION_INCONNUE" | "PRECISION_INSUFFISANTE" | "COUVERTURE_INSUFFISANTE" | "DIVERGENCE_SOURCES" | "VERTICAL_NON_EVALUE";

export interface EntreeClassification {
  type: TypeConflit;
  /** Classe de precision DECLAREE du jeu de reseau ; nulle = inconnue (jamais inventee). */
  classePrecision: ClassePrecision;
  /** Faux tant que profondeur et altitude manquent (toujours faux dans ce lot). */
  verticalEvalue: boolean;
  /**
   * Vrai si une regle approuvee EXIGE l'evaluation verticale avant de parler de conflit potentiel. Aucune regle de ce lot ne
   * l'exige (il n'existe pas de donnee verticale a evaluer) : faux par defaut. Si une regle future l'exige, un conflit dont le
   * vertical n'est pas evalue reste A_INVESTIGUER.
   */
  verticalRequis?: boolean;
}

export interface Classification {
  statut: StatutInitial;
  /** Raisons pour lesquelles le dossier est a investiguer (vide si POTENTIEL). */
  motifs: MotifInvestigation[];
  /** Mentions qui accompagnent le dossier quel que soit son statut. */
  notes: MotifInvestigation[];
}

/**
 * - couverture insuffisante et divergence de sources : toujours A_INVESTIGUER (c'est une zone a investiguer, pas une mesure) ;
 * - intersection, traversee, proximite : POTENTIEL si la classe de precision declaree est A, B ou C ; A_INVESTIGUER si D, E ou inconnue ;
 * - vertical non evalue : mention portee par le dossier (`verticalEvalue = false`), et motif d'investigation seulement si une regle
 *   l'exige (`verticalRequis`).
 */
export function classerInitial(e: EntreeClassification): Classification {
  const motifs: MotifInvestigation[] = [];
  const notes: MotifInvestigation[] = [];
  if (!e.verticalEvalue) notes.push("VERTICAL_NON_EVALUE");
  if (e.type === "COUVERTURE_INSUFFISANTE") motifs.push("COUVERTURE_INSUFFISANTE");
  else if (e.type === "DIVERGENCE_SOURCES") motifs.push("DIVERGENCE_SOURCES");
  else if (e.classePrecision === null) motifs.push("PRECISION_INCONNUE");
  else if (e.classePrecision === "D" || e.classePrecision === "E") motifs.push("PRECISION_INSUFFISANTE");
  if (e.verticalRequis === true && !e.verticalEvalue) motifs.push("VERTICAL_NON_EVALUE");
  return { statut: motifs.length > 0 ? "A_INVESTIGUER" : "POTENTIEL", motifs, notes };
}

// ------------------------------------------------------------------------------------------------
// Cle stable
// ------------------------------------------------------------------------------------------------

/**
 * Cellule de localisation : coordonnees arrondies au pas (environ 22 m), independantes de la projection de calcul. DEFINITION UNIQUE :
 * `floor(x / pas + 0.5)`, que la base reproduit a l'identique (`floor(x / pas + 0.5)` en double precision) pour reunir en un seul dossier les
 * parties d'un meme objet qui tombent dans la meme cellule.
 */
export function cellule(lon: number, lat: number, pas = PAS_CELLULE_DEG): [number, number] {
  return [Math.floor(lon / pas + 0.5), Math.floor(lat / pas + 0.5)];
}

/** Nom normalise : espaces de bord retires, espaces internes reduits, casse ignoree. */
export const normaliserNom = (s: string): string => s.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Identite de l'objet de reseau, stable d'une version de jeu a l'autre : concessionnaire + nom de l'objet. Un objet sans nom est
 * identifie par l'empreinte de sa geometrie. Les identifiants de jeu et d'objet NE servent PAS : ils changent a chaque version.
 */
export function cleReseau(concessionnaireId: string | null, nomObjet: string | null, empreinteObjet: string | null): string {
  const nom = nomObjet !== null && nomObjet.trim() !== "" ? `n:${normaliserNom(nomObjet)}` : `e:${empreinteObjet ?? ""}`;
  return `${concessionnaireId ?? ""}|${nom}`;
}

export interface ComposantesCle {
  projetId: string;
  axe: string;
  reseau: string;
  type: TypeConflit;
  cellule: readonly [number, number];
}

/** Empreinte SHA-256 (64 caracteres hexadecimaux) : projet, axe, objet de reseau, type et cellule de localisation. */
export function cleConflit(c: ComposantesCle): string {
  const texte = ["v1", c.projetId, normaliserNom(c.axe), c.reseau, c.type, String(c.cellule[0]), String(c.cellule[1])].join("\u001f");
  return createHash("sha256").update(texte, "utf8").digest("hex");
}

// ------------------------------------------------------------------------------------------------
// Mesure : arrondi, empreinte, egalite
// ------------------------------------------------------------------------------------------------

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Mesure au centimetre : deux calculs identiques donnent la meme mesure, un ecart de bruit flottant ne cree pas de « modification ». */
export function arrondirMesure(m: Mesure): Mesure {
  return {
    longueurChausseeM: r2(m.longueurChausseeM),
    longueurEmpriseM: r2(m.longueurEmpriseM),
    distanceMinM: m.distanceMinM === null ? null : r2(m.distanceMinM),
    nbCroisements: Math.max(0, Math.trunc(m.nbCroisements)),
    longueurPieceM: r2(m.longueurPieceM),
  };
}

/** Empreinte (16 caracteres hexadecimaux) de la mesure arrondie : sert a l'instantane d'une analyse et a la detection de modification. */
export function empreinteMesure(m: Mesure): string {
  const a = arrondirMesure(m);
  const canon = [a.longueurChausseeM, a.longueurEmpriseM, a.distanceMinM === null ? "null" : a.distanceMinM, a.nbCroisements, a.longueurPieceM].join("|");
  return createHash("sha256").update(canon, "utf8").digest("hex").slice(0, 16);
}

// ------------------------------------------------------------------------------------------------
// Candidats -> conflits calcules (cles uniques)
// ------------------------------------------------------------------------------------------------

/** Ce que rend le calcul geometrique (SQL) pour un conflit, avant cle ni classification. */
export interface CandidatBrut {
  type: TypeConflit;
  axe: string;
  jeuReseauId: string | null;
  objetId: string | null;
  concessionnaireId: string | null;
  nomObjet: string | null;
  empreinteObjet: string | null;
  classePrecision: ClassePrecision;
  mesure: Mesure;
  /** Cellule de localisation du milieu de la partie en conflit (voir `cellule`). */
  cellule: readonly [number, number];
  /** Geometrie du conflit, EWKB hexadecimal en WGS 84. */
  geomHex: string;
}

export interface ConflitCalcule extends CandidatBrut {
  cle: string;
  empreinteMesure: string;
  classification: Classification;
}

/**
 * Cles uniques par construction. Deux candidats de meme cle (meme axe, meme concessionnaire, meme nom d'objet, meme type, meme
 * cellule) sont departages par l'empreinte de la geometrie de l'objet ; s'ils ont aussi la meme empreinte ce sont deux copies du
 * meme objet : un seul est garde (le plus petit identifiant d'objet). Le resultat est trie par cle : il ne depend pas de l'ordre
 * de lecture.
 */
export function finaliserCandidats(projetId: string, bruts: readonly CandidatBrut[], options: { verticalRequis?: boolean } = {}): ConflitCalcule[] {
  const cleDe = (b: CandidatBrut, avecEmpreinte: boolean) => cleConflit({
    projetId, axe: b.axe, type: b.type, cellule: b.cellule,
    reseau: cleReseau(b.concessionnaireId, b.nomObjet, b.empreinteObjet) + (avecEmpreinte ? `|g:${b.empreinteObjet ?? ""}` : ""),
  });
  const groupes = new Map<string, CandidatBrut[]>();
  for (const b of bruts) groupes.set(cleDe(b, false), [...(groupes.get(cleDe(b, false)) ?? []), b]);

  const retenus = new Map<string, CandidatBrut>();
  for (const [cle, membres] of groupes) {
    if (membres.length === 1) { retenus.set(cle, membres[0]); continue; }
    const parEmpreinte = new Map<string, CandidatBrut>();
    for (const m of [...membres].sort((a, b) => Number(a.objetId ?? 0) - Number(b.objetId ?? 0))) {
      const k = cleDe(m, true);
      if (!parEmpreinte.has(k)) parEmpreinte.set(k, m);
    }
    for (const [k, m] of parEmpreinte) retenus.set(k, m);
  }
  return [...retenus.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([cle, b]) => {
      const mesure = arrondirMesure(b.mesure);
      return {
        ...b, mesure, cle, empreinteMesure: empreinteMesure(mesure),
        classification: classerInitial({ type: b.type, classePrecision: b.classePrecision, verticalEvalue: false, verticalRequis: options.verticalRequis }),
      };
    });
}
