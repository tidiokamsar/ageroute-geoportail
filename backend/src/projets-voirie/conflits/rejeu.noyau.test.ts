import { describe, expect, it } from "vitest";
import { calculerRejeu, comparerInstantanes, jeuxToken, type ActionRejeu, type ConflitExistant, type ConflitTrouve } from "./rejeu.noyau";
import { estVerdictHumain, type StatutConflit } from "./types.noyau";

const ex = (cle: string, s: Partial<ConflitExistant> = {}): ConflitExistant => ({
  id: `id-${cle}`, cle, statut: "POTENTIEL", empreinteMesure: "m1", jeuxToken: "ax|rs", classePrecision: "B", aReexaminer: false, motifReexamen: null, ...s,
});
const tr = (cle: string, s: Partial<ConflitTrouve> = {}): ConflitTrouve => ({ cle, empreinteMesure: "m1", jeuxToken: "ax|rs", classePrecision: "B", ...s });
const action = (a: ActionRejeu[], cle: string) => a.find((x) => x.cle === cle)!;

describe("rejeu : nouveau, retrouve, non retrouve", () => {
  it("un conflit inconnu est cree ; un conflit retrouve identique ne change rien ; un conflit non retrouve est marque a reexaminer", () => {
    const { actions, resume } = calculerRejeu([ex("a"), ex("b")], [tr("a"), tr("c")]);
    expect(action(actions, "c")).toEqual({ genre: "CREER", cle: "c" });
    expect(action(actions, "a")).toMatchObject({ genre: "RETROUVER", mesureModifiee: false, aReexaminer: false, motifReexamen: null, historique: null });
    expect(action(actions, "b")).toMatchObject({ genre: "NON_RETROUVE", aReexaminer: true, motifReexamen: "NON_RETROUVE", historique: "REEXAMEN" });
    expect(resume).toMatchObject({ nouveaux: 1, retrouves: 1, identiques: 1, modifies: 0, disparus: 1, reapparus: 0, marquesAReexaminer: 1 });
  });

  it("aucune action ne supprime ni ne ferme un conflit : le rejeu n'a pas d'action de statut", () => {
    const { actions } = calculerRejeu([ex("a", { statut: "CLOTURE" }), ex("b"), ex("c", { statut: "INFIRME" })], []);
    for (const a of actions) {
      expect(["CREER", "RETROUVER", "NON_RETROUVE"]).toContain(a.genre);
      expect(Object.keys(a)).not.toContain("statut");
      expect(Object.keys(a)).not.toContain("nouveauStatut");
    }
  });

  it("un verdict humain n'est jamais ecrase : les conflits CONFIRME, INFIRME, TRAITEMENT_DECIDE et CLOTURE non retrouves ne changent que le drapeau", () => {
    const statuts: StatutConflit[] = ["CONFIRME", "INFIRME", "TRAITEMENT_DECIDE", "CLOTURE"];
    for (const s of statuts) expect(estVerdictHumain(s)).toBe(true);
    const existants = statuts.map((s) => ex(`k-${s}`, { statut: s }));
    const { actions } = calculerRejeu(existants, []);
    expect(actions).toHaveLength(4);
    for (const a of actions) expect(a).toMatchObject({ genre: "NON_RETROUVE", aReexaminer: true, motifReexamen: "NON_RETROUVE" });
  });

  it("une cle presente deux fois dans les resultats n'est traitee qu'une fois", () => {
    const { actions } = calculerRejeu([], [tr("a"), tr("a")]);
    expect(actions.filter((a) => a.genre === "CREER")).toHaveLength(1);
  });

  it("l'ordre des entrees n'a pas d'effet : actions triees par cle", () => {
    const a = calculerRejeu([ex("z"), ex("m")], [tr("a"), tr("m")]).actions;
    const b = calculerRejeu([ex("m"), ex("z")], [tr("m"), tr("a")]).actions;
    expect(a).toEqual(b);
  });
});

