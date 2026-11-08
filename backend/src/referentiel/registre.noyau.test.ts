import { describe, expect, it } from "vitest";
import {
  EMPRISE_NATIONALE, REGLES, TRANSITIONS, celluleCsv, constaterAttributs, constaterPaire, empreinte, jsonStable,
  jugerAnnulation, jugerApplication, jugerDecision, valeurRecevable, versCsv,
  type AttributsTroncon, type Correction,
} from "./registre.noyau";

/**
 * Noyau du registre des anomalies : ce que ces tests defendent.
 *   - chaque regle constate ce qu'elle dit, et seulement cela (un troncon sain ne produit rien) ;
 *   - les seuils sont des parametres enregistres avec le constat, pas des normes cachees ;
 *   - l'empreinte ne depend pas de l'ordre des cles : relancer l'analyse ne cree rien ;
 *   - aucune correction sans valeur donnee, justification et source ; pas d'auto-validation ;
 *   - l'application et l'annulation refusent si la valeur a bouge (compare-et-echange) ;
 *   - le CSV neutralise les formules.
 */
const sain: AttributsTroncon = {
  id: "t1", regionId: 3, code: "GN N0001", pkDebut: 0, pkFin: 12.5, longueurKm: 12.5, classe: "RN", revetement: "BITUME",
  aGeometrie: true, geometrieValide: true, raisonInvalide: null, longueurGeometriqueM: 12_400,
  emprise: { xmin: -13.7, ymin: 9.5, xmax: -13.5, ymax: 9.6 },
};
const seuils = { ecartLongueurPct: 10, ecartPkPct: 10 };
const regles = (t: Partial<AttributsTroncon>) => constaterAttributs({ ...sain, ...t }, seuils).map((c) => c.regle);

describe("constaterAttributs", () => {
  it("un tronçon sain ne produit aucun constat", () => {
    expect(regles({})).toEqual([]);
  });
  it("PK 0 → 0 : non renseignés, et rien d'autre sur les PK", () => {
    expect(regles({ pkDebut: 0, pkFin: 0 })).toEqual(["PK_NON_RENSEIGNES"]);
  });
  it("PK négatif, PK de fin avant le début", () => {
    expect(regles({ pkDebut: -1, pkFin: 3 })).toContain("PK_NEGATIF");
    expect(regles({ pkDebut: 20, pkFin: 7.5 })).toEqual(["PK_FIN_AVANT_DEBUT"]);
  });
  it("étendue des PK contre longueur déclarée : seuil paramétré et enregistré", () => {
    const c = constaterAttributs({ ...sain, pkFin: 20 }, seuils);
    expect(c.map((x) => x.regle)).toEqual(["ETENDUE_PK_LONGUEUR"]);
    expect(c[0].valeurs).toMatchObject({ etendueKm: 20, longueurKm: 12.5, ecartPct: 60, seuilPct: 10 });
    expect(c[0].source).toMatch(/seuil 10 %/);
    expect(constaterAttributs({ ...sain, pkFin: 20 }, { ...seuils, ecartPkPct: 80 })).toEqual([]);
  });
  it("écart longueur déclarée / géométrique, sur le tracé géodésique", () => {
    const c = constaterAttributs({ ...sain, longueurGeometriqueM: 20_000 }, seuils);
    expect(c.map((x) => x.regle)).toEqual(["ECART_LONGUEUR_GEOMETRIQUE"]);
    expect(c[0].valeurs).toMatchObject({ longueurKm: 12.5, longueurGeometriqueKm: 20, ecartPct: 60 });
  });
  it("géométrie absente, invalide (raison conservée), hors emprise, très courte", () => {
    expect(regles({ aGeometrie: false, geometrieValide: null, longueurGeometriqueM: null, emprise: null })).toEqual(["GEOMETRIE_ABSENTE"]);
    const inv = constaterAttributs({ ...sain, geometrieValide: false, raisonInvalide: "Self-intersection[1 2]", longueurGeometriqueM: null }, seuils);
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ regle: "GEOMETRIE_INVALIDE", valeurs: { raison: "Self-intersection[1 2]" } });
    // Coordonnees inversees (lat, lon) : 9,5 E / -13,7 N, a des milliers de kilometres.
    expect(regles({ emprise: { xmin: 9.5, ymin: -13.7, xmax: 9.6, ymax: -13.5 } })).toContain("GEOMETRIE_HORS_EMPRISE");
    expect(regles({ emprise: { xmin: EMPRISE_NATIONALE.xmin + 0.1, ymin: 9, xmax: EMPRISE_NATIONALE.xmin + 0.2, ymax: 9.1 } })).not.toContain("GEOMETRIE_HORS_EMPRISE");
    expect(regles({ longueurGeometriqueM: 4 })).toEqual(["SEGMENT_TRES_COURT"]);
  });
  it("longueur déclarée nulle ; attributs non renseignés nommés", () => {
    expect(regles({ longueurKm: 0 })).toContain("LONGUEUR_DECLAREE_NULLE");
    const c = constaterAttributs({ ...sain, classe: "NON_CLASSEE", revetement: "NON_RENSEIGNE" }, seuils);
    expect(c.find((x) => x.regle === "ATTRIBUTS_NON_RENSEIGNES")?.valeurs).toEqual({ champs: ["classe", "revetement"] });
  });
});

