import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Controle territorial (A10) : compte NATIONAL ici, le sujet de ce fichier est ailleurs. Le controle lui-meme
// (lecture et ecriture par region) est eprouve par securite/controle-acces.test.ts et par le banc
// tests-integration/controle-acces.integration.mts.
vi.mock("../territoire/territoire.service", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  perimetreDe: async () => ({ national: true }),
}));

/**
 * `/api/v2/programmation/moteur` : ce que ces tests defendent.
 *
 *   - toute ECRITURE est auditee dans la transaction, et porte l'auteur de la SESSION (jamais du corps) ;
 *   - un scenario cite la version des parametres et l'etiquette « PROVISOIRE, non approuve » ;
 *   - sans bareme, le moteur de cout REFUSE : rien n'est chiffre, rien n'est retenu (D-07) ;
 *   - aucune route ne modifie ni ne supprime une fiche (ni PUT, ni PATCH, ni DELETE) ;
 *   - TRANSMIS, EN_EXECUTION, ACHEVE, EVALUE ne se saisissent pas ici : 403 ORIGINE_INTERDITE ;
 *   - approuver des parametres est reserve a l'ADMIN ;
 *   - les montants sont des chaines de chiffres, jamais des nombres JSON.
 *
 * La base est simulee par un depot en memoire : le SQL reel (declencheurs, contraintes d'empreinte,
 * oracle de calcul) est eprouve par tests-integration/programmation.integration.mts.
 */
