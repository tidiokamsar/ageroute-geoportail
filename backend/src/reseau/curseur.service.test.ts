import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import {
  chronologie,
  lirePortionsALaDate,
  PLAFOND_PORTIONS,
  RefusCurseur,
  type DepotCurseur,
} from "./curseur.service";

/**
 * Le service du curseur temporel : ce que ces tests defendent.
 *
 *   - un perimetre est EXIGE (emprise ou troncon, pas les deux) et borne ;
 *   - le pre-filtre SQL change avec l'axe systeme : sans lui, borne de fin et statut en SQL ; avec
 *     lui, ni l'un ni l'autre, parce que les regles doivent pouvoir rouvrir et re-statuer ;
 *   - le journal des decisions n'est lu QUE sur l'axe systeme ;
 *   - une reponse trop grosse est tronquee ET le dit ;
 *   - un resultat vide est une REPONSE (chronologie a zero), jamais une erreur.
 * Le SQL lui-meme est eprouve contre PostGIS (suivi, T-26) : ici on verifie sa FORME et le mapping.
 */

const EMPRISE = { ouest: -13.9, sud: 9.4, est: -13.5, nord: 9.8 };
const J = (s: string) => new Date(`${s}T00:00:00Z`);

function ligne(partiel: Record<string, unknown> = {}) {
  return {
    id: "p-1", tronconId: "t-1", tronconCode: "GN N0001", tronconNom: "Conakry - Coyah",
    debutM: 0, finM: 1_000, revetement: "BITUME", etat: "BON", etatLibelle: "Bon", praticabilite: null,
    largeurM: 6, source: "mission", observeeLe: J("2026-02-01"), confiance: "HIGH",
    statutValidation: "VALIDE", valideDu: J("2026-01-01"), valideAu: null,
    enregistreLe: new Date("2026-01-10T08:00:00Z"), remplaceeLe: null, deletedAt: null,
    geometry: '{"type":"LineString","coordinates":[[-13.7,9.5],[-13.69,9.5]]}',
    ...partiel,
  };
}

/** Depot simule : consigne chaque requete (texte et valeurs) et rend les reponses dans l'ordre. */
function depot(...reponses: unknown[][]) {
  const requetes: { sql: string; values: unknown[] }[] = [];
  let i = 0;
  const d = {
    $queryRaw: async (q: Prisma.Sql) => {
      requetes.push({ sql: q.sql, values: q.values });
      return reponses[i++] ?? [];
    },
  } as unknown as DepotCurseur;
  return { d, requetes };
}

const base = { dateTerrain: J("2026-03-15"), connuLe: null, inclureAValider: false, emprise: EMPRISE };

describe("perimetre", () => {
  it("EXIGE une emprise ou un troncon, jamais les deux, jamais aucun", async () => {
    const { d, requetes } = depot();
    await expect(lirePortionsALaDate(d, { ...base, emprise: undefined })).rejects.toMatchObject({ code: "PERIMETRE_REQUIS" });
    await expect(lirePortionsALaDate(d, { ...base, tronconId: "t-1" })).rejects.toMatchObject({ code: "PERIMETRE_REQUIS" });
    expect(requetes).toHaveLength(0);
  });

  it.each([
    ["inversee", { ouest: -13.5, sud: 9.4, est: -13.9, nord: 9.8 }, "EMPRISE_INVALIDE", 400],
    ["vide", { ouest: -13.9, sud: 9.8, est: -13.5, nord: 9.8 }, "EMPRISE_INVALIDE", 400],
    ["hors du globe", { ouest: -200, sud: 9.4, est: -199, nord: 9.8 }, "EMPRISE_INVALIDE", 400],
    ["trop large", { ouest: -20, sud: 0, est: 0, nord: 5 }, "EMPRISE_TROP_LARGE", 422],
    ["trop haute", { ouest: -13.9, sud: 0, est: -13.5, nord: 6 }, "EMPRISE_TROP_LARGE", 422],
  ])("refuse une emprise %s, sans interroger la base", async (_n, emprise, code, http) => {
    const { d, requetes } = depot();
    const e = await lirePortionsALaDate(d, { ...base, emprise }).catch((x) => x);
    expect(e).toBeInstanceOf(RefusCurseur);
    expect(e).toMatchObject({ code, http });
    expect(requetes).toHaveLength(0);
  });

  it("accepte un troncon seul", async () => {
    const { d } = depot([]);
    await expect(lirePortionsALaDate(d, { ...base, emprise: undefined, tronconId: "t-1" })).resolves.toBeDefined();
  });
});

