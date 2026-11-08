import { describe, expect, it } from "vitest";
import { MENTION_CIRCUITS_NON_CABLES, assemblerComptage, cleTrace, comptabiliser, groupeVide, supportsDesCircuits, type LiaisonCompte, type ObjetCompte } from "./comptage.noyau";
import type { Pt } from "../analyse.noyau";

/**
 * FIXTURES SYNTHETIQUES (aucune donnee reelle) : coordonnees planes en metres.
 * KIS-LOGIC-01 (cahier v2, 22.3) : « Deux circuits logiques ont une geometrie similaire. Les circuits restent separes, mais le systeme ne les
 * convertit pas en actifs physiques distincts sans information fiable. » Ici : TROIS circuits sur le meme trace (l'un parcouru a l'envers)
 * et UN cable physique distinct.
 */
const TRACE: Pt[] = [[0, 0], [100, 0], [100, 50]]; // 150 m
const circuit = (id: string, ligne: Pt[] = TRACE, typeObjet: string | null = "LIAISON"): ObjetCompte => ({ id, nature: "CIRCUIT_LOGIQUE", typeObjet, typeGeom: "LIGNE", ligne });
const cable = (id: string, ligne: Pt[]): ObjetCompte => ({ id, nature: "ACTIF_PHYSIQUE", typeObjet: "CABLE", typeGeom: "LIGNE", ligne });

const KIS_LOGIC_01: ObjetCompte[] = [
  circuit("c1"), circuit("c2"), circuit("c3", [...TRACE].reverse()),
  cable("p1", [[0, 20], [80, 20]]), // 80 m, distinct des circuits
];

describe("KIS-LOGIC-01 : trois circuits logiques superposes et un cable physique distinct", () => {
  const r = comptabiliser(KIS_LOGIC_01);

  it("ne compte JAMAIS trois circuits superposes comme trois cables : un seul cable physique est declare", () => {
    expect(r.infrastructuresPhysiques.nombreDeclare).toBe(1);
    expect(r.circuitsLogiques.nombreDeclare).toBe(3);
    expect(r.infrastructuresPhysiques.parType).toEqual({ CABLE: 1 });
  });

  it("distingue longueur de trace fusionnee, somme des longueurs de circuits et longueur de l'infrastructure", () => {
    expect(r.circuitsLogiques.sommeLongueursCircuitsM).toBe(450); // 3 x 150 : une somme, pas une longueur de cable
    expect(r.circuitsLogiques.longueurTraceFusionneM).toBe(150); // l'union des trois traces
    expect(r.infrastructuresPhysiques.longueurTraceFusionneM).toBe(80);
    expect(r.infrastructuresPhysiques.longueurSommeM).toBe(80);
  });

  it("n'ajoute JAMAIS la longueur des circuits a celle de l'infrastructure (aucun total ne melange les natures)", () => {
    expect(r.infrastructuresPhysiques.longueurTraceFusionneM).not.toBe(150 + 80);
    expect(r.infrastructuresPhysiques.longueurSommeM + r.circuitsLogiques.sommeLongueursCircuitsM).not.toBe(r.infrastructuresPhysiques.longueurTraceFusionneM);
    const cles = JSON.stringify(Object.keys(r).sort());
    expect(cles).toBe(JSON.stringify(["avertissements", "circuitsLogiques", "equipements", "infrastructuresPhysiques", "libelles", "natureInconnue"]));
    for (const interdit of ["total", "totalObjets", "longueurTotaleM", "nombreCables", "nbCables"]) {
      expect(JSON.stringify(r)).not.toContain(`"${interdit}"`);
    }
  });

  it("detecte les circuits de trace identique, quel que soit le sens de lecture, sans les convertir en infrastructures", () => {
    expect(r.circuitsLogiques.tracesPartagees).toEqual({ groupes: 1, circuitsConcernes: 3 });
    expect(r.infrastructuresPhysiques.nombreDeclare).toBe(1);
  });

  it("avertit que les circuits ne sont pas des cables et que leur support physique est inconnu tant qu'il n'est pas relie", () => {
    expect(r.avertissements).toContain(MENTION_CIRCUITS_NON_CABLES);
    expect(r.avertissements.some((a) => /ne sont pas 3 câbles physiques/.test(a))).toBe(true);
    expect(r.avertissements.some((a) => /sans support physique validé/.test(a))).toBe(true);
    expect(r.circuitsLogiques.supportPhysique).toEqual({ avecSupportValide: 0, avecPropositionSeulement: 0, sansSupportConnu: 3 });
  });

  it("porte des libelles explicites pour chaque grandeur", () => {
    expect(r.libelles.longueurTraceFusionneM).toMatch(/trace fusionnée/);
    expect(r.libelles.sommeLongueursCircuitsM).toMatch(/somme des longueurs de circuits/);
    expect(r.libelles.nombreInfrastructuresDeclarees).toMatch(/infrastructures physiques déclarées/);
    expect(r.libelles.nombreCircuitsDeclares).toMatch(/pas un nombre de câbles/);
  });
});

