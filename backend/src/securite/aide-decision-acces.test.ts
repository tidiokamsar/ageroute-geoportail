import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

/**
 * MATRICE D'ACCES DU MODULE AIDE A LA DECISION (lot AD-7, securite, droits, audit).
 *
 * CE QUE CE FICHIER PROUVE, ET CE QU'IL NE PROUVE PAS
 *
 * Il monte les VRAIS routeurs, le VRAI `requireAuth` (jeton signe, seul le resolveur de compte est injecte), les VRAIS
 * `requireRole` / `requireModuleAccess`, les VRAIES gardes territoriales et le VRAI `perimetreDe`. Seule la base est simulee
 * (un faux Prisma en memoire qui journalise les `where` et le SQL). Il prouve donc le CABLAGE : qui passe, qui est refuse,
 * quel filtre de region est transmis a la requete, quels champs sont masques. Il ne prouve pas que le SQL rend les bonnes
 * lignes : cela, c'est le banc `tests-integration/aide-decision-securite.integration.mts` (PostGIS reel).
 *
 * LES COMPTES (modules et regions posees par le test)
 *
 *   LECTEUR_VIDE      LECTEUR sans aucun module        LECTEUR_DECISION  LECTEUR decision + programmation + marches + dashboard
 *   LECTEUR_BAREMES   LECTEUR decision seul            LECTEUR_PROG      LECTEUR programmation seul
 *   LECTEUR_CHANTIERS LECTEUR chantiers seul           INSPECTEUR        INSPECTEUR, tous modules
 *   GEST_R1           GESTIONNAIRE rattache a la region 1, tous modules
 *   GEST_NATIONAL     GESTIONNAIRE sans rattachement   ADMIN             ADMIN
 */
vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://127.0.0.1:1/essai";
  process.env.JWT_ACCESS_SECRET = "essai-access-secret-essai-access-secret-0000";
  process.env.JWT_REFRESH_SECRET = "essai-refresh-secret-essai-refresh-secret-000";
  process.env.CORS_ORIGIN = "http://localhost:5173";
});

/* eslint-disable @typescript-eslint/no-explicit-any */
type L = Record<string, any>;
const w = vi.hoisted(() => ({
  modules: {} as Record<string, string[]>,
  perimetres: {} as Record<string, number[]>,
  ecritures: [] as { op: string; args: unknown }[],
  /** SQL brut : texte (fragments Prisma.sql developpes) et valeurs liees. */
  sql: [] as { texte: string; valeurs: unknown[] }[],
  wheres: {} as Record<string, any>,
  /** Region de chaque troncon / chantier connu de la base simulee. */
  troncons: {} as Record<string, number | null>,
  chantiers: {} as Record<string, number | null>,
}));

