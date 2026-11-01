import { describe, expect, it } from "vitest";
import { ecrireVue, lireVue } from "./permalien";

/**
 * Permaliens : un lien est une entree exterieure, il est valide ou ignore -- jamais applique a
 * moitie.
 */

describe("lireVue", () => {
  it("lit une vue complete et valide", () => {
    expect(lireVue("?lat=9.64120&lng=-13.57840&zoom=12")).toEqual({ lat: 9.6412, lng: -13.5784, zoom: 12 });
    expect(lireVue("lat=9.6&lng=-13.5&zoom=11.5&couche=x")).toEqual({ lat: 9.6, lng: -13.5, zoom: 11.5 });
  });
  it.each([
    ["absente", ""],
    ["incomplete", "?lat=9.6&lng=-13.5"],
    ["non numerique", "?lat=abc&lng=-13.5&zoom=12"],
    ["vide", "?lat=&lng=-13.5&zoom=12"],
    ["latitude hors bornes", "?lat=95&lng=-13.5&zoom=12"],
    ["longitude hors bornes", "?lat=9.6&lng=-200&zoom=12"],
    ["zoom hors bornes", "?lat=9.6&lng=-13.5&zoom=40"],
    ["zoom negatif", "?lat=9.6&lng=-13.5&zoom=-1"],
    ["infini", "?lat=Infinity&lng=-13.5&zoom=12"],
  ])("ignore une vue %s", (_n, s) => {
    expect(lireVue(s)).toBeNull();
  });
});

describe("ecrireVue", () => {
  it("ecrit cinq decimales et deux pour le zoom, en conservant les autres parametres", () => {
    const s = ecrireVue("?couche=voirie", { lat: 9.641234567, lng: -13.578456789, zoom: 12.3456 });
    const p = new URLSearchParams(s);
    expect(p.get("couche")).toBe("voirie");
    expect(p.get("lat")).toBe("9.64123");
    expect(p.get("lng")).toBe("-13.57846");
    expect(p.get("zoom")).toBe("12.35");
  });
  it("aller-retour : ce qui est ecrit se relit", () => {
    const v = { lat: 10.5, lng: -10.8, zoom: 7 };
    expect(lireVue(ecrireVue("", v))).toEqual(v);
  });
  it("remplace une vue precedente au lieu de l'empiler", () => {
    const s = ecrireVue("?lat=1&lng=2&zoom=3", { lat: 9.6, lng: -13.5, zoom: 10 });
    expect(new URLSearchParams(s).getAll("lat")).toEqual(["9.60000"]);
  });
});
