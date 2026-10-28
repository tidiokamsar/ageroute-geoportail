import { describe, expect, it } from "vitest";
import {
  AIDE_CLAVIER, PAS_PAGE, PLAFOND_ELEMENTS, actionPourTouche, ancrageDansLaVue, libelleGroupe, ordonner, positionApres, segmentDansLaVue,
  texteButee, texteElement, texteResume, type ElementNavigable, type VueCarte,
} from "./ordreClavierCarte";

// Vue de 2 degres de cote centree sur (10, -11) : lat 9 a 11, lon -12 a -10.
const VUE: VueCarte = { centre: [10, -11], sud: 9, nord: 11, ouest: -12, est: -10 };

const point = (cle: string, lat: number, lon: number): ElementNavigable => ({ cle, genre: "point", point: [lat, lon] });
const ligne = (cle: string, ...pts: [number, number][]): ElementNavigable => ({ cle, genre: "ligne", parties: [pts] });

describe("ordonner : ordre par distance au centre de la vue", () => {
  it("range du plus proche au plus eloigne, et ecarte ce qui est hors de la vue", () => {
    const r = ordonner([point("loin", 10.8, -11.8), point("pres", 10.1, -11), point("dehors", 20, 0), point("moyen", 10.4, -11.2)], VUE);
    expect(r.elements.map((e) => e.element.cle)).toEqual(["pres", "moyen", "loin"]);
    expect(r.totalDansVue).toBe(3);
    expect(r.tronque).toBe(false);
  });

  it("departage deux elements equidistants par leur cle : l'ordre est total, donc le meme a chaque calcul", () => {
    const a = ordonner([point("b", 10.5, -11), point("a", 9.5, -11), point("c", 10, -10.5)], VUE).elements.map((e) => e.element.cle);
    const b = ordonner([point("c", 10, -10.5), point("a", 9.5, -11), point("b", 10.5, -11)], VUE).elements.map((e) => e.element.cle);
    expect(a).toEqual(b);
    // c est un peu plus pres (la longitude est corrigee de la latitude) ; a et b sont a egale distance et se departagent par cle.
    expect(a).toEqual(["c", "a", "b"]);
  });

  it("corrige la longitude de la latitude : a 60 degres, un degre de longitude vaut la moitie d'un degre de latitude", () => {
    const vue: VueCarte = { centre: [60, 0], sud: 58, nord: 62, ouest: -3, est: 3 };
    // 0,8 degre de latitude contre 1,4 degre de longitude : en degres bruts le premier est plus pres, mais 1,4 de longitude ne vaut que 0,7.
    const r = ordonner([point("lat", 60.8, 0), point("lon", 60, 1.4)], vue);
    expect(r.elements.map((e) => e.element.cle)).toEqual(["lon", "lat"]);
  });

  it("applique le plafond en gardant les plus proches du centre, et le dit (tronque, total)", () => {
    const tous = Array.from({ length: 400 }, (_, i) => point(`p${String(i).padStart(3, "0")}`, 10 + (i % 20) * 0.04 - 0.4, -11 + Math.floor(i / 20) * 0.04 - 0.4));
    const r = ordonner(tous, VUE, 150);
    expect(r.elements).toHaveLength(150);
    expect(r.totalDansVue).toBe(400);
    expect(r.tronque).toBe(true);
    // Les 150 gardes sont bien les plus proches : aucun des elements ecartes n'est plus pres que le dernier garde.
    const dernier = r.elements[149].distance;
    const gardes = new Set(r.elements.map((e) => e.element.cle));
    const ecartes = ordonner(tous.filter((t) => !gardes.has(t.cle)), VUE, 1000).elements;
    expect(ecartes.every((e) => e.distance >= dernier)).toBe(true);
  });

  it("le plafond par defaut est celui qui est documente", () => {
    expect(PLAFOND_ELEMENTS).toBe(150);
    const tous = Array.from({ length: 1700 }, (_, i) => point(`t${i}`, 9 + (i % 40) * 0.05, -12 + Math.floor(i / 40) * 0.045));
    const r = ordonner(tous, VUE);
    expect(r.elements).toHaveLength(150);
    expect(r.totalDansVue).toBeGreaterThan(1000);
  });
});

