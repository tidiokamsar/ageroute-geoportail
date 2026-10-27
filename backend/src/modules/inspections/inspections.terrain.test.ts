import { describe, expect, it } from "vitest";
import { inspectionCreateSchema } from "./inspections.schema";
import { jugerAvis } from "./inspections.validation";

/**
 * Fiche d'inspection terrain (BDRI, lot F) : ce que ces tests défendent.
 *   - « aucun défaut observé », « non inspecté », « inconnu » et « non applicable » sont distincts ; une
 *     contradiction (aucun défaut ET une description de défauts) est refusée, avec un message par manque ;
 *   - un objet non inspecté n'a pas d'état observé ;
 *   - une section est une portion OU un intervalle complet, et se rapporte à un tronçon ;
 *   - l'avis d'un responsable : pas d'auto-validation, refus motivé, VALIDE terminal.
 */
const base = { tronconId: "11111111-1111-4111-8111-111111111111", dateInspection: "2026-10-25", etatObserve: "MOYEN" };
const messages = (o: Record<string, unknown>) => {
  const r = inspectionCreateSchema.safeParse({ ...base, ...o });
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe("constat des défauts", () => {
  it("les quatre situations sans défaut sont acceptées, distinctes, sans description", () => {
    for (const c of ["AUCUN_DEFAUT_OBSERVE", "INCONNU", "NON_APPLICABLE"]) expect(messages({ constatDefauts: c }), c).toEqual([]);
    expect(messages({ constatDefauts: "NON_INSPECTE", etatObserve: "NON_EVALUE" })).toEqual([]);
  });
  it("des défauts relevés se décrivent", () => {
    expect(messages({ constatDefauts: "DEFAUTS_RELEVES" })).toEqual([expect.stringMatching(/se décrivent/)]);
    expect(messages({ constatDefauts: "DEFAUTS_RELEVES", defautsConstates: "nids-de-poule PK 3" })).toEqual([]);
  });
  it("« aucun défaut » avec une description de défauts est une contradiction refusée", () => {
    expect(messages({ constatDefauts: "AUCUN_DEFAUT_OBSERVE", defautsConstates: "fissures" })).toEqual([expect.stringMatching(/contredit/)]);
  });
  it("un objet non inspecté n'a pas d'état observé", () => {
    expect(messages({ constatDefauts: "NON_INSPECTE" })).toEqual([expect.stringMatching(/NON_EVALUE/)]);
  });
  it("une méthode inconnue est refusée ; une appréciation visuelle passe", () => {
    expect(messages({ methodeObservation: "IRI_LASER" }).length).toBe(1);
    expect(messages({ methodeObservation: "VISUELLE_EN_VEHICULE", conditionsObservation: "pluie, chaussée mouillée" })).toEqual([]);
  });
});

describe("section observée", () => {
  it("intervalle complet et ordonné, rapporté à un tronçon", () => {
    expect(messages({ debutM: 100, finM: 600 })).toEqual([]);
    expect(messages({ debutM: 100 })).toEqual([expect.stringMatching(/un début et une fin/)]);
    expect(messages({ debutM: 600, finM: 100 })).toEqual([expect.stringMatching(/après son début/)]);
    expect(messages({ tronconId: undefined, ouvrageId: "22222222-2222-4222-8222-222222222222", debutM: 0, finM: 10 })).toEqual([expect.stringMatching(/se rapporte à un tronçon/)]);
  });
  it("une portion OU un intervalle, pas les deux", () => {
    expect(messages({ portionId: "33333333-3333-4333-8333-333333333333", debutM: 0, finM: 10 })).toEqual([expect.stringMatching(/portion OU un intervalle/)]);
  });
});

describe("avis d'un responsable", () => {
  const avis = (o: Partial<Parameters<typeof jugerAvis>[0]>) => jugerAvis({ statutActuel: null, inspecteurId: "agent", validateurId: "chef", validateurRole: "GESTIONNAIRE", decision: "VALIDE", ...o });
  it("un responsable valide une inspection d'un autre ; une ancienne inspection sans statut est « à valider »", () => {
    expect(avis({})).toEqual({ ok: true });
  });
  it.each([
    [{ validateurId: "agent" }, "AUTO_VALIDATION"],
    [{ validateurRole: "INSPECTEUR" }, "ROLE_INSUFFISANT"],
    [{ decision: "REJETE" }, "COMMENTAIRE_REQUIS"],
    [{ statutActuel: "VALIDE", decision: "A_CORRIGER", commentaire: "x" }, "TRANSITION_INTERDITE"],
  ])("%j -> %s", (o, code) => {
    expect(avis(o as never)).toMatchObject({ ok: false, code });
  });
});