vi.mock("../lib/prisma", () => {
  const bareme = () => ({ id: 1, familleRevetement: "bitume", etatDepart: "MAUVAIS", typeIntervention: "REHAB", coutKmGnf: 1n, code: "B1", libelle: "l", source: "s", version: 1, approuveLe: new Date(), approuveParId: "x", anneeReference: 2026, largeurChausseeM: null, commentaire: null, approuvePar: null });
  const REGIONS = [{ id: 1, nom: "Region 1" }, { id: 2, nom: "Region 2" }];
  const aplatir = (v: unknown): { texte: string; valeurs: unknown[] } => {
    if (v && typeof v === "object" && "sql" in (v as L) && "values" in (v as L)) return { texte: String((v as L).sql), valeurs: [...((v as L).values as unknown[])] };
    return { texte: "?", valeurs: [v] };
  };
  const modele = (nom: string): L => new Proxy({}, {
    get: (_t, op: string) => async (args: L = {}) => {
      if (["create", "update", "delete", "upsert", "updateMany", "deleteMany", "createMany"].includes(op)) {
        w.ecritures.push({ op: `${nom}.${op}`, args });
        return nom === "baremeIntervention" ? { ...bareme(), ...(args.data ?? {}) } : { id: "x", ...(args.data ?? {}) };
      }
      w.wheres[`${nom}.${op}`] = args.where;
      if (nom === "user" && op === "findUnique") return { modulesAutorises: w.modules[args.where.id] ?? [] };
      if (nom === "troncon" && op === "findUnique") return args.where.id in w.troncons ? { regionId: w.troncons[args.where.id] } : null;
      if (nom === "chantier" && op === "findUnique") return args.where.id in w.chantiers ? { regionId: w.chantiers[args.where.id] } : null;
      if (nom === "chantier" && op === "findFirst") return args.where.id in w.chantiers ? { id: args.where.id, intitule: "Travaux", montantGnf: 5, bailleur: "AFD", entreprise: "SOGEA", numContrat: "N-1", regionId: w.chantiers[args.where.id] } : null;
      if (nom === "baremeIntervention" && (op === "findUnique" || op === "findFirst")) return bareme();
      if (nom === "baremeIntervention" && op === "findMany") return [bareme()];
      if (nom === "region" && op === "findMany") return REGIONS.filter((r) => !args.where?.id?.in || args.where.id.in.includes(r.id));
      if (nom === "chantier" && op === "findMany") return [{ id: "c1", intitule: "Travaux", montantGnf: 5, bailleur: "AFD", entreprise: "SOGEA", numContrat: "N-1", statut: "EN_COURS", region: { nom: "Region 1" }, troncon: null, observations: null }];
      if (op === "count") return 0;
      if (op === "aggregate") return { _sum: {}, _count: {} };
      if (op === "findMany" || op === "groupBy") return [];
      return null;
    },
  });
  const prisma: L = new Proxy({}, {
    get: (_t, nom: string) => {
      if (nom === "$queryRaw") return async (s: TemplateStringsArray, ...v: unknown[]) => {
        let texte = s[0]; const valeurs: unknown[] = [];
        v.forEach((x, i) => { const a = aplatir(x); texte += (a.texte === "?" ? "?" : a.texte) + s[i + 1]; valeurs.push(...a.valeurs); });
        w.sql.push({ texte, valeurs });
        if (texte.includes("perimetres_comptes")) return (w.perimetres[String(valeurs[0])] ?? []).map((regionId) => ({ regionId }));
        if (texte.includes("scenarios_programmation") && texte.includes("perimetre")) return [{ r: "2" }];
        if (texte.includes("plans_pluriannuels") && texte.includes("perimetre")) return [{ r: "2" }];
        if (texte.includes("ST_AsGeoJSON")) return [{ id: "c1", intitule: "Travaux", statut: "EN_COURS", avancementPct: 10, region: "Region 1", entreprise: "SOGEA", bailleur: "AFD", montantGnf: "5000000", numContrat: "N-1", observations: null, tronconId: null, pkDebut: null, pkFin: null, geometry: '{"type":"Point","coordinates":[0,0]}', ancreLat: null, ancreLon: null }];
        if (texte.includes("FROM chantiers c") && texte.includes("c.geom IS NULL")) return [{ id: "c2", intitule: "Sans position", statut: "PLANIFIE", entreprise: "SOGEA", region: null }];
        if (texte.includes("FROM chantiers")) return [{ annee: 2027, nb: 0n, montant: "0", enCours: 0n, termine: 0n, bailleur: "x" }];
        return [];
      };
      if (nom === "$queryRawUnsafe") return async (q: string) => { w.sql.push({ texte: q, valeurs: [] }); return []; };
      if (nom === "$executeRaw") return async () => 0;
      if (nom === "$transaction") return async (a: unknown) => (Array.isArray(a) ? Promise.all(a) : (a as (t: unknown) => Promise<unknown>)(prisma));
      return modele(nom);
    },
  });
  return { prisma };
});
vi.mock("../utils/audit", () => ({
  logAudit: vi.fn(), construireAudit: vi.fn(() => ({ __audit: true })),
  logAuditTransactionnelle: vi.fn(async (_tx: unknown, p: L) => { w.ecritures.push({ op: `AUDIT ${p.entityType} ${p.action}`, args: p }); }),
}));
vi.mock("../lib/excel", () => ({ buildExportBuffer: async () => Buffer.from("xlsx"), parseImportBuffer: async () => [], formatImportError: () => "" }));

