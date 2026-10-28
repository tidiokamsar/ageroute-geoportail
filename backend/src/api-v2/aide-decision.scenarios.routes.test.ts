import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Simulateur budgetaire (AD-LOT-4) : les VRAIS gardes (requireAuth avec jeton signe et resolveur de compte injecte,
 * requireRole, requireModuleAccess, gardes territoriales), le VRAI service et les VRAIS noyaux. Seule la base est simulee par
 * des depots en memoire : ce fichier prouve le CABLAGE (droits, perimetre, oracle d'existence, entrees hostiles, absence d'ecriture
 * hors scenario et audit), pas le SQL, que le banc `aide-decision-scenarios.integration.mts` eprouve sur PostGIS.
 */
vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://127.0.0.1:1/essai";
  process.env.JWT_ACCESS_SECRET = "essai-access-secret-essai-access-secret-0000";
  process.env.JWT_REFRESH_SECRET = "essai-refresh-secret-essai-refresh-secret-000";
  process.env.CORS_ORIGIN = "http://localhost:5173";
});

type L = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const h = vi.hoisted(() => ({
  modules: {} as Record<string, string[]>,
  perimetres: {} as Record<string, number[]>,
  scenarios: new Map<string, Record<string, any>>(), // eslint-disable-line @typescript-eslint/no-explicit-any
  parametres: [] as Array<Record<string, any>>, // eslint-disable-line @typescript-eslint/no-explicit-any
  audit: [] as Array<{ action: string; entityType: string; entityId?: string; before?: unknown; after?: any; userId: string | null }>, // eslint-disable-line @typescript-eslint/no-explicit-any
  ecritures: [] as string[],
  insertions: 0,
  nbCandidats: 0,
  /** Identifiants de candidats dont la colonne longueurKm est DERIVEE de la geometrie (valeurs_qualite DERIVED). */
  derivees: [] as string[],
  /** Dernier filtre recu par chargerCandidats (le minimum de points noirs du registre en fait partie). */
  dernierFiltre: null as null | Record<string, unknown>,
}));

vi.mock("../lib/prisma", () => {
  const modele = (nom: string): L => new Proxy({}, {
    get: (_t, op: string) => async (args: L = {}) => {
      if (["create", "update", "delete", "upsert", "updateMany", "deleteMany", "createMany"].includes(op)) { h.ecritures.push(`${nom}.${op}`); return {}; }
      if (nom === "user" && op === "findUnique") return { modulesAutorises: h.modules[args.where.id] ?? [] };
      return null;
    },
  });
  const prisma: L = new Proxy({}, {
    get: (_t, nom: string) => {
      if (nom === "$queryRaw") {
        return async (s: TemplateStringsArray, ...v: unknown[]) => {
          const t = s.join("?");
          if (t.includes("perimetres_comptes")) return (h.perimetres[String(v[0])] ?? []).map((regionId) => ({ regionId }));
          if (t.includes("scenarios_programmation") && t.includes("perimetre")) {
            const sc = h.scenarios.get(String(v[0]));
            return sc ? [{ r: sc.perimetre?.regionId === null || sc.perimetre?.regionId === undefined ? null : String(sc.perimetre.regionId) }] : [];
          }
          return [];
        };
      }
      if (nom === "$executeRaw") return async () => { h.ecritures.push("$executeRaw"); return 0; };
      if (nom === "$queryRawUnsafe" || nom === "$executeRawUnsafe") return async () => { h.ecritures.push(nom); return []; };
      if (nom === "$transaction") return async (a: unknown) => (a as (t: unknown) => Promise<unknown>)(prisma);
      return modele(nom);
    },
  });
  return { prisma };
});
vi.mock("../utils/audit", () => ({
  logAudit: vi.fn(), construireAudit: vi.fn(() => ({})),
  logAuditTransactionnelle: vi.fn(async (_tx: unknown, p: any) => { h.audit.push(p); }), // eslint-disable-line @typescript-eslint/no-explicit-any
}));
vi.mock("../lib/reseau", () => ({ fragmentPerimetre: () => ({}) }));

vi.mock("../programmation/moteur.depot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../programmation/moteur.depot")>();
  const fx = await import("../programmation/scenario.fixtures");
  const clone = <T,>(x: T): T => structuredClone(x);
  return {
    ...actual,
    listerParametres: async () => h.parametres.filter((p) => !p.deletedAt).map(clone),
    lireParametresParId: async (_db: unknown, id: string) => { const p = h.parametres.find((x) => x.id === id && !x.deletedAt); return p ? clone(p) : null; },
    chargerCandidats: async (_db: unknown, f: { regionId?: number | null; classe?: string | null; registrePointsNoirsMinimum?: number }) => {
      h.dernierFiltre = { ...f };
      const l = (h.nbCandidats > 0
        ? Array.from({ length: h.nbCandidats }, (_, i) => fx.candidat(`id-${i}`, { code: `C-${i}` }))
        : fx.candidatsDeBase()
      ).map((c) => ({ ...c, longueurOrigine: c.longueurOrigine ?? (c.longueurM !== null ? "LONGUEUR_KM" as const : null), longueurMetierDerivee: h.derivees.includes(c.id) ? true : false }));
      return l.filter((c) => (f.regionId == null || c.regionId === f.regionId) && (!f.classe || c.classe === f.classe));
    },
    chargerCatalogue: async () => fx.CATALOGUE, chargerConditions: async () => fx.CONDITIONS, chargerMatrices: async () => fx.MATRICES,
    insererScenario: async (_db: unknown, s: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      h.insertions += 1;
      const l = { ...s, perimetre: JSON.parse(s.perimetreJson), creeLe: new Date("2026-10-26T09:00:00Z"), deletedAt: null };
      h.scenarios.set(s.id, l);
      const { entreesCanoniques: _e, resultatCanonique: _r, ...resume } = l;
      return resume;
    },
    lireScenario: async (_db: unknown, id: string) => { const s = h.scenarios.get(id); return s && !s.deletedAt ? clone(s) : null; },
    supprimerScenarioLogiquement: async (_db: unknown, id: string) => { const s = h.scenarios.get(id); if (s) s.deletedAt = new Date(); return s ? 1 : 0; },
    fichesDuScenario: async () => [],
  };
});

