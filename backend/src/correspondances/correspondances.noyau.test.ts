import { describe, expect, it } from "vitest";
import { METHODES, TYPES_OBJET, verifierConfirmation, verifierProposition, versCsv, type LigneEtat, type LigneExport, type Proposition } from "./correspondances.noyau";

/**
 * Regles pures de la correspondance d'identifiants (A23). Les valeurs ci-dessous sont des JETONS DE TEST sans
 * lien avec un code de l'ONR, de L2R ou d'ANASUR : aucun n'est connu du depot, aucun n'est suppose.
 */
const base: Proposition = {
  systemeSource: "SYSTEME_TEST", typeObjet: "TRONCON", identifiantSource: "src-1", identifiantCible: "cible-1",
  methode: "CODE_ROUTE_NOMENCLATURE", score: 0.9, valideDu: "2026-01-01",
};
const code = (p: Partial<Proposition>) => { const v = verifierProposition({ ...base, ...p }); return v.ok ? "OK" : v.code; };

describe("verifierProposition", () => {
  it("accepte une proposition coherente pour chacune des cinq methodes", () => {
    expect(code({})).toBe("OK");
    expect(code({ methode: "IDENTIFIANT_OFFICIEL", score: 1 })).toBe("OK");
    expect(code({ methode: "GEOMETRIE_CALCULEE", score: 0.7, tolerancesM: { bufferM: 10 } })).toBe("OK");
    expect(code({ methode: "CORROBORATION", score: 0.6, attributsCorroborants: { longueurKm: [2.1, 2.2] } })).toBe("OK");
    expect(code({ methode: "REVUE_HUMAINE", score: 0.5, decisionMotif: "Releve sur place" })).toBe("OK");
  });

  it("refuse un systeme, un type ou une methode hors forme", () => {
    expect(code({ systemeSource: "onr bdr" })).toBe("SYSTEME_INVALIDE");
    expect(code({ systemeSource: "A" })).toBe("SYSTEME_INVALIDE");
    expect(code({ typeObjet: "ROUTE" })).toBe("TYPE_INCONNU");
    expect(code({ methode: "NOM_SEUL" })).toBe("METHODE_INCONNUE");
    expect(code({ methode: "PROXIMITE" })).toBe("METHODE_INCONNUE");
  });

  it("n'offre aucune methode fondee sur le seul nom ou la seule proximite", () => {
    expect(METHODES.some((m) => /^NOM$|NOM_SEUL|PROXIMITE/.test(m))).toBe(false);
    expect([...TYPES_OBJET]).toEqual(["TRONCON", "PORTION", "OUVRAGE", "DEFAUT"]);
  });

  it("refuse un identifiant vide, y compris blanc, sans jamais le retoucher", () => {
    expect(code({ identifiantSource: "" })).toBe("SOURCE_VIDE");
    expect(code({ identifiantSource: "   " })).toBe("SOURCE_VIDE");
    expect(code({ identifiantCible: " " })).toBe("CIBLE_VIDE");
    // un identifiant avec espaces significatifs est accepte tel quel : « tel que recu, jamais retouche »
    expect(code({ identifiantSource: " A 12 " })).toBe("OK");
  });

  it("reserve le score 1 a l'identifiant officiel, et exige 1 pour lui", () => {
    expect(code({ score: 1 })).toBe("SCORE_UN_RESERVE");
    expect(code({ methode: "IDENTIFIANT_OFFICIEL", score: 0.99 })).toBe("SCORE_OFFICIEL_ATTENDU");
    expect(code({ score: 1.1 })).toBe("SCORE_HORS_BORNES");
    expect(code({ score: -0.1 })).toBe("SCORE_HORS_BORNES");
    expect(code({ score: Number.NaN })).toBe("SCORE_HORS_BORNES");
    expect(code({ score: 0.1234 })).toBe("SCORE_PRECISION");
  });

  it("exige les tolerances (etape 3), les attributs (etape 4) et le motif (etape 5)", () => {
    expect(code({ methode: "GEOMETRIE_CALCULEE", score: 0.7 })).toBe("TOLERANCES_REQUISES");
    expect(code({ methode: "GEOMETRIE_CALCULEE", score: 0.7, tolerancesM: {} })).toBe("TOLERANCES_REQUISES");
    expect(code({ methode: "CORROBORATION", score: 0.6 })).toBe("ATTRIBUTS_REQUIS");
    expect(code({ methode: "REVUE_HUMAINE", score: 0.5 })).toBe("MOTIF_REQUIS");
    expect(code({ methode: "REVUE_HUMAINE", score: 0.5, decisionMotif: "  " })).toBe("MOTIF_REQUIS");
  });

  it("refuse les dates impossibles et une periode vide (semi-ouverte)", () => {
    expect(code({ valideDu: "2026-02-30" })).toBe("DATE_INVALIDE");
    expect(code({ valideDu: "01/01/2026" })).toBe("DATE_INVALIDE");
    expect(code({ valideAu: "2026-01-01" })).toBe("PERIODE_VIDE");
    expect(code({ valideAu: "2025-12-31" })).toBe("PERIODE_VIDE");
    expect(code({ valideAu: "2026-06-01" })).toBe("OK");
  });
});

