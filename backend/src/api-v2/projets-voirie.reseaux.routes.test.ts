import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Routes des RESEAUX PHYSIQUES ET CIRCUITS LOGIQUES (`/api/v2/projets-voirie/:id/reseau/...`, lot B1) : cablage des gardes, validation stricte des
 * entrees, traduction des erreurs typees, ordre des routes. Les VRAIS `requireAuth` (jeton signe, resolveur de compte injecte), `requireModuleAccess`,
 * `requireRole`, gardes territoriales et validation zod ; seuls la BASE (comptes, modules, perimetres) et les SERVICES (qui parlent a PostGIS) sont
 * simules. Le SQL, les declencheurs, l'audit, la lisibilite par role et les propositions sont prouves par le banc
 * `tests-integration/reseau-physique-logique.integration.mts` et par les tests des noyaux (`projets-voirie/reseaux/*.test.ts`).
 */
vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://127.0.0.1:1/essai";
  process.env.JWT_ACCESS_SECRET = "essai-access-secret-essai-access-secret-0000";
  process.env.JWT_REFRESH_SECRET = "essai-refresh-secret-essai-refresh-secret-000";
  process.env.CORS_ORIGIN = "http://localhost:5173";
});

const { w, espion } = vi.hoisted(() => {
  const w = {
    modules: {} as Record<string, string[]>,
    perimetres: {} as Record<string, number[]>,
    regionsProjets: {} as Record<string, number | null>,
    appels: [] as { nom: string; args: unknown[] }[],
    echec: null as unknown,
  };
  const espion = (nom: string, valeur: unknown) => vi.fn(async (...args: unknown[]) => {
    w.appels.push({ nom, args });
    if (w.echec) throw w.echec;
    return valeur;
  });
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
vi.mock("../projets-voirie/carte.service", () => ({ carte: vi.fn() }));
vi.mock("../projets-voirie/analyse.service", () => ({ analyser: vi.fn(), exporterCsv: vi.fn(), celluleCsv: vi.fn() }));
vi.mock("../projets-voirie/conflits/analyse-conflits.service", () => ({ lancerAnalyse: vi.fn() }));
vi.mock("../projets-voirie/conflits/regles-analyses.service", async (original) => original<typeof import("../projets-voirie/conflits/regles-analyses.service")>());
vi.mock("../projets-voirie/conflits/dossiers.service", async (original) => original<typeof import("../projets-voirie/conflits/dossiers.service")>());
vi.mock("../projets-voirie/reseaux/descripteurs.service", async (original) => {
  const m = await original<typeof import("../projets-voirie/reseaux/descripteurs.service")>();
  return {
    ...m,
    listerObjetsReseau: espion("listerObjetsReseau", { objets: [], curseurSuivant: null }),
    ficheObjetReseau: espion("ficheObjetReseau", { objet: { id: "1" }, relations: [], tracePartagee: null }),
    declarerDescripteur: vi.fn(async (...args: unknown[]) => {
      w.appels.push({ nom: "declarerDescripteur", args });
      if (w.echec) throw w.echec;
      return { objet: { id: "1" }, cree: (args[2] as string) !== "2" };
    }),
  };
});
vi.mock("../projets-voirie/reseaux/relations.service", async (original) => {
  const m = await original<typeof import("../projets-voirie/reseaux/relations.service")>();
  return {
    ...m,
    listerRelationsProjet: espion("listerRelationsProjet", { relations: [], curseurSuivant: null }),
    declarerRelation: espion("declarerRelation", { relation: { id: "r1" } }),
    transitionRelation: espion("transitionRelation", { relation: { id: "r1" } }),
  };
});
vi.mock("../projets-voirie/reseaux/associations.service", async (original) => {
  const m = await original<typeof import("../projets-voirie/reseaux/associations.service")>();
  return { ...m, proposerAssociations: espion("proposerAssociations", { statut: "PROPOSITIONS_A_VALIDER", bilan: {} }) };
});
vi.mock("../projets-voirie/reseaux/comptage.service", async (original) => {
  const m = await original<typeof import("../projets-voirie/reseaux/comptage.service")>();
  return { ...m, comptageProjet: espion("comptageProjet", { infrastructuresPhysiques: {}, circuitsLogiques: {} }) };
});

import { _installerResolveurCompte } from "../middleware/auth.middleware";
import { signAccessToken } from "../utils/jwt";
import { errorHandler } from "../middleware/error.middleware";
import { ServiceOccupe } from "../import/limiteur";
import { ErreurMetier } from "../projets-voirie/erreurs";
import { projetsVoirieV2Router } from "./projets-voirie.routes";

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use("/api/v2/projets-voirie", projetsVoirieV2Router);
app.use(errorHandler);

const COMPTES: Record<string, { id: string; role: string; modules: string[]; regions?: number[] }> = {
  ADMIN: { id: "u-admin", role: "ADMIN", modules: [] },
  GEST: { id: "u-gest", role: "GESTIONNAIRE", modules: ["projets-voirie"] },
  LECT: { id: "u-lect", role: "LECTEUR", modules: ["projets-voirie"] },
  INSP: { id: "u-insp", role: "INSPECTEUR", modules: ["projets-voirie"] },
  SANS: { id: "u-sans", role: "GESTIONNAIRE", modules: ["troncons"] },
  GEST_R1: { id: "u-gest-1", role: "GESTIONNAIRE", modules: ["projets-voirie"], regions: [1] },
};
const jeton = (c: string) => signAccessToken({ sub: COMPTES[c].id, role: COMPTES[c].role as never, email: `${c}@essai.invalid` });
const BASE = "/api/v2/projets-voirie";
const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const P_R1 = uuid(1), P_R2 = uuid(2), P_SANS = uuid(3), REL = uuid(61), JEU = uuid(71);

beforeEach(() => {
  w.appels = []; w.echec = null;
  w.modules = {}; w.perimetres = {};
  w.regionsProjets = { [P_R1]: 1, [P_R2]: 2, [P_SANS]: null };
  for (const c of Object.values(COMPTES)) { w.modules[c.id] = c.modules; if (c.regions) w.perimetres[c.id] = c.regions; }
  _installerResolveurCompte(async (id) => {
    const c = Object.values(COMPTES).find((x) => x.id === id);
    return c ? { actif: true, lockedUntil: null, role: c.role as never, email: `${id}@essai.invalid` } : null;
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterAll(() => _installerResolveurCompte(null));

const avec = (r: request.Test, compte: string | null) => (compte ? r.set("Authorization", `Bearer ${jeton(compte)}`) : r);
const appelsDe = (nom: string) => w.appels.filter((a) => a.nom === nom);

const JUST = "Controle effectue avec le concessionnaire";
type Route = { m: "get" | "post" | "put"; chemin: string; corps?: object; service: string; lecture: boolean; ok?: number };
const ROUTES: Route[] = [
  { m: "get", chemin: `/${P_R1}/reseau/objets`, service: "listerObjetsReseau", lecture: true },
  { m: "get", chemin: `/${P_R1}/reseau/objets/12`, service: "ficheObjetReseau", lecture: true },
  { m: "put", chemin: `/${P_R1}/reseau/objets/12/descripteur`, corps: { nature: "CIRCUIT_LOGIQUE", justification: JUST }, service: "declarerDescripteur", lecture: false, ok: 201 },
  { m: "get", chemin: `/${P_R1}/reseau/relations`, service: "listerRelationsProjet", lecture: true },
  { m: "post", chemin: `/${P_R1}/reseau/relations`, corps: { type: "PORTE_PAR", sourceObjetId: "1", cibleObjetId: "2", justification: JUST }, service: "declarerRelation", lecture: false, ok: 201 },
  { m: "post", chemin: `/${P_R1}/reseau/relations/${REL}/valider`, corps: { justification: JUST }, service: "transitionRelation", lecture: false },
  { m: "post", chemin: `/${P_R1}/reseau/relations/${REL}/refuser`, corps: { justification: JUST }, service: "transitionRelation", lecture: false },
  { m: "post", chemin: `/${P_R1}/reseau/relations/${REL}/revoquer`, corps: { justification: JUST }, service: "transitionRelation", lecture: false },
  { m: "post", chemin: `/${P_R1}/reseau/associations/proposer`, corps: {}, service: "proposerAssociations", lecture: false, ok: 201 },
  { m: "get", chemin: `/${P_R1}/reseau/comptage`, service: "comptageProjet", lecture: true },
];
const OK = (r: Route) => r.ok ?? 200;
const appeler = (r: Route, compte: string | null, chemin = r.chemin, corps = r.corps) => {
  const req = avec(request(app)[r.m](`${BASE}${chemin}`), compte);
  return corps !== undefined ? req.send(corps) : req;
};

describe("gardes : authentification, module, role", () => {
  it("sans jeton : 401 sur les 10 routes, aucun service appele", async () => {
    expect(ROUTES).toHaveLength(10);
    for (const r of ROUTES) expect((await appeler(r, null)).status, `${r.m} ${r.chemin}`).toBe(401);
    expect(w.appels).toEqual([]);
  });

  it("sans la cle `projets-voirie` : 403 sur les 10 routes, aucun service appele", async () => {
    for (const r of ROUTES) expect((await appeler(r, "SANS")).status, `${r.m} ${r.chemin}`).toBe(403);
    expect(w.appels).toEqual([]);
  });

  it("un LECTEUR et un INSPECTEUR avec la cle lisent (200) et ne peuvent ecrire aucune des 6 routes d'ecriture (403)", async () => {
    for (const compte of ["LECT", "INSP"]) {
      for (const r of ROUTES) expect((await appeler(r, compte)).status, `${compte} ${r.m} ${r.chemin}`).toBe(r.lecture ? 200 : 403);
    }
    for (const nom of ["declarerDescripteur", "declarerRelation", "transitionRelation", "proposerAssociations"]) expect(appelsDe(nom), nom).toEqual([]);
  });

  it("GESTIONNAIRE et ADMIN (sans cle de module) ecrivent et lisent", async () => {
    for (const compte of ["GEST", "ADMIN"]) for (const r of ROUTES) expect((await appeler(r, compte)).status, `${compte} ${r.m} ${r.chemin}`).toBe(OK(r));
  });

  it("l'acteur transmis au service est le compte du jeton, jamais un champ du corps", async () => {
    await appeler(ROUTES[2], "GEST", ROUTES[2].chemin, { nature: "ACTIF_PHYSIQUE", justification: JUST });
    const [acteur, projetId, objetId] = appelsDe("declarerDescripteur")[0].args as [{ id: string; role: string }, string, string];
    expect(acteur).toMatchObject({ id: "u-gest", role: "GESTIONNAIRE" });
    expect(projetId).toBe(P_R1);
    expect(objetId).toBe("12");
    const rep = await appeler(ROUTES[2], "GEST", ROUTES[2].chemin, { nature: "ACTIF_PHYSIQUE", justification: JUST, declareParId: "u-admin" });
    expect(rep.status).toBe(400);
  });

  it("les reponses ne sont jamais mises en cache ni reinterpretees par le navigateur", async () => {
    const r = await appeler(ROUTES[0], "GEST");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("aucune route ne cree d'ordre, de deplacement ni de decision automatique", () => {
    expect(ROUTES.filter((r) => /ordre|deplac|ordonn/i.test(r.chemin))).toEqual([]);
  });
});

describe("controle territorial : 404 masque", () => {
  it("hors perimetre, projet sans region et projet inconnu : la MEME reponse 404, meme avec un corps invalide, avant toute validation", async () => {
    const corps = { error: "Projet introuvable", code: "PROJET_INTROUVABLE" };
    for (const r of ROUTES) {
      for (const projet of [P_R2, P_SANS, uuid(99)]) {
        const chemin = r.chemin.replace(P_R1, projet);
        const rep = await appeler(r, "GEST_R1", chemin, r.m === "get" ? undefined : { champInvalide: true });
        expect(rep.status, `${r.m} ${chemin}`).toBe(404);
        expect(rep.body).toEqual(corps);
      }
    }
    expect(w.appels).toEqual([]);
  });

  it("dans son perimetre, un compte regional lit et ecrit ; un compte national passe la garde", async () => {
    expect((await appeler(ROUTES[0], "GEST_R1")).status).toBe(200);
    expect((await appeler(ROUTES[8], "GEST_R1")).status).toBe(201);
    expect((await appeler(ROUTES[0], "GEST", ROUTES[0].chemin.replace(P_R1, P_R2))).status).toBe(200);
  });
});

describe("identifiants et caracteres", () => {
  it("identifiant d'objet qui n'est pas un entier positif sur 18 chiffres au plus : 400 IDENTIFIANT_INVALIDE, aucun service appele", async () => {
    for (const id of ["abc", "0", "01", "-1", "1.5", "1234567890123456789", "%00", "1%20OR%201"]) {
      for (const [m, suffixe] of [["get", ""], ["put", "/descripteur"]] as const) {
        const rep = await avec(request(app)[m](`${BASE}/${P_R1}/reseau/objets/${id}${suffixe}`), "ADMIN").send(m === "put" ? { justification: JUST } : undefined);
        expect(rep.status, `${m} ${id}`).toBe(400);
        expect(rep.body.code, `${m} ${id}`).toBe("IDENTIFIANT_INVALIDE");
      }
    }
    expect(w.appels).toEqual([]);
  });

  it("identifiant de relation qui n'est pas un UUID : 400 IDENTIFIANT_INVALIDE", async () => {
    for (const action of ["valider", "refuser", "revoquer"]) {
      const rep = await avec(request(app).post(`${BASE}/${P_R1}/reseau/relations/zzz/${action}`), "ADMIN").send({ justification: JUST });
      expect(rep.status).toBe(400);
      expect(rep.body.code).toBe("IDENTIFIANT_INVALIDE");
    }
    expect(w.appels).toEqual([]);
  });

  it("un octet NUL dans un parametre ou un corps : 400 PARAMETRES_INVALIDES", async () => {
    const q = await avec(request(app).get(`${BASE}/${P_R1}/reseau/objets?q=a%00b`), "GEST");
    const c = await avec(request(app).put(`${BASE}/${P_R1}/reseau/objets/12/descripteur`).send({ justification: "Controle\u0000effectue ici" }), "GEST");
    expect(q.status).toBe(400);
    expect(q.body.code).toBe("PARAMETRES_INVALIDES");
    expect(c.status).toBe(400);
    expect(c.body.code).toBe("PARAMETRES_INVALIDES");
    expect(w.appels).toEqual([]);
  });
});

describe("validation des entrees : 400 avec code, jamais 500, le service n'est pas appele", () => {
  const ecrire = (m: "post" | "put", chemin: string, corps: object | undefined, compte = "GEST") => avec(request(app)[m](`${BASE}${chemin}`), compte).send(corps);
  const D = `/${P_R1}/reseau/objets/12/descripteur`;
  const ok = { nature: "CIRCUIT_LOGIQUE", justification: JUST };

  it("descripteur : natures non declarables, classe hors A-E, precisions nulles ou negatives, profondeur negative, champs inconnus, justification courte", async () => {
    const mauvais: object[] = [
      { ...ok, nature: "AXE" }, { ...ok, nature: "EMPRISE" }, { ...ok, nature: "INCONNUE" }, { ...ok, nature: "circuit" },
      { ...ok, classePrecision: "F" }, { ...ok, classePrecision: "a" },
      { ...ok, precisionHorizontaleM: 0 }, { ...ok, precisionHorizontaleM: -1 }, { ...ok, precisionHorizontaleM: 0.004 }, { ...ok, precisionVerticaleM: 100_001 }, { ...ok, precisionHorizontaleM: "2" },
      { ...ok, profondeurM: -0.5 }, { ...ok, profondeurM: 10_001 }, { ...ok, altitudeM: -501 }, { ...ok, altitudeM: 9_001 }, { ...ok, profondeurM: "1" },
      { ...ok, typeObjet: "cable" }, { ...ok, typeObjet: "A" }, { ...ok, typeObjet: "X".repeat(41) },
      { ...ok, dateConstat: "2026-02-30" }, { ...ok, dateConstat: "pas une date" }, { ...ok, niveauConfiance: "TRES_ELEVE" }, { ...ok, statutQualite: "VALIDE" },
      { ...ok, methodeCollecte: "x".repeat(201) }, { ...ok, referenceVerticale: "x".repeat(121) },
      { nature: "CIRCUIT_LOGIQUE" }, { ...ok, justification: "court" }, { ...ok, justification: "          " }, { ...ok, justification: "x".repeat(2001) },
      { ...ok, jeuId: JEU }, { ...ok, objetId: "12" }, { ...ok, declareParId: "u-admin" }, [], "texte",
    ];
    for (const corps of mauvais) {
      const rep = await ecrire("put", D, corps as object);
      expect(rep.status, JSON.stringify(corps)).toBe(400);
      expect(rep.body.code, JSON.stringify(corps)).toMatch(/^(CHAMPS_INVALIDES|PARAMETRES_INVALIDES)$/);
    }
    expect(appelsDe("declarerDescripteur")).toEqual([]);
  });

  it("descripteur : une declaration complete et valide passe ; les valeurs omises sont transmises NULLES (jamais heritees ni deduites), les precisions arrondies au centimetre", async () => {
    const rep = await ecrire("put", D, { nature: "ACTIF_PHYSIQUE", typeObjet: "CABLE", classePrecision: "B", precisionHorizontaleM: 1.234, profondeurM: 1.2, referenceVerticale: "terrain naturel", justification: JUST });
    expect(rep.status).toBe(201);
    const corps = appelsDe("declarerDescripteur")[0].args[3] as Record<string, unknown>;
    expect(corps).toEqual({
      nature: "ACTIF_PHYSIQUE", typeObjet: "CABLE", classePrecision: "B", precisionHorizontaleM: 1.23, precisionVerticaleM: null, methodeCollecte: null, dateConstat: null,
      niveauConfiance: null, statutQualite: "INCONNU", profondeurM: 1.2, altitudeM: null, referenceVerticale: "terrain naturel", justification: JUST,
    });
  });

  it("descripteur : 201 a la creation, 200 a la correction (le descripteur est remplace, jamais supprime : aucune route DELETE)", async () => {
    expect((await ecrire("put", `/${P_R1}/reseau/objets/1/descripteur`, ok)).status).toBe(201);
    expect((await ecrire("put", `/${P_R1}/reseau/objets/2/descripteur`, ok)).status).toBe(200);
    const sup = await avec(request(app).delete(`${BASE}/${P_R1}/reseau/objets/12/descripteur`), "ADMIN");
    expect(sup.status).toBe(404);
  });

  it("relation : type inconnu, identifiants non entiers, justification courte, champs inconnus", async () => {
    const R = `/${P_R1}/reseau/relations`;
    const bon = { type: "PORTE_PAR", sourceObjetId: "1", cibleObjetId: "2", justification: JUST };
    const mauvais: object[] = [
      { ...bon, type: "RACCORDE_A" }, { ...bon, sourceObjetId: "abc" }, { ...bon, cibleObjetId: "0" }, { ...bon, sourceObjetId: 1 }, { ...bon, justification: "court" },
      { ...bon, statut: "VALIDEE" }, { type: "PORTE_PAR", sourceObjetId: "1", justification: JUST }, [],
    ];
    for (const corps of mauvais) expect((await ecrire("post", R, corps)).status, JSON.stringify(corps)).toBe(400);
    expect(appelsDe("declarerRelation")).toEqual([]);
    expect((await ecrire("post", R, bon)).status).toBe(201);
  });

  it("validation, refus, revocation : justification de 10 caracteres au moins, aucun autre champ", async () => {
    for (const action of ["valider", "refuser", "revoquer"]) {
      for (const corps of [{}, { justification: "court" }, { justification: JUST, statut: "VALIDEE" }]) {
        const rep = await ecrire("post", `/${P_R1}/reseau/relations/${REL}/${action}`, corps);
        expect(rep.status, `${action} ${JSON.stringify(corps)}`).toBe(400);
        expect(rep.body.code).toBe("JUSTIFICATION_INVALIDE");
      }
    }
    expect(appelsDe("transitionRelation")).toEqual([]);
    await ecrire("post", `/${P_R1}/reseau/relations/${REL}/revoquer`, { justification: JUST });
    expect(appelsDe("transitionRelation")[0].args.slice(2)).toEqual([REL, "revoquer", JUST]);
  });

  it("proposition d'associations : seuil, nombre par circuit et tolerances bornes ; jamais la classe E", async () => {
    const P = `/${P_R1}/reseau/associations/proposer`;
    const mauvais: object[] = [
      { couvertureMin: 0.2 }, { couvertureMin: 1.5 }, { couvertureMin: "0.9" }, { parCircuitMax: 0 }, { parCircuitMax: 21 }, { parCircuitMax: 2.5 },
      { jeuId: "pas-un-uuid" }, { tolerances: { E: 5 } }, { tolerances: { A: 0 } }, { tolerances: { D: 101 } }, { tolerances: { INCONNUE: -1 } }, { projetId: P_R2 }, [],
    ];
    for (const corps of mauvais) expect((await ecrire("post", P, corps)).status, JSON.stringify(corps)).toBe(400);
    expect(appelsDe("proposerAssociations")).toEqual([]);
    const rep = await ecrire("post", P, { jeuId: JEU, couvertureMin: 0.8, parCircuitMax: 3, tolerances: { A: 0.4, INCONNUE: 3 } });
    expect(rep.status).toBe(201);
    expect(appelsDe("proposerAssociations")[0].args.slice(2)).toEqual([{ jeuId: JEU, couvertureMin: 0.8, parCircuitMax: 3, tolerances: { A: 0.4, INCONNUE: 3 } }]);
    expect((await ecrire("post", P, undefined)).status).toBe(201);
  });

  it("listes : bornes de limite, filtres inconnus, valeurs hors enumeration", async () => {
    const chemins = [
      `/${P_R1}/reseau/objets?limite=0`, `/${P_R1}/reseau/objets?limite=201`, `/${P_R1}/reseau/objets?nature=AXE`, `/${P_R1}/reseau/objets?jeuId=zzz`,
      `/${P_R1}/reseau/objets?typeObjet=cable`, `/${P_R1}/reseau/objets?inconnu=1`, `/${P_R1}/reseau/objets?curseur=${"x".repeat(101)}`,
      `/${P_R1}/reseau/relations?limite=0`, `/${P_R1}/reseau/relations?statut=ANNULEE`, `/${P_R1}/reseau/relations?type=X`, `/${P_R1}/reseau/relations?objetId=abc`,
      `/${P_R1}/reseau/relations?origine=ROBOT`, `/${P_R1}/reseau/relations?inconnu=1`, `/${P_R1}/reseau/comptage?jeuId=zzz`, `/${P_R1}/reseau/comptage?inclureNonAutorises=oui`, `/${P_R1}/reseau/comptage?x=1`,
    ];
    for (const c of chemins) {
      const rep = await avec(request(app).get(`${BASE}${c}`), "GEST");
      expect(rep.status, c).toBe(400);
      expect(rep.body.code, c).toBe("PARAMETRES_INVALIDES");
    }
    expect(w.appels).toEqual([]);
  });

  it("liste des relations : un curseur forge est refuse (400 CURSEUR_INVALIDE) avant toute lecture", async () => {
    const forges = ["pas-un-curseur", Buffer.from(JSON.stringify({ t: "2026-01-01T00:00:00.000Z", i: "A".repeat(36) })).toString("base64url"), Buffer.from(JSON.stringify({ t: "1500-01-01T00:00:00.000Z", i: uuid(5) })).toString("base64url")];
    for (const c of forges) {
      const rep = await avec(request(app).get(`${BASE}/${P_R1}/reseau/relations?curseur=${c}`), "GEST");
      expect(rep.status, c).toBe(400);
      expect(rep.body.code).toBe("CURSEUR_INVALIDE");
    }
    expect(appelsDe("listerRelationsProjet")).toEqual([]);
  });

  it("liste des relations : filtres transmis tels quels (statuts en liste)", async () => {
    const rep = await avec(request(app).get(`${BASE}/${P_R1}/reseau/relations?statut=PROPOSEE,VALIDEE&type=PORTE_PAR&objetId=12&limite=7`), "LECT");
    expect(rep.status).toBe(200);
    expect(appelsDe("listerRelationsProjet")[0].args[2]).toMatchObject({ statuts: ["PROPOSEE", "VALIDEE"], type: "PORTE_PAR", objetId: "12", limite: 7 });
  });
});

describe("quarantaine : reservee aux roles qui decident", () => {
  it("un lecteur qui demande inclureNonAutorises=true recoit 403 QUARANTAINE_RESERVEE, sans lecture", async () => {
    for (const compte of ["LECT", "INSP"]) {
      const rep = await avec(request(app).get(`${BASE}/${P_R1}/reseau/comptage?inclureNonAutorises=true`), compte);
      expect(rep.status).toBe(403);
      expect(rep.body.code).toBe("QUARANTAINE_RESERVEE");
    }
    expect(appelsDe("comptageProjet")).toEqual([]);
  });

  it("un gestionnaire peut l'obtenir ; sans l'option, un lecteur lit les jeux autorises", async () => {
    expect((await avec(request(app).get(`${BASE}/${P_R1}/reseau/comptage?inclureNonAutorises=true`), "GEST")).status).toBe(200);
    expect(appelsDe("comptageProjet")[0].args[2]).toEqual({ jeuId: undefined, inclureNonAutorises: true });
    expect((await avec(request(app).get(`${BASE}/${P_R1}/reseau/comptage`), "LECT")).status).toBe(200);
    expect(appelsDe("comptageProjet")[1].args[2]).toEqual({ jeuId: undefined, inclureNonAutorises: false });
  });
});

describe("erreurs typees des services", () => {
  const cas: [ErreurMetier, number, string][] = [
    [new ErreurMetier(404, "OBJET_INTROUVABLE", "Objet de réseau introuvable"), 404, "OBJET_INTROUVABLE"],
    [new ErreurMetier(409, "RELATION_DEJA_CONNUE", "deja", { relationId: REL, statut: "REFUSEE" }), 409, "RELATION_DEJA_CONNUE"],
    [new ErreurMetier(409, "TRANSITION_INTERDITE", "interdite", { statut: "VALIDEE" }), 409, "TRANSITION_INTERDITE"],
    [new ErreurMetier(422, "NATURE_RELATION_INCOMPATIBLE", "natures"), 422, "NATURE_RELATION_INCOMPATIBLE"],
    [new ErreurMetier(422, "INCOHERENCE_REFUSEE", "Refusé par la base"), 422, "INCOHERENCE_REFUSEE"],
    [new ErreurMetier(503, "PROJET_OCCUPE", "occupe"), 503, "PROJET_OCCUPE"],
    [new ErreurMetier(504, "ASSOCIATION_TROP_LONGUE", "trop long"), 504, "ASSOCIATION_TROP_LONGUE"],
  ];
  it("une erreur metier est rendue au format { error, code, ... } avec son statut", async () => {
    for (const [e, statut, code] of cas) {
      w.echec = e;
      const rep = await appelerEcriture();
      expect(rep.status, code).toBe(statut);
      expect(rep.body.code).toBe(code);
      expect(typeof rep.body.error).toBe("string");
    }
  });
  const appelerEcriture = () => avec(request(app).post(`${BASE}/${P_R1}/reseau/relations`), "GEST").send({ type: "PORTE_PAR", sourceObjetId: "1", cibleObjetId: "2", justification: JUST });

  it("429 ASSOCIATION_TROP_FREQUENTE porte Retry-After ; 503 SERVICE_OCCUPE aussi", async () => {
    w.echec = new ErreurMetier(429, "ASSOCIATION_TROP_FREQUENTE", "trop frequente", { retryAfterS: 17 });
    const a = await avec(request(app).post(`${BASE}/${P_R1}/reseau/associations/proposer`), "GEST").send({});
    expect(a.status).toBe(429);
    expect(a.headers["retry-after"]).toBe("17");
    expect(a.body).toMatchObject({ code: "ASSOCIATION_TROP_FREQUENTE", retryAfterS: 17 });
    w.echec = new ServiceOccupe("trop de calculs simultanes", 5);
    const b = await avec(request(app).get(`${BASE}/${P_R1}/reseau/comptage`), "GEST");
    expect(b.status).toBe(503);
    expect(b.headers["retry-after"]).toBe("5");
    expect(b.body.code).toBe("SERVICE_OCCUPE");
  });
});
