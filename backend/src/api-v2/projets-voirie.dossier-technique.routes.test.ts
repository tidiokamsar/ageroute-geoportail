import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Routes du lot X1 : export du dossier technique (`/:id/export/dossier`, `/:id/export/journal`, `/:id/export/derogations`) et tableaux de bord
 * (`/tableau-de-bord`, `/tableau-de-bord/territoires/:tid`). VRAIS `requireAuth`, `requireModuleAccess`, `requireRole`, gardes territoriales et validation
 * zod ; seuls la base et les services sont simules. L'archive reelle, la derogation en base, la cadence et les agregats sont prouves par le banc
 * `tests-integration/exports-tableaux.integration.mts`.
 */
vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://127.0.0.1:1/essai";
  process.env.JWT_ACCESS_SECRET = "essai-access-secret-essai-access-secret-0000";
  process.env.JWT_REFRESH_SECRET = "essai-refresh-secret-essai-refresh-secret-000";
  process.env.CORS_ORIGIN = "http://localhost:5173";
});

const { w, espion, consignes } = vi.hoisted(() => {
  const consignes: boolean[] = [];
  const w = {
    modules: {} as Record<string, string[]>, perimetres: {} as Record<string, number[]>, regionsProjets: {} as Record<string, number | null>,
    regionsTerritoires: {} as Record<string, number | null>, appels: [] as { nom: string; args: unknown[] }[], echec: null as unknown, retardMs: 0,
  };
  const espion = (nom: string, valeur: unknown) => vi.fn(async (...args: unknown[]) => {
    w.appels.push({ nom, args });
    if (w.retardMs) await new Promise((ok) => setTimeout(ok, w.retardMs));
    if (w.echec) throw w.echec;
    return valeur;
  });
  return { w, espion, consignes };
});

vi.mock("../lib/prisma", () => {
  const prisma: Record<string, unknown> = new Proxy({}, {
    get: (_t, nom: string) => {
      if (nom === "$queryRaw") {
        return async (a: unknown, ...v: unknown[]) => {
          const texte = Array.isArray(a) ? (a as string[]).join("?") : "";
          if (texte.includes("perimetres_comptes")) return (w.perimetres[String(v[0])] ?? []).map((regionId) => ({ regionId }));
          return [];
        };
      }
      if (nom === "user") return { findUnique: async ({ where }: { where: { id: string } }) => ({ modulesAutorises: w.modules[where.id] ?? [] }) };
      return new Proxy({}, { get: () => async () => null });
    },
  });
  return { prisma };
});
vi.mock("../projets-voirie/projets.service", async (original) => {
  const m = await original<typeof import("../projets-voirie/projets.service")>();
  return { ...m, regionsDuProjet: vi.fn(async (id: string) => (id in w.regionsProjets ? [w.regionsProjets[id]] : [])) };
});
vi.mock("../projets-voirie/territoires/territoires.service", async (original) => {
  const m = await original<typeof import("../projets-voirie/territoires/territoires.service")>();
  return { ...m, regionsDuTerritoire: vi.fn(async (id: string) => (id in w.regionsTerritoires ? [w.regionsTerritoires[id]] : [])) };
});
vi.mock("../projets-voirie/import.service", () => ({ deposerJeu: vi.fn() }));
const { ARCHIVE } = vi.hoisted(() => ({ ARCHIVE: Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]) }));
vi.mock("../projets-voirie/exports/dossier.service", () => ({
  exporterDossier: espion("exporterDossier", { archive: ARCHIVE, nomFichier: "dossier-pv-1-2026-11-10.zip", exportId: "e-1", sha256: "a".repeat(64), nbFichiers: 9, nbJeuxGeojson: 2, consigner: async (envoye: boolean) => { consignes.push(envoye); } }),
  journalExports: espion("journalExports", { exports: [] }),
}));
vi.mock("../projets-voirie/exports/derogations.service", () => ({
  creerDerogation: espion("creerDerogation", { derogation: { id: "d-1" } }),
  listerDerogations: espion("listerDerogations", { derogations: [] }),
  listerMesDerogations: espion("listerMesDerogations", { derogations: [] }),
}));
vi.mock("../projets-voirie/tableaux/tableau.service", () => ({
  tableauNational: espion("tableauNational", { portee: "NATIONAL", total: { projets: 0 } }),
  tableauTerritoire: espion("tableauTerritoire", { portee: "TERRITOIRE", total: { projets: 0 } }),
}));

