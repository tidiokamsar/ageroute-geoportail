import { describe, expect, it } from "vitest";
import { construireXml, echapper, emprisePlausible, lacunes, type Contexte, type FicheJeu } from "./iso19115.noyau";

/**
 * Ce que ces tests defendent :
 *   - le document est BIEN FORME et ses elements suivent l'ordre que le schema ISO 19139 prescrit ;
 *   - une valeur non arretee sort en gco:nilReason et figure dans les lacunes : jamais inventee ;
 *   - tout texte venu d'une fiche est echappe (un titre avec `<` ou `&` ne casse pas le document) ;
 *   - une etendue incoherente n'est jamais publiee.
 * La validation contre les XSD n'est PAS faite ici : aucun schema n'est disponible hors ligne.
 */

const FICHE: FicheJeu = {
  id: "troncons", titre: "Reseau & <routes> \"classe\"", resume: "Resume d'un jeu", motsCles: ["a", "b&c"],
  categorie: "transportation",
  acces: { chemin: "/api/public/carte/geo", format: "JSON", nom: "Carte" },
  genealogie: "Genealogie.", conditions: null, attribution: null,
};
const COMPLET: Contexte = {
  organisme: "AGEROUTE Guinee", courriel: "meta@exemple.org", baseUrl: "https://carte.exemple.org",
  dateFiche: "2026-10-22", emprise: { ouest: -15.1, est: -7.6, sud: 7.2, nord: 12.7 }, derniereRevision: "2026-10-20",
};
const VIDE: Contexte = { ...COMPLET, courriel: null, baseUrl: null, emprise: null, derniereRevision: null };

/** Controle de bonne formation minimal : pile de balises, attributs entre guillemets, prefixes declares. */
function bienForme(xml: string): string[] {
  const erreurs: string[] = [];
  const corps = xml.replace(/^<\?xml[^>]*\?>\s*/, "");
  const prefixes = new Set(["xml", "xmlns"]);
  for (const m of corps.matchAll(/xmlns:(\w+)=/g)) prefixes.add(m[1]);
  const pile: string[] = [];
  const re = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>/g;
  let dernier = 0;
  for (let m = re.exec(corps); m; m = re.exec(corps)) {
    const hors = corps.slice(dernier, m.index);
    if (/[<]/.test(hors)) erreurs.push(`'<' hors balise pres de "${hors.slice(0, 30)}"`);
    if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/.test(hors)) erreurs.push(`entite non echappee pres de "${hors.slice(0, 30)}"`);
    dernier = m.index + m[0].length;
    const [, ferme, nom, attrs, auto] = m;
    const prefixe = nom.includes(":") ? nom.split(":")[0] : null;
    if (prefixe && !prefixes.has(prefixe)) erreurs.push(`prefixe non declare : ${prefixe}`);
    for (const a of attrs.matchAll(/([\w.-]+):[\w.-]+=/g)) if (!prefixes.has(a[1])) erreurs.push(`prefixe d'attribut non declare : ${a[1]}`);
    if (auto) continue;
    if (ferme) {
      const attendu = pile.pop();
      if (attendu !== nom) erreurs.push(`fermeture ${nom}, attendu ${attendu}`);
    } else pile.push(nom);
  }
  if (corps.slice(dernier).trim() !== "") erreurs.push("contenu apres la racine");
  if (pile.length) erreurs.push(`balises non fermees : ${pile.join(",")}`);
  return erreurs;
}

/** Position de la premiere occurrence de chaque balise, dans l'ordre demande. */
function dansLOrdre(xml: string, balises: string[]): boolean {
  let pos = -1;
  for (const b of balises) {
    const p = xml.indexOf(`<${b}`, pos + 1);
    if (p === -1 || p < pos) return false;
    pos = p;
  }
  return true;
}

describe("echapper", () => {
  it("echappe les cinq caracteres reserves et retire les caracteres interdits du XML 1.0", () => {
    expect(echapper(`a & b < c > d "e" 'f'`)).toBe("a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;");
    expect(echapper("a\u0000b\u0008c\u000Bd")).toBe("abcd");
    expect(echapper("tab\tet\nsaut")).toBe("tab\tet\nsaut");
  });
});

