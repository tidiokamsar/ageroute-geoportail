import { describe, expect, it } from "vitest";
import { LIMITES_OBLIGATOIRES, construireHypotheses, construireLimites, croisements, epsgPourLongitude, longueur, longueurDansBande, longueurPhysique, qualificationDe, type ContexteTextes, type Pt } from "./analyse.noyau";

/**
 * CAS SYNTHETIQUE DE RESULTAT CONNU (contrat, section 7), en metres, repere plan :
 *   - un axe horizontal de (0, 0) a (100, 0) ;
 *   - chaussee 7 m (demi-largeur 3,5), emprise 15 m (demi-largeur 7,5) ;
 *   - un trace a 2 m de l'axe  -> en chaussee ;
 *   - un trace a 6 m de l'axe  -> en emprise, hors chaussee ;
 *   - un trace a 9 m de l'axe  -> hors emprise ;
 *   - un trace perpendiculaire -> 1 croisement ;
 *   - deux circuits superposes -> comptes une fois en longueur physique.
 */
const AXE: Pt[] = [[0, 0], [100, 0]];
const DC = 3.5, DE = 7.5;
const parallele = (y: number): Pt[] => [[10, y], [90, y]];

describe("cas synthetique du contrat (oracle plan)", () => {
  it("un trace a 2 m de l'axe est entierement en chaussee", () => {
    expect(longueurDansBande(parallele(2), [AXE], DC)).toBeCloseTo(80, 9);
    expect(longueurDansBande(parallele(2), [AXE], DE)).toBeCloseTo(80, 9);
  });
  it("un trace a 6 m est en emprise mais hors chaussee", () => {
    expect(longueurDansBande(parallele(6), [AXE], DC)).toBeCloseTo(0, 9);
    expect(longueurDansBande(parallele(6), [AXE], DE)).toBeCloseTo(80, 9);
  });
  it("un trace a 9 m est hors emprise", () => {
    expect(longueurDansBande(parallele(9), [AXE], DE)).toBeCloseTo(0, 9);
  });
  it("le cote de l'axe n'importe pas : -2 m comme +2 m", () => {
    expect(longueurDansBande(parallele(-2), [AXE], DC)).toBeCloseTo(80, 9);
  });
  it("un trace perpendiculaire croise l'axe en un seul point ; son troncon dans la bande vaut la largeur de la bande", () => {
    const perp: Pt[] = [[50, -20], [50, 20]];
    expect(croisements([perp], [AXE])).toHaveLength(1);
    expect(croisements([perp], [AXE])[0][0]).toBeCloseTo(50, 9);
    expect(longueurDansBande(perp, [AXE], DC)).toBeCloseTo(7, 9);
    expect(longueurDansBande(perp, [AXE], DE)).toBeCloseTo(15, 9);
  });
  it("un trace qui ne coupe pas l'axe n'a aucun croisement, un trace parallele non plus", () => {
    expect(croisements([parallele(2)], [AXE])).toHaveLength(0);
    expect(croisements([[[50, 5], [50, 20]]], [AXE])).toHaveLength(0);
  });
  it("deux circuits superposes (meme trace, sens inverse compris) comptent une seule fois en longueur physique", () => {
    const c1 = parallele(2), c2 = parallele(2), c3 = [...parallele(2)].reverse();
    expect(longueur(c1) + longueur(c2) + longueur(c3)).toBeCloseTo(240, 9);
    expect(longueurPhysique([c1, c2, c3])).toBeCloseTo(80, 9);
  });
  it("un croisement a un sommet commun a deux axes n'est compte qu'une fois", () => {
    const axes: Pt[][] = [[[0, 0], [50, 0]], [[50, 0], [100, 0]]];
    expect(croisements([[[50, -10], [50, 10]]], axes)).toHaveLength(1);
  });
});

describe("longueurDansBande : bouts arrondis, segments obliques, plusieurs axes", () => {
  it("un trace dans le prolongement de l'axe n'est dans la bande que sur le bout arrondi", () => {
    // De x = 100 a x = 120 : seul le demi-disque (rayon 3,5) compte.
    expect(longueurDansBande([[100, 0], [120, 0]], [AXE], DC)).toBeCloseTo(3.5, 9);
  });
  it("trace oblique a 45 degres : la longueur dans la bande vaut 2 x 3,5 / sin 45", () => {
    const oblique: Pt[] = [[40, -20], [80, 20]];
    expect(longueurDansBande(oblique, [AXE], DC)).toBeCloseTo((2 * 3.5) / Math.SQRT1_2, 9);
  });
  it("l'union de deux axes ne compte pas deux fois ce qui est dans les deux bandes", () => {
    const axe2: Pt[] = [[0, 2], [100, 2]];
    expect(longueurDansBande(parallele(1), [AXE, axe2], DC)).toBeCloseTo(80, 9);
  });
});

