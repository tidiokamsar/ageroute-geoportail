import { describe, expect, it } from "vitest";
import {
  CORRECTION_PROPOSEE,
  EXEMPLES_MAX,
  attributsIncoherents,
  chevauchementsAnormaux,
  inspectionsPerimees,
  resumer,
  rupturesDeContinuite,
  type Anomalie,
  type PortionExaminee,
} from "./anomalies";

/**
 * Le moteur de qualite : ce que ces tests defendent.
 *
 * LE RISQUE N'EST PAS DE RATER UNE ANOMALIE, C'EST D'EN PRODUIRE UN DEMI-MILLION
 *
 * Mesure en production : `revetement` vaut NON_RENSEIGNE sur 258 961 troncons, `etat` vaut
 * NON_EVALUE sur 254 547. Un moteur qui emet une ligne par objet rend un deluge ou la
 * seule anomalie qui compte est noyee. Ces tests defendent donc surtout CE QUE LE MOTEUR
 * REFUSE DE SIGNALER, et l'agregation.
 *
 * ET AUCUNE CORRECTION NE DIT « SUPPRIMER »
 *
 * Le patrimoine routier est une donnee d'archive. Un test le verifie sur les neuf familles,
 * parce que c'est le genre de regle qu'une contribution ulterieure enfreint sans y penser.
 */

function portion(p: Partial<PortionExaminee> & Pick<PortionExaminee, "id" | "debutM" | "finM">): PortionExaminee {
  return {
    tronconId: "t-1",
    revetement: "BETON_BITUMINEUX",
    etat: "BON",
    statutValidation: "VALIDE",
    remplaceeLe: null,
    deletedAt: null,
    ...p,
  };
}