import { _installerResolveurCompte } from "../middleware/auth.middleware";
import { signAccessToken } from "../utils/jwt";
import { errorHandler } from "../middleware/error.middleware";
import { ErreurMetier } from "../projets-voirie/erreurs";
import { ServiceOccupe } from "../import/limiteur";
import { projetsVoirieV2Router } from "./projets-voirie.routes";

const app = express();
app.use(express.json());
app.use("/api/v2/projets-voirie", projetsVoirieV2Router);
app.use(errorHandler);

const COMPTES: Record<string, { id: string; role: string; modules: string[]; regions?: number[] }> = {
  ADMIN: { id: "u-admin", role: "ADMIN", modules: [] },
  GEST: { id: "u-gest", role: "GESTIONNAIRE", modules: ["projets-voirie"] },
  LECT: { id: "u-lect", role: "LECTEUR", modules: ["projets-voirie"] },
  INSP: { id: "u-insp", role: "INSPECTEUR", modules: ["projets-voirie"] },
  SANS: { id: "u-sans", role: "GESTIONNAIRE", modules: ["troncons"] },
  GEST_R1: { id: "u-gest-1", role: "GESTIONNAIRE", modules: ["projets-voirie"], regions: [1] },
  LECT_R1: { id: "u-lect-1", role: "LECTEUR", modules: ["projets-voirie"], regions: [1] },
};
const jeton = (c: string) => signAccessToken({ sub: COMPTES[c].id, role: COMPTES[c].role as never, email: `${c}@essai.invalid` });
const BASE = "/api/v2/projets-voirie";
const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const P1 = uuid(1), P2 = uuid(2), T1 = uuid(31), T2 = uuid(32), J1 = uuid(21), D1 = uuid(41);

