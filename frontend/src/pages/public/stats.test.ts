import { describe, expect, it } from "vitest";
import { calculerStats } from "./stats";
import type { PublicTroncon } from "./types";

/**
 * Lecture chiffree du reseau public.
 *
 * Le calcul portait une affirmation fausse et invisible : « 15 % du reseau en bon
 * etat » additionnait les releves de terrain et les declarations de gestionnaire.
 * Depuis la promotion de la voirie, les secondes pesent des centaines de kilometres.
 * Ces tests fixent la separation.
 */

function t(p: Partial<PublicTroncon> = {}): PublicTroncon {
  return {
    id: Math.random().toString(36).slice(2),
    code: "X", nom: "X", classe: "RN", etat: "BON",
    longueurKm: 10, region: "Conakry", geometry: null, ...p,
  };
}

describe("Le total et la répartition", () => {
  it("additionne les longueurs", () => {
    const s = calculerStats([t({ longueurKm: 10 }), t({ longueurKm: 5.4 })], 0, 0);
    expect(s.totalKm).toBe(15);
  });

  it("n'affiche pas les états absents du réseau", () => {
    const s = calculerStats([t({ etat: "BON" })], 0, 0);
    expect(s.parEtat.map((e) => e.etat)).toEqual(["BON"]);
  });

  it("classe les états du meilleur au pire", () => {
    const s = calculerStats(
      [t({ etat: "CRITIQUE" }), t({ etat: "BON" }), t({ etat: "MOYEN" })], 0, 0,
    );
    expect(s.parEtat.map((e) => e.etat)).toEqual(["BON", "MOYEN", "CRITIQUE"]);
  });

  it("ne divise pas par zéro sur un réseau vide", () => {
    const s = calculerStats([], 0, 0);
    expect(s.totalKm).toBe(0);
    expect(s.parEtat).toEqual([]);
    expect(s.kmDeclare).toBe(0);
  });

  it("tolère une longueur absente", () => {
    const s = calculerStats([t({ longueurKm: undefined as unknown as number })], 0, 0);
    expect(s.totalKm).toBe(0);
  });
});

describe("Ce qui est déclaré est compté à part", () => {
  it("sépare le déclaré du constaté dans un même état", () => {
    const s = calculerStats(
      [
        t({ etat: "BON", longueurKm: 30 }),
        t({ etat: "BON", longueurKm: 70, etatDeclare: true }),
      ],
      0, 0,
    );
    const bon = s.parEtat.find((e) => e.etat === "BON")!;
    expect(bon.km).toBe(100);
    expect(bon.kmDeclare).toBe(70);
  });

  it("totalise le déclaré tous états confondus", () => {
    const s = calculerStats(
      [
        t({ etat: "BON", longueurKm: 20, etatDeclare: true }),
        t({ etat: "MOYEN", longueurKm: 30, etatDeclare: true }),
        t({ etat: "MAUVAIS", longueurKm: 50 }),
      ],
      0, 0,
    );
    expect(s.kmDeclare).toBe(50);
  });

  it("ne déclare rien quand l'information est absente", () => {
    // L'absence de drapeau ne vaut pas verification : elle ne dit rien. Les 1 690
    // troncons anterieurs ne doivent donc pas basculer du cote « declare ».
    const s = calculerStats([t({ etat: "BON", longueurKm: 40 })], 0, 0);
    expect(s.kmDeclare).toBe(0);
    expect(s.parEtat[0].kmDeclare).toBe(0);
  });
});

describe("La répartition par type de route", () => {
  it("compte kilomètres et tronçons par classe", () => {
    const s = calculerStats(
      [
        t({ classe: "RN", longueurKm: 100 }),
        t({ classe: "RN", longueurKm: 50 }),
        t({ classe: "NON_CLASSEE", longueurKm: 3 }),
      ],
      0, 0,
    );
    expect(s.parClasse).toEqual([
      { classe: "RN", km: 150, troncons: 2 },
      { classe: "NON_CLASSEE", km: 3, troncons: 1 },
    ]);
  });

  it("va du plus structurant au moins classé", () => {
    const s = calculerStats(
      [t({ classe: "NON_CLASSEE" }), t({ classe: "RU" }), t({ classe: "RN" })], 0, 0,
    );
    expect(s.parClasse.map((c) => c.classe)).toEqual(["RN", "RU", "NON_CLASSEE"]);
  });

  it("n'invente pas les classes absentes", () => {
    const s = calculerStats([t({ classe: "RN" })], 0, 0);
    expect(s.parClasse).toHaveLength(1);
  });

  it("garde une classe inconnue du référentiel plutôt que de la perdre", () => {
    // Si une valeur d'enum apparait sans que le client soit a jour, la faire
    // disparaitre de la carte serait pire que de l'afficher telle quelle.
    const s = calculerStats([t({ classe: "RN" }), t({ classe: "FUTURE" })], 0, 0);
    expect(s.parClasse.map((c) => c.classe)).toEqual(["RN", "FUTURE"]);
  });
});
