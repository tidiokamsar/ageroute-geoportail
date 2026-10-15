import { describe, expect, it } from "vitest";
import {
  provenanceDepuisCode, planifierProvenance,
  type TronconProvenance,
} from "./provenance-backfill";

/**
 * La deduction de provenance : ce que ces tests defendent.
 *
 * POURQUOI CE FICHIER EXISTE MAINTENANT
 *
 * Ce code vivait dans `src/lib/provenance.ts` et n'avait pas de test propre. Le commit
 * 4eb1525 a reecrit ce module pour un autre besoin et a supprime ces fonctions, laissant
 * `scripts/backfill-provenance.ts` importer une fonction absente. Le script ne compilait
 * plus et ne demarrait meme pas, du 04/09/2026 au 12/10/2026, sans que rien ne tombe :
 * `typecheck:scripts` le disait, mais il n'est pas appele par la verification du backend.
 *
 * Un test aurait signale la suppression le jour meme. C'est la lecon, et c'est la raison
 * de ce fichier.
 *
 * CE QUI EST EN JEU
 *
 * Ces regles decident ce qui sera ecrit sur 1 690 troncons de production. Une regle trop
 * large rangerait un enregistrement dans une famille d'import a laquelle il n'appartient
 * pas, et lui donnerait une legitimite qu'il n'a pas. Une regle trop etroite laisserait
 * des troncons sans provenance, ce qui est honnete mais inutile.
 */

describe("Reconnaitre une famille d'import dans un code", () => {
  it("reconnait le marqueur OSM", () => {
    const p = provenanceDepuisCode("RN1-OSM-0042");
    expect(p).toMatchObject({
      sourceType: "IMPORT_CODE_PATTERN", sourceReference: "OSM", sourceConfidence: "HIGH",
    });
  });

  it("reconnait un identifiant de way OSM en fin de code", () => {
    expect(provenanceDepuisCode("voie-w123456789").sourceReference).toBe("OSM");
  });

  it("ne confond pas un w final avec un identifiant de way", () => {
    // `-w` sans chiffres n'est pas une notation OSM. La regle exige les chiffres.
    expect(provenanceDepuisCode("quelque-chose-w").sourceReference).toBeNull();
  });

  it("reconnait la famille regionale RES-", () => {
    const p = provenanceDepuisCode("RES-1004");
    expect(p.sourceReference).toBe("RES-*");
    expect(p.sourceConfidence).toBe("HIGH");
  });

  it("reconnait la famille nationale GN N", () => {
    expect(provenanceDepuisCode("GN N0001 1-1055").sourceReference).toBe("GN N*");
  });

  it("reconnait les familles urbaines a deux lettres, avec ou sans point", () => {
    // La regle a d'abord ete ecrite pour le seul prefixe DI, et seize codes de meme
    // forme restaient non reconnus. Elle a ete elargie APRES avoir ete eprouvee sur la
    // totalite des 1 690 codes reels, pas sur un echantillon.
    for (const [code, attendu] of [
      ["DI 002", "DI*"], ["KA 004", "KA*"], ["MA 006", "MA*"], ["RO. 001", "RO*"],
    ] as const) {
      const p = provenanceDepuisCode(code);
      expect(p.sourceReference, code).toBe(attendu);
      // MEDIUM et non HIGH : la forme est constante et la classe homogene, mais ce que
      // designe le prefixe n'est pas etabli.
      expect(p.sourceConfidence, code).toBe("MEDIUM");
    }
  });
});