describe("rejeu : mesure modifiee, nouvelle version des donnees", () => {
  it("mesure modifiee : a reexaminer (MESURE_MODIFIEE) avec une ligne d'historique", () => {
    const { actions, resume } = calculerRejeu([ex("a")], [tr("a", { empreinteMesure: "m2" })]);
    expect(action(actions, "a")).toMatchObject({ mesureModifiee: true, aReexaminer: true, motifReexamen: "MESURE_MODIFIEE", historique: "MESURE_MODIFIEE" });
    expect(resume).toMatchObject({ modifies: 1, identiques: 0, marquesAReexaminer: 1 });
  });

  it("nouvelle version des donnees a mesure egale : a reexaminer (NOUVELLE_VERSION_DONNEES), historique REEXAMEN", () => {
    const { actions } = calculerRejeu([ex("a")], [tr("a", { jeuxToken: "ax2|rs" })]);
    expect(action(actions, "a")).toMatchObject({ versionDonneesModifiee: true, aReexaminer: true, motifReexamen: "NOUVELLE_VERSION_DONNEES", historique: "REEXAMEN" });
    const reseau = calculerRejeu([ex("a")], [tr("a", { jeuxToken: "ax|rs2" })]).actions;
    expect(action(reseau, "a")).toMatchObject({ motifReexamen: "NOUVELLE_VERSION_DONNEES" });
  });

  it("classe de precision modifiee : a reexaminer, mais le STATUT n'est pas requalifie par le calcul", () => {
    const { actions } = calculerRejeu([ex("a", { statut: "A_INVESTIGUER", classePrecision: "D" })], [tr("a", { classePrecision: "B" })]);
    const a = action(actions, "a");
    expect(a).toMatchObject({ classeModifiee: true, aReexaminer: true, motifReexamen: "NOUVELLE_VERSION_DONNEES" });
    expect(Object.keys(a)).not.toContain("statut");
  });

  it("la mesure modifiee l'emporte sur un changement de version", () => {
    const { actions } = calculerRejeu([ex("a")], [tr("a", { empreinteMesure: "m2", jeuxToken: "ax2|rs" })]);
    expect(action(actions, "a")).toMatchObject({ motifReexamen: "MESURE_MODIFIEE", historique: "MESURE_MODIFIEE" });
  });

  it("une empreinte de jeux inconnue sur le conflit existant n'est jamais un motif de reexamen", () => {
    const { actions } = calculerRejeu([ex("a", { jeuxToken: null })], [tr("a")]);
    expect(action(actions, "a")).toMatchObject({ versionDonneesModifiee: false, aReexaminer: false, historique: null });
  });
});

describe("rejeu : reapparition et idempotence", () => {
  it("un conflit non retrouve qui reapparait avec la meme mesure redevient normal et laisse une ligne RETROUVE", () => {
    const { actions, resume } = calculerRejeu([ex("a", { aReexaminer: true, motifReexamen: "NON_RETROUVE" })], [tr("a")]);
    expect(action(actions, "a")).toMatchObject({ reapparu: true, aReexaminer: false, motifReexamen: null, historique: "RETROUVE" });
    expect(resume.reapparus).toBe(1);
  });

  it("... et reapparu avec une mesure differente : reste a reexaminer (MESURE_MODIFIEE)", () => {
    const { actions } = calculerRejeu([ex("a", { aReexaminer: true, motifReexamen: "NON_RETROUVE" })], [tr("a", { empreinteMesure: "m9" })]);
    expect(action(actions, "a")).toMatchObject({ reapparu: true, aReexaminer: true, motifReexamen: "MESURE_MODIFIEE", historique: "MESURE_MODIFIEE" });
  });

  it("un dossier deja marque a reexaminer pour une autre raison et retrouve inchange reste marque (rien n'est efface a l'insu de la personne)", () => {
    const { actions } = calculerRejeu([ex("a", { aReexaminer: true, motifReexamen: "MESURE_MODIFIEE" })], [tr("a")]);
    expect(action(actions, "a")).toMatchObject({ aReexaminer: true, motifReexamen: "MESURE_MODIFIEE", historique: null });
  });

  it("un conflit deja marque NON_RETROUVE et toujours absent : aucune nouvelle ligne d'historique", () => {
    const { actions, resume } = calculerRejeu([ex("a", { aReexaminer: true, motifReexamen: "NON_RETROUVE" })], []);
    expect(action(actions, "a")).toMatchObject({ genre: "NON_RETROUVE", historique: null });
    expect(resume.disparus).toBe(1);
    expect(resume.marquesAReexaminer).toBe(0);
  });

  it("REJEU IDEMPOTENT : appliquer l'analyse, puis la rejouer sur l'etat obtenu, ne produit plus aucune ecriture d'historique ni de changement", () => {
    let etat: ConflitExistant[] = [ex("a"), ex("b"), ex("c", { statut: "CLOTURE" })];
    const trouves = [tr("a", { empreinteMesure: "m2" }), tr("d")];
    const appliquer = (): ActionRejeu[] => {
      const { actions } = calculerRejeu(etat, trouves);
      etat = actions.map((a) => {
        if (a.genre === "CREER") return ex(a.cle, { empreinteMesure: trouves.find((t) => t.cle === a.cle)!.empreinteMesure });
        const ancien = etat.find((e) => e.cle === a.cle)!;
        if (a.genre === "NON_RETROUVE") return { ...ancien, aReexaminer: true, motifReexamen: "NON_RETROUVE" as const };
        return { ...ancien, aReexaminer: a.aReexaminer, motifReexamen: a.motifReexamen, empreinteMesure: trouves.find((t) => t.cle === a.cle)!.empreinteMesure };
      });
      return actions;
    };
    const premiere = appliquer();
    expect(premiere.filter((a) => a.genre !== "RETROUVER" || a.historique !== null || a.genre === "RETROUVER").some((a) => a.genre === "CREER")).toBe(true);
    const photo = JSON.stringify(etat);
    const seconde = appliquer();
    expect(JSON.stringify(etat)).toBe(photo);
    for (const a of seconde) {
      expect(a.genre).not.toBe("CREER");
      expect("historique" in a ? a.historique : null, a.cle).toBe(null);
    }
    // Les statuts, eux, n'ont jamais bouge.
    expect(etat.find((e) => e.cle === "c")?.statut).toBe("CLOTURE");
  });
});

