/**
 * Le noyau d'estimation de cout : ce que ces tests defendent.
 *
 * - il REFUSE quand aucune ligne de bareme ne couvre le cas, au lieu de deviner (D-07) ;
 * - il refuse de CHOISIR entre deux lignes : trancher est une decision, pas une arithmetique ;
 * - un montant sans millesime, sans largeur ou sans approbation est PROVISOIRE, et dit ce qui
 *   manque nommement -- rien n'est complete par defaut ;
 * - la classe de precision suit le niveau de mesure, et la marge est affichee ;
 * - l'arithmetique est en BigInt : aucun flottant n'entre dans un montant en GNF.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { estimer, formaterMontant, ligneApplicable, type LigneBareme } from "./cout.noyau";

describe("Le noyau ne depend de rien", () => {
  it("n'a aucun import", () => {
    const source = readFileSync(join(__dirname, "cout.noyau.ts"), "utf8");
    expect([...source.matchAll(/^import .*?from\s+["']/gm)]).toHaveLength(0);
  });
});

/** Les neuf lignes d'origine, telles que mesurees en base le 14/10 : aucune approuvee, ni annee ni largeur. */
const BAREMES: LigneBareme[] = [
  { id: 1, familleRevetement: "bitume", etatDepart: "MOYEN", typeIntervention: "entretien_periodique", coutKmGnf: 350_000_000n, uniteCout: "KM", devise: "GNF" },
  { id: 2, familleRevetement: "bitume", etatDepart: "MAUVAIS", typeIntervention: "rehabilitation", coutKmGnf: 1_100_000_000n, uniteCout: "KM", devise: "GNF" },
  { id: 3, familleRevetement: "bitume", etatDepart: "CRITIQUE", typeIntervention: "reconstruction", coutKmGnf: 3_500_000_000n, uniteCout: "KM", devise: "GNF" },
  { id: 4, familleRevetement: "terre_laterite", etatDepart: "MOYEN", typeIntervention: "entretien_periodique", coutKmGnf: 80_000_000n, uniteCout: "KM", devise: "GNF" },
  { id: 5, familleRevetement: "terre_laterite", etatDepart: "MAUVAIS", typeIntervention: "rehabilitation", coutKmGnf: 250_000_000n, uniteCout: "KM", devise: "GNF" },
  { id: 6, familleRevetement: "terre_laterite", etatDepart: "CRITIQUE", typeIntervention: "reconstruction", coutKmGnf: 700_000_000n, uniteCout: "KM", devise: "GNF" },
  { id: 7, familleRevetement: "pave", etatDepart: "MOYEN", typeIntervention: "entretien_periodique", coutKmGnf: 300_000_000n, uniteCout: "KM", devise: "GNF" },
  { id: 8, familleRevetement: "pave", etatDepart: "MAUVAIS", typeIntervention: "rehabilitation", coutKmGnf: 900_000_000n, uniteCout: "KM", devise: "GNF" },
  { id: 9, familleRevetement: "pave", etatDepart: "CRITIQUE", typeIntervention: "reconstruction", coutKmGnf: 2_800_000_000n, uniteCout: "KM", devise: "GNF" },
];

