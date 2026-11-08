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
const P_R1 = uuid(1), P_R2 = uuid(2), J1 = uuid(11);
const CSV = Buffer.from("x;y\n1;2\n");

beforeEach(() => {
  w.appels = []; w.echec = null;
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
const appelsDe = (nom: string) => w.appels.filter((a) => a.nom === nom);

const ROUTES: [string, string, string][] = [
  ["get", `/${P_R1}/import/options`, "options"],
  ["post", `/${P_R1}/import/inventaire`, "inventaire"],
  ["post", `/${P_R1}/import/apercu`, "apercu"],
  ["get", `/${P_R1}/jeux/${J1}/delta`, "delta"],
  ["post", `/${P_R1}/jeux/${J1}/revue-suppressions`, "revue"],
  ["post", `/${P_R1}/jeux/${J1}/retour-arriere`, "retour"],
];
const lancer = (m: string, chemin: string, compte: string | null) => avec((request(app) as unknown as Record<string, (u: string) => request.Test>)[m](`${BASE}${chemin}`), compte);

describe("gardes : authentification, module, role (toutes les routes du lot A1 sont reservees a ADMIN et GESTIONNAIRE)", () => {
  it("sans jeton : 401 ; sans la cle du module : 403 ; lecteur : 403 meme en lecture ; aucun service appele", async () => {
    for (const [m, c] of ROUTES) {
      expect((await lancer(m, c, null)).status, `${m} ${c} sans jeton`).toBe(401);
      expect((await lancer(m, c, "SANS")).status, `${m} ${c} sans module`).toBe(403);
      expect((await lancer(m, c, "LECT")).status, `${m} ${c} lecteur`).toBe(403);
    }
    expect(w.appels).toEqual([]);
  });

  it("un compte regional ne voit pas un projet d'une autre region : 404 identique, AVANT la validation du corps et la lecture du fichier", async () => {
    for (const [m, c] of ROUTES) {
      const hors = c.replace(P_R1, P_R2);
      const r = await lancer(m, hors, "GEST_R1").send({});
      expect(r.status, `${m} ${hors}`).toBe(404);
      expect(r.body.code).toBe("PROJET_INTROUVABLE");
    }
    expect(w.appels).toEqual([]);
  });

  it("identifiant de projet ou de jeu qui n'est pas un UUID : 400 IDENTIFIANT_INVALIDE ; reponses no-store", async () => {
    expect((await lancer("get", `/pas-un-uuid/import/options`, "GEST")).body.code).toBe("IDENTIFIANT_INVALIDE");
    expect((await lancer("get", `/${P_R1}/jeux/pas-un-uuid/delta`, "GEST")).body.code).toBe("IDENTIFIANT_INVALIDE");
    expect((await lancer("get", `/${P_R1}/jeux/${J1}%00/delta`, "GEST")).status).toBe(400);
    const r = await lancer("get", `/${P_R1}/import/options`, "GEST");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("GET /import/options", () => {
  it("formats, non pris en charge, limites, CRS source autorises (liste blanche), zone attendue, champs cibles, options CSV, mode de conservation", async () => {
    const r = await lancer("get", `/${P_R1}/import/options`, "GEST");
    expect(r.status).toBe(200);
    expect(r.body.formats.map((f: { format: string }) => f.format)).toEqual(["KML", "KMZ", "GEOJSON", "GPX", "CSV"]);
    expect(r.body.formats.find((f: { format: string }) => f.format === "CSV")).toMatchObject({ choixCrs: "obligatoire", crsParDefinition: null });
    expect(r.body.nonSupportes.map((f: { format: string }) => f.format)).toEqual(["DWG"]); // lot B2 : GeoPackage, Shapefile et DXF sont annonces par formatsGdal (indisponibles par defaut)
    expect(r.body.crs.cible).toMatchObject({ epsg: 4326, unite: "degre" });
    expect(r.body.crs.sourcesAutorises).toEqual([
      { epsg: 4326, nom: "WGS 84", unite: "degre", disponible: true },
      { epsg: 32628, nom: null, unite: null, disponible: false },
      { epsg: 32629, nom: "WGS 84 / UTM zone 29N", unite: "metre", disponible: true },
    ]);
    expect(r.body.crs.zoneAttendue.bbox).toEqual([-15.2, 7.1, -7.5, 12.8]);
    expect(r.body.champsCibles.map((c: { champ: string }) => c.champ)).toContain("identifiant");
    expect(r.body.limites).toMatchObject({ tailleMaxOctets: 26214400, objetsMax: 50000, archive: { entreesMax: 100, tauxCompressionMax: 100 }, csv: { lignesMax: 500000 } });
    expect(r.body.conservationOriginal).toBe("EMPREINTE_SEULE");
  });
});

describe("inventaire et apercu : fichier et options", () => {
  const envoi = (chemin: string, champs: Record<string, string>, contenu: Buffer | null = CSV) => {
    let r = lancer("post", chemin, "GEST");
    for (const [k, v] of Object.entries(champs)) r = r.field(k, v);
    return contenu ? r.attach("fichier", contenu, { filename: "relevé.csv" }) : r;
  };

  it("sans fichier : 400 FICHIER_MANQUANT ; options invalides : 400 CHAMPS_INVALIDES ; aucun service appele", async () => {
    for (const chemin of [`/${P_R1}/import/inventaire`, `/${P_R1}/import/apercu`]) {
      expect((await envoi(chemin, {}, null)).body.code).toBe("FICHIER_MANQUANT");
      for (const champs of [{ epsgSource: "abc" }, { epsgSource: "12" }, { epsgSource: "32629.5" }, { sha256Attendu: "xyz" }, { delimiteur: ";;" }, { encodage: "ebcdic" }, { separateurDecimal: ";" },
        { confirmerHorsZone: "peut-etre" }, { colonneX: "x".repeat(201) }, { inconnu: "x" }, { mapping: "x".repeat(4001) }] as Record<string, string>[]) {
        const r = await envoi(chemin, champs);
        expect(r.status, `${chemin} ${JSON.stringify(champs)}`).toBe(400);
        expect(r.body.code).toBe("CHAMPS_INVALIDES");
      }
    }
    expect(w.appels).toEqual([]);
  });

  it("mapping hors liste blanche, illisible ou mal forme : 400 MAPPING_INVALIDE", async () => {
    for (const mapping of ["pas du json", '{"geom":"c"}', '["a"]', '{"nom":3}', '{"nom":""}']) {
      const r = await envoi(`/${P_R1}/import/apercu`, { mapping });
      expect(r.status, mapping).toBe(400);
      expect(r.body.code).toBe("MAPPING_INVALIDE");
    }
    expect(appelsDe("apercuFichier")).toEqual([]);
  });

  it("options valides transmises au service : fichier, nom UTF-8, CRS, colonnes CSV, mapping valide ; les champs du depot sont ignores ; tabulation sous trois ecritures", async () => {
    const r = await envoi(`/${P_R1}/import/apercu`, {
      epsgSource: "32629", delimiteur: "\\t", encodage: "windows-1252", separateurDecimal: ",", colonneX: "X", colonneY: "Y", colonneCle: "axe", colonneOrdre: "n",
      couche: "c1", entreeKml: "doc.kml", confirmerHorsZone: "true", mapping: '{"nom":"Libelle","identifiant":"Code"}', role: "AUTRE", classePrecision: "B",
    });
    expect(r.status).toBe(200);
    const a = appelsDe("apercuFichier")[0].args[0] as { fichier: Buffer; nomFichier: string; options: Record<string, unknown> };
    expect(a.nomFichier).toBe("relevé.csv");
    expect(a.fichier.equals(CSV)).toBe(true);
    expect(a.options).toEqual({
      couche: "c1", entreeKml: "doc.kml", epsgSource: 32629, confirmerHorsZone: true, mapping: { nom: "Libelle", identifiant: "Code" },
      csv: { delimiteur: "\t", encodage: "windows-1252", separateurDecimal: ",", colonneX: "X", colonneY: "Y", colonneWkt: undefined, colonneCle: "axe", colonneOrdre: "n" },
    });
    for (const d of ["tab", "\t"]) {
      await envoi(`/${P_R1}/import/inventaire`, { delimiteur: d });
      const o = (appelsDe("inventaireFichier").at(-1)!.args[0] as { options: { csv: { delimiteur: string } } }).options;
      expect(o.csv.delimiteur).toBe("\t");
    }
  });

  it("champs facultatifs vides : non fournis ; pas de csv sans option CSV ; confirmerHorsZone vaut false par defaut", async () => {
    await envoi(`/${P_R1}/import/inventaire`, { couche: "", epsgSource: "", mapping: "" });
    const o = (appelsDe("inventaireFichier")[0].args[0] as { options: Record<string, unknown> }).options;
    expect(o).toMatchObject({ couche: undefined, epsgSource: undefined, mapping: undefined, csv: undefined, confirmerHorsZone: false });
  });

  it("erreurs de lecture : 422 avec leur code ; confirmation attendue : 409 avec le nombre d'elements ; delai : 504 ; saturation : 503", async () => {
    const { ErreurLecture } = await import("../projets-voirie/lecture.types");
    w.echec = new ErreurLecture("KMZ_PLUSIEURS_KML", "plusieurs");
    let r = await envoi(`/${P_R1}/import/apercu`, {});
    expect([r.status, r.body.code]).toEqual([422, "KMZ_PLUSIEURS_KML"]);
    w.echec = new ErreurMetier(409, "CONFIRMATION_HORS_ZONE_REQUISE", "confirmez", { nbElementsHorsZone: 3 });
    r = await envoi(`/${P_R1}/import/apercu`, {});
    expect([r.status, r.body.code, r.body.nbElementsHorsZone]).toEqual([409, "CONFIRMATION_HORS_ZONE_REQUISE", 3]);
    w.echec = new ErreurMetier(504, "APERCU_TROP_LONG", "trop long");
    expect((await envoi(`/${P_R1}/import/apercu`, {})).status).toBe(504);
    const { ServiceOccupe } = await import("../import/limiteur");
    w.echec = new ServiceOccupe("occupe", 7);
    r = await envoi(`/${P_R1}/import/apercu`, {});
    expect([r.status, r.headers["retry-after"]]).toEqual([503, "7"]);
  });

  it("une erreur interne ne fuit ni message ni trace : 500 generique", async () => {
    w.echec = new Error("connexion a postgres://secret@10.0.0.1 refusee");
    const r = await envoi(`/${P_R1}/import/apercu`, {});
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toMatch(/secret|10\.0\.0\.1|postgres/);
  });
});

describe("depot : les options d'import sont transmises, jamais l'acteur", () => {
  it("couche, CRS, colonnes, mapping, confirmation et empreinte attendue arrivent au service ; champs du jeu inchanges", async () => {
    const r = await avec(request(app).post(`${BASE}/${P_R1}/jeux?simuler=true`), "GEST")
      .field("role", "AUTRE").field("epsgSource", "32629").field("colonneX", "x").field("colonneY", "y").field("mapping", '{"nom":"n"}')
      .field("sha256Attendu", "A".repeat(64)).field("confirmerHorsZone", "true")
      .attach("fichier", CSV, { filename: "p.csv" });
    expect(r.status).toBe(200);
    const a = appelsDe("deposerJeu")[0].args[0] as { champs: Record<string, unknown>; options: Record<string, unknown>; sha256Attendu: string; simuler: boolean; acteur: { id: string } };
    expect(a.acteur.id).toBe("u-gest");
    expect(a.sha256Attendu).toBe("a".repeat(64));
    expect(a.options).toMatchObject({ epsgSource: 32629, confirmerHorsZone: true, mapping: { nom: "n" }, csv: { colonneX: "x", colonneY: "y" } });
    expect(a.champs.role).toBe("AUTRE");
  });
  it("sha256Attendu malforme : 400 ; mapping invalide au depot : 400 MAPPING_INVALIDE ; aucun service appele", async () => {
    const base = () => avec(request(app).post(`${BASE}/${P_R1}/jeux`), "GEST").field("role", "AUTRE").attach("fichier", CSV, { filename: "p.csv" });
    expect((await base().field("sha256Attendu", "123")).body.code).toBe("CHAMPS_INVALIDES");
    expect((await base().field("mapping", '{"x":"y"}')).body.code).toBe("MAPPING_INVALIDE");
    expect(appelsDe("deposerJeu")).toEqual([]);
  });
});

describe("delta, revue des suppressions, retour arriere", () => {
  it("delta : le service recoit le projet et le jeu ; jeu inconnu ou retire : 404 JEU_INTROUVABLE", async () => {
    expect((await lancer("get", `/${P_R1}/jeux/${J1}/delta`, "GEST")).status).toBe(200);
    expect(appelsDe("lireDelta")[0].args).toEqual([P_R1, J1]);
    w.echec = new ErreurMetier(404, "JEU_INTROUVABLE", "Jeu de données introuvable");
    expect((await lancer("get", `/${P_R1}/jeux/${J1}/delta`, "GEST")).body.code).toBe("JEU_INTROUVABLE");
  });

  it("revue : decision ACCEPTER ou REFUSER, justification de 10 caracteres au moins, aucun champ en plus ; le service recoit le compte authentifie", async () => {
    const url = `/${P_R1}/jeux/${J1}/revue-suppressions`;
    for (const corps of [{}, { decision: "ACCEPTER" }, { decision: "PEUT-ETRE", justification: "justification suffisante" }, { decision: "ACCEPTER", justification: "court" }, { decision: "ACCEPTER", justification: "justification suffisante", acteur: "u-admin" }]) {
      const r = await lancer("post", url, "GEST").send(corps);
      expect(r.status, JSON.stringify(corps)).toBe(400);
      expect(r.body.code).toBe("JUSTIFICATION_INVALIDE");
    }
    expect(appelsDe("revueSuppressions")).toEqual([]);
    const ok = await lancer("post", url, "GEST").send({ decision: "ACCEPTER", justification: "  suppressions voulues par le bureau d'etudes  " });
    expect(ok.status).toBe(200);
    const [acteur, projet, jeu, decision, justification] = appelsDe("revueSuppressions")[0].args as [{ id: string }, string, string, string, string];
    expect([acteur.id, projet, jeu, decision, justification]).toEqual(["u-gest", P_R1, J1, "ACCEPTER", "suppressions voulues par le bureau d'etudes"]);
  });

  it("revue et retour arriere : les erreurs metier gardent leur statut et leur code (409)", async () => {
    for (const code of ["AUCUNE_SUPPRESSION", "STATUT_INCOMPATIBLE"]) {
      w.echec = new ErreurMetier(409, code, "x");
      const r = await lancer("post", `/${P_R1}/jeux/${J1}/revue-suppressions`, "GEST").send({ decision: "REFUSER", justification: "justification suffisante" });
      expect([r.status, r.body.code]).toEqual([409, code]);
    }
    for (const code of ["AUCUNE_VERSION_PRECEDENTE", "VERSION_PRECEDENTE_INDISPONIBLE", "DEPOT_EN_ATTENTE"]) {
      w.echec = new ErreurMetier(409, code, "x", { jeuId: J1 });
      const r = await lancer("post", `/${P_R1}/jeux/${J1}/retour-arriere`, "ADMIN").send({ justification: "retour a la version validee" });
      expect([r.status, r.body.code, r.body.jeuId]).toEqual([409, code, J1]);
    }
  });

  it("retour arriere : justification obligatoire de 10 caracteres, aucun champ en plus ; acteur = compte authentifie", async () => {
    const url = `/${P_R1}/jeux/${J1}/retour-arriere`;
    for (const corps of [{}, { justification: "court" }, { justification: "justification suffisante", jeuId: J1 }]) {
      expect((await lancer("post", url, "GEST").send(corps)).status, JSON.stringify(corps)).toBe(400);
    }
    expect(appelsDe("retourArriere")).toEqual([]);
    const r = await lancer("post", url, "ADMIN").send({ justification: "la version 2 contient une erreur de levé" });
    expect(r.status).toBe(200);
    expect((appelsDe("retourArriere")[0].args[0] as { id: string }).id).toBe("u-admin");
  });

});
