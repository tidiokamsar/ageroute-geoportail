/**
 * Lecteur XML MINIMAL, sans dependance, sans resolution d'entite et sans DTD (module Projets de voirie et reseaux).
 *
 * POURQUOI UN LECTEUR ECRIT A LA MAIN
 *
 * Les fichiers KML des concessionnaires viennent de tiers : un lecteur XML generaliste est une surface d'attaque (entites
 * externes XXE, entites imbriquees « billion laughs », DTD distantes). Aucune bibliotheque XML n'est declaree dans
 * `package.json` ; ajouter une dependance pour lire un sous-ensemble tres restreint de XML serait un risque de chaine
 * d'approvisionnement plus grand que ce fichier, qui fait exactement ce que le contrat demande et rien de plus :
 *
 *   - `<!DOCTYPE ...>` et toute declaration `<!ENTITY ...>` sont REFUSES (DTD_REFUSEE), jamais ignores ;
 *   - seules les cinq entites predefinies (&lt; &gt; &amp; &quot; &apos;) et les references numeriques sont decodees ; toute
 *     autre entite nommee est REFUSEE (ENTITE_REFUSEE) : sans DTD, elle ne peut de toute facon pas etre definie ;
 *   - aucune E/S : le texte arrive en memoire, l'arbre en sort.
 *
 * COUT BORNE ET LINEAIRE (revue de securite, M3). Une seule passe sur le texte, par recherche de caracteres (`indexOf`, balayage
 * de codes), SANS expression reguliere appliquee a du contenu arbitraire et sans copie par element. Les bornes sont celles du
 * contrat (25 Mo, 50 000 objets) ramenees a l'XML :
 *
 *   - elements       : 1 200 000 (24 par objet autorise ; un objet KML en porte 8 a 15) ;
 *   - attributs      : 64 par element, 1 500 000 en tout ;
 *   - profondeur     : 100 ;
 *   - nom de balise ou d'attribut : 128 caracteres.
 *
 * Mesure : un fichier de 50 000 objets (12 Mo) s'analyse en moins d'une seconde ; un fichier abusif (millions d'elements,
 * d'attributs, de niveaux) est refuse sans allocation proportionnelle a ce qu'il pretend contenir.
 *
 * CE QU'IL NE FAIT PAS : validation par schema, espaces de noms (le prefixe est retire : `gx:Track` devient `Track`), XML 1.1,
 * encodages autres qu'UTF-8 (le decodage est fait par l'appelant).
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
  attrs: Readonly<Record<string, string>>;
  enfants: readonly NoeudXml[];
  /** Texte direct du noeud (texte et CDATA concatenes), non rogne. */
  texte: string;
}

export const PROFONDEUR_XML_MAX = 100;
export const ELEMENTS_XML_MAX = 1_200_000;
export const ATTRIBUTS_PAR_ELEMENT_MAX = 64;
export const ATTRIBUTS_XML_MAX = 1_500_000;
export const NOM_XML_MAX = 128;

