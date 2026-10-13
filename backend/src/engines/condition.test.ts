import { describe, expect, it } from "vitest";
import {
  calculerRci, motifExclusion, confianceDuScore, COMPOSANTES_RCI,
  type RegleRci, type EntreeComposante, type ComposanteRci,
} from "./condition";

/**
 * Le Condition Engine : ce que ces tests défendent.
 *
 * LE RISQUE N'EST PAS UNE ERREUR DE CALCUL
 *
 * Une moyenne pondérée fausse se verrait. Ce qui ne se verrait pas, c'est un score
 * **plausible** calculé sur des données absentes — et c'est le cas normal ici, pas
 * l'exception : `traficMoyenJma` est renseigné sur ZÉRO des 1 690 tronçons antérieurs à la
 * promotion de la voirie.
 *
 * Le TRAFIC porterait donc sur du vide, et les autres composantes sont inégalement
 * couvertes. Les compter comme nulles ferait chuter le score pour une raison qui n'a rien
 * à voir avec la route ; les compter comme moyennes serait pire, parce qu'invisible.
 *
 * Ces tests défendent donc surtout les refus, les exclusions, et le fait que le score dit
 * sur quelle part du modèle il porte.
 *
 * ET AUCUN COEFFICIENT N'EST TESTÉ ICI
 *
 * Les pondérations du §13 sont une « base indicative à calibrer ». Elles vivent en base,
 * dans une règle versionnée. Ces tests éprouvent le mécanisme avec des poids arbitraires :
 * figer les pourcentages du cahier dans un test les transformerait en décision.
 */

const MAINTENANT = new Date("2026-10-13T12:00:00.000Z");
const RECENT = new Date("2026-10-01T00:00:00.000Z");
const ANCIEN = new Date("2024-01-01T00:00:00.000Z");

const regle = (p: Partial<RegleRci> = {}): RegleRci => ({
  version: "essai-1",
  poids: { CHAUSSEE: 50, OUVRAGES: 30, TRAFIC: 20 },
  fraicheurMaxJours: 365,
  confiancesAcceptees: ["HIGH", "MEDIUM"],
  couvertureMinimale: 0.5,
  sensCroissant: true,
  approuvee: true,
  ...p,
});

const e = (
  composante: ComposanteRci,
  valeur: number | null,
  p: Partial<EntreeComposante> = {},
): EntreeComposante => ({
  composante, valeur, observeeLe: RECENT, confiance: "HIGH", source: "essai", ...p,
});

describe("Le score se calcule sur ce qui existe, et le dit", () => {
  it("rend une moyenne pondérée quand tout est disponible", () => {
    const r = calculerRci(
      [e("CHAUSSEE", 80), e("OUVRAGES", 60), e("TRAFIC", 40)],
      regle(), MAINTENANT,
    );
    // 80×0,5 + 60×0,3 + 40×0,2 = 40 + 18 + 8 = 66
    expect(r.score).toBe(66);
    expect(r.couverture).toBe(1);
  });

  it("RENORMALISE sur les composantes disponibles", () => {
    // Trafic absent : le score porte sur 80 % du modèle, et les poids restants sont
    // ramenés à 1. 80×(50/80) + 60×(30/80) = 50 + 22,5 = 72,5
    const r = calculerRci([e("CHAUSSEE", 80), e("OUVRAGES", 60)], regle(), MAINTENANT);
    expect(r.score).toBe(72.5);
    expect(r.couverture).toBe(0.8);
  });

  it("NE COMPTE PAS une composante absente comme zéro", () => {
    // Le mensonge le plus facile. Un tronçon sans donnée de trafic paraîtrait en mauvais
    // état, et le score chuterait pour une raison qui n'a rien à voir avec la route.
    const avecTout = calculerRci(
      [e("CHAUSSEE", 80), e("OUVRAGES", 80), e("TRAFIC", 80)], regle(), MAINTENANT,
    );
    const sansTrafic = calculerRci(
      [e("CHAUSSEE", 80), e("OUVRAGES", 80)], regle(), MAINTENANT,
    );
    expect(sansTrafic.score).toBe(avecTout.score);
    expect(sansTrafic.score).toBe(80);
  });

  it("NE COMPTE PAS une composante absente comme moyenne", () => {
    // Pire que zéro, parce qu'invisible : le score serait plausible et personne ne le
    // mettrait en doute.
    const r = calculerRci([e("CHAUSSEE", 100), e("OUVRAGES", 100)], regle(), MAINTENANT);
    expect(r.score).toBe(100);
  });

  it("dit sur combien de composantes et quelle part du modèle il porte", () => {
    const r = calculerRci([e("CHAUSSEE", 80), e("OUVRAGES", 60)], regle(), MAINTENANT);
    expect(r.explication).toMatch(/2 composante/);
    expect(r.explication).toMatch(/80 % du modèle/);
    expect(r.explication).toMatch(/TRAFIC ABSENTE/);
  });
});