describe("lignes : une route qui traverse la vue", () => {
  it("est dans la vue par sa portion visible, meme si ses sommets sont tous dehors", () => {
    const traversante = ligne("rn", [10, -20], [10, 0]);
    const a = ancrageDansLaVue(traversante, VUE);
    expect(a).not.toBeNull();
    // Le point le plus proche du centre (10, -11) est sur la route elle-meme, dans la vue.
    expect(a!.p[0]).toBeCloseTo(10, 6);
    expect(a!.p[1]).toBeCloseTo(-11, 6);
    expect(a!.d).toBeCloseTo(0, 9);
  });

  it("ancre l'infobulle dans la vue (jamais au milieu hors cadre d'une route qui deborde)", () => {
    const longue = ligne("l", [10.5, -30], [10.5, 10]);
    const a = ancrageDansLaVue(longue, VUE)!;
    expect(a.p[0]).toBeGreaterThanOrEqual(VUE.sud);
    expect(a.p[0]).toBeLessThanOrEqual(VUE.nord);
    expect(a.p[1]).toBeGreaterThanOrEqual(VUE.ouest);
    expect(a.p[1]).toBeLessThanOrEqual(VUE.est);
  });

  it("une ligne entierement hors de la vue est ecartee, y compris quand sa boite englobante croise la vue", () => {
    // Diagonale qui contourne un angle de la vue : sa boite englobante recouvre la vue, la ligne non.
    const coin = ligne("coin", [11.5, -10.2], [10.5, -9.2]);
    expect(segmentDansLaVue([11.5, -10.2], [10.5, -9.2], VUE)).toBeNull();
    expect(ancrageDansLaVue(coin, VUE)).toBeNull();
  });

  it("une multi-ligne ne relie pas ses parties : la partie la plus proche du centre l'emporte", () => {
    const multi: ElementNavigable = { cle: "m", genre: "ligne", parties: [[[9.2, -11.9], [9.3, -11.8]], [[10.1, -11], [10.1, -10.9]]] };
    const a = ancrageDansLaVue(multi, VUE)!;
    expect(a.p[0]).toBeCloseTo(10.1, 6);
  });

  it("ordonne points et lignes ensemble par la meme distance", () => {
    const r = ordonner([point("p", 10.3, -11), ligne("l", [10.1, -12], [10.1, -10]), ligne("loin", [10.9, -12], [10.9, -10])], VUE);
    expect(r.elements.map((e) => e.element.cle)).toEqual(["l", "p", "loin"]);
  });
});

describe("segmentDansLaVue", () => {
  it("rend le segment tel quel quand il est entierement dedans", () => {
    expect(segmentDansLaVue([10, -11.5], [10.5, -10.5], VUE)).toEqual([[10, -11.5], [10.5, -10.5]]);
  });
  it("rogne un segment qui sort de la vue", () => {
    const r = segmentDansLaVue([10, -11], [10, 0], VUE)!;
    expect(r[0]).toEqual([10, -11]);
    expect(r[1][1]).toBeCloseTo(-10, 9);
  });
  it("ecarte un segment parallele a un bord et dehors", () => {
    expect(segmentDansLaVue([12, -12], [12, -10], VUE)).toBeNull();
  });
});

describe("actionPourTouche", () => {
  const t = (key: string, extra: object = {}) => actionPourTouche({ key, ...extra });
  it("les fleches, Debut, Fin et les pages deplacent", () => {
    expect(t("ArrowRight")).toEqual({ type: "deplacer", vers: "suivant" });
    expect(t("ArrowDown")).toEqual({ type: "deplacer", vers: "suivant" });
    expect(t("ArrowLeft")).toEqual({ type: "deplacer", vers: "precedent" });
    expect(t("ArrowUp")).toEqual({ type: "deplacer", vers: "precedent" });
    expect(t("Home")).toEqual({ type: "deplacer", vers: "premier" });
    expect(t("End")).toEqual({ type: "deplacer", vers: "dernier" });
    expect(t("PageDown")).toEqual({ type: "deplacer", vers: "page-suivante" });
    expect(t("PageUp")).toEqual({ type: "deplacer", vers: "page-precedente" });
  });
  it("Entree et Espace activent, Echap sort", () => {
    expect(t("Enter")).toEqual({ type: "activer" });
    expect(t(" ")).toEqual({ type: "activer" });
    expect(t("Escape")).toEqual({ type: "echap" });
  });
  it("Tab et Maj+Tab ne sont PAS pris : ils sortent de la carte", () => {
    expect(t("Tab")).toBeNull();
    expect(t("Tab", { shiftKey: true })).toBeNull();
  });
  it("laisse au navigateur les combinaisons Ctrl, Alt, Meta et Maj, et les autres touches", () => {
    for (const m of ["ctrlKey", "altKey", "metaKey", "shiftKey"]) {
      expect(t("ArrowRight", { [m]: true })).toBeNull();
      expect(t("Enter", { [m]: true })).toBeNull();
    }
    expect(t("a")).toBeNull();
    expect(t("F5")).toBeNull();
  });
});