describe("empreinte des jeux", () => {
  const jeux = [
    { jeuId: "ja", sha256: "aa", role: "AXES_TRAVAUX" },
    { jeuId: "jr", sha256: "rr", role: "RESEAU_TIERS" },
    { jeuId: "jx", sha256: "xx", role: "RESEAU_TIERS" },
  ];
  it("depend du plan d'axes et du jeu de reseau du conflit seulement", () => {
    expect(jeuxToken(jeux, "jr")).toBe("aa|rr");
    expect(jeuxToken(jeux, "jx")).toBe("aa|xx");
    expect(jeuxToken(jeux, null)).toBe("aa|");
    expect(jeuxToken(jeux, "inconnu")).toBe("aa|");
    expect(jeuxToken([...jeux].reverse(), "jr")).toBe("aa|rr");
  });
  it("change avec une nouvelle version du plan d'axes", () => {
    expect(jeuxToken([{ jeuId: "ja2", sha256: "bb", role: "AXES_TRAVAUX" }, jeux[1]], "jr")).toBe("bb|rr");
  });
});

describe("comparaison de deux analyses", () => {
  const ref = { a: "1", b: "1", c: "1", d: "1" };
  it("apparus, disparus, modifies, identiques (listes triees)", () => {
    const c = comparerInstantanes(ref, { b: "1", c: "2", d: "1", e: "9", f: "9" });
    expect(c).toEqual({ apparus: ["e", "f"], disparus: ["a"], modifies: ["c"], identiques: ["b", "d"] });
  });
  it("deux instantanes identiques : rien n'apparait, rien ne disparait, rien ne change (reproductibilite)", () => {
    const c = comparerInstantanes(ref, { ...ref });
    expect(c.apparus).toEqual([]);
    expect(c.disparus).toEqual([]);
    expect(c.modifies).toEqual([]);
    expect(c.identiques).toEqual(["a", "b", "c", "d"]);
  });
  it("instantanes vides", () => {
    expect(comparerInstantanes({}, {})).toEqual({ apparus: [], disparus: [], modifies: [], identiques: [] });
    expect(comparerInstantanes({}, { x: "1" }).apparus).toEqual(["x"]);
    expect(comparerInstantanes({ x: "1" }, {}).disparus).toEqual(["x"]);
  });
  it("une cle heritee du prototype n'est pas une cle de l'instantane", () => {
    expect(comparerInstantanes({}, { constructor: "1" }).apparus).toEqual(["constructor"]);
  });
});
