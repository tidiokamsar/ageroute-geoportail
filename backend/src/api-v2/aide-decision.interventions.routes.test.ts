import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `/api/v2/aide-decision` : interventions priorisees et parametres de priorite. Ce que ces tests defendent :
 *
 *   - les VRAIS gardes (jeton signe, `requireAuth`, `requireModuleAccess("decision")`, `requireRole`, gardes territoriales) :
 *     matrice anonyme / sans module / lecteur / gestionnaire / administrateur / compte regional, sur CHAQUE route ;
 *   - l'ORACLE D'EXISTENCE est ferme : un troncon d'une autre region, un identifiant inconnu, un troncon supprime et un
 *     identifiant mal forme repondent le MEME 404 (meme corps) ; un compte regional ne recoit jamais un total national ;
 *   - toute entree hostile repond 400 (jamais 500) ; aucune requete de lecture n'ecrit quoi que ce soit ;
 *   - la pagination par curseur ne perd ni ne double aucune ligne ; le GeoJSON annonce `tronque` et `total` ;
 *     une intervention sans geometrie exploitable reste dans la liste (localisation invalide) et n'est pas sur la carte ;
 *   - les ecritures de parametres sont auditees avec l'auteur de la SESSION (jamais du corps).
 *
 * LA BASE EST SIMULEE (depots en memoire) : le SQL reel (filtres, points noirs, geometrie, instantane) est eprouve par
 * `tests-integration/aide-decision-priorites.integration.mts`. Le noyau et le service sont, eux, les vrais.
 */
vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://127.0.0.1:1/essai";
  process.env.JWT_ACCESS_SECRET = "essai-access-secret-essai-access-secret-0000";
  process.env.JWT_REFRESH_SECRET = "essai-refresh-secret-essai-refresh-secret-000";
  process.env.CORS_ORIGIN = "http://localhost:5173";
});

type L = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const w = vi.hoisted(() => ({
  modules: {} as Record<string, string[]>,
  perimetres: {} as Record<string, number[]>,
  /** Region de chaque troncon connu de la base (y compris ceux qui ne sont pas candidats). */
  troncons: {} as Record<string, number | null>,
  faits: [] as L[],
  dansBbox: new Set<string>(),
  parametres: [] as L[],
  fiches: [] as L[],
  statuts: [] as L[],
  appelsFaits: [] as L[],
  ecritures: [] as string[],
  audit: [] as { action: string; entityType: string; entityId?: string; userId: string | null; before?: L; after?: L }[],
}));

vi.mock("../lib/prisma", () => {
  const prisma: L = {
    $queryRaw: async () => [],
    $executeRaw: async () => { w.ecritures.push("executeRaw"); return 0; },
    $transaction: async (arg: unknown) => (arg as (tx: unknown) => Promise<unknown>)(prisma),
    user: { findUnique: async ({ where }: L) => ({ modulesAutorises: w.modules[where.id] ?? [] }) },
    troncon: { findUnique: async ({ where }: L) => (where.id in w.troncons ? { regionId: w.troncons[where.id] } : null) },
  };
  return { prisma };
});
vi.mock("../utils/audit", () => ({
  logAudit: vi.fn(), construireAudit: vi.fn(() => ({ __audit: true })),
  logAuditTransactionnelle: vi.fn(async (_tx: unknown, p: L) => { w.audit.push(p as never); }),
}));
vi.mock("../lib/reseau", () => ({ fragmentPerimetre: () => ({}) }));
vi.mock("../territoire/territoire.service", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  perimetreDe: async (u: { id: string; role: string }) => (u.role !== "ADMIN" && w.perimetres[u.id] ? { national: false, regions: new Set(w.perimetres[u.id]) } : { national: true }),
}));

vi.mock("../programmation/moteur.depot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../programmation/moteur.depot")>();
  const fx = await import("../programmation/scenario.fixtures");
  const clone = <T,>(x: T): T => structuredClone(x);
  return {
    ...actual,
    listerParametres: async () => w.parametres.filter((p) => !p.deletedAt).map(clone),
    lireParametresParId: async (_db: unknown, id: string) => { const p = w.parametres.find((x) => x.id === id && !x.deletedAt); return p ? clone(p) : null; },
    insererParametres: async (_db: unknown, p: L) => {
      if (w.parametres.some((x) => x.version === p.version)) throw Object.assign(new Error("duplicate key value violates unique constraint"), { meta: { code: "23505" } });
      const l = { id: p.id, version: p.version, source: "saisie", valeurs: JSON.parse(p.valeursJson), motif: p.motif, creeParId: p.creeParId, createdAt: new Date("2026-10-27T08:00:00Z"), approuveeLe: null, approuveeParId: null, deletedAt: null };
      w.parametres.push(l);
      w.ecritures.push("parametres.insert");
      return clone(l);
    },
    poserApprobation: async (_db: unknown, id: string, qui: string | null) => {
      const p = w.parametres.find((x) => x.id === id);
      if (!p) return null;
      p.approuveeLe = qui ? new Date("2026-10-27T09:00:00Z") : null; p.approuveeParId = qui;
      w.ecritures.push("parametres.approbation");
      return clone(p);
    },
    chargerBaremes: async () => fx.BAREMES,
    chargerCatalogue: async () => fx.CATALOGUE,
    chargerConditions: async () => fx.CONDITIONS,
    chargerMatrices: async () => fx.MATRICES,
  };
});