describe("Il refuse quand il ne sait pas (D-07)", () => {
  it.each([["beton", "MAUVAIS"], ["autre", "CRITIQUE"], ["non_renseigne", "MOYEN"], ["bitume", "BON"]])(
    "aucune ligne pour (%s, %s) : refus motive, aucun montant", (famille, etat) => {
      const r = estimer({ familleRevetement: famille, etatDepart: etat, longueurM: 1000, niveauMesure: "REFERENTIEL" }, BAREMES);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("AUCUNE_LIGNE_DE_BAREME");
        expect(r.motif).toMatch(/n'estime pas ce qu'il ne sait pas chiffrer/);
        expect(r.motif).toContain(famille);
      }
    });

  it("refuse de choisir entre deux lignes : trancher est une decision", () => {
    const deux = [...BAREMES, { id: 10, familleRevetement: "bitume", etatDepart: "MAUVAIS", typeIntervention: "renforcement", coutKmGnf: 800_000_000n, uniteCout: "KM", devise: "GNF" }];
    const r = ligneApplicable({ familleRevetement: "bitume", etatDepart: "MAUVAIS" }, deux);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("PLUSIEURS_LIGNES_DE_BAREME");
      expect(r.motif).toMatch(/rehabilitation, renforcement/);
    }
    // Precise, il tranche -- parce que l'appelant a tranche.
    const p = ligneApplicable({ familleRevetement: "bitume", etatDepart: "MAUVAIS", typeIntervention: "renforcement" }, deux);
    expect(p.ok).toBe(true);
  });

  it("ignore une ligne inactive", () => {
    const b = BAREMES.map((l) => (l.id === 2 ? { ...l, actif: false } : l));
    const r = estimer({ familleRevetement: "bitume", etatDepart: "MAUVAIS", longueurM: 1000, niveauMesure: "REFERENTIEL" }, b);
    expect(r.ok).toBe(false);
  });

  it("refuse une longueur nulle, negative ou non finie", () => {
    for (const l of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = estimer({ familleRevetement: "bitume", etatDepart: "MOYEN", longueurM: l, niveauMesure: "REFERENTIEL" }, BAREMES);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("LONGUEUR_INVALIDE");
    }
  });

  it("refuse une unite de cout qu'il ne gere pas, plutot que de l'interpreter", () => {
    const b = [{ ...BAREMES[0], uniteCout: "M2" }];
    const r = estimer({ familleRevetement: "bitume", etatDepart: "MOYEN", longueurM: 1000, niveauMesure: "REFERENTIEL" }, b);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("UNITE_NON_GEREE");
  });
});

describe("Un montant provisoire dit ce qui lui manque, nommement", () => {
  it("sur les neuf lignes d'origine : non approuvee, sans millesime, sans largeur -- trois hypotheses non faites", () => {
    const r = estimer({ familleRevetement: "bitume", etatDepart: "CRITIQUE", longueurM: 12_400, niveauMesure: "REFERENTIEL" }, BAREMES);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.provisoire).toBe(true);
    expect(r.hypothesesManquantes).toEqual([
      "ligne de bareme non approuvee",
      "millesime du prix inconnu",
      "largeur de chaussee de reference inconnue",
    ]);
    expect(r.bareme.approuve).toBe(false);
    expect(r.bareme.anneeReference).toBeNull();
  });

  it("devient non provisoire seulement quand les trois sont la", () => {
    const complete: LigneBareme = { ...BAREMES[2], approuveLe: new Date("2026-11-01"), anneeReference: 2026, largeurChausseeM: 7 };
    const r = estimer({ familleRevetement: "bitume", etatDepart: "CRITIQUE", longueurM: 1000, niveauMesure: "METRE_VALIDE" }, [complete]);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.provisoire).toBe(false); expect(r.hypothesesManquantes).toEqual([]); }

    const sansLargeur: LigneBareme = { ...complete, largeurChausseeM: null };
    const r2 = estimer({ familleRevetement: "bitume", etatDepart: "CRITIQUE", longueurM: 1000, niveauMesure: "METRE_VALIDE" }, [sansLargeur]);
    if (r2.ok) { expect(r2.provisoire).toBe(true); expect(r2.hypothesesManquantes).toEqual(["largeur de chaussee de reference inconnue"]); }
  });
});

