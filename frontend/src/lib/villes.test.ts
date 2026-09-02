import { describe, expect, it } from "vitest";
import { chercherVilles, tronconDansFiltre, sommetDansFiltre, VILLES, filtrerParRoute, filtrerParVille } from "./villes";

const GEOM_KANKAN_SIGUIRI = JSON.stringify({
  type: "LineString",
  // un sommet sur Kankan (10.38,-9.31), un autre vers Siguiri (11.42,-9.17)
  coordinates: [[-9.31, 10.38], [-9.6, 10.9], [-9.17, 11.42]],
});
const GEOM_CONAKRY = JSON.stringify({
  type: "LineString",
  coordinates: [[-13.71, 9.51], [-13.60, 9.45]],
});

describe("recherche par ville (P4)", () => {
  it("la liste couvre les 8 régions et les chefs-lieux attendus", () => {
    expect(VILLES.length).toBeGreaterThanOrEqual(33);
    const regions = new Set(VILLES.map((v) => v.region));
    for (const r of ["Conakry", "Boké", "Kindia", "Mamou", "Labé", "Faranah", "Kankan", "Nzérékoré"]) {
      expect(regions.has(r)).toBe(true);
    }
  });

  it("chercherVilles : insensible aux accents et à la casse, préfixe d'abord", () => {
    const res = chercherVilles("nZer");
    expect(res[0].nom).toBe("Nzérékoré");
    expect(chercherVilles("kindia").map((v) => v.nom)).toContain("Kindia");
    expect(chercherVilles("k")).toHaveLength(0); // trop court
  });

  it("une ville : le tronçon qui la touche passe, le tronçon lointain non", () => {
    const kankan = VILLES.find((v) => v.nom === "Kankan")!;
    expect(tronconDansFiltre(GEOM_KANKAN_SIGUIRI, { a: kankan })).toBe(true);
    expect(tronconDansFiltre(GEOM_CONAKRY, { a: kankan })).toBe(false);
  });

  it("deux villes : le corridor Kankan↔Siguiri garde leur axe, exclut Conakry", () => {
    const kankan = VILLES.find((v) => v.nom === "Kankan")!;
    const siguiri = VILLES.find((v) => v.nom === "Siguiri")!;
    expect(tronconDansFiltre(GEOM_KANKAN_SIGUIRI, { a: kankan, b: siguiri })).toBe(true);
    expect(tronconDansFiltre(GEOM_CONAKRY, { a: kankan, b: siguiri })).toBe(false);
  });

  it("corridor : un point sur l'axe entre les deux villes est inclus", () => {
    const kankan = VILLES.find((v) => v.nom === "Kankan")!;
    const siguiri = VILLES.find((v) => v.nom === "Siguiri")!;
    // point intermédiaire de l'axe Kankan-Siguiri
    expect(sommetDansFiltre(10.9, -9.24, { a: kankan, b: siguiri })).toBe(true);
    // ... et un point à 100 km de l'axe est exclu
    expect(sommetDansFiltre(10.66, -9.89, { a: kankan, b: siguiri })).toBe(false);
  });

  it("géométrie illisible : exclu sans crash", () => {
    const kankan = VILLES.find((v) => v.nom === "Kankan")!;
    expect(tronconDansFiltre("pas du tout du json", { a: kankan })).toBe(false);
  });
});

describe("Filtres de carte — route et ville s'excluent", () => {
  const labe = VILLES.find((v) => v.nom === "Labé")!;
  const mali = VILLES.find((v) => v.nom === "Mali")!;

  it("isoler une route ferme le filtre par ville", () => {
    expect(filtrerParRoute("RN8")).toEqual({ route: "RN8", ville: null });
  });

  it("filtrer par ville ferme l'isolement de route", () => {
    const f = filtrerParVille({ a: labe, b: mali });
    expect(f.route).toBeNull();
    expect(f.ville).toEqual({ a: labe, b: mali });
  });

  it("effacer le filtre ville n'isole aucune route", () => {
    expect(filtrerParVille(null)).toEqual({ route: null, ville: null });
  });

  it("le corridor Labé–Mali retient bien un tracé qui le suit — le cas signalé", () => {
    // La RN8 longe cet axe : elle passe a 0,1 km du segment en production.
    // Le defaut n'etait pas la donnee mais le cumul des deux filtres.
    const surLAxe = JSON.stringify({
      type: "LineString",
      coordinates: [[-12.28, 11.32], [-12.15, 11.70], [-11.97, 12.13]],
    });
    expect(tronconDansFiltre(surLAxe, { a: labe, b: mali })).toBe(true);
  });

  it("et rejette un tracé éloigné de l'axe", () => {
    const ailleurs = JSON.stringify({
      type: "LineString",
      coordinates: [[-9.31, 10.38], [-9.17, 11.42]], // Kankan - Siguiri
    });
    expect(tronconDansFiltre(ailleurs, { a: labe, b: mali })).toBe(false);
  });
});
