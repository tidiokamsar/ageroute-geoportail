import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Routes des DOCUMENTS DU PROJET et de « ce que les documents permettent » (lot D1) : `/:id/documents...`, `/:id/completude`.
 * VRAIS `requireAuth`, `requireModuleAccess`, `requireRole`, garde territoriale, reception multipart et validation zod ; seuls la base et les services
 * sont simules. Le SQL, les declencheurs, l'historique et l'audit sont prouves par le banc `tests-integration/documents-projet.integration.mts`.
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
vi.mock("../projets-voirie/documents/documents.service", async (original) => {
  const m = await original<typeof import("../projets-voirie/documents/documents.service")>();
  return {
    ...m,
    listerDocuments: espion("listerDocuments", { documents: [], curseurSuivant: null }), ficheDocument: espion("ficheDocument", { document: { id: "d" }, versions: [] }),
    creerDocument: espion("creerDocument", { document: { id: "d" }, avertissements: [] }), deposerPiece: espion("deposerPiece", { document: { id: "d" }, avertissements: [] }),
    nouvelleVersion: espion("nouvelleVersion", { document: { id: "d2" }, remplace: { id: "d" }, avertissements: [] }), changerStatut: espion("changerStatut", { document: { id: "d" } }),
    retirerDocument: espion("retirerDocument", { id: "d", retire: true }),
  };
});
vi.mock("../projets-voirie/documents/completude.service", () => ({ completudeProjet: espion("completude", { fonctions: [], piecesManquantes: [] }) }));

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
const P1 = uuid(1), P2 = uuid(2), DOC = uuid(11), J1 = uuid(21);
const PDF = Buffer.from("%PDF-1.7\n% document synthetique\n");

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

type Route = { m: "get" | "post" | "delete"; chemin: string; corps?: object; service: string; lecture: boolean; ok: number };
const ROUTES: Route[] = [
  { m: "get", chemin: `/${P1}/completude`, service: "completude", lecture: true, ok: 200 },
  { m: "get", chemin: `/${P1}/documents`, service: "listerDocuments", lecture: true, ok: 200 },
  { m: "get", chemin: `/${P1}/documents/${DOC}`, service: "ficheDocument", lecture: true, ok: 200 },
  { m: "post", chemin: `/${P1}/documents`, corps: { typeCode: "PLAN_AXES", titre: "Plan des axes du bureau d'etudes" }, service: "creerDocument", lecture: false, ok: 201 },
  { m: "post", chemin: `/${P1}/documents/${DOC}/depot`, corps: { reference: "Courrier 2026-118" }, service: "deposerPiece", lecture: false, ok: 200 },
  { m: "post", chemin: `/${P1}/documents/${DOC}/versions`, corps: { jeuId: J1 }, service: "nouvelleVersion", lecture: false, ok: 201 },
  { m: "post", chemin: `/${P1}/documents/${DOC}/statut`, corps: { statut: "EN_ANALYSE" }, service: "changerStatut", lecture: false, ok: 200 },
  { m: "delete", chemin: `/${P1}/documents/${DOC}`, corps: { justification: "Depose par erreur dans ce projet" }, service: "retirerDocument", lecture: false, ok: 200 },
];
const appeler = (r: Route, compte: string | null, chemin = r.chemin, corps = r.corps) => {
  let q = request(app)[r.m](`${BASE}${chemin}`);
  if (compte) q = q.set("Authorization", `Bearer ${jeton(compte)}`);
  return corps !== undefined ? q.send(corps) : q;
};
const appelsDe = (nom: string) => w.appels.filter((a) => a.nom === nom);