const ENTITES: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** Decode les references d'entite de `s` ; un seul passage, sans expression reguliere sur le contenu entier. */
function decoderEntites(s: string): string {
  let i = s.indexOf("&");
  if (i < 0) return s;
  let sortie = "";
  let debut = 0;
  while (i >= 0) {
    const pv = s.indexOf(";", i + 1);
    // Une esperluette qui n'ouvre pas une reference (pas de « ; » proche) reste litterale.
    if (pv < 0 || pv - i > 12) { i = s.indexOf("&", i + 1); continue; }
    const ref = s.slice(i + 1, pv);
    let rempl: string | null = null;
    if (ref.charCodeAt(0) === 35 /* # */) {
      const hex = ref.charCodeAt(1) === 120 || ref.charCodeAt(1) === 88;
      const corps = hex ? ref.slice(2) : ref.slice(1);
      if (corps !== "" && (hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(corps)) {
        const n = parseInt(corps, hex ? 16 : 10);
        if (!Number.isInteger(n) || n < 1 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) {
          throw new ErreurXml("XML_INVALIDE", `reference numerique de caractere invalide (&${ref};)`);
        }
        rempl = String.fromCodePoint(n);
      }
    } else if (/^[A-Za-z_][A-Za-z0-9._-]*$/.test(ref)) {
      rempl = ENTITES[ref] ?? null;
      if (rempl === null) throw new ErreurXml("ENTITE_REFUSEE", `entite « &${ref}; » refusee : seules les cinq entites predefinies sont admises`);
    }
    if (rempl === null) { i = s.indexOf("&", i + 1); continue; }
    sortie += s.slice(debut, i) + rempl;
    debut = pv + 1;
    i = s.indexOf("&", debut);
  }
  return sortie + s.slice(debut);
}

const estBlanc = (c: number) => c === 32 || c === 10 || c === 13 || c === 9;
/** Vrai si la sous-chaine [debut, fin[ contient autre chose que des blancs. */
function aDuTexte(s: string, debut: number, fin: number): boolean {
  for (let k = debut; k < fin; k++) if (!estBlanc(s.charCodeAt(k))) return true;
  return false;
}

/** Caractere admis dans un nom de balise ou d'attribut (apres le premier). */
function estCarNom(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 46 || c === 95 || c === 58 || c === 45;
}
function estDebutNom(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 58;
}

function nomLocal(nom: string): string {
  const i = nom.lastIndexOf(":");
  return i < 0 ? nom : nom.slice(i + 1);
}

const AUCUN_ATTRIBUT: Readonly<Record<string, string>> = Object.freeze({});
const AUCUN_ENFANT: readonly NoeudXml[] = Object.freeze([]);

interface NoeudInterne { nom: string; attrs: Readonly<Record<string, string>>; enfants: NoeudXml[] | readonly NoeudXml[]; texte: string }

/** Analyse un document XML et rend son element racine. */
export function lireXml(texte: string, options: { profondeurMax?: number; elementsMax?: number; attributsMax?: number } = {}): NoeudXml {
  const profondeurMax = options.profondeurMax ?? PROFONDEUR_XML_MAX;
  const elementsMax = options.elementsMax ?? ELEMENTS_XML_MAX;
  const attributsMax = options.attributsMax ?? ATTRIBUTS_XML_MAX;
  const n = texte.length;
  const pile: NoeudInterne[] = [];
  let racine: NoeudInterne | null = null;
  let nbElements = 0;
  let nbAttributs = 0;
  let i = 0;

  while (i < n) {
    const lt = texte.indexOf("<", i);
    if (lt < 0) {
      if (pile.length > 0) throw new ErreurXml("XML_INVALIDE", "document tronque : balise non fermee");
      if (aDuTexte(texte, i, n)) throw new ErreurXml("XML_INVALIDE", "texte en dehors de l'element racine");
      break;
    }
    if (lt > i && aDuTexte(texte, i, lt)) {
      // Les blancs entre balises n'apportent rien (et gonfleraient la memoire sur un fichier de 25 Mo).
      if (pile.length === 0) throw new ErreurXml("XML_INVALIDE", "texte en dehors de l'element racine");
      pile[pile.length - 1].texte += decoderEntites(texte.slice(i, lt));
    }
    const c1 = texte.charCodeAt(lt + 1);

    // Declaration, instruction de traitement.
    if (c1 === 63 /* ? */) {
      const fin = texte.indexOf("?>", lt + 2);
      if (fin < 0) throw new ErreurXml("XML_INVALIDE", "instruction de traitement non terminee");
      i = fin + 2;
      continue;
    }
    if (c1 === 33 /* ! */) {
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
      // <!DOCTYPE, <!ENTITY, <!ELEMENT, <!ATTLIST... : aucune declaration de type de document n'est admise.
      throw new ErreurXml("DTD_REFUSEE", "declaration de type de document (DTD, DOCTYPE, ENTITY) refusee");
    }

    // Balise fermante.
    if (c1 === 47 /* / */) {
      const gt = texte.indexOf(">", lt + 2);
      if (gt < 0) throw new ErreurXml("XML_INVALIDE", "balise fermante non terminee");
      let fin = gt;
      while (fin > lt + 2 && estBlanc(texte.charCodeAt(fin - 1))) fin--;
      const nom = nomLocal(texte.slice(lt + 2, fin));
      const courant = pile.pop();
      if (!courant || courant.nom !== nom) throw new ErreurXml("XML_INVALIDE", `balise fermante inattendue </${nom.slice(0, 40)}>`);
      i = gt + 1;
      continue;
    }

    // Balise ouvrante : nom.
    if (!estDebutNom(c1)) throw new ErreurXml("XML_INVALIDE", "nom de balise invalide");
    let k = lt + 2;
    while (k < n && estCarNom(texte.charCodeAt(k))) k++;
    if (k - (lt + 1) > NOM_XML_MAX) throw new ErreurXml("XML_INVALIDE", `nom de balise de plus de ${NOM_XML_MAX} caracteres`);
    const nomBrut = texte.slice(lt + 1, k);
    nbElements++;
    if (nbElements > elementsMax) throw new ErreurXml("XML_TROP_VOLUMINEUX", `plus de ${elementsMax} elements XML`);

    // Attributs.
    let attrs: Record<string, string> | null = null;
    let nbAttrsElement = 0;
    let autoFermante = false;
    for (;;) {
      while (k < n && estBlanc(texte.charCodeAt(k))) k++;
      if (k >= n) throw new ErreurXml("XML_INVALIDE", "balise ouvrante non terminee");
      const c = texte.charCodeAt(k);
      if (c === 62 /* > */) { k++; break; }
      if (c === 47 /* / */) {
        if (texte.charCodeAt(k + 1) !== 62) throw new ErreurXml("XML_INVALIDE", "balise auto-fermante mal formee");
        autoFermante = true;
        k += 2;
        break;
      }
      if (!estDebutNom(c)) throw new ErreurXml("XML_INVALIDE", "attribut mal forme dans une balise");
      const debutNom = k;
      while (k < n && estCarNom(texte.charCodeAt(k))) k++;
      if (k - debutNom > NOM_XML_MAX) throw new ErreurXml("XML_INVALIDE", `nom d'attribut de plus de ${NOM_XML_MAX} caracteres`);
      const nomAttr = texte.slice(debutNom, k);
      while (k < n && estBlanc(texte.charCodeAt(k))) k++;
      if (texte.charCodeAt(k) !== 61 /* = */) throw new ErreurXml("XML_INVALIDE", "attribut sans valeur dans une balise");
      k++;
      while (k < n && estBlanc(texte.charCodeAt(k))) k++;
      const guillemet = texte.charCodeAt(k);
      if (guillemet !== 34 && guillemet !== 39) throw new ErreurXml("XML_INVALIDE", "valeur d'attribut sans guillemets");
      const finValeur = texte.indexOf(guillemet === 34 ? '"' : "'", k + 1);
      if (finValeur < 0) throw new ErreurXml("XML_INVALIDE", "valeur d'attribut non terminee");
      nbAttrsElement++;
      nbAttributs++;
      if (nbAttrsElement > ATTRIBUTS_PAR_ELEMENT_MAX) throw new ErreurXml("XML_TROP_VOLUMINEUX", `plus de ${ATTRIBUTS_PAR_ELEMENT_MAX} attributs sur un element`);
      if (nbAttributs > attributsMax) throw new ErreurXml("XML_TROP_VOLUMINEUX", `plus de ${attributsMax} attributs XML`);
      // Les declarations d'espaces de noms ne portent aucune donnee ici ; `__proto__` n'est jamais pose.
      if (nomAttr !== "xmlns" && !nomAttr.startsWith("xmlns:") && nomAttr !== "__proto__") {
        (attrs ??= {})[nomLocal(nomAttr)] = decoderEntites(texte.slice(k + 1, finValeur));
      }
      k = finValeur + 1;
    }

    const noeud: NoeudInterne = { nom: nomLocal(nomBrut), attrs: attrs ?? AUCUN_ATTRIBUT, enfants: AUCUN_ENFANT, texte: "" };
    if (pile.length > 0) {
      const parent = pile[pile.length - 1];
      if (parent.enfants === AUCUN_ENFANT) parent.enfants = [noeud as NoeudXml];
      else (parent.enfants as NoeudXml[]).push(noeud as NoeudXml);
    } else if (racine) throw new ErreurXml("XML_INVALIDE", "plusieurs elements racine");
    else racine = noeud;
    if (!autoFermante) {
      if (pile.length >= profondeurMax) throw new ErreurXml("XML_TROP_PROFOND", `imbrication de plus de ${profondeurMax} niveaux`);
      pile.push(noeud);
    }
    i = k;
  }
  if (pile.length > 0) throw new ErreurXml("XML_INVALIDE", "document tronque : balise non fermee");
  if (!racine) throw new ErreurXml("XML_INVALIDE", "aucun element racine");
  return racine as NoeudXml;
}
