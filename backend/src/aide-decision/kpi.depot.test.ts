import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Prisma } from "@prisma/client";
import {
  PLAFOND_GROUPES, compterChantiersSansEcheance, lireDecaisse, lireEtatReseau, lireMarches, lireParBailleur, type Lecture,
} from "./kpi.depot";

/**
 * Le depot ne fait que LIRE, par des agregations bornees. Ces tests inspectent le SQL emis (texte et valeurs liees) ;
 * le comportement reel est rejoue contre PostGIS par le banc `aide-decision-kpi.integration.mts`.
 */
function faux(reponses: unknown[][]) {
  const appels: { sql: string; valeurs: unknown[] }[] = [];
  let i = 0;
  const db = {
    $queryRaw: async (q: Prisma.Sql) => {
      appels.push({ sql: q.sql.replace(/\s+/g, " "), valeurs: q.values });
      return reponses[i++] ?? [];
    },
  } as unknown as Lecture;
  return { db, appels };
}

describe("lireEtatReseau", () => {
  it("UNE seule requete, groupee par dimensions categorielles, bornee", async () => {
    const { db, appels } = faux([[]]);
    await lireEtatReseau(db, null, null);
    expect(appels).toHaveLength(1);
    const { sql } = appels[0];
    expect(sql).toMatch(/GROUP BY region, etat, sv, prov, obs, lc/);
    expect(sql).toMatch(/LIMIT [$?]\d*::int/);
    expect(appels[0].valeurs).toContain(PLAFOND_GROUPES);
  });

  it("applique le perimetre « reseau classe saisi » du registre (voirie promue et hors territoire exclues)", async () => {
    const { db, appels } = faux([[]]);
    await lireEtatReseau(db, null, null);
    const { sql } = appels[0];
    expect(sql).toMatch(/"sourceReference" IS NULL OR NOT/);
    expect(sql).toMatch(/voirie_locale:%/);
    expect(sql).toMatch(/hors_territoire:%/);
    expect(sql).toMatch(/"deletedAt" IS NULL/);
  });

  it("une longueur « connue » exclut NaN, l'infini, le zero et les longueurs DERIVED", async () => {
    const { db, appels } = faux([[]]);
    await lireEtatReseau(db, null, null);
    const { sql } = appels[0];
    expect(sql).toMatch(/"longueurKm" > 0/);
    expect(sql).toMatch(/<> 'NaN'::float8/);
    expect(sql).toMatch(/< 'Infinity'::float8/);
    expect(sql).toMatch(/ql\.champ = 'longueurKm' AND ql\.statut = 'DERIVED'/);
  });

  it("n'utilise jamais la longueur geometrique", async () => {
    const { db, appels } = faux([[]]);
    await lireEtatReseau(db, null, null);
    expect(appels[0].sql).not.toMatch(/ST_Length|geom/);
  });

  it("lit la provenance de l'ETAT (champ etat) par jointure gauche sur la cle unique", async () => {
    const { db, appels } = faux([[]]);
    await lireEtatReseau(db, null, null);
    expect(appels[0].sql).toMatch(/LEFT JOIN valeurs_qualite q ON q\."entityType" = 'Troncon' AND q\."entityId" = t\.id AND q\.champ = 'etat'/);
  });

  it("les regions et les classes sont des valeurs LIEES, jamais concatenees", async () => {
    const { db, appels } = faux([[]]);
    await lireEtatReseau(db, [3, 5], ["RN", "RR"]);
    expect(appels[0].valeurs).toEqual(expect.arrayContaining([["3", "5"], ["RN", "RR"]]));
    expect(appels[0].sql).not.toMatch(/'RN'|'RR'/);
    expect(appels[0].sql).toMatch(/t\.classe::text = ANY/);
  });

  it("convertit les lignes (nombres, dates, booleens) et laisse les dates nulles nulles", async () => {
    const { db } = faux([[
      { regionId: 2, etat: "MAUVAIS", sv: "VALIDE", prov: "OBSERVED", obs: true, lc: true, nb: 3, km: 12.5, derniere: "2026-05-01T00:00:00.000Z", ancienne: null },
      { regionId: 2, etat: null, sv: null, prov: "SANS_LIGNE", obs: false, lc: false, nb: 1, km: null, derniere: null, ancienne: null },
    ]]);
    const l = await lireEtatReseau(db, null, null);
    expect(l[0]).toMatchObject({ regionId: 2, etat: "MAUVAIS", provenance: "OBSERVED", observeDate: true, longueurConnue: true, nb: 3, km: 12.5, statutValidation: "VALIDE" });
    expect(l[0].derniereEvaluation).toEqual(new Date("2026-05-01T00:00:00.000Z"));
    expect(l[0].plusAncienneEvaluation).toBeNull();
    expect(l[1]).toMatchObject({ etat: null, km: 0, longueurConnue: false, derniereEvaluation: null });
  });

  it("refuse plutot que de tronquer en silence quand le plafond de groupes est atteint", async () => {
    const pleine = Array.from({ length: PLAFOND_GROUPES }, () => ({ regionId: 1, etat: "BON", sv: null, prov: "OBSERVED", obs: true, lc: true, nb: 1, km: 1, derniere: null, ancienne: null }));
    const { db } = faux([pleine]);
    await expect(lireEtatReseau(db, null, null)).rejects.toThrow(/agregation refusee/);
  });
});