const h = vi.hoisted(() => ({
  compte: { id: "u1", role: "GESTIONNAIRE", email: "g@essai.invalid" } as { id: string; role: string; email: string },
  parametres: [] as Array<Record<string, any>>,
  scenarios: new Map<string, Record<string, any>>(),
  fiches: new Map<string, Record<string, any>>(),
  statuts: [] as Array<Record<string, any>>,
  audit: [] as Array<{ action: string; entityType: string; entityId?: string; before?: any; after?: any; userId: string | null }>,
  baremes: null as null | unknown[],
  nbCandidats: 0,
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
  const { VALEURS_AMORCAGE_PROVISOIRES } = await import("../programmation/parametres.noyau");
  const clone = <T,>(x: T): T => structuredClone(x);
  const rangMax = (id: string) => Math.max(0, ...h.statuts.filter((s) => s.ficheId === id).map((s) => s.rang));
  return {
    ...actual,
    listerParametres: async () => h.parametres.filter((p) => !p.deletedAt).map(clone),
    lireParametresParId: async (_db: unknown, id: string) => { const p = h.parametres.find((x) => x.id === id && !x.deletedAt); return p ? clone(p) : null; },
    insererParametres: async (_db: unknown, p: any) => {
      if (h.parametres.some((x) => x.version === p.version)) throw Object.assign(new Error("duplicate key value violates unique constraint"), { meta: { code: "23505" } });
      const l = { id: p.id, version: p.version, source: "saisie", valeurs: JSON.parse(p.valeursJson), motif: p.motif, creeParId: p.creeParId, createdAt: new Date(), approuveeLe: null, approuveeParId: null, deletedAt: null };
      h.parametres.push(l);
      return clone(l);
    },
    poserApprobation: async (_db: unknown, id: string, qui: string | null) => {
      const p = h.parametres.find((x) => x.id === id);
      if (!p) return null;
      p.approuveeLe = qui ? new Date("2026-10-23T08:00:00Z") : null; p.approuveeParId = qui;
      return clone(p);
    },
    chargerCandidats: async () => (h.nbCandidats > 0
      ? Array.from({ length: h.nbCandidats }, (_, i) => fx.candidat(`id-${i}`, { code: `C-${i}` }))
      : fx.candidatsDeBase()),
    chargerBaremes: async () => (h.baremes ?? fx.BAREMES),
    chargerCatalogue: async () => fx.CATALOGUE,
    chargerConditions: async () => fx.CONDITIONS,
    chargerMatrices: async () => fx.MATRICES,
    insererScenario: async (_db: unknown, s: any) => {
      const l = { ...s, perimetre: JSON.parse(s.perimetreJson), creeLe: new Date("2026-10-23T09:00:00Z"), deletedAt: null };
      h.scenarios.set(s.id, l);
      const { entreesCanoniques: _e, resultatCanonique: _r, ...resume } = l;
      return resume;
    },
    lireScenario: async (_db: unknown, id: string) => { const s = h.scenarios.get(id); return s && !s.deletedAt ? clone(s) : null; },
    listerScenarios: async (_db: unknown, f: any) => {
      const l = [...h.scenarios.values()].filter((s) => !s.deletedAt && (f.annee == null || s.annee === f.annee));
      return { total: l.length, lignes: l.map(({ entreesCanoniques: _e, resultatCanonique: _r, ...r }) => r) };
    },
    supprimerScenarioLogiquement: async (_db: unknown, id: string) => { const s = h.scenarios.get(id); if (s) s.deletedAt = new Date(); return s ? 1 : 0; },
    fichesDuScenario: async (_db: unknown, sid: string) => [...h.fiches.values()].filter((f) => f.scenarioId === sid).map((f) => ({ id: f.id, tronconId: f.tronconId })),
    insererFiche: async (_db: unknown, f: any) => { h.fiches.set(f.id, { ...f, figeLe: new Date("2026-10-23T10:00:00Z") }); },
    lireFiche: async (_db: unknown, id: string) => clone(h.fiches.get(id) ?? null),
    lireFicheCourante: async (_db: unknown, id: string) => {
      const f = h.fiches.get(id);
      const rang = rangMax(id);
      const s = h.statuts.find((x) => x.ficheId === id && x.rang === rang);
      return f && s ? { id, reference: f.reference, scenarioId: f.scenarioId, tronconId: f.tronconId, annee: f.annee, parametresVersion: f.parametresVersion, empreinteSha256: f.empreinteSha256, figeLe: f.figeLe, figeParId: f.figeParId, statut: s.vers, rangStatut: rang, statutDepuis: s.enregistreLe } : null;
    },
    listerFiches: async () => ({ total: h.fiches.size, lignes: [] }),
    insererStatut: async (_db: unknown, s: any) => { h.statuts.push({ ...s, enregistreLe: new Date("2026-10-23T10:00:01Z") }); },
    historiqueStatuts: async (_db: unknown, id: string) => h.statuts.filter((s) => s.ficheId === id).sort((a, b) => a.rang - b.rang),
    _valeursAmorcage: VALEURS_AMORCAGE_PROVISOIRES,
  };
});

import { moteurProgrammationV2Router } from "./programmation.moteur.routes";
import { VALEURS_AMORCAGE_PROVISOIRES } from "../programmation/parametres.noyau";

const app = express();
app.use(express.json({ limit: "20mb" }), moteurProgrammationV2Router);

const SEED = { id: "p-seed", version: "prog-provisoire-1", source: "amorcage_provisoire", valeurs: structuredClone(VALEURS_AMORCAGE_PROVISOIRES), motif: "amorcage", creeParId: null, createdAt: new Date("2026-10-23T00:00:00Z"), approuveeLe: null, approuveeParId: null, deletedAt: null };

beforeEach(() => {
  h.compte = { id: "u1", role: "GESTIONNAIRE", email: "g@essai.invalid" };
  h.parametres = [structuredClone(SEED)];
  h.scenarios.clear(); h.fiches.clear(); h.statuts = []; h.audit = []; h.baremes = null; h.nbCandidats = 0;
});

const corpsSim = (o: Record<string, unknown> = {}) => ({ annee: 2027, intitule: "PAE 2027 essai", budgetGnf: "5000000000", ...o });
async function simuler(o: Record<string, unknown> = {}) {
  const r = await request(app).post("/simulations").send(corpsSim(o));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { scenario: { id: string; empreinteResultat: string }; resultat: any };
}

describe("aucune route ne modifie ni ne supprime", () => {
  it("le routeur n'expose ni PUT, ni PATCH, ni DELETE", () => {
    const methodes = new Set<string>();
    for (const l of (moteurProgrammationV2Router as unknown as { stack: Array<{ route?: { methods: Record<string, boolean> } }> }).stack) {
      for (const m of Object.keys(l.route?.methods ?? {})) methodes.add(m);
    }
    expect([...methodes].sort()).toEqual(["get", "post"]);
  });
});

describe("parametres", () => {
  it("GET liste les versions, PROVISOIRES tant qu'elles ne sont pas approuvees", async () => {
    const r = await request(app).get("/parametres");
    expect(r.status).toBe(200);
    expect(r.body.data[0]).toMatchObject({ version: "prog-provisoire-1", provisoire: true, etiquette: "PROVISOIRE, non approuvé", approuveeLe: null });
  });

  it("POST cree une NOUVELLE version provisoire, signee par la session, et l'audite", async () => {
    const r = await request(app).post("/parametres").send({ version: "prog-essai-2", valeurs: { ...VALEURS_AMORCAGE_PROVISOIRES, facteursMinimum: 2 }, motif: "essai" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ version: "prog-essai-2", source: "saisie", provisoire: true, creeParId: "u1" });
    expect(h.audit).toMatchObject([{ action: "CREATE", entityType: "ParametresProgrammation", userId: "u1" }]);
  });

  it("refuse un corps qui tente de poser l'approbation ou la source (schema strict)", async () => {
    const r = await request(app).post("/parametres").send({ version: "prog-essai-3", valeurs: VALEURS_AMORCAGE_PROVISOIRES, approuveeLe: "2026-01-01T00:00:00Z", source: "amorcage_provisoire" });
    expect(r.status).toBe(400);
    expect(h.parametres).toHaveLength(1);
    expect(h.audit).toHaveLength(0);
  });

  it("refuse des valeurs incoherentes avec toutes leurs erreurs, sans rien ecrire", async () => {
    const r = await request(app).post("/parametres").send({ version: "prog-essai-4", valeurs: { ...VALEURS_AMORCAGE_PROVISOIRES, traficPlafondJma: 0, horizonAnnees: 0 } });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("PARAMETRES_INVALIDES");
    expect(r.body.error).toMatch(/traficPlafondJma/);
    expect(r.body.error).toMatch(/horizonAnnees/);
    expect(h.parametres).toHaveLength(1);
  });

  it("refuse une version dont le nom est invalide, ou deja prise (une version est immuable)", async () => {
    expect((await request(app).post("/parametres").send({ version: "PROG X", valeurs: VALEURS_AMORCAGE_PROVISOIRES })).status).toBe(400);
    const r = await request(app).post("/parametres").send({ version: "prog-provisoire-1", valeurs: VALEURS_AMORCAGE_PROVISOIRES });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("VERSION_EXISTANTE");
  });

  it("un LECTEUR lit mais n'ecrit pas", async () => {
    h.compte.role = "LECTEUR";
    expect((await request(app).get("/parametres")).status).toBe(200);
    expect((await request(app).post("/parametres").send({ version: "prog-essai-5", valeurs: VALEURS_AMORCAGE_PROVISOIRES })).status).toBe(403);
  });

  it("approuver est reserve a l'ADMIN, audite VALIDATE, et ne se fait pas deux fois", async () => {
    expect((await request(app).post("/parametres/p-seed/approuver")).status).toBe(403);
    h.compte = { id: "admin1", role: "ADMIN", email: "a@essai.invalid" };
    const r = await request(app).post("/parametres/p-seed/approuver");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ provisoire: false, etiquette: "paramètres approuvés", approuveeParId: "admin1" });
    expect(h.audit).toMatchObject([{ action: "VALIDATE", entityType: "ParametresProgrammation", entityId: "p-seed", userId: "admin1" }]);
    const encore = await request(app).post("/parametres/p-seed/approuver");
    expect(encore.status).toBe(409);
    expect(encore.body.code).toBe("DEJA_APPROUVEE");
  });

  it("desapprouver exige un motif, ADMIN seulement, et le conserve dans l'audit", async () => {
    h.compte = { id: "admin1", role: "ADMIN", email: "a@essai.invalid" };
    await request(app).post("/parametres/p-seed/approuver");
    h.audit = [];
    expect((await request(app).post("/parametres/p-seed/desapprouver").send({})).status).toBe(400);
    const r = await request(app).post("/parametres/p-seed/desapprouver").send({ motif: "valeurs a revoir" });
    expect(r.status).toBe(200);
    expect(r.body.provisoire).toBe(true);
    expect(h.audit).toMatchObject([{ action: "UPDATE", entityType: "ParametresProgrammation", after: { motif: "valeurs a revoir", desapprouveeParId: "admin1" } }]);
    h.compte.role = "GESTIONNAIRE";
    expect((await request(app).post("/parametres/p-seed/desapprouver").send({ motif: "xxx yyy" })).status).toBe(403);
  });

  it("un inconnu : 404", async () => {
    h.compte.role = "ADMIN";
    expect((await request(app).post("/parametres/nope/approuver")).status).toBe(404);
  });
});

