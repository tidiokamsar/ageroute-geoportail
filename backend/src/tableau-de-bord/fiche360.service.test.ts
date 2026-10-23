import { describe, expect, it } from "vitest";
import { PLAFOND_FICHES_FIGEES, PLAFOND_VERSIONS, voletPortions, voletProgrammation, type DepotFiche } from "./fiche360.service";

/**
 * Volets portion et programmation de la fiche 360 : ce que ces tests defendent.
 *   - l'historique garde les versions REMPLACEES et ecarte les supprimees (la requete filtre deletedAt) ;
 *   - une date d'effet absente reste absente (null), jamais « depuis toujours » ;
 *   - un montant ne passe jamais par un nombre : bigint -> chaine, au-dela de 2^53 ;
 *   - les interventions figees sont LUES dans les fiches du moteur (statut courant, historique en ajout seul,
 *     etiquette de la fiche), jamais inventees ; une table absente est DITE, pas rendue comme une liste vide ;
 *   - un troncon introuvable ou supprime rend null (la route repond 404).
 */

const troncon = { id: "t1", code: "GN N0001", nom: "Conakry", regionId: 3 };

function depot(over: { portions?: unknown[]; lignes?: unknown[]; chantiers?: unknown[]; troncon?: unknown; figees?: unknown[]; statuts?: unknown[]; erreurFigees?: unknown } = {}) {
  const requetes: Record<string, unknown>[] = [];
  const sql: { texte: string; valeurs: unknown[] }[] = [];
  const d = {
    troncon: { findFirst: async () => (over.troncon === undefined ? troncon : over.troncon) },
    portion: { findMany: async (args: Record<string, unknown>) => { requetes.push(args); return over.portions ?? []; } },
    programmeBudgetaire: { findMany: async () => over.lignes ?? [] },
    chantier: { findMany: async () => over.chantiers ?? [] },
    // Requete etiquetee : le pilote recoit (fragments, ...valeurs liees), jamais un texte concatene.
    $queryRaw: async (fragments: TemplateStringsArray, ...valeurs: unknown[]) => {
      const texte = fragments.join("?");
      sql.push({ texte, valeurs });
      if (over.erreurFigees) throw over.erreurFigees;
      return /fiches_intervention_statuts/.test(texte) ? (over.statuts ?? []) : (over.figees ?? []);
    },
  } as unknown as DepotFiche;
  return { d, requetes, sql };
}

const figee = (id: string, o: Record<string, unknown> = {}) => ({
  id, reference: `FI-2027-${id}`, scenarioId: "s1", annee: 2027, parametresVersion: "prog-provisoire-1", empreinteSha256: "a".repeat(64),
  figeLe: new Date("2026-10-23T10:00:00Z"), statut: "BROUILLON", rangStatut: 1, statutDepuis: new Date("2026-10-23T10:00:01Z"),
  traitement: "rehabilitation", montantGnf: "4400000000", provisoire: true, etiquette: "PROVISOIRE, non approuvé", ...o,
});

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

  it("sans fiche figee : disponible, total zero, liste vide (la table existe, rien n'est fige pour ce troncon)", async () => {
    const v = await voletProgrammation(depot().d, "t1");
    expect(v?.interventionsFigees).toEqual({ disponible: true, total: 0, tronque: false, plafond: 100, fiches: [] });
    expect(v?.previsions).toEqual([]);
  });

  it("rend les fiches figees du troncon avec leur statut courant, leur etiquette et l'historique du cycle de vie", async () => {
    const { d, sql } = depot({
      figees: [figee("f1", { statut: "APPROUVE", rangStatut: 4 }), figee("f2")],
      statuts: [
        { ficheId: "f1", rang: 1, de: null, vers: "BROUILLON", origine: "GEOPORTAIL", motif: null, enregistreLe: new Date("2026-10-23T10:00:01Z") },
        { ficheId: "f1", rang: 2, de: "BROUILLON", vers: "PROPOSE", origine: "GEOPORTAIL", motif: "relu", enregistreLe: new Date("2026-10-24T08:00:00Z") },
        { ficheId: "f2", rang: 1, de: null, vers: "BROUILLON", origine: "GEOPORTAIL", motif: null, enregistreLe: new Date("2026-10-23T10:00:01Z") },
      ],
    });
    const v = await voletProgrammation(d, "t1");
    const f = v?.interventionsFigees;
    expect(f?.disponible).toBe(true);
    if (!f || !f.disponible) return;
    expect(f.fiches.map((x) => [x.reference, x.statut, x.rangStatut])).toEqual([["FI-2027-f1", "APPROUVE", 4], ["FI-2027-f2", "BROUILLON", 1]]);
    expect(f.fiches[0]).toMatchObject({ montantGnf: "4400000000", traitement: "rehabilitation", provisoire: true, etiquette: "PROVISOIRE, non approuvé", empreinteSha256: "a".repeat(64) });
    expect(f.fiches[0].historique.map((h) => [h.rang, h.de, h.vers, h.motif])).toEqual([[1, null, "BROUILLON", null], [2, "BROUILLON", "PROPOSE", "relu"]]);
    expect(f.fiches[1].historique).toHaveLength(1);
    // Les valeurs sont LIEES par le pilote, jamais concatenees dans le texte SQL.
    expect(sql[0].valeurs).toContain("t1");
    expect(sql[0].texte).not.toContain("'t1'");
    expect(sql[1].valeurs[0]).toEqual(["f1", "f2"]);
  });

  it("le montant d'une fiche reste une chaine (au-dela de 2^53) et une fiche sans etiquette lisible reste nulle, pas inventee", async () => {
    const { d } = depot({ figees: [figee("f1", { montantGnf: "9007199254740993", etiquette: null, provisoire: null })] });
    const f = (await voletProgrammation(d, "t1"))?.interventionsFigees;
    if (!f || !f.disponible) throw new Error("attendu : disponible");
    expect(f.fiches[0]).toMatchObject({ montantGnf: "9007199254740993", etiquette: null, provisoire: null });
  });

  it("tronque au plafond et le dit (une fiche de plus que le plafond est lue pour le savoir)", async () => {
    const trop = Array.from({ length: PLAFOND_FICHES_FIGEES + 1 }, (_, i) => figee(`f${i}`));
    const f = (await voletProgrammation(depot({ figees: trop }).d, "t1"))?.interventionsFigees;
    if (!f || !f.disponible) throw new Error("attendu : disponible");
    expect(f.tronque).toBe(true);
    expect(f.fiches).toHaveLength(PLAFOND_FICHES_FIGEES);
  });

  it("table des fiches absente (42P01) : le volet DIT que la migration manque, il ne rend pas une liste vide", async () => {
    const e = Object.assign(new Error('relation "fiches_intervention_courantes" does not exist'), { meta: { code: "42P01" } });
    const v = await voletProgrammation(depot({ erreurFigees: e }).d, "t1");
    expect(v?.interventionsFigees.disponible).toBe(false);
    expect((v?.interventionsFigees as { motif: string }).motif).toMatch(/n'existe pas.*20261023100000/);
  });

  it("toute autre erreur de base remonte (jamais avalee en « aucune fiche »)", async () => {
    await expect(voletProgrammation(depot({ erreurFigees: new Error("connexion perdue") }).d, "t1")).rejects.toThrow("connexion perdue");
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
