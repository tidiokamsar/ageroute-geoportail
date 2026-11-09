import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `/api/v2/projets-voirie/{territoires,referentiels,configuration}` (lot T1) : cablage des gardes (vrais `requireAuth`, `requireModuleAccess`,
 * `requireRole`, garde territoriale a 404 masque), validation des entrees, traduction des erreurs, et changements des routes du socle
 * (territoire obligatoire a la creation, region touchee derivee du territoire, filtre de liste). La BASE et les SERVICES sont simules ; le SQL,
 * les declencheurs et le scenario « nouvelle ville sans code » sont prouves par le banc `tests-integration/territoires-referentiels.integration.mts`.
 */
vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://127.0.0.1:1/essai";
  process.env.JWT_ACCESS_SECRET = "essai-access-secret-essai-access-secret-0000";
  process.env.JWT_REFRESH_SECRET = "essai-refresh-secret-essai-refresh-secret-000";
  process.env.CORS_ORIGIN = "http://localhost:5173";
});

const w = vi.hoisted(() => ({
  modules: {} as Record<string, string[]>,
  perimetres: {} as Record<string, number[]>,
  regionsTerritoires: {} as Record<string, number | null>,
  appels: [] as { nom: string; args: unknown[] }[],
  echec: null as unknown,
}));

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

const espion = (nom: string, valeur: unknown) => async (...args: unknown[]) => {
  w.appels.push({ nom, args });
  if (w.echec) throw w.echec;
  return valeur;
};

vi.mock("../projets-voirie/territoires/territoires.service", () => ({
  listerTerritoires: (...a: unknown[]) => espion("listerTerritoires", { territoires: [], curseurSuivant: null })(...a),
  comptesParTerritoire: (...a: unknown[]) => espion("comptesParTerritoire", { comptes: [], tronque: false })(...a),
  creerTerritoire: (...a: unknown[]) => espion("creerTerritoire", { territoire: { id: "t" }, avertissements: [] })(...a),
  ficheTerritoire: (...a: unknown[]) => espion("ficheTerritoire", { territoire: { id: "t" } })(...a),
  modifierTerritoire: (...a: unknown[]) => espion("modifierTerritoire", { territoire: { id: "t" }, avertissements: [] })(...a),
  retirerTerritoire: (...a: unknown[]) => espion("retirerTerritoire", { id: "t", retire: true })(...a),
  regionsDuTerritoire: async (id: string) => (id in w.regionsTerritoires ? [w.regionsTerritoires[id]] : []),
}));
vi.mock("../projets-voirie/territoires/referentiels.service", () => ({
  listerDomaines: (...a: unknown[]) => espion("listerDomaines", { domaines: [] })(...a),
  listerValeurs: (...a: unknown[]) => espion("listerValeurs", { domaine: "TYPE_RESEAU", valeurs: [] })(...a),
  lireValeur: (...a: unknown[]) => espion("lireValeur", { valeur: {} })(...a),
  creerValeur: (...a: unknown[]) => espion("creerValeur", { valeur: {} })(...a),
  modifierValeur: (...a: unknown[]) => espion("modifierValeur", { valeur: {} })(...a),
  retirerValeur: (...a: unknown[]) => espion("retirerValeur", { code: "X", retire: true })(...a),
  resoudreTypeReseau: async () => ({ famille: "TELECOM", code: null }),
}));
vi.mock("../projets-voirie/territoires/configuration.service", () => ({
  lireConfiguration: (...a: unknown[]) => espion("lireConfiguration", { configuration: [] })(...a),
  lireCle: (...a: unknown[]) => espion("lireCle", { configuration: {} })(...a),
  ecrireConfiguration: (...a: unknown[]) => espion("ecrireConfiguration", { configuration: {} })(...a),
  configurationCourante: async () => ({}),
  listeBlancheEffective: () => ({ valeur: [4326], source: "DEFAUT" }),
}));
vi.mock("../projets-voirie/projets.service", async (original) => {
  const m = await original<typeof import("../projets-voirie/projets.service")>();
  return {
    ...m,
    creerProjet: (...a: unknown[]) => espion("creerProjet", { id: "p1" })(...a),
    listerProjets: (...a: unknown[]) => espion("listerProjets", { projets: [], curseurSuivant: null })(...a),
    regionDuTerritoire: async (id: string | undefined) => (id && id in w.regionsTerritoires ? w.regionsTerritoires[id] : null),
  };
});