vi.mock("../programmation/comparaison.depot", async () => {
  const fx = await import("../programmation/scenario.fixtures");
  const { versionDesBaremes } = await import("../programmation/contraintes.fixtures");
  return {
    chargerBaremesSimulation: async () => ({ baremes: fx.BAREMES, refs: versionDesBaremes().liste }),
    nomsAuteurs: async () => new Map(),
    listerResumes: async (_db: unknown, f: { regions?: readonly number[] | null; limite: number; decalage: number; q?: string | null; logique?: string | null; annee?: number | null }) => {
      const tous = [...h.scenarios.values()].filter((s) => !s.deletedAt && (!f.regions || f.regions.includes(s.perimetre?.regionId)))
        .filter((s) => !f.q || s.intitule.toLowerCase().includes(f.q.toLowerCase()))
        .filter((s) => !f.annee || s.annee === f.annee);
      const lignes = tous.slice(f.decalage, f.decalage + f.limite).map((s) => {
        const e = JSON.parse(s.entreesCanoniques); const r = JSON.parse(s.resultatCanonique);
        const { entreesCanoniques: _e, resultatCanonique: _r, ...resume } = s;
        return { ...resume, auteurNom: null, logique: e.simulation?.logique ?? null, periodeDebut: e.simulation?.periode.debut ?? null, periodeFin: e.simulation?.periode.fin ?? null, deficitGnf: r.simulation?.bilan.deficitGnf ?? null, deficitMinorant: r.simulation?.bilan.deficitMinorant ?? null };
      });
      return { total: tous.length, lignes };
    },
  };
});

import { _installerResolveurCompte } from "../middleware/auth.middleware";
import { signAccessToken } from "../utils/jwt";
import { errorHandler } from "../middleware/error.middleware";
import { scenariosAideDecisionRouter } from "./aide-decision.scenarios.routes";
import { VALEURS_AMORCAGE_PROVISOIRES } from "../programmation/parametres.noyau";
import { BLOC_PRIORITE_AMORCAGE } from "../programmation/priorite.parametres";
import { entreesVersJson, construireScenario } from "../programmation/scenario.noyau";
import { entreesSimulation } from "../programmation/contraintes.fixtures";
import { canonique } from "../programmation/canonique";

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use("/aide-decision", scenariosAideDecisionRouter);
app.use(errorHandler);

const TOUS = ["decision", "programmation", "rapports", "marches", "chantiers"];
const COMPTES: Record<string, { id: string; role: string; modules: string[]; regions?: number[] }> = {
  ADMIN: { id: "u-admin", role: "ADMIN", modules: [] },
  GEST_NAT: { id: "u-gest-nat", role: "GESTIONNAIRE", modules: TOUS },
  GEST_R1: { id: "u-gest-r1", role: "GESTIONNAIRE", modules: TOUS, regions: [1] },
  GEST_R2: { id: "u-gest-r2", role: "GESTIONNAIRE", modules: TOUS, regions: [2] },
  // Droit sur les montants : ADMIN, `marches` ou `chantiers` (droitMontantsContractuels). `decision` + `programmation` + `rapports` ne l'ouvrent pas.
  GEST_SANS_FINANCIER: { id: "u-gest-sf", role: "GESTIONNAIRE", modules: ["decision", "programmation", "rapports"] },
  GEST_CHANTIERS: { id: "u-gest-ch", role: "GESTIONNAIRE", modules: ["decision", "programmation", "rapports", "chantiers"] },
  GEST_MARCHES: { id: "u-gest-ma", role: "GESTIONNAIRE", modules: ["decision", "programmation", "rapports", "marches"] },
  GEST_SANS_RAPPORTS: { id: "u-gest-sr", role: "GESTIONNAIRE", modules: ["decision", "programmation"] },
  INSPECTEUR: { id: "u-insp", role: "INSPECTEUR", modules: TOUS },
  LECTEUR: { id: "u-lect", role: "LECTEUR", modules: TOUS },
  LECTEUR_SANS_PROG: { id: "u-lect-sp", role: "LECTEUR", modules: ["decision"] },
  LECTEUR_SANS_DEC: { id: "u-lect-sd", role: "LECTEUR", modules: ["programmation"] },
  LECTEUR_VIDE: { id: "u-lect-v", role: "LECTEUR", modules: [] },
};
const jeton = (c: string) => signAccessToken({ sub: COMPTES[c].id, role: COMPTES[c].role as never, email: `${c}@essai.invalid` });
const matrice: string[] = [];

const SEED = { id: "p-seed", version: "prog-provisoire-1", source: "amorcage_provisoire", valeurs: structuredClone(VALEURS_AMORCAGE_PROVISOIRES), motif: "amorcage", creeParId: null, createdAt: new Date("2026-10-23T00:00:00Z"), approuveeLe: null, approuveeParId: null, deletedAt: null };

beforeEach(() => {
  h.scenarios.clear(); h.audit = []; h.ecritures = []; h.insertions = 0; h.nbCandidats = 0; h.derivees = []; h.dernierFiltre = null;
  h.parametres = [structuredClone(SEED)];
  h.modules = {}; h.perimetres = {};
  for (const c of Object.values(COMPTES)) { h.modules[c.id] = c.modules; if (c.regions) h.perimetres[c.id] = c.regions; }
  _installerResolveurCompte(async (id) => {
    const c = Object.values(COMPTES).find((x) => x.id === id);
    return c ? { actif: true, lockedUntil: null, role: c.role as never, email: `${id}@essai.invalid` } : null;
  });
});
afterAll(() => { _installerResolveurCompte(null); console.log("MATRICE\n" + matrice.join("\n")); });

