import { describe, expect, it } from "vitest";
import { legendeVoirie } from "./VoirieLocaleLayer";

/**
 * Legende de la couche voirie.
 *
 * Elle affirmait « donnee OpenStreetMap non validee par AGEROUTE ». C'etait exact
 * tant qu'aucune voie n'etait promue. Depuis la promotion, une voie rattachee a un
 * troncon EST au registre : le lui refuser serait faux — dans l'autre sens, mais
 * faux quand meme.
 *
 * Ces tests fixent la regle : la legende compte, elle n'affirme pas.
 */

describe("La légende dit ce qui est rattaché au registre", () => {
  it("n'affirme rien quand la vue est vide", () => {
    expect(legendeVoirie(0, 0)).toMatch(/aucune voie/i);
  });

  it("annonce la donnée externe quand rien n'est promu", () => {
    const t = legendeVoirie(128, 0);
    expect(t).toMatch(/non validée par AGEROUTE/i);
    expect(t).toContain("128");
  });

  it("ne dit plus « non validée » quand toutes sont au registre", () => {
    const t = legendeVoirie(350, 350);
    expect(t).toMatch(/registre AGEROUTE/i);
    expect(t).not.toMatch(/non validée/i);
  });

  it("distingue les deux quand la vue est mixte", () => {
    const t = legendeVoirie(500, 350);
    expect(t).toContain("500");
    expect(t).toContain("350");
    expect(t).toMatch(/registre AGEROUTE/i);
    expect(t).toMatch(/non validée/i);
  });

  it("traite un compte de promues supérieur comme totalement promu", () => {
    // Defensif : les deux comptes viennent de la meme reponse, mais une legende
    // ne doit jamais afficher « dont 351 sur 350 ».
    expect(legendeVoirie(350, 351)).toMatch(/registre AGEROUTE/i);
    expect(legendeVoirie(350, 351)).not.toMatch(/dont/i);
  });

  it("sépare les milliers en français", () => {
    expect(legendeVoirie(12000, 0)).toMatch(/12\s?000/);
  });
});