describe("constaterPaire", () => {
  it("un doublon potentiel se constate sur les deux tronçons, chacun nommant l'autre", () => {
    const c = constaterPaire({
      a: "a", b: "b", regionId: 3, codeA: "A", codeB: "B", archiveA: false, archiveB: true,
      longueurAM: 1000, longueurBM: 990, couvertureA: 0.97, couvertureB: 0.99, pkA: [0, 1], pkB: [0, 1],
    }, 25);
    expect(c.map((x) => [x.tronconId, x.valeurs.autreTronconId, x.valeurs.autreArchive])).toEqual([["a", "b", true], ["b", "a", false]]);
    expect(c[0].source).toMatch(/tampon 25 m/);
  });
});

describe("empreinte", () => {
  it("ne dépend pas de l'ordre des clés, et change avec les valeurs ou la règle", () => {
    expect(jsonStable({ b: 1, a: { d: 2, c: [1, { f: 1, e: 2 }] } })).toBe('{"a":{"c":[1,{"e":2,"f":1}],"d":2},"b":1}');
    expect(empreinte("PK_FIN_AVANT_DEBUT", { pkDebut: 1, pkFin: 0 })).toBe(empreinte("PK_FIN_AVANT_DEBUT", { pkFin: 0, pkDebut: 1 }));
    expect(empreinte("PK_FIN_AVANT_DEBUT", { pkDebut: 1, pkFin: 0 })).not.toBe(empreinte("PK_FIN_AVANT_DEBUT", { pkDebut: 2, pkFin: 0 }));
    expect(empreinte("PK_NEGATIF", { pkDebut: 1, pkFin: 0 })).not.toBe(empreinte("PK_FIN_AVANT_DEBUT", { pkDebut: 1, pkFin: 0 }));
  });
});

describe("valeurRecevable", () => {
  it.each([
    ["classe", "RN", true], ["classe", "AUTOROUTE", false], ["revetement", "PAVE", true],
    ["pkDebut", "12,5", true], ["pkDebut", -1, false], ["longueurKm", 0, false], ["longueurKm", "abc", false],
  ] as const)("%s = %j -> %s", (champ, v, ok) => {
    expect(valeurRecevable(champ, v).ok).toBe(ok);
  });
});

const courante = (v: Record<string, number | string>) => (champ: string) => v[champ] ?? null;

