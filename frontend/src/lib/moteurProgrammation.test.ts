import { describe, expect, it } from "vitest";
import { chiffresGnf, diagnostiquerSansRetenue, empreinteCourte, enMilliards, formaterGnf, type FacteurTrace, type LigneScenario } from "./moteurProgrammation";

/**
 * Moteur de programmation, helpers de l'ecran : ce que ces tests defendent.
 *   - un montant en GNF reste une chaine de chiffres (jamais converti en nombre, 18 chiffres au plus) ;
 *   - une saisie invalide est REFUSEE (null), jamais corrigee en silence ni lue comme zero ;
 *   - un resultat sans ligne retenue s'explique : motif, facteurs disponibles, minimum requis, facteurs absents.
 */
describe("chiffresGnf", () => {
  it("accepte des chiffres, avec ou sans espaces, et retire les zeros de tete", () => {
    expect(chiffresGnf("5000000000")).toBe("5000000000");
    expect(chiffresGnf("5 000 000 000")).toBe("5000000000");
    expect(chiffresGnf("5 000 000")).toBe("5000000");
    expect(chiffresGnf("0007")).toBe("7");
  });
  it("0 est une saisie valide (rien cette annee-la), pas une absence", () => {
    expect(chiffresGnf("0")).toBe("0");
    expect(chiffresGnf("000")).toBe("0");
  });
  it("refuse le vide, les decimales, les signes, les lettres et plus de 18 chiffres", () => {
    for (const s of ["", " ", "12,5", "12.5", "-5", "+5", "5 Md", "1e9", "1234567890123456789"]) expect(chiffresGnf(s), s).toBeNull();
  });
  it("garde les derniers chiffres au-dela de 2^53 : aucune conversion en nombre", () => {
    expect(chiffresGnf("9007199254740993")).toBe("9007199254740993");
    expect(formaterGnf("9007199254740993").replace(/\s/g, " ")).toBe("9 007 199 254 740 993 GNF");
  });
});

describe("formaterGnf et enMilliards", () => {
  it("une valeur absente se dit, elle n'est pas un zero", () => {
    expect(formaterGnf(null)).toBe("non renseigné");
    expect(formaterGnf(undefined)).toBe("non renseigné");
    expect(formaterGnf("0").replace(/\s/g, " ")).toBe("0 GNF");
  });
  it("lit une enveloppe en milliards sans flottant", () => {
    expect(enMilliards("5000000000").replace(/\s/g, " ")).toBe("5 Md GNF");
    expect(enMilliards("4400000000").replace(/\s/g, " ")).toBe("4,40 Md GNF");
    expect(enMilliards("800000000").replace(/\s/g, " ")).toBe("800 000 000 GNF");
  });
});

describe("empreinteCourte", () => {
  it("abrege une empreinte SHA-256 pour la table, pas pour la verification", () => {
    expect(empreinteCourte("a".repeat(64))).toBe(`${"a".repeat(8)}…${"a".repeat(8)}`);
    expect(empreinteCourte("abc")).toBe("abc");
  });
});

const facteur = (f: string, disponible: boolean, note = ""): FacteurTrace => ({ facteur: f, poids: 10, disponible, valeur: disponible ? 50 : null, brut: null, origine: null, note });
function ligneFacteurs(id: string, dispo: string[]): LigneScenario {
  const tous = ["ETAT", "TRAFIC_IMPORTANCE", "SECURITE", "CLIMAT", "POPULATION"];
  const facteurs = tous.map((f) => facteur(f, dispo.includes(f), dispo.includes(f) ? "ok" : `${f} sans source`));
  return {
    troncon: { id, code: `T-${id}`, nom: null, regionId: 1, classe: "RN", revetement: "BITUME", etat: "MAUVAIS", longueurM: 1000, longueurOrigine: "LONGUEUR_KM" },
    decision: "ECARTEE", rangPriorite: null, rangRetenu: null,
    motifExclusion: { code: "RISQUE_NON_CALCULABLE", detail: "FACTEURS_INSUFFISANTS" },
    risque: { ok: false, code: "FACTEURS_INSUFFISANTS", motif: `${dispo.length} facteur(s) disponible(s) sur 5 ponderes, minimum 3`, facteurs },
    projection: null, risqueAttendu: null, traitement: null, cout: null, priorite: null, budget: null, etiquette: "PROVISOIRE, non approuvé", justification: "x",
  };
}

