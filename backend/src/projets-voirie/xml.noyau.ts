/**
 * Lecteur XML MINIMAL, sans dependance, sans resolution d'entite et sans DTD (module Projets de voirie et reseaux).
 *
 * POURQUOI UN LECTEUR ECRIT A LA MAIN
 *
 * Les fichiers KML des concessionnaires viennent de tiers : un lecteur XML generaliste est une surface d'attaque (entites
 * externes XXE, entites imbriquees « billion laughs », DTD distantes). Aucune bibliotheque XML n'est declaree dans
 * `package.json` ; ajouter une dependance pour lire un sous-ensemble tres restreint de XML serait un risque de chaine
 * d'approvisionnement plus grand que ces ~200 lignes, qui font exactement ce que le contrat demande et rien de plus :
 *
 *   - `<!DOCTYPE ...>` et toute declaration `<!ENTITY ...>` sont REFUSES (DTD_REFUSEE), jamais ignores ;
 *   - seules les cinq entites predefinies (&lt; &gt; &amp; &quot; &apos;) et les references numeriques sont decodees ; toute
 *     autre entite nommee est REFUSEE (ENTITE_REFUSEE) : sans DTD, elle ne peut de toute facon pas etre definie ;
 *   - profondeur (100) et nombre d'elements (3 000 000) bornes ;
 *   - aucune E/S : le texte arrive en memoire, l'arbre en sort.
 *
 * CE QU'IL NE FAIT PAS : validation par schema, espaces de noms (le prefixe est retire : `gx:Track` devient `Track`),
 * XML 1.1, encodages autres qu'UTF-8 (le decodage est fait par l'appelant).
 */

export type CodeErreurXml = "XML_INVALIDE" | "DTD_REFUSEE" | "ENTITE_REFUSEE" | "XML_TROP_PROFOND" | "XML_TROP_VOLUMINEUX";

export class ErreurXml extends Error {
  constructor(public readonly code: CodeErreurXml, message: string) {
    super(message);
    this.name = "ErreurXml";
  }
}

export interface NoeudXml {
  /** Nom local (prefixe d'espace de noms retire), casse conservee. */
  nom: string;
  attrs: Record<string, string>;
  enfants: NoeudXml[];
  /** Texte direct du noeud (texte et CDATA concatenes), non rogne. */
  texte: string;
}

export const PROFONDEUR_XML_MAX = 100;
export const ELEMENTS_XML_MAX = 3_000_000;

const ENTITES: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const REGEX_ENTITE = /&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z_][A-Za-z0-9._-]*);/g;

function decoderEntites(s: string): string {
  if (s.indexOf("&") < 0) return s;
  return s.replace(REGEX_ENTITE, (_m, ref: string) => {
    if (ref[0] === "#") {
      const n = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isInteger(n) || n < 1 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) {
        throw new ErreurXml("XML_INVALIDE", `reference numerique de caractere invalide (&${ref};)`);
      }
      return String.fromCodePoint(n);
    }
    const v = ENTITES[ref];
    if (v === undefined) throw new ErreurXml("ENTITE_REFUSEE", `entite « &${ref}; » refusee : seules les cinq entites predefinies sont admises`);
    return v;
  });
}

function nomLocal(nom: string): string {
  const i = nom.lastIndexOf(":");
  return i < 0 ? nom : nom.slice(i + 1);
}