describe("comptage : les natures ne se melangent pas", () => {
  it("un objet de nature inconnue n'est compte ni comme infrastructure ni comme circuit", () => {
    const r = comptabiliser([
      { id: "x1", nature: "INCONNUE", typeObjet: null, typeGeom: "LIGNE", ligne: [[0, 0], [10, 0]] },
      { id: "x2", nature: "INCONNUE", typeObjet: null, typeGeom: "LIGNE", ligne: [[0, 0], [10, 0]] },
    ]);
    expect(r.infrastructuresPhysiques.nombreDeclare).toBe(0);
    expect(r.circuitsLogiques.nombreDeclare).toBe(0);
    expect(r.natureInconnue).toEqual({ nombreObjets: 2, nombreLineaires: 2, longueurSommeM: 20, longueurTraceFusionneM: 10 });
    expect(r.avertissements.some((a) => /nature inconnue/.test(a))).toBe(true);
  });

  it("des infrastructures physiques superposees (deux gaines declarees au meme endroit) restent DEUX infrastructures declarees, avec une seule trace fusionnee", () => {
    const g: Pt[] = [[0, 0], [30, 0]];
    const r = comptabiliser([cable("a", g), cable("b", g)]);
    expect(r.infrastructuresPhysiques.nombreDeclare).toBe(2); // « declarees » : le systeme ne dedoublonne pas une declaration
    expect(r.infrastructuresPhysiques.longueurSommeM).toBe(60);
    expect(r.infrastructuresPhysiques.longueurTraceFusionneM).toBe(30);
  });

  it("les equipements se comptent par type, sans longueur", () => {
    const pt = (id: string, typeObjet: string | null): ObjetCompte => ({ id, nature: "EQUIPEMENT", typeObjet, typeGeom: "POINT" });
    const r = comptabiliser([pt("e1", "VANNE"), pt("e2", "VANNE"), pt("e3", null)]);
    expect(r.equipements).toEqual({ nombreDeclare: 3, parType: { VANNE: 2, INCONNU: 1 } });
    expect(r.infrastructuresPhysiques.longueurTraceFusionneM).toBe(0);
  });

  it("une chambre (point) est une infrastructure declaree sans longueur", () => {
    const r = comptabiliser([{ id: "ch", nature: "ACTIF_PHYSIQUE", typeObjet: "CHAMBRE", typeGeom: "POINT" }]);
    expect(r.infrastructuresPhysiques).toMatchObject({ nombreDeclare: 1, nombreLineaires: 0, longueurSommeM: 0, longueurTraceFusionneM: 0 });
  });

  it("une liste vide donne des blocs a zero, sans erreur ni avertissement de circuits", () => {
    const r = comptabiliser([]);
    expect(r.infrastructuresPhysiques.nombreDeclare + r.circuitsLogiques.nombreDeclare + r.equipements.nombreDeclare + r.natureInconnue.nombreObjets).toBe(0);
    expect(r.avertissements).toEqual([]);
  });

  it("des circuits sans aucune infrastructure declaree : le support est inconnu, jamais suppose", () => {
    const r = comptabiliser([circuit("c1"), circuit("c2", [[0, 0], [10, 0]])]);
    expect(r.avertissements.some((a) => /Aucune infrastructure physique n'est déclarée/.test(a))).toBe(true);
  });

  it("des circuits distincts (aucun recouvrement) : somme = trace fusionnee, aucun avertissement de partage", () => {
    const r = comptabiliser([circuit("c1", [[0, 0], [10, 0]]), circuit("c2", [[0, 5], [10, 5]]), cable("p", [[0, 9], [10, 9]])]);
    expect(r.circuitsLogiques.sommeLongueursCircuitsM).toBe(r.circuitsLogiques.longueurTraceFusionneM);
    expect(r.circuitsLogiques.tracesPartagees).toEqual({ groupes: 0, circuitsConcernes: 0 });
    expect(r.avertissements.some((a) => /partagent/.test(a))).toBe(false);
  });

  it("la trace fusionnee ne depasse jamais la somme des longueurs (invariant)", () => {
    const a: Pt[] = [[0, 0], [10, 0], [10, 10]];
    const b: Pt[] = [[10, 10], [10, 0], [0, 0]]; // meme trace a l'envers
    const c: Pt[] = [[0, 0], [10, 0]]; // sous-trace
    const r = comptabiliser([circuit("a", a), circuit("b", b), circuit("c", c)]);
    expect(r.circuitsLogiques.longueurTraceFusionneM).toBeLessThanOrEqual(r.circuitsLogiques.sommeLongueursCircuitsM);
    expect(r.circuitsLogiques.longueurTraceFusionneM).toBe(20);
    expect(r.circuitsLogiques.sommeLongueursCircuitsM).toBe(50);
  });
});

describe("support physique des circuits (relations)", () => {
  const liaisons = (...l: [string, string, LiaisonCompte["statut"], LiaisonCompte["type"]?][]): LiaisonCompte[] =>
    l.map(([s, c, statut, type]) => ({ sourceId: s, cibleId: c, statut, type: type ?? "PORTE_PAR" }));

  it("distingue support valide, simple proposition et support inconnu ; la plus favorable des relations compte", () => {
    const s = supportsDesCircuits(["c1", "c2", "c3", "c4"], liaisons(["c1", "p", "VALIDEE"], ["c1", "q", "REFUSEE"], ["c2", "p", "PROPOSEE"], ["c3", "p", "REFUSEE"]));
    expect(s).toEqual({ avecSupportValide: 1, avecPropositionSeulement: 1, sansSupportConnu: 2 });
  });

  it("une proposition ne vaut pas validation, une relation revoquee ne compte plus, une relation d'un autre type est ignoree", () => {
    const s = supportsDesCircuits(["c1", "c2", "c3"], liaisons(["c1", "p", "PROPOSEE"], ["c2", "p", "REVOQUEE"], ["c3", "p", "VALIDEE", "CONTENU_DANS"]));
    expect(s).toEqual({ avecSupportValide: 0, avecPropositionSeulement: 1, sansSupportConnu: 2 });
  });

  it("le comptage reprend les supports et reste muet sur ceux d'objets qui ne sont pas des circuits", () => {
    const r = comptabiliser(KIS_LOGIC_01, liaisons(["c1", "p1", "VALIDEE"], ["p1", "zz", "VALIDEE"]));
    expect(r.circuitsLogiques.supportPhysique).toEqual({ avecSupportValide: 1, avecPropositionSeulement: 0, sansSupportConnu: 2 });
  });
});

describe("assemblage des mesures (chemin PostGIS)", () => {
  const g = (o: Partial<ReturnType<typeof groupeVide>>) => ({ ...groupeVide(), ...o });
  const entree = (circuits = groupeVide()) => ({ infrastructures: groupeVide(), circuits, equipements: groupeVide(), inconnue: groupeVide(), supportPhysique: { avecSupportValide: 0, avecPropositionSeulement: 0, sansSupportConnu: circuits.nb } });

  it("arrondit au centimetre et reprend les mesures telles quelles", () => {
    const r = assemblerComptage(entree(g({ nb: 3, nbLineaires: 3, sommeM: 450.004, fusionneM: 150.0049 })));
    expect(r.circuitsLogiques).toMatchObject({ nombreDeclare: 3, sommeLongueursCircuitsM: 450, longueurTraceFusionneM: 150 });
  });

  it("refuse des mesures impossibles (negatives, non finies, plus de lineaires que d'objets)", () => {
    expect(() => assemblerComptage(entree(g({ nb: 1, nbLineaires: 1, sommeM: -1 })))).toThrow(/invalides/);
    expect(() => assemblerComptage(entree(g({ nb: 1, nbLineaires: 1, sommeM: Number.NaN })))).toThrow(/invalides/);
    expect(() => assemblerComptage(entree(g({ nb: 1, nbLineaires: 2, sommeM: 1 })))).toThrow(/lineaires/);
  });

  it("le chemin plan et le chemin assemble rendent la meme forme", () => {
    const plan = comptabiliser(KIS_LOGIC_01);
    const assemble = assemblerComptage({
      infrastructures: g({ nb: 1, nbLineaires: 1, sommeM: 80, fusionneM: 80, parType: { CABLE: 1 } }),
      circuits: g({ nb: 3, nbLineaires: 3, sommeM: 450, fusionneM: 150, parType: { LIAISON: 3 }, tracesPartagees: { nbGroupes: 1, nbObjets: 3 } }),
      equipements: groupeVide(), inconnue: groupeVide(), supportPhysique: { avecSupportValide: 0, avecPropositionSeulement: 0, sansSupportConnu: 3 },
    });
    expect(assemble).toEqual(plan);
  });
});

describe("cle de trace", () => {
  it("ne depend ni du sens de lecture ni du bruit inferieur au millimetre", () => {
    expect(cleTrace([[0, 0], [1, 1]])).toBe(cleTrace([[1.0001, 1], [0, 0.0002]]));
    expect(cleTrace([[0, 0], [1, 1]])).not.toBe(cleTrace([[0, 0], [1, 1.01]]));
  });
});