describe("Ce qui ne doit surtout pas etre range dans une famille", () => {
  it("signale l'enregistrement d'essai au lieu de l'adopter", () => {
    // Il porte le nom « RN2 », la classe RR et 56,4 km, et c'est l'UNIQUE regionale avec
    // une longueur saisie. Le ranger dans un lot d'import lui donnerait une legitimite
    // qu'il n'a pas ; son motif doit rester lisible pour qu'on vienne l'examiner.
    const p = provenanceDepuisCode("test");
    expect(p.sourceType).toBe("INCONNUE");
    expect(p.sourceReference).toBeNull();
    expect(p.motif).toContain("essai");
  });

  it("traite TEST et Test comme le code d'essai", () => {
    for (const c of ["TEST", "Test", " test "]) {
      expect(provenanceDepuisCode(c).motif, c).toContain("essai");
    }
  });

  it("rend INCONNUE plutot que de deviner", () => {
    for (const c of [null, undefined, "", "   ", "quelque chose", "123", "rn1"]) {
      const p = provenanceDepuisCode(c);
      expect(p.sourceType, String(c)).toBe("INCONNUE");
      expect(p.sourceReference, String(c)).toBeNull();
      expect(p.sourceConfidence, String(c)).toBe("LOW");
    }
  });

  it("n'attribue jamais une confiance HIGH a une deduction inconnue", () => {
    expect(provenanceDepuisCode("inclassable").sourceConfidence).not.toBe("HIGH");
  });
});

describe("Le plan se montre a blanc et ne reecrit rien deux fois", () => {
  const t = (p: Partial<TronconProvenance> & { id: string; code: string }): TronconProvenance => ({
    sourceType: null, sourceReference: null, sourceConfidence: null, ...p,
  });

  it("ne retient que les troncons dont la provenance differe", () => {
    const plan = planifierProvenance([
      t({ id: "1", code: "RES-1" }),
      t({ id: "2", code: "GN N0001 1" }),
    ]);
    expect(plan.total).toBe(2);
    expect(plan.aEcrire.map((x) => x.id)).toEqual(["1", "2"]);
  });

  it("EST IDEMPOTENT : un second passage n'ecrit rien", () => {
    // La propriete qui compte le plus. Sans elle, chaque relance recrirait les 1 690
    // lignes et ecraserait la date de la deduction d'origine, c'est-a-dire l'information
    // meme qu'on cherchait a conserver.
    const premier = planifierProvenance([t({ id: "1", code: "RES-1" })]);
    const deja = premier.aEcrire[0].provenance;

    const second = planifierProvenance([
      t({
        id: "1", code: "RES-1",
        sourceType: deja.sourceType,
        sourceReference: deja.sourceReference,
        sourceConfidence: deja.sourceConfidence,
      }),
    ]);
    expect(second.aEcrire).toEqual([]);
    // Le troncon reste COMPTE dans la repartition : l'operateur doit voir la famille
    // entiere, pas seulement le reste a faire.
    expect(second.total).toBe(1);
    expect(second.parReference[0]).toMatchObject({ reference: "RES-*", total: 1, aEcrire: 0 });
  });

  it("reecrit si une seule des trois colonnes differe", () => {
    const attendu = provenanceDepuisCode("RES-1");
    for (const ecart of [
      { sourceType: "INCONNUE" as const },
      { sourceReference: "autre" },
      { sourceConfidence: "LOW" as const },
    ]) {
      const plan = planifierProvenance([
        t({ id: "1", code: "RES-1", ...attendu, ...ecart }),
      ]);
      expect(plan.aEcrire.length, JSON.stringify(ecart)).toBe(1);
    }
  });

  it("classe les familles par effectif decroissant", () => {
    // L'operateur lit cette table avant d'ecrire : la famille la plus nombreuse est
    // celle dont une erreur couterait le plus cher, elle doit venir en premier.
    const plan = planifierProvenance([
      t({ id: "1", code: "GN N0001 1" }),
      t({ id: "2", code: "RES-1" }),
      t({ id: "3", code: "RES-2" }),
      t({ id: "4", code: "RES-3" }),
    ]);
    expect(plan.parReference[0]).toMatchObject({ reference: "RES-*", total: 3 });
    expect(plan.parReference[1]).toMatchObject({ reference: "GN N*", total: 1 });
  });

  it("regroupe les codes non reconnus sous une entree lisible", () => {
    const plan = planifierProvenance([t({ id: "1", code: "inclassable" })]);
    expect(plan.parReference[0].reference).toBe("(inconnue)");
  });

  it("rend un plan vide sur une liste vide", () => {
    expect(planifierProvenance([])).toEqual({ aEcrire: [], parReference: [], total: 0 });
  });
});