async function appel(compte: string | null, methode: "get" | "post", url: string, corps?: object) {
  let r = request(app)[methode](`/aide-decision${url}`);
  if (compte) r = r.set("Authorization", `Bearer ${jeton(compte)}`);
  const rep = await (corps ? r.send(corps) : r);
  matrice.push(`${(compte ?? "ANONYME").padEnd(18)} ${methode.toUpperCase().padEnd(5)} ${url.padEnd(60)} -> ${rep.status}`);
  return rep;
}

const corps = (o: Record<string, unknown> = {}) => ({
  annee: 2027, budgetGnf: "10000000000", periode: { debut: "2027-01-01", fin: "2027-12-31" }, logique: "ratio_cout_impact", ...o,
});
const corpsNomme = (o: Record<string, unknown> = {}) => ({ ...corps(o), intitule: "PAE 2027 essai", ...o });
const UUID_INCONNU = "00000000-0000-4000-8000-000000000000";

async function creer(compte = "GEST_NAT", o: Record<string, unknown> = {}) {
  const r = await appel(compte, "post", "/scenarios", corpsNomme(o));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { scenario: { id: string; empreinteResultat: string }; resultat: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe("1. ANONYME : 401 partout, aucune ecriture", () => {
  const ROUTES: ["get" | "post", string, object?][] = [
    ["get", "/scenarios/options"], ["get", "/scenarios/candidats"], ["post", "/scenarios/simuler", corps()], ["post", "/scenarios", corpsNomme()], ["get", "/scenarios"],
    ["post", "/scenarios/comparer", { ids: [UUID_INCONNU, UUID_INCONNU] }], ["get", `/scenarios/${UUID_INCONNU}`], ["post", `/scenarios/${UUID_INCONNU}/rejouer`],
    ["post", `/scenarios/${UUID_INCONNU}/supprimer`], ["get", `/scenarios/${UUID_INCONNU}/export?format=csv`],
  ];
  it.each(ROUTES)("%s %s", async (m, u, c) => {
    expect((await appel(null, m, u, c)).status).toBe(401);
    expect(h.ecritures).toEqual([]);
    expect(h.insertions).toBe(0);
  });
});

describe("2. Modules : decision ET programmation, sinon 403", () => {
  it.each(["LECTEUR_SANS_PROG", "LECTEUR_SANS_DEC", "LECTEUR_VIDE"])("%s : toutes les routes refusees (403)", async (c) => {
    for (const [m, u, b] of [["get", "/scenarios"], ["get", "/scenarios/options"], ["post", "/scenarios/simuler", corps()], ["post", "/scenarios/comparer", { ids: [UUID_INCONNU, UUID_INCONNU] }]] as ["get" | "post", string, object?][]) {
      expect((await appel(c, m, u, b)).status).toBe(403);
    }
    expect(h.insertions).toBe(0);
  });
  it("ADMIN passe sans configuration de module", async () => {
    expect((await appel("ADMIN", "get", "/scenarios")).status).toBe(200);
  });
});

describe("3. Roles : proposer = ADMIN ou GESTIONNAIRE ; lire = tout compte du module", () => {
  it.each(["LECTEUR", "INSPECTEUR"])("%s lit mais ne simule, n'enregistre ni ne supprime", async (c) => {
    expect((await appel(c, "get", "/scenarios")).status).toBe(200);
    expect((await appel(c, "get", "/scenarios/options")).status).toBe(200);
    expect((await appel(c, "get", "/scenarios/candidats")).status).toBe(200);
    expect((await appel(c, "post", "/scenarios/simuler", corps())).status).toBe(403);
    expect((await appel(c, "post", "/scenarios", corpsNomme())).status).toBe(403);
    expect((await appel(c, "post", `/scenarios/${UUID_INCONNU}/supprimer`)).status).toBe(403);
    expect(h.insertions).toBe(0);
    expect(h.audit).toEqual([]);
  });
  it.each(["GEST_NAT", "ADMIN"])("%s simule, enregistre, rejoue, supprime", async (c) => {
    expect((await appel(c, "post", "/scenarios/simuler", corps())).status).toBe(200);
    const s = await creer(c);
    expect((await appel(c, "post", `/scenarios/${s.scenario.id}/rejouer`)).status).toBe(200);
    expect((await appel(c, "post", `/scenarios/${s.scenario.id}/supprimer`)).status).toBe(200);
  });
  it("l'export exige le module rapports ET un role ADMIN/GESTIONNAIRE", async () => {
    const s = await creer("GEST_NAT");
    const url = `/scenarios/${s.scenario.id}/export?format=csv`;
    expect((await appel("GEST_SANS_RAPPORTS", "get", url)).status).toBe(403);
    expect((await appel("LECTEUR", "get", url)).status).toBe(403);
    expect((await appel("INSPECTEUR", "get", url)).status).toBe(403);
    expect((await appel("GEST_NAT", "get", url)).status).toBe(200);
    expect((await appel("ADMIN", "get", url)).status).toBe(200);
  });
  it("la comparaison est une lecture : un lecteur peut comparer", async () => {
    const a = await creer("GEST_NAT"), b = await creer("GEST_NAT", { budgetGnf: "5000000000" });
    const r = await appel("LECTEUR", "post", "/scenarios/comparer", { ids: [a.scenario.id, b.scenario.id] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });
});

describe("4. Perimetre territorial : calcul national refuse a un compte regional, 404 identique hors perimetre", () => {
  it("un compte regional ne calcule pas sans region, ni sur une autre region ; il calcule sur la sienne", async () => {
    expect((await appel("GEST_R1", "post", "/scenarios/simuler", corps())).status).toBe(403);
    expect((await appel("GEST_R1", "post", "/scenarios", corpsNomme())).status).toBe(403);
    expect((await appel("GEST_R1", "post", "/scenarios/simuler", corps({ regionId: 2 }))).status).toBe(403);
    const r = await appel("GEST_R1", "post", "/scenarios/simuler", corps({ regionId: 1 }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.resultat.totaux.candidats).toBe(2); // RN-A et RN-C, region 1 ; jamais RN-B (region 2)
    expect(h.insertions).toBe(0);
  });

  it("candidats : un compte regional doit nommer sa region", async () => {
    expect((await appel("GEST_R1", "get", "/scenarios/candidats")).status).toBe(403);
    expect((await appel("GEST_R1", "get", "/scenarios/candidats?regionId=2")).status).toBe(403);
    const r = await appel("GEST_R1", "get", "/scenarios/candidats?regionId=1");
    expect(r.status).toBe(200);
    expect(r.body.data.map((c: { code: string }) => c.code).sort()).toEqual(["RN-A", "RN-C"]);
  });

  it("candidats : une longueur `longueurKm` DERIVEE de la geometrie est rendue avec son drapeau, jamais presentee comme une longueur metier saisie (comme la liste priorisee)", async () => {
    h.derivees = ["a"];
    const r = await appel("GEST_NAT", "get", "/scenarios/candidats");
    expect(r.status).toBe(200);
    const parCode = Object.fromEntries(r.body.data.map((c: { code: string }) => [c.code, c]));
    expect(parCode["RN-A"]).toMatchObject({ longueurOrigine: "LONGUEUR_KM", longueurMetierKm: "4.000", longueurMetierDerivee: true, longueurGeometriqueKm: null });
    expect(parCode["RN-B"]).toMatchObject({ longueurOrigine: "LONGUEUR_KM", longueurMetierKm: "1.000", longueurMetierDerivee: false });
  });

  it("candidats : le minimum de points noirs transmis au chargement est celui d'amorcage (meme regle que la liste), et la simulation prend celui de la version choisie", async () => {
    await appel("GEST_NAT", "get", "/scenarios/candidats");
    expect(h.dernierFiltre).toMatchObject({ registrePointsNoirsMinimum: 5 });
    h.parametres = [{ ...structuredClone(SEED), valeurs: { ...structuredClone(SEED.valeurs), priorite: { ...structuredClone(BLOC_PRIORITE_AMORCAGE), registrePointsNoirsMinimum: 9 } } }];
    expect((await appel("GEST_NAT", "post", "/scenarios/simuler", corps())).status).toBe(200);
    expect(h.dernierFiltre).toMatchObject({ registrePointsNoirsMinimum: 9 });
  });

  it("un scenario national est INTROUVABLE pour un compte regional : meme 404, meme corps qu'un identifiant inconnu ou mal forme", async () => {
    const nat = await creer("GEST_NAT");
    const hors = await creer("GEST_NAT", { regionId: 2 });
    const reponses = [
      await appel("GEST_R1", "get", `/scenarios/${nat.scenario.id}`),
      await appel("GEST_R1", "get", `/scenarios/${hors.scenario.id}`),
      await appel("GEST_R1", "get", `/scenarios/${UUID_INCONNU}`),
      await appel("GEST_R1", "get", "/scenarios/pas-un-identifiant"),
      await appel("GEST_NAT", "get", `/scenarios/${UUID_INCONNU}`),
    ];
    for (const r of reponses) expect(r.status).toBe(404);
    for (const r of reponses) expect(r.body).toEqual(reponses[0].body);
    // meme oracle sur chaque route designant un scenario
    for (const [m, suffixe] of [["post", "/rejouer"], ["post", "/supprimer"], ["get", "/export?format=json"]] as const) {
      const a = await appel("GEST_R1", m, `/scenarios/${nat.scenario.id}${suffixe}`);
      const b = await appel("GEST_R1", m, `/scenarios/${UUID_INCONNU}${suffixe}`);
      expect([a.status, b.status]).toEqual([404, 404]);
      expect(a.body).toEqual(b.body);
    }
    // le scenario n'a pas ete supprime ni exporte par la tentative
    expect(h.scenarios.get(nat.scenario.id)!.deletedAt).toBeNull();
    expect(h.audit.filter((a) => a.entityType === "ExportScenario" || a.action === "DELETE")).toEqual([]);
  });

  it("la liste d'un compte regional ne contient que son perimetre, et la comparaison traite un scenario hors perimetre comme inconnu", async () => {
    const r1 = await creer("GEST_NAT", { regionId: 1 }), r2 = await creer("GEST_NAT", { regionId: 2 }), nat = await creer("GEST_NAT");
    const liste = await appel("GEST_R1", "get", "/scenarios");
    expect(liste.body.data.map((s: { id: string }) => s.id)).toEqual([r1.scenario.id]);
    expect(liste.body.total).toBe(1);
    const cmp = await appel("GEST_R1", "post", "/scenarios/comparer", { ids: [r1.scenario.id, r2.scenario.id] });
    const inconnu = await appel("GEST_R1", "post", "/scenarios/comparer", { ids: [r1.scenario.id, UUID_INCONNU] });
    expect([cmp.status, inconnu.status]).toEqual([404, 404]);
    expect(cmp.body).toEqual(inconnu.body);
    expect((await appel("GEST_R1", "post", "/scenarios/comparer", { ids: [r1.scenario.id, nat.scenario.id] })).status).toBe(404);
    const national = await appel("GEST_NAT", "get", "/scenarios");
    expect(national.body.total).toBe(3);
  });

  it("l'export d'un compte national porte « national » ; celui d'un compte regional ne voit que sa region", async () => {
    const r1 = await creer("GEST_NAT", { regionId: 1 });
    const e = await appel("GEST_R1", "get", `/scenarios/${r1.scenario.id}/export?format=json`);
    expect(e.status).toBe(200);
    expect(JSON.parse(e.text).perimetre.territoireApplique).toEqual([1]);
    const n = await appel("GEST_NAT", "get", `/scenarios/${r1.scenario.id}/export?format=json`);
    expect(JSON.parse(n.text).perimetre.territoireApplique).toBe("national");
  });
});

describe("5. Entrees hostiles : 400, jamais 500, jamais d'ecriture", () => {
  const hostiles: [string, Record<string, unknown>][] = [
    ["enveloppe negative", { budgetGnf: "-1" }],
    ["enveloppe decimale", { budgetGnf: "1.5" }],
    ["enveloppe en nombre", { budgetGnf: 1000 }],
    ["enveloppe vide", { budgetGnf: "" }],
    ["enveloppe de 19 chiffres", { budgetGnf: "1000000000000000000" }],
    ["enveloppe avec espaces", { budgetGnf: "1 000" }],
    ["enveloppe scientifique", { budgetGnf: "1e9" }],
    ["annee hors plage", { annee: 1999 }],
    ["annee en chaine", { annee: "2027" }],
    ["logique inconnue", { logique: "au_hasard" }],
    ["logique absente", { logique: undefined }],
    ["periode absente", { periode: undefined }],
    ["periode : 31 fevrier", { periode: { debut: "2027-02-31", fin: "2027-12-31" } }],
    ["periode : fin avant debut", { periode: { debut: "2027-12-31", fin: "2027-01-01" } }],
    ["periode : format", { periode: { debut: "01/01/2027", fin: "31/12/2027" } }],
    ["champ inconnu (auteur dans le corps)", { creeParId: "u-admin" }],
    ["__proto__", JSON.parse('{"__proto__": {"admin": true}, "x": 1}')],
    ["groupe d'un seul troncon", { groupesNonDivisibles: [["a"]] }],
    ["equilibre 0 %", { logique: "equilibre_territorial", equilibre: { partMinimaleParRegionPct: 0 } }],
    ["equilibre 101 %", { logique: "equilibre_territorial", equilibre: { partMinimaleParRegionPct: 101 } }],
    ["equilibre decimal", { logique: "equilibre_territorial", equilibre: { partMinimaleParRegionPct: 12.5 } }],
    ["plafond negatif", { plafondsRegionauxGnf: { "1": "-5" } }],
    ["cle de plafond non numerique", { plafondsRegionauxGnf: { "x": "5" } }],
    ["classe inconnue", { classe: "XX" }],
    ["region negative", { regionId: -1 }],
    ["obligatoires non texte", { obligatoires: [1, 2] }],
    ["trop d'obligatoires", { obligatoires: Array.from({ length: 501 }, (_, i) => `t${i}`) }],
    ["selection vide", { selection: [] }],
    ["bareme non entier", { baremeIds: ["x"] }],
  ];
  it.each(hostiles)("simuler : %s", async (_nom, o) => {
    const r = await appel("GEST_NAT", "post", "/scenarios/simuler", { ...corps(), ...o });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(h.insertions).toBe(0);
  });
  it.each(hostiles)("enregistrer : %s", async (_nom, o) => {
    expect((await appel("GEST_NAT", "post", "/scenarios", { ...corpsNomme(), ...o })).status).toBe(400);
    expect(h.insertions).toBe(0);
    expect(h.audit).toEqual([]);
  });
  it("intitule : trop court, trop long, absent", async () => {
    for (const intitule of ["ab", "x".repeat(301), undefined]) {
      expect((await appel("GEST_NAT", "post", "/scenarios", { ...corps(), intitule })).status).toBe(400);
    }
  });
  it("comparer : un seul identifiant, six, doublons de forme, ids non texte, champ en plus", async () => {
    const six = Array.from({ length: 6 }, () => UUID_INCONNU);
    for (const b of [{ ids: [UUID_INCONNU] }, { ids: six }, { ids: [1, 2] }, { ids: [UUID_INCONNU, UUID_INCONNU], extra: 1 }, {}]) {
      expect((await appel("GEST_NAT", "post", "/scenarios/comparer", b)).status).toBe(400);
    }
  });
  it("liste, options, candidats, export : parametres hors schema", async () => {
    expect((await appel("GEST_NAT", "get", "/scenarios?annee=abc")).status).toBe(400);
    expect((await appel("GEST_NAT", "get", "/scenarios?pageSize=1000")).status).toBe(400);
    expect((await appel("GEST_NAT", "get", "/scenarios?logique=zzz")).status).toBe(400);
    expect((await appel("GEST_NAT", "get", "/scenarios?inconnu=1")).status).toBe(400);
    expect((await appel("GEST_NAT", "get", "/scenarios/options?debut=2027-01-01")).status).toBe(400);
    expect((await appel("GEST_NAT", "get", "/scenarios/options?debut=2027-12-31&fin=2027-01-01")).status).toBe(400);
    expect((await appel("GEST_NAT", "get", "/scenarios/candidats?classe=XX")).status).toBe(400);
    const s = await creer("GEST_NAT");
    expect((await appel("GEST_NAT", "get", `/scenarios/${s.scenario.id}/export`)).status).toBe(400);
    expect((await appel("GEST_NAT", "get", `/scenarios/${s.scenario.id}/export?format=pdf`)).status).toBe(400);
    expect((await appel("GEST_NAT", "get", `/scenarios/${s.scenario.id}/export?format=csv&x=1`)).status).toBe(400);
  });
  it("refus metier (422) et non 500 : perimetre trop large, selection hors perimetre, ordre personnalise inconnu, equilibre impossible", async () => {
    h.nbCandidats = 3001;
    expect((await appel("GEST_NAT", "post", "/scenarios/simuler", corps())).status).toBe(422);
    h.nbCandidats = 0;
    const sel = await appel("GEST_NAT", "post", "/scenarios/simuler", corps({ selection: ["a", "zzz"] }));
    expect([sel.status, sel.body.code]).toEqual([422, "SELECTION_INVALIDE"]);
    const ordre = await appel("GEST_NAT", "post", "/scenarios/simuler", corps({ logique: "personnalise", ordrePersonnalise: ["a", "zzz"] }));
    expect([ordre.status, ordre.body.code]).toEqual([422, "ENTREES_INVALIDES"]);
    const eq = await appel("GEST_NAT", "post", "/scenarios/simuler", corps({ logique: "equilibre_territorial", equilibre: { partMinimaleParRegionPct: 60 } }));
    expect(eq.status).toBe(422);
    expect(eq.body.error).toMatch(/dépassent 100 %/);
  });
});

describe("6. Calcul : valeurs a la main, jamais d'invention, et aucune ecriture hors scenario", () => {
  it("simuler : resultat a la main (enveloppe 5 Md), mention, periode, aucun enregistrement", async () => {
    const r = await appel("GEST_NAT", "post", "/scenarios/simuler", corps({ budgetGnf: "5000000000" }));
    expect(r.status).toBe(200);
    expect(r.body.enregistre).toBe(false);
    expect(r.body.empreinteResultat).toMatch(/^[0-9a-f]{64}$/);
    const s = r.body.resultat;
    expect(s.simulation.mention).toBe("SIMULATION NON ENGAGEANTE : ne constitue ni une autorisation de dépense ni un ordre de travaux.");
    expect(s.simulation.bilan).toMatchObject({ consommeGnf: "4300000000", resteGnf: "700000000", besoinTotalGnf: "8700000000", deficitGnf: "3700000000" });
    expect(s.lignes.map((l: { troncon: { code: string }; decision: string }) => [l.troncon.code, l.decision])).toEqual([["RN-C", "RETENUE"], ["RN-A", "ECARTEE"], ["RN-B", "RETENUE"]]);
    expect(h.insertions).toBe(0);
    expect(h.audit).toEqual([]);
    expect(h.ecritures).toEqual([]);
  });

  it("enveloppe 0 est acceptee (rien n'est retenu, deficit = besoin) ; la plus grande enveloppe de 18 chiffres aussi", async () => {
    const zero = await appel("GEST_NAT", "post", "/scenarios/simuler", corps({ budgetGnf: "0" }));
    expect(zero.status).toBe(200);
    expect(zero.body.resultat.totaux.retenues).toBe(0);
    expect(zero.body.resultat.simulation.bilan.deficitGnf).toBe("8700000000");
    const max = await appel("GEST_NAT", "post", "/scenarios/simuler", corps({ budgetGnf: "999999999999999999" }));
    expect(max.status).toBe(200);
    expect(max.body.resultat.simulation.bilan.resteGnf).toBe((999999999999999999n - 8_700_000_000n).toString());
  });

  it("enregistrer : une seule insertion, l'auteur est celui de la SESSION, audit CREATE avec le deficit et la version des baremes", async () => {
    const s = await creer("GEST_R1", { regionId: 1, budgetGnf: "3000000000" });
    expect(h.insertions).toBe(1);
    expect(h.scenarios.get(s.scenario.id)!.creeParId).toBe("u-gest-r1");
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({ action: "CREATE", entityType: "ScenarioProgrammation", entityId: s.scenario.id, userId: "u-gest-r1" });
    expect(h.audit[0].after).toMatchObject({ origine: "simulateur", logique: "ratio_cout_impact", deficitGnf: expect.any(String), baremesEmpreinte: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // AD-08 : ni budget, ni marche, ni chantier, ni bareme : la seule ecriture est le scenario (et l'audit)
    expect(h.ecritures).toEqual([]);
  });

  it("detail : options relues du texte scelle, empreintes, resultat complet", async () => {
    const s = await creer("GEST_NAT", { logique: "urgence", obligatoires: ["a"] });
    const d = await appel("LECTEUR", "get", `/scenarios/${s.scenario.id}`);
    expect(d.status).toBe(200);
    expect(d.body.simulateur).toBe(true);
    expect(d.body.entrees.simulation).toMatchObject({ logique: "urgence", obligatoires: ["a"], periode: { debut: "2027-01-01", fin: "2027-12-31" }, devise: "GNF" });
    expect(d.body.entrees.simulation.baremes.empreinte).toMatch(/^[0-9a-f]{64}$/);
    expect(d.body.resultat.simulation.logique.code).toBe("urgence");
    expect(d.body.scenario.empreinteResultat).toBe(s.scenario.empreinteResultat);
  });

  it("rejeu : identique octet pour octet ; un resultat stocke altere est signale non identique (mutation de controle)", async () => {
    const s = await creer("GEST_NAT", { logique: "personnalise", ordrePersonnalise: ["b", "a"], obligatoires: ["c"], groupesNonDivisibles: [["a", "b"]] });
    const ok = await appel("LECTEUR", "post", `/scenarios/${s.scenario.id}/rejouer`);
    expect(ok.body).toMatchObject({ identique: true, entreesIntegres: true });
    const stocke = h.scenarios.get(s.scenario.id)!;
    stocke.resultatCanonique = stocke.resultatCanonique.replace('"retenues":', '"retenues":0,"x":');
    const ko = await appel("LECTEUR", "post", `/scenarios/${s.scenario.id}/rejouer`);
    expect(ko.body.identique).toBe(false);
  });

  it("liste : periode, logique et deficit lus dans le scelle ; filtre par intitule", async () => {
    await creer("GEST_NAT", { intitule: "PAE Boké 2027", budgetGnf: "5000000000", logique: "criticite" });
    await creer("GEST_NAT", { intitule: "Autre scénario" });
    const r = await appel("LECTEUR", "get", "/scenarios?q=boké");
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
    expect(r.body.data[0]).toMatchObject({ intitule: "PAE Boké 2027", simulateur: true, logique: "criticite", periode: { debut: "2027-01-01", fin: "2027-12-31" }, deficitGnf: "3700000000" });
    expect(typeof r.body.data[0].budgetGnf).toBe("string");
  });

  it("un scenario herite (sans simulation) apparait dans la liste mais ne se compare ni ne s'exporte comme une simulation", async () => {
    const e = entreesSimulation();
    const herite = construireScenario({ ...e, simulation: undefined });
    if (!herite.ok) throw new Error("refus");
    const texteEntrees = canonique(entreesVersJson({ ...e, simulation: undefined }));
    const { sha256Hex } = await import("../programmation/canonique");
    const resultat = canonique(herite.scenario);
    h.scenarios.set("11111111-1111-4111-8111-111111111111", {
      id: "11111111-1111-4111-8111-111111111111", annee: 2027, intitule: "PAE ancien", parametresId: "p-seed", parametresVersion: "prog-provisoire-1", budgetGnf: 10_000_000_000n,
      perimetre: { regionId: null }, entreesCanoniques: texteEntrees, empreinteEntrees: sha256Hex(texteEntrees), resultatCanonique: resultat, empreinteResultat: sha256Hex(resultat),
      nbRetenues: 3, nbEcartees: 0, montantEngageGnf: 8_700_000_000n, provisoire: true, creeParId: "u1", creeLe: new Date("2026-10-01T00:00:00Z"), deletedAt: null,
    });
    const nouveau = await creer("GEST_NAT");
    const liste = await appel("GEST_NAT", "get", "/scenarios");
    expect(liste.body.data.find((s: { id: string }) => s.id.startsWith("1111"))).toMatchObject({ simulateur: false, logique: null, periode: null, deficitGnf: null });
    const cmp = await appel("GEST_NAT", "post", "/scenarios/comparer", { ids: ["11111111-1111-4111-8111-111111111111", nouveau.scenario.id] });
    expect([cmp.status, cmp.body.code]).toEqual([422, "SCENARIO_SANS_SIMULATION"]);
    const exp = await appel("GEST_NAT", "get", "/scenarios/11111111-1111-4111-8111-111111111111/export?format=csv");
    expect([exp.status, exp.body.code]).toEqual([422, "SCENARIO_SANS_SIMULATION"]);
    // le rejeu d'un scenario herite reste identique : retrocompatibilite
    const rejeu = await appel("GEST_NAT", "post", "/scenarios/11111111-1111-4111-8111-111111111111/rejouer");
    expect(rejeu.body).toMatchObject({ identique: true, entreesIntegres: true });
  });

  it("suppression logique : le scenario disparait des lectures, audit DELETE, aucune autre ecriture", async () => {
    const s = await creer("GEST_NAT");
    h.audit = [];
    const r = await appel("GEST_NAT", "post", `/scenarios/${s.scenario.id}/supprimer`);
    expect(r.status).toBe(200);
    expect(h.scenarios.get(s.scenario.id)!.deletedAt).not.toBeNull();
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({ action: "DELETE", entityType: "ScenarioProgrammation", entityId: s.scenario.id, userId: "u-gest-nat" });
    expect((await appel("GEST_NAT", "get", `/scenarios/${s.scenario.id}`)).status).toBe(404);
    expect((await appel("GEST_NAT", "post", `/scenarios/${s.scenario.id}/supprimer`)).status).toBe(404);
  });

  it("options : cinq logiques dont deux provisoires, mention, baremes avec statut et couverture de la periode", async () => {
    const r = await appel("LECTEUR", "get", "/scenarios/options?debut=2027-01-01&fin=2027-12-31");
    expect(r.status).toBe(200);
    expect(r.body.logiques.map((l: { code: string }) => l.code)).toEqual(["ratio_cout_impact", "urgence", "criticite", "equilibre_territorial", "personnalise"]);
    expect(r.body.logiques.filter((l: { provisoire: boolean }) => l.provisoire)).toHaveLength(2);
    expect(r.body.mention).toMatch(/SIMULATION NON ENGAGEANTE/);
    expect(r.body.devise).toBe("GNF");
    expect(r.body.baremes).toHaveLength(9);
    expect(r.body.baremes.every((b: { statut: string; couvrePeriode: boolean }) => b.statut === "PROVISOIRE" && b.couvrePeriode)).toBe(true);
    expect(r.body.parametres[0]).toMatchObject({ version: "prog-provisoire-1", provisoire: true });
    expect(r.body.contraintes.reglesFinancement).toMatch(/non modélisées/);
    const sans = await appel("LECTEUR", "get", "/scenarios/options");
    expect(sans.body.baremes).toBeNull();
  });
});

describe("7. Comparaison et export par l'API", () => {
  it("compare deux scenarios : tableau cote a cote, aucune ecriture", async () => {
    const a = await creer("GEST_NAT", { budgetGnf: "5000000000" }), b = await creer("GEST_NAT", { budgetGnf: "8000000000", logique: "urgence" });
    const avant = h.insertions;
    h.audit = [];
    const r = await appel("GEST_NAT", "post", "/scenarios/comparer", { ids: [a.scenario.id, b.scenario.id] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.scenarios.map((s: { deficitGnf: string }) => s.deficitGnf)).toEqual(["3700000000", "700000000"]);
    expect(r.body.mention).toMatch(/NON ENGAGEANTE/);
    expect(h.insertions).toBe(avant);
    expect(h.audit).toEqual([]);
    expect(h.ecritures).toEqual([]);
  });

  it("PERIMETRES DIFFERENTS (region, classe, selection) : comparaison servie avec les hypotheses et un avertissement, jamais en silence", async () => {
    const r1 = await creer("GEST_NAT", { regionId: 1 }), r2 = await creer("GEST_NAT", { regionId: 2, classe: "RN" });
    const r = await appel("GEST_NAT", "post", "/scenarios/comparer", { ids: [r1.scenario.id, r2.scenario.id] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.perimetresIdentiques).toBe(false);
    expect(r.body.avertissements[0]).toContain("Périmètres différents (région, classe de route)");
    const h = Object.fromEntries(r.body.hypotheses.map((x: { champ: string; valeurs: string[] }) => [x.champ, x.valeurs]));
    expect(h.region).toEqual(["région 1", "région 2"]);
    expect(h.classe).toEqual(["toutes les classes", "RN"]);
    expect(r.body.scenarios.map((c: { perimetre: unknown }) => c.perimetre)).toEqual([{ regionId: 1, classe: null, nbSelection: null }, { regionId: 2, classe: "RN", nbSelection: null }]);
    const memes = await appel("GEST_NAT", "post", "/scenarios/comparer", { ids: [(await creer("GEST_NAT", { regionId: 1 })).scenario.id, r1.scenario.id] });
    expect([memes.body.perimetresIdentiques, memes.body.avertissements]).toEqual([true, []]);
  });

  it("refuse des periodes incompatibles (422) avec un message", async () => {
    const a = await creer("GEST_NAT"), b = await creer("GEST_NAT", { periode: { debut: "2027-01-01", fin: "2028-12-31" } });
    const r = await appel("GEST_NAT", "post", "/scenarios/comparer", { ids: [a.scenario.id, b.scenario.id] });
    expect([r.status, r.body.code]).toEqual([422, "PERIODES_INCOMPATIBLES"]);
    expect(r.body.error).toMatch(/périodes différentes/);
  });

  it("export CSV : mention en premiere ligne, date, auteur, versions, nom de fichier sur", async () => {
    const s = await creer("GEST_NAT", { budgetGnf: "5000000000" });
    const r = await appel("GEST_NAT", "get", `/scenarios/${s.scenario.id}/export?format=csv`);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/csv/);
    expect(r.headers["content-disposition"]).toMatch(/^attachment; filename="simulation-[0-9a-f]{8}-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["cache-control"]).toBe("no-store"); // un export n'est jamais conserve par un cache (avant : private, no-cache)
    expect(r.text.startsWith("﻿SIMULATION NON ENGAGEANTE : ne constitue ni une autorisation de dépense ni un ordre de travaux.\n")).toBe(true);
    expect(r.text).toContain("Export;Généré par;u-gest-nat@essai.invalid"); // l'auteur de l'export est celui de la SESSION
    expect(r.text).toMatch(/Export;Généré le;\d{4}-\d{2}-\d{2}T/);
    expect(r.text).toContain("Versions;Barèmes (empreinte);");
    expect(r.text).toContain("Bilan;Déficit (GNF);3700000000");
  });

  it("export JSON : objet complet, et l'export est JOURNALISE (qui, quand, format, lignes, territoire)", async () => {
    const s = await creer("GEST_NAT");
    h.audit = [];
    const r = await appel("GEST_NAT", "get", `/scenarios/${s.scenario.id}/export?format=json`);
    expect(r.status).toBe(200);
    const j = JSON.parse(r.text);
    expect(j.mention).toMatch(/NON ENGAGEANTE/);
    expect(j.format).toBe("ad-simulation-export");
    expect(j.lignes).toHaveLength(3);
    expect(j.scenario.auteurId).toBe("u-gest-nat");
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({ action: "CREATE", entityType: "ExportScenario", entityId: s.scenario.id, userId: "u-gest-nat" });
    expect(h.audit[0].after).toMatchObject({ format: "json", nbLignes: 3, territoire: "national" });
    expect(h.audit[0].after.genereLe).toBe(j.genereLe);
  });

  it("DROIT FINANCIER : un compte sans le droit (decision + programmation + rapports) ne lit AUCUN montant, ni en JSON ni en CSV", async () => {
    const s = await creer("GEST_NAT", { budgetGnf: "5000000000" });
    const montants = new Set<string>(["5000000000", "3700000000", s.resultat.totaux.engageGnf, s.resultat.totaux.resteGnf]);
    for (const l of s.resultat.lignes) {
      if (l.cout?.ok) montants.add(l.cout.montantGnf);
      if (l.budget) { montants.add(l.budget.resteAvantGnf); montants.add(l.budget.resteApresGnf); }
    }
    const m = [...montants].filter((x) => x.length >= 6 && x !== "0");
    expect(m.length).toBeGreaterThan(4);
    for (const format of ["json", "csv"] as const) {
      const plein = await appel("GEST_NAT", "get", `/scenarios/${s.scenario.id}/export?format=${format}`);
      const sans = await appel("GEST_SANS_FINANCIER", "get", `/scenarios/${s.scenario.id}/export?format=${format}`);
      expect(sans.status, sans.text).toBe(200);
      for (const x of m) { expect(plein.text, `reference ${format} ${x}`).toContain(x); expect(sans.text, `${format} ${x}`).not.toContain(x); }
      expect(sans.text).toContain("NON ENGAGEANTE");
      expect(sans.text).toContain("Consultatif, non engageant");
    }
    const j = JSON.parse((await appel("GEST_SANS_FINANCIER", "get", `/scenarios/${s.scenario.id}/export?format=json`)).text);
    expect(j.droitFinancier).toBe(false);
    expect(j.champsFinanciersRetires.length).toBeGreaterThan(5);
    expect(j.lignes).toHaveLength(3);
  });

  it("DROIT FINANCIER : ADMIN, `marches` ou `chantiers` lisent les montants ; le retrait est AUDITE (droit et champs retires)", async () => {
    const s = await creer("GEST_NAT", { budgetGnf: "5000000000" });
    for (const c of ["ADMIN", "GEST_MARCHES", "GEST_CHANTIERS"]) {
      const r = await appel(c, "get", `/scenarios/${s.scenario.id}/export?format=csv`);
      expect(r.status).toBe(200);
      expect(r.text, c).toContain("Bilan;Déficit (GNF);3700000000");
    }
    h.audit = [];
    await appel("GEST_SANS_FINANCIER", "get", `/scenarios/${s.scenario.id}/export?format=json`);
    await appel("GEST_MARCHES", "get", `/scenarios/${s.scenario.id}/export?format=json`);
    expect(h.audit.map((a) => a.after.droitFinancier)).toEqual([false, true]);
    expect(h.audit[0].after.nbChampsRetires).toBeGreaterThan(5);
  });

  it("l'export n'est jamais conserve par un cache (Cache-Control: no-store)", async () => {
    const s = await creer("GEST_NAT");
    for (const format of ["csv", "json"]) {
      expect((await appel("GEST_NAT", "get", `/scenarios/${s.scenario.id}/export?format=${format}`)).headers["cache-control"]).toBe("no-store");
    }
  });

  it("l'audit d'export est transactionnel : sans trace, pas d'export", async () => {
    const s = await creer("GEST_NAT");
    const { logAuditTransactionnelle } = await import("../utils/audit");
    vi.mocked(logAuditTransactionnelle).mockRejectedValueOnce(new Error("audit indisponible"));
    const r = await appel("GEST_NAT", "get", `/scenarios/${s.scenario.id}/export?format=csv`);
    expect(r.status).toBe(500);
    expect(r.text).not.toContain("SIMULATION NON ENGAGEANTE");
  });
});