describe("jugerDecision", () => {
  const base = { regle: "PK_NON_RENSEIGNES" as const, correctionActuelle: null, auteurId: "u1", valeurCourante: courante({ pkDebut: 0, pkFin: 0 }) };
  it("propose une correction : l'ancienne valeur est celle constatée en base, pas celle du client", () => {
    const j = jugerDecision({ ...base, statutActuel: "A_EXAMINER", demande: { statut: "CORRECTION_PROPOSEE", correction: { champ: "pkFin", nouvelle: "41,2", justification: "PV de réception", source: "PV 2024-17" } } });
    expect(j).toEqual({ ok: true, correction: { champ: "pkFin", ancienne: 0, nouvelle: 41.2, justification: "PV de réception", source: "PV 2024-17", proposeeParId: "u1" } });
  });
  it.each([
    [{ champ: "longueurKm", nouvelle: 3, justification: "xxxxx", source: "src" }, "CHAMP_NON_CORRIGEABLE"],
    [{ champ: "pkFin", nouvelle: 3, justification: "", source: "src" }, "JUSTIFICATION_EXIGEE"],
    [{ champ: "pkFin", nouvelle: 3, justification: "xxxxx", source: "" }, "SOURCE_EXIGEE"],
    [{ champ: "pkFin", nouvelle: 0, justification: "xxxxx", source: "src" }, "VALEUR_INCHANGEE"],
  ])("refuse une correction incomplète ou sans effet : %j", (correction, code) => {
    const j = jugerDecision({ ...base, statutActuel: "A_EXAMINER", demande: { statut: "CORRECTION_PROPOSEE", correction } });
    expect(j).toMatchObject({ ok: false, code });
  });
  it("une géométrie absente s'examine, elle ne se corrige pas ici", () => {
    const j = jugerDecision({ ...base, regle: "GEOMETRIE_ABSENTE", statutActuel: "A_EXAMINER", demande: { statut: "CORRECTION_PROPOSEE", correction: { champ: "pkFin", nouvelle: 3, justification: "xxxxx", source: "src" } } });
    expect(j).toMatchObject({ ok: false, code: "CHAMP_NON_CORRIGEABLE" });
  });
  it("refuse l'auto-validation d'une correction ; une autre personne la valide et la correction est gardée", () => {
    const correction: Correction = { champ: "pkFin", ancienne: 0, nouvelle: 41.2, justification: "PV", source: "PV", proposeeParId: "u1" };
    const p = { ...base, statutActuel: "CORRECTION_PROPOSEE" as const, correctionActuelle: correction, demande: { statut: "VALIDEE" as const } };
    expect(jugerDecision(p)).toMatchObject({ ok: false, code: "AUTO_VALIDATION" });
    expect(jugerDecision({ ...p, auteurId: "u2" })).toEqual({ ok: true, correction });
  });
  it("un rejet et une réouverture se motivent ; une transition hors table est refusée", () => {
    expect(jugerDecision({ ...base, statutActuel: "A_EXAMINER", demande: { statut: "REJETEE", commentaire: "ok" } })).toMatchObject({ ok: false, code: "MOTIF_EXIGE" });
    expect(jugerDecision({ ...base, statutActuel: "A_EXAMINER", demande: { statut: "REJETEE", commentaire: "deux chaussées distinctes" } })).toEqual({ ok: true, correction: null });
    expect(jugerDecision({ ...base, statutActuel: "REJETEE", demande: { statut: "A_EXAMINER", commentaire: "" } })).toMatchObject({ ok: false, code: "MOTIF_EXIGE" });
    expect(jugerDecision({ ...base, statutActuel: "A_EXAMINER", demande: { statut: "CORRIGEE" } })).toMatchObject({ ok: false, code: "TRANSITION_INTERDITE" });
    expect(TRANSITIONS.CORRIGEE).toEqual([]);
  });
});

describe("application et annulation", () => {
  const c: Correction = { champ: "pkFin", ancienne: 0, nouvelle: 41.2, justification: "PV", source: "PV", proposeeParId: "u1" };
  it("n'applique qu'une correction validée, et seulement si la valeur n'a pas bougé", () => {
    expect(jugerApplication("VALIDEE", c, 0)).toEqual({ ok: true, correction: c });
    expect(jugerApplication("CORRECTION_PROPOSEE", c, 0)).toMatchObject({ ok: false, code: "NON_APPLICABLE" });
    expect(jugerApplication("VALIDEE", c, 3)).toMatchObject({ ok: false, code: "VALEUR_A_CHANGE" });
  });
  it("n'annule que si le champ porte encore la valeur appliquée", () => {
    expect(jugerAnnulation("CORRIGEE", c, 41.2)).toEqual({ ok: true, correction: c });
    expect(jugerAnnulation("CORRIGEE", c, 50)).toMatchObject({ ok: false, code: "VALEUR_A_CHANGE" });
    expect(jugerAnnulation("VALIDEE", c, 41.2)).toMatchObject({ ok: false, code: "NON_ANNULABLE" });
  });
});

describe("export CSV", () => {
  it("neutralise les formules et protège les séparateurs", () => {
    expect(celluleCsv("=HYPERLINK(\"x\")")).toBe(`"'=HYPERLINK(""x"")"`);
    expect(celluleCsv("-12")).toBe("'-12");
    expect(celluleCsv("a;b")).toBe('"a;b"');
    expect(celluleCsv({ a: 1 })).toBe('"{""a"":1}"');
    expect(versCsv(["a", "b"], [{ a: 1, b: null }])).toBe("﻿a;b\n1;\n");
  });
  it("chaque règle du catalogue a un libellé, une gravité et une phrase", () => {
    for (const r of Object.values(REGLES)) expect(r.libelle.length * r.regle.length).toBeGreaterThan(0);
  });
});
