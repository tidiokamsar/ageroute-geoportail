import { describe, expect, it } from "vitest";
import { PLAFOND_VERSIONS, voletPortions, voletProgrammation, type DepotFiche } from "./fiche360.service";

/**
 * Volets portion et programmation de la fiche 360 : ce que ces tests defendent.
 *   - l'historique garde les versions REMPLACEES et ecarte les supprimees (la requete filtre deletedAt) ;
 *   - une date d'effet absente reste absente (null), jamais « depuis toujours » ;
 *   - un montant ne passe jamais par un nombre : bigint -> chaine, au-dela de 2^53 ;
 *   - les interventions figees sont declarees indisponibles, pas inventees ;
 *   - un troncon introuvable ou supprime rend null (la route repond 404).
 */

const troncon = { id: "t1", code: "GN N0001", nom: "Conakry", regionId: 3 };

function depot(over: { portions?: unknown[]; lignes?: unknown[]; chantiers?: unknown[]; troncon?: unknown } = {}) {
  const requetes: Record<string, unknown>[] = [];
  const d = {
    troncon: { findFirst: async () => (over.troncon === undefined ? troncon : over.troncon) },
    portion: { findMany: async (args: Record<string, unknown>) => { requetes.push(args); return over.portions ?? []; } },
    programmeBudgetaire: { findMany: async () => over.lignes ?? [] },
    chantier: { findMany: async () => over.chantiers ?? [] },
  } as unknown as DepotFiche;
  return { d, requetes };
}

const portion = (id: string, o: Record<string, unknown> = {}) => ({
  id, tronconId: "t1", debutM: 0, finM: 100, etat: "BON", etatRef: { libelle: "Bon" }, revetement: "BITUME",
  statutValidation: "VALIDE", origine: "SAISIE_TERRAIN", valideDu: new Date("2026-01-01"), valideAu: null,
  createdAt: new Date("2026-01-10T08:00:00Z"), observeeLe: null, remplaceeLe: null, parents: [], ...o,
});

describe("voletPortions", () => {
  it("distingue les versions courantes des remplacees, avec le lignage", async () => {
    const { d, requetes } = depot({ portions: [
      portion("p1", { remplaceeLe: new Date("2026-06-02T09:00:00Z"), valideAu: new Date("2026-06-01") }),
      portion("p2", { etat: "MAUVAIS", etatRef: { libelle: "Mauvais" }, valideDu: new Date("2026-06-01"), parents: [{ parentId: "p1" }] }),
    ] });
    const v = await voletPortions(d, "t1");
    expect(v?.courantes.map((x) => x.id)).toEqual(["p2"]);
    expect(v?.historique.map((x) => [x.id, x.courante])).toEqual([["p1", false], ["p2", true]]);
    expect(v?.historique[1]).toMatchObject({ issueDe: ["p1"], etatLibelle: "Mauvais", valideDu: "2026-06-01" });
    expect(v?.historique[0].valideAu).toBe("2026-06-01");
    expect(v?.comptes).toEqual({ courantes: 1, remplacees: 1, sansDateEffet: 0 });
    // Les versions supprimees LOGIQUEMENT n'entrent pas dans l'histoire : le filtre est dans la requete.
    expect((requetes[0].where as Record<string, unknown>)).toMatchObject({ tronconId: "t1", deletedAt: null });
  });

  it("une date d'effet absente reste null et est comptee, pas remplacee par une date", async () => {
    const { d } = depot({ portions: [portion("p1", { valideDu: null })] });
    const v = await voletPortions(d, "t1");
    expect(v?.historique[0].valideDu).toBeNull();
    expect(v?.comptes.sansDateEffet).toBe(1);
  });

  it("tronque au plafond et le dit", async () => {
    const trop = Array.from({ length: PLAFOND_VERSIONS + 1 }, (_, i) => portion(`p${i}`));
    const v = await voletPortions(depot({ portions: trop }).d, "t1");
    expect(v?.tronque).toBe(true);
    expect(v?.historique).toHaveLength(PLAFOND_VERSIONS);
  });

  it("troncon introuvable ou supprime : null", async () => {
    expect(await voletPortions(depot({ troncon: null }).d, "x")).toBeNull();
  });

  it("aucune portion : listes vides, pas d'erreur", async () => {
    const v = await voletPortions(depot().d, "t1");
    expect(v).toMatchObject({ courantes: [], historique: [], tronque: false, comptes: { courantes: 0, remplacees: 0, sansDateEffet: 0 } });
  });
});

describe("voletProgrammation", () => {
  const ligne = (id: string, statut: string, montant: bigint) => ({
    id, annee: 2027, intitule: id, statut, source: "SAISIE", bailleur: null, typeIntervention: null, priorite: null, montantPrevuGnf: montant,
  });

  it("totalise par statut en bigint et rend les montants en chaine", async () => {
    const { d } = depot({ lignes: [ligne("a", "RETENU", 9_007_199_254_740_993n), ligne("b", "RETENU", 500n), ligne("c", "PROPOSE", 40n)] });
    const v = await voletProgrammation(d, "t1");
    expect(v?.previsions[0].montantPrevuGnf).toBe("9007199254740993");
    expect(v?.totaux).toEqual([{ statut: "RETENU", nb: 2, montantGnf: "9007199254741493" }, { statut: "PROPOSE", nb: 1, montantGnf: "40" }]);
  });

  it("declare les interventions figees indisponibles au lieu d'en inventer", async () => {
    const v = await voletProgrammation(depot().d, "t1");
    expect(v?.interventionsFigees.disponible).toBe(false);
    expect(v?.interventionsFigees.motif).toMatch(/Aucune table/);
    expect(v?.previsions).toEqual([]);
  });

  it("rend les chantiers du troncon, montant nul conserve nul", async () => {
    const { d } = depot({ chantiers: [{ id: "c1", intitule: "Reprise", statut: "EN_COURS", avancementPct: 40, entreprise: "E", montantGnf: null, dateDebutPrevue: null, dateFinPrevue: new Date("2026-12-31") }] });
    const v = await voletProgrammation(d, "t1");
    expect(v?.chantiers[0]).toMatchObject({ montantGnf: null, dateFinPrevue: "2026-12-31", dateDebutPrevue: null });
  });

  it("troncon introuvable : null", async () => {
    expect(await voletProgrammation(depot({ troncon: null }).d, "x")).toBeNull();
  });
});