vi.mock("../programmation/priorite.depot", () => ({
  chargerFaits: async (_db: unknown, f: L) => {
    w.appelsFaits.push(f);
    const faits = w.faits
      .filter((x) => f.regions === null || (x.regionId !== null && f.regions.includes(x.regionId)))
      .filter((x) => f.regionId === undefined || x.regionId === f.regionId)
      .filter((x) => !f.classe || f.classe.includes(x.classe))
      .filter((x) => !f.etat || f.etat.includes(x.etat));
    return { faits: structuredClone(faits), dansBbox: new Set(faits.filter((x) => w.dansBbox.has(x.id)).map((x) => x.id)) };
  },
  chargerValiditesBaremes: async () => ({}),
  chargerGeometries: async (_db: unknown, ids: string[]) => new Map(ids.map((id) => [id, { type: "LineString", coordinates: [[-13.6, 9.6], [-13.5, 9.7]] }])),
  fichesDuTroncon: async (_db: unknown, id: string) => {
    const fiches = w.fiches.filter((f) => f.tronconId === id);
    return { fiches, statuts: w.statuts.filter((s) => fiches.some((f) => f.id === s.ficheId)) };
  },
}));

import { _installerResolveurCompte } from "../middleware/auth.middleware";
import { signAccessToken } from "../utils/jwt";
import { errorHandler } from "../middleware/error.middleware";
import { aideDecisionInterventionsRouter } from "./aide-decision.interventions.routes";
import { VALEURS_AMORCAGE_PROVISOIRES } from "../programmation/parametres.noyau";

const app = express();
app.use(express.json());
app.use("/api/v2/aide-decision", aideDecisionInterventionsRouter);
app.use(errorHandler);

const COMPTES: Record<string, { id: string; role: string; modules: string[]; regions?: number[] }> = {
  SANS_MODULE: { id: "u-sans", role: "LECTEUR", modules: ["dashboard", "programmation"] },
  LECTEUR: { id: "u-lect", role: "LECTEUR", modules: ["decision"] },
  GESTIONNAIRE: { id: "u-gest", role: "GESTIONNAIRE", modules: ["decision"] },
  INSPECTEUR: { id: "u-insp", role: "INSPECTEUR", modules: ["decision"] },
  GEST_R1: { id: "u-gest-r1", role: "GESTIONNAIRE", modules: ["decision"], regions: [1] },
  ADMIN: { id: "u-admin", role: "ADMIN", modules: [] },
};
const jeton = (c: string) => signAccessToken({ sub: COMPTES[c].id, role: COMPTES[c].role as never, email: `${c}@essai.invalid` });

function fait(id: string, o: L = {}): L {
  return {
    id, code: o.code ?? `RN-${id}`, nom: `Troncon ${id}`, regionId: 1, regionNom: "Region 1", classe: "RN", revetement: "BITUME", prefecture: null,
    etat: "MAUVAIS", traficMoyenJma: 2500, traficDateComptage: "2025-03-01", criticiteStrategique: null,
    pointsNoirs: { confirmes: 1, nonConfirmes: 0, registreRegion: 10 }, constats: [], dateDerniereEvaluation: null,
    longueurKm: 2, longueurMetierDerivee: false, longueurGeometriqueM: 2000,
    localisation: { valide: true, motif: null }, qualiteEtat: null, sourceTroncon: { type: null, confiance: null },
    ...o,
  };
}

const ID_SEED = "p-seed";
function semis(): L {
  return { id: ID_SEED, version: "prog-provisoire-1", source: "amorcage_provisoire", valeurs: structuredClone(VALEURS_AMORCAGE_PROVISOIRES), motif: null, creeParId: null, createdAt: new Date("2026-10-23T00:00:00Z"), approuveeLe: null, approuveeParId: null, deletedAt: null };
}

beforeEach(() => {
  w.modules = {}; w.perimetres = {}; w.ecritures = []; w.audit = []; w.appelsFaits = []; w.fiches = []; w.statuts = [];
  for (const c of Object.values(COMPTES)) { w.modules[c.id] = c.modules; if (c.regions) w.perimetres[c.id] = c.regions; }
  w.parametres = [semis()];
  w.faits = [
    fait("t1", { etat: "CRITIQUE", traficMoyenJma: 4000, pointsNoirs: { confirmes: 2, nonConfirmes: 0, registreRegion: 10 } }),
    fait("t2", { etat: "MAUVAIS" }),
    fait("t3", { etat: "NON_EVALUE" }),
    fait("t4", { etat: "MOYEN", regionId: 2, regionNom: "Region 2" }),
    fait("t5", { etat: "CRITIQUE", regionId: 2, regionNom: "Region 2", classe: "RR" }),
    fait("t6", { etat: "MAUVAIS", localisation: { valide: false, motif: "GEOMETRIE_ABSENTE" } }),
    fait("t7", { etat: "BON", traficMoyenJma: null, pointsNoirs: { confirmes: 0, nonConfirmes: 0, registreRegion: 0 } }),
  ];
  w.troncons = Object.fromEntries(w.faits.map((f) => [f.id, f.regionId]));
  w.troncons.supprime = 1; // existe en base, supprime : pas candidat
  w.dansBbox = new Set(["t1", "t2", "t3", "t4", "t5", "t6", "t7"]);
  _installerResolveurCompte(async (id) => {
    const c = Object.values(COMPTES).find((x) => x.id === id);
    return c ? { actif: true, lockedUntil: null, role: c.role as never, email: `${id}@essai.invalid` } : null;
  });
});