import { _installerResolveurCompte } from "../middleware/auth.middleware";
import { signAccessToken } from "../utils/jwt";
import { errorHandler } from "../middleware/error.middleware";
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
  SANS: { id: "u-sans", role: "GESTIONNAIRE", modules: ["troncons"] },
  GEST_R1: { id: "u-gest-1", role: "GESTIONNAIRE", modules: ["projets-voirie"], regions: [1] },
};
const jeton = (c: string) => signAccessToken({ sub: COMPTES[c].id, role: COMPTES[c].role as never, email: `${c}@essai.invalid` });
const BASE = "/api/v2/projets-voirie";
const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const T_R1 = uuid(1), T_R2 = uuid(2), T_NATION = uuid(3), T_INCONNU = uuid(4);
const carre = { type: "Polygon", coordinates: [[[-10, 9], [-9.9, 9], [-9.9, 9.1], [-10, 9.1], [-10, 9]]] };

beforeEach(() => {
  w.appels = []; w.echec = null; w.modules = {}; w.perimetres = {};
  w.regionsTerritoires = { [T_R1]: 1, [T_R2]: 2, [T_NATION]: null };
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

const ECRITURES: [string, string, unknown][] = [
  ["post", "/territoires", { code: "X-1", nom: "x", niveau: "REGION", parentId: T_NATION }],
  ["patch", `/territoires/${T_R1}`, { nom: "y" }],
  ["delete", `/territoires/${T_R1}`, undefined],
  ["post", "/referentiels/TYPE_RESEAU", { code: "FIBRE", libelle: "Fibre", parametres: { famille: "TELECOM" } }],
  ["patch", "/referentiels/TYPE_RESEAU/FIBRE", { libelle: "Fibre optique" }],
  ["delete", "/referentiels/TYPE_RESEAU/FIBRE", undefined],
  ["put", "/configuration/PROTECTIONS", { valeur: {} }],
];

describe("gardes", () => {
  it("sans jeton 401, sans la cle de module 403, sur lecture et ecriture ; aucun service appele", async () => {
    for (const chemin of ["/territoires", "/referentiels", "/configuration", `/territoires/${T_R1}`, "/territoires/comptes"]) {
      expect((await request(app).get(`${BASE}${chemin}`)).status, chemin).toBe(401);
      expect((await avec(request(app).get(`${BASE}${chemin}`), "SANS")).status, chemin).toBe(403);
    }
    expect((await avec(request(app).post(`${BASE}/territoires`).send({}), "SANS")).status).toBe(403);
    expect(w.appels).toEqual([]);
  });

  it("toute ecriture est reservee a l'ADMIN : un GESTIONNAIRE et un LECTEUR recoivent 403, aucun service d'ecriture appele", async () => {
    for (const c of ["GEST", "LECT"]) {
      for (const [m, chemin, corps] of ECRITURES) {
        const r = avec((request(app) as unknown as Record<string, (u: string) => request.Test>)[m](`${BASE}${chemin}`), c);
        expect((await (corps === undefined ? r : r.send(corps as object))).status, `${c} ${m} ${chemin}`).toBe(403);
      }
    }
    expect(w.appels.filter((a) => /^(creer|modifier|retirer|ecrire)/.test(a.nom))).toEqual([]);
  });

  it("l'ADMIN ecrit (201 a la creation, 200 sinon) ; chaque service recoit l'acteur", async () => {
    for (const [m, chemin, corps] of ECRITURES) {
      const r = avec((request(app) as unknown as Record<string, (u: string) => request.Test>)[m](`${BASE}${chemin}`), "ADMIN");
      const rep = await (corps === undefined ? r : r.send(corps as object));
      expect(rep.status, `${m} ${chemin}`).toBe(m === "post" ? 201 : 200);
    }
    expect((appelsDe("creerTerritoire")[0].args[0] as { id: string }).id).toBe("u-admin");
    expect(appelsDe("ecrireConfiguration")).toHaveLength(1);
  });

  it("toute lecture est ouverte a un compte qui a la cle (LECTEUR compris)", async () => {
    for (const chemin of ["/territoires", "/territoires/comptes", `/territoires/${T_R1}`, "/referentiels", "/referentiels/TYPE_RESEAU", "/referentiels/TYPE_RESEAU/TELECOM", "/configuration", "/configuration/PROTECTIONS"]) {
      expect((await avec(request(app).get(`${BASE}${chemin}`), "LECT")).status, chemin).toBe(200);
    }
  });
});

describe("perimetre : 404 masque sur un territoire designe", () => {
  it("hors perimetre, sans region (nation) et inconnu donnent la MEME reponse a un compte regional ; dans sa region, 200", async () => {
    const dans = await avec(request(app).get(`${BASE}/territoires/${T_R1}`), "GEST_R1");
    expect(dans.status).toBe(200);
    for (const t of [T_R2, T_NATION, T_INCONNU]) {
      const r = await avec(request(app).get(`${BASE}/territoires/${t}`), "GEST_R1");
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ error: "Territoire introuvable", code: "TERRITOIRE_INTROUVABLE" });
    }
    expect(appelsDe("ficheTerritoire")).toHaveLength(1);
  });

  it("la liste et les comptes recoivent la portee du compte (regions triees) ; un compte national recoit null", async () => {
    await avec(request(app).get(`${BASE}/territoires`), "GEST_R1");
    await avec(request(app).get(`${BASE}/territoires`), "GEST");
    await avec(request(app).get(`${BASE}/territoires/comptes`), "GEST_R1");
    expect(appelsDe("listerTerritoires").map((a) => a.args[0])).toEqual([[1], null]);
    expect(appelsDe("comptesParTerritoire")[0].args.slice(0, 2)).toEqual([[1], true]);
    await avec(request(app).get(`${BASE}/territoires/comptes`), "LECT");
    expect(appelsDe("comptesParTerritoire")[1].args[1]).toBe(false);
  });
});

