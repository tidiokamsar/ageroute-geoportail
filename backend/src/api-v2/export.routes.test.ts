import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createHash } from "node:crypto";

/**
 * `/api/v2/export/selection` — ce que ces tests defendent (durci par le lot 6).
 *
 * LA LISTE BLANCHE EST LE MUR, pour les tables ET pour les colonnes : aucune table hors liste ne passe, et le SQL ne lit que
 * des colonnes nommees (jamais `row_to_json(t.*)`, qui remettait aussi les montants des marches).
 *
 * LE TERRITOIRE SE CONTROLE PAR LIGNE, en base : un compte regional ne recoit que les lignes de ses regions.
 *
 * AUCUNE COLONNE FINANCIERE sans droit financier ; LES LIGNES ARCHIVEES NE SORTENT PAS ; chaque fichier porte date, auteur,
 * perimetre, nombre de lignes et mention ; un journal (empreinte du fichier) est ecrit AVANT la remise.
 *
 * UN REFUS DE MODULE REPOND (la promesse n'est plus pendante) ; LE GEOJSON SORT (plus d'operateur `-` sur du texte).
 */
const h = vi.hoisted(() => ({
  compte: { id: "u1", role: "GESTIONNAIRE", email: "gest@ageroute.gov.gn" } as { id: string; role: string; email: string },
  modules: null as Set<string> | null,
  perimetre: { national: true } as { national: true } | { national: false; regions: Set<number> },
  requetes: [] as Array<{ sql: string; params: unknown[] }>,
  journal: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  journalEchoue: false,
}));

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { ...h.compte };
    n();
  },
}));
vi.mock("../lib/access", () => ({
  modulesAutorisesDe: vi.fn(async () => h.modules),
  moduleAutorise: (m: Set<string> | null, k: string) => m === null || m.has(k),
}));
vi.mock("../territoire/territoire.service", () => ({ perimetreDe: vi.fn(async () => h.perimetre) }));
vi.mock("../utils/audit", () => ({
  logAuditTransactionnelle: vi.fn(async (_tx: unknown, p: Record<string, unknown>) => { h.audits.push(p); }),
}));
vi.mock("../lib/prisma", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async (sql: string, ...params: unknown[]) => {
      h.requetes.push({ sql, params });
      return [
        { fid: "o1", props: JSON.stringify({ id: "o1", nom: "Pont de Kindia", etat: "MOYEN" }), geojson: JSON.stringify({ type: "Point", coordinates: [-13.6, 9.64] }) },
        { fid: "o2", props: JSON.stringify({ id: "o2", nom: "=HYPERLINK(\"http://x\")", etat: "BON" }), geojson: null },
      ];
    }),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      exportJournal: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { if (h.journalEchoue) throw new Error("journal en panne"); h.journal.push(data); }) },
    })),
  },
}));

import { exportV2Router, TABLES } from "./export.routes";

const app = express();
app.use(express.json(), exportV2Router);
app.use((err: Error, _q: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(500).json({ error: err.message }); });

beforeEach(() => {
  h.compte = { id: "u1", role: "GESTIONNAIRE", email: "gest@ageroute.gov.gn" };
  h.modules = null; h.perimetre = { national: true };
  h.requetes = []; h.journal = []; h.audits = []; h.journalEchoue = false;
});

const post = (corps: unknown) => request(app).post("/selection").send(corps as object);