const matrice: string[] = [];
afterAll(() => { console.log("MATRICE\n" + matrice.join("\n")); });

type Methode = "get" | "post";
async function appel(compte: string | null, methode: Methode, url: string, corps?: object) {
  let r = request(app)[methode](url);
  if (compte) r = r.set("Authorization", `Bearer ${jeton(compte)}`);
  const rep = await (corps ? r.send(corps) : r);
  matrice.push(`${(compte ?? "ANONYME").padEnd(13)} ${methode.toUpperCase().padEnd(5)} ${url.padEnd(62).slice(0, 62)} -> ${rep.status}`);
  return rep;
}

const BBOX = "bbox=-15,7,-7.5,12.8";
const ROUTES: [Methode, string, object | undefined][] = [
  ["get", "/api/v2/aide-decision/interventions", undefined],
  ["get", `/api/v2/aide-decision/interventions.geojson?${BBOX}`, undefined],
  ["get", "/api/v2/aide-decision/interventions/t1", undefined],
  ["get", "/api/v2/aide-decision/priorites/parametres", undefined],
  ["post", "/api/v2/aide-decision/priorites/parametres", { version: "prog-priorite-9", priorite: {} }],
  ["post", `/api/v2/aide-decision/priorites/parametres/${ID_SEED}/approuver`, undefined],
  ["post", `/api/v2/aide-decision/priorites/parametres/${ID_SEED}/desapprouver`, { motif: "essai de retrait" }],
];

describe("matrice d'acces : chaque route, chaque profil", () => {
  it.each(ROUTES)("ANONYME : 401, aucune ecriture : %s %s", async (m, u, c) => {
    const r = await appel(null, m, u, c);
    expect(r.status).toBe(401);
    expect(w.ecritures).toEqual([]);
    expect(w.appelsFaits).toEqual([]);
  });

  it.each(ROUTES)("sans le module `decision` : 403 meme pour GESTIONNAIRE, rien n'est lu ni ecrit : %s %s", async (m, u, c) => {
    w.modules["u-gest"] = ["dashboard", "programmation", "marches", "rapports"];
    const r = await appel("GESTIONNAIRE", m, u, c);
    expect(r.status).toBe(403);
    expect(w.ecritures).toEqual([]);
    expect(w.appelsFaits).toEqual([]);
  });

  it("un compte au tableau de modules VIDE n'a aucun module (pas « tous »)", async () => {
    w.modules["u-lect"] = [];
    expect((await appel("LECTEUR", "get", "/api/v2/aide-decision/interventions")).status).toBe(403);
  });

  it("les GET sont ouverts a tout compte ayant le module (lecteur, inspecteur, gestionnaire, administrateur)", async () => {
    for (const compte of ["LECTEUR", "INSPECTEUR", "GESTIONNAIRE", "ADMIN"]) {
      for (const [m, u] of ROUTES.filter(([m2]) => m2 === "get")) expect((await appel(compte, m, u)).status, `${compte} ${u}`).toBe(200);
    }
  });

  it("les ecritures de parametres : LECTEUR et INSPECTEUR 403 ; approuver et desapprouver reserves a l'ADMIN", async () => {
    for (const c of ["LECTEUR", "INSPECTEUR"]) {
      expect((await appel(c, "post", "/api/v2/aide-decision/priorites/parametres", { version: "prog-priorite-9", priorite: {} })).status).toBe(403);
    }
    for (const c of ["LECTEUR", "INSPECTEUR", "GESTIONNAIRE"]) {
      expect((await appel(c, "post", `/api/v2/aide-decision/priorites/parametres/${ID_SEED}/approuver`)).status).toBe(403);
      expect((await appel(c, "post", `/api/v2/aide-decision/priorites/parametres/${ID_SEED}/desapprouver`, { motif: "essai de retrait" })).status).toBe(403);
    }
    expect(w.ecritures).toEqual([]);
    expect(w.audit).toEqual([]);
  });

  it("la lecture des interventions n'ecrit RIEN (ni SQL d'ecriture, ni audit)", async () => {
    for (const u of ["/interventions", `/interventions.geojson?${BBOX}`, "/interventions/t1", "/priorites/parametres"]) {
      await appel("ADMIN", "get", `/api/v2/aide-decision${u}`);
    }
    expect(w.ecritures).toEqual([]);
    expect(w.audit).toEqual([]);
  });
});

