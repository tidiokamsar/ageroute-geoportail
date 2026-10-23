import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `/api/v2/programmation/moteur/ppe` et lecture de la praticabilite (D-02) : ce que ces tests defendent.
 *
 *   - toute ECRITURE est auditee dans la transaction, et porte l'auteur de la SESSION (jamais du corps) ;
 *   - le corps est STRICT : une cle inconnue, un nombre d'annees hors 2..5, un montant non chaine = 400 ;
 *   - AUCUNE enveloppe n'est inventee : l'absence d'enveloppe est refusee ;
 *   - un plan est PROVISOIRE et le dit, avec la version des parametres, tant que rien n'est approuve ;
 *   - deux calculs avec le meme corps rendent le meme resultat, octet pour octet ; le rejeu est identique ;
 *   - aucune route ne modifie ni ne supprime physiquement (ni PUT, ni PATCH, ni DELETE) ;
 *   - la praticabilite est « non branchee » sans valeur approuvee, et ne l'est qu'EN LECTURE sinon.
 *
 * La base est simulee par un depot en memoire : le SQL reel (declencheur, contraintes d'empreinte et de coherence,
 * oracle independant) est eprouve par tests-integration/ppe.integration.mts.
 */
const h = vi.hoisted(() => ({
  compte: { id: "u1", role: "GESTIONNAIRE", email: "g@essai.invalid" } as { id: string; role: string; email: string },
  parametres: [] as Array<Record<string, any>>,
  plans: new Map<string, Record<string, any>>(),
  audit: [] as Array<{ action: string; entityType: string; entityId?: string; before?: any; after?: any; userId: string | null }>,
  nbCandidats: 0,
  praticabilites: [] as Array<Record<string, any>>,
  portionsPrat: [] as Array<Record<string, any>>,
}));

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { ...h.compte };
    n();
  },
}));
vi.mock("../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_q: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));
vi.mock("../middleware/rbac.middleware", () => ({
  requireRole: (...roles: string[]) => (req: express.Request, res: express.Response, n: express.NextFunction) => {
    if (!roles.includes(req.user?.role as string)) { res.status(403).json({ error: "Acces refuse pour votre role" }); return; }
    n();
  },
}));
vi.mock("../lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    $queryRaw: vi.fn(), $executeRaw: vi.fn(),
  },
}));
vi.mock("../utils/audit", () => ({
  logAuditTransactionnelle: vi.fn(async (_tx: unknown, p: any) => { h.audit.push(p); }),
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
    chargerCandidats: async () => (h.nbCandidats > 0
      ? Array.from({ length: h.nbCandidats }, (_, i) => fx.candidat(`id-${i}`, { code: `C-${i}` }))
      : fx.candidatsDeBase()),
    chargerBaremes: async () => fx.BAREMES,
    chargerCatalogue: async () => fx.CATALOGUE,
    chargerConditions: async () => fx.CONDITIONS,
    chargerMatrices: async () => fx.MATRICES,
    lireScenario: async () => null,
  };
});

vi.mock("../programmation/ppe.depot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../programmation/ppe.depot")>();
  const clone = <T,>(x: T): T => structuredClone(x);
  return {
    ...actual,
    insererPlan: async (_db: unknown, p: any) => {
      const l = { ...p, perimetre: JSON.parse(p.perimetreJson), creeLe: new Date("2026-10-26T09:00:00Z"), deletedAt: null };
      h.plans.set(p.id, l);
      const { entreesCanoniques: _e, resultatCanonique: _r, perimetreJson: _pj, ...resume } = l;
      return resume;
    },
    lirePlan: async (_db: unknown, id: string) => { const p = h.plans.get(id); return p && !p.deletedAt ? clone(p) : null; },
    listerPlans: async (_db: unknown, f: any) => {
      const l = [...h.plans.values()].filter((p) => !p.deletedAt && (f.anneeDebut == null || p.anneeDebut === f.anneeDebut));
      return { total: l.length, lignes: l.map(({ entreesCanoniques: _e, resultatCanonique: _r, perimetreJson: _pj, ...r }) => r) };
    },
    supprimerPlanLogiquement: async (_db: unknown, id: string) => { const p = h.plans.get(id); if (p) p.deletedAt = new Date(); return p ? 1 : 0; },
    lirePraticabilites: async () => clone(h.praticabilites),
    portionsAvecPraticabiliteApprouvee: async (_db: unknown, ids: string[]) => clone(h.portionsPrat.filter((p) => ids.includes(p.tronconId))),
  };
});