beforeEach(() => {
  w.appels = []; w.echec = null; w.retardMs = 0; w.modules = {}; w.perimetres = {};
  w.regionsProjets = { [P1]: 1, [P2]: 2 };
  w.regionsTerritoires = { [T1]: 1, [T2]: 2 };
  for (const c of Object.values(COMPTES)) { w.modules[c.id] = c.modules; if (c.regions) w.perimetres[c.id] = c.regions; }
  _installerResolveurCompte(async (id) => {
    const c = Object.values(COMPTES).find((x) => x.id === id);
    return c ? { actif: true, lockedUntil: null, role: c.role as never, email: `${id}@essai.invalid` } : null;
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterAll(() => _installerResolveurCompte(null));

type Route = { m: "get" | "post"; chemin: string; corps?: object; service: string; roles: string[]; ok: number; projet: boolean };
const DEROG = { jeuxIds: [J1], justification: "Transmission au bureau de controle pour execution", beneficiaireId: uuid(7) };
const ROUTES: Route[] = [
  { m: "get", chemin: `/${P1}/export/dossier`, service: "exporterDossier", roles: ["ADMIN", "GEST"], ok: 200, projet: true },
  { m: "get", chemin: `/${P1}/export/journal`, service: "journalExports", roles: ["ADMIN", "GEST"], ok: 200, projet: true },
  { m: "post", chemin: `/${P1}/export/derogations`, corps: DEROG, service: "creerDerogation", roles: ["ADMIN"], ok: 201, projet: true },
  { m: "get", chemin: `/${P1}/export/derogations`, service: "listerDerogations", roles: ["ADMIN"], ok: 200, projet: true },
  // Ecart E1 du lot UI-D : le beneficiaire (ADMIN ou GESTIONNAIRE) lit les derogations qui le designent.
  { m: "get", chemin: `/${P1}/export/derogations/miennes`, service: "listerMesDerogations", roles: ["ADMIN", "GEST"], ok: 200, projet: true },
  { m: "get", chemin: "/tableau-de-bord", service: "tableauNational", roles: ["ADMIN", "GEST", "LECT", "INSP"], ok: 200, projet: false },
  { m: "get", chemin: `/tableau-de-bord/territoires/${T1}`, service: "tableauTerritoire", roles: ["ADMIN", "GEST", "LECT", "INSP"], ok: 200, projet: false },
];
const appeler = (r: Route, compte: string | null, chemin = r.chemin, corps = r.corps) => {
  let q = request(app)[r.m](`${BASE}${chemin}`);
  if (compte) q = q.set("Authorization", `Bearer ${jeton(compte)}`);
  return corps !== undefined ? q.send(corps) : q;
};
const appelsDe = (nom: string) => w.appels.filter((a) => a.nom === nom);

describe("gardes : authentification, module, role, perimetre", () => {
  it("sans jeton 401, sans la cle du module 403, sur les 7 routes ; aucun service appele", async () => {
    expect(ROUTES).toHaveLength(7);
    for (const r of ROUTES) expect((await appeler(r, null)).status, r.chemin).toBe(401);
    for (const r of ROUTES) expect((await appeler(r, "SANS")).status, r.chemin).toBe(403);
    expect(w.appels).toEqual([]);
  });

  it("export et journal : ADMIN et GESTIONNAIRE seulement ; derogations : ADMIN seul ; tableaux : toute personne qui a la cle", async () => {
    for (const r of ROUTES) for (const c of ["ADMIN", "GEST", "LECT", "INSP"]) {
      const rep = await appeler(r, c);
      expect(rep.status, `${c} ${r.m} ${r.chemin}`).toBe(r.roles.includes(c) ? r.ok : 403);
    }
    expect(appelsDe("exporterDossier").every((a) => ["ADMIN", "GESTIONNAIRE"].includes((a.args[0] as { role: string }).role))).toBe(true);
    expect(appelsDe("creerDerogation").every((a) => (a.args[0] as { role: string }).role === "ADMIN")).toBe(true);
    // « Mes derogations » : le service recoit l'acteur du jeton (jamais un beneficiaire passe en parametre).
    expect(appelsDe("listerMesDerogations").length).toBeGreaterThan(0);
    expect(appelsDe("listerMesDerogations").every((a) => ["ADMIN", "GESTIONNAIRE"].includes((a.args[0] as { role: string }).role) && a.args[1] === P1)).toBe(true);
  });

  it("« mes derogations » : aucun parametre de requete admis (un beneficiaire ne se choisit pas) : 400", async () => {
    const r = ROUTES.find((x) => x.service === "listerMesDerogations")!;
    expect((await appeler(r, "GEST", `${r.chemin}?beneficiaireId=${uuid(9)}`)).status).toBe(400);
  });

  it("projet hors perimetre ou inconnu : le MEME 404 masque, avant toute validation (parametres faux compris) ; aucun service appele", async () => {
    for (const r of ROUTES.filter((x) => x.projet && x.roles.includes("GEST"))) {
      for (const projet of [P2, uuid(99)]) {
        const rep = await appeler(r, "GEST_R1", `${r.chemin.replace(P1, projet)}?inconnu=1`);
        expect(rep.status, `${r.chemin} ${projet}`).toBe(404);
        expect(rep.body).toEqual({ error: "Projet introuvable", code: "PROJET_INTROUVABLE" });
      }
    }
    expect(w.appels).toEqual([]);
  });

  it("territoire hors perimetre ou inconnu : le MEME 404 TERRITOIRE_INTROUVABLE, avant la validation ; identifiant non UUID : 400", async () => {
    for (const t of [T2, uuid(98)]) {
      const rep = await request(app).get(`${BASE}/tableau-de-bord/territoires/${t}?inconnu=1`).set("Authorization", `Bearer ${jeton("LECT_R1")}`);
      expect(rep.status, t).toBe(404);
      expect(rep.body).toEqual({ error: "Territoire introuvable", code: "TERRITOIRE_INTROUVABLE" });
    }
    const mal = await request(app).get(`${BASE}/tableau-de-bord/territoires/pas-un-uuid`).set("Authorization", `Bearer ${jeton("ADMIN")}`);
    expect(mal.status).toBe(400);
    expect(mal.body.code).toBe("IDENTIFIANT_INVALIDE");
    expect(w.appels).toEqual([]);
    const ok = await request(app).get(`${BASE}/tableau-de-bord/territoires/${T1}`).set("Authorization", `Bearer ${jeton("LECT_R1")}`);
    expect(ok.status).toBe(200);
  });

  it("les tableaux de bord recoivent l'acteur du jeton et la portee lue en base (regions du compte), jamais un parametre de requete", async () => {
    await request(app).get(`${BASE}/tableau-de-bord`).set("Authorization", `Bearer ${jeton("LECT_R1")}`);
    await request(app).get(`${BASE}/tableau-de-bord`).set("Authorization", `Bearer ${jeton("ADMIN")}`);
    const [a, b] = appelsDe("tableauNational");
    expect(a.args[0]).toMatchObject({ id: "u-lect-1", role: "LECTEUR" });
    expect(a.args[1]).toEqual([1]);
    expect(b.args[1]).toBeNull();
    for (const q of ["regions=1,2", "territoireId=x", "role=ADMIN"]) {
      const r = await request(app).get(`${BASE}/tableau-de-bord?${q}`).set("Authorization", `Bearer ${jeton("LECT")}`);
      expect(r.status, q).toBe(400);
      expect(r.body.code).toBe("PARAMETRES_INVALIDES");
    }
    expect(appelsDe("tableauNational")).toHaveLength(2);
  });
});

describe("export du dossier : reponse binaire et parametres", () => {
  beforeEach(() => { consignes.length = 0; });
  it("200 application/zip, piece jointe nommee, en-tetes d'empreinte, d'identifiant et de comptes ; corps = l'archive du service ; pas de cache", async () => {
    const r = await request(app).get(`${BASE}/${P1}/export/dossier`).set("Authorization", `Bearer ${jeton("GEST")}`).buffer(true).parse((res, cb) => {
      const morceaux: Buffer[] = []; res.on("data", (c: Buffer) => morceaux.push(c)); res.on("end", () => cb(null, Buffer.concat(morceaux)));
    });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/zip");
    expect(r.headers["content-disposition"]).toBe('attachment; filename="dossier-pv-1-2026-11-10.zip"');
    expect([r.headers["x-export-id"], r.headers["x-empreinte-sha256"], r.headers["x-fichiers"], r.headers["x-jeux-geojson"]]).toEqual(["e-1", "a".repeat(64), "9", "2"]);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect((r.body as Buffer).equals(ARCHIVE)).toBe(true);
    // Revue du lot X1, M4 : la remise est consignee APRES l'ecriture complete de la reponse, une seule fois, comme envoyee.
    await new Promise((ok) => setTimeout(ok, 20));
    expect(consignes).toEqual([true]);
    expect(appelsDe("exporterDossier")[0].args.slice(1)).toEqual([P1, { geojson: true, derogationId: undefined }]);
  });

  it("geojson=false et derogation transmis ; une derogation sans GeoJSON, une valeur inconnue, un identifiant non UUID, un parametre en trop : 400", async () => {
    const g = (q: string) => request(app).get(`${BASE}/${P1}/export/dossier?${q}`).set("Authorization", `Bearer ${jeton("ADMIN")}`);
    expect((await g("geojson=false")).status).toBe(200);
    expect((await g(`derogation=${D1}`)).status).toBe(200);
    expect(appelsDe("exporterDossier").map((a) => a.args[2])).toEqual([{ geojson: false, derogationId: undefined }, { geojson: true, derogationId: D1 }]);
    for (const q of [`geojson=false&derogation=${D1}`, "geojson=oui", "derogation=abc", "format=kml", "inclureNonAutorises=true"]) {
      const r = await g(q);
      expect(r.status, q).toBe(400);
      expect(r.body.code).toBe("PARAMETRES_INVALIDES");
    }
    expect(appelsDe("exporterDossier")).toHaveLength(2);
  });

  it("client parti pendant la fabrication : l'archive n'est pas envoyee et la remise est consignee NON envoyee (ECHEC_ENVOI, derogation non consommee)", async () => {
    w.retardMs = 300;
    const echec = await request(app).get(`${BASE}/${P1}/export/dossier`).set("Authorization", `Bearer ${jeton("GEST")}`).timeout(60).then(() => "recu", (e: { timeout?: number }) => (e.timeout ? "abandon" : "autre"));
    expect(echec).toBe("abandon");
    await new Promise((ok) => setTimeout(ok, 600));
    expect(consignes).toEqual([false]);
  });

  it("journal : limite bornee (1 a 100) ; transmise au service", async () => {
    const g = (q: string) => request(app).get(`${BASE}/${P1}/export/journal?${q}`).set("Authorization", `Bearer ${jeton("GEST")}`);
    for (const q of ["limite=0", "limite=101", "x=1"]) expect((await g(q)).status, q).toBe(400);
    expect((await g("limite=7")).status).toBe(200);
    expect(appelsDe("journalExports")[0].args).toEqual([P1, 7]);
  });
});

describe("derogation : validation stricte du corps", () => {
  it("jeux (1 a 20 UUID), justification de 20 caracteres, beneficiaire UUID OBLIGATOIRE (revue X1, M2), duree 1 a 168 h, aucun champ en trop : 400 CHAMPS_INVALIDES sinon", async () => {
    const p = (corps: object) => request(app).post(`${BASE}/${P1}/export/derogations`).set("Authorization", `Bearer ${jeton("ADMIN")}`).send(corps);
    const { beneficiaireId: _b, ...sansBeneficiaire } = DEROG;
    void _b;
    for (const corps of [{}, sansBeneficiaire, { ...DEROG, jeuxIds: [] }, { ...DEROG, jeuxIds: Array.from({ length: 21 }, (_, i) => uuid(100 + i)) }, { ...DEROG, jeuxIds: ["x"] },
      { ...DEROG, justification: "trop court" }, { ...DEROG, beneficiaireId: "x" }, { ...DEROG, dureeHeures: 0 }, { ...DEROG, dureeHeures: 169 }, { ...DEROG, dureeHeures: 1.5 },
      { ...DEROG, utiliseeLe: "2026-01-01" }, { ...DEROG, projetId: P2 }]) {
      const r = await p(corps);
      expect(r.status, JSON.stringify(corps).slice(0, 90)).toBe(400);
      expect(r.body.code).toBe("CHAMPS_INVALIDES");
    }
    expect(appelsDe("creerDerogation")).toEqual([]);
    expect((await p({ ...DEROG, dureeHeures: 48 })).status).toBe(201);
    expect(appelsDe("creerDerogation")[0].args.slice(1)).toEqual([P1, { ...DEROG, dureeHeures: 48 }]);
  });
});

describe("erreurs typees rendues telles quelles", () => {
  it("404, 409, 422, 429 (Retry-After), 503 (Retry-After), 504 : statut, code et champs du contrat", async () => {
    const cas: [unknown, number, string][] = [
      [new ErreurMetier(404, "DEROGATION_INTROUVABLE", "Dérogation introuvable pour ce projet et ce compte."), 404, "DEROGATION_INTROUVABLE"],
      [new ErreurMetier(409, "DEROGATION_INDISPONIBLE", "Utilisee.", { etat: "UTILISEE" }), 409, "DEROGATION_INDISPONIBLE"],
      [new ErreurMetier(422, "EXPORT_TROP_VOLUMINEUX", "Trop.", { objets: 9, objetsMax: 1 }), 422, "EXPORT_TROP_VOLUMINEUX"],
      [new ErreurMetier(429, "EXPORT_TROP_FREQUENT", "Trop frequent.", { retryAfterS: 42 }), 429, "EXPORT_TROP_FREQUENT"],
      [new ServiceOccupe("Un export de ce compte est déjà en cours.", 10), 503, "SERVICE_OCCUPE"],
      [new ErreurMetier(504, "EXPORT_TROP_LONG", "Trop long."), 504, "EXPORT_TROP_LONG"],
    ];
    for (const [e, statut, code] of cas) {
      w.echec = e;
      const r = await request(app).get(`${BASE}/${P1}/export/dossier`).set("Authorization", `Bearer ${jeton("GEST")}`);
      expect(r.status, code).toBe(statut);
      expect(r.body.code).toBe(code);
      if (e instanceof ErreurMetier) expect(r.body).toEqual({ error: e.message, code: e.code, ...e.extra });
      if (statut === 429) expect(r.headers["retry-after"]).toBe("42");
      if (statut === 503) expect(r.headers["retry-after"]).toBe("10");
      expect(r.headers["content-type"]).toMatch(/application\/json/);
    }
    w.echec = new ErreurMetier(429, "TABLEAU_DE_BORD_TROP_FREQUENT", "Trop.", { retryAfterS: 5 });
    const t = await request(app).get(`${BASE}/tableau-de-bord`).set("Authorization", `Bearer ${jeton("LECT")}`);
    expect([t.status, t.body.code, t.headers["retry-after"]]).toEqual([429, "TABLEAU_DE_BORD_TROP_FREQUENT", "5"]);
  });
});
