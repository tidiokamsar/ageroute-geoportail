import { describe, expect, it } from "vitest";
import { CRITERES_PROVISOIRES, centile, evaluerDetections, iou, verdict, type Annotation, type Detection, type MesuresModele } from "./evaluationVision";

/**
 * Banc d'évaluation d'un modèle de vision : ce que ces tests défendent. Tous les cas sont FABRIQUÉS et calculables à la main ;
 * aucun modèle, aucune image. Ils garantissent que le banc ne déclarera jamais « conforme » ce qui n'a pas été mesuré.
 */
const B = (x: number, y: number, l = 10, h = 10) => ({ x, y, l, h });
const A = (image: string, classe: string, boite = B(0, 0)): Annotation => ({ image, classe, boite });
const D = (image: string, classe: string, confiance: number, boite = B(0, 0)): Detection => ({ image, classe, boite, confiance });

describe("iou", () => {
  it("1 pour deux boîtes identiques, 0 pour deux boîtes disjointes, 1/3 pour un demi-recouvrement", () => {
    expect(iou(B(0, 0), B(0, 0))).toBe(1);
    expect(iou(B(0, 0), B(20, 20))).toBe(0);
    expect(iou(B(0, 0, 10, 10), B(5, 0, 10, 10))).toBeCloseTo(50 / 150, 10);
  });
  it("une boîte de surface nulle ne divise pas par zéro", () => {
    expect(iou(B(0, 0, 0, 0), B(0, 0, 0, 0))).toBe(0);
  });
});

describe("evaluerDetections", () => {
  it("compte vrais positifs, fausses alertes et manques, et calcule précision et rappel à la main", () => {
    const annots = [A("i1", "NID"), A("i2", "NID"), A("i3", "NID"), A("i4", "FISSURE")];
    const dets = [D("i1", "NID", 0.9), D("i2", "NID", 0.8), D("i9", "NID", 0.7), D("i4", "FISSURE", 0.6)];
    const r = evaluerDetections(annots, dets);
    const nid = r.find((x) => x.classe === "NID")!;
    expect(nid).toMatchObject({ annotations: 3, detections: 3, vraisPositifs: 2, fausseAlertes: 1, manques: 1 });
    expect(nid.precision).toBeCloseTo(2 / 3, 10);
    expect(nid.rappel).toBeCloseTo(2 / 3, 10);
    expect(r.find((x) => x.classe === "FISSURE")).toMatchObject({ vraisPositifs: 1, fausseAlertes: 0, precision: 1, rappel: 1 });
  });

  it("chaque annotation ne sert qu'une fois : deux détections sur la même annotation = un vrai et une fausse alerte", () => {
    const r = evaluerDetections([A("i1", "NID")], [D("i1", "NID", 0.9), D("i1", "NID", 0.8)]);
    expect(r[0]).toMatchObject({ vraisPositifs: 1, fausseAlertes: 1 });
  });

  it("une mauvaise classe ou une mauvaise image n'est pas un vrai positif", () => {
    const r = evaluerDetections([A("i1", "NID")], [D("i1", "FISSURE", 0.9), D("i2", "NID", 0.9)]);
    expect(r.find((x) => x.classe === "NID")).toMatchObject({ vraisPositifs: 0, fausseAlertes: 1, manques: 1 });
    expect(r.find((x) => x.classe === "FISSURE")).toMatchObject({ vraisPositifs: 0, fausseAlertes: 1 });
  });

  it("le seuil de recouvrement est respecté", () => {
    const annots = [A("i1", "NID", B(0, 0, 10, 10))];
    const dets = [D("i1", "NID", 0.9, B(5, 0, 10, 10))]; // IoU 1/3
    expect(evaluerDetections(annots, dets, { seuilIou: 0.5 })[0].vraisPositifs).toBe(0);
    expect(evaluerDetections(annots, dets, { seuilIou: 0.3 })[0].vraisPositifs).toBe(1);
  });

  it("le seuil de confiance écarte les détections peu sûres", () => {
    const r = evaluerDetections([A("i1", "NID")], [D("i1", "NID", 0.4)], { seuilConfiance: 0.5 });
    expect(r[0]).toMatchObject({ detections: 0, vraisPositifs: 0, manques: 1, precision: null, rappel: 0 });
  });

  it("un modèle muet a un rappel nul et une précision NON DÉFINIE, jamais 100 %", () => {
    const r = evaluerDetections([A("i1", "NID")], []);
    expect(r[0].precision).toBeNull();
    expect(r[0].rappel).toBe(0);
  });
});

describe("centile", () => {
  it("rang le plus proche ; null si la série est vide", () => {
    expect(centile([], 95)).toBeNull();
    expect(centile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 95)).toBe(100);
    expect(centile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 50)).toBe(50);
    expect(centile([7], 95)).toBe(7);
  });
});

