import { describe, expect, it } from "vitest";
import { decouperEnregistrementsCsv, ecrireCsv, lireCsv, verifierLigne, type LignePivot } from "./pivot.noyau";

/**
 * Forme du CSV : ce qui doit rester UNE ligne, et ce qui ne doit JAMAIS passer en silence.
 *
 * CRITERE A28 : 100 % des lignes dans un statut. Une ligne coupee en deux par un saut de ligne
 * dans un champ cite, ou jetee par un champ en trop, est une ligne que le lot ne compte pas comme
 * elle est. Eprouve en base par `tests-integration/import.integration.mts`.
 */
const ENTETE = "systeme_source;type_objet;identifiant_source;commentaire";

describe("enregistrements CSV (RFC 4180)", () => {
  it("un saut de ligne dans un champ cite fait partie de l'enregistrement", () => {
    const e = decouperEnregistrementsCsv('a;"x\ny";c\nd;e;f\n');
    expect(e.map((x) => x.texte)).toEqual(['a;"x\ny";c', "d;e;f"]);
  });

  it("CRLF et LF donnent les memes enregistrements, y compris dans un champ cite", () => {
    const lf = decouperEnregistrementsCsv('a;"x\ny"\nb\n').map((x) => x.texte);
    const crlf = decouperEnregistrementsCsv('a;"x\ny"\r\nb\r\n').map((x) => x.texte);
    // Le saut DANS le champ cite est conserve tel quel ; seul le saut de fin d'enregistrement perd son \r.
    expect(crlf).toEqual(lf);
  });

  it("un guillemet double dans un champ cite ne rouvre pas le champ", () => {
    const { lignes } = lireCsv(`${ENTETE}\nONR;comptage;A;"il dit ""bonjour"";\nsalut"\nONR;comptage;B;ok\n`);
    expect(lignes).toHaveLength(2);
    expect(lignes[0].commentaire).toBe('il dit "bonjour";\nsalut');
  });

  it("un guillemet ouvert jamais referme n'avale pas le reste du fichier", () => {
    const { lignes, anomalies } = lireCsv(`${ENTETE}\nONR;comptage;A;"jamais referme\nONR;comptage;B;ok\nONR;comptage;C;ok\n`);
    expect(lignes).toHaveLength(3);                              // A, B et C : trois lignes, chacune a son statut
    expect(anomalies.get(0)).toMatch(/guillemet ouvert/);
    expect(anomalies.has(1)).toBe(false);
    expect(anomalies.has(2)).toBe(false);
    expect(lignes[1].identifiant_source).toBe("B");
  });

  it("un aller-retour ecrire/lire conserve un commentaire multi-ligne", () => {
    const l: LignePivot = { systemeSource: "ONR", typeObjet: "comptage", identifiantSource: "M", attributs: { commentaire: "ligne 1\nligne 2; avec point-virgule" } };
    const relu = lireCsv(ecrireCsv([l])).lignes;
    expect(relu).toHaveLength(1);
    const v = verifierLigne(relu[0]);
    expect(v.ok && v.ligne.attributs.commentaire).toBe("ligne 1\nligne 2; avec point-virgule");
  });
});

describe("nombre de champs", () => {
  it("un champ EN TROP n'est pas jete en silence : l'enregistrement est signale", () => {
    const { lignes, anomalies } = lireCsv(`${ENTETE}\nONR;comptage;A;ok;en;trop\n`);
    expect(anomalies.get(0)).toMatch(/6 champs pour 4 colonnes/);
    expect(lignes[0]._ligne_brute).toBe("ONR;comptage;A;ok;en;trop");   // la forme brute est conservee
  });

  it("un champ EN MOINS n'est pas complete par du vide : l'enregistrement est signale", () => {
    const { anomalies } = lireCsv(`${ENTETE}\nONR;comptage;A\n`);
    expect(anomalies.get(0)).toMatch(/3 champs pour 4 colonnes/);
  });

  it("une ligne bien formee n'a aucune anomalie, et une colonne vide terminale est un champ", () => {
    const { anomalies } = lireCsv(`${ENTETE}\nONR;comptage;A;\n`);
    expect(anomalies.size).toBe(0);
  });

  it("les lignes vides et les commentaires ne sont pas des enregistrements", () => {
    const { lignes } = lireCsv(`# source\n${ENTETE}\n\n# note\nONR;comptage;A;ok\n\n`);
    expect(lignes).toHaveLength(1);
  });
});