describe("diagnostiquerSansRetenue", () => {
  it("seul l'etat est renseigne : dit le motif, 1 facteur sur 5, minimum 3, il en manque 2 au moins, et les facteurs absents", () => {
    const d = diagnostiquerSansRetenue([ligneFacteurs("a", ["ETAT"]), ligneFacteurs("b", ["ETAT"]), ligneFacteurs("c", ["ETAT"])], 3);
    expect(d.vide).toBe(true);
    expect(d.parMotif).toEqual([{ code: "RISQUE_NON_CALCULABLE", libelle: "Risque non calculable (facteurs manquants)", nb: 3 }]);
    expect(d.facteurs).toMatchObject({ troncons: 3, minimumRequis: 3, disponiblesMin: 1, disponiblesMax: 1, ponderes: 5, manquantAuMoins: 2 });
    expect(d.facteurs!.absents.map((f) => [f.facteur, f.troncons])).toEqual([["CLIMAT", 3], ["POPULATION", 3], ["SECURITE", 3], ["TRAFIC_IMPORTANCE", 3]]);
    expect(d.phrase).toMatch(/Aucun tronçon retenu : les 3 tronçon\(s\) candidat\(s\) sont tous écartés/);
    expect(d.phrase).toMatch(/3 tronçon\(s\) disposent de 1 facteur\(s\) sur 5 pondérés, le minimum requis est 3 : il manque au moins 2 facteur\(s\) par tronçon/);
  });

  it("des disponibilites inegales : « 1 a 2 » facteurs, et le manque se mesure sur le meilleur troncon", () => {
    const d = diagnostiquerSansRetenue([ligneFacteurs("a", ["ETAT"]), ligneFacteurs("b", ["ETAT", "SECURITE"])], 3);
    expect(d.facteurs).toMatchObject({ disponiblesMin: 1, disponiblesMax: 2, manquantAuMoins: 1 });
    expect(d.phrase).toMatch(/de 1 à 2 facteur\(s\)/);
  });

  it("minimum inconnu des parametres : relu dans la phrase du moteur, sinon non affirme", () => {
    expect(diagnostiquerSansRetenue([ligneFacteurs("a", ["ETAT"])], null).facteurs?.minimumRequis).toBe(3);
    const l = ligneFacteurs("a", ["ETAT"]);
    if (!l.risque.ok) l.risque.motif = "phrase sans minimum";
    const d = diagnostiquerSansRetenue([l], null);
    expect(d.facteurs?.minimumRequis).toBeNull();
    expect(d.facteurs?.manquantAuMoins).toBeNull();
    expect(d.phrase).not.toMatch(/minimum requis/);
  });

  it("aucun troncon candidat : le dit au lieu d'une liste vide", () => {
    const d = diagnostiquerSansRetenue([], 3);
    expect(d.vide).toBe(true);
    expect(d.phrase).toMatch(/Aucun tronçon candidat dans ce périmètre/);
  });

  it("des lignes retenues : pas de diagnostic de vide", () => {
    const l = ligneFacteurs("a", ["ETAT"]);
    l.decision = "RETENUE";
    const d = diagnostiquerSansRetenue([l], 3);
    expect(d.vide).toBe(false);
    expect(d.phrase).toBe("");
  });

  it("un autre motif principal est compte et classe (budget insuffisant)", () => {
    const l = ligneFacteurs("a", ["ETAT"]);
    l.risque = { ok: true, score: 50, couverture: 1, facteursDisponibles: 3, facteursPonderes: 5, formule: "f", facteurs: l.risque.facteurs };
    l.motifExclusion = { code: "BUDGET_INSUFFISANT", detail: "d" };
    const d = diagnostiquerSansRetenue([l, l], 3);
    expect(d.parMotif).toEqual([{ code: "BUDGET_INSUFFISANT", libelle: "Budget insuffisant", nb: 2 }]);
    expect(d.facteurs).toBeNull();
    expect(d.phrase).toMatch(/Motif principal : Budget insuffisant \(2\)/);
  });
});