import { _installerResolveurCompte } from "../middleware/auth.middleware";
import { signAccessToken } from "../utils/jwt";
import { errorHandler } from "../middleware/error.middleware";
import { programmationV2Router } from "../api-v2/programmation.routes";
import { moteurProgrammationV2Router } from "../api-v2/programmation.moteur.routes";
import { ppeProgrammationV2Router } from "../api-v2/programmation.ppe.routes";
import { baremesV2Router } from "../api-v2/baremes.routes";
import { fiche360V2Router } from "../api-v2/tableau-de-bord.routes";
import { marchesRouter } from "../modules/marches/marches.routes";
import { chantiersRouter } from "../modules/chantiers/chantiers.routes";
import { dashboardRouter } from "../modules/dashboard/dashboard.routes";
import { auditRouter } from "../modules/audit/audit.routes";

const app = express();
app.use(express.json());
app.use("/v2/programmation/moteur/ppe", ppeProgrammationV2Router);
app.use("/v2/programmation/moteur", moteurProgrammationV2Router);
app.use("/v2/programmation", programmationV2Router);
app.use("/v2/baremes", baremesV2Router);
app.use("/v2/fiche-360", fiche360V2Router);
app.use("/api/chantiers", chantiersRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/audit", auditRouter);
app.use("/api", marchesRouter);
app.use(errorHandler);

const TOUS = ["dashboard", "geoportail", "alertes", "rapports", "troncons", "ouvrages", "points-noirs", "postes", "chantiers", "programmation", "marches", "inspections", "documents", "decision", "ordres-travaux", "signalements"];
const COMPTES: Record<string, { id: string; role: string; modules: string[]; regions?: number[] }> = {
  LECTEUR_VIDE: { id: "u-lect-vide", role: "LECTEUR", modules: [] },
  LECTEUR_DECISION: { id: "u-lect-dec", role: "LECTEUR", modules: ["decision", "programmation", "marches", "dashboard", "rapports"] },
  LECTEUR_BAREMES: { id: "u-lect-bar", role: "LECTEUR", modules: ["decision"] },
  LECTEUR_PROG: { id: "u-lect-prog", role: "LECTEUR", modules: ["programmation"] },
  LECTEUR_CHANTIERS: { id: "u-lect-ch", role: "LECTEUR", modules: ["chantiers"] },
  LECTEUR_GEO: { id: "u-lect-geo", role: "LECTEUR", modules: ["geoportail", "troncons", "dashboard"] },
  INSPECTEUR: { id: "u-insp", role: "INSPECTEUR", modules: TOUS },
  GEST_R1: { id: "u-gest-r1", role: "GESTIONNAIRE", modules: TOUS, regions: [1] },
  GEST_NATIONAL: { id: "u-gest-nat", role: "GESTIONNAIRE", modules: TOUS },
  ADMIN: { id: "u-admin", role: "ADMIN", modules: [] },
};
const jeton = (c: string) => signAccessToken({ sub: COMPTES[c].id, role: COMPTES[c].role as never, email: `${c}@essai.invalid` });
const matrice: string[] = [];
let compteInactif = false;

beforeEach(() => {
  w.ecritures = []; w.sql = []; w.wheres = {};
  w.modules = {}; w.perimetres = {};
  w.troncons = { "t-r1": 1, "t-r2": 2 }; w.chantiers = { "ch-r1": 1, "ch-r2": 2 };
  compteInactif = false;
  for (const c of Object.values(COMPTES)) { w.modules[c.id] = c.modules; if (c.regions) w.perimetres[c.id] = c.regions; }
  _installerResolveurCompte(async (id) => {
    const c = Object.values(COMPTES).find((x) => x.id === id);
    if (!c) return null;
    return { actif: !(compteInactif && id === "u-gest-nat"), lockedUntil: null, role: c.role as never, email: `${id}@essai.invalid` };
  });
});
afterAll(() => { _installerResolveurCompte(null); if (process.env.MATRICE_SORTIE) console.log("MATRICE\n" + matrice.join("\n")); });

type Methode = "get" | "post" | "patch";
async function appel(compte: string | null, methode: Methode, url: string, corps?: object, entetes: Record<string, string> = {}) {
  let r = request(app)[methode](url);
  if (compte) r = r.set("Authorization", `Bearer ${jeton(compte)}`);
  for (const [k, v] of Object.entries(entetes)) r = r.set(k, v);
  const rep = await (corps ? r.send(corps) : r);
  matrice.push(`${(compte ?? "ANONYME").padEnd(17)} ${methode.toUpperCase().padEnd(5)} ${url.padEnd(62)} -> ${rep.status}`);
  return rep;
}
const sqlChantiers = () => w.sql.filter((q) => /FROM chantiers/.test(q.texte));

const ROUTES_AD: [Methode, string, object?][] = [
  ["get", "/v2/programmation"], ["get", "/v2/programmation/totaux"], ["post", "/v2/programmation", { annee: 2027, intitule: "xxx", montantPrevuGnf: "1" }],
  ["patch", "/v2/programmation/p1", { statut: "RETENU" }],
  ["get", "/v2/programmation/moteur/parametres"], ["post", "/v2/programmation/moteur/parametres", { version: "abc-1", valeurs: {} }],
  ["post", "/v2/programmation/moteur/parametres/p1/approuver"],
  ["post", "/v2/programmation/moteur/simulations", { annee: 2027, intitule: "xxx", budgetGnf: "1" }],
  ["post", "/v2/programmation/moteur/fiches/f1/statut", { vers: "APPROUVE" }],
  ["get", "/v2/baremes"], ["patch", "/v2/baremes/1", { libelle: "x" }], ["post", "/v2/baremes/1/approuver"],
  ["get", "/api/priorisation/scores"], ["get", "/api/dashboard/decision"], ["get", "/api/dashboard/programmation"],
  ["get", "/api/dashboard/programmation/lignes"], ["get", "/api/dashboard/rapport-regions"], ["get", "/api/dashboard/tendances"],
  ["get", "/api/chantiers/geo"], ["get", "/api/chantiers/export"], ["get", "/api/audit?entityType=ScenarioProgrammation&entityId=1"],
];

describe("1. ANONYME, JETON FORGE, COMPTE INACTIF : 401 partout, aucune ecriture, aucune lecture de donnees", () => {
  it.each(ROUTES_AD)("anonyme %s %s", async (m, u, c) => {
    const r = await appel(null, m, u, c);
    expect(r.status).toBe(401);
    expect(w.ecritures).toEqual([]);
  });

  it.each(ROUTES_AD)("jeton forge (signe avec une autre cle) %s %s", async (m, u, c) => {
    const forge = jwt.sign({ sub: COMPTES.ADMIN.id, role: "ADMIN", email: "forge@essai.invalid" }, "x".repeat(48), { expiresIn: "5m" });
    const r = await appel(null, m, u, c, { Authorization: `Bearer ${forge}` });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe("JETON_INVALIDE");
    expect(w.ecritures).toEqual([]);
  });

  it.each(ROUTES_AD)("compte desactive apres emission du jeton %s %s", async (m, u, c) => {
    compteInactif = true;
    const r = await appel("GEST_NATIONAL", m, u, c);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe("COMPTE_INACTIF");
    expect(w.ecritures).toEqual([]);
  });
});

describe("2. LECTEUR sans aucun module : refuse partout (403), sauf les lectures ouvertes decrites, qui sont MASQUEES (D-C1-1)", () => {
  it("modules decision / programmation / marches / rapports : 403, aucune ecriture", async () => {
    const fermees = ROUTES_AD.filter(([, u]) => !u.startsWith("/api/chantiers") && !u.startsWith("/api/audit"));
    for (const [m, u, c] of fermees) {
      expect((await appel("LECTEUR_VIDE", m, u, c)).status, `${m} ${u}`).toBe(403);
    }
    expect(w.ecritures).toEqual([]);
  });

  it("D-C1-1 (constat 4) : /api/chantiers/geo reste lisible sans module chantiers pour la carte, mais SANS champs financiers", async () => {
    const r = await appel("LECTEUR_VIDE", "get", "/api/chantiers/geo");
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0]).toMatchObject({ id: "c1", intitule: "Travaux", statut: "EN_COURS", avancementPct: 10, region: "Region 1" });
    expect(r.body[0].geometry).toBeTruthy();
    for (const champ of ["montantGnf", "bailleur", "numContrat", "entreprise"]) expect(r.body[0][champ], champ).toBeNull();
  });

  it("D-C1-1 : la liste, la liste sans localisation et l'export suivent la meme regle (champs masques, export refuse)", async () => {
    const liste = await appel("LECTEUR_VIDE", "get", "/api/chantiers");
    expect(liste.status).toBe(200);
    for (const champ of ["montantGnf", "bailleur", "numContrat", "entreprise"]) expect(liste.body.data[0][champ], champ).toBeNull();
    const sans = await appel("LECTEUR_VIDE", "get", "/api/chantiers/sans-localisation");
    expect(sans.status).toBe(200);
    expect(sans.body[0].entreprise).toBeNull();
    expect((await appel("LECTEUR_VIDE", "get", "/api/chantiers/export")).status).toBe(403);
  });

  it("un compte qui n'a que la carte et le patrimoine (geoportail, troncons, dashboard) est masque comme le compte sans module", async () => {
    const r = await appel("LECTEUR_GEO", "get", "/api/chantiers/geo");
    expect(r.status).toBe(200);
    expect(r.body[0].montantGnf).toBeNull();
  });

  // CONTRAT MODIFIE (D-C1-1, regle unique `droitMontantsContractuels`) : ce test donnait le droit aux modules `programmation` et `decision`
  // SEULS (LECTEUR_PROG, LECTEUR_BAREMES), alors que la synthese, le suivi contractuel et les exports n'exigeaient que `marches` : un compte
  // `decision` seul lisait entreprise et montant des chantiers. Le droit est maintenant ADMIN, `marches` ou `chantiers`.
  it("les comptes qui ONT le droit sur les montants contractuels (modules chantiers ou marches ; ADMIN) voient les montants", async () => {
    for (const c of ["LECTEUR_CHANTIERS", "LECTEUR_DECISION", "GEST_NATIONAL", "ADMIN"]) {
      const r = await appel(c, "get", "/api/chantiers/geo");
      expect(r.body[0].montantGnf, c).toBe("5000000");
      expect(r.body[0].bailleur, c).toBe("AFD");
    }
    expect((await appel("LECTEUR_CHANTIERS", "get", "/api/chantiers/export")).status).toBe(200);
  });

  it("les comptes `decision` seul ou `programmation` seul lisent le chantier mais PAS le montant, le bailleur, le contrat ni l'entreprise", async () => {
    for (const c of ["LECTEUR_BAREMES", "LECTEUR_PROG"]) {
      for (const u of ["/api/chantiers/geo", "/api/chantiers/sans-localisation", "/api/chantiers"]) {
        const r = await appel(c, "get", u);
        expect(r.status, `${c} ${u}`).toBe(200);
        const l = u === "/api/chantiers" ? r.body.data[0] : r.body[0];
        // La liste sans localisation ne porte pas toutes les cles : une cle absente n'est pas une fuite, une cle presente vaut null.
        for (const champ of ["montantGnf", "bailleur", "numContrat", "entreprise"]) expect(l[champ] ?? null, `${c} ${u} ${champ}`).toBeNull();
      }
    }
  });

  it("l'audit n'est lisible par aucun LECTEUR sans module (403)", async () => {
    expect((await appel("LECTEUR_VIDE", "get", "/api/audit?entityType=ScenarioProgrammation&entityId=1")).status).toBe(403);
  });
});

