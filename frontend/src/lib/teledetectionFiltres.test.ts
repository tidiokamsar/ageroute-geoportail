import { describe, expect, it } from "vitest";
import { FILTRES_VIDES, filtresHorsSynthese, nombreFiltresActifs, versFiltresSynthese } from "./teledetectionFiltres";

describe("filtres que la synthese ignore", () => {
  it("region et periode : suivies par la synthese, donc jamais citees comme cause d'un ecart", () => {
    expect(filtresHorsSynthese({ ...FILTRES_VIDES, regionId: "1", depuis: "2026-10-01", jusqua: "2026-10-20" })).toEqual([]);
    expect(versFiltresSynthese({ ...FILTRES_VIDES, regionId: "1", type: "INONDATION" })).toEqual({ regionId: "1", depuis: "", jusqua: "" });
  });

  it("tous les autres filtres de la liste sont cites, et seulement ceux qui sont actifs", () => {
    expect(filtresHorsSynthese({ ...FILTRES_VIDES, q: " coyah ", source: "S", type: "T", tronconId: "t", priorite: "HAUTE", rattachee: "non" }))
      .toEqual(["recherche", "source", "type", "tronçon", "priorité", "rattachement"]);
    expect(filtresHorsSynthese({ ...FILTRES_VIDES, q: "   " })).toEqual([]);
  });

  it("reste coherent avec le compteur de filtres actifs : chaque filtre hors synthese en fait partie", () => {
    const tous = { ...FILTRES_VIDES, q: "a", source: "S", type: "T", tronconId: "t", priorite: "HAUTE", rattachee: "oui" };
    expect(nombreFiltresActifs(tous)).toBe(filtresHorsSynthese(tous).length);
  });
});
