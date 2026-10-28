import { describe, expect, it } from "vitest";
import { filtresNonAppliques, lireFiltres } from "./synthese.filtres";

/** Entrees hostiles : jamais une exception, toujours un refus lisible ou une valeur bornee. */
describe("lireFiltres", () => {
  it("accepte une requete vide", () => {
    expect(lireFiltres({})).toEqual({ ok: true, filtres: {} });
    expect(lireFiltres(undefined)).toEqual({ ok: true, filtres: {} });
  });

  it("lit les formes « a,b » et « a&a=b », deduplique", () => {
    expect(lireFiltres({ classe: "RN,RR" })).toEqual({ ok: true, filtres: { classe: ["RN", "RR"] } });
    expect(lireFiltres({ classe: ["RN", "RR", "RN"] })).toEqual({ ok: true, filtres: { classe: ["RN", "RR"] } });
    expect(lireFiltres({ etat: "MAUVAIS, CRITIQUE" })).toEqual({ ok: true, filtres: { etat: ["MAUVAIS", "CRITIQUE"] } });
  });

  it("lit regionId, statutChantier et une periode valide", () => {
    expect(lireFiltres({ regionId: "7", statutChantier: "EN_COURS", depuis: "2026-01-31", jusqua: "2026-02-28" }))
      .toEqual({ ok: true, filtres: { regionId: 7, statutChantier: ["EN_COURS"], depuis: "2026-01-31", jusqua: "2026-02-28" } });
  });

  it.each([
    ["cle inconnue", { inconnu: "1" }],
    ["regionId texte", { regionId: "abc" }],
    ["regionId zero", { regionId: "0" }],
    ["regionId negatif", { regionId: "-1" }],
    ["regionId decimal", { regionId: "1.5" }],
    ["regionId demesure", { regionId: "99999999999999999999" }],
    ["regionId tableau", { regionId: ["1", "2"] }],
    ["regionId objet", { regionId: { $gt: 0 } }],
    ["classe inconnue", { classe: "AUTOROUTE" }],
    ["classe vide", { classe: "" }],
    ["classe virgule seule", { classe: "," }],
    ["classe objet (qs)", { classe: { a: "RN" } }],
    ["classe trop longue", { classe: "R".repeat(500) }],
    ["classe 11 elements", { classe: Array.from({ length: 11 }, () => "RN") }],
    ["etat hors nomenclature", { etat: "bon" }],
    ["statut inconnu", { statutChantier: "ANNULE" }],
    ["date impossible", { depuis: "2026-02-30" }],
    ["date mal formee", { depuis: "26/10/2026" }],
    ["date hors bornes", { jusqua: "1999-12-31" }],
    ["date injection", { depuis: "2026-01-01'; DROP TABLE troncons;--" }],
    ["periode inversee", { depuis: "2026-03-01", jusqua: "2026-02-01" }],
    ["proto", JSON.parse('{"__proto__": {"x": 1}, "constructor": "x"}')],
  ])("refuse %s", (_n, query) => {
    const r = lireFiltres(query);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.details.length).toBeGreaterThan(0);
      expect(r.details.length).toBeLessThanOrEqual(10);
      for (const d of r.details) expect(d.message.length).toBeLessThanOrEqual(200);
    }
  });

  it("ne leve jamais d'exception, quelle que soit l'entree", () => {
    for (const q of [null, 0, "x", [], [1, 2], () => 1, Symbol.iterator as unknown, { a: {} }, { regionId: null }]) {
      expect(() => lireFiltres(q as unknown)).not.toThrow();
    }
  });
});

describe("filtresNonAppliques", () => {
  it("dit ce qui n'est pas applique, avec la raison", () => {
    const n = filtresNonAppliques({ etat: ["BON"], statutChantier: ["EN_COURS"], depuis: "2026-01-01" });
    expect(n.map((x) => x.nom)).toEqual(["etat", "statutChantier", "periode"]);
    for (const x of n) expect(x.raison).toMatch(/^Non appliqué/);
  });
  it("ne dit rien pour region et classe, qui sont appliques", () => {
    expect(filtresNonAppliques({ regionId: 1, classe: ["RN"] })).toEqual([]);
  });
});
