/**
 * NOYAU DE LA RECEPTION : ce qu'on verifie sur les OCTETS et les METADONNEES avant qu'une seule
 * ligne ne soit lue, et ce qu'on borne avant de repondre. Aucune base, aucune horloge, aucun
 * reseau : des valeurs en valeurs, donc testable sans rien.
 *
 * POURQUOI UN FICHIER A PART
 *
 * `pivot.noyau.ts` juge UNE ligne. Ce fichier juge le FICHIER entier : sa forme est-elle celle du
 * format declare, son encodage est-il lisible, son nom est-il affichable, ses cellules sont-elles
 * enregistrables, son export d'erreurs est-il sur. Ce sont des controles que l'audit du 25/10/2026
 * a montres absents, chacun avec sa preuve (voir docs/imports/RECEPTION-LOTS-IMPORT.md).
 */

import type { Compteurs } from "./pivot.noyau";

/* ============================== Plafonds (tous nommes) ============================== */

/**
 * Nombre maximal de lignes de donnees d'un lot. PROVISOIRE : fixe d'apres les mesures du
 * 25/10/2026 (docs/imports/RECEPTION-LOTS-IMPORT.md), a revoir avec la DSI. Au-dela : 400
 * `TROP_DE_LIGNES`, rien n'est enregistre, la source decoupe son fichier.
 */
export const LIMITE_LIGNES = 20_000;

/** Lignes inserees par requete `createMany` : une requete de 20 000 lignes bloquait tout le reste. */
export const TAILLE_LOT_INSERTION = 1_000;

/** Lignes traitees entre deux cessions de la boucle d'evenements (sinon requireAuth depasse son delai). */
export const TAILLE_TRANCHE_TRAITEMENT = 500;

/** Longueur maximale d'un nom de fichier conserve. */
export const LONGUEUR_MAX_NOM_FICHIER = 255;

/** Export d'erreurs : nombre de lignes et nombre de caracteres maximaux, taille d'une cellule de charge. */
export const LIMITE_LIGNES_ERREURS = 20_000;
export const LIMITE_CARACTERES_ERREURS = 10_000_000;
export const LIMITE_CELLULE_CHARGE = 5_000;

/** Apercu : valeurs et colonnes plafonnees. */
export const APERCU_VALEUR_MAX = 200;
export const APERCU_COLONNES_MAX = 40;
export const APERCU_MOTIF_MAX = 500;
export const APERCU_LIMITE_MAX = 50;

/** Colonnes inconnues rendues dans le controle (un GeoJSON peut en fabriquer une par entite). */
export const COLONNES_INCONNUES_MAX = 200;

/** Profondeur maximale d'une propriete GeoJSON conservee ; au-dela, la structure est tronquee. */
export const PROFONDEUR_MAX_CHARGE = 32;

/* ================================ Coherence du format ================================ */

export type Verdict = { ok: true } | { ok: false; motif: string };

const OCTETS_TETE = 8192;

/** Vrai si le fichier commence par un BOM UTF-16 ou UTF-32 (FF FE ou FE FF). */
export function aBomUtf16(o: Uint8Array): boolean {
  return o.length >= 2 && ((o[0] === 0xff && o[1] === 0xfe) || (o[0] === 0xfe && o[1] === 0xff));
}

/**
 * Le contenu a-t-il la FORME du format declare ? Le champ `format` vient du client : sans ce
 * controle, un CSV envoye en « geojson » devenait un lot REJETE, et renvoyer les memes octets avec
 * le bon format rendait ce lot REJETE comme `dejaRecu`, sans moyen de corriger.
 *
 *   - un contenu BINAIRE (plus de 5 % d'octets de controle dans les premiers Ko) n'est ni l'un ni l'autre ;
 *   - un GeoJSON commence par `{` (apres un BOM UTF-8 et des blancs) ;
 *   - un CSV ne commence ni par `{` ni par `[`.
 *
 * Un BOM UTF-16 n'est PAS juge ici : le fichier est de l'UTF-16, ce qui est un probleme d'encodage
 * a dire en toutes lettres (`decoderUtf8`), pas un contenu binaire.
 */
