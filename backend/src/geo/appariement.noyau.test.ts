import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  confianceComplete, facteurCap, facteurContinuite, decider, scorer,
  SEUIL_PRESELECTION, SEPARATION_PRESELECTION, CONFIANCE_MINIMALE,
  VITESSE_CAP_MINIMALE_KMH, PRECISION_MAX_RATTACHEMENT_M,
  type CandidatNoyau, type ContexteAppariement,
} from "./appariement.noyau";

/**
 * Noyau d'appariement : ce que ces tests defendent.
 *
 * POURQUOI UN NOYAU SEPARE, ET CE QUE CELA DEBLOQUE
 *
 * Le paragraphe 7.3 exige l'algorithme « cote serveur ET embarque cote mobile (hors ligne) ».
 * `geo/appariement.ts` melangeait la decision et la requete : il importe Prisma, donc importer
 * `confiance()` entrainait Prisma avec elle. Le noyau etait inextricable, et l'argument central
 * de l'ADR-002 — « les regles sont deja partageables » — ne tenait pas pour celle-ci.
 *
 * Ce module n'importe rien. Un test ci-dessous le VERIFIE, parce qu'une dependance ajoutee un
 * jour par commodite casserait le portage mobile sans que rien ne le signale.
 *
 * LES CINQ FACTEURS DU PARAGRAPHE 7.3.3, DONT DEUX MANQUAIENT
 *
 *   distance normalisee              existait
 *   precision GPS                    existait, incluse dans l'ecart
 *   ecart avec le 2e candidat        existait
 *   ecart cap de deplacement / orientation du troncon    ABSENT
 *   continuite avec le troncon precedemment confirme     ABSENT
 *
 * Mesure du 14/10/2026 : `heading` comptait ZERO occurrence dans le depot.
 *
 * LA DECISION A TROIS ISSUES, ET NON DEUX
 *
 * Le paragraphe 7.3.4 demande trois sorties la ou le code n'en avait que deux (rattacher ou
 * rien) : preselection confirmable en un geste, liste de candidats a trancher par l'agent, ou
 * observation non rattachee avec le GPS brut conserve.
 */

function c(p: Partial<CandidatNoyau> & { tronconId: string; distanceM: number }): CandidatNoyau {
  return {
    code: p.tronconId, nom: null, classe: "RN",
    fraction: 0.5, longueurM: 1000, pkDebut: null, pkFin: null,
    capTronconDeg: null,
    ...p,
  };
}

const ctx = (p: Partial<ContexteAppariement> = {}): ContexteAppariement => ({
  incertitudeM: 5, capDeg: null, vitesseKmH: null, tronconPrecedentId: null, ...p,
});