describe("Les chevauchements : seuls ceux qui touchent le referentiel officiel", () => {
  it("signale une VALIDEE recouverte par une autre", () => {
    const r = chevauchementsAnormaux([
      portion({ id: "a", debutM: 0, finM: 1_000 }),
      portion({ id: "b", debutM: 800, finM: 1_500 }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].mesure).toBe(200);
    expect(r[0].famille).toBe("PORTIONS_CHEVAUCHANTES");
  });

  it("NE SIGNALE PAS deux propositions qui se contredisent", () => {
    // Le test le plus important de ce bloc. Deux releves qui disent autre chose l'un de
    // l'autre sont le fonctionnement VOULU : le cahier interdit tout ecrasement silencieux,
    // donc la contradiction doit pouvoir etre saisie. La compter comme anomalie noierait le
    // rapport sous le fonctionnement normal du systeme.
    const r = chevauchementsAnormaux([
      portion({ id: "a", debutM: 0, finM: 1_000, statutValidation: "A_VALIDER" }),
      portion({ id: "b", debutM: 800, finM: 1_500, statutValidation: "A_VALIDER" }),
    ]);
    expect(r).toEqual([]);
  });

  it("signale une proposition qui recouvre une VALIDEE", () => {
    const r = chevauchementsAnormaux([
      portion({ id: "officielle", debutM: 0, finM: 1_000, statutValidation: "VALIDE" }),
      portion({ id: "proposee", debutM: 500, finM: 1_500, statutValidation: "A_VALIDER" }),
    ]);
    expect(r).toHaveLength(1);
  });

  it("ignore l'historique, qui se recouvre par construction", () => {
    expect(chevauchementsAnormaux([
      portion({ id: "vieille", debutM: 0, finM: 1_000, remplaceeLe: new Date("2026-09-01") }),
      portion({ id: "neuve", debutM: 0, finM: 1_000 }),
    ])).toEqual([]);
  });

  it("ne confond pas deux troncons differents", () => {
    expect(chevauchementsAnormaux([
      portion({ id: "a", debutM: 0, finM: 1_000, tronconId: "t-1" }),
      portion({ id: "b", debutM: 0, finM: 1_000, tronconId: "t-2" }),
    ])).toEqual([]);
  });

  it("ne signale pas deux portions simplement adjacentes", () => {
    expect(chevauchementsAnormaux([
      portion({ id: "a", debutM: 0, finM: 1_000 }),
      portion({ id: "b", debutM: 1_000, finM: 2_000 }),
    ])).toEqual([]);
  });
});

describe("Les ruptures : seulement sur ce qui est deja commence", () => {
  it("NE SIGNALE PAS un troncon sans aucune portion", () => {
    // Sinon le moteur rendrait 261 387 anomalies disant toutes la meme chose des sa
    // premiere execution. Un troncon vide n'est pas une rupture : il n'est pas inventorie.
    const r = rupturesDeContinuite([], new Map([["t-1", 20_000]]), 10);
    expect(r).toEqual([]);
  });

  it("signale un trou entre deux portions, nomme par ses abscisses", () => {
    const r = rupturesDeContinuite(
      [portion({ id: "a", debutM: 0, finM: 8_000 }), portion({ id: "b", debutM: 13_000, finM: 20_000 })],
      new Map([["t-1", 20_000]]),
      10,
    );
    expect(r).toHaveLength(1);
    expect(r[0].explication).toMatch(/de 8000 m a 13000 m/);
    expect(r[0].mesure).toBe(5_000);
  });

  it("signale aussi la queue non qualifiee du troncon", () => {
    const r = rupturesDeContinuite(
      [portion({ id: "a", debutM: 0, finM: 5_000 })],
      new Map([["t-1", 20_000]]),
      10,
    );
    expect(r).toHaveLength(1);
    expect(r[0].mesure).toBe(15_000);
  });

  it("IGNORE un ecart sous le seuil, qui est un artefact de decoupage", () => {
    const r = rupturesDeContinuite(
      [portion({ id: "a", debutM: 0, finM: 999 }), portion({ id: "b", debutM: 1_004, finM: 20_000 })],
      new Map([["t-1", 20_000]]),
      10,
    );
    expect(r).toEqual([]);
  });

  it("ne signale rien quand la longueur du troncon est inconnue", () => {
    // Sans longueur mesuree, la queue du troncon n'a pas de fin : inventer un trou
    // jusqu'a une longueur supposee serait une anomalie fabriquee.
    const r = rupturesDeContinuite([portion({ id: "a", debutM: 0, finM: 5_000 })], new Map(), 10);
    expect(r).toEqual([]);
  });
});

describe("Les attributs incoherents : une seule regle, et elle est defendable", () => {
  it("signale une VALIDEE qui n'affirme ni revetement ni etat", () => {
    // Elle occupe des metres du referentiel officiel sans rien y dire.
    const r = attributsIncoherents(
      [portion({ id: "vide", debutM: 0, finM: 3_000, revetement: null, etat: null })],
      { bitumineux: new Set(["BETON_BITUMINEUX"]) },
    );
    expect(r).toHaveLength(1);
    expect(r[0].mesure).toBe(3_000);
  });

  it("NE SIGNALE PAS une PROPOSITION incomplete", () => {
    // Une proposition incomplete est en cours de saisie, pas incoherente.
    const r = attributsIncoherents(
      [portion({ id: "p", debutM: 0, finM: 3_000, revetement: null, etat: null, statutValidation: "A_VALIDER" })],
      { bitumineux: new Set() },
    );
    expect(r).toEqual([]);
  });

  it("NE SIGNALE PAS une validee qui affirme au moins un attribut", () => {
    // Incomplet n'est pas incoherent, et les confondre produirait des centaines de
    // milliers d'anomalies sur ce reseau.
    const r = attributsIncoherents(
      [portion({ id: "p", debutM: 0, finM: 3_000, revetement: "LATERITE", etat: null })],
      { bitumineux: new Set() },
    );
    expect(r).toEqual([]);
  });
});

describe("Les inspections perimees", () => {
  const maintenant = new Date("2026-10-13T00:00:00Z");

  it("une date ABSENTE est perimee, pas fraiche", () => {
    // Un ouvrage dont on ignore la date d'inspection n'a pas ete inspecte recemment : il
    // n'a pas ete documente.
    const r = inspectionsPerimees([{ id: "o-1", type: "PONT", derniereInspectionLe: null }], 365, maintenant);
    expect(r).toHaveLength(1);
    expect(r[0].explication).toMatch(/sans aucune date/);
    expect(r[0].mesure).toBeNull();
  });

  it("signale au-dela du seuil RECU, jamais d'un seuil code en dur", () => {
    const actifs = [{ id: "o-1", type: "DALOT", derniereInspectionLe: new Date("2025-10-01T00:00:00Z") }];
    expect(inspectionsPerimees(actifs, 365, maintenant)).toHaveLength(1);
    // Avec un seuil plus large, le meme ouvrage n'est plus signale : le nombre appartient
    // a AGEROUTE, comme les coefficients du RCI.
    expect(inspectionsPerimees(actifs, 1_000, maintenant)).toEqual([]);
  });

  it("ne signale pas une inspection recente", () => {
    const r = inspectionsPerimees(
      [{ id: "o-1", type: "PONT", derniereInspectionLe: new Date("2026-09-01T00:00:00Z") }],
      365, maintenant,
    );
    expect(r).toEqual([]);
  });
});

describe("L'agregation, qui est la raison d'etre de ce moteur", () => {
  function faire(famille: Anomalie["famille"], n: number, mesure = 1): Anomalie[] {
    return Array.from({ length: n }, (_, i) => ({
      famille, entityType: "Troncon", entityId: `x-${i}`, explication: "—", mesure: mesure + i,
    }));
  }

  it("rend un COMPTE et quelques exemples, jamais la liste entiere", () => {
    // Le point central. 258 961 lignes ne sont pas un diagnostic.
    const r = resumer(faire("DONNEE_SANS_PROVENANCE", 258_961), { DONNEE_SANS_PROVENANCE: 261_387 });
    expect(r).toHaveLength(1);
    expect(r[0].nombre).toBe(258_961);
    expect(r[0].exemples).toHaveLength(EXEMPLES_MAX);
    expect(r[0].part).toBe(0.9907);
  });

  it("rend part NULLE quand la population est inconnue, au lieu d'un pourcentage invente", () => {
    const r = resumer(faire("DOUBLON", 4));
    expect(r[0].surTotal).toBeNull();
    expect(r[0].part).toBeNull();
  });

  it("met les BLOQUANTES en tete, quel que soit leur nombre", () => {
    // Trois geometries invalides passent avant 200 000 champs non renseignes : les
    // premieres cassent des requetes, les seconds empechent seulement de conclure.
    const r = resumer([
      ...faire("DONNEE_SANS_PROVENANCE", 200_000),
      ...faire("GEOMETRIE_INVALIDE", 3),
    ]);
    expect(r[0].famille).toBe("GEOMETRIE_INVALIDE");
    expect(r[0].gravite).toBe("BLOQUANTE");
  });

  it("garde les exemples les plus GROS, pas les premiers venus", () => {
    // Un chevauchement de 4 km merite d'etre vu avant un de 30 cm.
    const r = resumer(faire("PORTIONS_CHEVAUCHANTES", 10, 100));
    expect(r[0].exemples.map((x) => x.mesure)).toEqual([109, 108, 107]);
  });

  it("porte la correction proposee sur chaque famille", () => {
    const r = resumer(faire("HORS_TERRITOIRE", 7));
    expect(r[0].correctionProposee).toMatch(/non supprimer/);
  });
});

describe("Aucune correction ne dit de supprimer", () => {
  it("sur les NEUF familles", () => {
    // Le patrimoine routier est une donnee d'archive, et la regle 2 d'AGENTS.md n'admet que
    // la suppression logique — qui ne repare pas une donnee douteuse, elle la cache. Ce test
    // existe parce que c'est le genre de regle qu'on enfreint sans y penser.
    const familles = Object.keys(CORRECTION_PROPOSEE) as (keyof typeof CORRECTION_PROPOSEE)[];
    expect(familles).toHaveLength(9);
    for (const f of familles) {
      const texte = CORRECTION_PROPOSEE[f].toLowerCase();
      // « ne jamais supprimer » et « et non supprimer » sont des interdictions, pas des
      // instructions : on ne cherche donc qu'un impératif de suppression.
      expect(texte).not.toMatch(/^supprimer/);
      expect(texte).not.toMatch(/\bpuis supprimer\b/);
    }
  });
});
