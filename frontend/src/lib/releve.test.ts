import { describe, expect, it } from "vitest";
import { decouperEnFragments, detecterFormat, libelleDuree, libelleKm, libellePourcent, nomFichierResultat } from "./releve";

describe("detecterFormat", () => {
  it("deduit le format de l'extension, sans tenir compte de la casse", () => {
    expect(detecterFormat("sortie.gpx")).toBe("gpx");
    expect(detecterFormat("SORTIE.GPX")).toBe("gpx");
    expect(detecterFormat("trace.csv")).toBe("csv");
    expect(detecterFormat("trace.txt")).toBe("csv");
  });
  it("rend null quand l'extension ne dit rien : l'agent doit choisir", () => {
    expect(detecterFormat("trace.kml")).toBeNull();
    expect(detecterFormat("trace")).toBeNull();
  });
});

describe("mise en forme", () => {
  it("duree lisible, ou « non calculable » quand le fichier n'a pas d'horodatage", () => {
    expect(libelleDuree(null)).toBe("non calculable");
    expect(libelleDuree(45)).toBe("45 s");
    expect(libelleDuree(125)).toBe("2 min 05 s");
    expect(libelleDuree(3 * 3600 + 5 * 60)).toBe("3 h 05 min");
  });
  it("longueur en metres sous le kilometre, en kilometres au-dela, avec la virgule francaise", () => {
    expect(libelleKm(850)).toBe("850 m");
    expect(libelleKm(2190)).toBe("2,2 km");
    expect(libelleKm(120_000)).toBe("120 km");
  });
  it("taux en pourcentage entier", () => { expect(libellePourcent(0.812)).toBe("81 %"); });
  it("le nom du fichier de resultat ne porte que la date", () => {
    expect(nomFichierResultat(new Date("2026-10-21T10:00:00Z"))).toBe("analyse-trace-2026-10-21.json");
  });
});

describe("decouperEnFragments", () => {
  const t: [number, number][] = [[-13.7, 9.5], [-13.7, 9.6], [-13.7, 9.7], [-13.7, 9.8], [-13.7, 9.9]];

  it("passe de [lon, lat] a [lat, lon], l'ordre de Leaflet", () => {
    const f = decouperEnFragments(t, [true, true, true, true, true]);
    expect(f).toHaveLength(1);
    expect(f[0].points[0]).toEqual([9.5, -13.7]);
  });

  it("coupe a chaque changement de statut et PARTAGE le point de jonction : aucun trou dans le trace", () => {
    const f = decouperEnFragments(t, [true, true, false, false, true]);
    expect(f.map((x) => x.rattache)).toEqual([true, false, true]);
    // La fin d'un fragment est le debut du suivant.
    expect(f[0].points[f[0].points.length - 1]).toEqual(f[1].points[0]);
    expect(f[1].points[f[1].points.length - 1]).toEqual(f[2].points[0]);
  });

  it("n'emet aucun fragment d'un seul point, et tolere des tableaux de longueurs differentes", () => {
    expect(decouperEnFragments([[-13.7, 9.5]], [true])).toEqual([]);
    expect(decouperEnFragments(t, [true, true])).toHaveLength(1);
    expect(decouperEnFragments([], [])).toEqual([]);
  });
});