describe("3. LECTEUR avec decision + programmation + marches : lit, n'ecrit pas", () => {
  it("lectures 200, ecritures 403, aucune ecriture en base", async () => {
    expect((await appel("LECTEUR_DECISION", "get", "/v2/baremes")).status).toBe(200);
    expect((await appel("LECTEUR_DECISION", "get", "/v2/programmation/moteur/parametres")).status).toBe(200);
    expect((await appel("LECTEUR_DECISION", "patch", "/v2/baremes/1", { libelle: "x" })).status).toBe(403);
    expect((await appel("LECTEUR_DECISION", "post", "/v2/programmation/moteur/parametres", { version: "abc-1", valeurs: {} })).status).toBe(403);
    expect((await appel("LECTEUR_DECISION", "post", "/v2/programmation/moteur/parametres/p1/approuver")).status).toBe(403);
    expect((await appel("LECTEUR_DECISION", "post", "/v2/programmation/moteur/fiches/f1/statut", { vers: "APPROUVE" })).status).toBe(403);
    expect((await appel("LECTEUR_DECISION", "patch", "/v2/programmation/p1", { statut: "RETENU" })).status).toBe(403);
    expect(w.ecritures).toEqual([]);
  });

  it("un compte NATIONAL garde le comportement actuel sur les routes heritees : 200, aucun filtre de region", async () => {
    expect((await appel("LECTEUR_DECISION", "get", "/api/dashboard/decision")).status).toBe(200);
    expect(w.wheres["troncon.groupBy"]).toEqual({ deletedAt: null });
    for (const u of ["/api/dashboard/programmation", "/api/dashboard/programmation/lignes", "/api/dashboard/tendances", "/api/priorisation/scores"]) {
      expect((await appel("LECTEUR_DECISION", "get", u)).status, u).toBe(200);
    }
    // Aucun filtre « regionId IN (...) » : le compte national voit tout, comme avant.
    expect(JSON.stringify(w.wheres["chantier.findMany"] ?? {})).not.toMatch(/regionId/);
    expect(JSON.stringify(w.wheres["troncon.findMany"] ?? {})).not.toMatch(/regionId/);
    w.wheres = {};
    expect((await appel("LECTEUR_DECISION", "get", "/api/dashboard/rapport-regions")).status).toBe(200);
    expect(w.wheres["region.findMany"]).toBeUndefined();
  });
});