describe("epsgPourLongitude", () => {
  it("32628 si la longitude est inferieure a -12, sinon 32629", () => {
    expect(epsgPourLongitude(-13.7)).toBe(32628);
    expect(epsgPourLongitude(-12.0001)).toBe(32628);
    expect(epsgPourLongitude(-12)).toBe(32629);
    expect(epsgPourLongitude(-10.1)).toBe(32629);
    expect(epsgPourLongitude(-8)).toBe(32629);
  });
});

describe("qualification par classe de precision", () => {
  it("A, B, C = conflit potentiel ; D, E et inconnue = proximite a verifier, jamais un conflit", () => {
    expect(['A', 'B', 'C'].map((c) => qualificationDe(c as 'A'))).toEqual(Array(3).fill('CONFLIT_POTENTIEL'));
    expect(['D', 'E', null].map((c) => qualificationDe(c as 'D'))).toEqual(Array(3).fill('PROXIMITE_A_VERIFIER'));
  });
});

describe("textes des hypotheses et des limites", () => {
  const base: ContexteTextes = {
    largeurEmpriseM: 15, largeurChausseeM: 7, statutParametres: "THEORIQUE", projection: "EPSG:32629",
    nbAxes: 31, nbJeuxReseau: 1, nbJeuxLimites: 0, datesDonnees: ["2026-10-24"], precisionsDeclareesM: [null], classes: [null], inclureNonAutorises: false, nbJeuxNonAutorises: 0,
  };
  it("dit que les largeurs sont theoriques tant qu'elles ne sont pas validees", () => {
    expect(construireHypotheses(base).join(" ")).toContain("THÉORIQUES");
    expect(construireHypotheses({ ...base, statutParametres: "VALIDE" }).join(" ")).toContain("validées");
    expect(construireHypotheses({ ...base, statutParametres: "VALIDE" }).join(" ")).not.toContain("THÉORIQUES");
  });
  it("cite la projection, les largeurs et la demi-largeur en virgule decimale", () => {
    const t = construireHypotheses(base).join(" ");
    expect(t).toContain("EPSG:32629");
    expect(t).toContain("3,5 m");
    expect(t).toContain("7,5 m");
  });
  it("porte toujours la precision inconnue, la profondeur inconnue et le caractere d'aide a la decision", () => {
    const l = construireLimites(base).join(" ");
    expect(l).toContain("INCONNUE");
    expect(l).toContain("profondeur");
  });
  it("dit pourquoi les totaux sont a zero sans axe ou sans reseau", () => {
    expect(construireLimites({ ...base, nbAxes: 0 }).join(" ")).toContain("Aucun axe");
    expect(construireLimites({ ...base, nbJeuxReseau: 0, precisionsDeclareesM: [] }).join(" ")).toContain("Aucun réseau");
  });
  it("signale les limites de route non utilisees et les dates manquantes", () => {
    expect(construireLimites({ ...base, nbJeuxLimites: 1 }).join(" ")).toContain("limites de route");
    expect(construireLimites({ ...base, datesDonnees: [null] }).join(" ")).toContain("date de levé");
  });
  it("cite la precision declaree quand elle existe", () => {
    expect(construireLimites({ ...base, precisionsDeclareesM: [5] }).join(" ")).toContain("5");
  });

  it("les trois limites obligatoires figurent TOUJOURS, avec ou sans donnees", () => {
    for (const ctx of [base, { ...base, nbAxes: 0, nbJeuxReseau: 0, precisionsDeclareesM: [], classes: [] }]) {
      const l = construireLimites(ctx);
      for (const phrase of LIMITES_OBLIGATOIRES) expect(l).toContain(phrase);
    }
    expect(LIMITES_OBLIGATOIRES.join(' ')).toContain('Conflit vertical non évalué : profondeur et altitude absentes');
    expect(LIMITES_OBLIGATOIRES.join(" ")).toContain("Aucun conflit détecté ne prouve l'absence de réseau");
    expect(LIMITES_OBLIGATOIRES.join(" ")).toContain("aucune décision de déplacement n'en découle");
  });
  it("cite les classes de precision presentes, dont l'inconnue, et la regle D, E, inconnue = proximite", () => {
    const h = construireHypotheses({ ...base, classes: ['B', null, null] }).join(' ');
    expect(h).toContain('B (1 jeu)');
    expect(h).toContain('inconnue (2 jeux)');
    expect(h).toContain('proximité à vérifier');
  });
  it("ne presente jamais N objets comme N cables et dit quand les jeux non autorises sont inclus", () => {
    const h = construireHypotheses({ ...base, inclureNonAutorises: true, nbJeuxNonAutorises: 1 }).join(' ');
    expect(h).toContain('circuits ou objets du fichier');
    expect(h).toContain('jamais un nombre de câbles');
    expect(h).toContain('INCLUS');
    expect(construireHypotheses(base).join(' ')).toContain('Seuls les jeux autorisés');
  });
});