import { ppeProgrammationV2Router } from "./programmation.ppe.routes";
import { moteurProgrammationV2Router } from "./programmation.moteur.routes";
import { VALEURS_AMORCAGE_PROVISOIRES } from "../programmation/parametres.noyau";

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use("/ppe", ppeProgrammationV2Router);
app.use("/", moteurProgrammationV2Router);

const SEED = { id: "p-seed", version: "prog-provisoire-1", source: "amorcage_provisoire", valeurs: structuredClone(VALEURS_AMORCAGE_PROVISOIRES), motif: "amorcage", creeParId: null, createdAt: new Date("2026-10-23T00:00:00Z"), approuveeLe: null, approuveeParId: null, deletedAt: null };

beforeEach(() => {
  h.compte = { id: "u1", role: "GESTIONNAIRE", email: "g@essai.invalid" };
  h.parametres = [structuredClone(SEED)];
  h.plans.clear(); h.audit = []; h.nbCandidats = 0; h.praticabilites = []; h.portionsPrat = [];
});

const corps = (o: Record<string, unknown> = {}) => ({
  anneeDebut: 2027, intitule: "PPE 2027-2029 essai",
  enveloppes: [{ budgetGnf: "5000000000" }, { budgetGnf: "5000000000" }, { budgetGnf: "5000000000" }], ...o,
});
async function calculer(o: Record<string, unknown> = {}) {
  const r = await request(app).post("/ppe/simulations").send(corps(o));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { plan: { id: string; empreinteResultat: string; empreinteEntrees: string; enveloppeTotaleGnf: string; montantEngageGnf: string }; resultat: any };
}

describe("aucune route ne modifie ni ne supprime physiquement", () => {
  it("le routeur PPE n'expose ni PUT, ni PATCH, ni DELETE", () => {
    const methodes = new Set<string>();
    for (const l of (ppeProgrammationV2Router as unknown as { stack: Array<{ route?: { methods: Record<string, boolean> } }> }).stack) {
      for (const m of Object.keys(l.route?.methods ?? {})) methodes.add(m);
    }
    expect([...methodes].sort()).toEqual(["get", "post"]);
  });
});