describe("4. LECTEUR a UN seul module : l'audit suit le module de l'entite (constat 2)", () => {
  const PROG = ["ParametresProgrammation", "ScenarioProgrammation", "FicheIntervention", "ProgrammeBudgetaire", "PlanPluriannuel"];

  it.each([...PROG, "BaremeIntervention"])("ADMIN lit l'audit de %s (200)", async (t) => {
    expect((await appel("ADMIN", "get", `/api/audit?entityType=${t}&entityId=1`)).status).toBe(200);
  });

  it.each(PROG)("module programmation : %s lisible ; module decision seul : refuse", async (t) => {
    expect((await appel("LECTEUR_PROG", "get", `/api/audit?entityType=${t}&entityId=1`)).status).toBe(200);
    expect((await appel("LECTEUR_BAREMES", "get", `/api/audit?entityType=${t}&entityId=1`)).status).toBe(403);
  });

  it("BaremeIntervention suit le module decision (celui de /v2/baremes) : decision lit, programmation seul refuse", async () => {
    expect((await appel("LECTEUR_BAREMES", "get", "/api/audit?entityType=BaremeIntervention&entityId=1")).status).toBe(200);
    expect((await appel("LECTEUR_PROG", "get", "/api/audit?entityType=BaremeIntervention&entityId=1")).status).toBe(403);
  });

  it("ExportScenario (journal de l'export d'un scenario) suit le module rapports, comme ExportJournal : rapports lit, programmation seul et decision seul refusent", async () => {
    expect((await appel("LECTEUR_DECISION", "get", "/api/audit?entityType=ExportScenario&entityId=1")).status).toBe(200); // a rapports
    expect((await appel("ADMIN", "get", "/api/audit?entityType=ExportScenario&entityId=1")).status).toBe(200);
    expect((await appel("LECTEUR_PROG", "get", "/api/audit?entityType=ExportScenario&entityId=1")).status).toBe(403);
    expect((await appel("LECTEUR_BAREMES", "get", "/api/audit?entityType=ExportScenario&entityId=1")).status).toBe(403);
    expect((await appel("LECTEUR_VIDE", "get", "/api/audit?entityType=ExportScenario&entityId=1")).status).toBe(403);
  });

  it("un type inconnu reste refuse pour tous, ADMIN compris (echec ferme)", async () => {
    expect((await appel("ADMIN", "get", "/api/audit?entityType=TypeInconnu&entityId=1")).status).toBe(403);
    expect((await appel("ADMIN", "get", "/api/audit?entityType=constructor&entityId=1")).status).toBe(403);
  });
});