describe("GET /interventions", () => {
  it("rend la liste classee : deux classements nommes, score incomplet avec criteres manquants, exclusion nommee", async () => {
    const r = await appel("GESTIONNAIRE", "get", "/api/v2/aide-decision/interventions?limite=100");
    expect(r.status).toBe(200);
    const ids = r.body.data.map((l: L) => l.id);
    expect(ids).toHaveLength(7);
    const classes = r.body.data.filter((l: L) => l.prioriteTechnique.rang !== null);
    expect(classes.map((l: L) => l.prioriteTechnique.rang)).toEqual([1, 2, 3, 4, 5, 6]);
    // l'exclue est APRES les classees, avec son motif, sans rang ni score
    const exclue = r.body.data[6];
    expect(exclue.id).toBe("t3");
    expect(exclue.prioriteTechnique).toMatchObject({ statut: "EXCLU", rang: null, score: null, exclusion: { code: "ETAT_NON_EVALUE" } });
    // chaque ligne porte les deux classements, distincts
    for (const l of r.body.data) {
      expect(l.prioriteTechnique).toBeDefined();
      expect(l.ordreArbitrage).toBeDefined();
      expect(l).not.toHaveProperty("rang");
      expect(l.completude).toBe(l.prioriteTechnique.couverture);
      expect(l.provisoire).toBe(true);
    }
    const t1 = r.body.data.find((l: L) => l.id === "t1");
    expect(t1.prioriteTechnique.rang).toBe(1); // critique, trafic fort, points noirs
    expect(t1.prioriteTechnique.scoreIncomplet).toBe(true); // l'urgence manque (aucune inspection)
    expect(t1.prioriteTechnique.criteresManquants.map((m: L) => m.critere)).toEqual(["URGENCE_TEMPORELLE"]);
    expect(t1.etatPhysique).toBe("CRITIQUE");
    expect(t1.dernierConstat).toEqual({ date: null, source: null, ageJours: null });
    expect(t1.coutEstime).toMatchObject({ montantGnf: "7000000000", unite: "KM", devise: "GNF" });
    expect(t1.longueur).toMatchObject({ metierKm: 2, geometriqueM: 2000, longueurOrigine: "LONGUEUR_KM" });
    // la localisation invalide reste dans la liste, avertie
    const t6 = r.body.data.find((l: L) => l.id === "t6");
    expect(t6).toMatchObject({ localisation: "invalide", localisationMotif: "GEOMETRIE_ABSENTE" });
    expect(t6.prioriteTechnique.rang).not.toBeNull();
    // le modele et les parametres sont rendus avec la reponse
    expect(r.body.provisoire).toBe(true);
    expect(r.body.parametres).toMatchObject({ version: "prog-provisoire-1", blocOrigine: "AMORCAGE_CODE", approuveeLe: null });
    expect(r.body.modele.criteres.map((c: L) => c.code)).toContain("COUT_EFFICACITE");
    expect(r.body.modele.criteres.find((c: L) => c.code === "ACCESSIBILITE_SERVICE")).toMatchObject({ disponibilite: "NON_DISPONIBLE", ponderee: false });
    expect(r.body.avertissement).toContain("non engageant");
    expect(r.body.empreinte).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.resume).toMatchObject({ candidats: 7, classes: 6, exclus: 1 });
    expect(r.headers["cache-control"]).toBe("private, no-cache");
  });

  it("pagination par curseur : aucune ligne perdue ni doublee, meme ordre que la liste entiere", async () => {
    const entiere = (await appel("ADMIN", "get", "/api/v2/aide-decision/interventions?limite=100")).body.data.map((l: L) => l.id);
    const vus: string[] = [];
    let curseur: string | null = null;
    let pages = 0;
    do {
      const r: request.Response = await appel("ADMIN", "get", `/api/v2/aide-decision/interventions?limite=3${curseur ? `&curseur=${curseur}` : ""}`);
      expect(r.status).toBe(200);
      vus.push(...r.body.data.map((l: L) => l.id));
      expect(r.body.total).toBe(7);
      curseur = r.body.page.prochainCurseur;
      expect(r.body.page.aSuivant).toBe(curseur !== null);
      pages += 1;
    } while (curseur && pages < 10);
    expect(pages).toBe(3);
    expect(vus).toEqual(entiere);
    expect(new Set(vus).size).toBe(7);
  });

  it("un curseur issu d'une autre version de parametres est refuse (400), pas reinterprete", async () => {
    const p1 = (await appel("ADMIN", "get", "/api/v2/aide-decision/interventions?limite=2")).body.page.prochainCurseur;
    w.parametres.push({ ...semis(), id: "p-autre", version: "prog-autre-2", approuveeLe: new Date("2026-10-26T00:00:00Z"), approuveeParId: "u-x" });
    const r = await appel("ADMIN", "get", `/api/v2/aide-decision/interventions?limite=2&curseur=${p1}`);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("CURSEUR_INCOMPATIBLE");
  });

  it("filtres : classe, etat et region sont transmis au depot ; statutScore filtre l'AFFICHAGE sans changer les rangs", async () => {
    await appel("ADMIN", "get", "/api/v2/aide-decision/interventions?classe=RR&etat=CRITIQUE&regionId=2");
    expect(w.appelsFaits.at(-1)).toMatchObject({ classe: ["RR"], etat: ["CRITIQUE"], regionId: 2, regions: null });

    const tout = (await appel("ADMIN", "get", "/api/v2/aide-decision/interventions?limite=100")).body.data;
    const exclus = await appel("ADMIN", "get", "/api/v2/aide-decision/interventions?statutScore=EXCLU");
    expect(exclus.body.data.map((l: L) => l.id)).toEqual(["t3"]);
    expect(exclus.body.totalAffiche).toBe(1);
    expect(exclus.body.total).toBe(7);
    const incomplets = await appel("ADMIN", "get", "/api/v2/aide-decision/interventions?statutScore=INCOMPLET&limite=100");
    for (const l of incomplets.body.data) expect(l.prioriteTechnique.rang).toBe(tout.find((x: L) => x.id === l.id).prioriteTechnique.rang);
  });

  it("statutChantier est accepte mais declare NON APPLIQUE, avec la raison", async () => {
    const r = await appel("ADMIN", "get", "/api/v2/aide-decision/interventions?statutChantier=EN_COURS");
    expect(r.status).toBe(200);
    expect(r.body.filtres.nonAppliques).toEqual([expect.objectContaining({ filtre: "statutChantier", valeurs: ["EN_COURS"] })]);
    expect(r.body.filtres.appliques).not.toHaveProperty("statutChantier");
    expect(r.body.data).toHaveLength(7);
  });

  it("au-dela de 3 000 candidats : 422 PERIMETRE_TROP_LARGE, pas de classement partiel", async () => {
    w.faits = Array.from({ length: 3001 }, (_, i) => fait(`g${i}`, { code: `G-${i}` }));
    const r = await appel("ADMIN", "get", "/api/v2/aide-decision/interventions");
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("PERIMETRE_TROP_LARGE");
  });

  it("plusieurs versions provisoires et aucune approuvee : 422 PARAMETRES_A_PRECISER, puis OK avec parametresId", async () => {
    w.parametres.push({ ...semis(), id: "p-bis", version: "prog-bis-1" });
    const r = await appel("ADMIN", "get", "/api/v2/aide-decision/interventions");
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("PARAMETRES_A_PRECISER");
    const ok = await appel("ADMIN", "get", "/api/v2/aide-decision/interventions?parametresId=p-bis");
    expect(ok.status).toBe(200);
    expect(ok.body.parametres.version).toBe("prog-bis-1");
    expect((await appel("ADMIN", "get", "/api/v2/aide-decision/interventions?parametresId=inconnu")).status).toBe(422);
  });
});