export function verifierCoherenceFormat(format: "csv" | "geojson", octets: Uint8Array): Verdict {
  if (aBomUtf16(octets)) return { ok: true };
  const tete = octets.subarray(0, OCTETS_TETE);
  let controles = 0;
  for (let i = 0; i < tete.length; i += 1) {
    const b = tete[i];
    if (b === 0 || (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c)) controles += 1;
  }
  // Binaire = plus de 5 % d'octets de controle dans les premiers Ko (zip, SQLite, image, UTF-16 sans BOM,
  // octets aleatoires : bien au-dessus). Un NUL ISOLE dans un fichier texte n'est pas un fichier binaire :
  // c'est une cellule fautive, rejetee ligne par ligne avec son motif (jamais un 500).
  if (controles * 20 > tete.length) {
    return { ok: false, motif: `le contenu est binaire (${controles} octets de controle sur les ${tete.length} premiers), ce n'est ni un CSV ni un GeoJSON` };
  }
  let i = 0;
  if (octets[0] === 0xef && octets[1] === 0xbb && octets[2] === 0xbf) i = 3;
  while (i < octets.length && (octets[i] === 0x20 || octets[i] === 0x09 || octets[i] === 0x0a || octets[i] === 0x0d)) i += 1;
  const premier = octets[i];
  if (format === "geojson") {
    if (premier !== 0x7b) return { ok: false, motif: "le contenu ne ressemble pas a du GeoJSON (un objet JSON commencant par « { » est attendu) : verifiez le format declare" };
  } else if (premier === 0x7b || premier === 0x5b) {
    return { ok: false, motif: "le contenu ressemble a du JSON et non a un CSV : verifiez le format declare" };
  }
  return { ok: true };
}

/* ====================================== Encodage ====================================== */

/**
 * Position du premier octet qui n'est pas de l'UTF-8 valide, ou -1. Ecrit a la main parce que
 * `TextDecoder` en mode fatal dit SEULEMENT que c'est invalide, pas ou : or la source doit savoir
 * ou corriger. Verifie contre `TextDecoder` par un test de proprietes.
 */