const ESPACE = /\s/;
const REGEX_ATTR = /\s*([^\s=/>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;

/** Lit les attributs de `s` (partie de la balise apres le nom). Un attribut mal forme est une erreur. */
function lireAttributs(s: string): Record<string, string> {
  const attrs: Record<string, string> = Object.create(null);
  REGEX_ATTR.lastIndex = 0;
  let pos = 0;
  while (pos < s.length) {
    // Fin de balise : espaces seuls.
    if (/^\s*$/.test(s.slice(pos))) break;
    REGEX_ATTR.lastIndex = pos;
    const m = REGEX_ATTR.exec(s);
    if (!m) throw new ErreurXml("XML_INVALIDE", "attribut mal forme dans une balise");
    const nom = nomLocal(m[1]);
    if (!/^xmlns$/.test(m[1]) && !m[1].startsWith("xmlns:")) attrs[nom] = decoderEntites(m[2] ?? m[3] ?? "");
    pos = REGEX_ATTR.lastIndex;
  }
  return { ...attrs };
}

/** Analyse un document XML et rend son element racine. */
export function lireXml(texte: string, options: { profondeurMax?: number; elementsMax?: number } = {}): NoeudXml {
  const profondeurMax = options.profondeurMax ?? PROFONDEUR_XML_MAX;
  const elementsMax = options.elementsMax ?? ELEMENTS_XML_MAX;
  const n = texte.length;
  const pile: NoeudXml[] = [];
  let racine: NoeudXml | null = null;
  let nbElements = 0;
  let i = 0;

  const texteHorsRacine = (s: string) => {
    if (s.trim() !== "") throw new ErreurXml("XML_INVALIDE", "texte en dehors de l'element racine");
  };

  while (i < n) {
    const lt = texte.indexOf("<", i);
    if (lt < 0) {
      const reste = texte.slice(i);
      if (pile.length > 0) throw new ErreurXml("XML_INVALIDE", "document tronque : balise non fermee");
      texteHorsRacine(reste);
      break;
    }
    if (lt > i) {
      const brut = texte.slice(i, lt);
      // Les blancs entre balises n'apportent rien (et gonfleraient la memoire sur un fichier de 25 Mo).
      if (pile.length > 0) { if (/\S/.test(brut)) pile[pile.length - 1].texte += decoderEntites(brut); }
      else texteHorsRacine(brut);
    }
    // Declaration, instruction de traitement.
    if (texte.startsWith("<?", lt)) {
      const fin = texte.indexOf("?>", lt + 2);
      if (fin < 0) throw new ErreurXml("XML_INVALIDE", "instruction de traitement non terminee");
      i = fin + 2;
      continue;
    }
    if (texte.startsWith("<!--", lt)) {
      const fin = texte.indexOf("-->", lt + 4);
      if (fin < 0) throw new ErreurXml("XML_INVALIDE", "commentaire non termine");
      i = fin + 3;
      continue;
    }
    if (texte.startsWith("<![CDATA[", lt)) {
      const fin = texte.indexOf("]]>", lt + 9);
      if (fin < 0) throw new ErreurXml("XML_INVALIDE", "section CDATA non terminee");
      if (pile.length === 0) throw new ErreurXml("XML_INVALIDE", "CDATA en dehors de l'element racine");
      pile[pile.length - 1].texte += texte.slice(lt + 9, fin);
      i = fin + 3;
      continue;
    }
    if (texte.startsWith("<!", lt)) {
      // <!DOCTYPE, <!ENTITY, <!ELEMENT, <!ATTLIST... : aucune declaration de type de document n'est admise.
      throw new ErreurXml("DTD_REFUSEE", "declaration de type de document (DTD, DOCTYPE, ENTITY) refusee");
    }
    // Balise fermante.
    if (texte[lt + 1] === "/") {
      const gt = texte.indexOf(">", lt + 2);
      if (gt < 0) throw new ErreurXml("XML_INVALIDE", "balise fermante non terminee");
      const nom = nomLocal(texte.slice(lt + 2, gt).trim());
      const courant = pile.pop();
      if (!courant || courant.nom !== nom) throw new ErreurXml("XML_INVALIDE", `balise fermante inattendue </${nom}>`);
      i = gt + 1;
      continue;
    }
    // Balise ouvrante : chercher le '>' en respectant les guillemets des attributs.
    let j = lt + 1;
    let guillemet = "";
    while (j < n) {
      const c = texte[j];
      if (guillemet) { if (c === guillemet) guillemet = ""; }
      else if (c === '"' || c === "'") guillemet = c;
      else if (c === ">") break;
      j++;
    }
    if (j >= n) throw new ErreurXml("XML_INVALIDE", "balise ouvrante non terminee");
    let interieur = texte.slice(lt + 1, j);
    const autoFermante = interieur.endsWith("/");
    if (autoFermante) interieur = interieur.slice(0, -1);
    let k = 0;
    while (k < interieur.length && !ESPACE.test(interieur[k])) k++;
    const nomBrut = interieur.slice(0, k);
    if (nomBrut === "" || !/^[A-Za-z_][A-Za-z0-9._:-]*$/.test(nomBrut)) throw new ErreurXml("XML_INVALIDE", "nom de balise invalide");
    nbElements++;
    if (nbElements > elementsMax) throw new ErreurXml("XML_TROP_VOLUMINEUX", `plus de ${elementsMax} elements XML`);
    const noeud: NoeudXml = { nom: nomLocal(nomBrut), attrs: lireAttributs(interieur.slice(k)), enfants: [], texte: "" };
    if (pile.length > 0) pile[pile.length - 1].enfants.push(noeud);
    else if (racine) throw new ErreurXml("XML_INVALIDE", "plusieurs elements racine");
    else racine = noeud;
    if (!autoFermante) {
      if (pile.length >= profondeurMax) throw new ErreurXml("XML_TROP_PROFOND", `imbrication de plus de ${profondeurMax} niveaux`);
      pile.push(noeud);
    }
    i = j + 1;
  }
  if (pile.length > 0) throw new ErreurXml("XML_INVALIDE", "document tronque : balise non fermee");
  if (!racine) throw new ErreurXml("XML_INVALIDE", "aucun element racine");
  return racine;
}
