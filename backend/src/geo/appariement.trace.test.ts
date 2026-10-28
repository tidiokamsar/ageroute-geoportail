/**
 * Tests du map-matching de trace (HMM), et MESURE du critere A18.
 *
 * A18 exige « >= 97 % des points sur le bon troncon sur le jeu de test ». Le test ci-dessous
 * calcule ce taux et le fait echouer s'il tombe sous le seuil — il ne se contente pas de
 * verifier que la fonction rend quelque chose.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  apparierTrace,
  distanceHaversineM,
  logProbaEmission,
  logProbaTransition,
  BETA_TRANSITION_PAR_DEFAUT_M,
  type PointTrace,
} from "./appariement.trace";
import { TRACES_ANNOTEES, distanceReseauScenarios } from "./appariement.trace-annotee";
import { PRECISION_MAX_RATTACHEMENT_M } from "./appariement.noyau";

describe("Le module de trace reste portable sur mobile", () => {
  it("n'importe que du relatif, comme le noyau ponctuel", () => {
    for (const fichier of ["appariement.trace.ts", "appariement.trace-annotee.ts"]) {
      const source = readFileSync(join(__dirname, fichier), "utf8");
      const imports = [...source.matchAll(/^import .*?from\s+["']([^"']+)["']/gm)].map(
        (m) => m[1],
      );
      for (const i of imports) {
        expect(i.startsWith("."), `${fichier} : import non relatif ${i}`).toBe(true);
      }
      expect(source).not.toMatch(/@prisma\/client|from "express"|node:/);
    }
  });
});

describe("Les briques de probabilite", () => {
  it("mesure une distance orthodromique plausible a Conakry", () => {
    // Un degre de latitude vaut environ 110,6 km partout.
    const d = distanceHaversineM(
      { lat: 9.6412, lon: -13.5784 },
      { lat: 9.7412, lon: -13.5784 },
    );
    expect(d).toBeGreaterThan(11000);
    expect(d).toBeLessThan(11200);
  });

  it("rend zero metre pour deux fois le meme point", () => {
    const p = { lat: 9.6412, lon: -13.5784 };
    expect(distanceHaversineM(p, p)).toBe(0);
  });

  it("decroit quand le point s'eloigne du trace", () => {
    expect(logProbaEmission(2, 15)).toBeGreaterThan(logProbaEmission(20, 15));
  });

  it("penalise moins un meme ecart quand le GPS est annonce comme mauvais", () => {
    // 20 m d'ecart est anormal avec un GPS a 5 m, banal avec un GPS a 40 m.
    const avecBonGps = logProbaEmission(20, 5);
    const avecMauvaisGps = logProbaEmission(20, 40);
    expect(avecMauvaisGps).toBeGreaterThan(avecBonGps);
  });

  it("decroit avec l'incoherence entre distance parcourue et distance reseau", () => {
    const coherent = logProbaTransition(0, BETA_TRANSITION_PAR_DEFAUT_M);
    const incoherent = logProbaTransition(500, BETA_TRANSITION_PAR_DEFAUT_M);
    expect(coherent).toBeGreaterThan(incoherent);
  });

  it("traite symetriquement un ecart positif et negatif", () => {
    expect(logProbaTransition(30, 10)).toBe(logProbaTransition(-30, 10));
  });
});

describe("Critere A18 — rattachement de trace par HMM", () => {
  const resultats = TRACES_ANNOTEES.map((trace) => ({
    trace,
    resultat: apparierTrace(trace.points, {
      distanceReseauM: distanceReseauScenarios,
    }),
  }));

  it.each(resultats)("$trace.nom : chaque point sur le troncon attendu", ({ trace, resultat }) => {
    expect(resultat.points).toHaveLength(trace.points.length);
    for (let i = 0; i < trace.attendu.length; i += 1) {
      expect(
        resultat.points[i].tronconId,
        `${trace.nom}, point ${i} : ${trace.pourquoi}`,
      ).toBe(trace.attendu[i]);
    }
  });

  it("atteint le seuil de 97 % exige, et le taux est affiche", () => {
    let attendus = 0;
    let justes = 0;
    let rupturesAttendues = 0;
    let rupturesJustes = 0;

    for (const { trace, resultat } of resultats) {
      for (let i = 0; i < trace.attendu.length; i += 1) {
        const cible = trace.attendu[i];
        if (cible === null) {
          rupturesAttendues += 1;
          if (resultat.points[i].tronconId === null) rupturesJustes += 1;
          continue;
        }
        attendus += 1;
        if (resultat.points[i].tronconId === cible) justes += 1;
      }
    }

    // LES CHIFFRES SONT AFFIRMES, PAS AFFICHES. Une premiere version comparait l'objet mesure
    // a lui-meme : elle affichait le taux dans la sortie de vitest sans rien verifier, donc
    // elle aurait laisse passer n'importe quelle valeur.
    expect({ attendus, justes, rupturesAttendues, rupturesJustes }).toEqual({
      attendus: 130,
      justes: 130,
      rupturesAttendues: 8,
      rupturesJustes: 8,
    });

    const taux = justes / attendus;
    expect(taux).toBeGreaterThanOrEqual(0.97);
    // Une sortie du referentiel non detectee serait pire qu'un mauvais troncon : elle
    // fabriquerait une route la ou il n'y en a pas.
    expect(rupturesJustes).toBe(rupturesAttendues);
  });
});

describe("Ce que la trace apporte, et ce qu'elle doit avouer", () => {
  it("tient la RN1 malgre dix points plus proches de la contre-allee", () => {
    const t1 = TRACES_ANNOTEES[0];
    // Combien de points le rattachement ponctuel aurait-il mal classes ? La contre-allee
    // est plus proche a chaque fois que le decalage depasse 12,5 m.
    const pointsTrompeurs = t1.points.filter((p) => {
      const rn1 = p.candidats.find((c) => c.tronconId === "rn1");
      const ca1 = p.candidats.find((c) => c.tronconId === "ca1");
      return rn1 && ca1 && ca1.distanceM < rn1.distanceM;
    }).length;
    expect(pointsTrompeurs).toBeGreaterThan(0);

    const resultat = apparierTrace(t1.points, { distanceReseauM: distanceReseauScenarios });
    expect(resultat.points.every((p) => p.tronconId === "rn1")).toBe(true);
    expect(resultat.chaines).toBe(1);
  });

  it("perd cet avantage sans graphe de reseau, et c'est mesure", () => {
    // SANS `distanceReseauM`, la transition entre deux troncons differents est neutre : le HMM
    // n'a aucun moyen de savoir que la contre-allee est a 800 m de detour. La decision retombe
    // sur l'emission, donc sur la distance seule.
    //
    // Ce test existe pour que personne ne lise « A18 : 100 % » sans savoir ce qui le porte.
    const t1 = TRACES_ANNOTEES[0];
    const sansGraphe = apparierTrace(t1.points);
    const mauvais = sansGraphe.points.filter((p) => p.tronconId !== "rn1").length;

    expect(mauvais).toBeGreaterThan(0);
    expect(sansGraphe.transitionsNonVerifiees).toBeGreaterThan(0);
  });

  it("franchit les points de precision insuffisante, et les marque", () => {
    const t4 = TRACES_ANNOTEES[3];
    const resultat = apparierTrace(t4.points, { distanceReseauM: distanceReseauScenarios });

    const marques = resultat.points.filter((p) => p.precisionInsuffisante);
    expect(marques).toHaveLength(10);
    // Marques, mais rattaches : c'est la deduction par le parcours.
    expect(marques.every((p) => p.tronconId === "rn1")).toBe(true);
    // Et le plafond ponctuel reste celui du mandat.
    expect(
      t4.points[12].position.precisionM! > PRECISION_MAX_RATTACHEMENT_M,
    ).toBe(true);
  });

  it("detecte la sortie du referentiel au lieu de forcer un rattachement", () => {
    const t3 = TRACES_ANNOTEES[2];
    const resultat = apparierTrace(t3.points, { distanceReseauM: distanceReseauScenarios });

    expect(resultat.horsReferentiel).toHaveLength(1);
    const segment = resultat.horsReferentiel[0];
    expect(segment.indexDebut).toBe(10);
    expect(segment.indexFin).toBe(17);
    expect(segment.nombrePoints).toBe(8);
    expect(segment.longueurM).toBeGreaterThan(0);

    expect(resultat.points.filter((p) => p.rupture !== null)).toHaveLength(8);
    expect(resultat.points[10].rupture).toBe("AUCUN_CANDIDAT");
    // Deux chaines : avant la sortie, et apres.
    expect(resultat.chaines).toBe(2);
  });

  it("rend les passages dans l'ordre, pour annoncer les changements de troncon", () => {
    const t2 = TRACES_ANNOTEES[1];
    const resultat = apparierTrace(t2.points, { distanceReseauM: distanceReseauScenarios });

    expect(resultat.passages.map((p) => p.tronconId)).toEqual(["rn1", "rr5"]);
    expect(resultat.passages[0].nombrePoints).toBe(20);
    expect(resultat.passages[1].nombrePoints).toBe(20);
    // « Vous entrez sur la RR5 » se declenche a cet index.
    expect(resultat.passages[1].indexDebut).toBe(20);
  });
});

describe("Robustesse numerique et cout", () => {
  /** Une trace droite de `n` points sur un seul troncon, avec deux candidats concurrents. */
  function traceLongue(n: number): PointTrace[] {
    const points: PointTrace[] = [];
    for (let i = 0; i < n; i += 1) {
      const est = i * 16.7;
      const decalage = 6 * Math.sin(i / 7);
      points.push({
        horodatageMs: i * 1000,
        position: {
          lat: 9.6412 + decalage / 110574,
          lon: -13.5784 + est / 109750,
          precisionM: 12,
          capDeg: null,
          vitesseKmH: 60,
        },
        candidats: [
          {
            tronconId: "long",
            code: "RN1-LONG",
            nom: null,
            classe: "RN",
            distanceM: Math.abs(decalage),
            fraction: (i * 16.7) / 200000,
            longueurM: 200000,
            pkDebut: 0,
            pkFin: 200,
            capTronconDeg: null,
          },
          {
            tronconId: "voisin",
            code: "CA-LONG",
            nom: null,
            classe: "RR",
            distanceM: Math.abs(30 - decalage),
            fraction: (i * 16.7) / 200000,
            longueurM: 200000,
            pkDebut: 0,
            pkFin: 200,
            capTronconDeg: null,
          },
        ],
      });
    }
    return points;
  }

  it("ne deborde pas sur 7 200 points — les deux heures du critere A18", () => {
    // SANS espace logarithmique, le produit de 7 200 probabilites inferieures a 1 atteint zero
    // en flottant double bien avant la fin, et le Viterbi rendrait un chemin arbitraire SANS
    // AUCUN SIGNE D'ERREUR. C'est la raison d'etre du choix 1 de l'en-tete du module.
    const points = traceLongue(7200);
    const resultat = apparierTrace(points, {
      distanceReseauM: (a, b) => (a.tronconId === b.tronconId ? null : 500),
    });

    expect(resultat.pointsTotal).toBe(7200);
    expect(resultat.pointsRattaches).toBe(7200);
    expect(resultat.chaines).toBe(1);
    // Aucun point sans troncon, donc aucun NaN ni Infinity n'a traverse le calcul.
    expect(resultat.points.every((p) => p.tronconId !== null)).toBe(true);
    expect(resultat.points.every((p) => Number.isFinite(p.abscisseM as number))).toBe(true);
    // Et la decision reste la bonne de bout en bout.
    expect(resultat.points.every((p) => p.tronconId === "long")).toBe(true);
  });

  it("apparie une heure de trace, 3 600 points, en moins de 5 s", () => {
    // Cible du paragraphe 7.3. MESUREE ICI SUR UN POSTE DE DEVELOPPEMENT, pas sur un
    // smartphone d'entree de gamme : ce test ecarte un cout quadratique accidentel, il ne
    // prouve pas la cible mobile. Celle-la demande l'appareil (B-10).
    const points = traceLongue(3600);
    const debut = Date.now();
    const resultat = apparierTrace(points, { distanceReseauM: () => 500 });
    const duree = Date.now() - debut;

    expect(resultat.pointsRattaches).toBe(3600);
    expect(duree).toBeLessThan(5000);
  });

  it("ne rattache rien quand la trace est vide", () => {
    const resultat = apparierTrace([]);
    expect(resultat.pointsTotal).toBe(0);
    expect(resultat.pointsRattaches).toBe(0);
    expect(resultat.chaines).toBe(0);
    expect(resultat.horsReferentiel).toHaveLength(0);
    expect(resultat.passages).toHaveLength(0);
  });

  it("traite un point unique sans transition a calculer", () => {
    const points = traceLongue(1);
    const resultat = apparierTrace(points);
    expect(resultat.pointsRattaches).toBe(1);
    expect(resultat.chaines).toBe(1);
    expect(resultat.transitionsNonVerifiees).toBe(0);
  });

  it("distingue les deux motifs de rupture", () => {
    const base = traceLongue(3);
    // Un point sans aucun candidat, un autre dont tous les candidats sont trop loin.
    base[1].candidats = [];
    const resultat = apparierTrace(base);
    expect(resultat.points[1].rupture).toBe("AUCUN_CANDIDAT");

    const base2 = traceLongue(3);
    base2[1].candidats = base2[1].candidats.map((c) => ({ ...c, distanceM: 400 }));
    const resultat2 = apparierTrace(base2);
    expect(resultat2.points[1].rupture).toBe("TOUS_TROP_LOIN");
  });

  /** Trace a candidat UNIQUE : aucune echappatoire par une transition inter-troncons. */
  function traceCandidatUnique(n: number): PointTrace[] {
    return traceLongue(n).map((p) => ({
      ...p,
      candidats: p.candidats.filter((c) => c.tronconId === "long"),
    }));
  }

  it("coupe la chaine quand la vitesse maximale rend toute transition impossible", () => {
    // La trace avance de 16,7 m par seconde, soit 60 km/h. Un plafond a 30 km/h rend donc
    // chaque transition impossible sur ce meme troncon, ou la distance reseau est l'ecart
    // d'abscisse et ne passe pas par `distanceReseauM`.
    const resultat = apparierTrace(traceCandidatUnique(6), { vitesseMaxKmH: 30 });

    // Chaque point redevient son propre depart : autant de chaines que de points. Et LES SIX
    // POINTS SONT EMIS, ce que la premiere version de la remontee ne faisait pas — elle
    // s'arretait a la premiere rupture de chainage et laissait un tableau a trous.
    expect(resultat.chaines).toBe(6);
    expect(resultat.pointsRattaches).toBe(6);
    expect(resultat.points.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("laisse passer un plafond de vitesse que la trace respecte", () => {
    // Contre-epreuve : sans elle, le test precedent passerait aussi avec un plafond casse qui
    // rejetterait toute transition quelle qu'elle soit.
    const resultat = apparierTrace(traceCandidatUnique(6), { vitesseMaxKmH: 90 });
    expect(resultat.chaines).toBe(1);
    expect(resultat.pointsRattaches).toBe(6);
  });

  it("ne coupe pas sur une distance reseau INCONNUE, meme avec un plafond de vitesse", () => {
    // Le plafond ne s'applique que la ou la distance reseau est connue. Entre deux troncons
    // sans graphe, l'ecart est inconnu : le module reste neutre et compte, il ne declare pas
    // la transition impossible. Une mesure absente n'est pas une mesure nulle.
    const resultat = apparierTrace(traceLongue(6), { vitesseMaxKmH: 30 });
    expect(resultat.chaines).toBe(1);
    expect(resultat.transitionsNonVerifiees).toBeGreaterThan(0);
  });
});
