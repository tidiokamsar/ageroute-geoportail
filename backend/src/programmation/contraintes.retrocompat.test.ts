import { describe, expect, it } from "vitest";
import { canonique, sha256Hex } from "./canonique";
import { construireScenario, entreesDepuisJson, entreesVersJson, type EntreesScenario } from "./scenario.noyau";
import { BAREMES, candidat, entreesDeBase } from "./scenario.fixtures";
import { parametresAmorcage } from "./parametres.noyau";

/**
 * RETROCOMPATIBILITE DU NOYAU (AD-LOT-4). Un scenario deja scelle en base (entrees et resultat canoniques, empreintes
 * SHA-256 verifiees par des CHECK) doit se rejouer OCTET POUR OCTET identique apres l'extension du simulateur.
 *
 * Les empreintes ci-dessous ont ete relevees AVANT toute modification de `scenario.noyau.ts` (script jetable
 * `lot4-or.mts`, sur le code du commit 1af3e6e), puis epinglees ici. Si l'une d'elles change, l'extension a modifie
 * le comportement d'un scenario herite : le test echoue, et c'est le CODE qu'il faut corriger, jamais l'empreinte.
 */
const p1 = parametresAmorcage();
p1.valeurs.facteursMinimum = 1;
p1.valeurs.couvertureMinimale = 0.3;

const CAS: Record<string, { entrees: () => EntreesScenario; shaEntrees: string; shaResultat: string }> = {
  base: {
    entrees: () => entreesDeBase(),
    shaEntrees: "6330e7fd3b63456df68d83131f4b188d7533960b703740fcb04cf30da071f635",
    shaResultat: "fefe348f428ddb0fc61fd7f13904315e559dde0bfdc5ad17fee89d7f2b2d6fa5",
  },
  budget4Md: {
    entrees: () => entreesDeBase({ budgetGnf: 4_000_000_000n }),
    shaEntrees: "130578a27af432e4bddec5b0ef7458fc08c0f0099ff692276828072fa5e859cd",
    shaResultat: "5758f2e63e4cbc04aed5d303adab242cced97b812bb0f987a5617ca0aec5f140",
  },
  budget0: {
    entrees: () => entreesDeBase({ budgetGnf: 0n }),
    shaEntrees: "f2c6899e243e54714a6183cad8eb6cda07362aac328719c7b50d5217b16dbe95",
    shaResultat: "bd1447ebfe529b68391250a9f3fae82ec01b2f75074aad5d5cabc6c88591828f",
  },
  plafondRegion1: {
    entrees: () => entreesDeBase({ plafondsRegionauxGnf: { "1": 3_000_000_000n } }),
    shaEntrees: "8c5b4a08038808220a5cfc67e1bda858dd97c630f758d6198faa791b157e3452",
    shaResultat: "2cf301287b93fc8fc899a42673dc1c7de93b780e164419a9119a288578ca6cc9",
  },
  sansBaremeReconstruction: {
    entrees: () => entreesDeBase({ baremes: BAREMES.filter((b) => b.typeIntervention !== "reconstruction") }),
    shaEntrees: "6dc6db816711dedb00c3bd4b8a30da61e552d7287e689278aed54881aa3b91e2",
    shaResultat: "34243afd5b71b5a1dc07b1798bd5f0517541bacc99389a206af020c97d607f66",
  },
  parametresAssouplis: {
    entrees: () => entreesDeBase({ parametres: p1, candidats: [candidat("x", { code: "X-ETAT", etat: "MAUVAIS", longueurM: 2000 })] }),
    shaEntrees: "adb3d3b0d4f020d0c706a56f5d5e207ca473801b5b842bcb16fe846a3ceedc8a",
    shaResultat: "d767107b5b50510465bd025e8e5b171bee57cab93c5038b90d5480bed69f5758",
  },
  longueursGeometrie: {
    entrees: () => entreesDeBase({
      parametres: p1,
      candidats: [
        candidat("g1", { code: "G-1", etat: "MAUVAIS", traficMoyenJma: 1000, nbPointsNoirs: 1, longueurM: 2500, longueurOrigine: "GEOMETRIE" }),
        candidat("g2", { code: "G-2", etat: "CRITIQUE", traficMoyenJma: 800, nbPointsNoirs: 0, longueurM: 1200, longueurOrigine: "LONGUEUR_KM", regionId: 3 }),
      ],
    }),
    shaEntrees: "486f99a190c1e7c0ed47976aa096ad42224202d9558fafd190e366a6d7af4d1e",
    shaResultat: "1ae1b176aca0b023f65fd17111f5999ab0ca4af7c9549d1e1f33437f8e53e955",
  },
};

describe("Scenarios scelles avant le simulateur : rejeu identique octet pour octet", () => {
  for (const [nom, c] of Object.entries(CAS)) {
    it(`${nom} : entrees et resultat canoniques gardent leurs empreintes d'origine`, () => {
      const e = c.entrees();
      expect(e.simulation).toBeUndefined();
      const texteEntrees = canonique(entreesVersJson(e));
      expect(sha256Hex(texteEntrees)).toBe(c.shaEntrees);
      expect(texteEntrees).not.toContain("simulation");
      const r = construireScenario(e);
      if (!r.ok) throw new Error(r.erreurs.join(" ; "));
      expect(r.scenario).not.toHaveProperty("simulation");
      expect(sha256Hex(canonique(r.scenario))).toBe(c.shaResultat);
    });

    it(`${nom} : relire les entrees stockees puis recalculer redonne le meme resultat (c'est le rejeu du service)`, () => {
      const texte = canonique(entreesVersJson(c.entrees()));
      const relu = entreesDepuisJson(JSON.parse(texte));
      if (!relu.ok) throw new Error(relu.erreurs.join(" ; "));
      expect(relu.entrees.simulation).toBeUndefined();
      expect(canonique(entreesVersJson(relu.entrees))).toBe(texte);
      const r = construireScenario(relu.entrees);
      if (!r.ok) throw new Error(r.erreurs.join(" ; "));
      expect(sha256Hex(canonique(r.scenario))).toBe(c.shaResultat);
    });
  }
});
