import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHash } from "node:crypto";

/**
 * `/api/v2/aide-decision` : barèmes, rapport par région, exports gouvernés et journal (lot 6).
 *
 * Monte le VRAI routeur, le VRAI `requireAuth` (jeton signé, compte relu par un résolveur injecté), le VRAI `requireRole`, le
 * VRAI `requireModuleAccess`, le VRAI `perimetreDe` et le VRAI service d'export ; seuls la base (modules, rattachements,
 * régions, journal, barèmes) et les FOURNISSEURS de données sont simulés. Le fournisseur factice rend volontairement des
 * lignes de TOUTES les régions : ce que la route garantit, c'est la portée qu'elle lui donne et le 404 d'un scénario hors
 * périmètre ; que le SQL ne ramène que la région du compte, c'est le banc PostGIS (`aide-decision-baremes-exports`).
 */
vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://127.0.0.1:1/essai";
  process.env.JWT_ACCESS_SECRET = "essai-access-secret-essai-access-secret-0000";
  process.env.JWT_REFRESH_SECRET = "essai-refresh-secret-essai-refresh-secret-000";
  process.env.CORS_ORIGIN = "http://localhost:5173";
});

const w = vi.hoisted(() => ({
  comptes: {} as Record<string, { role: string; modules: string[]; regions: number[]; actif: boolean; email: string }>,
  scenarios: {} as Record<string, number | null>,
  journal: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  journalEchoue: false,
  appels: [] as Array<{ type: string; regions: readonly number[] | null; filtres: unknown; droits: unknown; scenarioId?: string }>,
}));

vi.mock("../lib/prisma", () => {
  const regionsConnues = [{ id: 1, nom: "Conakry" }, { id: 2, nom: "Kindia" }, { id: 3, nom: "Labe" }];
  const tx = {
    exportJournal: { create: async ({ data }: { data: Record<string, unknown> }) => { if (w.journalEchoue) throw new Error("journal en panne"); w.journal.push({ ...data, creeLe: new Date("2026-10-29T10:00:00Z") }); } },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { w.audits.push(data); } },
  };
  return {
    prisma: {
      user: { findUnique: async ({ where }: { where: { id: string } }) => { const c = w.comptes[where.id]; return c ? { modulesAutorises: c.modules } : null; } },
      region: { findMany: async ({ where }: { where: { id: { in: number[] } } }) => regionsConnues.filter((r) => where.id.in.includes(r.id)) },
      exportJournal: {
        count: async ({ where }: { where: { auteurId?: string } }) => w.journal.filter((j) => !where.auteurId || j.auteurId === where.auteurId).length,
        findMany: async ({ where, take, skip }: { where: { auteurId?: string }; take: number; skip: number }) =>
          w.journal.filter((j) => !where.auteurId || j.auteurId === where.auteurId).slice(skip, skip + take),
      },
      baremeIntervention: {
        findMany: async () => [{
          id: 3, familleRevetement: "bitume", etatDepart: "CRITIQUE", typeIntervention: "reconstruction", coutKmGnf: 3_500_000_000n, code: null, libelle: null,
          source: "standard_initial", version: 1, approuveLe: null, approuveParId: null, anneeReference: null, largeurChausseeM: null, commentaire: null,
          uniteCout: "KM", devise: "GNF", actif: true, validDe: null, validA: null, approuvePar: null,
        }],
        findUnique: async ({ where }: { where: { id: number } }) => (where.id === 3 ? {
          id: 3, familleRevetement: "bitume", etatDepart: "CRITIQUE", typeIntervention: "reconstruction", coutKmGnf: 3_500_000_000n, code: null, libelle: null,
          source: "standard_initial", version: 1, approuveLe: null, approuveParId: null, anneeReference: null, largeurChausseeM: null, commentaire: null,
          uniteCout: "KM", devise: "GNF", actif: true, validDe: null, validA: null, approuvePar: null,
        } : null),
      },
      baremeHistorique: { findMany: async () => [] },
      $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      $queryRaw: async (premier: unknown, ...reste: unknown[]) => {
        const texte = Array.isArray(premier) ? (premier as string[]).join("?") : String(premier);
        if (texte.includes("perimetres_comptes")) return (w.comptes[String(reste[0])]?.regions ?? []).map((regionId) => ({ regionId }));
        if (texte.includes("scenarios_programmation")) {
          const id = String(reste[0]);
          return id in w.scenarios ? [{ r: w.scenarios[id] === null ? null : String(w.scenarios[id]) }] : [];
        }
        throw new Error(`requete inattendue : ${texte}`);
      },
    },
  };
});