describe("Sous un plancher de couverture, le moteur REFUSE", () => {
  it("refuse quand trop peu du modèle est couvert", () => {
    // Renormaliser sur 20 % du modèle produirait un nombre entre 0 et 100 qui ne dit
    // presque rien, et que personne ne saurait lire comme tel.
    const r = calculerRci([e("TRAFIC", 90)], regle({ couvertureMinimale: 0.5 }), MAINTENANT);
    expect(r.score).toBeNull();
    expect(r).toMatchObject({ motif: "COUVERTURE_INSUFFISANTE" });
    expect(r.couverture).toBe(0.2);
  });

  it("nomme ce qui manque dans son refus", () => {
    // Un refus qui ne dit pas quoi aller chercher laisse la situation inchangée.
    const r = calculerRci([e("TRAFIC", 90)], regle(), MAINTENANT);
    expect(r.explication).toMatch(/CHAUSSEE ABSENTE/);
    expect(r.explication).toMatch(/minimum 50 %/);
  });

  it("accepte pile au seuil", () => {
    // 50 % de couverture avec un minimum de 50 % : le seuil est inclusif, sinon un réseau
    // calibré sur ce seuil ne scorerait jamais.
    const r = calculerRci([e("CHAUSSEE", 70)], regle({ couvertureMinimale: 0.5 }), MAINTENANT);
    expect(r.score).toBe(70);
  });

  it("refuse une règle sans aucun poids", () => {
    const r = calculerRci([e("CHAUSSEE", 70)], regle({ poids: {} }), MAINTENANT);
    expect(r).toMatchObject({ score: null, motif: "AUCUN_POIDS_DECLARE" });
  });
});

describe("Une composante périmée n'est pas une composante absente", () => {
  it("distingue les deux motifs", () => {
    // Un état relevé il y a dix ans demande une réinspection ; un état jamais relevé
    // demande un inventaire. Les deux sortent du calcul, mais on ne va pas chercher la
    // même chose.
    const r = calculerRci(
      [e("CHAUSSEE", 80), e("OUVRAGES", 60, { observeeLe: ANCIEN }), e("TRAFIC", null)],
      regle({ couvertureMinimale: 0.4 }), MAINTENANT,
    );
    const parNom = new Map(r.composantes.map((c) => [c.composante, c]));
    expect(parNom.get("OUVRAGES")?.exclue).toBe("PERIMEE");
    expect(parNom.get("TRAFIC")?.exclue).toBe("ABSENTE");
  });

  it("traite une valeur SANS DATE comme périmée, pas comme fraîche", () => {
    // On ne peut pas affirmer qu'elle est récente. Mesure du 01/09/2026 : 3 dates de
    // constat renseignées sur 4 970 attendues — ce cas est le plus fréquent de tous.
    expect(motifExclusion(
      e("CHAUSSEE", 80, { observeeLe: null }), regle(), MAINTENANT,
    )).toBe("PERIMEE");
  });

  it("exclut une confiance que la règle n'accepte pas", () => {
    expect(motifExclusion(e("CHAUSSEE", 80, { confiance: "LOW" }), regle(), MAINTENANT))
      .toBe("CONFIANCE_INSUFFISANTE");
  });

  it("exclut une confiance ABSENTE au lieu de la supposer bonne", () => {
    expect(motifExclusion(e("CHAUSSEE", 80, { confiance: null }), regle(), MAINTENANT))
      .toBe("CONFIANCE_INSUFFISANTE");
  });

  it("NE REPROCHE PAS une composante que la règle ignore", () => {
    // Demander une inspection pour une composante sans poids serait du travail inutile.
    const r = calculerRci([e("CHAUSSEE", 80), e("OUVRAGES", 60), e("TRAFIC", 40)],
      regle({ poids: { CHAUSSEE: 100 } }), MAINTENANT);
    const parNom = new Map(r.composantes.map((c) => [c.composante, c]));
    expect(parNom.get("DRAINAGE")?.exclue).toBe("POIDS_NUL");
    expect(r.explication).not.toMatch(/DRAINAGE/);
  });

  it("refuse une valeur hors de l'intervalle du score", () => {
    for (const v of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(motifExclusion(e("CHAUSSEE", v), regle(), MAINTENANT), String(v)).toBe("ABSENTE");
    }
  });
});

