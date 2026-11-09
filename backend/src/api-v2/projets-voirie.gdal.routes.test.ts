import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Routes d'import du lot A1 (`/:id/import/*`, `/:id/jeux/:jeuId/{delta,revue-suppressions,retour-arriere}`) : cablage des gardes, validation
 * des entrees, traduction des erreurs. Les VRAIS `requireAuth`, `requireModuleAccess`, `requireRole`, gardes territoriales, multer et zod ;
 * seuls la BASE et les SERVICES (qui parlent a PostGIS) sont simules. Le SQL, la quarantaine, le delta, la revue et le retour arriere sont
 * prouves par le banc `tests-integration/import-formats.integration.mts`.
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
    dispo: { actif: false, disponible: false, raison: "interrupteur PROJETS_VOIRIE_GDAL desactive" } as { actif: boolean; disponible: boolean; raison: string | null },
  };
  const espion = (nom: string, valeur: unknown) => async (...args: unknown[]) => {
    w.appels.push({ nom, args });
    if (w.echec) throw w.echec;
    return valeur;
  };
  return { w, espion };
});

vi.mock("../lib/prisma", () => {
  const prisma: Record<string, unknown> = new Proxy({}, {
    get: (_t, nom: string) => {
      if (nom === "$queryRaw") {
        return async (a: unknown, ...v: unknown[]) => {
          const texte = Array.isArray(a) ? (a as string[]).join("?") : "";
          if (texte.includes("perimetres_comptes")) return (w.perimetres[String(v[0])] ?? []).map((regionId) => ({ regionId }));
          if (texte.includes("spatial_ref_sys")) {
            const epsg = Number(v[0]);
            return epsg === 32629 ? [{ srid: 32629, srtext: 'PROJCS["WGS 84 / UTM zone 29N"', proj4text: "+proj=utm +zone=29 +datum=WGS84 +units=m +no_defs" }] : [];
          }
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
vi.mock("../projets-voirie/import.service", () => ({
  deposerJeu: vi.fn(async (...args: unknown[]) => {
    w.appels.push({ nom: "deposerJeu", args });
    if (w.echec) throw w.echec;
    return { simulation: (args[0] as { simuler: boolean }).simuler, jeu: { id: "j1" }, resume: {}, avertissements: [], delta: null, remplace: null, suppressions: null, validationGeometrique: { nbProblemes: 0, problemes: [], tronque: false } };
  }),
}));
vi.mock("../projets-voirie/formats/apercu.service", () => ({
  inventaireFichier: vi.fn((...args: unknown[]) => { w.appels.push({ nom: "inventaireFichier", args }); if (w.echec) throw w.echec; return { format: "CSV" }; }),
  apercuFichier: espion("apercuFichier", { format: "CSV" }),
  limiteurApercus: { executer: (f: () => unknown) => f() },
}));
vi.mock("../projets-voirie/formats/revue-versions.service", () => ({
  lireDelta: espion("lireDelta", { delta: null }),
  revueSuppressions: espion("revueSuppressions", { suppressions: { statut: "ACCEPTEES", nb: 2 } }),
  retourArriere: espion("retourArriere", { jeuRestaure: { id: "j1" } }),
}));
vi.mock("../projets-voirie/gdal/jobs.service", () => ({
  LISTE_JOBS_MAX: 50,
  disponibilite: vi.fn(async () => w.dispo),
  creerJob: vi.fn(async (...a: unknown[]) => { w.appels.push({ nom: "creerJob", args: a }); if (w.echec) throw w.echec; return { id: "j-1", statut: "EN_ATTENTE" }; }),
  lireJob: espion("lireJob", { id: "j-1" }),
  listerJobs: espion("listerJobs", { jobs: [], total: 0, tronque: false }),
  annulerJob: espion("annulerJob", { id: "j-1", statut: "ANNULE" }),
  chargerConversion: vi.fn(async (...a: unknown[]) => { w.appels.push({ nom: "chargerConversion", args: a }); if (w.echec) throw w.echec; return { job: { id: "00000021-0000-4000-8000-000000000000", nomFichier: "reseau.gpkg" }, conversion: { format: "GPKG", marqueur: "conv" } }; }),
  consommerDansTx: vi.fn(async () => undefined),
  purgerApresDepot: vi.fn(async (...a: unknown[]) => { w.appels.push({ nom: "purgerApresDepot", args: a }); }),
}));
// Lot T1 : la route lit le contexte spatial du projet (configuration nationale, territoire) ; la base est simulee ici, le contexte aussi :
// contexte national par defaut, liste blanche lue comme avant (environnement, sinon defaut). Le contexte reel est prouve par le banc territoires-referentiels.
vi.mock("../projets-voirie/territoires/contexte-spatial", async () => {
  const { crsSourceAutorises } = await import("../projets-voirie/formats/import.config");
  return {
    contexteSpatialDuProjet: async () => ({
      zoneNationale: { nom: "Guinee", bbox: [-15.2, 7.1, -7.5, 12.8] }, zoneTerritoire: null, territoireId: null, crsImpose: null,
      epsgDefaut: 32629, epsgPour: () => 32629, crsAutorises: crsSourceAutorises(),
    }),
  };
});
vi.mock("../projets-voirie/carte.service", () => ({ carte: vi.fn(async () => ({ jeux: [] })) }));
vi.mock("../projets-voirie/analyse.service", () => ({ analyser: vi.fn(async () => ({})), exporterCsv: vi.fn(async () => ({ csv: "", nbLignes: 0, nomFichier: "x.csv" })) }));

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
const P_R1 = uuid(1), P_R2 = uuid(2);
const JOB = uuid(21);

beforeEach(() => {
  w.appels = []; w.echec = null;
  w.dispo = { actif: false, disponible: false, raison: "interrupteur PROJETS_VOIRIE_GDAL desactive" };
  w.modules = {}; w.perimetres = {};
  w.regionsProjets = { [P_R1]: 1, [P_R2]: 2 };
  for (const c of Object.values(COMPTES)) { w.modules[c.id] = c.modules; if (c.regions) w.perimetres[c.id] = c.regions; }
  _installerResolveurCompte(async (id) => {
    const c = Object.values(COMPTES).find((x) => x.id === id);
    return c ? { actif: true, lockedUntil: null, role: c.role as never, email: `${id}@essai.invalid` } : null;
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterAll(() => _installerResolveurCompte(null));

const avec = (r: request.Test, compte: string | null) => (compte ? r.set("Authorization", `Bearer ${jeton(compte)}`) : r);

const lancer = (m: string, chemin: string, compte: string | null) => avec((request(app) as unknown as Record<string, (u: string) => request.Test>)[m](`${BASE}${chemin}`), compte);
const GPKG = Buffer.from("contenu quelconque");

const ROUTES: [string, string][] = [
  ["post", `/${P_R1}/import/jobs`],
  ["get", `/${P_R1}/import/jobs`],
  ["get", `/${P_R1}/import/jobs/${JOB}`],
  ["post", `/${P_R1}/import/jobs/${JOB}/annuler`],
];

describe("jobs de conversion GDAL : gardes identiques au socle", () => {
  it("sans jeton 401, sans la cle du module 403, lecteur 403 (meme en lecture) ; aucun service appele", async () => {
    for (const [m, c] of ROUTES) {
      expect((await lancer(m, c, null)).status, `${m} ${c} sans jeton`).toBe(401);
      expect((await lancer(m, c, "SANS")).status, `${m} ${c} sans module`).toBe(403);
      expect((await lancer(m, c, "LECT")).status, `${m} ${c} lecteur`).toBe(403);
    }
    expect(w.appels).toEqual([]);
  });

  it("projet d'une autre region : 404 masque AVANT toute validation ; projet inexistant : 404 a tous, ADMIN compris", async () => {
    for (const [m, c] of ROUTES) {
      const r = await lancer(m, c.replace(P_R1, P_R2), "GEST_R1").send({});
      expect(r.status, `${m} ${c}`).toBe(404);
      expect(r.body.code).toBe("PROJET_INTROUVABLE");
      const inconnu = await lancer(m, c.replace(P_R1, uuid(99)), "ADMIN");
      expect(inconnu.status, `${m} ${c} inexistant`).toBe(404);
      expect(inconnu.body.code).toBe("PROJET_INTROUVABLE");
    }
    expect(w.appels).toEqual([]);
  });

  it("identifiants qui ne sont pas des UUID, octet NUL : 400 ; reponses no-store", async () => {
    expect((await lancer("get", `/pas-un-uuid/import/jobs`, "GEST")).body.code).toBe("IDENTIFIANT_INVALIDE");
    expect((await lancer("get", `/${P_R1}/import/jobs/pas-un-uuid`, "GEST")).body.code).toBe("IDENTIFIANT_INVALIDE");
    expect((await lancer("post", `/${P_R1}/import/jobs/${JOB}%00/annuler`, "GEST")).status).toBe(400);
    expect((await lancer("get", `/${P_R1}/import/jobs?limite=%00`, "GEST")).status).toBe(400);
    const r = await lancer("get", `/${P_R1}/import/jobs`, "GEST");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(w.appels.filter((a) => a.nom === "annulerJob" || a.nom === "lireJob")).toEqual([]);
  });
});

describe("POST /import/jobs : creation", () => {
  const envoi = (champs: Record<string, string>, contenu: Buffer | null = GPKG, compte = "GEST") => {
    let r = lancer("post", `/${P_R1}/import/jobs`, compte);
    for (const [k, v] of Object.entries(champs)) r = r.field(k, v);
    return contenu ? r.attach("fichier", contenu, { filename: "reseau.gpkg" }) : r;
  };

  it("202 avec le job ; le CRS confirme et les unites sont transmis au service (nombres, jamais devines)", async () => {
    const r = await envoi({ epsgSource: "32629", unitesDxf: "metre" });
    expect(r.status).toBe(202);
    expect(r.body.job).toMatchObject({ id: "j-1", statut: "EN_ATTENTE" });
    const a = w.appels.find((x) => x.nom === "creerJob")!.args[0] as Record<string, unknown>;
    expect(a).toMatchObject({ projetId: P_R1, nomFichier: "reseau.gpkg", epsgSource: 32629, unitesDxf: "metre" });
    expect((await envoi({})).status).toBe(202);
    expect((w.appels.filter((x) => x.nom === "creerJob")[1].args[0] as Record<string, unknown>).epsgSource).toBeUndefined();
  });

  it("fichier manquant 400 ; champ inconnu, epsg mal forme, unite hors liste : 400 sans service appele", async () => {
    expect((await envoi({}, null)).body.code).toBe("FICHIER_MANQUANT");
    for (const champs of [{ inconnu: "x" }, { epsgSource: "abc" }, { epsgSource: "12" }, { unitesDxf: "pied" }, { jobId: JOB }, { couche: "a" }] as Record<string, string>[]) {
      const r = await envoi(champs);
      expect(r.status, JSON.stringify(champs)).toBe(400);
      expect(r.body.code).toBe("CHAMPS_INVALIDES");
    }
    expect(w.appels).toEqual([]);
  });

  it("les erreurs du service gardent leur code, leur statut et Retry-After (cadence, plafonds, desactive)", async () => {
    w.echec = new ErreurMetier(429, "PLAFOND_JOBS_COMPTE", "trop", { retryAfterS: 30 });
    const a = await envoi({});
    expect(a.status).toBe(429);
    expect(a.body.code).toBe("PLAFOND_JOBS_COMPTE");
    expect(a.headers["retry-after"]).toBe("30");
    w.echec = new ErreurMetier(415, "FORMAT_GDAL_DESACTIVE", "desactive", { formats: ["GPKG"] });
    const b = await envoi({});
    expect(b.status).toBe(415);
    expect(b.body).toMatchObject({ code: "FORMAT_GDAL_DESACTIVE", formats: ["GPKG"] });
  });
});

describe("lecture, liste et annulation", () => {
  it("liste : limite bornee 1 a 50 ; lecture et annulation passent le projet ET le job au service", async () => {
    expect((await lancer("get", `/${P_R1}/import/jobs?limite=0`, "GEST")).status).toBe(400);
    expect((await lancer("get", `/${P_R1}/import/jobs?limite=51`, "GEST")).status).toBe(400);
    expect((await lancer("get", `/${P_R1}/import/jobs?inconnu=1`, "GEST")).status).toBe(400);
    expect((await lancer("get", `/${P_R1}/import/jobs?limite=50`, "GEST")).status).toBe(200);
    expect(w.appels.find((x) => x.nom === "listerJobs")!.args).toEqual([P_R1, 50]);
    expect((await lancer("get", `/${P_R1}/import/jobs/${JOB}`, "GEST")).status).toBe(200);
    expect(w.appels.find((x) => x.nom === "lireJob")!.args).toEqual([P_R1, JOB]);
    expect((await lancer("post", `/${P_R1}/import/jobs/${JOB}/annuler`, "GEST")).status).toBe(200);
    expect(w.appels.find((x) => x.nom === "annulerJob")!.args.slice(1)).toEqual([P_R1, JOB]);
  });

  it("un job d'un autre projet ou desactive : le code du service est rendu tel quel (404 identique, 503 GDAL_DESACTIVE)", async () => {
    w.echec = new ErreurMetier(404, "JOB_INTROUVABLE", "Job de conversion introuvable");
    const r = await lancer("get", `/${P_R1}/import/jobs/${JOB}`, "GEST");
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("JOB_INTROUVABLE");
    w.echec = new ErreurMetier(503, "GDAL_DESACTIVE", "desactive");
    expect((await lancer("get", `/${P_R1}/import/jobs`, "GEST")).body.code).toBe("GDAL_DESACTIVE");
  });
});

describe("GET /import/options : etat des formats GDAL", () => {
  it("desactive (defaut) : GeoPackage, Shapefile ZIP et DXF annonces INDISPONIBLES avec la raison, sans limites ; plus dans nonSupportes", async () => {
    const r = await lancer("get", `/${P_R1}/import/options`, "GEST");
    expect(r.status).toBe(200);
    expect(r.body.formatsGdal).toMatchObject({ actif: false, disponible: false, limites: null });
    expect(r.body.formatsGdal.formats.map((f: { format: string; etat: string }) => [f.format, f.etat])).toEqual([["GPKG", "INDISPONIBLE"], ["SHAPEFILE", "INDISPONIBLE"], ["DXF", "INDISPONIBLE"]]);
    expect(r.body.formatsGdal.formats[0].raison).toMatch(/PROJETS_VOIRIE_GDAL/);
    expect(r.body.nonSupportes.map((f: { format: string }) => f.format)).toEqual(["DWG"]);
  });

  it("actif et dossier d'echange accessible : SUPPORTE, avec les regles de CRS, les entites DXF supportees et les limites", async () => {
    w.dispo = { actif: true, disponible: true, raison: null };
    const r = await lancer("get", `/${P_R1}/import/options`, "GEST");
    const f = r.body.formatsGdal.formats as { format: string; etat: string; crs: string; specifique: Record<string, unknown> }[];
    expect(f.map((x) => x.etat)).toEqual(["SUPPORTE", "SUPPORTE", "SUPPORTE"]);
    expect(f.find((x) => x.format === "DXF")!.specifique.entitesSupportees).toEqual(["LINE", "LWPOLYLINE", "POLYLINE", "3DPOLYLINE"]);
    expect(f.find((x) => x.format === "SHAPEFILE")!.crs).toMatch(/OBLIGATOIRE/);
    expect(r.body.formatsGdal.limites).toMatchObject({ tentativesMax: 3, retentionH: 24, actifsParCompte: 2 });
  });

  it("actif mais dossier d'echange inaccessible : INDISPONIBLE avec la raison", async () => {
    w.dispo = { actif: true, disponible: false, raison: "dossiers d'echange du convertisseur inaccessibles" };
    const r = await lancer("get", `/${P_R1}/import/options`, "GEST");
    expect(r.body.formatsGdal.formats.every((f: { etat: string }) => f.etat === "INDISPONIBLE")).toBe(true);
  });
});

describe("jobId a la place du fichier : memes routes inventaire, apercu et depot", () => {
  const avecJob = (chemin: string, champs: Record<string, string>, fichier = false) => {
    let r = lancer("post", chemin, "GEST").field("jobId", JOB);
    for (const [k, v] of Object.entries(champs)) r = r.field(k, v);
    return fichier ? r.attach("fichier", GPKG, { filename: "x.gpkg" }) : r;
  };

  it("inventaire et apercu : le resultat valide du job est charge (projet, job, couche) puis passe au service du pipeline", async () => {
    for (const chemin of [`/${P_R1}/import/inventaire`, `/${P_R1}/import/apercu`]) {
      w.appels = [];
      expect((await avecJob(chemin, { couche: "axes", epsgSource: "32629" })).status).toBe(200);
      expect(w.appels.find((a) => a.nom === "chargerConversion")!.args).toEqual([P_R1, JOB, { couche: "axes" }]);
      const svc = w.appels.find((a) => a.nom === "inventaireFichier" || a.nom === "apercuFichier")!.args[0] as { conversion: { marqueur: string }; nomFichier: string; fichier: Buffer; options: { epsgSource: number } };
      expect(svc.conversion.marqueur).toBe("conv");
      expect(svc.nomFichier).toBe("reseau.gpkg");
      expect(svc.fichier.length).toBe(0);
      expect(svc.options.epsgSource).toBe(32629);
    }
  });

  it("jobId et fichier s'excluent (400) ; jobId mal forme (400) ; aucun chargement", async () => {
    for (const chemin of [`/${P_R1}/import/inventaire`, `/${P_R1}/import/apercu`, `/${P_R1}/jeux`]) {
      const a = await avecJob(chemin, chemin.endsWith("jeux") ? { role: "AUTRE" } : {}, true);
      expect(a.status, chemin).toBe(400);
      expect(a.body.code).toBe("CHAMPS_INVALIDES");
      const b = await lancer("post", chemin, "GEST").field("jobId", "pas-un-uuid").field("role", "AUTRE");
      expect(b.status, chemin).toBe(400);
    }
    expect(w.appels).toEqual([]);
  });

  it("job non termine, expire, deja utilise : les codes du service sont rendus (409, 410)", async () => {
    w.echec = new ErreurMetier(409, "JOB_NON_TERMINE", "pas termine", { statut: "EN_COURS" });
    const a = await avecJob(`/${P_R1}/import/apercu`, {});
    expect(a.status).toBe(409);
    expect(a.body).toMatchObject({ code: "JOB_NON_TERMINE", statut: "EN_COURS" });
    w.echec = new ErreurMetier(410, "RESULTAT_EXPIRE", "expire");
    expect((await avecJob(`/${P_R1}/import/apercu`, {})).status).toBe(410);
  });

  it("depot : MEME service deposerJeu avec la conversion et la consommation du job ; purge seulement apres un depot REEL", async () => {
    const reel = await avecJob(`/${P_R1}/jeux`, { role: "AUTRE" });
    expect(reel.status).toBe(201);
    const d = w.appels.find((a) => a.nom === "deposerJeu")!.args[0] as { conversion: unknown; apresDepot: unknown; nomFichier: string; simuler: boolean };
    expect(d.conversion).toBeDefined();
    expect(typeof d.apresDepot).toBe("function");
    expect(d.nomFichier).toBe("reseau.gpkg");
    expect(w.appels.filter((a) => a.nom === "purgerApresDepot")).toHaveLength(1);
    w.appels = [];
    const simu = await lancer("post", `/${P_R1}/jeux?simuler=true`, "GEST").field("jobId", JOB).field("role", "AUTRE");
    expect(simu.status).toBe(200);
    expect(w.appels.filter((a) => a.nom === "purgerApresDepot")).toEqual([]);
  });
});