describe("POST /api/v2/export/selection : le contenu", () => {
  it("CSV point-virgule BOM, avec exactement les ids demandes, et l'en-tete (date, auteur, perimetre, mention, lignes)", async () => {
    const r = await post({ table: "ouvrages", format: "csv", ids: ["o1", "o2"] });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("text/csv");
    expect(r.text.startsWith("﻿")).toBe(true);
    expect(r.text).toContain("Pont de Kindia");
    expect(h.requetes[0].params[0]).toEqual(["o1", "o2"]);
    expect(r.text).toMatch(/# genere_le;\d{4}-\d{2}-\d{2}T/);
    expect(r.text).toContain("# auteur;gest@ageroute.gov.gn (GESTIONNAIRE)");
    expect(r.text).toContain("# perimetre;National");
    expect(r.text).toContain("# nb_lignes;2");
    expect(r.text).toMatch(/# mention;Consultatif, non engageant/);
    expect(r.text).toContain("2 ligne(s) exportee(s)");
  });

  it("une cellule qui commence par = est neutralisee (pas de formule dans le tableur)", async () => {
    const r = await post({ table: "ouvrages", format: "csv", ids: ["o1", "o2"] });
    expect(r.text).toContain("'=HYPERLINK");
    expect(r.text).not.toMatch(/;=HYPERLINK/);
  });

  it("GeoJSON : le SQL est valide (ni row_to_json, ni operateur - sur du texte), geometrie WGS84, en-tete en membre etranger", async () => {
    const r = await post({ table: "ouvrages", format: "geojson", ids: ["o1", "o2"] });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("application/geo+json");
    const sql = h.requetes[0].sql;
    expect(sql).toContain("ST_AsGeoJSON");
    expect(sql).not.toMatch(/row_to_json|- 'geom'|t\.\*/);
    const j = JSON.parse(r.text);
    expect(j.type).toBe("FeatureCollection");
    expect(j.features[0].geometry.coordinates).toEqual([-13.6, 9.64]);
    expect(j.features[0].properties.nom).toBe("Pont de Kindia");
    expect(j.features[1].geometry).toBeNull();
    expect(j.metadonnees.mention).toMatch(/Consultatif, non engageant/);
    expect(j.metadonnees.auteur.email).toBe("gest@ageroute.gov.gn");
    expect(j.metadonnees.nbLignes).toBe(2);
  });

  it("refuse le GeoJSON sur une table sans geometrie", async () => {
    const r = await post({ table: "marches", format: "geojson", ids: ["m1"] });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("SANS_GEOMETRIE");
  });
});

describe("liste blanche de tables et de colonnes", () => {
  it.each(["users", "troncons; DROP TABLE users", "__proto__", "constructor", "toString", "TRONCONS"])("refuse la table %s", async (t) => {
    const r = await post({ table: t, format: "csv", ids: ["x"] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("TABLE_REFUSEE");
    expect(h.requetes).toHaveLength(0);
  });

  it("le SQL ne lit que des colonnes nommees (jamais t.* ni row_to_json), tables et colonnes viennent de la liste blanche", async () => {
    for (const [nom, def] of Object.entries(TABLES)) {
      h.requetes = [];
      h.modules = null; // ADMIN-like : toutes colonnes
      await post({ table: nom, format: "csv", ids: ["x"] });
      const sql = h.requetes[0].sql;
      expect(sql).not.toMatch(/row_to_json|\bt\.\*/);
      for (const k of def.colonnes) expect(sql).toContain(`t."${k.nom}"`);
      expect(sql).toContain(`FROM ${def.table} t`);
    }
  });

  it("aucune colonne sensible hors liste : photos, geometrie, hash ne sont dans aucune liste", () => {
    const toutes = Object.values(TABLES).flatMap((t) => t.colonnes.map((k) => k.nom));
    expect(toutes).not.toContain("photos");
    expect(toutes).not.toContain("geom");
    expect(toutes).not.toContain("geomLigne");
  });

  it("refuse plus de 2000 identifiants, un format inconnu, une liste vide, un champ inconnu", async () => {
    expect((await post({ table: "ouvrages", format: "csv", ids: Array(2001).fill("x") })).status).toBe(400);
    expect((await post({ table: "ouvrages", format: "pdf", ids: ["o1"] })).status).toBe(400);
    expect((await post({ table: "ouvrages", format: "csv", ids: [] })).status).toBe(400);
    expect((await post({ table: "ouvrages", format: "csv", ids: ["o1"], where: "1=1" })).status).toBe(400);
  });

  it("les valeurs sont liees : un identifiant hostile ne se retrouve jamais dans le texte SQL", async () => {
    await post({ table: "ouvrages", format: "csv", ids: ["x'; DROP TABLE ouvrages;--"] });
    expect(h.requetes[0].sql).not.toContain("DROP");
    expect(h.requetes[0].params[0]).toEqual(["x'; DROP TABLE ouvrages;--"]);
  });
});

describe("territoire par ligne, archives, droit financier", () => {
  it("compte NATIONAL : aucune clause de region ; lignes archivees exclues", async () => {
    await post({ table: "troncons", format: "csv", ids: ["t1"] });
    const { sql, params } = h.requetes[0];
    expect(sql).toContain(`t."deletedAt" IS NULL`);
    expect(sql).not.toContain("$2");
    expect(params).toHaveLength(1);
  });

  it("MUTATION DE CONTROLE : compte REGIONAL, la clause de region est dans le SQL et les regions sont liees", async () => {
    h.perimetre = { national: false, regions: new Set([7, 3]) };
    const r = await post({ table: "troncons", format: "csv", ids: ["t1"] });
    expect(r.status).toBe(200);
    const { sql, params } = h.requetes[0];
    expect(sql).toContain(`t."regionId" = ANY($2::int[])`);
    expect(params[1]).toEqual([3, 7]);
    expect(r.text).toContain("# perimetre;Regions du compte");
  });

  it("un marche d'un compte regional exige que TOUS ses chantiers soient dans sa portee", async () => {
    h.perimetre = { national: false, regions: new Set([3]) };
    await post({ table: "marches", format: "csv", ids: ["m1"] });
    expect(h.requetes[0].sql).toContain("NOT EXISTS");
    expect(h.requetes[0].sql).toContain("$2::int[]");
  });

  // CONTRAT MODIFIE (D-C1-1) : ce test posait `chantiers` SEUL comme compte "sans droit financier". La regle est maintenant UNE seule fonction
  // (`droitMontantsContractuels` : ADMIN, `marches` ou `chantiers`) : le module `chantiers` possede la donnee et la lit deja par
  // /api/chantiers. Le compte "sans droit" de ce test est donc un compte `troncons` (cout de rehabilitation estime).
  it("sans droit financier : les colonnes financieres ne sont meme pas lues, et le fichier le dit", async () => {
    h.modules = new Set(["troncons"]);
    const r = await post({ table: "troncons", format: "csv", ids: ["t1"] });
    expect(r.status).toBe(200);
    expect(h.requetes[0].sql).not.toContain(`"coutRehabEstime"`);
    expect(r.text).toContain("# colonnes_financieres_retirees;coutRehabEstime");
    expect(h.journal[0].droitFinancier).toBe(false);
  });

  it("avec le droit sur les montants contractuels (module marches OU chantiers, regle unique), les montants du chantier sont lus", async () => {
    for (const modules of [["chantiers"], ["chantiers", "marches"]]) {
      h.requetes = [];
      h.modules = new Set(modules);
      await post({ table: "chantiers", format: "csv", ids: ["c1"] });
      expect(h.requetes[0].sql, modules.join()).toContain(`t."montantGnf"`);
      expect(h.requetes[0].sql, modules.join()).toContain(`t."entreprise"`);
    }
  });

  it("le titulaire (entreprise) d'un chantier est une colonne financiere, au meme titre que le montant", () => {
    const cols = TABLES.chantiers.colonnes;
    for (const nom of ["entreprise", "bailleur", "montantGnf", "numContrat"]) expect(cols.find((c) => c.nom === nom)?.financier, nom).toBe(true);
  });
});

describe("droits : un refus REPOND", () => {
  it("module de la table absent : 403 immediat (la requete n'est plus suspendue)", async () => {
    h.modules = new Set(["troncons"]);
    const r = await post({ table: "ouvrages", format: "csv", ids: ["o1"] });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("MODULE_NON_AUTORISE");
    expect(h.requetes).toHaveLength(0);
    expect(h.journal).toHaveLength(0);
  });

  it("un LECTEUR avec le module marches n'exporte pas les marches (donnees contractuelles : ADMIN ou GESTIONNAIRE)", async () => {
    h.compte = { id: "u2", role: "LECTEUR", email: "l@ageroute.gov.gn" };
    h.modules = new Set(["marches"]);
    const r = await post({ table: "marches", format: "csv", ids: ["m1"] });
    expect(r.status).toBe(403);
    expect(h.requetes).toHaveLength(0);
  });

  it("un LECTEUR garde l'export du patrimoine qu'il peut voir (comportement historique)", async () => {
    h.compte = { id: "u2", role: "LECTEUR", email: "l@ageroute.gov.gn" };
    h.modules = new Set(["ouvrages"]);
    expect((await post({ table: "ouvrages", format: "csv", ids: ["o1"] })).status).toBe(200);
  });
});

describe("journal avant remise", () => {
  it("ecrit le journal (empreinte SHA-256 du fichier remis) et l'audit", async () => {
    const r = await post({ table: "ouvrages", format: "csv", ids: ["o1", "o2"] });
    expect(r.status).toBe(200);
    expect(h.journal).toHaveLength(1);
    const j = h.journal[0];
    expect(j.type).toBe("selection:ouvrages");
    expect(j.auteurEmail).toBe("gest@ageroute.gov.gn");
    expect(j.nbLignes).toBe(2);
    expect(j.empreinteSha256).toBe(createHash("sha256").update(Buffer.from(r.text, "utf8")).digest("hex"));
    expect(r.headers["x-export-empreinte-sha256"]).toBe(j.empreinteSha256);
    expect(r.headers["x-export-id"]).toBe(j.id);
    expect(h.audits).toHaveLength(1);
  });

  it("si le journal echoue, AUCUN fichier ne part", async () => {
    h.journalEchoue = true;
    const r = await post({ table: "ouvrages", format: "csv", ids: ["o1"] });
    expect(r.status).toBe(500);
    expect(r.text).not.toContain("Pont de Kindia");
  });
});