describe("la forme du SQL, selon l'axe", () => {
  it("SANS axe systeme : borne de fin et statut sont filtres en SQL, aucune lecture du journal", async () => {
    const { d, requetes } = depot([ligne()]);
    await lirePortionsALaDate(d, base);
    expect(requetes).toHaveLength(1);
    const sql = requetes[0].sql;
    expect(sql).toMatch(/"valideAu" IS NULL OR p\."valideAu" > /);
    expect(sql).toMatch(/"statutValidation"::text = ANY/);
    expect(sql).toMatch(/"valideDu" IS NOT NULL/);
    expect(sql).not.toMatch(/"createdAt" <=/);
    // Les rejets et les « a corriger » sont ecartes en SQL ; les propositions, JAMAIS (voir ci-dessous).
    expect(requetes[0].values).toContainEqual(["VALIDE", "A_VALIDER"]);
  });

  it("les propositions sont chargees MEME non demandees : ce sont les regles qui les ecartent et les comptent", async () => {
    const attente = ligne({ id: "attente", statutValidation: "A_VALIDER" });
    const sans = depot([ligne(), attente]);
    const r = await lirePortionsALaDate(sans.d, { ...base, inclureAValider: false });
    expect(sans.requetes[0].values).toContainEqual(["VALIDE", "A_VALIDER"]);
    expect(r.portions.map((p) => p.id)).toEqual(["p-1"]);
    // Sans ce chargement, ce compte serait toujours nul : l'agent croirait que rien n'attend validation.
    expect(r.comptes.aValiderEcartees).toBe(1);

    const avec = depot([ligne(), attente]);
    const r2 = await lirePortionsALaDate(avec.d, { ...base, inclureAValider: true });
    expect(r2.portions.map((p) => p.id).sort()).toEqual(["attente", "p-1"]);
    expect(r2.comptes.aValiderEcartees).toBe(0);
  });

  it("AVEC l'axe systeme : pas de borne de fin ni de statut en SQL, pour que les regles rouvrent et re-statuent", async () => {
    const { d, requetes } = depot([ligne()], []);
    await lirePortionsALaDate(d, { ...base, connuLe: new Date("2026-04-01T23:59:59.999Z") });
    const sql = requetes[0].sql;
    expect(sql).toMatch(/p\."createdAt" <= /);
    expect(sql).not.toMatch(/p\."valideAu" IS NULL OR/);
    expect(sql).not.toMatch(/"statutValidation"::text = ANY/);
    // L'instant est passe SANS fuseau : la colonne est un timestamp(3) en UTC naif.
    expect(requetes[0].values).toContain("2026-04-01T23:59:59.999");
  });

  it("le journal des decisions n'est lu QUE sur l'axe systeme, et seulement pour les candidates", async () => {
    const sans = depot([ligne()]);
    await lirePortionsALaDate(sans.d, base);
    expect(sans.requetes.some((r) => r.sql.includes("audit_logs"))).toBe(false);

    const avec = depot([ligne({ id: "p-7" })], []);
    await lirePortionsALaDate(avec.d, { ...base, connuLe: new Date("2026-04-01T23:59:59.999Z") });
    const journal = avec.requetes.find((r) => r.sql.includes("audit_logs"));
    expect(journal).toBeDefined();
    expect(journal?.values).toContainEqual(["p-7"]);

    // Aucune candidate : inutile d'interroger le journal.
    const vide = depot([]);
    await lirePortionsALaDate(vide.d, { ...base, connuLe: new Date("2026-04-01T23:59:59.999Z") });
    expect(vide.requetes.some((r) => r.sql.includes("audit_logs"))).toBe(false);
  });

  it("le jour de terrain est passe en texte AAAA-MM-JJ, sans fuseau", async () => {
    const { d, requetes } = depot([]);
    await lirePortionsALaDate(d, base);
    expect(requetes[0].values).toContain("2026-03-15");
  });
});