describe("entrees hostiles : 400, jamais 500", () => {
  const HOSTILES = [
    "zzz=1", "limite=0", "limite=101", "limite=abc", "limite=1&limite=2", "classe=AUTOROUTE", "classe[a]=RN", "classe=RN,", "etat=BIEN",
    "regionId=abc", "regionId=0", "regionId=99999999999", "depuis=2026-02-30", "depuis=2026-06-01&jusqua=2026-01-01", "jusqua=2999-01-01",
    "statutScore=MEILLEUR", "parametresId=x'%20OR%20'1'='1", "curseur=!!!", "curseur=", `curseur=${Buffer.from('{"v":"x"}').toString("base64url")}`,
    `limite=${"9".repeat(40)}`, "statutChantier=a;b",
  ];
  it.each(HOSTILES)("liste : %s", async (q) => {
    const r = await appel("GESTIONNAIRE", "get", `/api/v2/aide-decision/interventions?${q}`);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("ENTREE_INVALIDE");
    expect(typeof r.body.error).toBe("string");
  });

  const HOSTILES_GEO = [
    "", "bbox=", "bbox=1,2,3", "bbox=-20,0,0,5", "bbox=0,0,0,0", "bbox=a,b,c,d", "bbox=-190,0,0,5", "bbox=-14,9,-13,10&limite=1001",
    "bbox=-14,9,-13,10&limite=0", "bbox=-14,9,-13,10&q=1", "bbox[]=-14,9,-13,10", "bbox=-14,9,-13,10&classe=XX", "bbox=1e2,0,2e2,1",
  ];
  it.each(HOSTILES_GEO)("geojson : %s", async (q) => {
    const r = await appel("GESTIONNAIRE", "get", `/api/v2/aide-decision/interventions.geojson?${q}`);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("ENTREE_INVALIDE");
  });

  it("detail : parametre inconnu ou parametresId hostile", async () => {
    expect((await appel("GESTIONNAIRE", "get", "/api/v2/aide-decision/interventions/t1?limite=3")).status).toBe(400);
    expect((await appel("GESTIONNAIRE", "get", "/api/v2/aide-decision/interventions/t1?parametresId=a%20b")).status).toBe(400);
  });

  const CORPS_HOSTILES: [string, unknown][] = [
    ["corps vide", {}], ["version absente", { priorite: {} }], ["version trop courte", { version: "ab", priorite: {} }],
    ["priorite absente", { version: "prog-x-1" }], ["cle inconnue", { version: "prog-x-1", priorite: {}, creeParId: "autre" }],
    ["auteur dans le corps", { version: "prog-x-1", priorite: {}, userId: "u-admin" }], ["poids inconnu", { version: "prog-x-1", priorite: { poids: { CRITERE_INVENTE: 1 } } }],
    ["poids texte", { version: "prog-x-1", priorite: { poids: { ETAT_GRAVITE: "40" } } }], ["poids NaN en texte", { version: "prog-x-1", priorite: { poids: { ETAT_GRAVITE: "NaN" } } }],
    ["date non ISO", { version: "prog-x-1", priorite: { validiteDe: "demain" } }], ["registre decimal", { version: "prog-x-1", priorite: { registrePointsNoirsMinimum: 1.5 } }],
    ["base avec guillemet", { version: "prog-x-1", baseParametresId: "x' OR 1=1", priorite: {} }], ["motif trop court", { version: "prog-x-1", motif: "a", priorite: {} }],
    ["priorite en tableau", { version: "prog-x-1", priorite: [] }],
  ];
  it.each(CORPS_HOSTILES)("POST parametres : %s", async (_nom, corps) => {
    const r = await appel("GESTIONNAIRE", "post", "/api/v2/aide-decision/priorites/parametres", corps as object);
    expect(r.status).toBe(400);
    expect(w.parametres).toHaveLength(1);
    expect(w.audit).toEqual([]);
  });

  it("desapprouver sans motif : 400 ; identifiant de version mal forme : 404", async () => {
    expect((await appel("ADMIN", "post", `/api/v2/aide-decision/priorites/parametres/${ID_SEED}/desapprouver`, {})).status).toBe(400);
    expect((await appel("ADMIN", "post", "/api/v2/aide-decision/priorites/parametres/a%20b/approuver")).status).toBe(404);
  });
});

