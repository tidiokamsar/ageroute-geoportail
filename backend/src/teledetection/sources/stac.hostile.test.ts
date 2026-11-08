import { describe, expect, it } from "vitest";
import { creerAdaptateurCdseStac } from "./adaptateurs/cdse-stac";
import type { BBox } from "./contrat";
import { charger, fetchScenario, reponseJson, sommeilFactice } from "./essais.support";

/**
 * Constat EO-FIX-BACK 4 : un catalogue HOSTILE (ou simplement fautif) qui rend plus d'items que la page demandee contournait
 * `produitsMax` : une page de 1000 items pour un plafond de 200 rendait 1000 produits. Le plafond de produits et la taille de
 * page demandee doivent tenir quoi que repondent le serveur, et la recherche doit dire qu'elle s'est arretee (jamais « complete »).
 */

const BOKE: BBox = [-14.4, 10.8, -14.2, 11.0];
const FENETRE = { debut: new Date("2026-09-01"), fin: new Date("2026-10-01") };

/** Page de `n` items distincts calques sur un vrai item du CDSE ; le lien « next » promet une suite. */
function pageHostile(n: number, rang: number, suite = true) {
  const rep = charger("cdse-stac-s2-l2a.json").reponse;
  const modele = rep.features[0];
  const features = Array.from({ length: n }, (_, i) => ({ ...modele, id: `${modele.id.slice(0, -4)}${String(rang).padStart(2, "0")}${String(i).padStart(2, "0")}`.slice(0, modele.id.length) + `_${rang}_${i}` }));
  return { ...rep, features, links: suite ? [{ rel: "next", href: "https://stac.dataspace.copernicus.eu/v1/search?token=suite", method: "GET" }] : [] };
}

describe("un catalogue qui rend plus d'items que la page demandee ne contourne pas produitsMax", () => {
  it("page de 1000 items, produitsMax = 200 : au plus 200 produits, arret signale PLAFOND_PRODUITS", async () => {
    let n = 0;
    const { fetch } = fetchScenario(async () => reponseJson(pageHostile(1000, ++n)));
    const a = creerAdaptateurCdseStac({ fetch, sleep: sommeilFactice().sleep });
    const r = await a.rechercher({ bbox: BOKE, ...FENETRE, pagesMax: 4, produitsMax: 200 });
    expect(r.produits.length).toBeLessThanOrEqual(200);
    expect(r.pagination.raisonArret).not.toBe("FIN");
    expect(r.diagnostics.some((d) => d.code === "PLAFOND_PRODUITS" || d.code === "PAGE_TROP_GRANDE")).toBe(true);
    // les produits lus sont ceux qui ont ete examines : rien n'est compte sans avoir ete traite
    expect(r.pagination.produitsLus).toBe(r.produits.length);
  });

  it("le plafond est atteint EN MILIEU de page : les items restants ne sont pas lus, l'arret est signale et la reprise est possible", async () => {
    const { fetch } = fetchScenario(async () => reponseJson(pageHostile(50, 1)));
    const a = creerAdaptateurCdseStac({ fetch, sleep: sommeilFactice().sleep });
    const r = await a.rechercher({ bbox: BOKE, ...FENETRE, limiteParPage: 50, pagesMax: 4, produitsMax: 30 });
    expect(r.produits).toHaveLength(30);
    expect(r.pagination.produitsLus).toBe(30);
    expect(r.pagination.raisonArret).toBe("PLAFOND_PRODUITS");
    expect(r.pagination.suivant).not.toBeNull();
  });

  it("une page plus grande que la limite demandee est tronquee a cette limite, et le dit", async () => {
    const { fetch } = fetchScenario(async () => reponseJson(pageHostile(500, 1, false)));
    const a = creerAdaptateurCdseStac({ fetch, sleep: sommeilFactice().sleep });
    const r = await a.rechercher({ bbox: BOKE, ...FENETRE, limiteParPage: 20, pagesMax: 1, produitsMax: 400 });
    expect(r.produits.length).toBeLessThanOrEqual(20);
    expect(r.pagination.raisonArret).not.toBe("FIN");
    expect(r.diagnostics.some((d) => d.code === "PAGE_TROP_GRANDE")).toBe(true);
  });

  it("un catalogue honnete (page <= limite, sous le plafond) reste complet : raison FIN, aucun avertissement de troncature", async () => {
    const { fetch } = fetchScenario(reponseJson(pageHostile(10, 1, false)));
    const a = creerAdaptateurCdseStac({ fetch, sleep: sommeilFactice().sleep });
    const r = await a.rechercher({ bbox: BOKE, ...FENETRE, limiteParPage: 50, pagesMax: 4, produitsMax: 200 });
    expect(r.produits).toHaveLength(10);
    expect(r.pagination.raisonArret).toBe("FIN");
    expect(r.diagnostics.some((d) => d.code === "PAGE_TROP_GRANDE" || d.code === "PLAFOND_PRODUITS")).toBe(false);
  });
});