describe("validation des entrees", () => {
  it("identifiant de territoire non UUID : 400 IDENTIFIANT_INVALIDE ; octet NUL : 400", async () => {
    expect((await avec(request(app).get(`${BASE}/territoires/pas-un-uuid`), "ADMIN")).body.code).toBe("IDENTIFIANT_INVALIDE");
    expect((await avec(request(app).get(`${BASE}/territoires?q=a%00b`), "ADMIN")).body.code).toBe("PARAMETRES_INVALIDES");
  });

  it("creation : niveau inconnu, champ inconnu, CRS hors bornes, emprise mal typee : 400 CHAMPS_INVALIDES ; le code est mis en majuscules", async () => {
    for (const corps of [
      { code: "X-1", nom: "x", niveau: "VILLE" },
      { code: "X-1", nom: "x", niveau: "REGION", ville: "y" },
      { code: "X-1", nom: "x", niveau: "REGION", crsMetriqueEpsg: 4 },
      { code: "X-1", nom: "x", niveau: "REGION", emprise: { type: "Point", coordinates: [0, 0] } },
      { code: "x", nom: "x", niveau: "REGION" },
    ]) {
      const r = await avec(request(app).post(`${BASE}/territoires`).send(corps), "ADMIN");
      expect(r.status, JSON.stringify(corps)).toBe(400);
      expect(r.body.code).toBe("CHAMPS_INVALIDES");
    }
    await avec(request(app).post(`${BASE}/territoires`).send({ code: "zone-a", nom: "Zone", niveau: "ZONE", parentId: T_NATION, emprise: carre }), "ADMIN");
    expect((appelsDe("creerTerritoire")[0].args[1] as { code: string }).code).toBe("ZONE-A");
  });

  it("modification : parent, niveau et code ne se modifient pas (400) ; corps vide 400", async () => {
    for (const corps of [{ parentId: T_R2 }, { niveau: "ZONE" }, { code: "AUTRE" }, {}]) {
      expect((await avec(request(app).patch(`${BASE}/territoires/${T_R1}`).send(corps), "ADMIN")).status, JSON.stringify(corps)).toBe(400);
    }
    expect(appelsDe("modifierTerritoire")).toEqual([]);
  });

  it("referentiels : domaine mal forme 404 DOMAINE_INCONNU, code mal forme 404 VALEUR_INTROUVABLE, corps strict", async () => {
    expect((await avec(request(app).get(`${BASE}/referentiels/villes`), "LECT")).body.code).toBe("DOMAINE_INCONNU");
    expect((await avec(request(app).get(`${BASE}/referentiels/TYPE_RESEAU/bas`), "LECT")).body.code).toBe("VALEUR_INTROUVABLE");
    expect((await avec(request(app).post(`${BASE}/referentiels/TYPE_RESEAU`).send({ code: "X1", libelle: "x", inconnu: 1 }), "ADMIN")).status).toBe(400);
    expect((await avec(request(app).post(`${BASE}/referentiels/TYPE_RESEAU`).send({ code: "X1", libelle: "x", parametres: "texte" }), "ADMIN")).status).toBe(400);
    expect((await avec(request(app).get(`${BASE}/referentiels/TYPE_RESEAU?tous=peut-etre`), "LECT")).status).toBe(400);
  });

  it("configuration : cle mal formee 404 CLE_INCONNUE ; valeur absente ou non objet 400", async () => {
    expect((await avec(request(app).get(`${BASE}/configuration/minuscules`), "LECT")).body.code).toBe("CLE_INCONNUE");
    expect((await avec(request(app).put(`${BASE}/configuration/PROTECTIONS`).send({}), "ADMIN")).status).toBe(400);
    expect((await avec(request(app).put(`${BASE}/configuration/PROTECTIONS`).send({ valeur: [1] }), "ADMIN")).status).toBe(400);
  });

  it("une erreur metier du service est rendue telle quelle ({ error, code, ...extra })", async () => {
    w.echec = new ErreurMetier(409, "TERRITOIRE_UTILISE", "encore utilise", { enfants: 2, projets: 0 });
    const r = await avec(request(app).delete(`${BASE}/territoires/${T_R1}`), "ADMIN");
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "encore utilise", code: "TERRITOIRE_UTILISE", enfants: 2, projets: 0 });
  });
});

