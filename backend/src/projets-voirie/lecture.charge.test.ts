import { describe, expect, it } from "vitest";
import { ErreurLecture, lireFichier } from "./lecture.noyau";
import { ELEMENTS_XML_MAX, ErreurXml, lireXml } from "./xml.noyau";

/**
 * NON-REGRESSION DU COUT DE LECTURE (revue de securite, M1 et M3). Un fichier abusif ne doit jamais occuper le fil principal de
 * Node (tout le serveur, tous modules) plus d'une seconde.
 *
 * Avant correction (mesures du 01/11/2026, poste de developpement) : 80 000 espaces dans `<coordinates>` : 8 a 29 s ; 3 000 000
 * d'elements : 10 s et 586 Mo ; 50 000 objets legitimes : 2,7 s. Apres : quelques millisecondes, et un fichier de 50 000 objets
 * se lit en une fraction de seconde sur un poste normal.
 *
 * CALIBRAGE : les delais sont ecrits pour un poste normal. Sur un poste charge ou bride (CI, portable sur batterie), ils sont
 * multiplies par le rapport entre la duree d'une boucle de reference et sa duree attendue, de sorte que le test mesure la
 * COMPLEXITE de la lecture et non la vitesse de la machine. Le facteur est affiche.
 */
function facteurMachine(): number {
  const t = performance.now();
  let s = 0;
  for (let i = 0; i < 3e7; i++) s += i;
  if (s < 0) throw new Error("jamais");
  // Environ 30 ms sur un poste normal.
  return Math.max(1, (performance.now() - t) / 30);
}
const F = facteurMachine();
const LIMITE_MS = 1000 * F;
console.log(`[lecture.charge] facteur machine ${F.toFixed(1)} (limite effective ${LIMITE_MS.toFixed(0)} ms)`);

const kml = (corps: string) => Buffer.from(`<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>${corps}</Document></kml>`);
const pm = (c: string) => `<Placemark><name>n</name><LineString><coordinates>${c}</coordinates></LineString></Placemark>`;

function mesurer(f: () => unknown): { ms: number; code: string | null } {
  const t = performance.now();
  let code: string | null = null;
  try { f(); } catch (e) {
    if (e instanceof ErreurLecture || e instanceof ErreurXml) code = e.code; else throw e;
  }
  return { ms: performance.now() - t, code };
}

describe("M1 : <coordinates> pathologiques, lecture lineaire", () => {
  it("80 000 espaces dans <coordinates> : lu sans delai", () => {
    const r = mesurer(() => lireFichier(kml(pm(`-10.1,9.2${" ".repeat(80_000)}-10.09,9.2`)), "a.kml"));
    expect(r.code).toBeNull();
    expect(r.ms).toBeLessThan(LIMITE_MS);
  });

  it("80 000 espaces entre des tuples valides : lu sans delai, geometrie correcte", () => {
    const sep = " ".repeat(80_000);
    let objets = 0;
    const r = mesurer(() => { objets = lireFichier(kml(pm(`-10.1,9.2${sep}-10.09,9.2${sep}-10.08,9.2`)), "a.kml").objets.length; });
    expect(r.ms).toBeLessThan(LIMITE_MS);
    expect(objets).toBe(1);
  });

  it("1 million de separateurs « , » : refuse (champs vides), sans delai", () => {
    const r = mesurer(() => lireFichier(kml(pm("-10.1" + " , ".repeat(333_333) + "9.2 -10.09,9.2")), "a.kml"));
    expect(r.ms).toBeLessThan(LIMITE_MS);
    expect(r.code).not.toBeNull();
  });

  it("un nombre de 1 million de chiffres est illisible (NaN), sans le convertir : GEOMETRIE_INVALIDE", () => {
    const r = mesurer(() => lireFichier(kml(pm(`-10.${"1".repeat(1_000_000)},9.2 -10.09,9.2`)), "a.kml"));
    expect(r.ms).toBeLessThan(LIMITE_MS);
    expect(r.code).toBe("GEOMETRIE_INVALIDE");
  });

  it("des retours a la ligne et tabulations a la place des espaces donnent le meme resultat", () => {
    const r = lireFichier(kml(pm("-10.1,9.2\r\n\t -10.09 ,\n 9.2 \t-10.08, 9.2")), "a.kml");
    expect(r.objets[0].geometrie).toEqual({ type: "LineString", coordinates: [[-10.1, 9.2], [-10.09, 9.2], [-10.08, 9.2]] });
  });
});