describe("La confiance du score tient compte de la couverture", () => {
  it("ne donne pas HIGH sur un tiers du modèle, même avec des sources sûres", () => {
    expect(confianceDuScore(0.33, ["HIGH", "HIGH"])).toBe("LOW");
  });

  it("dégrade HIGH en MEDIUM sur une couverture intermédiaire", () => {
    expect(confianceDuScore(0.7, ["HIGH"])).toBe("MEDIUM");
  });

  it("garde HIGH sur une couverture complète et des sources sûres", () => {
    expect(confianceDuScore(1, ["HIGH", "HIGH"])).toBe("HIGH");
  });

  it("retient le MAILLON FAIBLE et non la moyenne", () => {
    // Une seule source douteuse suffit à retirer la confiance haute : c'est elle qui
    // porte le risque, pas la moyenne des autres.
    expect(confianceDuScore(1, ["HIGH", "HIGH", "LOW"])).toBe("LOW");
  });

  it("rend LOW quand rien n'est retenu", () => {
    expect(confianceDuScore(0, [])).toBe("LOW");
  });
});

describe("Une règle non approuvée produit un score NON PUBLIABLE", () => {
  it("marque le score et le dit dans l'explication", () => {
    /**
     * Le garde-fou qui empêche les pondérations du cahier — données comme « base
     * indicative à calibrer » — de devenir officielles par le simple fait d'avoir été
     * écrites quelque part. C'est la règle impérative du §39.
     */
    const r = calculerRci(
      [e("CHAUSSEE", 80), e("OUVRAGES", 60), e("TRAFIC", 40)],
      regle({ approuvee: false }), MAINTENANT,
    );
    expect(r.score).toBe(66);
    expect(r).toMatchObject({ publiable: false });
    expect(r.explication).toMatch(/NON APPROUVÉE/);
  });

  it("rend publiable un score sous une règle approuvée", () => {
    const r = calculerRci([e("CHAUSSEE", 80)], regle({ couvertureMinimale: 0.4 }), MAINTENANT);
    expect(r).toMatchObject({ publiable: true });
    expect(r.explication).not.toMatch(/NON APPROUVÉE/);
  });
});

describe("Le score s'explique composante par composante", () => {
  it("conserve le poids déclaré, le poids effectif et la contribution", () => {
    // « Le système doit expliquer pourquoi le score est obtenu » (§13). Sans le poids
    // effectif, on ne peut pas refaire le calcul après renormalisation.
    const r = calculerRci([e("CHAUSSEE", 80), e("OUVRAGES", 60)], regle(), MAINTENANT);
    const chaussee = r.composantes.find((c) => c.composante === "CHAUSSEE")!;
    expect(chaussee.poidsDeclare).toBe(50);
    expect(chaussee.poidsEffectif).toBeCloseTo(50 / 80, 5);
    expect(chaussee.contribution).toBe(50);
  });

  it("conserve la source et la date de chaque composante retenue", () => {
    const r = calculerRci([e("CHAUSSEE", 80, { source: "INSPECTION_TERRAIN" })],
      regle({ couvertureMinimale: 0.4 }), MAINTENANT);
    const c = r.composantes.find((x) => x.composante === "CHAUSSEE")!;
    expect(c.source).toBe("INSPECTION_TERRAIN");
    expect(c.observeeLe).toEqual(RECENT);
  });

  it("rend les huit composantes, retenues ou non", () => {
    // Une composante absente de la sortie serait une absence invisible.
    const r = calculerRci([e("CHAUSSEE", 80)], regle({ couvertureMinimale: 0.4 }), MAINTENANT);
    expect(r.composantes.map((c) => c.composante)).toEqual([...COMPOSANTES_RCI]);
  });

  it("somme des contributions égale le score", () => {
    const r = calculerRci(
      [e("CHAUSSEE", 77), e("OUVRAGES", 43), e("TRAFIC", 91)], regle(), MAINTENANT,
    );
    const somme = r.composantes.reduce((s, c) => s + c.contribution, 0);
    expect(Math.abs(somme - (r.score as number))).toBeLessThan(0.05);
  });
});