// Les fournisseurs reels (synthese, scenarios) lisent la base : ils ne sont pas charges ici.
vi.mock("../aide-decision/export.fournisseurs", () => ({ fournisseursReels: {} }));
vi.mock("../aide-decision/synthese", () => ({ depotPrisma: () => ({ etat: async () => [], nomsRegions: async () => new Map() }) }));

import { _installerResolveurCompte } from "../middleware/auth.middleware";
import { errorHandler } from "../middleware/error.middleware";
import { signAccessToken } from "../utils/jwt";
import { creerRouteurExports } from "./aide-decision.exports.routes";
import type { Fournisseurs, ProduitExport } from "../aide-decision/export.service";

const ID = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const U = { admin: ID(901), nat: ID(902), lecteur: ID(903), r1: ID(904), r2: ID(905), sansRapports: ID(906), sansProg: ID(907), sansMarches: ID(908), avecChantiers: ID(911), inactif: ID(909), autreNat: ID(910) };
const SC = { r1: ID(51), nat: ID(52), r2: ID(53), absent: ID(99) };
const BASE = "/api/v2/aide-decision";
const TOUS = ["rapports", "decision", "programmation", "marches"];

const produit = (): ProduitExport => ({
  jeu: {
    colonnes: [{ cle: "region", libelle: "Region", unite: null }, { cle: "cout_estime_gnf", libelle: "Cout", unite: "GNF", financier: true }],
    lignes: [{ region: "Conakry", cout_estime_gnf: "1000" }, { region: "Kindia", cout_estime_gnf: "2000" }, { region: "Labe", cout_estime_gnf: "3000" }],
  },
  sources: [{ code: "src", libelle: "Source de test", dateReference: "2026-10-01" }], definitions: [], avertissements: [],
});
const enregistrer = (type: string) => async (ctx: { portee: { regions: readonly number[] | null }; droits: unknown }, filtres: unknown, scenarioId?: string): Promise<ProduitExport> => {
  w.appels.push({ type, regions: ctx.portee.regions, filtres, droits: ctx.droits, scenarioId });
  return produit();
};
const fournisseurs: Fournisseurs = {
  synthese: enregistrer("synthese") as Fournisseurs["synthese"],
  reseauRegions: enregistrer("reseau_regions") as Fournisseurs["reseauRegions"],
  interventions: enregistrer("interventions") as Fournisseurs["interventions"],
  scenario: enregistrer("scenario") as Fournisseurs["scenario"],
};

function app() {
  const a = express();
  a.use(express.json());
  a.use(BASE, creerRouteurExports({ fournisseurs, maintenant: () => new Date("2026-10-29T10:00:00.000Z"), nouvelId: () => "22222222-2222-4222-8222-222222222222" }));
  a.use(errorHandler);
  return a;
}
const jeton = (id: string) => signAccessToken({ sub: id, role: (w.comptes[id]?.role ?? "LECTEUR") as never, email: "x@ageroute.invalid" });
const auth = (r: request.Test, id: string | null) => (id ? r.set("Authorization", `Bearer ${jeton(id)}`) : r);
const exporter = (id: string | null, corps: unknown) => auth(request(app()).post(`${BASE}/exports`), id).send(corps as object);
const journal = (id: string | null, q = "") => auth(request(app()).get(`${BASE}/exports${q}`), id);

beforeEach(() => {
  w.comptes = {
    [U.admin]: { role: "ADMIN", modules: [], regions: [], actif: true, email: "ad@x.invalid" },
    [U.nat]: { role: "GESTIONNAIRE", modules: TOUS, regions: [], actif: true, email: "n@x.invalid" },
    [U.autreNat]: { role: "GESTIONNAIRE", modules: TOUS, regions: [], actif: true, email: "n2@x.invalid" },
    [U.lecteur]: { role: "LECTEUR", modules: TOUS, regions: [], actif: true, email: "l@x.invalid" },
    [U.r1]: { role: "GESTIONNAIRE", modules: TOUS, regions: [1], actif: true, email: "r1@x.invalid" },
    [U.r2]: { role: "GESTIONNAIRE", modules: TOUS, regions: [2], actif: true, email: "r2@x.invalid" },
    [U.sansRapports]: { role: "GESTIONNAIRE", modules: ["decision", "programmation"], regions: [], actif: true, email: "sr@x.invalid" },
    [U.sansProg]: { role: "GESTIONNAIRE", modules: ["rapports", "decision"], regions: [], actif: true, email: "sp@x.invalid" },
    [U.sansMarches]: { role: "GESTIONNAIRE", modules: ["rapports", "decision", "programmation"], regions: [], actif: true, email: "sm@x.invalid" },
    [U.avecChantiers]: { role: "GESTIONNAIRE", modules: ["rapports", "decision", "programmation", "chantiers"], regions: [], actif: true, email: "ch@x.invalid" },
    [U.inactif]: { role: "GESTIONNAIRE", modules: TOUS, regions: [], actif: false, email: "in@x.invalid" },
  };
  w.scenarios = { [SC.r1]: 1, [SC.nat]: null, [SC.r2]: 2 };
  w.journal = []; w.audits = []; w.appels = []; w.journalEchoue = false;
  _installerResolveurCompte(async (userId) => {
    const c = w.comptes[userId];
    return c ? { actif: c.actif, lockedUntil: null, role: c.role as never, email: c.email } : null;
  });
});