describe("routes du socle modifiees par le lot T1", () => {
  it("creation d'un projet sans territoire : 400 TERRITOIRE_REQUIS, aucun service appele", async () => {
    const r = await avec(request(app).post(BASE).send({ code: "P-1", nom: "Projet" }), "GEST");
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("TERRITOIRE_REQUIS");
    expect(appelsDe("creerProjet")).toEqual([]);
  });

  it("compte regional : la region touchee est celle du territoire ; hors de sa region 403 HORS_PERIMETRE, territoire inconnu 403 REGION_INCONNUE", async () => {
    expect((await avec(request(app).post(BASE).send({ code: "P-1", nom: "Projet", territoireId: T_R1 }), "GEST_R1")).status).toBe(201);
    const hors = await avec(request(app).post(BASE).send({ code: "P-2", nom: "Projet", territoireId: T_R2 }), "GEST_R1");
    expect(hors.status).toBe(403);
    expect(hors.body.code).toBe("HORS_PERIMETRE");
    const inconnu = await avec(request(app).post(BASE).send({ code: "P-3", nom: "Projet", territoireId: T_INCONNU }), "GEST_R1");
    expect(inconnu.status).toBe(403);
    expect(inconnu.body.code).toBe("REGION_INCONNUE");
    expect(appelsDe("creerProjet")).toHaveLength(1);
  });

  it("liste des projets filtree par territoire (UUID exige)", async () => {
    await avec(request(app).get(`${BASE}?territoireId=${T_R1}`), "GEST");
    expect((appelsDe("listerProjets")[0].args[1] as { territoireId: string }).territoireId).toBe(T_R1);
    expect((await avec(request(app).get(`${BASE}?territoireId=abc`), "GEST")).status).toBe(400);
  });

  it("concessionnaire : typeReseau ou typeReseauCode exige", async () => {
    expect((await avec(request(app).post(`${BASE}/concessionnaires`).send({ nom: "Operateur" }), "GEST")).status).toBe(400);
  });
});