describe("gardes : authentification, module, role, territoire", () => {
  it("sans jeton 401, sans la cle 403, sur les 8 routes ; aucun service appele", async () => {
    expect(ROUTES).toHaveLength(8);
    for (const r of ROUTES) expect((await appeler(r, null)).status, r.chemin).toBe(401);
    for (const r of ROUTES) expect((await appeler(r, "SANS")).status, r.chemin).toBe(403);
    expect(w.appels).toEqual([]);
  });
  it("un LECTEUR lit (200) et n'ecrit rien (403) ; GESTIONNAIRE et ADMIN ecrivent", async () => {
    for (const r of ROUTES) expect((await appeler(r, "LECT")).status, `LECT ${r.m} ${r.chemin}`).toBe(r.lecture ? 200 : 403);
    for (const nom of ["creerDocument", "deposerPiece", "nouvelleVersion", "changerStatut", "retirerDocument"]) expect(appelsDe(nom), nom).toEqual([]);
    for (const r of ROUTES) expect((await appeler(r, "GEST")).status, `GEST ${r.m} ${r.chemin}`).toBe(r.ok);
    for (const r of ROUTES) expect((await appeler(r, "ADMIN")).status, `ADMIN ${r.m} ${r.chemin}`).toBe(r.ok);
  });
  it("hors perimetre ou projet inconnu : le MEME 404, meme avec un corps invalide, avant toute validation et toute reception", async () => {
    for (const r of ROUTES) {
      for (const projet of [P2, uuid(99)]) {
        const rep = await appeler(r, "GEST_R1", r.chemin.replace(P1, projet), r.m === "get" ? undefined : { inconnu: true });
        expect(rep.status, `${r.m} ${r.chemin} ${projet}`).toBe(404);
        expect(rep.body).toEqual({ error: "Projet introuvable", code: "PROJET_INTROUVABLE" });
      }
    }
    expect(w.appels).toEqual([]);
  });
  it("l'acteur transmis est celui du jeton, jamais un champ du corps ; le compte qui ne decide pas est transmis tel quel (le service filtre les VALIDE)", async () => {
    await appeler(ROUTES[6], "GEST", ROUTES[6].chemin, { statut: "EN_ANALYSE" });
    const [acteur, projetId, docId, statut] = appelsDe("changerStatut")[0].args as [{ id: string; role: string }, string, string, string];
    expect(acteur).toMatchObject({ id: "u-gest", role: "GESTIONNAIRE" });
    expect([projetId, docId, statut]).toEqual([P1, DOC, "EN_ANALYSE"]);
    await appeler(ROUTES[1], "LECT");
    expect((appelsDe("listerDocuments")[0].args[0] as { role: string }).role).toBe("LECTEUR");
  });
});

describe("reception : multipart avec fichier, JSON sans fichier", () => {
  it("creation multipart : le fichier (contenu, nom) et les champs texte sont transmis au service ; le contenu n'est pas dans la reponse", async () => {
    const r = await request(app).post(`${BASE}/${P1}/documents`).set("Authorization", `Bearer ${jeton("GEST")}`)
      .field("typeCode", "plan_axes").field("titre", "Plan PDF de reference").field("reference", "GED-0042").attach("fichier", PDF, { filename: "plan.pdf" });
    expect(r.status).toBe(201);
    const [, projetId, donnees, piece] = appelsDe("creerDocument")[0].args as [unknown, string, Record<string, unknown>, { reference?: string; fichier?: { contenu: Buffer; nom: string } }];
    expect(projetId).toBe(P1);
    expect(donnees).toEqual({ typeCode: "PLAN_AXES", titre: "Plan PDF de reference" });
    expect(piece.reference).toBe("GED-0042");
    expect(piece.fichier?.nom).toBe("plan.pdf");
    expect(piece.fichier?.contenu.equals(PDF)).toBe(true);
  });
  it("fichier de plus de 25 Mo : 413 FICHIER_TROP_GROS, service non appele", async () => {
    const r = await request(app).post(`${BASE}/${P1}/documents/${DOC}/versions`).set("Authorization", `Bearer ${jeton("GEST")}`)
      .attach("fichier", Buffer.alloc(25 * 1024 * 1024 + 1, 0x41), { filename: "gros.pdf" });
    expect(r.status).toBe(413);
    expect(r.body.code).toBe("FICHIER_TROP_GROS");
    expect(appelsDe("nouvelleVersion")).toEqual([]);
  });
  it("octet NUL dans un champ multipart ou dans le nom du fichier : 400 PARAMETRES_INVALIDES", async () => {
    const r = await request(app).post(`${BASE}/${P1}/documents`).set("Authorization", `Bearer ${jeton("GEST")}`).field("typeCode", "PLAN_AXES").field("titre", "a\u0000b");
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("PARAMETRES_INVALIDES");
    expect(appelsDe("creerDocument")).toEqual([]);
  });
});

