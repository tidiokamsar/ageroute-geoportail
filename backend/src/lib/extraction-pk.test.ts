import { describe, expect, it } from "vitest";
import { extraireReference } from "./extraction-pk";

/**
 * Extraction d'une reference lineaire depuis un intitule de chantier.
 *
 * Tous les intitules cites ici sont REELS, releves en production le 01/09/2026. Le
 * principe teste est celui du §18 du cahier des charges : refuser plutot que deviner.
 *
 * Resultat mesure sur les 36 intitules contenant a la fois une route et un PK :
 *   11 emprises en confiance HIGH
 *    3 emprises en confiance MEDIUM (aucune longueur pour recouper)
 *   19 rattachements a la route seule (un seul PK)
 *    3 refus (deux routes citees)
 */

describe("Extraction route + PK", () => {
  it("extrait une emprise nette et la recoupe avec la longueur citée", () => {
    const r = extraireReference("lot 12:travaux de cantonnage manuel de la route  PK24  - PK66  RN5 ( 42 km)");
    expect(r.route).toBe("RN5");
    expect(r.pkDebut).toBe(24);
    expect(r.pkFin).toBe(66);
    expect(r.longueurCiteeKm).toBe(42);
    expect(r.confiance).toBe("HIGH");
    expect(r.methode).toBe("INTITULE_ROUTE_PK");
    expect(r.motif).toMatch(/cohérente/);
  });

  it("REFUSE quand deux routes sont citées", () => {
    // « rn23- rn5 » : on ne sait pas a laquelle rattacher les PK.
    const r = extraireReference("lot 11:travaux de cantonnage manuel de la route Gaoual (Kounsitel) - pk 24 rn23- rn5 ( 41 km)");
    expect(r.methode).toBeNull();
    expect(r.pkDebut).toBeNull();
    expect(r.routesCitees).toHaveLength(2);
    expect(r.motif).toMatch(/ambigu/);
  });

  it("REFUSE aussi quand les deux routes sont séparées dans le texte", () => {
    const r = extraireReference(
      "Projet de Construction de deux routes d’intégration régionale Dabola-Kouroussa (RN1) et Kissidougou PK63-Guéckédou (RN2) Lot 1: Dabola - Cisséla (68,06 Km)"
    );
    expect(r.methode).toBeNull();
    expect(r.routesCitees.sort()).toEqual(["RN1", "RN2"]);
  });

  it("ne fabrique pas d'emprise à partir d'un seul PK", () => {
    // « Kankan - pk 41 » : l'autre extremite est une localite, qu'aucun referentiel
    // ne permet de resoudre aujourd'hui.
    const r = extraireReference("lot 29 : travaux de cantonnage manuel de la route nationale Kankan - pk 41 (Kouroussa) rn 1");
    expect(r.route).toBe("RN1");
    expect(r.pkDebut).toBeNull();
    expect(r.methode).toBe("INTITULE_ROUTE_SEULE");
    expect(r.confiance).toBe("LOW");
    expect(r.motif).toMatch(/localité/);
  });

  it("lit une route écrite avec un espace ou un tiret", () => {
    for (const [texte, attendu] of [
      ["route rn 6 pk 53 - pk 106", "RN6"],
      ["route RN-5 pk 1 - pk 2", "RN5"],
      ["route (RN2) pk 1 - pk 2", "RN2"],
      ["route rn23 pk 1 - pk 2", "RN23"],
    ] as const) {
      expect(extraireReference(texte).route).toBe(attendu);
    }
  });

  it("convertit un décalage métrique après le +", () => {
    // « PK94+300 » vaut 94,3 km. Et l'intervalle obtenu — 40,8 km — correspond
    // exactement a la longueur citee dans l'intitule reel.
    const r = extraireReference(
      "Travaux de rehabilitation d'un tronçon de la route de 40,8km et de reconstruction de deux (2) ponts en béton armé de 15 et 8ml sur la RN38 entre Boula et la Frontière Côte d'ivoire respectivement situés au PK94+300 et PK135+100"
    );
    expect(r.pkDebut).toBeCloseTo(94.3, 3);
    expect(r.pkFin).toBeCloseTo(135.1, 3);
    expect(r.longueurCiteeKm).toBe(40.8);
    expect(r.confiance).toBe("HIGH");
  });

  it("retient les PK extrêmes quand une localité s'intercale", () => {
    const r = extraireReference(
      "lot 33 : travaux de cantonnage manuel de la route nationale pk 106 - Siguiri - pk 160 axe Kankan - Kouremalé (54 km) rn 6"
    );
    expect(r.pkDebut).toBe(106);
    expect(r.pkFin).toBe(160);
    expect(r.confiance).toBe("HIGH");
  });

  it("baisse la confiance quand la longueur citée contredit l'intervalle", () => {
    const r = extraireReference("route RN5 pk 10 - pk 20 (80 km)");
    expect(r.pkDebut).toBe(10);
    expect(r.confiance).toBe("LOW");
    expect(r.motif).toMatch(/s'écarte de/);
  });

  it("n'accorde pas la confiance haute sans longueur pour recouper", () => {
    const r = extraireReference("lot 8:travaux de cantonnage manuel de la route nationale Kagbelen- Boké tronçon  Boffa pk 39 Tanené (pk 78) rn 3");
    expect(r.pkDebut).toBe(39);
    expect(r.pkFin).toBe(78);
    expect(r.confiance).toBe("MEDIUM");
    expect(r.motif).toMatch(/aucune longueur citée/);
  });

  it("refuse une emprise nulle", () => {
    const r = extraireReference("route RN5 pk 30 et pk 30");
    expect(r.pkDebut).toBeNull();
    expect(r.motif).toMatch(/identiques/);
  });

  it("rattache à la route quand aucun PK n'est cité", () => {
    const r = extraireReference("Travaux de réhabilitation de la RN4 entre deux villages");
    expect(r.route).toBe("RN4");
    expect(r.methode).toBe("INTITULE_ROUTE_SEULE");
    expect(r.motif).toMatch(/sans emprise/);
  });

  it("ne propose rien sans route", () => {
    const r = extraireReference("Construction pont du Konkoure (2eme ouvrage)");
    expect(r.route).toBeNull();
    expect(r.methode).toBeNull();
    expect(r.motif).toMatch(/aucune désignation/);
  });

  it("ne confond pas les mètres linéaires avec des kilomètres", () => {
    // « 1543ml » est une longueur en metres : elle ne doit pas etre lue comme 1 543 km.
    const r = extraireReference("Travaux de résurfaçage en BB de 1543ml sur la RN1 pk 4 - pk 6");
    expect(r.longueurCiteeKm).toBeNull();
  });

  it("supporte un intitulé vide ou absent", () => {
    for (const v of ["", "   ", null, undefined]) {
      const r = extraireReference(v);
      expect(r.methode).toBeNull();
      expect(r.motif.length).toBeGreaterThan(5);
    }
  });

  it("donne toujours un motif, y compris en cas de refus", () => {
    const cas = [
      "lot 12: route PK24 - PK66 RN5 (42 km)",
      "route rn23- rn5 pk 24",
      "route rn 1 Kankan - pk 41",
      "Construction pont du Konkoure",
      "",
    ];
    for (const c of cas) expect(extraireReference(c).motif.length).toBeGreaterThan(8);
  });
});