describe("Classe de precision et arithmetique", () => {
  it("la classe suit le niveau de mesure, avec sa marge affichee", () => {
    const base = { familleRevetement: "pave", etatDepart: "MAUVAIS", longueurM: 2000 } as const;
    const a = estimer({ ...base, niveauMesure: "REFERENTIEL" }, BAREMES);
    const b = estimer({ ...base, niveauMesure: "PRE_ETUDE" }, BAREMES);
    const c = estimer({ ...base, niveauMesure: "METRE_VALIDE" }, BAREMES);
    expect(a.ok && a.classePrecision === "RESEAU_30" && a.margePct === 30).toBe(true);
    expect(b.ok && b.classePrecision === "PRE_ETUDE_15" && b.margePct === 15).toBe(true);
    expect(c.ok && c.classePrecision === "METRE_DETAILLE" && c.margePct === null).toBe(true);
    // Le montant, lui, ne depend pas de la classe : la precision qualifie, elle ne corrige pas.
    if (a.ok && b.ok && c.ok) expect(a.montant === b.montant && b.montant === c.montant).toBe(true);
  });

  it("calcule en BigInt, au franc inferieur, et la note de calcul le dit", () => {
    const r = estimer({ familleRevetement: "bitume", etatDepart: "CRITIQUE", longueurM: 12_400, niveauMesure: "REFERENTIEL" }, BAREMES);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 3 500 000 000 x 12 400 / 1000 = 43 400 000 000
    expect(r.montant).toBe(43_400_000_000n);
    expect(typeof r.montant).toBe("bigint");
    expect(r.calcul).toContain("3500000000 GNF/km x 12400 m / 1000 = 43400000000 GNF");
  });

  it("arrondit les metres a l'entier et le quotient au franc inferieur, de facon reproductible", () => {
    const b: LigneBareme[] = [{ id: 1, familleRevetement: "x", etatDepart: "y", typeIntervention: "t", coutKmGnf: 1_000_001n, uniteCout: "KM", devise: "GNF" }];
    const r1 = estimer({ familleRevetement: "x", etatDepart: "y", longueurM: 1.4, niveauMesure: "REFERENTIEL" }, b);
    const r2 = estimer({ familleRevetement: "x", etatDepart: "y", longueurM: 1.4, niveauMesure: "REFERENTIEL" }, b);
    // 1 000 001 x 1 / 1000 = 1000,001 -> 1000
    expect(r1.ok && r1.montant === 1000n).toBe(true);
    expect(r1.ok && r2.ok && r1.montant === r2.montant).toBe(true);
  });

  it("le reseau classe entier a 3,5 Md/km : 74 048 100 000 000 GNF exactement", () => {
    // Premiere version de ce test : elle affirmait que ce montant depassait 2^53. C'est faux --
    // 7,4 x 10^13 tient dans un double -- et le test l'a dit. L'exactitude au franc reste la
    // propriete defendue, et elle se verifie la ou un flottant perdrait vraiment : ci-dessous.
    const r = estimer({ familleRevetement: "bitume", etatDepart: "CRITIQUE", longueurM: 21_156_600, niveauMesure: "REFERENTIEL" }, BAREMES);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.montant).toBe(74_048_100_000_000n);
  });

  it("reste exact au franc la ou un double ne le serait plus (borne, pas un prix realiste)", () => {
    // Le produit intermediaire vaut 1,2 x 10^22 : hors de portee d'un double sans arrondi.
    // L'ATTENDU EST CALCULE EN BIGINT ICI MEME, pas recopie : une premiere version portait un
    // produit calcule a la main, et faux. Un test dont l'attendu est faux ne garde rien.
    const coutKm = 1_234_567_890_123n;
    const metres = 9_876_543_210;
    const attendu = (coutKm * BigInt(metres)) / 1000n;
    const b: LigneBareme[] = [{ id: 1, familleRevetement: "x", etatDepart: "y", typeIntervention: "t", coutKmGnf: coutKm, uniteCout: "KM", devise: "GNF" }];
    const r = estimer({ familleRevetement: "x", etatDepart: "y", longueurM: metres, niveauMesure: "REFERENTIEL" }, b);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.montant).toBe(attendu);
    // La perte de precision d'un double se voit a l'aller-retour : il ne revient pas au meme franc.
    expect(BigInt(Number(r.montant))).not.toBe(r.montant);
  });

  it("formate sans passer par un flottant", () => {
    expect(formaterMontant(74_048_100_000_000n, "GNF")).toBe("74 048 100 000 000 GNF");
    expect(formaterMontant(0n, "GNF")).toBe("0 GNF");
  });
});

describe("Ce que le module ne fait pas", () => {
  it("n'exporte rien qui ressemble a un engagement : ni decompte, ni marche, ni paiement", async () => {
    const mod = await import("./cout.noyau");
    expect(Object.keys(mod).some((k) => /decompte|marche|paiement|engag|contrat/i.test(k))).toBe(false);
  });
});
