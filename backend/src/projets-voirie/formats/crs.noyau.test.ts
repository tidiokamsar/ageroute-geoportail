import { describe, expect, it } from "vitest";
import { metaDepuisSpatialRef } from "./crs.noyau";

/**
 * Unite d'un CRS lue dans `spatial_ref_sys` (revue D1, m2). Definitions PROJ synthetiques (forme de celles de PostGIS), aucune donnee reelle.
 */
const ligne = (proj4text: string, srtext = 'PROJCS["CRS synthetique",UNIT["x",1]]') => ({ srid: 99001, srtext, proj4text });

describe("unite d'un CRS projete", () => {
  it("+units=m, ou ni +units ni +to_meter : metre", () => {
    expect(metaDepuisSpatialRef(ligne("+proj=utm +zone=29 +datum=WGS84 +units=m +no_defs")).unite).toBe("metre");
    expect(metaDepuisSpatialRef(ligne("+proj=utm +zone=29 +datum=WGS84 +no_defs")).unite).toBe("metre");
    expect(metaDepuisSpatialRef(ligne("+proj=utm +zone=29 +to_meter=1 +no_defs")).unite).toBe("metre");
  });
  it("+to_meter different de 1 sans +units : jamais « metre » (pied de Clarke : pied ; facteur inconnu : inconnue)", () => {
    expect(metaDepuisSpatialRef(ligne("+proj=tmerc +lat_0=0 +lon_0=-12 +k=1 +x_0=0 +y_0=0 +a=6378300 +b=6356751 +to_meter=0.3047972654 +no_defs")).unite).toBe("pied");
    expect(metaDepuisSpatialRef(ligne("+proj=tmerc +to_meter=0.304800609601219 +no_defs")).unite).toBe("pied");
    expect(metaDepuisSpatialRef(ligne("+proj=tmerc +to_meter=20.1168 +no_defs")).unite).toBe("inconnue");
    expect(metaDepuisSpatialRef(ligne("+proj=tmerc +to_meter=abc +no_defs")).unite).toBe("inconnue");
  });
  it("un CRS geographique reste en degres", () => {
    expect(metaDepuisSpatialRef(ligne("+proj=longlat +datum=WGS84 +no_defs", 'GEOGCS["WGS 84"]')).unite).toBe("degre");
  });
});