describe("verdict : une case non mesurée n'est jamais conforme", () => {
  const classe = (c: string, annotations: number, vrais: number, detections: number) => ({
    classe: c, annotations, detections, vraisPositifs: vrais, fausseAlertes: detections - vrais, manques: annotations - vrais,
    precision: detections ? vrais / detections : null, rappel: annotations ? vrais / annotations : null,
  });
  const bon: MesuresModele = {
    imagesInedites: true, nbImages: 400,
    resultats: [classe("NID", 150, 120, 150), classe("FISSURE", 120, 90, 120)],
    kmParcourus: 100, latencesMs: [300, 500, 900, 1200], memoirePicMo: 200, surconsommationBatteriePctParHeure: 6, tailleModeleMo: 12,
  };

  it("un modèle qui atteint tous les critères sur images inédites est acceptable", () => {
    const v = verdict(bon);
    expect(v.criteres.map((x) => `${x.critere}:${x.statut}`)).toEqual([
      "effectif:atteint", "precision:atteint", "rappel:atteint", "fausses_alertes_par_km:atteint",
      "latence_p95:atteint", "memoire_pic:atteint", "batterie:atteint", "taille_modele:atteint",
    ]);
    expect(v.acceptable).toBe(true);
  });

  it("images non attestées inédites : précision, rappel, fausses alertes et effectif sont NON MESURÉS, donc inacceptable", () => {
    const v = verdict({ ...bon, imagesInedites: false });
    for (const k of ["effectif", "precision", "rappel", "fausses_alertes_par_km"]) expect(v.criteres.find((x) => x.critere === k)?.statut).toBe("non_mesure");
    expect(v.acceptable).toBe(false);
  });

  it("une latence, une mémoire, une batterie ou une taille non mesurées rendent le modèle inacceptable", () => {
    expect(verdict({ ...bon, latencesMs: [] }).acceptable).toBe(false);
    expect(verdict({ ...bon, memoirePicMo: null }).criteres.find((x) => x.critere === "memoire_pic")?.statut).toBe("non_mesure");
    expect(verdict({ ...bon, surconsommationBatteriePctParHeure: null }).acceptable).toBe(false);
    expect(verdict({ ...bon, tailleModeleMo: null }).acceptable).toBe(false);
    expect(verdict({ ...bon, kmParcourus: null }).criteres.find((x) => x.critere === "fausses_alertes_par_km")?.statut).toBe("non_mesure");
  });

  it("chaque critère peut être manqué : précision, rappel, fausses alertes par km, latence, mémoire, batterie, taille", () => {
    const rate = (m: MesuresModele, critere: string) => verdict(m).criteres.find((x) => x.critere === critere)?.statut;
    expect(rate({ ...bon, resultats: [classe("NID", 150, 120, 400), classe("FISSURE", 120, 90, 120)] }, "precision")).toBe("non_atteint");
    expect(rate({ ...bon, resultats: [classe("NID", 150, 30, 40), classe("FISSURE", 120, 30, 40)] }, "rappel")).toBe("non_atteint");
    expect(rate({ ...bon, kmParcourus: 10 }, "fausses_alertes_par_km")).toBe("non_atteint");
    expect(rate({ ...bon, latencesMs: [100, 200, 3000] }, "latence_p95")).toBe("non_atteint");
    expect(rate({ ...bon, memoirePicMo: 900 }, "memoire_pic")).toBe("non_atteint");
    expect(rate({ ...bon, surconsommationBatteriePctParHeure: 25 }, "batterie")).toBe("non_atteint");
    expect(rate({ ...bon, tailleModeleMo: 120 }, "taille_modele")).toBe("non_atteint");
  });

  it("une classe trop rare ou trop peu d'images : l'effectif n'est pas atteint, donc inacceptable même avec de bons scores", () => {
    const v = verdict({ ...bon, resultats: [classe("NID", 150, 120, 150), classe("ORNIERE", 20, 18, 20)] });
    const e = v.criteres.find((x) => x.critere === "effectif")!;
    expect(e.statut).toBe("non_atteint");
    expect(e.detail).toContain("ORNIERE (20)");
    expect(v.acceptable).toBe(false);
    expect(verdict({ ...bon, nbImages: 120 }).acceptable).toBe(false);
  });

  it("aucun résultat du tout : inacceptable (rien n'a été essayé)", () => {
    expect(verdict({ ...bon, resultats: [] }).acceptable).toBe(false);
  });

  it("les critères portent leur provenance provisoire", () => {
    expect(CRITERES_PROVISOIRES.provenance).toBe("PROVISOIRE_NON_CALIBRE");
  });
});
