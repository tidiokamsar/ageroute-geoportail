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

/**
 * Le chiffre en tete d'affiche du site public.
 *
 * Il valait la somme de `longueurKm` — les seules longueurs SAISIES. Mesure du
 * 05/09/2026 sur la charge utile reelle : 1 028 des 1 691 troncons servis (61 %)
 * n'en portent aucune, et ce sont TOUS des routes regionales. Une seule des 1 029 RR
 * est renseignee, pour 56 km, la ou leur trace en mesure 13 296.
 *
 * Le site annoncait donc « 7 933 km de routes » a un pays dont le reseau classe en
 * mesure 21 157. La somme n'etait pas fausse ; l'enonce l'etait.
 */
describe("La longueur affichee est celle du reseau, pas celle des saisies", () => {
  const reseauReel = [
    // Une nationale renseignee, comme les 621 RN.
    { classe: "RN", etat: "BON" as const, longueurKm: 120, etatDeclare: false },
    // Quatre regionales sans longueur, comme 1 028 des 1 029 RR.
    ...Array.from({ length: 4 }, () => ({
      classe: "RR", etat: "MOYEN" as const, longueurKm: 0, etatDeclare: false,
    })),
  ];

  it("prend la longueur mesuree quand le serveur la fournit", () => {
    const s = calculerStats(reseauReel as never, 0, 0, 21157);
    expect(s.totalKm).toBe(21157);
    expect(s.totalMesure).toBe(true);
  });

  it("n'annonce plus le total des seules saisies", () => {
    // Sans la mesure, ce jeu annoncerait 120 km pour cinq routes.
    const s = calculerStats(reseauReel as never, 0, 0, 21157);
    expect(s.totalKm).not.toBe(120);
  });

  it("retombe sur la somme si le serveur ne fournit rien", () => {
    // Un serveur anterieur au changement ne doit pas faire afficher 0 km.
    const s = calculerStats(reseauReel as never, 0, 0);
    expect(s.totalKm).toBe(120);
    expect(s.totalMesure).toBe(false);
  });

  it("ignore une mesure absurde plutot que de l'afficher", () => {
    expect(calculerStats(reseauReel as never, 0, 0, 0).totalKm).toBe(120);
    expect(calculerStats(reseauReel as never, 0, 0, -5).totalKm).toBe(120);
  });

  it("garde des parts d'etat qui totalisent 100 %", () => {
    // Le piege : rapporter les parts au total MESURE alors qu'elles ne portent que
    // sur le lineaire saisi ferait une barre d'etat vide a 99 %.
    const s = calculerStats(reseauReel as never, 0, 0, 21157);
    const somme = s.parEtat.reduce((t, e) => t + e.pct, 0);
    expect(somme).toBe(100);
  });
});