describe("validation des entrees : 400 type, jamais 500, le service n'est pas appele", () => {
  it("identifiant de document hors UUID : 400 IDENTIFIANT_INVALIDE", async () => {
    for (const r of ROUTES.filter((x) => x.chemin.includes(DOC))) {
      const rep = await appeler(r, "ADMIN", r.chemin.replace(DOC, "zzz"));
      expect(rep.status, r.chemin).toBe(400); expect(rep.body.code).toBe("IDENTIFIANT_INVALIDE");
    }
    expect(w.appels).toEqual([]);
  });
  it("creation : type absent ou mal forme, titre vide ou trop long, date impossible, jeu ou concessionnaire non UUID, champ en trop (statut impose, sha256 fourni)", async () => {
    const base = { typeCode: "PLAN_AXES", titre: "Plan" };
    for (const corps of [{ titre: "x" }, { ...base, typeCode: "a" }, { ...base, titre: "" }, { ...base, titre: "x".repeat(201) }, { ...base, dateDocument: "2026-02-30" },
      { ...base, jeuId: "x" }, { ...base, concessionnaireId: "x" }, { ...base, statut: "VALIDE" }, { ...base, sha256: "a".repeat(64) }, { ...base, reference: "" .padEnd(301, "r") }]) {
      const r = await appeler(ROUTES[3], "GEST", ROUTES[3].chemin, corps);
      expect(r.status, JSON.stringify(corps).slice(0, 80)).toBe(400); expect(r.body.code).toBe("CHAMPS_INVALIDES");
    }
    expect(appelsDe("creerDocument")).toEqual([]);
  });
  it("statut : absent, champ en trop (valideur impose) ; retrait sans justification : 400", async () => {
    for (const corps of [{}, { statut: "VALIDE", valideParId: "u-autre" }]) {
      expect((await appeler(ROUTES[6], "GEST", ROUTES[6].chemin, corps)).status, JSON.stringify(corps)).toBe(400);
    }
    for (const corps of [{}, { justification: "court" }]) {
      const r = await appeler(ROUTES[7], "GEST", ROUTES[7].chemin, corps);
      expect(r.status).toBe(400); expect(r.body.code).toBe("JUSTIFICATION_INVALIDE");
    }
    expect(appelsDe("changerStatut")).toEqual([]);
    expect(appelsDe("retirerDocument")).toEqual([]);
  });
  it("liste : statut inconnu, limite hors bornes, version inconnue, curseur forge : 400 ; filtres valides transmis", async () => {
    const g = (q: string) => request(app).get(`${BASE}/${P1}/documents?${q}`).set("Authorization", `Bearer ${jeton("LECT")}`);
    for (const q of ["statut=PERDU", "limite=0", "limite=101", "versions=anciennes", "inconnu=1"]) expect((await g(q)).status, q).toBe(400);
    expect((await g(`curseur=${Buffer.from("{}").toString("base64url")}`)).body.code).toBe("CURSEUR_INVALIDE");
    expect(appelsDe("listerDocuments")).toEqual([]);
    expect((await g("statut=VALIDE,REJETE&typeCode=plan_axes&versions=toutes&limite=7")).status).toBe(200);
    expect(appelsDe("listerDocuments")[0].args[2]).toEqual({ statuts: ["VALIDE", "REJETE"], typeCode: "PLAN_AXES", toutesVersions: true, limite: 7, curseur: undefined });
  });
});

describe("erreurs typees rendues telles quelles", () => {
  it("409 (transition, separation des taches, DWG), 415, 404, 503 : statut, code et champs du contrat", async () => {
    const cas: [ErreurMetier, number][] = [
      [new ErreurMetier(409, "TRANSITION_INTERDITE", "Interdit.", { de: "RECU", vers: "VALIDE", possibles: ["EN_ANALYSE", "REJETE"] }), 409],
      [new ErreurMetier(409, "SEPARATION_DES_TACHES", "Le deposant ne valide pas."), 409],
      [new ErreurMetier(409, "DOCUMENT_NON_EXPLOITABLE", "DWG.", { aide: "Exportez en DXF" }), 409],
      [new ErreurMetier(415, "FORMAT_DOCUMENT_NON_PRIS_EN_CHARGE", "Format."), 415],
      [new ErreurMetier(404, "DOCUMENT_INTROUVABLE", "Document introuvable"), 404],
      [new ErreurMetier(503, "PROJET_OCCUPE", "Occupe."), 503],
    ];
    for (const [e, statut] of cas) {
      w.echec = e;
      const r = await appeler(ROUTES[6], "GEST", ROUTES[6].chemin, { statut: "VALIDE", justification: "Piece verifiee par la direction" });
      expect(r.status, e.code).toBe(statut);
      expect(r.body).toEqual({ error: e.message, code: e.code, ...e.extra });
    }
  });
});