export function premierOctetInvalideUtf8(o: Uint8Array): number {
  let i = 0;
  while (i < o.length) {
    const b = o[i];
    if (b < 0x80) { i += 1; continue; }
    let n: number; let min: number;
    if (b >= 0xc2 && b <= 0xdf) { n = 1; min = 0x80; }
    else if (b >= 0xe0 && b <= 0xef) { n = 2; min = 0x800; }
    else if (b >= 0xf0 && b <= 0xf4) { n = 3; min = 0x10000; }
    else return i;
    let cp = b & (0xff >> (n + 2));
    for (let k = 1; k <= n; k += 1) {
      const c = o[i + k];
      if (c === undefined || (c & 0xc0) !== 0x80) return i;
      cp = (cp << 6) | (c & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return i;
    i += n + 1;
  }
  return -1;
}

export type Decodage = { ok: true; texte: string } | { ok: false; motif: string };

/**
 * Decode en UTF-8 STRICT. `toString("utf8")` remplaçait en silence chaque octet invalide par
 * U+FFFD : un export Excel francais (Windows-1252) devenait un lot VALIDE_SCHEMA aux accents
 * detruits, sans un mot. Le BOM UTF-8 est accepte et retire.
 */
export function decoderUtf8(octets: Uint8Array): Decodage {
  if (aBomUtf16(octets)) {
    return { ok: false, motif: "encodage UTF-16 detecte (marque d'ordre des octets) : reenregistrez le fichier en UTF-8" };
  }
  try {
    return { ok: true, texte: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(octets) };
  } catch {
    const pos = premierOctetInvalideUtf8(octets);
    return { ok: false, motif: `encodage non UTF-8 : reenregistrez le fichier en UTF-8${pos >= 0 ? ` (premier octet invalide a la position ${pos})` : ""}` };
  }
}

/* ===================================== Nom de fichier ===================================== */

/**
 * Nom de fichier AFFICHABLE : sans caractere de controle ni de direction (un U+202E retourne
 * l'extension affichee), sans separateur de chemin (seul le dernier element est garde), borne a
 * 255 caracteres. Il n'est jamais utilise comme chemin : il n'est qu'une etiquette.
 */
export function assainirNomFichier(brut: string): string {
  let s = String(brut ?? "").replace(CONTROLE_OU_DIRECTION_G, "");
  s = s.split(/[\\/]/).pop() ?? "";
  s = s.trim();
  if (s === "" || /^\.+$/.test(s)) return "fichier";
  const car = Array.from(s);
  return car.length > LONGUEUR_MAX_NOM_FICHIER ? car.slice(0, LONGUEUR_MAX_NOM_FICHIER).join("") : s;
}

const CARACTERES_INVISIBLES = "\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069";
const CONTROLE_OU_DIRECTION = new RegExp(`[${CARACTERES_INVISIBLES}]`);
const CONTROLE_OU_DIRECTION_G = new RegExp(`[${CARACTERES_INVISIBLES}\ufeff]`, "g");


/** Texte imprimable : ni retour a la ligne, ni NUL, ni caractere de controle ou de direction. */
export function estImprimable(s: string): boolean {
  return !CONTROLE_OU_DIRECTION.test(s);
}

export const AUTORISATION_REF_LONGUEUR_MIN = 5;

/**
 * Durcissement MINIMAL de la reference d'autorisation : cinq caracteres au moins (apres blancs) et
 * imprimables. `x`, `.` et `n/a` passaient. Aucune autre regle n'est inventee : rapprocher la
 * reference d'un registre d'autorisations est une decision de la DSI.
 */
export function verifierAutorisationRef(valeur: string): string | null {
  const t = valeur.trim();
  if (t.length < AUTORISATION_REF_LONGUEUR_MIN) return `au moins ${AUTORISATION_REF_LONGUEUR_MIN} caracteres attendus`;
  if (!estImprimable(t)) return "caracteres imprimables uniquement (ni retour a la ligne, ni caractere de controle)";
  return null;
}

export interface MetadonneesComparables {
  autorisationRef: string;
  versionMapping: string;
  methodeSource: string;
  auteurSource?: string | null;
  dateSource?: Date | null;
}

export interface MetadonneeDifferente { champ: string; recu: string | null; conserve: string | null }

/**
 * Le meme fichier renvoye avec d'AUTRES metadonnees rendait `dejaRecu` en conservant les anciennes
 * SANS LE DIRE. Le lot existant n'est pas modifie ; la difference est nommee. L'auteur et la date
 * du releve ne sont comparees que s'ils sont fournis : omettre n'est pas contredire.
 */
export function comparerMetadonnees(recu: MetadonneesComparables, conserve: MetadonneesComparables): MetadonneeDifferente[] {
  const texte = (v: string | null | undefined) => (v === null || v === undefined ? null : v.trim());
  const date = (v: Date | null | undefined) => (v ? v.toISOString() : null);
  const sortie: MetadonneeDifferente[] = [];
  for (const champ of ["autorisationRef", "versionMapping", "methodeSource"] as const) {
    if (texte(recu[champ]) !== texte(conserve[champ])) sortie.push({ champ, recu: texte(recu[champ]), conserve: texte(conserve[champ]) });
  }
  const auteur = texte(recu.auteurSource);
  if (auteur && auteur !== texte(conserve.auteurSource)) sortie.push({ champ: "auteurSource", recu: auteur, conserve: texte(conserve.auteurSource) });
  if (recu.dateSource && date(recu.dateSource) !== date(conserve.dateSource)) {
    sortie.push({ champ: "dateSource", recu: date(recu.dateSource), conserve: date(conserve.dateSource) });
  }
  return sortie;
}

/** Une source normalisee pour COMPARER (jamais pour stocker) : sans casse ni blancs superflus. */
export function sourceNormalisee(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

/* ====================================== Charge d'une ligne ====================================== */

export interface ChargeNettoyee {
  /** Copie enregistrable (jsonb) : sans NUL, sans substitut isole, profondeur bornee. */
  propre: Record<string, unknown>;
  /** Un motif de rejet de la ligne si la charge n'est pas enregistrable telle quelle, sinon null. */
  motif: string | null;
}

const SUBSTITUT_ISOLE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * Prepare la charge d'une ligne pour PostgreSQL. `jsonb` refuse le caractere NUL et un substitut
 * UTF-16 isole : sans cette etape, UNE cellule ainsi faisait echouer l'enregistrement du lot entier
 * en 500. La ligne est maintenant REJETEE avec son motif, et sa charge est conservee avec le
 * caractere remplace par un marqueur visible (U+2400 pour le NUL, U+FFFD pour un substitut isole) :
 * la substitution est declaree dans le motif, jamais silencieuse. Une propriete plus profonde que
 * 32 niveaux est tronquee (jsonb et la pile d'appels ont leurs limites).
 */
export function nettoyerCharge(brute: Record<string, unknown>): ChargeNettoyee {
  const problemes = new Set<string>();
  let colonneFautive = null as string | null;
  let colonneCourante = "";

  const nettoyerTexte = (t: string): string => {
    let r = t;
    if (r.includes("\u0000")) { problemes.add("NUL"); colonneFautive ??= colonneCourante; r = r.replace(/\u0000/g, "␀"); }
    if (SUBSTITUT_ISOLE.test(r)) { problemes.add("SUBSTITUT"); colonneFautive ??= colonneCourante; r = r.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "�"); }
    return r;
  };
  const nettoyer = (v: unknown, profondeur: number): unknown => {
    if (typeof v === "string") return nettoyerTexte(v);
    if (v === null || typeof v !== "object") return v;
    if (profondeur >= PROFONDEUR_MAX_CHARGE) { problemes.add("PROFONDEUR"); colonneFautive ??= colonneCourante; return "[structure tronquee]"; }
    if (Array.isArray(v)) return v.map((x) => nettoyer(x, profondeur + 1));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [nettoyerTexte(k), nettoyer(x, profondeur + 1)]));
  };

  // fromEntries cree des proprietes PROPRES : une colonne nommee `__proto__` n'est pas avalee.
  const propre: Record<string, unknown> = Object.fromEntries(Object.entries(brute).map(([k, v]) => {
    colonneCourante = k;
    return [nettoyerTexte(k), nettoyer(v, 0)];
  }));
  if (problemes.size === 0) return { propre: brute, motif: null };

  const col = colonneFautive === null ? "" : ` (colonne « ${colonneFautive.length > 40 ? `${colonneFautive.slice(0, 40)}...` : colonneFautive.replace(/[\u0000-\u001f]/g, " ")} »)`;
  const dits: string[] = [];
  if (problemes.has("NUL")) dits.push("caractere NUL (U+0000), non enregistrable, remplace par U+2400 dans la charge conservee");
  if (problemes.has("SUBSTITUT")) dits.push("substitut UTF-16 isole, remplace par U+FFFD dans la charge conservee");
  if (problemes.has("PROFONDEUR")) dits.push(`structure imbriquee au-dela de ${PROFONDEUR_MAX_CHARGE} niveaux, tronquee dans la charge conservee`);
  return { propre, motif: `contenu non enregistrable${col} : ${dits.join(" ; ")}` };
}

/* ===================================== Export d'erreurs ===================================== */

/**
 * Injection de formule : une cellule commencant par `=`, `+`, `-`, `@`, tabulation ou retour
 * chariot est INTERPRETEE comme une formule par Excel et LibreOffice (`=HYPERLINK(...)`, `+cmd`).
 * Elle est precedee d'une apostrophe, que les tableurs n'affichent pas et que la relecture par
 * `lireCsv` reste libre de retirer : la valeur d'origine est la cellule SANS cette apostrophe
 * initiale. Les colonnes ne bougent pas (l'apostrophe est AVANT le guillemetage).
 */
export function neutraliserFormule(valeur: string): string {
  return /^[=+\-@\t\r]/.test(valeur) ? `'${valeur}` : valeur;
}

function citerErreur(v: unknown, sep: string, neutraliser: boolean, max?: number): string {
  let s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (max !== undefined && s.length > max) s = `${s.slice(0, max)}...[tronque a ${max} caracteres]`;
  if (neutraliser) s = neutraliserFormule(s);
  return /["\r\n]/.test(s) || s.includes(sep) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface LigneErreur {
  numeroLigne: number;
  statut: string;
  motifRejet: string | null;
  identifiantSource: string | null;
  chargeOriginale: unknown;
}

/**
 * CSV d'erreurs : une ligne par rejet ou doublon, formules neutralisees, volume BORNE. `total`
 * est le nombre de lignes en erreur du lot ; si l'export est plus court, un commentaire final
 * (ligne commencant par `#`, ignoree par `lireCsv`) le dit.
 */
export function construireErreursCsv(
  lignes: Iterable<LigneErreur>,
  total: number,
  sep: string,
  limites: { lignes: number; caracteres: number } = { lignes: LIMITE_LIGNES_ERREURS, caracteres: LIMITE_CARACTERES_ERREURS },
): { csv: string; exportees: number; tronque: boolean } {
  const sortie: string[] = [["numero_ligne", "statut", "motif", "identifiant_source", "charge_originale"].join(sep)];
  let caracteres = sortie[0].length;
  let exportees = 0;
  for (const l of lignes) {
    if (exportees >= limites.lignes || caracteres >= limites.caracteres) break;
    const ligne = [
      String(l.numeroLigne), l.statut,
      citerErreur(l.motifRejet, sep, true), citerErreur(l.identifiantSource, sep, true),
      citerErreur(l.chargeOriginale, sep, true, LIMITE_CELLULE_CHARGE),
    ].map((c, i) => (i < 2 ? citerErreur(c, sep, false) : c)).join(sep);
    sortie.push(ligne);
    caracteres += ligne.length + 1;
    exportees += 1;
  }
  const tronque = exportees < total;
  if (tronque) sortie.push(`# export tronque : ${exportees} lignes sur ${total} (limite de l'export)`);
  return { csv: sortie.join("\n") + "\n", exportees, tronque };
}

/* ========================================== Divers ========================================== */

/** Compte les lignes qui ne sont pas VALIDEES : ce que l'export d'erreurs contiendrait au plus. */
export function lignesEnErreur(c: Compteurs): number {
  return c.rejetees + c.ignorees;
}
