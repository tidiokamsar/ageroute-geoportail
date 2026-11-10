/**
 * Mapping de champs : colonne source -> champ cible, valide par LISTE BLANCHE de champs cibles. Sans E/S, sans base.
 * Contrat : docs/projets-voirie/CONTRAT-IMPORT.md, section 7.3.
 *
 * Deux portees :
 *   - OBJET (`nom`, `identifiant`) : `nom` renomme chaque objet depuis sa colonne ; `identifiant` est la cle qui rapproche les objets
 *     d'une version a l'autre (delta : objets MODIFIES) ;
 *   - JEU (type de reseau, concessionnaire, classe et precisions, methode, dates, nature) : un jeu n'a qu'une valeur par champ. La valeur
 *     UNIQUE d'une colonne est PROPOSEE ; plusieurs valeurs distinctes : rien n'est applique (scinder le fichier). Jamais de valeur inventee :
 *     une classe de precision ne vient que d'un mapping demande par l'utilisateur.
 */

import { ErreurMetier } from "../erreurs";
import { estFormeMethodeAcquisition } from "../config";
import { CHAMPS_JEU, type ChampJeu } from "./puits.noyau";
import type { Avertissement } from "../lecture.types";

export interface ChampCible { champ: string; portee: "objet" | "jeu"; description: string }

export const CHAMPS_CIBLES: readonly ChampCible[] = [
  { champ: "nom", portee: "objet", description: "Nom de l'objet, pris dans la colonne (sinon le nom lu dans le fichier)." },
  { champ: "identifiant", portee: "objet", description: "Cle stable qui rapproche les objets d'une version a l'autre (detection des objets modifies)." },
  { champ: "typeReseau", portee: "jeu", description: "Type de reseau du jeu (TELECOM, EAU_POTABLE, ELECTRICITE, ASSAINISSEMENT, GAZ_HYDROCARBURES, AUTRE) : valeur unique de la colonne." },
  { champ: "concessionnaire", portee: "jeu", description: "Nom du concessionnaire, retrouve (jamais cree) parmi les concessionnaires connus : valeur unique de la colonne." },
  { champ: "classePrecision", portee: "jeu", description: "Classe de precision declaree A a E : valeur unique de la colonne." },
  { champ: "precisionHorizontaleM", portee: "jeu", description: "Precision horizontale declaree, en metres : valeur unique de la colonne." },
  { champ: "precisionVerticaleM", portee: "jeu", description: "Precision verticale declaree, en metres : valeur unique de la colonne." },
  { champ: "methode", portee: "jeu", description: "Methode de leve (200 caracteres au plus) : valeur unique de la colonne." },
  { champ: "dateDonnees", portee: "jeu", description: "Date des donnees AAAA-MM-JJ : valeur unique de la colonne." },
  { champ: "dateConstat", portee: "jeu", description: "Date du constat AAAA-MM-JJ : valeur unique de la colonne." },
  { champ: "methodeAcquisition", portee: "jeu", description: "Methode d'acquisition (GNSS_RTK, GEORADAR, NUMERISATION_PLAN, PLAN_CAO...) : valeur unique de la colonne, lot S1." },
  { champ: "connecteA", portee: "objet", description: "Nom de l'objet du MEME fichier auquel l'objet est connecte (declaration du fournisseur, lot S1) : jamais deduit d'une proximite." },
  { champ: "natureObjets", portee: "jeu", description: "Nature des objets (ACTIF_PHYSIQUE, CIRCUIT_LOGIQUE, EQUIPEMENT, INCONNUE ; AXE et EMPRISE sont imposes par le role) : valeur unique de la colonne." },
];

export type Mapping = Readonly<Record<string, string>>;
const CIBLES = new Set(CHAMPS_CIBLES.map((c) => c.champ));
const COLONNE_MAX = 200;

