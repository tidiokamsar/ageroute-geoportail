import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Routes des SOURCES MULTIPLES (lot S1) : `/:id/sources`, `/:id/regles-rapprochement`, `/:id/comparaisons` et l'extension CONNECTE_A des relations B1.
 * VRAIS `requireAuth`, `requireModuleAccess`, `requireRole`, gardes territoriales et validation zod ; seuls la base et les services sont simules.
 * Le SQL, les declencheurs et l'audit sont prouves par le banc `tests-integration/sources-comparaison.integration.mts`.
 */
vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://127.0.0.1:1/essai";
  process.env.JWT_ACCESS_SECRET = "essai-access-secret-essai-access-secret-0000";
  process.env.JWT_REFRESH_SECRET = "essai-refresh-secret-essai-refresh-secret-000";
  process.env.CORS_ORIGIN = "http://localhost:5173";
});

const { w, espion } = vi.hoisted(() => {
  const w = { modules: {} as Record<string, string[]>, perimetres: {} as Record<string, number[]>, regionsProjets: {} as Record<string, number | null>, appels: [] as { nom: string; args: unknown[] }[], echec: null as unknown };
  const espion = (nom: string, valeur: unknown) => vi.fn(async (...args: unknown[]) => { w.appels.push({ nom, args }); if (w.echec) throw w.echec; return valeur; });
  return { w, espion };
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
vi.mock("../projets-voirie/import.service", () => ({ deposerJeu: vi.fn() }));
vi.mock("../projets-voirie/sources/sources.service", () => ({ vueSources: espion("vueSources", { reseaux: [], totaux: {} }) }));
vi.mock("../projets-voirie/sources/regles-rapprochement.service", async (original) => {
  const m = await original<typeof import("../projets-voirie/sources/regles-rapprochement.service")>();
  return { ...m, listerReglesRapprochement: espion("listerRegles", { regles: [] }), creerRegleRapprochement: espion("creerRegle", { regle: { id: "r" } }), approuverRegleRapprochement: espion("approuverRegle", { regle: { id: "r" } }) };
});
vi.mock("../projets-voirie/sources/comparaison.service", async (original) => {
  const m = await original<typeof import("../projets-voirie/sources/comparaison.service")>();
  return {
    ...m, lancerComparaison: espion("lancerComparaison", { comparaison: { id: "c" }, resume: {} }), listerComparaisons: espion("listerComparaisons", { comparaisons: [], curseurSuivant: null }),
    detailComparaison: espion("detailComparaison", { comparaison: { id: "c" } }), listerResultats: espion("listerResultats", { resultats: [], curseurSuivant: null }),
    ouvrirDossierDivergence: espion("ouvrirDossier", { conflit: { id: "k" } }),
  };
});
vi.mock("../projets-voirie/reseaux/relations.service", async (original) => {
  const m = await original<typeof import("../projets-voirie/reseaux/relations.service")>();
  return { ...m, declarerRelation: espion("declarerRelation", { relation: { id: "rel" } }) };
});

import { _installerResolveurCompte } from "../middleware/auth.middleware";
import { signAccessToken } from "../utils/jwt";
import { errorHandler } from "../middleware/error.middleware";
import { ErreurMetier } from "../projets-voirie/erreurs";
import { projetsVoirieV2Router } from "./projets-voirie.routes";

const app = express();
app.use(express.json());
app.use("/api/v2/projets-voirie", projetsVoirieV2Router);
app.use(errorHandler);

const COMPTES: Record<string, { id: string; role: string; modules: string[]; regions?: number[] }> = {
  ADMIN: { id: "u-admin", role: "ADMIN", modules: [] },
  GEST: { id: "u-gest", role: "GESTIONNAIRE", modules: ["projets-voirie"] },
  LECT: { id: "u-lect", role: "LECTEUR", modules: ["projets-voirie"] },
  SANS: { id: "u-sans", role: "GESTIONNAIRE", modules: ["troncons"] },
  GEST_R1: { id: "u-gest-1", role: "GESTIONNAIRE", modules: ["projets-voirie"], regions: [1] },
};
const jeton = (c: string) => signAccessToken({ sub: COMPTES[c].id, role: COMPTES[c].role as never, email: `${c}@essai.invalid` });
const BASE = "/api/v2/projets-voirie";
const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const P1 = uuid(1), P2 = uuid(2), CMP = uuid(11), RG = uuid(12), J1 = uuid(21), J2 = uuid(22), RES = uuid(31);

beforeEach(() => {
  w.appels = []; w.echec = null; w.modules = {}; w.perimetres = {};
  w.regionsProjets = { [P1]: 1, [P2]: 2 };
  for (const c of Object.values(COMPTES)) { w.modules[c.id] = c.modules; if (c.regions) w.perimetres[c.id] = c.regions; }
  _installerResolveurCompte(async (id) => {
    const c = Object.values(COMPTES).find((x) => x.id === id);
    return c ? { actif: true, lockedUntil: null, role: c.role as never, email: `${id}@essai.invalid` } : null;
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterAll(() => _installerResolveurCompte(null));

type Route = { m: "get" | "post"; chemin: string; corps?: object; service: string; lecture: boolean; admin?: boolean; ok: number };
const ROUTES: Route[] = [
  { m: "get", chemin: `/${P1}/sources`, service: "vueSources", lecture: true, ok: 200 },
  { m: "get", chemin: `/${P1}/regles-rapprochement`, service: "listerRegles", lecture: true, ok: 200 },
  { m: "post", chemin: `/${P1}/regles-rapprochement`, corps: { code: "COR-1", margeM: 1, justification: "Corridor valide par la direction" }, service: "creerRegle", lecture: false, ok: 201 },
  { m: "post", chemin: `/${P1}/regles-rapprochement/${RG}/approuver`, corps: { justification: "Relue et approuvee" }, service: "approuverRegle", lecture: false, admin: true, ok: 200 },
  { m: "post", chemin: `/${P1}/comparaisons`, corps: { jeuAId: J1, jeuBId: J2 }, service: "lancerComparaison", lecture: false, ok: 201 },
  { m: "get", chemin: `/${P1}/comparaisons`, service: "listerComparaisons", lecture: true, ok: 200 },
  { m: "get", chemin: `/${P1}/comparaisons/${CMP}`, service: "detailComparaison", lecture: true, ok: 200 },
  { m: "get", chemin: `/${P1}/comparaisons/${CMP}/objets`, service: "listerResultats", lecture: true, ok: 200 },
  { m: "post", chemin: `/${P1}/comparaisons/${CMP}/dossiers-conflit`, corps: { resultatId: RES, justification: "Divergence a investiguer sur le terrain" }, service: "ouvrirDossier", lecture: false, ok: 201 },
];
const appeler = (r: Route, compte: string | null, chemin = r.chemin, corps = r.corps) => {
  let q = request(app)[r.m](`${BASE}${chemin}`);
  if (compte) q = q.set("Authorization", `Bearer ${jeton(compte)}`);
  return corps !== undefined ? q.send(corps) : q;
};
const appelsDe = (nom: string) => w.appels.filter((a) => a.nom === nom);

describe("gardes : authentification, module, role, territoire", () => {
  it("sans jeton 401, sans la cle 403, sur les 9 routes ; aucun service appele", async () => {
    expect(ROUTES).toHaveLength(9);
    for (const r of ROUTES) expect((await appeler(r, null)).status, r.chemin).toBe(401);
    for (const r of ROUTES) expect((await appeler(r, "SANS")).status, r.chemin).toBe(403);
    expect(w.appels).toEqual([]);
  });
  it("un LECTEUR lit (200) et n'ecrit rien (403) ; un GESTIONNAIRE ecrit tout sauf l'approbation (ADMIN seul)", async () => {
    for (const r of ROUTES) expect((await appeler(r, "LECT")).status, `LECT ${r.chemin}`).toBe(r.lecture ? 200 : 403);
    for (const nom of ["creerRegle", "approuverRegle", "lancerComparaison", "ouvrirDossier"]) expect(appelsDe(nom), nom).toEqual([]);
    for (const r of ROUTES) expect((await appeler(r, "GEST")).status, `GEST ${r.chemin}`).toBe(r.admin ? 403 : r.ok);
    for (const r of ROUTES) expect((await appeler(r, "ADMIN")).status, `ADMIN ${r.chemin}`).toBe(r.ok);
  });
  it("hors perimetre ou projet inconnu : le MEME 404, meme avec un corps invalide, avant toute validation", async () => {
    for (const r of ROUTES.filter((x) => !x.admin)) {
      for (const projet of [P2, uuid(99)]) {
        const rep = await appeler(r, "GEST_R1", r.chemin.replace(P1, projet), r.m === "get" ? undefined : { inconnu: true });
        expect(rep.status, `${r.m} ${projet}`).toBe(404);
        expect(rep.body).toEqual({ error: "Projet introuvable", code: "PROJET_INTROUVABLE" });
      }
    }
    expect(w.appels).toEqual([]);
  });
  it("l'acteur transmis est celui du jeton, jamais un champ du corps", async () => {
    await appeler(ROUTES[4], "GEST");
    const [acteur, projetId, corps] = appelsDe("lancerComparaison")[0].args as [{ id: string; role: string }, string, object];
    expect(acteur).toMatchObject({ id: "u-gest", role: "GESTIONNAIRE" });
    expect(projetId).toBe(P1);
    expect(corps).toEqual({ jeuAId: J1, jeuBId: J2 });
  });
});

describe("validation des entrees : 400 type, jamais 500, le service n'est pas appele", () => {
  it("identifiants de comparaison ou de regle hors UUID : 400 IDENTIFIANT_INVALIDE", async () => {
    for (const c of [`/${P1}/comparaisons/zzz`, `/${P1}/comparaisons/zzz/objets`]) {
      const r = await request(app).get(`${BASE}${c}`).set("Authorization", `Bearer ${jeton("GEST")}`);
      expect(r.status, c).toBe(400); expect(r.body.code).toBe("IDENTIFIANT_INVALIDE");
    }
    const r = await request(app).post(`${BASE}/${P1}/regles-rapprochement/zzz/approuver`).set("Authorization", `Bearer ${jeton("ADMIN")}`).send({});
    expect(r.body.code).toBe("IDENTIFIANT_INVALIDE");
    expect(w.appels).toEqual([]);
  });
  it("comparaison : jeux absents, non UUID, champ en trop (aucun parametre de calcul n'est modifiable par la requete)", async () => {
    for (const corps of [{}, { jeuAId: J1 }, { jeuAId: "x", jeuBId: J2 }, { jeuAId: J1, jeuBId: J2, margeM: 50 }, { jeuAId: J1, jeuBId: J2, mode: "SOURCES" }]) {
      const r = await appeler(ROUTES[4], "GEST", ROUTES[4].chemin, corps);
      expect(r.status, JSON.stringify(corps)).toBe(400); expect(r.body.code).toBe("CHAMPS_INVALIDES");
    }
    expect(appelsDe("lancerComparaison")).toEqual([]);
  });
  it("regle : code, marge, rayon, part, precisions par classe (E interdite, valeur nulle), statut impose refuses ; defauts appliques", async () => {
    const base = { code: "COR-1", justification: "Corridor valide par la direction" };
    for (const corps of [{ ...base, code: "x" }, { ...base, margeM: -1 }, { ...base, margeM: 101 }, { ...base, rayonAppariementM: 0 }, { ...base, partHorsCorridorMax: 2 },
      { ...base, precisionParClasseM: { A: 1, B: 1, C: 1, D: 1, E: 1 } }, { ...base, precisionParClasseM: { A: 0, B: 1, C: 1, D: 1 } }, { ...base, statut: "APPROUVEE" }, { ...base, famille: "PETROLE" }]) {
      expect((await appeler(ROUTES[2], "GEST", ROUTES[2].chemin, corps)).status, JSON.stringify(corps)).toBe(400);
    }
    expect(appelsDe("creerRegle")).toEqual([]);
    expect((await appeler(ROUTES[2], "GEST", ROUTES[2].chemin, { ...base, famille: "TELECOM", precisionParClasseM: { A: 0.2, B: 1, C: 3, D: 6 } })).status).toBe(201);
    expect(appelsDe("creerRegle")[0].args[2]).toMatchObject({ famille: "TELECOM", margeM: 1, rayonAppariementM: 10, partHorsCorridorMax: 0, precisionParClasseM: { A: 0.2, B: 1, C: 3, D: 6 } });
  });
  it("resultats : statut inconnu, limite hors bornes, curseur forge : 400 ; filtres valides transmis", async () => {
    const g = (q: string) => request(app).get(`${BASE}/${P1}/comparaisons/${CMP}/objets?${q}`).set("Authorization", `Bearer ${jeton("LECT")}`);
    for (const q of ["statut=FUSION", "limite=0", "limite=201", "inconnu=1"]) expect((await g(q)).status, q).toBe(400);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    for (const n of [0, 2_147_483_648, 1.5, "3"]) expect((await g(`curseur=${b64({ n })}`)).body.code).toBe("CURSEUR_INVALIDE");
    expect(appelsDe("listerResultats")).toEqual([]);
    expect((await g(`statut=DIVERGENCE,RAPPROCHEMENT_INCERTAIN&limite=7&curseur=${b64({ n: 14 })}`)).status).toBe(200);
    expect(appelsDe("listerResultats")[0].args[3]).toEqual({ statuts: ["DIVERGENCE", "RAPPROCHEMENT_INCERTAIN"], limite: 7, apresOrdre: 14 });
  });
  it("dossier : resultat absent ou non UUID, champ en trop (aucun statut ni type impose par la requete)", async () => {
    for (const corps of [{}, { resultatId: "x" }, { resultatId: RES, statut: "CONFIRME" }, { resultatId: RES, type: "PROXIMITE" }]) {
      expect((await appeler(ROUTES[8], "GEST", ROUTES[8].chemin, corps)).status, JSON.stringify(corps)).toBe(400);
    }
    expect(appelsDe("ouvrirDossier")).toEqual([]);
  });
});

describe("erreurs typees rendues telles quelles", () => {
  it("409, 422, 429 (avec Retry-After), 503, 504 : statut, code et champs du contrat", async () => {
    const cas: [ErreurMetier, number][] = [
      [new ErreurMetier(409, "JEUX_NON_COMPARABLES", "Pas le meme reseau.", { motif: "RESEAU_DIFFERENT" }), 409],
      [new ErreurMetier(422, "COMPARAISON_TROP_VOLUMINEUSE", "Trop.", { objetsMax: 100 }), 422],
      [new ErreurMetier(429, "COMPARAISON_TROP_FREQUENTE", "Attendez.", { retryAfterS: 12 }), 429],
      [new ErreurMetier(503, "PROJET_OCCUPE", "Occupe."), 503],
      [new ErreurMetier(504, "COMPARAISON_TROP_LONGUE", "Trop long."), 504],
    ];
    for (const [e, s] of cas) {
      w.echec = e;
      const r = await appeler(ROUTES[4], "GEST");
      expect(r.status, e.code).toBe(s);
      expect(r.body).toEqual({ error: e.message, code: e.code, ...e.extra });
      if (s === 429) expect(r.headers["retry-after"]).toBe("12");
    }
  });
});

describe("relations B1 : CONNECTE_A exige une preuve, et seulement lui", () => {
  const P = (corps: object) => request(app).post(`${BASE}/${P1}/reseau/relations`).set("Authorization", `Bearer ${jeton("GEST")}`).send(corps);
  const base = { sourceObjetId: "11", cibleObjetId: "12", justification: "Connexion confirmee par le plan du concessionnaire" };
  it("CONNECTE_A sans preuve, preuve inconnue, preuve sur PORTE_PAR : 400 ; avec preuve : transmise au service", async () => {
    for (const corps of [{ ...base, type: "CONNECTE_A" }, { ...base, type: "CONNECTE_A", preuve: "DEDUITE" }, { ...base, type: "PORTE_PAR", preuve: "INCONNUE" }, { ...base, type: "CONNECTE_A", preuve: "INCONNUE", origine: "AUTOMATIQUE" }]) {
      const r = await P(corps);
      expect(r.status, JSON.stringify(corps)).toBe(400); expect(r.body.code).toBe("CHAMPS_INVALIDES");
    }
    expect(appelsDe("declarerRelation")).toEqual([]);
    expect((await P({ ...base, type: "CONNECTE_A", preuve: "CONFIRMEE_PAR_FOURNISSEUR" })).status).toBe(201);
    expect((await P({ ...base, type: "PORTE_PAR" })).status).toBe(201);
    expect(appelsDe("declarerRelation")[0].args[2]).toMatchObject({ type: "CONNECTE_A", preuve: "CONFIRMEE_PAR_FOURNISSEUR" });
  });
  it("aucune route de proposition automatique de connexion n'existe", async () => {
    for (const c of [`/${P1}/reseau/connexions/proposer`, `/${P1}/reseau/connectivite/calculer`, `/${P1}/reseau/associations/connecter`]) {
      expect((await request(app).post(`${BASE}${c}`).set("Authorization", `Bearer ${jeton("ADMIN")}`).send({})).status, c).toBe(404);
    }
  });
});