describe("matrice d'accès à l'export", () => {
  const corps = { type: "reseau_regions", format: "csv" };
  it("anonyme : 401, aucun fournisseur appelé", async () => {
    expect((await exporter(null, corps)).status).toBe(401);
    expect(w.appels).toHaveLength(0);
  });
  it("compte inactif : 401", async () => {
    expect((await exporter(U.inactif, corps)).status).toBe(401);
  });
  it("LECTEUR (même avec le module rapports) : 403, pas d'export", async () => {
    expect((await exporter(U.lecteur, corps)).status).toBe(403);
    expect(w.appels).toHaveLength(0);
  });
  it("GESTIONNAIRE sans le module rapports : 403", async () => {
    expect((await exporter(U.sansRapports, corps)).status).toBe(403);
    expect(w.appels).toHaveLength(0);
  });
  it("GESTIONNAIRE avec le module rapports et ADMIN : 200", async () => {
    expect((await exporter(U.nat, corps)).status).toBe(200);
    expect((await exporter(U.admin, corps)).status).toBe(200);
  });
  it("interventions et scénario exigent AUSSI le module programmation (l'export ne contourne pas le module d'origine)", async () => {
    const r = await exporter(U.sansProg, { type: "interventions", format: "csv", scenarioId: SC.nat });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("MODULE_NON_AUTORISE");
    expect(w.appels).toHaveLength(0);
  });
  it("le journal est refusé au LECTEUR et à l'anonyme", async () => {
    expect((await journal(null)).status).toBe(401);
    expect((await journal(U.lecteur)).status).toBe(403);
  });
});

describe("validation du corps (400)", () => {
  it.each([
    [{}], [{ type: "tout", format: "csv" }], [{ type: "synthese", format: "pdf" }], [{ type: "synthese", format: "csv", sql: "1=1" }],
    [{ type: "synthese", format: "csv", filtres: { regionId: -1 } }], [{ type: "synthese", format: "csv", filtres: { regionId: "1" } }],
    [{ type: "synthese", format: "csv", filtres: { classe: ["XX"] } }], [{ type: "synthese", format: "csv", filtres: { etat: [] } }],
    [{ type: "synthese", format: "csv", filtres: { depuis: "2026-02-30" } }], [{ type: "synthese", format: "csv", filtres: { depuis: "2026-05-02", jusqua: "2026-05-01" } }],
    [{ type: "synthese", format: "csv", filtres: { inconnu: 1 } }], [{ type: "scenario", format: "csv", scenarioId: "pas-un-uuid" }],
  ])("refuse %j", async (corps) => {
    const r = await exporter(U.nat, corps);
    expect(r.status).toBe(400);
    expect(w.appels).toHaveLength(0);
    expect(w.journal).toHaveLength(0);
  });
  it("interventions sans scenarioId : 400 SCENARIO_REQUIS", async () => {
    const r = await exporter(U.nat, { type: "interventions", format: "csv" });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("SCENARIO_REQUIS");
  });
});