describe("verifierConfirmation", () => {
  const ligne: LigneEtat = { statut: "A_CONFIRMER", versionFermeture: null, proposeParId: "u-prop", methode: "GEOMETRIE_CALCULEE" };
  const c = (l: Partial<typeof ligne>, qui = "u-autre", motif: string | null = "Verifie") => { const v = verifierConfirmation({ ...ligne, ...l }, qui, motif); return v.ok ? "OK" : v.code; };

  it("accepte la decision d'une autre personne, motivee", () => { expect(c({})).toBe("OK"); });
  it("refuse l'auto-confirmation (403)", () => {
    expect(c({}, "u-prop")).toBe("AUTO_CONFIRMATION");
    const v = verifierConfirmation(ligne, "u-prop", "x");
    expect(!v.ok && v.http).toBe(403);
  });
  it("refuse une ligne fermee, deja confirmee, ou sans motif", () => {
    expect(c({ versionFermeture: 4 })).toBe("CORRESPONDANCE_FERMEE");
    expect(c({ statut: "CONFIRMEE" })).toBe("DEJA_CONFIRMEE");
    expect(c({}, "u-autre", null)).toBe("MOTIF_REQUIS");
    expect(c({}, "u-autre", "  ")).toBe("MOTIF_REQUIS");
  });
});

describe("versCsv", () => {
  const l = (o: Partial<LigneExport>): LigneExport => ({
    systemeSource: "SYSTEME_TEST", typeObjet: "TRONCON", identifiantSource: "a", identifiantCible: "t1", methode: "CODE_ROUTE_NOMENCLATURE",
    score: "0.900", statut: "A_CONFIRMER", valideDu: "2026-01-01", valideAu: null, versionOuverture: 1, ...o,
  });

  it("est deterministe : meme contenu dans un autre ordre, memes octets et meme empreinte", () => {
    const a = versCsv([l({ identifiantSource: "b" }), l({ identifiantSource: "a" })], 3);
    const b = versCsv([l({ identifiantSource: "a" }), l({ identifiantSource: "b" })], 3);
    expect(a.texte).toBe(b.texte);
    expect(a.empreinteSha256).toBe(b.empreinteSha256);
    expect(a.empreinteSha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("porte la version dans son en-tete et la fait compter dans l'empreinte", () => {
    const v3 = versCsv([l({})], 3), v4 = versCsv([l({})], 4);
    expect(v3.texte.startsWith("# versionTable=3\n")).toBe(true);
    expect(v3.empreinteSha256).not.toBe(v4.empreinteSha256);
  });
  it("conserve le score tel que la base le rend (aucun arrondi) et echappe les separateurs", () => {
    const { texte } = versCsv([l({ score: "0.050", identifiantSource: 'a;"b"' })], 1);
    expect(texte).toContain(";0.050;");
    expect(texte).toContain('"a;""b"""');
  });
  it("une table vide donne l'en-tete seul (version 0 = avant toute saisie)", () => {
    expect(versCsv([], 0).texte).toBe("# versionTable=0\nsysteme_source;type_objet;identifiant_source;identifiant_cible;methode;score;statut;valide_du;valide_au;version_ouverture\n");
  });
});