describe("Le noyau ne depend de rien, et c'est teste", () => {
  it("n'importe ni Prisma ni Express, pour rester portable sur mobile", () => {
    const source = readFileSync(join(__dirname, "appariement.noyau.ts"), "utf8");
    const imports = [...source.matchAll(/^import .*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    // Aucun import du tout est l'etat souhaite ; s'il en apparait un, il doit etre relatif
    // et lui-meme pur. Un paquet installe (@prisma/client, express…) casserait le portage.
    for (const i of imports) {
      expect(i.startsWith("."), `import non relatif : ${i}`).toBe(true);
    }
    expect(source).not.toMatch(/@prisma\/client|from "express"|node:/);
  });
});

describe("Facteur de cap : l'orientation du troncon contre celle du deplacement", () => {
  it("vaut 1 quand l'appareil n'annonce pas de cap", () => {
    expect(facteurCap(null, 90, 60)).toBe(1);
  });

  it("vaut 1 quand le troncon n'a pas d'orientation locale connue", () => {
    expect(facteurCap(90, null, 60)).toBe(1);
  });

  it("vaut 1 a l'arret : un cap mesure immobile ne veut rien dire", () => {
    // Un GPS immobile rend un cap aleatoire. Le prendre en compte penaliserait au hasard.
    expect(facteurCap(0, 90, 2)).toBe(1);
    expect(facteurCap(0, 90, null)).toBe(1);
  });

  it("vaut 1 pour un deplacement aligne avec le troncon", () => {
    expect(facteurCap(90, 90, 60)).toBe(1);
  });

  it("vaut 1 pour un deplacement a CONTRESENS : une route se parcourt dans les deux sens", () => {
    // C'est le piege de ce facteur. Un cap oppose de 180 degres est parfaitement coherent
    // avec le troncon : l'agent le descend au lieu de le monter.
    expect(facteurCap(270, 90, 60)).toBe(1);
  });

  it("s'annule pour un deplacement perpendiculaire", () => {
    expect(facteurCap(0, 90, 60)).toBe(0);
    expect(facteurCap(180, 90, 60)).toBe(0);
  });

  it("decroit continument entre les deux", () => {
    const a45 = facteurCap(45, 90, 60);
    expect(a45).toBeGreaterThan(0);
    expect(a45).toBeLessThan(1);
    expect(facteurCap(60, 90, 60)).toBeGreaterThan(a45);
  });

  it("traite les caps au-dela de 360 et negatifs sans se tromper", () => {
    expect(facteurCap(450, 90, 60)).toBe(1);
    expect(facteurCap(-270, 90, 60)).toBe(1);
  });
});

describe("Facteur de continuite : rester sur le troncon deja confirme", () => {
  const sur = c({ tronconId: "A", distanceM: 4 });
  const autre = c({ tronconId: "B", distanceM: 6 });

  it("vaut 1 partout quand aucun troncon n'a ete confirme avant", () => {
    expect(facteurContinuite(autre, [sur, autre], null, 5)).toBe(1);
  });

  it("vaut 1 pour le troncon deja confirme", () => {
    expect(facteurContinuite(sur, [sur, autre], "A", 5)).toBe(1);
  });

  it("PENALISE un autre troncon quand le precedent est encore a portee", () => {
    // Sur une route droite, le trace voisin est souvent aussi proche. La continuite est ce
    // qui empeche de sauter d'un troncon a l'autre a chaque point.
    expect(facteurContinuite(autre, [sur, autre], "A", 5)).toBeLessThan(1);
  });

  it("NE PENALISE PAS quand le precedent n'est plus a portee : on a vraiment quitte", () => {
    // Au carrefour, l'agent change legitimement de troncon. Penaliser alors ferait coller
    // l'appariement a un troncon qu'on a quitte, ce qui est le defaut inverse et pire.
    const loin = c({ tronconId: "A", distanceM: 40 });
    expect(facteurContinuite(autre, [autre, loin], "A", 5)).toBe(1);
  });

  it("ne penalise pas quand le precedent n'est plus candidat du tout", () => {
    expect(facteurContinuite(autre, [autre], "A", 5)).toBe(1);
  });
});

describe("La confiance complete reste multiplicative", () => {
  it("retrouve l'ancien resultat quand ni cap ni continuite ne s'appliquent", () => {
    // Non-regression : les deux facteurs neutres valent 1, donc la formule a deux facteurs
    // est un cas particulier de celle a quatre.
    const r = confianceComplete(c({ tronconId: "A", distanceM: 4 }), [
      c({ tronconId: "A", distanceM: 4 }), c({ tronconId: "B", distanceM: 14 }),
    ], ctx({ incertitudeM: 5 }));
    expect(r).toBeGreaterThan(0.7);
  });

  it("s'annule quand un seul facteur s'annule, parce qu'ils doivent TOUS tenir", () => {
    const perpendiculaire = confianceComplete(
      c({ tronconId: "A", distanceM: 2, capTronconDeg: 90 }),
      [c({ tronconId: "A", distanceM: 2, capTronconDeg: 90 })],
      ctx({ capDeg: 0, vitesseKmH: 60 }),
    );
    expect(perpendiculaire).toBe(0);
  });

  it("s'annule quand le second candidat est a la meme distance, cap ou pas", () => {
    const r = confianceComplete(
      c({ tronconId: "A", distanceM: 3, capTronconDeg: 90 }),
      [c({ tronconId: "A", distanceM: 3, capTronconDeg: 90 }),
       c({ tronconId: "B", distanceM: 3, capTronconDeg: 90 })],
      ctx({ capDeg: 90, vitesseKmH: 60 }),
    );
    expect(r).toBe(0);
  });
});

describe("Le classement des candidats", () => {
  it("remonte le troncon deja confirme devant un concurrent a peine plus proche", () => {
    // Le cas qui justifie la continuite : B est a 4 m, A a 5 m, mais A est celui qu'on
    // suivait. Sans continuite, l'appariement saute sur B.
    const liste = [c({ tronconId: "B", distanceM: 4 }), c({ tronconId: "A", distanceM: 5 })];
    const classe = scorer(liste, ctx({ incertitudeM: 8, tronconPrecedentId: "A" }));
    expect(classe[0].candidat.tronconId).toBe("A");
  });

  it("ne remonte PAS le precedent quand il est franchement plus loin", () => {
    const liste = [c({ tronconId: "B", distanceM: 3 }), c({ tronconId: "A", distanceM: 45 })];
    const classe = scorer(liste, ctx({ incertitudeM: 5, tronconPrecedentId: "A" }));
    expect(classe[0].candidat.tronconId).toBe("B");
  });

  it("rend les candidats avec leur score, du meilleur au pire", () => {
    const classe = scorer(
      [c({ tronconId: "A", distanceM: 2 }), c({ tronconId: "B", distanceM: 30 })],
      ctx({ incertitudeM: 5 }),
    );
    expect(classe.map((x) => x.candidat.tronconId)).toEqual(["A", "B"]);
    expect(classe[0].confiance).toBeGreaterThanOrEqual(classe[1].confiance);
  });
});

describe("Les trois issues du paragraphe 7.3.4", () => {
  const bon = [c({ tronconId: "A", distanceM: 1 }), c({ tronconId: "B", distanceM: 40 })];

  it("PRESELECTION quand le score est haut ET l'ecart au 2e suffisant", () => {
    const d = decider(bon, ctx({ incertitudeM: 4 }));
    expect(d.issue).toBe("PRESELECTION");
    if (d.issue !== "PRESELECTION") return;
    expect(d.appariement.tronconId).toBe("A");
    expect(d.appariement.confiance).toBeGreaterThanOrEqual(SEUIL_PRESELECTION);
  });

  it("CHOIX_AGENT quand le score passe le minimum sans atteindre la preselection", () => {
    // Nombres choisis pour tomber ENTRE les seuils, et non pour saturer la formule : avec
    // u = 8, A a 14 m donne une qualite de 0,625 et une separation de 0,75, soit une
    // confiance de 0,47 — au-dessus de 0,35, en dessous de 0,85.
    const d = decider(
      [c({ tronconId: "A", distanceM: 14 }), c({ tronconId: "B", distanceM: 20 })],
      ctx({ incertitudeM: 8 }),
    );
    expect(d.issue).toBe("CHOIX_AGENT");
    if (d.issue !== "CHOIX_AGENT") return;
    // L'agent doit voir PLUSIEURS candidats, sinon il n'a rien a trancher.
    expect(d.candidats.length).toBeGreaterThan(1);
  });

  it("CHOIX_AGENT meme avec un score haut si les deux premiers sont trop proches", () => {
    // Le paragraphe 7.3.4 exige les DEUX conditions. Un score haut avec un concurrent
    // colle ne se confirme pas en un geste : c'est le cas urbain.
    const d = decider(
      [c({ tronconId: "A", distanceM: 2 }), c({ tronconId: "B", distanceM: 2.5 })],
      ctx({ incertitudeM: 4 }),
    );
    expect(d.issue).not.toBe("PRESELECTION");
  });

  it("NON_RATTACHE quand la precision depasse le plafond, quoi que dise la distance", () => {
    // « sous le seuil bas OU precision > 50 m ». Une position a 80 m d'incertitude ne
    // rattache rien, meme si un trace passe a un metre : le metre est illusoire.
    const d = decider(bon, ctx({ incertitudeM: PRECISION_MAX_RATTACHEMENT_M + 1 }));
    expect(d.issue).toBe("NON_RATTACHE");
    if (d.issue !== "NON_RATTACHE") return;
    expect(d.motif).toBe("PRECISION_INSUFFISANTE");
  });

  it("NON_RATTACHE sans aucun candidat", () => {
    const d = decider([], ctx());
    expect(d.issue).toBe("NON_RATTACHE");
    if (d.issue !== "NON_RATTACHE") return;
    expect(d.motif).toBe("AUCUN_CANDIDAT");
  });

  it("NON_RATTACHE quand le plus proche est au-dela de la distance maximale", () => {
    const d = decider([c({ tronconId: "A", distanceM: 120 })], ctx({ incertitudeM: 5 }));
    expect(d.issue).toBe("NON_RATTACHE");
    if (d.issue !== "NON_RATTACHE") return;
    expect(d.motif).toBe("TROP_LOIN");
  });

  it("NON_RATTACHE quand la confiance tombe sous le minimum", () => {
    const d = decider(
      [c({ tronconId: "A", distanceM: 10 }), c({ tronconId: "B", distanceM: 10.2 })],
      ctx({ incertitudeM: 10 }),
    );
    expect(d.issue).toBe("NON_RATTACHE");
    if (d.issue !== "NON_RATTACHE") return;
    expect(d.motif).toBe("CONFIANCE_INSUFFISANTE");
  });

  it("rend TOUJOURS les candidats examines, meme quand elle ne rattache pas", () => {
    // Le paragraphe 7.3.6 exige de conserver « le candidat retenu » et les elements du
    // choix. Un refus muet empecherait un rattachement ulterieur au bureau.
    const d = decider(
      [c({ tronconId: "A", distanceM: 10 }), c({ tronconId: "B", distanceM: 10.2 })],
      ctx({ incertitudeM: 10 }),
    );
    if (d.issue !== "NON_RATTACHE") throw new Error("issue inattendue");
    expect(d.candidats.length).toBe(2);
  });

  it("les seuils sont ceux du mandat", () => {
    expect(SEUIL_PRESELECTION).toBe(0.85);
    expect(SEPARATION_PRESELECTION).toBe(0.2);
    expect(PRECISION_MAX_RATTACHEMENT_M).toBe(50);
    expect(CONFIANCE_MINIMALE).toBe(0.35);
    expect(VITESSE_CAP_MINIMALE_KMH).toBeGreaterThan(0);
  });
});