describe("construireXml", () => {
  it("produit un document bien forme, meme avec des caracteres reserves dans les textes", () => {
    const xml = construireXml(FICHE, COMPLET);
    expect(bienForme(xml)).toEqual([]);
    expect(xml).toContain("Reseau &amp; &lt;routes&gt; &quot;classe&quot;");
    expect(xml).toContain("<gmd:keyword><gco:CharacterString>b&amp;c</gco:CharacterString></gmd:keyword>");
  });

  it("garde bienForme honnete : il detecte une balise non fermee et un '&' nu", () => {
    expect(bienForme("<a:x xmlns:a=\"u\"><a:y></a:x>")).not.toEqual([]);
    expect(bienForme("<a:x xmlns:a=\"u\">A & B</a:x>")).not.toEqual([]);
    expect(bienForme("<a:x>texte</a:x>")).not.toEqual([]); // prefixe non declare
  });

  it("suit l'ordre des elements de l'ISO 19139 (racine, identification, distribution, qualite)", () => {
    const xml = construireXml(FICHE, COMPLET);
    expect(dansLOrdre(xml, [
      "gmd:fileIdentifier", "gmd:language", "gmd:characterSet", "gmd:hierarchyLevel", "gmd:contact", "gmd:dateStamp",
      "gmd:metadataStandardName", "gmd:referenceSystemInfo", "gmd:identificationInfo", "gmd:distributionInfo", "gmd:dataQualityInfo",
    ])).toBe(true);
    expect(dansLOrdre(xml, [
      "gmd:citation", "gmd:abstract", "gmd:pointOfContact", "gmd:descriptiveKeywords", "gmd:resourceConstraints",
      "gmd:spatialRepresentationType", "gmd:language", "gmd:characterSet", "gmd:topicCategory", "gmd:extent",
    ])).toBe(true);
  });

  it("porte les elements du noyau : titre, date, resume, categorie, etendue, contact, langue, genealogie", () => {
    const xml = construireXml(FICHE, COMPLET);
    expect(xml).toContain("<gmd:topicCategory><gmd:MD_TopicCategoryCode>transportation</gmd:MD_TopicCategoryCode>");
    expect(xml).toContain("<gco:Date>2026-10-20</gco:Date>");
    expect(xml).toContain('codeListValue="revision"');
    expect(xml).toContain('codeListValue="fre"');
    expect(xml).toContain("<gmd:westBoundLongitude><gco:Decimal>-15.1</gco:Decimal>");
    expect(xml).toContain("<gmd:code><gco:CharacterString>4326</gco:CharacterString>");
    expect(xml).toContain("<gmd:linkage><gmd:URL>https://carte.exemple.org/api/public/carte/geo</gmd:URL>");
    expect(xml).toContain("<gmd:statement><gco:CharacterString>Genealogie.</gco:CharacterString>");
    expect(xml).toContain("meta@exemple.org");
    expect(xml).toContain("<gmd:dateStamp><gco:Date>2026-10-22</gco:Date>");
  });

  it("n'invente rien : sans courriel, adresse, etendue, date ni licence, le document dit nilReason", () => {
    const xml = construireXml(FICHE, VIDE);
    expect(bienForme(xml)).toEqual([]);
    expect(xml).toContain('<gmd:electronicMailAddress gco:nilReason="unknown"/>');
    expect(xml).toContain('<gmd:otherConstraints gco:nilReason="unknown"/>');
    expect(xml).toContain('<gmd:extent gco:nilReason="unknown"/>');
    expect(xml).toContain('<gmd:date gco:nilReason="missing"/>');
    expect(xml).not.toContain("<gmd:distributionInfo>");
    expect(xml).not.toContain("@");
    expect(xml).not.toContain("<gmd:URL>");
  });

  it("n'utilise pas la date du jour comme date de citation quand la revision est inconnue", () => {
    const xml = construireXml(FICHE, { ...COMPLET, derniereRevision: null });
    expect(xml).not.toContain('codeListValue="revision"');
    // La seule date du document est alors le dateStamp (la date de la FICHE, pas celle de la donnee).
    expect((xml.match(/<gco:Date>/g) ?? [])).toHaveLength(1);
  });

  it("refuse de publier une etendue incoherente ou une date de revision impossible", () => {
    for (const emprise of [
      { ouest: 10, est: -10, sud: 0, nord: 1 }, { ouest: -200, est: 0, sud: 0, nord: 1 },
      { ouest: 0, est: 1, sud: 5, nord: 2 }, { ouest: Number.NaN, est: 1, sud: 0, nord: 1 },
    ]) {
      expect(emprisePlausible(emprise)).toBe(false);
      expect(construireXml(FICHE, { ...COMPLET, emprise })).toContain('<gmd:extent gco:nilReason="unknown"/>');
    }
    expect(construireXml(FICHE, { ...COMPLET, derniereRevision: "2026-02-31" })).toContain('<gmd:date gco:nilReason="missing"/>');
    expect(() => construireXml(FICHE, { ...COMPLET, dateFiche: "22/10/2026" })).toThrow(RangeError);
  });

  it("restitue la licence quand elle est arretee, et l'attribution quand le producteur n'est pas l'organisme", () => {
    const xml = construireXml(
      { ...FICHE, conditions: "Reutilisation libre avec mention.", attribution: "Donnees OpenStreetMap" },
      COMPLET,
    );
    expect(xml).toContain("<gmd:otherConstraints><gco:CharacterString>Reutilisation libre avec mention.");
    expect(xml).toContain("<gmd:useLimitation><gco:CharacterString>Donnees OpenStreetMap");
    expect(xml).not.toContain('<gmd:otherConstraints gco:nilReason');
    expect(dansLOrdre(xml, ["gmd:useLimitation", "gmd:accessConstraints", "gmd:otherConstraints"])).toBe(true);
  });
});

describe("lacunes", () => {
  it("liste tout ce qui manque, champ par champ", () => {
    const champs = lacunes(FICHE, VIDE).map((l) => l.champ);
    expect(champs).toEqual(expect.arrayContaining([
      "contact.courriel", "distribution.url", "contraintes.reutilisation", "etendue.geographique", "date.revision", "maintenance.frequence",
    ]));
  });

  it("ne reclame plus ce qui est renseigne, mais garde la licence et la frequence tant qu'elles ne sont pas decidees", () => {
    const champs = lacunes(FICHE, COMPLET).map((l) => l.champ);
    expect(champs).toEqual(["contraintes.reutilisation", "maintenance.frequence"]);
  });

  it("une fiche sans point d'acces le dit", () => {
    expect(lacunes({ ...FICHE, acces: null }, COMPLET).map((l) => l.champ)).toContain("distribution");
  });
});