describe("territoire : un compte regional", () => {
  it("ne voit QUE sa region, et aucun total national : liste, total, resume et empreinte ne portent que son perimetre", async () => {
    const r = await appel("GEST_R1", "get", "/api/v2/aide-decision/interventions?limite=100");
    expect(r.status).toBe(200);
    expect(w.appelsFaits.at(-1)!.regions).toEqual([1]);
    expect(r.body.data.map((l: L) => l.id).sort()).toEqual(["t1", "t2", "t3", "t6", "t7"]);
    expect(r.body.total).toBe(5);
    expect(r.body.resume.candidats).toBe(5);
    expect(r.body.perimetre).toEqual({ national: false, regions: [1] });
    expect(JSON.stringify(r.body)).not.toContain("Region 2");
    // pour un compte national, le meme appel voit 7 lignes (contre-epreuve : le perimetre decide)
    const nat = await appel("GESTIONNAIRE", "get", "/api/v2/aide-decision/interventions?limite=100");
    expect(nat.body.total).toBe(7);
    expect(nat.body.perimetre).toEqual({ national: true, regions: null });
  });

  it("une region hors perimetre demandee en filtre : 403 HORS_PERIMETRE, avant toute lecture", async () => {
    const r = await appel("GEST_R1", "get", "/api/v2/aide-decision/interventions?regionId=2");
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("HORS_PERIMETRE");
    expect(w.appelsFaits).toEqual([]);
    const g = await appel("GEST_R1", "get", `/api/v2/aide-decision/interventions.geojson?${BBOX}&regionId=2`);
    expect(g.status).toBe(403);
    // sa propre region reste permise
    expect((await appel("GEST_R1", "get", "/api/v2/aide-decision/interventions?regionId=1")).status).toBe(200);
  });

  it("GeoJSON : seuls les troncons de sa region, total de SON perimetre", async () => {
    const r = await appel("GEST_R1", "get", `/api/v2/aide-decision/interventions.geojson?${BBOX}`);
    expect(r.status).toBe(200);
    expect(r.body.features.map((f: L) => f.properties.regionId)).toEqual([1, 1, 1, 1]);
    expect(r.body.selection).toBe(5);
  });

  it("ORACLE FERME : region voisine, identifiant inconnu, troncon supprime et identifiant mal forme repondent le MEME 404", async () => {
    const voisine = await appel("GEST_R1", "get", "/api/v2/aide-decision/interventions/t4");
    const inconnu = await appel("GEST_R1", "get", "/api/v2/aide-decision/interventions/n-existe-pas");
    const supprime = await appel("GEST_R1", "get", "/api/v2/aide-decision/interventions/supprime");
    const malForme = await appel("GEST_R1", "get", "/api/v2/aide-decision/interventions/a%20b");
    const trop = await appel("GEST_R1", "get", `/api/v2/aide-decision/interventions/${"a".repeat(65)}`);
    const reference = await appel("GEST_R1", "get", "/api/v2/aide-decision/interventions/t4?limite=5"); // parametre hostile sur une ressource masquee : 404 aussi, pas 400
    for (const r of [voisine, inconnu, supprime, malForme, trop, reference]) {
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ error: "intervention introuvable", code: "INTROUVABLE" });
    }
    // un compte NATIONAL recoit le meme corps pour l'inconnu, le supprime et le mal forme
    for (const id of ["n-existe-pas", "supprime", "a%20b"]) {
      const r = await appel("GESTIONNAIRE", "get", `/api/v2/aide-decision/interventions/${id}`);
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ error: "intervention introuvable", code: "INTROUVABLE" });
    }
    // contre-epreuve : le compte national voit t4
    expect((await appel("GESTIONNAIRE", "get", "/api/v2/aide-decision/interventions/t4")).status).toBe(200);
    expect((await appel("GEST_R1", "get", "/api/v2/aide-decision/interventions/t1")).status).toBe(200);
  });
});

