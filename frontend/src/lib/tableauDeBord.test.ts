import { describe, expect, it } from "vitest";
import {
  aTraiter, emprise, etatAffichage, formaterValeur, grouperChiffres, jourFr, perimetresDistincts, resumeControle,
  texteIndicateur, textePortee, type IndicateurEvalue, type RapportControle,
} from "./tableauDeBord";

/** Espaces fines et insecables ramenees a l'espace, pour comparer sans dependre de l'ICU de la machine. */
const n = (s: string) => s.replace(/\s/g, " ");

const perimetre = { code: "RESEAU_CLASSE_SAISI", libelle: "Réseau classé saisi", definition: "tronçons classés" };
function ind(over: Partial<IndicateurEvalue> = {}): IndicateurEvalue {
  return {
    code: "troncons_classes", libelle: "Tronçons classés", groupe: "reseau", unite: "nombre", perimetre,
    statut: "CALCULE", valeur: 1691, motif: null, aucuneDonnee: false, sourceLibelle: null, ...over,
  };
}

describe("formaterValeur", () => {
  it("entiers en francais, mesures avec unite, part en pourcentage", () => {
    expect(n(formaterValeur(1691, "nombre"))).toBe("1 691");
    expect(n(formaterValeur(21156.6, "km"))).toBe("21 156,6 km");
    expect(n(formaterValeur(0.6587, "part"))).toBe("65,9 %");
  });

  it("un montant en chaine n'est jamais converti en nombre (au-dela de 2^53)", () => {
    expect(n(formaterValeur("9007199254740993", "GNF"))).toBe("9 007 199 254 740 993 GNF");
    expect(grouperChiffres("1000")).toBe(`1${String.fromCharCode(0x202f)}000`);
    expect(grouperChiffres("abc")).toBe("abc");
  });

  it("null se lit « non calculable », jamais « 0 »", () => {
    expect(formaterValeur(null, "part")).toBe("non calculable");
  });
});

describe("etatAffichage et texteIndicateur", () => {
  it("une valeur calculee s'affiche", () => {
    expect(etatAffichage(ind())).toBe("valeur");
    expect(n(texteIndicateur(ind()))).toBe("1 691");
  });

  it("une table source vide dit « aucune donnee » avec sa source, pas 0", () => {
    const i = ind({ valeur: 0, aucuneDonnee: true, sourceLibelle: "main courante" });
    expect(etatAffichage(i)).toBe("aucune-donnee");
    expect(texteIndicateur(i)).toMatch(/^Aucune donnée \(main courante/);
    expect(texteIndicateur(i)).not.toBe("0");
  });

  it("indisponible et erreur ont leur propre texte", () => {
    expect(texteIndicateur(ind({ statut: "INDISPONIBLE", valeur: null }))).toMatch(/Indisponible hors périmètre national/);
    expect(texteIndicateur(ind({ statut: "ERREUR", valeur: null }))).toBe("Calcul en erreur");
  });
});

describe("aTraiter", () => {
  it("seule une valeur positive d'un indicateur de traitement est a traiter ; zero ne l'est pas", () => {
    expect(aTraiter(ind({ code: "trous_de_permanence", valeur: 2 }))).toBe(true);
    expect(aTraiter(ind({ code: "trous_de_permanence", valeur: 0 }))).toBe(false);
    expect(aTraiter(ind({ code: "troncons_classes", valeur: 5 }))).toBe(false);
    expect(aTraiter(ind({ code: "trous_de_permanence", valeur: 2, aucuneDonnee: true }))).toBe(false);
  });
});

describe("textePortee", () => {
  it("national, une region, plusieurs regions", () => {
    expect(textePortee({ national: true, regions: [] })).toMatch(/national/);
    expect(textePortee({ national: false, regions: [{ id: 3, nom: "Kankan" }] })).toMatch(/région Kankan/);
    expect(textePortee({ national: false, regions: [{ id: 3, nom: "Kankan" }, { id: 4, nom: "Labé" }] })).toMatch(/régions Kankan, Labé/);
  });
});

describe("perimetresDistincts", () => {
  it("dedoublonne par code, dans l'ordre d'apparition", () => {
    const autre = { code: "POSTES_REGISTRE", libelle: "Péages", definition: "postes" };
    const r = perimetresDistincts([ind(), ind({ code: "b" }), ind({ code: "c", perimetre: autre })]);
    expect(r.map((p) => p.code)).toEqual(["RESEAU_CLASSE_SAISI", "POSTES_REGISTRE"]);
  });
});

describe("resumeControle", () => {
  const base: RapportControle = { genereLe: "2026-10-22T10:00:00Z", total: 31, egaux: 31, ecarts: 0, erreurs: 0, indisponibles: 0, resultats: [] };
  it("tous egaux", () => {
    expect(resumeControle(base)).toBe("31 indicateurs rapprochés de leur requête de contrôle : 31 égaux, 0 écarts.");
  });
  it("ecart, erreur et indisponibles sont dits", () => {
    expect(resumeControle({ ...base, egaux: 25, ecarts: 1, erreurs: 1, indisponibles: 4 })).toBe(
      "31 indicateurs rapprochés de leur requête de contrôle : 25 égaux, 1 écart, 1 en erreur, 4 indisponibles pour votre périmètre.");
  });
});

describe("emprise et jourFr", () => {
  it("abscisses en m puis en km", () => {
    expect(n(emprise(0, 400))).toBe("0 m à 400 m");
    expect(n(emprise(400, 1500))).toBe("400 m à 1,50 km");
  });
  it("dates : jour, instant, absence", () => {
    expect(jourFr("2026-06-01")).toBe("01/06/2026");
    expect(jourFr("2026-06-02T09:00:00Z")).toBe("02/06/2026");
    expect(jourFr(null)).toBe("non renseignée");
  });
});
