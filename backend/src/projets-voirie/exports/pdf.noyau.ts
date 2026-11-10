/**
 * PRODUCTEUR DE PDF TEXTE SIMPLE, MINIMAL ET DETERMINISTE (lot X1, fiche projet du dossier technique ; contrat CONTRAT-EXPORTS.md, section 4.2). Sans E/S,
 * sans dependance (aucune bibliotheque PDF n'est dans backend/package.json, et aucune n'est ajoutee).
 *
 * PDF 1.4 : un catalogue, un arbre de pages, deux polices STANDARD (Helvetica et Helvetica-Bold, jamais incorporees : tout lecteur les fournit) en
 * codage WinAnsi, une page A4 par tranche de lignes, un flux de contenu NON compresse par page (lisible, verifiable), un dictionnaire d'information
 * et une table de renvois aux decalages exacts.
 *
 * TEXTE : chaque ligne est normalisee (NFC), codee en WinAnsi (Latin-1 et les signes typographiques de Windows-1252 : apostrophe courbe, guillemets,
 * tirets, points de suspension, euro, oe) ; un caractere non representable devient « ? » ; un caractere de controle devient une espace. Les chaines
 * PDF sont des litterales ou `(`, `)` et `\` sont echappes et tout octet hors ASCII imprimable est ecrit en octal : le fichier ne contient aucune
 * sequence que le texte d'un utilisateur pourrait fermer ou detourner. Les lignes trop longues sont coupees aux espaces (une largeur moyenne de
 * caractere prudente, sans table de metriques).
 * DETERMINISME : memes lignes, meme titre, meme date => memes octets (aucune date courante, aucun identifiant aleatoire).
 */

export interface LignePdf {
  texte: string;
  /** Corps en points (8 a 18 ; defaut 10). */
  taille?: number;
  gras?: boolean;
}

export interface MetaPdf { titre: string; creeLe: Date; producteur?: string }

const LARGEUR_PAGE = 595;
const HAUTEUR_PAGE = 842;
const MARGE = 50;
/** Largeur moyenne d'un caractere en fraction du corps : prudente pour Helvetica (lettres larges comprises) ; le texte ne deborde pas. */
const LARGEUR_CARACTERE = 0.6;

const CP1252: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** Code un texte en octets WinAnsi (un octet par caractere). */
export function versWinAnsi(texte: string): number[] {
  const sortie: number[] = [];
  for (const car of texte.normalize("NFC")) {
    const c = car.codePointAt(0)!;
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c < 0xa0)) sortie.push(0x20);
    else if (c < 0x7f || (c >= 0xa0 && c <= 0xff)) sortie.push(c);
    else sortie.push(CP1252[c] ?? 0x3f);
  }
  return sortie;
}

/** Chaine litterale PDF, entierement en ASCII imprimable : `(`, `)`, `\` echappes, octets hors ASCII en octal. */
export function chaineLitterale(texte: string): string {
  let s = "(";
  for (const o of versWinAnsi(texte)) {
    if (o === 0x28 || o === 0x29 || o === 0x5c) s += `\\${String.fromCharCode(o)}`;
    else if (o >= 0x20 && o < 0x7f) s += String.fromCharCode(o);
    else s += `\\${o.toString(8).padStart(3, "0")}`;
  }
  return `${s})`;
}

/** Coupe une ligne aux espaces pour tenir dans `max` caracteres (un mot plus long est coupe). Une ligne vide reste une ligne vide. */
export function couper(texte: string, max: number): string[] {
  const propre = texte.replace(/[\t\r\n]+/g, " ");
  if (propre.length <= max) return [propre];
  const sortie: string[] = [];
  let courante = "";
  for (const mot of propre.split(" ")) {
    let m = mot;
    while (m.length > max) {
      if (courante) { sortie.push(courante); courante = ""; }
      sortie.push(m.slice(0, max));
      m = m.slice(max);
    }
    if (!courante) courante = m;
    else if (courante.length + 1 + m.length <= max) courante += ` ${m}`;
    else { sortie.push(courante); courante = m; }
  }
  if (courante || sortie.length === 0) sortie.push(courante);
  return sortie;
}

