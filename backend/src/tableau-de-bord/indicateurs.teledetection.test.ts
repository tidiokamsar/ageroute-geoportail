import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({ prisma: {} }));

import { REGISTRE } from "./indicateurs.registre";

/**
 * Indicateur `propositions_a_verifier` (EO-API) : il ne comptait que `A_VERIFIER` et ne separait pas les donnees de test.
 * Une proposition EN_ATTENTE ou NON_CONCLUANTE attend aussi son verdict ; une donnee synthetique n'entre jamais dans un compteur de
 * production. Le test lit le SQL du calcul ET du controle independant ; les valeurs sont eprouvees sur PostGIS (banc tableau-de-bord).
 */
describe("propositions_a_verifier", () => {
  const def = REGISTRE.find((d) => d.code === "propositions_a_verifier")!;
  const portee = { regions: null, maintenant: new Date("2026-10-25T12:00:00Z") } as never;

  async function sqlDe(f: (d: never, p: never) => Promise<unknown>): Promise<string> {
    let texte = "";
    const depot = { $queryRaw: async (q: { strings: string[] } | readonly string[]) => { texte = (Array.isArray(q) ? q : (q as { strings: string[] }).strings).join("?").replace(/\s+/g, " "); return [{ v: 0, tout: 0, jugees: 0 }]; } };
    await f(depot as never, portee);
    return texte;
  }

  it("le calcul compte les trois statuts qui attendent un verdict, sans les donnees synthetiques", async () => {
    const sql = await sqlDe(def.calcul as never);
    expect(sql).toContain("pt.statut IN ('A_VERIFIER', 'EN_ATTENTE', 'NON_CONCLUANTE')");
    expect(sql).toContain("NOT pt.synthetique");
  });

  it("le controle (autre chemin : tout moins les verdicts) exclut aussi les donnees synthetiques", async () => {
    const sql = await sqlDe(def.controle as never);
    expect(sql).toContain("NOT pt.synthetique");
    expect(sql).toContain("pt.statut IN ('CONFIRMEE', 'INFIRMEE')");
  });

  it("la source « aucune donnee » ignore les donnees synthetiques : une table qui n'en contient que n'est pas « avec donnees »", async () => {
    const source = def.source!;
    const sql = await sqlDe(((d: never, p: never) => source.vide(d, p)) as never);
    expect(sql).toContain("NOT pt.synthetique");
  });
});