describe("périmètre territorial (le serveur décide, pas la requête)", () => {
  it("compte NATIONAL sans filtre : portée = pays entier", async () => {
    await exporter(U.nat, { type: "reseau_regions", format: "csv" });
    expect(w.appels[0].regions).toBeNull();
  });
  it("MUTATION DE CONTROLE : compte REGIONAL sans filtre : portée = SES régions, jamais le pays", async () => {
    const r = await exporter(U.r1, { type: "reseau_regions", format: "csv" });
    expect(r.status).toBe(200);
    expect(w.appels[0].regions).toEqual([1]);
    expect(r.text).toContain("# perimetre;Regions du compte : Conakry");
    expect(w.journal[0].perimetre).toMatchObject({ national: false, regionIds: [1] });
  });
  it("compte régional demandant une AUTRE région : 403 HORS_PERIMETRE, rien n'est calculé ni journalisé", async () => {
    const r = await exporter(U.r1, { type: "reseau_regions", format: "csv", filtres: { regionId: 2 } });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("HORS_PERIMETRE");
    expect(w.appels).toHaveLength(0);
    expect(w.journal).toHaveLength(0);
  });
  it("compte régional demandant sa région : portée réduite à elle", async () => {
    const r = await exporter(U.r1, { type: "synthese", format: "json", filtres: { regionId: 1 } });
    expect(r.status).toBe(200);
    expect(w.appels[0].regions).toEqual([1]);
    expect(JSON.parse(r.text).metadonnees.perimetre.libelle).toBe("Region Conakry");
  });
  it("national avec un filtre de région : portée réduite à cette région ; région inexistante : 404", async () => {
    await exporter(U.nat, { type: "synthese", format: "csv", filtres: { regionId: 3 } });
    expect(w.appels[0].regions).toEqual([3]);
    const r = await exporter(U.nat, { type: "synthese", format: "csv", filtres: { regionId: 77 } });
    expect(r.status).toBe(404);
  });
  it("scénario d'une autre région, national ou inexistant : le MÊME 404 pour un compte régional", async () => {
    const corps = (id: string) => ({ type: "scenario", format: "csv", scenarioId: id });
    const hors = await exporter(U.r1, corps(SC.r2));
    const national = await exporter(U.r1, corps(SC.nat));
    const absent = await exporter(U.r1, corps(SC.absent));
    expect([hors.status, national.status, absent.status]).toEqual([404, 404, 404]);
    expect(hors.body).toEqual(absent.body);
    expect(national.body).toEqual(absent.body);
    expect(w.appels).toHaveLength(0);
    expect((await exporter(U.r1, corps(SC.r1))).status).toBe(200);
    expect((await exporter(U.nat, corps(SC.r2))).status).toBe(200);
  });
});

describe("droit financier transmis au service", () => {
  it("sans le module marches : les colonnes financières sont retirées du fichier remis", async () => {
    const r = await exporter(U.sansMarches, { type: "scenario", format: "csv", scenarioId: SC.nat });
    expect(r.status).toBe(200);
    const tableau = r.text.split("\n\n")[1];
    expect(tableau).not.toContain("cout_estime_gnf");
    expect(tableau).not.toContain("2000");
    expect(r.text).toContain("# colonnes_financieres_retirees;cout_estime_gnf");
    expect(w.journal[0]).toMatchObject({ droitFinancier: false, colonnesRetirees: ["cout_estime_gnf"] });
  });
  it("REGLE UNIQUE (droitMontantsContractuels) : le module chantiers vaut droit, comme marches ; decision + programmation + rapports non", async () => {
    const r = await exporter(U.avecChantiers, { type: "scenario", format: "csv", scenarioId: SC.nat });
    expect(r.status).toBe(200);
    expect(r.text).toContain("2000");
    expect(w.journal[0].droitFinancier).toBe(true);
    expect(w.appels[0].droits).toMatchObject({ financier: true, marches: true });
    w.journal = []; w.appels = [];
    await exporter(U.sansMarches, { type: "scenario", format: "csv", scenarioId: SC.nat });
    expect(w.appels[0].droits).toMatchObject({ financier: false, marches: false, programmation: true });
  });
  it("avec le module marches : colonnes présentes", async () => {
    const r = await exporter(U.nat, { type: "scenario", format: "csv", scenarioId: SC.nat });
    expect(r.text).toContain("cout_estime_gnf");
    expect(r.text).toContain("2000");
    expect(w.journal[0].droitFinancier).toBe(true);
  });
});