describe("POST /ppe/simulations", () => {
  it("calcule le plan annee par annee, ligne par ligne, avec son etiquette PROVISOIRE et la version des parametres", async () => {
    const { plan, resultat } = await calculer();
    expect(resultat.etiquette).toBe("PROVISOIRE, non approuvé");
    expect(resultat.parametres).toMatchObject({ version: "prog-provisoire-1", etiquette: "PROVISOIRE, non approuvé" });
    expect(resultat.annees.map((a: any) => a.annee)).toEqual([2027, 2028, 2029]);
    expect(resultat.annees[0].scenario.lignes.filter((l: any) => l.decision === "RETENUE").map((l: any) => l.troncon.code)).toEqual(["RN-C", "RN-B"]);
    expect(resultat.annees[1].scenario.lignes.filter((l: any) => l.decision === "RETENUE").map((l: any) => l.troncon.code)).toEqual(["RN-A"]);
    for (const a of resultat.annees) for (const l of a.scenario.lignes) { expect(l.etiquette).toBe("PROVISOIRE, non approuvé"); expect(l.justification.length).toBeGreaterThan(10); }
    expect(resultat.limites.join(" ")).toMatch(/gloutonne/);
    expect(plan).toMatchObject({ empreinteResultat: expect.stringMatching(/^[0-9a-f]{64}$/), empreinteEntrees: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("les montants du resume sont des chaines de chiffres, jamais des nombres JSON", async () => {
    const { plan } = await calculer({ enveloppes: [{ budgetGnf: "9007199254740993" }, { budgetGnf: "5" }] });
    expect(plan.enveloppeTotaleGnf).toBe("9007199254740998");
    expect(typeof plan.montantEngageGnf).toBe("string");
  });

  it("audite CREATE PlanPluriannuel dans la transaction, auteur pris sur la session, avec les enveloppes saisies", async () => {
    const { plan } = await calculer();
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({ action: "CREATE", entityType: "PlanPluriannuel", entityId: plan.id, userId: "u1" });
    expect(h.audit[0].after).toMatchObject({ anneeDebut: 2027, nbAnnees: 3, enveloppesGnf: ["5000000000", "5000000000", "5000000000"], provisoire: true, parametresVersion: "prog-provisoire-1" });
    expect(h.plans.get(plan.id)!.creeParId).toBe("u1");
  });

  it("DETERMINISME : le meme corps rend le meme resultat et les memes empreintes, octet pour octet", async () => {
    const a = await calculer();
    const b = await calculer();
    expect(JSON.stringify(b.resultat)).toBe(JSON.stringify(a.resultat));
    expect(b.plan.empreinteResultat).toBe(a.plan.empreinteResultat);
    expect(b.plan.empreinteEntrees).toBe(a.plan.empreinteEntrees);
    expect(b.plan.id).not.toBe(a.plan.id);
  });

  it("refuse (400) un corps strict : cle inconnue (auteur, approbation), 1 ou 6 annees, montant non chaine, montant negatif, aucune enveloppe", async () => {
    const mauvais: Record<string, unknown>[] = [
      corps({ creeParId: "autre" }),
      corps({ approuveeLe: "2026-01-01" }),
      corps({ enveloppes: [{ budgetGnf: "100" }] }),
      corps({ enveloppes: Array.from({ length: 6 }, () => ({ budgetGnf: "100" })) }),
      corps({ enveloppes: [{ budgetGnf: 5000 }, { budgetGnf: "100" }] }),
      corps({ enveloppes: [{ budgetGnf: "-5" }, { budgetGnf: "100" }] }),
      corps({ enveloppes: [{ budgetGnf: "100", note: "x" }, { budgetGnf: "100" }] }),
      corps({ enveloppes: [] }),
      { anneeDebut: 2027, intitule: "PPE sans enveloppe" },
      corps({ anneeDebut: 1999 }),
    ];
    for (const c of mauvais) {
      const r = await request(app).post("/ppe/simulations").send(c);
      expect(r.status, JSON.stringify(c)).toBe(400);
    }
    expect(h.plans.size).toBe(0);
    expect(h.audit).toHaveLength(0);
  });

  it("une enveloppe annuelle de 0 est une saisie valide", async () => {
    const { resultat } = await calculer({ enveloppes: [{ budgetGnf: "0" }, { budgetGnf: "5000000000" }] });
    expect(resultat.annees[0].scenario.totaux.retenues).toBe(0);
    expect(resultat.annees[1].scenario.totaux.retenues).toBe(2);
  });

  it("plus de 500 troncons candidats : 422 PERIMETRE_TROP_LARGE, rien n'est ecrit", async () => {
    h.nbCandidats = 501;
    const r = await request(app).post("/ppe/simulations").send(corps());
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("PERIMETRE_TROP_LARGE");
    expect(h.plans.size).toBe(0);
  });

  it("deux versions provisoires sans approbation et sans parametresId : le moteur ne choisit pas (422)", async () => {
    h.parametres.push({ ...structuredClone(SEED), id: "p-2", version: "prog-essai-2" });
    const r = await request(app).post("/ppe/simulations").send(corps());
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("PARAMETRES_A_PRECISER");
  });

  it("un LECTEUR lit mais ne calcule pas (403)", async () => {
    h.compte.role = "LECTEUR";
    expect((await request(app).post("/ppe/simulations").send(corps())).status).toBe(403);
    expect((await request(app).get("/ppe/simulations")).status).toBe(200);
  });
});

describe("lecture, rejeu, suppression logique", () => {
  it("GET /simulations liste, GET /simulations/:id rend le plan complet, un inconnu est 404", async () => {
    const { plan } = await calculer();
    const l = await request(app).get("/ppe/simulations");
    expect(l.body.total).toBe(1);
    expect(l.body.data[0]).toMatchObject({ id: plan.id, nbAnnees: 3, anneeFin: 2029, etiquette: "PROVISOIRE, non approuvé" });
    const g = await request(app).get(`/ppe/simulations/${plan.id}`);
    expect(g.status).toBe(200);
    expect(g.body.resultat.synthese.retenus).toBe(3);
    expect((await request(app).get("/ppe/simulations/inconnu")).status).toBe(404);
  });

  it("le rejeu depuis les entrees stockees est IDENTIQUE, octet pour octet, et n'ecrit rien", async () => {
    const { plan } = await calculer();
    const avant = h.audit.length;
    const r = await request(app).post(`/ppe/simulations/${plan.id}/rejouer`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ identique: true, entreesIntegres: true, empreinteStockee: plan.empreinteResultat, empreinteRecalculee: plan.empreinteResultat });
    expect(h.audit.length).toBe(avant);
  });

  it("un texte de resultat altere est signale par le rejeu (identique: false), pas masque", async () => {
    const { plan } = await calculer();
    const p = h.plans.get(plan.id)!;
    p.resultatCanonique = p.resultatCanonique.replace('"retenus":3', '"retenus":2');
    const r = await request(app).post(`/ppe/simulations/${plan.id}/rejouer`);
    expect(r.body.identique).toBe(false);
    expect(r.body.explication).toMatch(/diffère/);
  });

  it("des entrees stockees alterees sont signalees (entreesIntegres: false)", async () => {
    const { plan } = await calculer();
    const p = h.plans.get(plan.id)!;
    // Le texte d'entrees ne correspond plus a l'empreinte scellee : le rejeu doit le dire.
    p.empreinteEntrees = "0".repeat(64);
    const r = await request(app).post(`/ppe/simulations/${plan.id}/rejouer`);
    expect(r.body.entreesIntegres).toBe(false);
  });

  it("supprimer est LOGIQUE, audite DELETE, ne se fait pas deux fois, et le plan disparait des lectures", async () => {
    const { plan } = await calculer();
    const r = await request(app).post(`/ppe/simulations/${plan.id}/supprimer`);
    expect(r.status).toBe(200);
    expect(h.audit.at(-1)).toMatchObject({ action: "DELETE", entityType: "PlanPluriannuel", entityId: plan.id, userId: "u1" });
    expect(h.plans.get(plan.id)!.deletedAt).toBeInstanceOf(Date);
    expect((await request(app).get(`/ppe/simulations/${plan.id}`)).status).toBe(404);
    expect((await request(app).post(`/ppe/simulations/${plan.id}/supprimer`)).status).toBe(404);
  });
});

describe("praticabilite (D-02)", () => {
  const niveau = (code: string, o: Record<string, unknown> = {}) => ({ code, libelle: `Niveau ${code}`, franchissable: true, saisonniere: false, approuveeLe: null, actif: true, ordre: 1, ...o });

  it("referentiel vide : « non branchée : aucune valeur approuvée (D-02) », aucun critere invente", async () => {
    const r = await request(app).get("/praticabilite");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ branchee: false, valeursDeclarees: 0, valeursApprouvees: 0, libelle: "non branchée : aucune valeur approuvée (D-02)" });
    expect(r.body.effet).toMatch(/Aucun critère n'est inventé/);
  });

  it("des valeurs declarees mais NON approuvees ne branchent rien, et le motif le dit", async () => {
    h.praticabilites = [niveau("P1"), niveau("P4", { franchissable: false })];
    const r = await request(app).get("/praticabilite");
    expect(r.body).toMatchObject({ branchee: false, valeursDeclarees: 2, valeursApprouvees: 0 });
    expect(r.body.motif).toMatch(/2 valeur\(s\) déclarée\(s\), aucune approuvée/);
  });

  it("une valeur inactive n'est jamais comptee, meme approuvee", async () => {
    h.praticabilites = [niveau("P4", { franchissable: false, approuveeLe: new Date("2026-10-20"), actif: false })];
    expect((await request(app).get("/praticabilite")).body.branchee).toBe(false);
  });

  it("sans valeur approuvee, la lecture sur un plan ne rend AUCUNE alerte, meme si une portion porte un niveau non approuve", async () => {
    h.praticabilites = [niveau("P4", { franchissable: false })];
    h.portionsPrat = [{ tronconId: "a", code: "P4", debutM: 0, finM: 100 }];
    const { plan } = await calculer();
    const r = await request(app).get(`/ppe/simulations/${plan.id}/praticabilite`);
    expect(r.status).toBe(200);
    expect(r.body.statut.branchee).toBe(false);
    expect(r.body.alertes).toEqual([]);
  });

  it("avec une valeur APPROUVEE non franchissable : branchee EN LECTURE, signal sur la ligne retenue concernee, aucun rang change", async () => {
    h.praticabilites = [niveau("P1", { approuveeLe: new Date("2026-10-20") }), niveau("P4", { franchissable: false, approuveeLe: new Date("2026-10-20"), libelle: "Coupée" })];
    h.portionsPrat = [{ tronconId: "a", code: "P4", debutM: 0, finM: 100 }, { tronconId: "b", code: "P1", debutM: 0, finM: 50 }, { tronconId: "zzz-non-retenu", code: "P4", debutM: 0, finM: 5 }];
    const avant = await calculer();
    const r = await request(app).get(`/ppe/simulations/${avant.plan.id}/praticabilite`);
    expect(r.body.statut).toMatchObject({ branchee: true, valeursApprouvees: 2 });
    expect(r.body.statut.effet).toMatch(/Signal seulement/);
    expect(r.body.alertes).toEqual([{ tronconId: "a", code: "P4", niveau: "P4", libelle: "Coupée", franchissable: false, saisonniere: false, debutM: 0, finM: 100 }]);
    // Le plan calcule apres que la praticabilite est branchee est identique a celui d'avant : aucun effet sur le calcul.
    const apres = await calculer();
    expect(JSON.stringify(apres.resultat)).toBe(JSON.stringify(avant.resultat));
  });

  it("GET /simulations/:id/praticabilite d'un scenario annuel inconnu : 404", async () => {
    expect((await request(app).get("/simulations/inconnu/praticabilite")).status).toBe(404);
  });
});