describe("la reponse", () => {
  it("met en forme les dates en jours, calcule la longueur, et rend le statut tel que connu", async () => {
    const { d } = depot([ligne({ debutM: 100, finM: 460.5, valideDu: J("2026-01-01"), valideAu: J("2026-09-01") })]);
    const r = await lirePortionsALaDate(d, base);
    expect(r.portions).toHaveLength(1);
    expect(r.portions[0]).toMatchObject({
      id: "p-1", tronconCode: "GN N0001", debutM: 100, finM: 460.5, longueurM: 360.5,
      valideDu: "2026-01-01", valideAu: "2026-09-01", observeeLe: "2026-02-01",
      statut: "VALIDE", ambigue: false, etat: "BON", etatLibelle: "Bon",
    });
    expect(r.dateTerrain).toBe("2026-03-15");
    expect(r.connuLe).toBeNull();
    expect(r.longueurCouverteM).toBe(360.5);
    expect(r.tronque).toBe(false);
  });

  it("applique les regles : une version remplacee sans date de fin n'est pas rendue, et est comptee", async () => {
    const { d } = depot([ligne({ id: "parent", remplaceeLe: new Date("2026-03-01T00:00:00Z") }), ligne({ id: "enfant", debutM: 0, finM: 1_000 })]);
    const r = await lirePortionsALaDate(d, base);
    expect(r.portions.map((p) => p.id)).toEqual(["enfant"]);
    expect(r.comptes.remplaceesSansFin).toBe(1);
  });

  it("sur l'axe systeme, le statut vient du JOURNAL : validee apres la date = simple proposition", async () => {
    const { d } = depot(
      [ligne({ id: "a", statutValidation: "VALIDE" })],
      [{ portionId: "a", statut: "VALIDE", decideLe: new Date("2026-06-01T00:00:00Z") }],
    );
    const r = await lirePortionsALaDate(d, { ...base, connuLe: new Date("2026-04-01T23:59:59.999Z"), inclureAValider: true });
    expect(r.portions[0].statut).toBe("A_VALIDER");
    expect(r.connuLe).toBe("2026-04-01");
  });

  it("ignore une decision au statut inattendu du journal plutot que d'en inventer un", async () => {
    const { d } = depot(
      [ligne({ id: "a" })],
      [{ portionId: "a", statut: "N_IMPORTE_QUOI", decideLe: new Date("2026-02-01T00:00:00Z") }],
    );
    const r = await lirePortionsALaDate(d, { ...base, connuLe: new Date("2026-04-01T23:59:59.999Z"), inclureAValider: true });
    expect(r.portions[0].statut).toBe("A_VALIDER");
  });

  it("TRONQUE a PLAFOND portions et le dit : une carte incomplete ne se fait pas passer pour complete", async () => {
    const lignes = Array.from({ length: PLAFOND_PORTIONS + 1 }, (_, i) => ligne({ id: `p-${i}`, tronconId: `t-${i}` }));
    const { d, requetes } = depot(lignes);
    const r = await lirePortionsALaDate(d, base);
    expect(r.tronque).toBe(true);
    expect(r.plafond).toBe(PLAFOND_PORTIONS);
    expect(r.portions).toHaveLength(PLAFOND_PORTIONS);
    // La requete demande UNE ligne de plus que le plafond, precisement pour pouvoir le savoir.
    expect(requetes[0].values).toContain(PLAFOND_PORTIONS + 1);
  });

  it("un perimetre sans portion est une REPONSE vide, pas une erreur", async () => {
    const { d } = depot([]);
    const r = await lirePortionsALaDate(d, base);
    expect(r.portions).toEqual([]);
    expect(r.comptes.retenues).toBe(0);
    expect(r.tronque).toBe(false);
  });
});

describe("chronologie", () => {
  it("compte les portions placees et celles qui ne le sont a aucune date", async () => {
    const { d } = depot(
      [{ total: 40, avecDateEffet: 12, premiere: J("2025-11-03"), derniere: J("2026-08-20") }],
      [{ mois: "2025-11", n: 5 }, { mois: "2026-03", n: 9 }],
    );
    const c = await chronologie(d);
    expect(c).toEqual({
      total: 40, avecDateEffet: 12, sansDateEffet: 28,
      premiere: "2025-11-03", derniere: "2026-08-20",
      parMois: [{ mois: "2025-11", n: 5 }, { mois: "2026-03", n: 9 }],
    });
  });

  it("sans aucune portion : des zeros et des dates nulles, pas d'erreur", async () => {
    const { d } = depot([{ total: 0, avecDateEffet: 0, premiere: null, derniere: null }], []);
    expect(await chronologie(d)).toEqual({ total: 0, avecDateEffet: 0, sansDateEffet: 0, premiere: null, derniere: null, parMois: [] });
  });

  it("tolere une reponse vide de la base", async () => {
    const { d } = depot([], []);
    expect(await chronologie(d)).toMatchObject({ total: 0, avecDateEffet: 0, sansDateEffet: 0, premiere: null });
  });
});