describe("simulations", () => {
  it("calcule, justifie et enregistre : PROVISOIRE, version des parametres, empreinte, audit", async () => {
    const { scenario, resultat } = await simuler();
    expect(scenario.empreinteResultat).toMatch(/^[0-9a-f]{64}$/);
    expect(resultat.etiquette).toBe("PROVISOIRE, non approuvé");
    expect(resultat.provisoire).toBe(true);
    expect(resultat.parametres).toMatchObject({ version: "prog-provisoire-1", etiquette: "PROVISOIRE, non approuvé" });
    expect(resultat.lignes.every((l: any) => l.justification.length > 30 && l.etiquette === "PROVISOIRE, non approuvé")).toBe(true);
    // 5 Md : C (0,8) retenue, A (4,4) ecartee pour budget, B (3,5) retenue
    expect(resultat.lignes.map((l: any) => `${l.troncon.code}:${l.decision}`)).toEqual(["RN-C:RETENUE", "RN-A:ECARTEE", "RN-B:RETENUE"]);
    expect(resultat.totaux).toMatchObject({ engageGnf: "4300000000", resteGnf: "700000000" });
    expect(h.audit).toMatchObject([{ action: "CREATE", entityType: "ScenarioProgrammation", userId: "u1", after: { retenues: 2, engageGnf: "4300000000", parametresVersion: "prog-provisoire-1" } }]);
    expect(h.scenarios.size).toBe(1);
  });

  it("l'auteur vient de la session, pas du corps (schema strict)", async () => {
    const r = await request(app).post("/simulations").send(corpsSim({ creeParId: "pirate" }));
    expect(r.status).toBe(400);
    const ok = await simuler();
    expect(h.scenarios.get(ok.scenario.id)!.creeParId).toBe("u1");
  });

  it("le budget est une chaine de chiffres : un nombre JSON ou un decimal est refuse", async () => {
    expect((await request(app).post("/simulations").send(corpsSim({ budgetGnf: 5000000000 }))).status).toBe(400);
    expect((await request(app).post("/simulations").send(corpsSim({ budgetGnf: "5e9" }))).status).toBe(400);
    expect((await request(app).post("/simulations").send(corpsSim({ budgetGnf: "-5" }))).status).toBe(400);
    expect((await request(app).post("/simulations").send(corpsSim({ budgetGnf: "9007199254740993000" }))).status).toBe(400);
    expect(h.scenarios.size).toBe(0);
    expect(h.audit).toHaveLength(0);
  });

  it("un montant superieur a 2^53 est conserve a l'unite pres", async () => {
    const r = await simuler({ budgetGnf: "900719925474099300" });
    expect(r.resultat.budgetGnf).toBe("900719925474099300");
    expect(r.resultat.totaux.resteGnf).toBe((900719925474099300n - 8_700_000_000n).toString());
  });

  it("sans bareme, le moteur de cout REFUSE : rien n'est chiffre, rien n'est retenu", async () => {
    h.baremes = [];
    const { resultat } = await simuler({ budgetGnf: "100000000000" });
    expect(resultat.totaux).toMatchObject({ retenues: 0, engageGnf: "0" });
    expect(resultat.lignes.every((l: any) => l.motifExclusion.code === "COUT_NON_ESTIMABLE" && /AUCUNE_LIGNE_DE_BAREME/.test(l.motifExclusion.detail))).toBe(true);
  });

  it("deux versions provisoires, aucune approuvee : PARAMETRES_A_PRECISER, rien n'est ecrit", async () => {
    h.parametres.push({ ...structuredClone(SEED), id: "p2", version: "prog-essai-2" });
    const r = await request(app).post("/simulations").send(corpsSim());
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("PARAMETRES_A_PRECISER");
    expect(h.scenarios.size).toBe(0);
    const ok = await request(app).post("/simulations").send(corpsSim({ parametresId: "p2" }));
    expect(ok.status).toBe(201);
    expect(ok.body.resultat.parametres.version).toBe("prog-essai-2");
  });

  it("une version approuvee est choisie par defaut, et le scenario le dit", async () => {
    h.parametres.push({ ...structuredClone(SEED), id: "p2", version: "prog-essai-2", approuveeLe: new Date("2026-10-23T08:00:00Z"), approuveeParId: "admin1" });
    const { resultat } = await simuler();
    expect(resultat.parametres).toMatchObject({ version: "prog-essai-2", etiquette: "paramètres approuvés" });
    expect(resultat.provisoire).toBe(true); // bareme, catalogue et matrices restent non approuves
    expect(resultat.motifsProvisoire.join()).not.toMatch(/paramètres de programmation non approuvés/);
  });

  it("des parametres inconnus : 422 PARAMETRES_INTROUVABLES", async () => {
    const r = await request(app).post("/simulations").send(corpsSim({ parametresId: "nope" }));
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("PARAMETRES_INTROUVABLES");
  });

  it("un perimetre de plus de 3000 troncons est refuse (PERIMETRE_TROP_LARGE)", async () => {
    h.nbCandidats = 3001;
    const r = await request(app).post("/simulations").send(corpsSim());
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("PERIMETRE_TROP_LARGE");
    expect(h.scenarios.size).toBe(0);
  });

  it("un LECTEUR ne lance pas de simulation", async () => {
    h.compte.role = "LECTEUR";
    expect((await request(app).post("/simulations").send(corpsSim())).status).toBe(403);
  });

  it("liste et lecture : le scenario complet reste lisible ligne par ligne", async () => {
    const { scenario } = await simuler();
    const liste = await request(app).get("/simulations");
    expect(liste.status).toBe(200);
    expect(liste.body.total).toBe(1);
    expect(liste.body.data[0]).toMatchObject({ id: scenario.id, budgetGnf: "5000000000", provisoire: true, nbRetenues: 2 });
    expect(liste.body.data[0].resultatCanonique).toBeUndefined();
    const un = await request(app).get(`/simulations/${scenario.id}`);
    expect(un.status).toBe(200);
    expect(un.body.resultat.lignes).toHaveLength(3);
    expect((await request(app).get("/simulations/inconnu")).status).toBe(404);
    expect((await request(app).get("/simulations?annee=abc")).status).toBe(400);
  });
});