describe("positionApres", () => {
  it("la premiere fleche pose le choix sur le premier element, Fin sur le dernier", () => {
    for (const v of ["suivant", "precedent", "premier", "page-suivante", "page-precedente"] as const) {
      expect(positionApres(-1, v, 5)).toEqual({ index: 0, butee: null });
    }
    expect(positionApres(-1, "dernier", 5)).toEqual({ index: 4, butee: null });
  });
  it("avance et recule d'un cran, par pages de dix, au premier et au dernier", () => {
    expect(positionApres(2, "suivant", 50)).toEqual({ index: 3, butee: null });
    expect(positionApres(2, "precedent", 50)).toEqual({ index: 1, butee: null });
    expect(PAS_PAGE).toBe(10);
    expect(positionApres(2, "page-suivante", 50)).toEqual({ index: 12, butee: null });
    expect(positionApres(25, "page-precedente", 50)).toEqual({ index: 15, butee: null });
    expect(positionApres(25, "premier", 50)).toEqual({ index: 0, butee: null });
    expect(positionApres(25, "dernier", 50)).toEqual({ index: 49, butee: null });
  });
  it("ne boucle pas : il signale la butee au lieu de revenir au debut", () => {
    expect(positionApres(4, "suivant", 5)).toEqual({ index: 4, butee: "fin" });
    expect(positionApres(0, "precedent", 5)).toEqual({ index: 0, butee: "debut" });
    expect(positionApres(3, "page-suivante", 5)).toEqual({ index: 4, butee: null }); // la page est tronquee a la fin mais avance
    expect(positionApres(4, "page-suivante", 5)).toEqual({ index: 4, butee: "fin" });
    expect(positionApres(1, "page-precedente", 5)).toEqual({ index: 0, butee: null });
    expect(positionApres(0, "page-precedente", 5)).toEqual({ index: 0, butee: "debut" });
    expect(positionApres(0, "premier", 5)).toEqual({ index: 0, butee: "debut" });
    expect(positionApres(4, "dernier", 5)).toEqual({ index: 4, butee: "fin" });
  });
  it("sans element, il n'y a rien a choisir", () => {
    expect(positionApres(-1, "suivant", 0)).toEqual({ index: -1, butee: null });
  });
});

describe("textes annonces", () => {
  it("le resume dit le plafond quand il est atteint, et le nombre d'elements quand il ne l'est pas", () => {
    expect(texteResume(0, false)).toMatch(/Aucun élément/);
    expect(texteResume(1, false)).toBe("1 élément dans la vue.");
    expect(texteResume(12, false)).toBe("12 éléments dans la vue.");
    const t = texteResume(1700, true);
    expect(t).toContain("150 plus proches du centre");
    expect(t).toMatch(/1\s?700 éléments dans la vue/);
    expect(t).toMatch(/Zoomez ou déplacez/);
  });
  it("l'element est annonce avec son rang, la butee avec sa nature, le groupe avec son effectif", () => {
    expect(texteElement("RN1 Conakry", 2, 40)).toBe("RN1 Conakry, 3 sur 40");
    expect(texteButee("fin", "Pont X", 39, 40)).toBe("Dernier élément. Pont X, 40 sur 40");
    expect(texteButee("debut", "Pont X", 0, 40)).toBe("Premier élément. Pont X, 1 sur 40");
    expect(libelleGroupe(7)).toBe("Groupe de 7 éléments, Entrée pour zoomer");
  });
  it("l'aide cite toutes les touches", () => {
    for (const mot of ["Flèches", "Début", "Fin", "Page", "Entrée", "Espace", "Échap", "Tab"]) expect(AIDE_CLAVIER).toContain(mot);
  });
});