describe("GET /interventions/:id", () => {
  it("fiche : motif, contributions, limites, actions honnetes, historique", async () => {
    w.fiches = [{ id: "f1", reference: "FI-2027-0001", scenarioId: "s1", tronconId: "t1", annee: 2027, parametresVersion: "prog-provisoire-1", statut: "PROPOSE", rangStatut: 2, statutDepuis: new Date("2026-10-26T10:00:00Z"), figeLe: new Date("2026-10-25T10:00:00Z"), figeParId: "u-gest" }];
    w.statuts = [
      { ficheId: "f1", rang: 1, de: null, vers: "BROUILLON", origine: "GEOPORTAIL", motif: null, auteurId: "u-gest", enregistreLe: new Date("2026-10-25T10:00:00Z") },
      { ficheId: "f1", rang: 2, de: "BROUILLON", vers: "PROPOSE", origine: "GEOPORTAIL", motif: null, auteurId: "u-gest", enregistreLe: new Date("2026-10-26T10:00:00Z") },
    ];
    const r = await appel("LECTEUR", "get", "/api/v2/aide-decision/interventions/t1");
    expect(r.status).toBe(200);
    expect(r.body.intervention.id).toBe("t1");
    expect(r.body.intervention.prioriteTechnique.contributions.length).toBeGreaterThanOrEqual(3);
    expect(r.body.motif).toContain("Priorite technique 1/6");
    expect(r.body.limites.length).toBeGreaterThan(3);
    // actions : aucun workflow n'existe pour une intervention candidate : liste vide, raison, et ce qui n'est pas implemente
    expect(r.body.actions.disponibles).toEqual([]);
    expect(r.body.actions.nonDisponibles).toEqual(["examiner", "affecter", "proposer_a_la_programmation", "reporter", "rejeter"]);
    expect(r.body.actions.raison).toContain("Aucun workflow");
    // historique : pas de recalculs enregistres (dit), decisions humaines = statuts des fiches figees
    expect(r.body.historique.recalculs).toMatchObject({ disponible: false });
    expect(r.body.historique.decisions.map((d: L) => d.vers)).toEqual(["BROUILLON", "PROPOSE"]);
    expect(r.body.historique.parametres[0]).toMatchObject({ version: "prog-provisoire-1", utilisee: true });
    expect(r.body.fiches[0]).toMatchObject({ reference: "FI-2027-0001", statut: "PROPOSE" });
    expect(r.body.fiches[0].transitionsPossibles).toEqual(["ARBITRE", "BROUILLON"]);
    expect(r.body.provisoire).toBe(true);
  });

  it("une intervention exclue a une fiche lisible : motif d'exclusion, pas de rang", async () => {
    const r = await appel("LECTEUR", "get", "/api/v2/aide-decision/interventions/t3");
    expect(r.status).toBe(200);
    expect(r.body.intervention.prioriteTechnique).toMatchObject({ statut: "EXCLU", rang: null, score: null });
    expect(r.body.motif).toMatch(/^Non classee \(ETAT_NON_EVALUE\)/);
  });
});

describe("GET /interventions.geojson", () => {
  it("FeatureCollection : proprietes minimales, une intervention sans geometrie exploitable n'y figure PAS", async () => {
    const r = await appel("LECTEUR", "get", `/api/v2/aide-decision/interventions.geojson?${BBOX}`);
    expect(r.status).toBe(200);
    expect(r.body.type).toBe("FeatureCollection");
    const ids = r.body.features.map((f: L) => f.properties.id);
    expect(ids).not.toContain("t6"); // localisation invalide : reste dans la liste, pas sur la carte
    expect(ids).toHaveLength(6);
    expect(r.body.total).toBe(6);
    expect(r.body.tronque).toBe(false);
    expect(r.body.horsGeometrie).toBe(1);
    expect(r.body.selection).toBe(7);
    expect(Object.keys(r.body.features[0].properties).sort()).toEqual(["classe", "code", "couverture", "etatPhysique", "id", "nom", "rang", "rangArbitrage", "regionId", "score", "scoreIncomplet", "statutScore"]);
    expect(r.body.features[0].geometry.type).toBe("LineString");
    expect(r.body.ordrePlafonnement).toContain("priorite technique");
  });

  it("plafond : au-dela, on garde les mieux classes, et on annonce `tronque` et `total`", async () => {
    const r = await appel("LECTEUR", "get", `/api/v2/aide-decision/interventions.geojson?${BBOX}&limite=2`);
    expect(r.status).toBe(200);
    expect(r.body.features).toHaveLength(2);
    expect(r.body.tronque).toBe(true);
    expect(r.body.total).toBe(6);
    expect(r.body.limite).toBe(2);
    const rangs = r.body.features.map((f: L) => f.properties.rang);
    expect(rangs).toEqual([1, 2]);
  });

  it("l'emprise decide : seuls les troncons dans la zone sont servis", async () => {
    w.dansBbox = new Set(["t1"]);
    const r = await appel("LECTEUR", "get", `/api/v2/aide-decision/interventions.geojson?${BBOX}`);
    expect(r.body.features.map((f: L) => f.properties.id)).toEqual(["t1"]);
    expect(r.body.total).toBe(1);
    expect(r.body.selection).toBe(7);
    // rang et score sont ceux de la liste (meme classement, pas un classement local a la zone)
    expect(r.body.features[0].properties.rang).toBe(1);
  });

  it("le plafond par defaut est 300", async () => {
    const r = await appel("LECTEUR", "get", `/api/v2/aide-decision/interventions.geojson?${BBOX}`);
    expect(r.body.limite).toBe(300);
  });
});