describe("rejeu", () => {
  it("rejoue depuis les seules entrees stockees : identique octet pour octet", async () => {
    const { scenario } = await simuler();
    const r = await request(app).post(`/simulations/${scenario.id}/rejouer`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ identique: true, entreesIntegres: true, empreinteRecalculee: scenario.empreinteResultat, empreinteStockee: scenario.empreinteResultat });
    expect(h.audit).toHaveLength(1); // seule la creation est ecrite : rejouer ne n'ecrit rien
  });

  it("un resultat stocke qui differe du recalcul est signale, sans rien modifier", async () => {
    const { scenario } = await simuler();
    h.scenarios.get(scenario.id)!.resultatCanonique = '{"altere":true}';
    const r = await request(app).post(`/simulations/${scenario.id}/rejouer`);
    expect(r.body.identique).toBe(false);
    expect(r.body.explication).toMatch(/diffère/);
  });

  it("des entrees stockees illisibles : 422, pas une panne", async () => {
    const { scenario } = await simuler();
    h.scenarios.get(scenario.id)!.entreesCanoniques = '{"budgetGnf":5}';
    const r = await request(app).post(`/simulations/${scenario.id}/rejouer`);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("ENTREES_ILLISIBLES");
  });
});

describe("suppression logique d'un scenario", () => {
  it("pose deletedAt, audite DELETE, et le scenario disparait de la lecture", async () => {
    const { scenario } = await simuler();
    h.audit = [];
    const r = await request(app).post(`/simulations/${scenario.id}/supprimer`);
    expect(r.status).toBe(200);
    expect(h.scenarios.get(scenario.id)!.deletedAt).toBeInstanceOf(Date);
    expect(h.audit).toMatchObject([{ action: "DELETE", entityType: "ScenarioProgrammation", entityId: scenario.id }]);
    expect((await request(app).get(`/simulations/${scenario.id}`)).status).toBe(404);
    expect((await request(app).get("/simulations")).body.total).toBe(0);
  });

  it("refuse tant qu'une fiche figee le cite", async () => {
    const { scenario } = await simuler({ budgetGnf: "100000000000" });
    await request(app).post(`/simulations/${scenario.id}/fiches`).send({});
    const r = await request(app).post(`/simulations/${scenario.id}/supprimer`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("SCENARIO_UTILISE");
  });
});

describe("fiches d'intervention", () => {
  it("fige toutes les lignes retenues, chacune BROUILLON, auditee, avec l'empreinte du texte", async () => {
    const { scenario } = await simuler({ budgetGnf: "100000000000" });
    h.audit = [];
    const r = await request(app).post(`/simulations/${scenario.id}/fiches`).send({ sourceFinancement: "FER (essai)" });
    expect(r.status).toBe(201);
    expect(r.body.fiches).toHaveLength(3);
    expect(r.body.provisoire).toBe(true);
    expect(h.fiches.size).toBe(3);
    expect(h.statuts.every((s) => s.rang === 1 && s.vers === "BROUILLON" && s.origine === "GEOPORTAIL" && s.auteurId === "u1")).toBe(true);
    expect(h.audit.filter((a) => a.action === "CREATE" && a.entityType === "FicheIntervention")).toHaveLength(3);
    const f = [...h.fiches.values()][0];
    expect(f.empreinteSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(f.contenuCanonique).financement.source).toBe("FER (essai)");
    expect(f.figeParId).toBe("u1");
  });

  it("refuse de figer une ligne ecartee : rien n'est ecrit (tout ou rien)", async () => {
    const { scenario, resultat } = await simuler(); // A est ecartee (budget)
    const ecartee = resultat.lignes.find((l: any) => l.decision === "ECARTEE").troncon.id;
    const retenue = resultat.lignes.find((l: any) => l.decision === "RETENUE").troncon.id;
    const r = await request(app).post(`/simulations/${scenario.id}/fiches`).send({ tronconIds: [retenue, ecartee] });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("LIGNE_NON_RETENUE");
    expect(h.fiches.size).toBe(0);
  });

  it("refuse un troncon absent du scenario, et un scenario qui ne retient rien", async () => {
    const { scenario } = await simuler();
    expect((await request(app).post(`/simulations/${scenario.id}/fiches`).send({ tronconIds: ["inconnu"] })).body.code).toBe("TRONCON_ABSENT_DU_SCENARIO");
    const vide = await simuler({ budgetGnf: "0" });
    const r = await request(app).post(`/simulations/${vide.scenario.id}/fiches`).send({});
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("AUCUNE_LIGNE_RETENUE");
  });

  it("figer deux fois la meme ligne : 409 FICHE_DEJA_FIGEE", async () => {
    const { scenario, resultat } = await simuler();
    const id = resultat.lignes.find((l: any) => l.decision === "RETENUE").troncon.id;
    expect((await request(app).post(`/simulations/${scenario.id}/fiches`).send({ tronconIds: [id] })).status).toBe(201);
    const r = await request(app).post(`/simulations/${scenario.id}/fiches`).send({ tronconIds: [id] });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("FICHE_DEJA_FIGEE");
    expect(h.fiches.size).toBe(1);
  });

  it("la verification recalcule l'empreinte ; un texte altere est detecte", async () => {
    const { scenario } = await simuler({ budgetGnf: "100000000000" });
    await request(app).post(`/simulations/${scenario.id}/fiches`).send({});
    const [id, f] = [...h.fiches.entries()][0];
    expect((await request(app).get(`/fiches/${id}/verification`)).body.verdict).toEqual({ ok: true });
    f.contenuCanonique = f.contenuCanonique.replace('"montantGnf":"', '"montantGnf":"9');
    const v = await request(app).get(`/fiches/${id}/verification`);
    expect(v.body.verdict).toMatchObject({ ok: false, code: "EMPREINTE_DIFFERENTE" });
  });

  it("lit une fiche : contenu, statut courant et historique", async () => {
    const { scenario } = await simuler({ budgetGnf: "100000000000" });
    await request(app).post(`/simulations/${scenario.id}/fiches`).send({});
    const id = [...h.fiches.keys()][0];
    const r = await request(app).get(`/fiches/${id}`);
    expect(r.status).toBe(200);
    expect(r.body.fiche).toMatchObject({ statut: "BROUILLON", rangStatut: 1 });
    expect(r.body.contenu.schema).toBe("fiche-intervention/1");
    expect(r.body.contenu.etiquette).toBe("PROVISOIRE, non approuvé");
    expect(r.body.historique).toHaveLength(1);
    expect((await request(app).get("/fiches/inconnue")).status).toBe(404);
  });

  it("jamais de route de modification : PATCH, PUT et DELETE sur une fiche n'existent pas (404)", async () => {
    for (const m of ["patch", "put", "delete"] as const) expect((await request(app)[m]("/fiches/abc")).status).toBe(404);
  });
});

describe("cycle de vie : la frontiere DigitalRoad", () => {
  async function uneFiche() {
    const { scenario } = await simuler({ budgetGnf: "100000000000" });
    await request(app).post(`/simulations/${scenario.id}/fiches`).send({});
    h.audit = [];
    return [...h.fiches.keys()][0];
  }

  /**
   * Fait avancer la fiche jusqu'a APPROUVE comme le fait l'equipe depuis AD-07 : le compte qui a cree le scenario et fige la
   * fiche (u1) la propose et l'arbitre, un AUTRE compte (u2) l'approuve. Avant ce lot, u1 faisait les trois pas seul : ce
   * contrat de test a change legitimement (separation des taches), pas le cycle de vie. Rend le compte courant a u1.
   */
  async function jusquaApprouve(id: string) {
    for (const v of ["PROPOSE", "ARBITRE"]) await request(app).post(`/fiches/${id}/statut`).send({ vers: v });
    h.compte = { id: "u2", role: "GESTIONNAIRE", email: "g2@essai.invalid" };
    const r = await request(app).post(`/fiches/${id}/statut`).send({ vers: "APPROUVE" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    h.compte = { id: "u1", role: "GESTIONNAIRE", email: "g@essai.invalid" };
  }

  it("BROUILLON vers PROPOSE : accepte, audite, rang suivant", async () => {
    const id = await uneFiche();
    const r = await request(app).post(`/fiches/${id}/statut`).send({ vers: "PROPOSE" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ de: "BROUILLON", vers: "PROPOSE", rang: 2, recule: false });
    expect(h.statuts.at(-1)).toMatchObject({ rang: 2, de: "BROUILLON", vers: "PROPOSE", origine: "GEOPORTAIL", auteurId: "u1" });
    expect(h.audit).toMatchObject([{ action: "UPDATE", entityType: "FicheIntervention", before: { statut: "BROUILLON" }, after: { statut: "PROPOSE" } }]);
  });

  it("saut d'etape : 409 TRANSITION_INEXISTANTE", async () => {
    const id = await uneFiche();
    const r = await request(app).post(`/fiches/${id}/statut`).send({ vers: "APPROUVE" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("TRANSITION_INEXISTANTE");
  });

  it("un recul sans motif : 400 RETOUR_NON_MOTIVE ; avec motif : accepte", async () => {
    const id = await uneFiche();
    await request(app).post(`/fiches/${id}/statut`).send({ vers: "PROPOSE" });
    expect((await request(app).post(`/fiches/${id}/statut`).send({ vers: "BROUILLON" })).body.code).toBe("RETOUR_NON_MOTIVE");
    const r = await request(app).post(`/fiches/${id}/statut`).send({ vers: "BROUILLON", motif: "erreur de saisie" });
    expect(r.status).toBe(201);
    expect(r.body.recule).toBe(true);
  });

  it.each(["TRANSMIS", "EN_EXECUTION", "ACHEVE", "EVALUE"])("%s depuis le Geoportail : refuse, meme pour un ADMIN", async (vers) => {
    const id = await uneFiche();
    await jusquaApprouve(id);
    h.compte = { id: "admin1", role: "ADMIN", email: "a@essai.invalid" };
    const r = await request(app).post(`/fiches/${id}/statut`).send({ vers, motif: "je force" });
    expect([403, 409]).toContain(r.status);
    expect(["ORIGINE_INTERDITE", "TRANSITION_INEXISTANTE"]).toContain(r.body.code);
    expect(h.statuts.at(-1)!.vers).toBe("APPROUVE");
  });

  it("APPROUVE vers TRANSMIS : 403 ORIGINE_INTERDITE (le statut est recu de DigitalRoad, pas saisi)", async () => {
    const id = await uneFiche();
    await jusquaApprouve(id);
    const r = await request(app).post(`/fiches/${id}/statut`).send({ vers: "TRANSMIS" });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("ORIGINE_INTERDITE");
    expect(r.body.error).toMatch(/ne se saisit pas dans le Geoportail/);
  });

  it("le corps ne connait pas l'origine, le message DigitalRoad, l'inspection ni la version figee (schema strict)", async () => {
    const id = await uneFiche();
    await jusquaApprouve(id);
    for (const extra of [{ origine: "DIGITALROAD" }, { messageDigitalRoadId: "msg-1" }, { inspectionId: "i-1" }, { versionFigee: "a".repeat(64) }]) {
      const r = await request(app).post(`/fiches/${id}/statut`).send({ vers: "TRANSMIS", ...extra });
      expect(r.status, JSON.stringify(extra)).toBe(400);
    }
    expect(h.statuts.at(-1)!.vers).toBe("APPROUVE");
  });

  it("un LECTEUR ne fait pas avancer une fiche ; une fiche inconnue : 404 ; un statut inconnu : 400", async () => {
    const id = await uneFiche();
    expect((await request(app).post(`/fiches/${id}/statut`).send({ vers: "BIZARRE" })).status).toBe(400);
    expect((await request(app).post("/fiches/inconnue/statut").send({ vers: "PROPOSE" })).status).toBe(404);
    h.compte.role = "LECTEUR";
    expect((await request(app).post(`/fiches/${id}/statut`).send({ vers: "PROPOSE" })).status).toBe(403);
  });
});

/**
 * SEPARATION DES TACHES (AD-07, lot AD-7). Avant ce lot : un ADMIN creait puis approuvait ses propres poids, et un seul
 * GESTIONNAIRE figeait un scenario puis faisait avancer sa fiche jusqu'a APPROUVE. Maintenant : l'approbateur n'est jamais
 * un intervenant precedent (code stable AUTO_VALIDATION, 403), et l'audit garde les VALEURS des poids.
 */
describe("separation des taches : parametres (AD-07)", () => {
  const admin = (id: string) => { h.compte = { id, role: "ADMIN", email: `${id}@essai.invalid` }; };

  it("un ADMIN ne peut pas approuver la version qu'il a creee : 403 AUTO_VALIDATION, rien n'est approuve ni audite VALIDATE", async () => {
    admin("admin1");
    const c = await request(app).post("/parametres").send({ version: "prog-sod-1", valeurs: VALEURS_AMORCAGE_PROVISOIRES, motif: "essai" });
    expect(c.status).toBe(201);
    h.audit = [];
    const r = await request(app).post(`/parametres/${c.body.id}/approuver`);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("AUTO_VALIDATION");
    expect(r.body.error).toMatch(/ne peut pas être validé par la personne qui l'a produit/);
    expect(h.parametres.find((p) => p.id === c.body.id)!.approuveeLe).toBeNull();
    expect(h.audit.filter((a) => a.action === "VALIDATE")).toEqual([]);
  });

  it("un AUTRE ADMIN l'approuve : 200, audite VALIDATE", async () => {
    admin("admin1");
    const c = await request(app).post("/parametres").send({ version: "prog-sod-2", valeurs: VALEURS_AMORCAGE_PROVISOIRES });
    admin("admin2");
    const r = await request(app).post(`/parametres/${c.body.id}/approuver`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ provisoire: false, approuveeParId: "admin2", creeParId: "admin1" });
  });

  it("une version amorcee sans auteur (creeParId nul) reste approuvable par tout ADMIN", async () => {
    admin("admin1");
    expect((await request(app).post("/parametres/p-seed/approuver")).status).toBe(200);
  });

  it("l'audit garde les VALEURS : CREATE apres, VALIDATE avant et apres (poids relisibles)", async () => {
    admin("admin1");
    const c = await request(app).post("/parametres").send({ version: "prog-sod-3", valeurs: VALEURS_AMORCAGE_PROVISOIRES });
    const creation = h.audit.find((a) => a.action === "CREATE" && a.entityType === "ParametresProgrammation")!;
    expect(creation.after.valeurs).toEqual(JSON.parse(JSON.stringify(VALEURS_AMORCAGE_PROVISOIRES)));
    admin("admin2");
    await request(app).post(`/parametres/${c.body.id}/approuver`);
    const validation = h.audit.find((a) => a.action === "VALIDATE")!;
    expect(validation.before.valeurs).toEqual(creation.after.valeurs);
    expect(validation.after.valeurs).toEqual(creation.after.valeurs);
  });
});

describe("separation des taches : fiches (AD-07)", () => {
  const gest = (id: string) => { h.compte = { id, role: "GESTIONNAIRE", email: `${id}@essai.invalid` }; };
  async function ficheArbitree(simulateur = "u1", figeur = "u1", arbitre = "u1") {
    gest(simulateur);
    const { scenario } = await simuler({ budgetGnf: "100000000000" });
    gest(figeur);
    await request(app).post(`/simulations/${scenario.id}/fiches`).send({});
    const id = [...h.fiches.keys()][0];
    gest(arbitre);
    for (const v of ["PROPOSE", "ARBITRE"]) expect((await request(app).post(`/fiches/${id}/statut`).send({ vers: v })).status).toBe(201);
    h.audit = [];
    return id;
  }

  it("celui qui a fige la fiche ne peut pas l'approuver : 403 AUTO_VALIDATION, le statut reste ARBITRE", async () => {
    const id = await ficheArbitree();
    const r = await request(app).post(`/fiches/${id}/statut`).send({ vers: "APPROUVE" });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("AUTO_VALIDATION");
    expect(r.body.error).toMatch(/a créé le scénario|a figé cette fiche/);
    expect(h.statuts.at(-1)!.vers).toBe("ARBITRE");
    expect(h.audit).toEqual([]);
  });

  it("l'auteur du scenario ne l'approuve pas non plus, meme s'il n'a pas fige la fiche", async () => {
    const id = await ficheArbitree("u1", "u2", "u2");
    gest("u1");
    const r = await request(app).post(`/fiches/${id}/statut`).send({ vers: "APPROUVE" });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/a créé le scénario/);
  });

  it("celui qui a arbitre ne l'approuve pas : arbitrage et approbation sont deux regards", async () => {
    const id = await ficheArbitree("u1", "u1", "u2");
    gest("u2");
    const r = await request(app).post(`/fiches/${id}/statut`).send({ vers: "APPROUVE" });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/a fait passer cette fiche à (PROPOSE|ARBITRE)/);
  });

  it("un compte etranger a la chaine approuve : 201, audite", async () => {
    const id = await ficheArbitree("u1", "u1", "u2");
    gest("u3");
    const r = await request(app).post(`/fiches/${id}/statut`).send({ vers: "APPROUVE" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ de: "ARBITRE", vers: "APPROUVE" });
    expect(h.audit).toMatchObject([{ action: "UPDATE", entityType: "FicheIntervention", after: { statut: "APPROUVE" } }]);
  });

  it("un ADMIN auteur n'echappe pas a la regle", async () => {
    h.compte = { id: "adm", role: "ADMIN", email: "adm@essai.invalid" };
    const { scenario } = await simuler({ budgetGnf: "100000000000" });
    await request(app).post(`/simulations/${scenario.id}/fiches`).send({});
    const id = [...h.fiches.keys()][0];
    for (const v of ["PROPOSE", "ARBITRE"]) await request(app).post(`/fiches/${id}/statut`).send({ vers: v });
    expect((await request(app).post(`/fiches/${id}/statut`).send({ vers: "APPROUVE" })).status).toBe(403);
  });

  it("les autres etapes ne sont pas gelees : le figeur propose et arbitre, et un recul motive reste possible", async () => {
    const id = await ficheArbitree("u1", "u1", "u1");
    gest("u3");
    await request(app).post(`/fiches/${id}/statut`).send({ vers: "APPROUVE" });
    gest("u1");
    const r = await request(app).post(`/fiches/${id}/statut`).send({ vers: "ARBITRE", motif: "montant a revoir" });
    expect(r.status).toBe(201);
  });
});

describe("rien ne cree d'engagement", () => {
  it("aucune route n'ecrit hors des tables du moteur : seuls les types d'entite du moteur sont audites", async () => {
    const { scenario } = await simuler({ budgetGnf: "100000000000" });
    await request(app).post(`/simulations/${scenario.id}/fiches`).send({});
    const id = [...h.fiches.keys()][0];
    await request(app).post(`/fiches/${id}/statut`).send({ vers: "PROPOSE" });
    await request(app).post(`/simulations/${scenario.id}/rejouer`);
    const types = new Set(h.audit.map((a) => a.entityType));
    expect([...types].sort()).toEqual(["FicheIntervention", "ScenarioProgrammation"]);
    expect(JSON.stringify(h.audit)).not.toMatch(/Marche|Chantier|OrdreTravaux|Decompte|ProgrammeBudgetaire/);
    expect((await request(app).get(`/simulations/${scenario.id}`)).body.resultat.avertissement).toMatch(/ne crée de marché, contrat, ordre de travaux/);
  });
});
