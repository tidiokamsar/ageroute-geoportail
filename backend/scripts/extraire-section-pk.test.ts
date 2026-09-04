import { describe, expect, it } from "vitest";
import { sectionDuCode } from "./extraire-section-pk";

/**
 * Lecture de la section dans le code du troncon.
 *
 * Cette fonction decide si le referencement kilometrique de la BDRI est lisible. Se
 * tromper ne casse rien visiblement : une section mal lue rattache un chantier au
 * mauvais endroit de la route, et personne ne s'en apercoit.
 */

describe("Le format nominal", () => {
  it("lit la section d'un code espace", () => {
    expect(sectionDuCode("GN N0001 3-1216")).toBe("3");
    expect(sectionDuCode("GN N0005 4-1070")).toBe("4");
  });

  it("lit un code sans suffixe d'identifiant", () => {
    expect(sectionDuCode("GN N0001 0")).toBe("0");
    expect(sectionDuCode("GN N0001 7")).toBe("7");
  });
});

describe("Le piège de l'espace manquant", () => {
  it("lit une section a deux chiffres collee au numero de route", () => {
    // « GN N000110-1042 » est la route 0001, section 10 — pas la route 0001 sans
    // section. Un decoupage par espaces les fait disparaitre SILENCIEUSEMENT, ce qui
    // est pire qu'une erreur : la section 10 de la RN1 sortirait du referencement.
    expect(sectionDuCode("GN N000110-1042")).toBe("10");
    expect(sectionDuCode("GN N000110")).toBe("10");
  });

  it("ne confond pas la section 1 et la section 10", () => {
    expect(sectionDuCode("GN N0001 1")).toBe("1");
    expect(sectionDuCode("GN N000110")).toBe("10");
  });

  it("normalise les zeros de tete", () => {
    // « 03 » et « 3 » designent la meme section ; deux chaines differentes les
    // separeraient en deux sections fantomes.
    expect(sectionDuCode("GN N0001 03-1216")).toBe("3");
  });
});

describe("Ce qu'elle refuse de deviner", () => {
  it("rend null sur un code hors convention", () => {
    // Un code qui deroge doit rester SANS section et se voir, plutot que de recevoir
    // une valeur approximative qui se lirait comme un fait.
    for (const c of ["RES-972", "KALOUM-OSM-w38698544", "GNL-OSM-w1006090082", ""]) {
      expect(sectionDuCode(c), c).toBeNull();
    }
  });

  it("rend null si le numero de route n'a pas quatre chiffres", () => {
    expect(sectionDuCode("GN N01 3")).toBeNull();
  });

  it("rend null si rien ne suit le numero de route", () => {
    expect(sectionDuCode("GN N0001")).toBeNull();
    expect(sectionDuCode("GN N0001 ")).toBeNull();
  });

  it("n'accepte pas un prefixe approchant", () => {
    expect(sectionDuCode("GNN0001 3")).toBeNull();
    expect(sectionDuCode("gn n0001 3")).toBeNull();
  });
});