describe("parametres de priorite : delegues au mecanisme du moteur", () => {
  it("GET : chaque version dit si elle porte son bloc ; l'amorcage du code est nomme comme tel", async () => {
    const r = await appel("LECTEUR", "get", "/api/v2/aide-decision/priorites/parametres");
    expect(r.status).toBe(200);
    expect(r.body.data[0]).toMatchObject({ version: "prog-provisoire-1", provisoire: true, etiquette: "PROVISOIRE, non approuvé" });
    expect(r.body.data[0].priorite).toMatchObject({ present: false, origine: "AMORCAGE_CODE" });
    expect(r.body.data[0].priorite.bloc.poids.ETAT_GRAVITE).toBe(40);
  });

  it("POST : cree une NOUVELLE version provisoire (risque copie de la base + bloc), auteur de la SESSION, audit CREATE", async () => {
    const r = await appel("GESTIONNAIRE", "post", "/api/v2/aide-decision/priorites/parametres", {
      version: "prog-priorite-2", motif: "essai de poids", priorite: { poids: { ETAT_GRAVITE: 50, URGENCE_TEMPORELLE: 5 }, validiteA: "2027-12-31", couvertureMinimale: 0.4 },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ version: "prog-priorite-2", provisoire: true, creeParId: "u-gest", baseVersion: "prog-provisoire-1" });
    const cree = w.parametres.find((p) => p.version === "prog-priorite-2")!;
    expect(cree.creeParId).toBe("u-gest");
    expect(cree.approuveeLe).toBeNull();
    expect(cree.valeurs.priorite.poids).toEqual({ ETAT_GRAVITE: 50, IMPORTANCE_AXE: 25, SECURITE_CRITICITE: 20, ACCESSIBILITE_SERVICE: 0, URGENCE_TEMPORELLE: 5, MATURITE_FAISABILITE: 0 });
    expect(cree.valeurs.priorite).toMatchObject({ validiteA: "2027-12-31", couvertureMinimale: 0.4, modele: "priorite-technique-1" });
    expect(cree.valeurs.poidsRisque).toEqual(VALEURS_AMORCAGE_PROVISOIRES.poidsRisque); // valeurs du risque reprises de la base
    expect(w.audit).toHaveLength(1);
    expect(w.audit[0]).toMatchObject({ action: "CREATE", entityType: "ParametresProgrammation", userId: "u-gest" });
  });

  it("POST : valeurs incoherentes -> 422 avec toutes les erreurs ; version existante -> 409 ; aucune ecriture ni audit", async () => {
    const mauvais = await appel("GESTIONNAIRE", "post", "/api/v2/aide-decision/priorites/parametres", { version: "prog-priorite-3", priorite: { couvertureMinimale: 3, registrePointsNoirsMinimum: 0, poids: { ETAT_GRAVITE: -4 } } });
    expect(mauvais.status).toBe(422);
    expect(mauvais.body.code).toBe("PARAMETRES_INVALIDES");
    expect(mauvais.body.error).toContain("couvertureMinimale");
    expect(mauvais.body.error).toContain("registrePointsNoirsMinimum");
    expect(mauvais.body.error).toContain("ETAT_GRAVITE");
    const doublon = await appel("GESTIONNAIRE", "post", "/api/v2/aide-decision/priorites/parametres", { version: "prog-provisoire-1", priorite: {} });
    expect(doublon.status).toBe(409);
    expect(doublon.body.code).toBe("VERSION_EXISTANTE");
    expect(w.parametres).toHaveLength(1);
    expect(w.audit).toEqual([]);
  });

  it("POST : base inconnue -> 422", async () => {
    const r = await appel("GESTIONNAIRE", "post", "/api/v2/aide-decision/priorites/parametres", { version: "prog-priorite-4", baseParametresId: "inconnue", priorite: {} });
    expect(r.status).toBe(422);
    expect(w.parametres).toHaveLength(1);
  });

  it("approuver : refuse une version SANS bloc (409), approuve une version avec bloc, auditee VALIDATE avec l'approbateur de la session ; double approbation 409", async () => {
    const sans = await appel("ADMIN", "post", `/api/v2/aide-decision/priorites/parametres/${ID_SEED}/approuver`);
    expect(sans.status).toBe(409);
    expect(sans.body.code).toBe("BLOC_PRIORITE_ABSENT");
    expect((await appel("ADMIN", "post", "/api/v2/aide-decision/priorites/parametres/inconnue/approuver")).status).toBe(404);

    const cree = await appel("GESTIONNAIRE", "post", "/api/v2/aide-decision/priorites/parametres", { version: "prog-priorite-5", priorite: {} });
    const id = cree.body.id;
    const ok = await appel("ADMIN", "post", `/api/v2/aide-decision/priorites/parametres/${id}/approuver`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ provisoire: false, approuveeParId: "u-admin", etiquette: "paramètres approuvés" });
    expect(w.audit.map((a) => a.action)).toEqual(["CREATE", "VALIDATE"]);
    expect(w.audit[1].userId).toBe("u-admin");
    expect((await appel("ADMIN", "post", `/api/v2/aide-decision/priorites/parametres/${id}/approuver`)).status).toBe(409);

    // une fois approuvee, la version est celle que le moteur choisit : l'etiquette change, le calcul n'est plus provisoire
    const liste = await appel("ADMIN", "get", "/api/v2/aide-decision/interventions");
    expect(liste.body.parametres).toMatchObject({ version: "prog-priorite-5", etiquette: "paramètres approuvés", blocOrigine: "VERSION" });
    expect(liste.body.provisoire).toBe(false);
    expect(liste.body.data.every((l: L) => l.provisoire === false)).toBe(true);

    const retrait = await appel("ADMIN", "post", `/api/v2/aide-decision/priorites/parametres/${id}/desapprouver`, { motif: "retrait pour essai" });
    expect(retrait.status).toBe(200);
    expect(retrait.body.provisoire).toBe(true);
    expect(w.audit.at(-1)).toMatchObject({ action: "UPDATE", userId: "u-admin" });
  });
});
