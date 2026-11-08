import { afterEach, describe, expect, it, vi } from "vitest";
import { controler, evaluer } from "./tableau-de-bord.service";
import { controlTower, MODULES_CONTROL_TOWER } from "./control-tower.service";
import type { DefinitionIndicateur, Portee } from "./indicateurs.noyau";

/**
 * Evaluation du registre et Control Tower : ce que ces tests defendent.
 *   - un indicateur en erreur est DIT en erreur, jamais rendu comme un zero ;
 *   - un compte regional ne recoit aucune valeur nationale a la place d'une valeur ventilee (A10) ;
 *   - une table source vide est annoncee « aucune donnee », avec son perimetre ;
 *   - un ecart entre calcul et controle est montre, pas corrige.
 */

type D = { appels: string[] };
const perimetre = { code: "P", libelle: "Périmètre de test", definition: "définition de test assez longue" };
const national: Portee = { regions: null, maintenant: new Date("2026-10-22T10:00:00Z") };
const regional: Portee = { regions: [3], maintenant: national.maintenant };

function def(code: string, over: Partial<DefinitionIndicateur<D>> = {}): DefinitionIndicateur<D> {
  return {
    code, libelle: code, groupe: "veille", unite: "nombre", perimetre, regionalisable: true,
    calcul: async (_d, p) => (p.regions === null ? 10 : 4),
    controle: async (_d, p) => (p.regions === null ? 10 : 4),
    ...over,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("evaluer", () => {
  it("calcule en national et ventile pour un compte regional, perimetre joint a chaque valeur", async () => {
    const reg = [def("a")];
    const [n] = await evaluer({ appels: [] }, reg, national);
    const [r] = await evaluer({ appels: [] }, reg, regional);
    expect(n).toMatchObject({ statut: "CALCULE", valeur: 10, perimetre, aucuneDonnee: false });
    expect(r).toMatchObject({ statut: "CALCULE", valeur: 4 });
  });

  it("refuse a un compte regional un indicateur non ventile, et ne rend aucune valeur", async () => {
    const calcul = vi.fn(async () => 99);
    const [r] = await evaluer({ appels: [] }, [def("n", { regionalisable: false, calcul })], regional);
    expect(r.statut).toBe("INDISPONIBLE");
    expect(r.valeur).toBeNull();
    expect(r.motif).toMatch(/national/);
    expect(calcul).not.toHaveBeenCalled();
  });

  it("un calcul en erreur est signale ERREUR, journalise, et n'empeche pas les autres", async () => {
    const journal = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await evaluer({ appels: [] }, [def("casse", { calcul: async () => { throw new Error("SQL"); } }), def("sain")], national);
    expect(r.find((x) => x.code === "casse")).toMatchObject({ statut: "ERREUR", valeur: null });
    expect(r.find((x) => x.code === "casse")?.motif).toMatch(/échoué/);
    expect(r.find((x) => x.code === "sain")?.statut).toBe("CALCULE");
    expect(journal).toHaveBeenCalledTimes(1);
  });

  it("declare « aucune donnee » quand la source est vide, ou quand la valeur n'est pas calculable (null)", async () => {
    const source = { cle: "t", libelle: "table de test", vide: async () => true };
    const r = await evaluer({ appels: [] }, [
      def("vide", { source }),
      def("nul", { calcul: async () => null, controle: async () => null }),
      def("plein", { source: { ...source, cle: "autre", vide: async () => false } }),
    ], national);
    expect(r.map((x) => [x.code, x.aucuneDonnee])).toEqual([["vide", true], ["nul", true], ["plein", false]]);
    expect(r[0].sourceLibelle).toBe("table de test");
  });

  it("sansSource : n'interroge aucune table source", async () => {
    const vide = vi.fn(async () => true);
    const [r] = await evaluer({ appels: [] }, [def("a", { source: { cle: "s", libelle: "s", vide } })], national, { sansSource: true });
    expect(vide).not.toHaveBeenCalled();
    expect(r).toMatchObject({ statut: "CALCULE", valeur: 10, aucuneDonnee: false });
  });

  it("n'interroge une source partagee qu'une fois", async () => {
    const vide = vi.fn(async () => false);
    const source = { cle: "partagee", libelle: "s", vide };
    await evaluer({ appels: [] }, [def("a", { source }), def("b", { source }), def("c", { source })], national);
    expect(vide).toHaveBeenCalledTimes(1);
  });

  it("filtre par groupe et par code", async () => {
    const reg = [def("a", { groupe: "veille" }), def("b", { groupe: "reseau" }), def("c", { groupe: "reseau" })];
    expect((await evaluer({ appels: [] }, reg, national, { groupes: ["reseau"] })).map((x) => x.code)).toEqual(["b", "c"]);
    expect((await evaluer({ appels: [] }, reg, national, { codes: ["a", "c"] })).map((x) => x.code)).toEqual(["a", "c"]);
  });
});

describe("controler (A12)", () => {
  it("EGAL quand calcul et controle s'accordent ; ECART quand ils divergent ; les deux valeurs sont rendues", async () => {
    const rapport = await controler({ appels: [] }, [
      def("ok"),
      def("ecart", { calcul: async () => 11, controle: async () => 10 }),
      def("montant", { unite: "GNF", calcul: async () => "9007199254740993", controle: async () => "9007199254740993" }),
    ], national);
    expect(rapport.resultats.map((r) => [r.code, r.statut])).toEqual([["ok", "EGAL"], ["ecart", "ECART"], ["montant", "EGAL"]]);
    expect(rapport.resultats[1]).toMatchObject({ calcul: 11, controle: 10 });
    expect(rapport).toMatchObject({ total: 3, egaux: 2, ecarts: 1, erreurs: 0, indisponibles: 0 });
  });

  it("un controle en erreur est une ERREUR, pas un accord ; un non-ventile est INDISPONIBLE pour un compte regional", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rapport = await controler({ appels: [] }, [
      def("casse", { controle: async () => { throw new Error("SQL"); } }),
      def("nat", { regionalisable: false }),
    ], regional);
    expect(rapport.resultats.map((r) => r.statut)).toEqual(["ERREUR", "INDISPONIBLE"]);
    expect(rapport).toMatchObject({ erreurs: 1, indisponibles: 1, egaux: 0 });
  });
});

describe("controlTower", () => {
  /** Un registre factice qui porte tous les codes nommes par la Control Tower. */
  const codes = MODULES_CONTROL_TOWER.flatMap((m) => m.codes);
  const registre = (over: (code: string) => Partial<DefinitionIndicateur<D>> = () => ({})) => codes.map((c) => def(c, over(c)));

  it("compose cinq modules, chacun avec les indicateurs qu'il nomme et leur perimetre", async () => {
    const ct = await controlTower({ appels: [] }, registre(), national);
    expect(ct.modules.map((m) => m.code)).toEqual(["veille", "patrouilles", "teledetection", "qualite", "programmation"]);
    expect(ct.modules[0].indicateurs.map((i) => i.code)).toEqual(MODULES_CONTROL_TOWER[0].codes);
    expect(ct.modules.flatMap((m) => m.indicateurs).every((i) => i.perimetre.code === "P")).toBe(true);
    expect(ct.modules.every((m) => !m.aucuneDonnee && !m.indisponible)).toBe(true);
    expect(ct.nonCouvert.length).toBeGreaterThan(0);
  });

  it("un module dont toutes les sources sont vides dit « aucune donnee », sans chiffre fabrique", async () => {
    const vide = { cle: "vide", libelle: "v", vide: async () => true };
    const ct = await controlTower({ appels: [] }, registre((c) => (c.startsWith("propositions") ? { source: vide } : {})), national);
    expect(ct.modules.find((m) => m.code === "teledetection")?.aucuneDonnee).toBe(true);
    expect(ct.modules.find((m) => m.code === "veille")?.aucuneDonnee).toBe(false);
  });

  it("un module que le compte regional ne peut lire par region est declare indisponible", async () => {
    const ct = await controlTower({ appels: [] }, registre(() => ({ regionalisable: false })), regional);
    expect(ct.modules.every((m) => m.indisponible)).toBe(true);
    expect(ct.modules.flatMap((m) => m.indicateurs).every((i) => i.valeur === null)).toBe(true);
  });
});