describe("fichier, journal et audit", () => {
  it("CSV : en-tête (filtres, date, auteur, mention), pièce jointe, empreinte et journal rapprochables du fichier", async () => {
    const r = await exporter(U.nat, { type: "reseau_regions", format: "csv", filtres: { classe: ["RN"], depuis: "2026-01-01" } });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("text/csv");
    expect(r.headers["content-disposition"]).toContain("attachment");
    expect(r.text).toContain("# genere_le;2026-10-29T10:00:00.000Z");
    expect(r.text).toContain("# filtres_appliques;classe=RN");
    expect(r.text).toContain("# filtre_non_applique;depuis");
    expect(r.text).toContain("# mention;Consultatif, non engageant");
    const empreinte = createHash("sha256").update(Buffer.from(r.text, "utf8")).digest("hex");
    expect(r.headers["x-export-empreinte-sha256"]).toBe(empreinte);
    expect(w.journal).toHaveLength(1);
    expect(w.journal[0]).toMatchObject({ id: "22222222-2222-4222-8222-222222222222", type: "reseau_regions", format: "csv", auteurId: U.nat, nbLignes: 3, empreinteSha256: empreinte });
    expect(w.audits).toHaveLength(1);
    expect(w.audits[0]).toMatchObject({ entityType: "ExportJournal", action: "CREATE" });
  });
  it("JSON : métadonnées complètes", async () => {
    const r = await exporter(U.nat, { type: "synthese", format: "json" });
    const j = JSON.parse(r.text);
    expect(r.headers["content-type"]).toContain("application/json");
    expect(j.metadonnees).toMatchObject({ type: "synthese", genereLe: "2026-10-29T10:00:00.000Z", nbLignes: 3 });
    expect(j.metadonnees.filtresNonAppliques.length).toBeGreaterThan(0);
  });
  it("si le journal ne s'écrit pas, AUCUN fichier ne part (500)", async () => {
    w.journalEchoue = true;
    const r = await exporter(U.nat, { type: "reseau_regions", format: "csv" });
    expect(r.status).toBe(500);
    expect(r.text).not.toContain("Conakry");
  });
  it("plafond : un jeu trop gros est refusé en 413, sans journal", async () => {
    const gros = fournisseurs.reseauRegions;
    (fournisseurs as { reseauRegions: Fournisseurs["reseauRegions"] }).reseauRegions = async () => ({ ...produit(), jeu: { colonnes: [{ cle: "a", libelle: "a", unite: null }], lignes: Array.from({ length: 10_001 }, () => ({ a: 1 })) } });
    try {
      const r = await exporter(U.nat, { type: "reseau_regions", format: "csv" });
      expect(r.status).toBe(413);
      expect(r.body.code).toBe("EXPORT_TROP_VOLUMINEUX");
      expect(w.journal).toHaveLength(0);
    } finally {
      (fournisseurs as { reseauRegions: Fournisseurs["reseauRegions"] }).reseauRegions = gros;
    }
  });
});

describe("journal des exports", () => {
  it("ADMIN voit tout ; un gestionnaire ne voit que ses propres exports", async () => {
    await exporter(U.nat, { type: "reseau_regions", format: "csv" });
    await exporter(U.autreNat, { type: "synthese", format: "json" });
    const admin = await journal(U.admin);
    const nat = await journal(U.nat);
    expect(admin.body.total).toBe(2);
    expect(nat.body.total).toBe(1);
    expect(nat.body.data[0].auteur.email).toBe("n@x.invalid");
    expect(nat.body.data[0]).toHaveProperty("empreinteSha256");
    expect(nat.body.data[0]).toHaveProperty("filtres");
  });
  it("paramètres invalides : 400", async () => {
    expect((await journal(U.admin, "?limite=0")).status).toBe(400);
    expect((await journal(U.admin, "?limite=1000")).status).toBe(400);
    expect((await journal(U.admin, "?inconnu=1")).status).toBe(400);
  });
});

describe("barèmes (lecture, module decision)", () => {
  it("rend les lignes avec devise, unité et statut ; 404 pour une ligne inconnue", async () => {
    const r = await auth(request(app()).get(`${BASE}/baremes`), U.nat);
    expect(r.status).toBe(200);
    expect(r.body.data[0]).toMatchObject({ devise: "GNF", uniteCout: "KM", statutApprobation: "NON_APPROUVE", coutKmGnf: "3500000000" });
    expect((await auth(request(app()).get(`${BASE}/baremes/3/historique`), U.nat)).status).toBe(200);
    expect((await auth(request(app()).get(`${BASE}/baremes/99/historique`), U.nat)).status).toBe(404);
    expect((await auth(request(app()).get(`${BASE}/baremes`), null)).status).toBe(401);
  });
  it("identifiant de ligne hors de l'entier 32 bits : 400 propre (jamais 500), mal forme : 404, borne haute valide : 404 (inconnue)", async () => {
    for (const id of ["2147483648", "9007199254740993"]) {
      const r = await auth(request(app()).get(`${BASE}/baremes/${id}/historique`), U.nat);
      expect([r.status, r.body.code]).toEqual([400, "ID_HORS_PLAGE"]);
    }
    expect((await auth(request(app()).get(`${BASE}/baremes/2147483647/historique`), U.nat)).status).toBe(404);
    expect((await auth(request(app()).get(`${BASE}/baremes/abc/historique`), U.nat)).status).toBe(404);
  });
  it("sans le module decision : 403", async () => {
    w.comptes[U.sansRapports].modules = ["rapports"];
    expect((await auth(request(app()).get(`${BASE}/baremes`), U.sansRapports)).status).toBe(403);
  });
});