/** Analyse le texte JSON du champ `mapping` : liste blanche des champs cibles, colonnes en chaines de 1 a 200 caracteres. */
export function analyserMapping(texte: string): Mapping {
  if (texte.length > 4000) throw new ErreurMetier(400, "MAPPING_INVALIDE", "Le mapping depasse 4 000 caracteres.");
  let v: unknown;
  try { v = JSON.parse(texte); } catch { throw new ErreurMetier(400, "MAPPING_INVALIDE", "Le mapping n'est pas un JSON valide."); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ErreurMetier(400, "MAPPING_INVALIDE", "Le mapping doit etre un objet { champCible: colonneSource }.");
  const sortie: Record<string, string> = {};
  const inconnus: string[] = [];
  for (const [cible, col] of Object.entries(v)) {
    if (!CIBLES.has(cible)) { inconnus.push(cible.slice(0, 40)); continue; }
    if (typeof col !== "string" || col.trim() === "" || col.length > COLONNE_MAX || col.includes("\u0000")) {
      throw new ErreurMetier(400, "MAPPING_INVALIDE", `La colonne source de « ${cible} » doit etre un texte de 1 a ${COLONNE_MAX} caracteres.`);
    }
    sortie[cible] = col;
  }
  if (inconnus.length > 0) {
    throw new ErreurMetier(400, "MAPPING_INVALIDE", `Champs cibles inconnus : ${inconnus.join(", ")}. Admis : ${[...CIBLES].join(", ")}.`, { champsInconnus: inconnus });
  }
  return sortie;
}

export interface PropositionJeu { valeur: string | number; colonne: string }

const TYPES_RESEAU = ["TELECOM", "EAU_POTABLE", "ELECTRICITE", "ASSAINISSEMENT", "GAZ_HYDROCARBURES", "AUTRE"];
const NATURES = ["ACTIF_PHYSIQUE", "CIRCUIT_LOGIQUE", "EQUIPEMENT", "AXE", "EMPRISE", "INCONNUE"];

function jourValide(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && d.getUTCFullYear() >= 1900 && d.getUTCFullYear() <= 2100;
}

/** Valide la valeur unique d'un champ du jeu ; `null` si elle est inexploitable. */
function validerValeur(champ: ChampJeu, brut: string): string | number | null {
  switch (champ) {
    case "typeReseau": { const v = brut.toUpperCase(); return TYPES_RESEAU.includes(v) ? v : null; }
    case "natureObjets": { const v = brut.toUpperCase(); return NATURES.includes(v) ? v : null; }
    case "classePrecision": { const v = brut.toUpperCase(); return ["A", "B", "C", "D", "E"].includes(v) ? v : null; }
    case "precisionHorizontaleM":
    case "precisionVerticaleM": {
      const t = brut.includes(",") && !brut.includes(".") ? brut.replace(",", ".") : brut;
      if (!/^\d+(\.\d+)?$/.test(t)) return null;
      const n = Number(t);
      return n > 0 && n <= 100_000 ? n : null;
    }
    case "methode": return brut.length <= 200 ? brut : null;
    case "dateDonnees":
    case "dateConstat": return jourValide(brut) ? brut : null;
    case "concessionnaire": return brut.length <= 200 ? brut : null;
    // Forme seulement (noyau pur) : la valeur est verifiee contre le referentiel METHODE_ACQUISITION par le depot (correctifs T1+S1, M2).
    case "methodeAcquisition": { const v = brut.trim().toUpperCase(); return estFormeMethodeAcquisition(v) ? v : null; }
  }
}

/**
 * Propositions de valeurs du jeu a partir des valeurs distinctes lues (`PuitsFiltre.valeurs`). N'applique rien : l'appelant decide, et
 * seulement quand le champ correspondant du formulaire est absent.
 */
export function proposerChampsJeu(mapping: Mapping, valeurs: ReadonlyMap<ChampJeu, ReadonlyMap<string, number>>): { propositions: Partial<Record<ChampJeu, PropositionJeu>>; avertissements: Avertissement[] } {
  const propositions: Partial<Record<ChampJeu, PropositionJeu>> = {};
  const avertissements: Avertissement[] = [];
  for (const champ of CHAMPS_JEU) {
    const colonne = mapping[champ];
    if (colonne === undefined) continue;
    const d = valeurs.get(champ);
    if (!d || d.size === 0) {
      avertissements.push({ code: "MAPPING_CHAMP_IGNORE", message: `La colonne « ${colonne.slice(0, 60)} » (${champ}) est vide : rien n'est propose.` });
      continue;
    }
    if (d.size > 1) {
      avertissements.push({ code: "MAPPING_VALEURS_MULTIPLES", message: `La colonne « ${colonne.slice(0, 60)} » (${champ}) porte plusieurs valeurs distinctes : un jeu n'en a qu'une, rien n'est applique (scindez le fichier).`, nb: d.size });
      continue;
    }
    const brut = [...d.keys()][0];
    const v = validerValeur(champ, brut);
    if (v === null) {
      avertissements.push({ code: "MAPPING_VALEUR_INCONNUE", message: `La valeur de la colonne « ${colonne.slice(0, 60)} » n'est pas valide pour ${champ} : rien n'est applique.` });
      continue;
    }
    propositions[champ] = { valeur: v, colonne };
  }
  return { propositions, avertissements };
}