describe("M3 : lecteur XML borne et lineaire", () => {
  it("plus d'elements que la borne : XML_TROP_VOLUMINEUX, sans delai", () => {
    const r = mesurer(() => lireXml("<kml>" + "<a/>".repeat(ELEMENTS_XML_MAX + 1) + "</kml>"));
    expect(r.code).toBe("XML_TROP_VOLUMINEUX");
    expect(r.ms).toBeLessThan(LIMITE_MS);
  });

  it("3 millions d'elements (le cas de la revue) : refuse en moins d'une seconde, sans exploser la memoire", () => {
    const avant = process.memoryUsage().heapUsed;
    const r = mesurer(() => lireFichier(kml("<a/>".repeat(3_000_000)), "a.kml"));
    expect(r.code).toBe("XML_TROP_VOLUMINEUX");
    expect(r.ms).toBeLessThan(LIMITE_MS);
    // Le refus survient a la borne : environ 1,2 million de noeuds au plus (a ~100 octets), bien en deca des 586 Mo constates.
    expect(process.memoryUsage().heapUsed - avant).toBeLessThan(400 * 1024 * 1024);
  });

  it("un million d'attributs sur un element, ou 65 attributs, sont refuses", () => {
    const beaucoup = Array.from({ length: 1_000_000 }, (_, i) => `a${i}="1"`).join(" ");
    const r = mesurer(() => lireXml(`<kml><Placemark ${beaucoup}/></kml>`));
    expect(r.code).toBe("XML_TROP_VOLUMINEUX");
    expect(r.ms).toBeLessThan(LIMITE_MS);
    const soixanteCinq = Array.from({ length: 65 }, (_, i) => `a${i}="1"`).join(" ");
    expect(mesurer(() => lireXml(`<kml><p ${soixanteCinq}/></kml>`)).code).toBe("XML_TROP_VOLUMINEUX");
    const soixanteQuatre = Array.from({ length: 64 }, (_, i) => `a${i}="1"`).join(" ");
    expect(mesurer(() => lireXml(`<kml><p ${soixanteQuatre}/></kml>`)).code).toBeNull();
  });

  it("attributs repartis sur des millions d'elements : refuse a la borne des attributs", () => {
    const r = mesurer(() => lireXml("<kml>" + '<a x="1" y="2" z="3"/>'.repeat(600_000) + "</kml>", { elementsMax: 10_000_000 }));
    expect(r.code).toBe("XML_TROP_VOLUMINEUX");
    expect(r.ms).toBeLessThan(LIMITE_MS * 2);
  });

  it("profondeur d'un million de niveaux : XML_TROP_PROFOND, sans delai ni pile epuisee", () => {
    const r = mesurer(() => lireXml("<a>".repeat(1_000_000)));
    expect(r.code).toBe("XML_TROP_PROFOND");
    expect(r.ms).toBeLessThan(LIMITE_MS);
  });

  it("noms de balise et d'attribut demesures : XML_INVALIDE", () => {
    expect(mesurer(() => lireXml(`<${"a".repeat(1_000_000)}/>`)).code).toBe("XML_INVALIDE");
    expect(mesurer(() => lireXml(`<a ${"b".repeat(1_000_000)}="1"/>`)).code).toBe("XML_INVALIDE");
  });

  it("un attribut `__proto__` n'est jamais pose, une valeur d'attribut peut contenir « > » et des entites", () => {
    const r = lireXml(`<a __proto__="x" b="1 &gt; 0 &amp; 2" xmlns:g="http://exemple.invalid"/>`);
    expect(Object.keys(r.attrs)).toEqual(["b"]);
    expect(r.attrs.b).toBe("1 > 0 & 2");
    expect(Object.getPrototypeOf(r.attrs)).toBe(Object.prototype);
  });

  it("une entite sans point-virgule ou une esperluette isolee reste du texte ; une entite inconnue est refusee", () => {
    expect(lireXml("<a>a & b &c d</a>").texte).toBe("a & b &c d");
    expect(() => lireXml("<a>&nbsp;</a>")).toThrow(/entite/);
    expect(lireXml("<a>&#233;&#x41;</a>").texte).toBe("éA");
  });
});

describe("fichier legitime : 50 000 objets", () => {
  it("50 000 Placemark de 3 sommets (environ 6 Mo) : lus en moins d'une seconde (poste normal)", () => {
    const doc = kml(pm("-10.1,9.2,0 -10.09,9.2,0 -10.08,9.21,0").repeat(50_000));
    expect(doc.length).toBeGreaterThan(6_000_000);
    let nb = 0;
    const r = mesurer(() => { nb = lireFichier(doc, "a.kml").resume.nbObjets; });
    console.log(`[lecture.charge] 50 000 objets (${(doc.length / 1e6).toFixed(1)} Mo) : ${r.ms.toFixed(0)} ms, facteur ${F.toFixed(1)}`);
    expect(nb).toBe(50_000);
    expect(r.ms).toBeLessThan(LIMITE_MS);
  }, 120_000);

  it("50 000 Placemark portant 6 donnees etendues chacun restent sous la borne d'elements", () => {
    const ed = "<ExtendedData>" + Array.from({ length: 6 }, (_, i) => `<Data name="a${i}"><value>v${i}</value></Data>`).join("") + "</ExtendedData>";
    const doc = kml(`<Placemark><name>n</name>${ed}<LineString><coordinates>-10.1,9.2 -10.09,9.2</coordinates></LineString></Placemark>`.repeat(50_000));
    let nb = 0;
    const r = mesurer(() => { nb = lireFichier(doc, "a.kml").resume.nbObjets; });
    expect(nb).toBe(50_000);
    expect(r.ms).toBeLessThan(LIMITE_MS * 3);
  }, 120_000);
});