describe("5. INSPECTEUR : pas d'ecriture de programmation ni de bareme", () => {
  it("403 sur les ecritures, 200 sur la lecture des previsions", async () => {
    expect((await appel("INSPECTEUR", "get", "/v2/programmation")).status).toBe(200);
    expect((await appel("INSPECTEUR", "post", "/v2/programmation", { annee: 2027, intitule: "xxx", montantPrevuGnf: "1" })).status).toBe(403);
    expect((await appel("INSPECTEUR", "patch", "/v2/programmation/p1", { statut: "RETENU" })).status).toBe(403);
    expect((await appel("INSPECTEUR", "patch", "/v2/baremes/1", { libelle: "x" })).status).toBe(403);
    expect((await appel("INSPECTEUR", "post", "/v2/programmation/moteur/simulations", { annee: 2027, intitule: "xxx", budgetGnf: "1" })).status).toBe(403);
    expect(w.ecritures).toEqual([]);
  });
});

describe("6. GESTIONNAIRE REGIONAL (region 1) : aucun total national (constat 3)", () => {
  const NATIONALES = ["/api/dashboard/decision", "/api/dashboard/programmation", "/api/dashboard/tendances"];

  it.each(NATIONALES)("%s : refuse (403 PERIMETRE_NATIONAL_REQUIS), aucune donnee nationale lue", async (u) => {
    const r = await appel("GEST_R1", "get", u);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("PERIMETRE_NATIONAL_REQUIS");
    expect(sqlChantiers().filter((q) => !/perimetres_comptes/.test(q.texte))).toEqual([]);
    expect(w.wheres["troncon.groupBy"]).toBeUndefined();
    expect(w.wheres["indicateurReseauHistorique.findMany"]).toBeUndefined();
  });

  it("/api/dashboard/programmation/lignes : filtre sur les regions du compte (chantiers de la region 1 seulement)", async () => {
    const r = await appel("GEST_R1", "get", "/api/dashboard/programmation/lignes");
    expect(r.status).toBe(200);
    expect(w.wheres["chantier.findMany"]).toMatchObject({ regionId: { in: [1] } });
    expect(w.wheres["chantier.count"]).toMatchObject({ regionId: { in: [1] } });
  });

  it("/api/dashboard/rapport-regions : seules les regions du compte sont interrogees", async () => {
    const r = await appel("GEST_R1", "get", "/api/dashboard/rapport-regions");
    expect(r.status).toBe(200);
    expect(w.wheres["region.findMany"]).toMatchObject({ id: { in: [1] } });
  });

  it("/api/priorisation/scores : la region du CLIENT ne remplace pas le perimetre, elle s'y ajoute", async () => {
    expect((await appel("GEST_R1", "get", "/api/priorisation/scores?region=Region%202")).status).toBe(200);
    expect(w.wheres["troncon.findMany"]).toMatchObject({ regionId: { in: [1] }, region: { nom: "Region 2" } });
  });

  it("/api/chantiers/geo, /sans-localisation, /export, liste et stats : filtre de region transmis", async () => {
    expect((await appel("GEST_R1", "get", "/api/chantiers/geo")).status).toBe(200);
    expect((await appel("GEST_R1", "get", "/api/chantiers/sans-localisation")).status).toBe(200);
    const sqlRegion = sqlChantiers().filter((q) => /regionId" IN/.test(q.texte) && q.valeurs.includes(1));
    expect(sqlRegion.length).toBeGreaterThanOrEqual(2);
    expect(sqlChantiers().some((q) => q.valeurs.includes(2))).toBe(false);
    expect((await appel("GEST_R1", "get", "/api/chantiers")).status).toBe(200);
    expect(w.wheres["chantier.findMany"]).toMatchObject({ regionId: { in: [1] } });
    expect((await appel("GEST_R1", "get", "/api/chantiers/stats")).status).toBe(200);
    expect(w.wheres["chantier.count"]).toMatchObject({ regionId: { in: [1] } });
    w.wheres = {};
    expect((await appel("GEST_R1", "get", "/api/chantiers/export")).status).toBe(200);
    expect(w.wheres["chantier.findMany"]).toMatchObject({ regionId: { in: [1] } });
  });

  it("un chantier d'une autre region est introuvable (404) comme un chantier inexistant", async () => {
    const autre = await appel("GEST_R1", "get", "/api/chantiers/ch-r2");
    const inconnu = await appel("GEST_R1", "get", "/api/chantiers/ch-inconnu");
    expect(autre.status).toBe(404);
    expect(inconnu.status).toBe(404);
    expect(autre.body).toEqual(inconnu.body);
    expect((await appel("GEST_R1", "get", "/api/chantiers/ch-r1")).status).toBe(200);
  });

  it("calcul national refuse (403) ; scenario d'une autre region introuvable (404) ; creation hors perimetre refusee", async () => {
    expect((await appel("GEST_R1", "post", "/v2/programmation/moteur/simulations", { annee: 2027, intitule: "xxx", budgetGnf: "1" })).status).toBe(403);
    expect((await appel("GEST_R1", "get", "/v2/programmation/moteur/simulations/s-r2")).status).toBe(404);
    expect((await appel("GEST_R1", "post", "/v2/programmation", { annee: 2027, intitule: "xxx", montantPrevuGnf: "1" })).status).toBe(403);
  });

  it("un compte regional ne lit l'audit que des modules qu'il a, comme avant (aucun filtre de region sur l'audit : limite documentee)", async () => {
    expect((await appel("GEST_R1", "get", "/api/audit?entityType=ScenarioProgrammation&entityId=1")).status).toBe(200);
  });
});

describe("7. fiche-360 : un troncon d'une autre region est INTROUVABLE, pas interdit (constat 6, oracle 403 / 404)", () => {
  it.each(["portions", "programmation", "constats"])("/troncons/:id/%s : hors perimetre = meme 404 et meme corps qu'un troncon inexistant", async (volet) => {
    const hors = await appel("GEST_R1", "get", `/v2/fiche-360/troncons/t-r2/${volet}`);
    const inconnu = await appel("GEST_R1", "get", `/v2/fiche-360/troncons/t-inexistant/${volet}`);
    expect(hors.status).toBe(404);
    expect(inconnu.status).toBe(404);
    expect(hors.body).toEqual(inconnu.body);
    expect(hors.body.code).toBe("INTROUVABLE");
  });
});

describe("8. ENTREES INVALIDES : 400 net, sans appel a la base (constat 6)", () => {
  it.each(["abc", "20x7", "99999999999", "-1", "2027.5"])("/api/dashboard/programmation/lignes?annee=%s", async (annee) => {
    const r = await appel("GEST_NATIONAL", "get", `/api/dashboard/programmation/lignes?annee=${annee}`);
    expect(r.status).toBe(400);
    expect(w.wheres["chantier.findMany"]).toBeUndefined();
  });

  it("annee valide acceptee", async () => {
    expect((await appel("GEST_NATIONAL", "get", "/api/dashboard/programmation/lignes?annee=2027")).status).toBe(200);
  });

  it.each([["periode_debut", "pas-une-date"], ["periode_fin", "2026-13-45"], ["periode_debut", "31/12/2026"]])("/api/dashboard/tendances?%s=%s", async (cle, valeur) => {
    const r = await appel("LECTEUR_DECISION", "get", `/api/dashboard/tendances?${cle}=${encodeURIComponent(valeur)}`);
    expect(r.status).toBe(400);
    expect(w.wheres["indicateurReseauHistorique.findMany"]).toBeUndefined();
  });

  it("periodes valides acceptees", async () => {
    expect((await appel("LECTEUR_DECISION", "get", "/api/dashboard/tendances?periode_debut=2026-01-01&periode_fin=2026-12-31")).status).toBe(200);
  });
});

describe("9. ADMIN et separation : les gardes de role restent, la regle d'auteur est testee dans les tests de route", () => {
  it("l'ADMIN passe les gardes d'approbation (404 : version inconnue dans la base simulee)", async () => {
    expect((await appel("ADMIN", "post", "/v2/programmation/moteur/parametres/p1/approuver")).status).toBe(404);
  });
  it("GESTIONNAIRE ne peut pas approuver des parametres ni un bareme (403)", async () => {
    expect((await appel("GEST_NATIONAL", "post", "/v2/programmation/moteur/parametres/p1/approuver")).status).toBe(403);
    expect((await appel("GEST_NATIONAL", "post", "/v2/baremes/1/approuver")).status).toBe(403);
  });
});
