import { describe, expect, it } from "vitest";
import { provenanceDepuisCode, planifierProvenance } from "./provenance";

/**
 * La provenance deduite ne doit jamais pouvoir passer pour une provenance documentee.
 * C'est la seule regle qui compte ici : le prefixe du code designe un LOT D'IMPORT,
 * et ce que « RES-* » recouvre reellement reste a etablir aupres d'AGEROUTE.
 *
 * Les codes utilises sont ceux de la production, releves le 01/09/2026.
 */

describe("Provenance déduite du code", () => {
  it("reconnaît le lot RES-*, qui porte 1 028 tronçons sans longueur", () => {
    const p = provenanceDepuisCode("RES-972");
    expect(p.sourceType).toBe("IMPORT_CODE_PATTERN");
    expect(p.sourceReference).toBe("RES-*");
    expect(p.sourceConfidence).toBe("HIGH");
  });

  it("reconnaît le lot GN N*, seul à porter des PK exploitables", () => {
    for (const code of ["GN N0001 0", "GN N0003 2", "GN N0001 0-1567"]) {
      const p = provenanceDepuisCode(code);
      expect(p.sourceReference).toBe("GN N*");
      expect(p.sourceConfidence).toBe("HIGH");
    }
  });

  it("reconnaît OSM par son marqueur explicite", () => {
    for (const code of ["RN1-OSM-1", "RN15-OSM-0", "RN1-OSM-10"]) {
      expect(provenanceDepuisCode(code).sourceReference).toBe("OSM");
    }
  });

  it("reconnaît OSM par l'identifiant de way en suffixe", () => {
    // « w » suivi de chiffres est la notation OSM d'un way : ces urbaines viennent
    // d'OSM elles aussi, par un nommage different des nationales.
    const p = provenanceDepuisCode("DI 002-w1096262465");
    expect(p.sourceReference).toBe("OSM");
    expect(p.sourceConfidence).toBe("HIGH");
    expect(p.motif).toMatch(/way OSM/);
  });

  it("ne confond pas un suffixe OSM avec un simple w dans le code", () => {
    // Sans chiffres a la suite, ce n'est pas un identifiant de way.
    expect(provenanceDepuisCode("DI 002-west").sourceReference).not.toBe("OSM");
  });

  it("reconnaît les préfixes urbains, et reste prudent sur leur signification", () => {
    // Vingt troncons, tous urbains, quatre prefixes. La regle n'a couvert KA, MA et RO
    // qu'apres avoir ete eprouvee sur les 1 690 codes reels : elle ne visait d'abord
    // que DI, et seize codes de meme forme restaient non reconnus.
    for (const [code, ref] of [
      ["DI 256", "DI*"],
      ["DI. 002", "DI*"],
      ["KA 004", "KA*"],
      ["KA. 032", "KA*"],
      ["MA 006", "MA*"],
      ["RO. 001", "RO*"],
    ] as const) {
      const p = provenanceDepuisCode(code);
      expect(p.sourceReference).toBe(ref);
      expect(p.sourceConfidence).toBe("MEDIUM");
      expect(p.motif).toMatch(/signification non etablie/);
    }
  });

  it("n'invente pas de préfixe urbain là où la forme ne correspond pas", () => {
    // Trois lettres, une seule lettre, minuscules, ou pas d'espace : la regle doit
    // laisser INCONNUE plutot que d'elargir jusqu'a tout attraper.
    for (const code of ["DIXINN 002", "D 002", "di 002", "KA004"]) {
      const p = provenanceDepuisCode(code);
      expect(p.sourceType).toBe("INCONNUE");
      expect(p.sourceReference).toBeNull();
    }
  });

  it("ne prétend jamais qu'une provenance est documentée", () => {
    const codes = ["RES-1", "GN N0001 0", "RN1-OSM-1", "DI 256", "inconnu", "", "test"];
    for (const code of codes) {
      expect(provenanceDepuisCode(code).sourceType).not.toBe("IMPORT_DOCUMENTE");
    }
  });

  it("signale le tronçon d'essai au lieu de l'assimiler à un import", () => {
    // Code « test », nom « RN2 », classe RR, 56,4 km : c'est l'UNIQUE regionale avec
    // une longueur saisie. Le ranger dans une famille d'import lui donnerait une
    // legitimite qu'il n'a pas.
    const p = provenanceDepuisCode("test");
    expect(p.sourceType).toBe("INCONNUE");
    expect(p.motif).toMatch(/essai/);
  });

  it("laisse INCONNUE ce qu'il ne reconnaît pas, plutôt que de deviner", () => {
    for (const code of ["", "   ", "XYZ-42", "route 3"]) {
      const p = provenanceDepuisCode(code);
      expect(p.sourceType).toBe("INCONNUE");
      expect(p.sourceReference).toBeNull();
      expect(p.sourceConfidence).toBe("LOW");
    }
  });

  it("supporte un code absent sans lever d'erreur", () => {
    expect(provenanceDepuisCode(null).sourceType).toBe("INCONNUE");
    expect(provenanceDepuisCode(undefined).sourceType).toBe("INCONNUE");
  });

  it("donne toujours un motif lisible", () => {
    for (const code of ["RES-1", "GN N0001 0", "RN1-OSM-1", "DI 256", "test", "xyz"]) {
      expect(provenanceDepuisCode(code).motif.length).toBeGreaterThan(10);
    }
  });
});

