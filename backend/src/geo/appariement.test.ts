import { describe, expect, it } from "vitest";
import {
  choisir, confiance, pkDeFraction,
  CONFIANCE_MINIMALE, DISTANCE_MAX_PAR_DEFAUT_M,
  INCERTITUDE_MINIMALE_M, INCERTITUDE_PAR_DEFAUT_M,
  type Candidat,
} from "./appariement";

/**
 * La decision d'appariement, isolee de PostGIS.
 *
 * CE QUE CES TESTS DEFENDENT
 *
 * Mesure du 07/10/2026 sur la production : a 5 m d'erreur GPS, 199 appariements sur
 * 200 sont corrects. A 15 m, les nationales et regionales tiennent (97 % et 99 %)
 * mais l'urbain s'effondre, 0 sur 6. En ville, une erreur de 15 m fait changer de rue
 * — et le trace voisin est aussi proche que le bon.
 *
 * Un moteur qui rend toujours le plus proche se trompe donc silencieusement la ou le
 * reseau est dense, c'est-a-dire la ou il y a le plus d'objets a inventorier. La
 * parade n'est pas d'ameliorer la distance, c'est de mesurer la SEPARATION d'avec le
 * deuxieme candidat et de se taire quand elle est nulle.
 *
 * Ces tests fixent ce refus. Un moteur qui conclut toujours les ferait tous echouer.
 */

const troncon = (p: Partial<Candidat> = {}): Candidat => ({
  tronconId: "t1", code: "RN1-001", nom: "RN1", classe: "RN",
  distanceM: 4, fraction: 0.5, pkDebut: 10, pkFin: 20,
  ...p,
});

describe("La confiance combine l'ecart au trace et la separation", () => {
  it("est pleine quand le point est sur le trace et seul candidat", () => {
    expect(confiance(0, null, 5)).toBe(1);
  });

  it("decroit quand le point s'eloigne du trace", () => {
    const suite = [0, 5, 10, 15, 20].map((d) => confiance(d, null, 5));
    for (let i = 1; i < suite.length; i++) expect(suite[i]).toBeLessThanOrEqual(suite[i - 1]);
    expect(suite.at(-1)).toBe(0);
  });

  it("S'ANNULE quand un autre troncon est a la meme distance", () => {
    // Le cas urbain mesure : le bon trace est proche, celui d'a cote aussi. Choisir
    // revient a tirer a pile ou face, et une piece ne merite pas d'etre crue.
    expect(confiance(4, 4, 15)).toBe(0);
    expect(confiance(1, 1.5, 15)).toBe(0.03);
  });

  it("remonte des que le second candidat s'ecarte", () => {
    const serre = confiance(4, 6, 10);
    const net = confiance(4, 30, 10);
    expect(net).toBeGreaterThan(serre);
    expect(net).toBeGreaterThan(0.5);
  });

  it("traite une incertitude absurde comme le plancher", () => {
    // Un appareil qui annonce 0 m ment ; on ne divise pas par sa pretention.
    expect(confiance(2, null, 0)).toBe(confiance(2, null, INCERTITUDE_MINIMALE_M));
  });
});

describe("Le PK n'est pas invente", () => {
  it("se calcule quand le troncon porte un intervalle", () => {
    expect(pkDeFraction(0.5, 10, 20)).toEqual({ pk: 15, motif: "CALCULE" });
    expect(pkDeFraction(0, 10, 20).pk).toBe(10);
    expect(pkDeFraction(1, 10, 20).pk).toBe(20);
  });

  it("reste NUL quand le troncon n'en porte pas", () => {
    // 1 140 des 1 691 troncons du reseau classe sont dans ce cas, dont les 1 029
    // regionales. Substituer un kilometrage geometrique repondrait a une autre
    // question et ferait passer une derivation pour un PK officiel.
    for (const [d, f] of [[null, null], [0, 0], [10, 10], [20, 10]] as [number | null, number | null][]) {
      expect(pkDeFraction(0.5, d, f)).toEqual({ pk: null, motif: "TRONCON_SANS_PK" });
    }
  });

  it("borne la fraction, qu'un arrondi peut faire deborder", () => {
    expect(pkDeFraction(1.0001, 10, 20).pk).toBe(20);
    expect(pkDeFraction(-0.0001, 10, 20).pk).toBe(10);
  });
});

describe("Le moteur sait ne pas conclure", () => {
  const decider = (c: Candidat[], incertitude = INCERTITUDE_PAR_DEFAUT_M) =>
    choisir(c, incertitude, DISTANCE_MAX_PAR_DEFAUT_M, CONFIANCE_MINIMALE);

  it("ne rend rien sans candidat", () => {
    expect(decider([])).toBeNull();
  });

  it("ne rattache pas un point trop loin de toute route", () => {
    // Un agent qui s'arrete a 200 m de la chaussee n'est pas sur la chaussee.
    expect(decider([troncon({ distanceM: 200 })])).toBeNull();
  });

  it("REFUSE quand deux troncons se valent — le cas urbain", () => {
    const refus = decider([
      troncon({ tronconId: "rue-a", distanceM: 6 }),
      troncon({ tronconId: "rue-b", distanceM: 7 }),
    ], 15);
    expect(refus).toBeNull();
  });

  it("conclut sur le meme point si le GPS est bon", () => {
    // Memes candidats, incertitude de 3 m au lieu de 15 : 1 m de separation devient
    // significatif. C'est la precision annoncee qui decide, pas la distance seule.
    const choisi = decider([
      troncon({ tronconId: "rue-a", distanceM: 2 }),
      troncon({ tronconId: "rue-b", distanceM: 9 }),
    ], 3);
    expect(choisi?.tronconId).toBe("rue-a");
  });

  it("conclut quand un seul troncon est a portee", () => {
    const choisi = decider([troncon({ distanceM: 4 }), troncon({ tronconId: "loin", distanceM: 80 })], 5);
    expect(choisi).not.toBeNull();
    expect(choisi!.tronconId).toBe("t1");
    expect(choisi!.ambigu).toBe(false);
    expect(choisi!.pk).toBe(15);
  });

  it("signale l'ambiguite meme quand il conclut", () => {
    // Conclure et prevenir valent mieux que refuser tout net : l'appelant peut
    // demander confirmation a l'agent, qui lui voit la route.
    const choisi = choisir(
      [troncon({ distanceM: 1 }), troncon({ tronconId: "voisine", distanceM: 4 })],
      5, DISTANCE_MAX_PAR_DEFAUT_M, 0.1,
    );
    expect(choisi).not.toBeNull();
    expect(choisi!.ambigu).toBe(true);
  });

  it("rend un PK nul sans refuser l'appariement", () => {
    // Savoir OU sans savoir a quel PK reste utile : l'observation se rattache au
    // troncon. Le contraire — un PK sans troncon — n'aurait aucun sens.
    const choisi = decider([troncon({ pkDebut: 0, pkFin: 0, distanceM: 3 })], 5);
    expect(choisi).not.toBeNull();
    expect(choisi!.pk).toBeNull();
    expect(choisi!.pkMotif).toBe("TRONCON_SANS_PK");
  });

  it("arrondit la distance sans la deformer", () => {
    const choisi = decider([troncon({ distanceM: 4.26 })], 5);
    expect(choisi!.distanceM).toBe(4.3);
  });
});
