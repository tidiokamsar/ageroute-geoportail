import { describe, expect, it } from "vitest";
import { COUCHES_PAR_DEFAUT, coucheVisible, garderLeFocus, KIND_PAR_COUCHE, lireFocus, sansFocus, type CleCouche } from "./focus";

/**
 * Ce que ces tests defendent : arriver sur la carte pour VOIR un element n'affiche que cet element, et
 * un lien PARTAGE depuis la carte (vue=complete) rouvre la vue complete.
 */

const TOUT_COCHE: Record<CleCouche, boolean> = { troncons: true, chantiers: true, ouvrages: true, postes: true, pointsNoirs: true };
const RIEN: Record<CleCouche, boolean> = { troncons: false, chantiers: false, ouvrages: false, postes: false, pointsNoirs: false };

describe("lireFocus", () => {
  it("lit l'element demande par un lien « Carte »", () => {
    expect(lireFocus(new URLSearchParams("select=troncon&id=t-1"))).toEqual({ kind: "troncon", id: "t-1" });
    expect(lireFocus(new URLSearchParams("select=pointNoir&id=p-9"))).toEqual({ kind: "pointNoir", id: "p-9" });
  });

  it("ne declenche rien sans id, sans type, ou pour un type inconnu", () => {
    expect(lireFocus(new URLSearchParams("select=troncon"))).toBeNull();
    expect(lireFocus(new URLSearchParams("id=t-1"))).toBeNull();
    expect(lireFocus(new URLSearchParams("select=toponyme&id=x"))).toBeNull();
    expect(lireFocus(new URLSearchParams(""))).toBeNull();
  });

  it("un lien PARTAGE (vue=complete) rouvre la vue complete, avec l'element ouvert mais pas isole", () => {
    expect(lireFocus(new URLSearchParams("select=troncon&id=t-1&vue=complete"))).toBeNull();
  });
});

describe("coucheVisible", () => {
  it("hors mode, la case cochee decide", () => {
    expect(coucheVisible(null, TOUT_COCHE, "troncons")).toBe(true);
    expect(coucheVisible(null, { ...TOUT_COCHE, chantiers: false }, "chantiers")).toBe(false);
  });

  it("en mode un seul element : SEULE la couche de cet element, meme decochee, et aucune autre, meme cochee", () => {
    const focus = { kind: "chantier" as const, id: "c-1" };
    expect(coucheVisible(focus, RIEN, "chantiers")).toBe(true);
    for (const autre of ["troncons", "ouvrages", "postes", "pointsNoirs"] as const) {
      expect(coucheVisible(focus, TOUT_COCHE, autre), autre).toBe(false);
    }
  });

  it("chaque couche correspond a une sorte d'element, sans doublon", () => {
    expect(new Set(Object.values(KIND_PAR_COUCHE)).size).toBe(5);
  });
});

describe("garderLeFocus", () => {
  const troncons = [{ id: "t-1" }, { id: "t-2" }, { id: "t-3" }];

  it("hors mode, rend tout", () => {
    expect(garderLeFocus(troncons, null, "troncon")).toHaveLength(3);
  });

  it("ne garde QUE le troncon cible : pas tous ceux de la region", () => {
    expect(garderLeFocus(troncons, { kind: "troncon", id: "t-2" }, "troncon")).toEqual([{ id: "t-2" }]);
  });

  it("ne rend rien d'une autre sorte que l'element cible", () => {
    expect(garderLeFocus(troncons, { kind: "ouvrage", id: "o-1" }, "troncon")).toEqual([]);
  });

  it("un identifiant inconnu ne montre aucun element (pas tout le reseau)", () => {
    expect(garderLeFocus(troncons, { kind: "troncon", id: "absent" }, "troncon")).toEqual([]);
  });

  it("ne modifie pas le tableau d'origine", () => {
    garderLeFocus(troncons, { kind: "troncon", id: "t-2" }, "troncon");
    expect(troncons).toHaveLength(3);
  });
});

describe("sansFocus", () => {
  it("retire l'element de l'URL et garde le reste", () => {
    const p = sansFocus(new URLSearchParams("select=troncon&id=t-1&bg=satellite&region=Conakry"));
    expect(p.get("select")).toBeNull();
    expect(p.get("id")).toBeNull();
    expect(p.get("bg")).toBe("satellite");
    expect(p.get("region")).toBe("Conakry");
  });
});

describe("COUCHES_PAR_DEFAUT", () => {
  it("a l'ouverture : le reseau et les ouvrages seulement ; ni travaux en cours, ni peages/pesages, ni points noirs", () => {
    expect(COUCHES_PAR_DEFAUT).toEqual({ troncons: true, ouvrages: true, chantiers: false, postes: false, pointsNoirs: false });
  });
});