describe("Planification du remplissage", () => {
  const brut = (id: string, code: string) => ({
    id,
    code,
    sourceType: null,
    sourceReference: null,
    sourceConfidence: null,
  });

  it("ne planifie que les tronçons dont la provenance change", () => {
    const plan = planifierProvenance([brut("1", "RES-1"), brut("2", "GN N0001 0")]);
    expect(plan.aEcrire).toHaveLength(2);
    expect(plan.total).toBe(2);
  });

  it("ne réécrit rien au second passage — idempotence", () => {
    // C'est la garantie qui permet de rejouer le script sans crainte, et qui preserve
    // la date de la deduction d'origine.
    const dejaFait = [
      { id: "1", code: "RES-1", sourceType: "IMPORT_CODE_PATTERN" as const, sourceReference: "RES-*", sourceConfidence: "HIGH" as const },
      { id: "2", code: "RN1-OSM-1", sourceType: "IMPORT_CODE_PATTERN" as const, sourceReference: "OSM", sourceConfidence: "HIGH" as const },
    ];
    const plan = planifierProvenance(dejaFait);

    expect(plan.aEcrire).toHaveLength(0);
    expect(plan.total).toBe(2);
  });

  it("reprend un tronçon dont la provenance enregistrée est fausse", () => {
    const faux = [{
      id: "1", code: "RES-1",
      sourceType: "IMPORT_CODE_PATTERN" as const,
      sourceReference: "GN N*",           // ne correspond pas au code
      sourceConfidence: "HIGH" as const,
    }];
    expect(planifierProvenance(faux).aEcrire).toHaveLength(1);
  });

  it("compte chaque famille, y compris celles qui n'ont rien à écrire", () => {
    const plan = planifierProvenance([
      brut("1", "RES-1"),
      brut("2", "RES-2"),
      brut("3", "GN N0001 0"),
    ]);
    const res = plan.parReference.find((r) => r.reference === "RES-*")!;
    expect(res.total).toBe(2);
    expect(res.aEcrire).toBe(2);
    // Trie du plus gros au plus petit : l'operateur voit d'abord ce qui pese.
    expect(plan.parReference[0].reference).toBe("RES-*");
  });

  it("range les codes non reconnus sous une famille lisible", () => {
    const plan = planifierProvenance([brut("1", "test"), brut("2", "xyz")]);
    expect(plan.parReference.find((r) => r.reference === "(inconnue)")?.total).toBe(2);
  });

  it("ne planifie rien sur une base vide", () => {
    const plan = planifierProvenance([]);
    expect(plan.aEcrire).toHaveLength(0);
    expect(plan.parReference).toEqual([]);
    expect(plan.total).toBe(0);
  });
});