describe("marches, decomptes, bailleurs", () => {
  it("national : aucune restriction par chantier ; regional : tous les chantiers non supprimes doivent etre dans la portee", async () => {
    const nat = faux([[{}]]);
    await lireMarches(nat.db, null);
    expect(nat.appels[0].sql).not.toMatch(/marches_chantiers/);
    const reg = faux([[{}]]);
    await lireMarches(reg.db, [4]);
    expect(reg.appels[0].sql).toMatch(/EXISTS \(SELECT 1 FROM marches_chantiers/);
    expect(reg.appels[0].sql).toMatch(/NOT EXISTS \(SELECT 1 FROM marches_chantiers/);
    expect(reg.appels[0].sql).toMatch(/cx\."deletedAt" IS NULL/);
    expect(reg.appels[0].valeurs).toContainEqual(["4"]);
  });

  it("le contractuel ne somme que la devise GNF, les montants absents sont comptes a part", async () => {
    const { db, appels } = faux([[{ nb: 5, sans: 1, hors: 1, gnf: 3, total: "9007199254740993" }]]);
    const r = await lireMarches(db, null);
    expect(appels[0].sql).toMatch(/SUM\(montant\) FILTER \(WHERE devise = 'GNF'\)/);
    expect(appels[0].sql).toMatch(/FILTER \(WHERE montant IS NULL\)/);
    expect(r).toEqual({ marches: 5, sansMontant: 1, horsGnf: 1, gnfAvecMontant: 3, contractuelGnf: "9007199254740993" });
  });

  it("un resultat vide donne des zeros de COMPTAGE, jamais undefined", async () => {
    const { db } = faux([[]]);
    expect(await lireMarches(db, null)).toEqual({ marches: 0, sansMontant: 0, horsGnf: 0, gnfAvecMontant: 0, contractuelGnf: "0" });
  });

  it("le decaisse ne somme que les decomptes PAYE non supprimes", async () => {
    const { db, appels } = faux([[{ payes: 2, total: "500", sans: 1, ret: 1, emis: 3 }]]);
    const r = await lireDecaisse(db, null);
    expect(appels[0].sql).toMatch(/FILTER \(WHERE d\.statut = 'PAYE'\)/);
    expect(appels[0].sql).toMatch(/d\."deletedAt" IS NULL/);
    expect(r).toEqual({ payes: 2, payeGnf: "500", payesSansDate: 1, payesRetenueGarantie: 1, emis: 3 });
  });

  it("la ventilation passe par marches.bailleurId -> bailleurs, jamais par le texte libre des chantiers", async () => {
    const { db, appels } = faux([[], [{ n: 0 }], []]);
    await lireParBailleur(db, null, 20);
    const tout = appels.map((a) => a.sql).join(" ");
    expect(tout).toMatch(/s\."bailleurId"/);
    expect(tout).toMatch(/LEFT JOIN bailleurs b ON b\.id = s\."bailleurId"/);
    expect(tout).not.toMatch(/chantiers\.bailleur|c\.bailleur/);
  });

  it("la limite de la ventilation est bornee entre 1 et 200, et le total de bailleurs est lu pour dire ce qui est tronque", async () => {
    for (const [entree, borne] of [[0, 1], [-5, 1], [20, 20], [5000, 200], [7.9, 7]] as const) {
      const { db, appels } = faux([[], [{ n: 0 }], []]);
      await lireParBailleur(db, null, entree);
      expect(appels[0].valeurs).toContain(borne);
    }
    const { db } = faux([
      [{ id: 1, nom: "Bailleur A", nb: 2, sans: 0, hors: 0, gnf: 2, total: "100" }, { id: null, nom: null, nb: 1, sans: 1, hors: 0, gnf: 0, total: "0" }],
      [{ n: 7 }],
      [{ id: 1, total: "40" }],
    ]);
    const v = await lireParBailleur(db, null, 2);
    expect(v.totalBailleurs).toBe(7);
    expect(v.lignes[0]).toMatchObject({ bailleurId: 1, nom: "Bailleur A", contractuelGnf: "100", avecMontantGnf: 2, decaisseGnf: "40" });
    expect(v.lignes[1]).toMatchObject({ bailleurId: null, nom: null, decaisseGnf: null }); // aucun paiement : inconnu, pas "0"
  });

  it("un bailleur dont AUCUN marche n'a de montant GNF (sans montant, ou en devise etrangere) a un contractuel INCONNU (null), jamais \"0\"", async () => {
    const { db, appels } = faux([
      [
        { id: 1, nom: "Sans montant", nb: 2, sans: 2, hors: 0, gnf: 0, total: "0" },
        { id: 2, nom: "Devise etrangere", nb: 1, sans: 0, hors: 1, gnf: 0, total: "0" },
        { id: 3, nom: "Mixte", nb: 3, sans: 1, hors: 1, gnf: 1, total: "50" },
      ],
      [{ n: 3 }],
      [],
    ]);
    const v = await lireParBailleur(db, null, 20);
    expect(appels[0].sql).toMatch(/count\(\*\) FILTER \(WHERE s\.devise = 'GNF' AND s\.montant IS NOT NULL\)/);
    expect(v.lignes.map((l) => [l.nom, l.contractuelGnf, l.avecMontantGnf])).toEqual([["Sans montant", null, 0], ["Devise etrangere", null, 0], ["Mixte", "50", 1]]);
  });

  it("compte les chantiers en cours sans echeance (retard non juge)", async () => {
    const { db, appels } = faux([[{ n: 4 }]]);
    expect(await compterChantiersSansEcheance(db, [1])).toBe(4);
    expect(appels[0].sql).toMatch(/"dateFinPrevue" IS NULL/);
  });
});

describe("garde de la source : lecture seule, SQL etiquete, aucun repli", () => {
  const source = readFileSync(join(__dirname, "kpi.depot.ts"), "utf8");
  // On retire les commentaires : ils parlent de ce que le fichier ne fait pas.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  it("aucun mot d'ecriture SQL", () => {
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|MERGE)\b/);
  });
  it("ni $queryRawUnsafe ni $executeRaw ni delegue Prisma", () => {
    expect(code).not.toMatch(/\$queryRawUnsafe|\$executeRaw|\.create\(|\.update\(|\.delete\(|\.upsert\(/);
  });
  it("aucun take / findMany : les agregations sont faites en SQL", () => {
    expect(code).not.toMatch(/\btake\b|findMany|\.groupBy\(/);
  });
  it("aucun `|| 0` sur une absence", () => {
    expect(code).not.toMatch(/\|\|\s*0\b/);
  });
});