const nombre = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""));
const deux = (n: number) => String(n).padStart(2, "0");
const datePdf = (d: Date): string => `D:${d.getUTCFullYear()}${deux(d.getUTCMonth() + 1)}${deux(d.getUTCDate())}${deux(d.getUTCHours())}${deux(d.getUTCMinutes())}${deux(d.getUTCSeconds())}Z`;

interface Placee { texte: string; taille: number; gras: boolean; y: number }

/** Mise en page : lignes coupees, placees de haut en bas, page suivante quand la marge basse est atteinte. */
export function mettreEnPage(lignes: readonly LignePdf[]): Placee[][] {
  const pages: Placee[][] = [[]];
  let y = HAUTEUR_PAGE - MARGE;
  for (const l of lignes) {
    const taille = Math.min(18, Math.max(8, l.taille ?? 10));
    const interligne = Math.round(taille * 1.35 * 100) / 100;
    const max = Math.max(10, Math.floor((LARGEUR_PAGE - 2 * MARGE) / (taille * LARGEUR_CARACTERE)));
    for (const morceau of couper(l.texte, max)) {
      if (y - interligne < MARGE + 20) { pages.push([]); y = HAUTEUR_PAGE - MARGE; }
      y = Math.round((y - interligne) * 100) / 100;
      pages[pages.length - 1].push({ texte: morceau, taille, gras: l.gras === true, y });
    }
  }
  return pages;
}

/** Produit le PDF. */
export function produirePdf(lignes: readonly LignePdf[], meta: MetaPdf): Buffer {
  const pages = mettreEnPage(lignes);
  const n = pages.length;
  // Numerotation des objets : 1 catalogue, 2 pages, 3 et 4 polices, 5 information, puis (page, contenu) par page.
  const idPage = (i: number) => 6 + 2 * i;
  const idContenu = (i: number) => 7 + 2 * i;
  const objets: string[] = [];
  objets[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objets[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${idPage(i)} 0 R`).join(" ")}] /Count ${n} >>`;
  objets[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objets[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  objets[5] = `<< /Title ${chaineLitterale(meta.titre)} /Producer ${chaineLitterale(meta.producteur ?? "Console BDRI")} /CreationDate (${datePdf(meta.creeLe)}) >>`;
  pages.forEach((page, i) => {
    let flux = "";
    for (const p of page) flux += `BT /${p.gras ? "F2" : "F1"} ${nombre(p.taille)} Tf 1 0 0 1 ${MARGE} ${nombre(p.y)} Tm ${chaineLitterale(p.texte)} Tj ET\n`;
    flux += `BT /F1 8 Tf 1 0 0 1 ${MARGE} ${MARGE - 10} Tm ${chaineLitterale(`Page ${i + 1} / ${n}`)} Tj ET\n`;
    objets[idPage(i)] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${LARGEUR_PAGE} ${HAUTEUR_PAGE}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${idContenu(i)} 0 R >>`;
    objets[idContenu(i)] = `<< /Length ${Buffer.byteLength(flux, "latin1")} >>\nstream\n${flux}endstream`;
  });

  const morceaux: Buffer[] = [Buffer.from("%PDF-1.4\n%", "latin1"), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3]), Buffer.from("\n", "latin1")];
  let position = morceaux.reduce((s, b) => s + b.length, 0);
  const decalages: number[] = [];
  for (let id = 1; id < objets.length; id++) {
    decalages[id] = position;
    const b = Buffer.from(`${id} 0 obj\n${objets[id]}\nendobj\n`, "latin1");
    morceaux.push(b);
    position += b.length;
  }
  const debutXref = position;
  let xref = `xref\n0 ${objets.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objets.length; id++) xref += `${String(decalages[id]).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objets.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${debutXref}\n%%EOF\n`;
  morceaux.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(morceaux);
}
