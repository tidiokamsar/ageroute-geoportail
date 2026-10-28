import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `/api/v2/projets-voirie` : ce que ces tests defendent (cablage des gardes, validation des entrees, traduction des erreurs).
 *
 * Les VRAIS `requireAuth` (jeton signe, resolveur de compte injecte), `requireModuleAccess`, `requireRole`, gardes territoriales,
 * multer et validation zod ; seuls la BASE (comptes, modules, perimetres) et les SERVICES (qui parlent a PostGIS) sont simules.
 * Le SQL, la quarantaine, les versions, les mesures et l'audit sont prouves par le banc `tests-integration/projets-voirie.integration.mts`.
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
  regionsProjets: {} as Record<string, number | null>,
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

vi.mock("../projets-voirie/projets.service", async (original) => {
  const m = await original<typeof import("../projets-voirie/projets.service")>();
  const espion = (nom: string, valeur: unknown) => vi.fn(async (...args: unknown[]) => {
    w.appels.push({ nom, args });
    if (w.echec) throw w.echec;
    return valeur;
  });
  return {
    ...m,
    creerProjet: espion("creerProjet", { id: "p1", code: "X-1" }),
    listerProjets: espion("listerProjets", { projets: [], curseurSuivant: null }),
    ficheProjet: espion("ficheProjet", { id: "p1" }),
    modifierProjet: espion("modifierProjet", { id: "p1" }),
    retirerProjet: espion("retirerProjet", { id: "p1", retire: true }),
    listerConcessionnaires: espion("listerConcessionnaires", { concessionnaires: [] }),
    creerConcessionnaire: espion("creerConcessionnaire", { id: "c1" }),
    listerJeux: espion("listerJeux", { jeux: [] }),
    retirerJeu: espion("retirerJeu", { jeu: { id: "j1" } }),
    decider: espion("decider", { jeu: { id: "j1" }, remplaces: [] }),
    regionsDuProjet: vi.fn(async (id: string) => (id in w.regionsProjets ? [w.regionsProjets[id]] : [])),
  };
});
vi.mock("../projets-voirie/import.service", () => ({
  deposerJeu: vi.fn(async (...args: unknown[]) => {
    w.appels.push({ nom: "deposerJeu", args });
    if (w.echec) throw w.echec;
    return { simulation: (args[0] as { simuler: boolean }).simuler, jeu: { id: "j1" }, resume: {}, avertissements: [], delta: null, remplace: null };
  }),
}));
vi.mock("../projets-voirie/carte.service", () => ({
  carte: vi.fn(async (...args: unknown[]) => { w.appels.push({ nom: "carte", args }); return { jeux: [] }; }),
}));
vi.mock("../projets-voirie/analyse.service", () => ({
  analyser: vi.fn(async (...args: unknown[]) => { w.appels.push({ nom: "analyser", args }); return { statut: "A_VERIFIER" }; }),
  exporterCsv: vi.fn(async (...args: unknown[]) => { w.appels.push({ nom: "exporterCsv", args }); return { csv: "﻿axe;x\r\n", nbLignes: 0, nomFichier: "analyse-x.csv" }; }),
}));

import { _installerResolveurCompte } from "../middleware/auth.middleware";
import { signAccessToken } from "../utils/jwt";
import { errorHandler } from "../middleware/error.middleware";
import { ServiceOccupe } from "../import/limiteur";
import { ErreurMetier } from "../projets-voirie/erreurs";
import { ErreurLecture } from "../projets-voirie/lecture.noyau";
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
  VIDE: { id: "u-vide", role: "GESTIONNAIRE", modules: [] },
  GEST_R1: { id: "u-gest-1", role: "GESTIONNAIRE", modules: ["projets-voirie"], regions: [1] },
};
const jeton = (c: string) => signAccessToken({ sub: COMPTES[c].id, role: COMPTES[c].role as never, email: `${c}@essai.invalid` });
const BASE = "/api/v2/projets-voirie";
const fichier = Buffer.from("<kml/>");

beforeEach(() => {
  w.appels = []; w.echec = null;
  w.modules = {}; w.perimetres = {};
  w.regionsProjets = { "p-r1": 1, "p-r2": 2, "p-sans-region": null };
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

describe("gardes : authentification, module, role", () => {
  it("sans jeton : 401 sur chaque verbe, aucun service appele", async () => {
    for (const r of [request(app).get(BASE), request(app).post(BASE).send({}), request(app).get(`${BASE}/p1/carte`), request(app).delete(`${BASE}/p1`)]) {
      expect((await r).status).toBe(401);
    }
    expect(w.appels).toEqual([]);
  });

  it("sans la cle `projets-voirie` (module vide ou autre module) : 403 sur lecture et ecriture, aucun service appele", async () => {
    for (const c of ["SANS", "VIDE"]) {
      expect((await avec(request(app).get(BASE), c)).status).toBe(403);
      expect((await avec(request(app).get(`${BASE}/p-r1/analyse`), c)).status).toBe(403);
      expect((await avec(request(app).post(BASE).send({ code: "X-1", nom: "x" }), c)).status).toBe(403);
    }
    expect(w.appels).toEqual([]);
  });

  it("un ADMIN passe sans cle de module (regle commune) ; un LECTEUR avec la cle lit mais n'ecrit pas", async () => {
    expect((await avec(request(app).get(BASE), "ADMIN")).status).toBe(200);
    expect((await avec(request(app).get(BASE), "LECT")).status).toBe(200);
    for (const [methode, chemin] of [["post", ""], ["post", "/concessionnaires"], ["patch", "/p-r1"], ["delete", "/p-r1"], ["post", "/p-r1/jeux"], ["delete", "/p-r1/jeux/j1"], ["post", "/p-r1/jeux/j1/autoriser"], ["post", "/p-r1/jeux/j1/rejeter"]] as const) {
      const r = await avec(request(app)[methode](`${BASE}${chemin}`).send({}), "LECT");
      expect(r.status, `${methode} ${chemin}`).toBe(403);
    }
    expect(appelsDe("creerProjet")).toEqual([]);
  });

  it("l'export CSV est reserve a ADMIN et GESTIONNAIRE : un LECTEUR avec la cle recoit 403", async () => {
    expect((await avec(request(app).get(`${BASE}/p-r1/analyse/export.csv`), "LECT")).status).toBe(403);
    const ok = await avec(request(app).get(`${BASE}/p-r1/analyse/export.csv`), "GEST");
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toMatch(/text\/csv/);
    expect(ok.headers["content-disposition"]).toMatch(/attachment; filename="analyse-x.csv"/);
    expect(appelsDe("exporterCsv")).toHaveLength(1);
  });

  it("DELETE d'un projet est reserve a ADMIN", async () => {
    expect((await avec(request(app).delete(`${BASE}/p-r1`), "GEST")).status).toBe(403);
    expect((await avec(request(app).delete(`${BASE}/p-r1`), "ADMIN")).status).toBe(200);
  });

  it("les reponses ne sont jamais mises en cache et ne sont pas reinterpretees par le navigateur", async () => {
    const r = await avec(request(app).get(BASE), "GEST");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("controle territorial : 404 masque", () => {
  it("un compte regional ne voit que sa region ; hors perimetre, sans region et inconnu donnent la MEME reponse 404", async () => {
    const dans = await avec(request(app).get(`${BASE}/p-r1`), "GEST_R1");
    const autre = await avec(request(app).get(`${BASE}/p-r2`), "GEST_R1");
    const sans = await avec(request(app).get(`${BASE}/p-sans-region`), "GEST_R1");
    const inconnu = await avec(request(app).get(`${BASE}/n-existe-pas`), "GEST_R1");
    expect(dans.status).toBe(200);
    for (const r of [autre, sans, inconnu]) {
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ error: "Projet introuvable", code: "PROJET_INTROUVABLE" });
    }
    expect(appelsDe("ficheProjet")).toHaveLength(1);
  });

  it("le masquage precede la validation du corps et le televersement : un corps invalide hors perimetre donne 404, pas 400", async () => {
    const r = await avec(request(app).post(`${BASE}/p-r2/jeux/j1/autoriser`).send({}), "GEST_R1");
    expect(r.status).toBe(404);
    const d = await avec(request(app).post(`${BASE}/p-r2/jeux`).field("role", "pas-un-role").attach("fichier", fichier, "a.kml"), "GEST_R1");
    expect(d.status).toBe(404);
    expect(w.appels).toEqual([]);
  });

  it("un compte national passe sans lecture du perimetre ; le service rend son propre 404 pour un projet inconnu", async () => {
    w.echec = new ErreurMetier(404, "PROJET_INTROUVABLE", "Projet introuvable");
    const r = await avec(request(app).get(`${BASE}/n-existe-pas`), "GEST");
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("PROJET_INTROUVABLE");
  });

  it("la creation par un compte regional exige sa region : autre region ou region absente donnent 403", async () => {
    expect((await avec(request(app).post(BASE).send({ code: "AB-1", nom: "x", regionId: 2 }), "GEST_R1")).status).toBe(403);
    expect((await avec(request(app).post(BASE).send({ code: "AB-1", nom: "x" }), "GEST_R1")).status).toBe(403);
    expect((await avec(request(app).post(BASE).send({ code: "AB-1", nom: "x", regionId: 1 }), "GEST_R1")).status).toBe(201);
  });
});

describe("validation des entrees : 400 avec code, jamais 500, le service n'est pas appele", () => {
  it("creation de projet", async () => {
    const mauvais = [{ code: "a b", nom: "x" }, { code: "OK-1" }, { code: "OK-1", nom: "" }, { code: "OK-1", nom: "x", extra: 1 }, { code: "OK-1", nom: "x", largeurEmpriseM: -4 }, { code: "OK-1", nom: "x", largeurEmpriseM: 500 }, { code: "OK-1", nom: "x", regionId: "1" }];
    for (const corps of mauvais) {
      const r = await avec(request(app).post(BASE).send(corps), "GEST");
      expect(r.status, JSON.stringify(corps)).toBe(400);
      expect(r.body.code).toBe("CHAMPS_INVALIDES");
    }
    expect(appelsDe("creerProjet")).toEqual([]);
    const ok = await avec(request(app).post(BASE).send({ code: "kissi-1", nom: "Voirie", commune: "K" }), "GEST");
    expect(ok.status).toBe(201);
    expect((appelsDe("creerProjet")[0].args[1] as { code: string }).code).toBe("KISSI-1");
  });

  it("modification : aucun champ, champ inconnu, statut invalide", async () => {
    for (const corps of [{}, { admin: true }, { statutParametres: "X" }, { largeurChausseeM: 0 }]) {
      expect((await avec(request(app).patch(`${BASE}/p-r1`).send(corps), "GEST")).status).toBe(400);
    }
    expect((await avec(request(app).patch(`${BASE}/p-r1`).send({ nom: "Nouveau nom" }), "GEST")).status).toBe(200);
  });

  it("liste : limite et curseur hostiles", async () => {
    for (const q of ["limite=0", "limite=500", "limite=abc", "curseur=%%%", "inconnu=1"]) {
      expect((await avec(request(app).get(`${BASE}?${q}`), "GEST")).status, q).toBe(400);
    }
    expect((await avec(request(app).get(`${BASE}?limite=10&q=kissi`), "GEST")).status).toBe(200);
  });

  it("concessionnaire : type inconnu, nom vide", async () => {
    expect((await avec(request(app).post(`${BASE}/concessionnaires`).send({ nom: "X", typeReseau: "AUTRE_TYPE" }), "GEST")).status).toBe(400);
    expect((await avec(request(app).post(`${BASE}/concessionnaires`).send({ nom: " ", typeReseau: "TELECOM" }), "GEST")).status).toBe(400);
    expect((await avec(request(app).post(`${BASE}/concessionnaires`).send({ nom: "Operateur", typeReseau: "TELECOM" }), "GEST")).status).toBe(201);
  });

  it("carte : bbox, zoom, jeux, parametre inconnu", async () => {
    for (const q of ["bbox=1,2,0,1", "bbox=a,b,c,d", "bbox=1,2,3", "zoom=99", "zoom=1.5", "jeux=%20,%20", "x=1", "inclureNonAutorises=oui"]) {
      expect((await avec(request(app).get(`${BASE}/p-r1/carte?${q}`), "GEST")).status, q).toBe(400);
    }
    expect(appelsDe("carte")).toEqual([]);
    const ok = await avec(request(app).get(`${BASE}/p-r1/carte?bbox=-11,9,-10,10&zoom=12&jeux=a,b&inclureNonAutorises=true`), "LECT");
    expect(ok.status).toBe(200);
    expect(appelsDe("carte")[0].args[0]).toMatchObject({ projetId: "p-r1", bbox: [-11, 9, -10, 10], zoom: 12, jeuxIds: ["a", "b"], inclureNonAutorises: true });
  });

  it("analyse : largeurs incoherentes ou hors plage, parametre inconnu ; la surcharge est transmise", async () => {
    for (const q of ["largeurChausseeM=0", "largeurEmpriseM=500", "largeurEmpriseM=abc", "x=1"]) {
      expect((await avec(request(app).get(`${BASE}/p-r1/analyse?${q}`), "GEST")).status, q).toBe(400);
    }
    const ok = await avec(request(app).get(`${BASE}/p-r1/analyse?largeurChausseeM=6&largeurEmpriseM=12`), "LECT");
    expect(ok.status).toBe(200);
    expect(appelsDe("analyser")[0].args[0]).toMatchObject({ projetId: "p-r1", largeurChausseeM: 6, largeurEmpriseM: 12, inclureNonAutorises: false });
  });

  it("autorisation et rejet : justification de 10 caracteres au moins, obligatoire, aucun champ en plus", async () => {
    for (const action of ["autoriser", "rejeter"]) {
      for (const corps of [{}, { justification: "court" }, { justification: "          " }, { justification: "x".repeat(2001) }, { justification: "assez longue", statut: "AUTORISE" }]) {
        const r = await avec(request(app).post(`${BASE}/p-r1/jeux/j1/${action}`).send(corps), "GEST");
        expect(r.status, `${action} ${JSON.stringify(corps).slice(0, 40)}`).toBe(400);
        expect(r.body.code).toBe("JUSTIFICATION_INVALIDE");
      }
    }
    expect(appelsDe("decider")).toEqual([]);
    expect((await avec(request(app).post(`${BASE}/p-r1/jeux/j1/autoriser`).send({ justification: "Controle fait avec le chef de projet" }), "GEST")).status).toBe(200);
    expect((await avec(request(app).post(`${BASE}/p-r1/jeux/j1/rejeter`).send({ justification: "Fichier incomplet, a refaire" }), "ADMIN")).status).toBe(200);
    expect(appelsDe("decider").map((a) => a.args[3])).toEqual(["AUTORISE", "REJETE"]);
    // L'acteur est TOUJOURS le compte authentifie.
    expect(appelsDe("decider")[0].args[0]).toMatchObject({ id: "u-gest", role: "GESTIONNAIRE" });
  });

  it("identifiant de jeu demesure : 404 sans appeler le service", async () => {
    expect((await avec(request(app).post(`${BASE}/p-r1/jeux/${"x".repeat(200)}/autoriser`).send({ justification: "Controle fait avec le chef" }), "GEST")).status).toBe(404);
    expect((await avec(request(app).delete(`${BASE}/p-r1/jeux/${"x".repeat(200)}`), "GEST")).status).toBe(404);
    expect(w.appels).toEqual([]);
  });
});

describe("depot d'un fichier (multipart)", () => {
  const depot = (compte: string, champs: Record<string, string>, contenu: Buffer | null = fichier, requete = "") => {
    let r = avec(request(app).post(`${BASE}/p-r1/jeux${requete}`), compte);
    for (const [k, v] of Object.entries(champs)) r = r.field(k, v);
    return contenu ? r.attach("fichier", contenu, { filename: "relevé.kml" }) : r;
  };

  it("sans fichier : 400 FICHIER_MANQUANT ; champs invalides : 400 CHAMPS_INVALIDES ; aucune lecture n'est tentee", async () => {
    expect((await depot("GEST", { role: "AUTRE" }, null)).body.code).toBe("FICHIER_MANQUANT");
    for (const champs of [{} as Record<string, string>, { role: "PAS_UN_ROLE" }, { role: "AUTRE", classePrecision: "Z" }, { role: "AUTRE", dateDonnees: "2026-02-30" }, { role: "AUTRE", precisionHorizontaleM: "-1" }, { role: "AUTRE", confidentialite: "SECRET" }, { role: "AUTRE", nimporte: "x" }]) {
      const r = await depot("GEST", champs);
      expect(r.status, JSON.stringify(champs)).toBe(400);
      expect(r.body.code).toBe("CHAMPS_INVALIDES");
    }
    expect(appelsDe("deposerJeu")).toEqual([]);
  });

  it("depot valide : 201, l'acteur est le compte authentifie (aucun champ du corps ne le choisit), nom de fichier UTF-8 conserve", async () => {
    const r = await depot("GEST", { role: "RESEAU_TIERS", concessionnaireId: "c1", classePrecision: "B", precisionHorizontaleM: "3.5", dateDonnees: "2026-10-24", origineFichier: "recu de l operateur" });
    // Aucun champ ne designe l acteur : un creeParId du corps est REFUSE (schema strict), jamais ignore en silence.
    expect((await depot("GEST", { role: "AUTRE", creeParId: "u-admin" })).status).toBe(400);
    expect(r.status).toBe(201);
    const a = appelsDe("deposerJeu")[0].args[0] as { acteur: { id: string }; nomFichier: string; champs: Record<string, unknown>; simuler: boolean; projetId: string };
    expect(a.acteur.id).toBe("u-gest");
    expect(a.nomFichier).toBe("relevé.kml");
    expect(a.projetId).toBe("p-r1");
    expect(a.simuler).toBe(false);
    expect(a.champs).toMatchObject({ role: "RESEAU_TIERS", concessionnaireId: "c1", classePrecision: "B", precisionHorizontaleM: 3.5, dateDonnees: "2026-10-24" });
  });

  it("?simuler=true : 200 et simuler=true transmis ; valeur inconnue : 400", async () => {
    const r = await depot("GEST", { role: "AUTRE" }, fichier, "?simuler=true");
    expect(r.status).toBe(200);
    expect(r.body.simulation).toBe(true);
    expect((appelsDe("deposerJeu")[0].args[0] as { simuler: boolean }).simuler).toBe(true);
    expect((await depot("GEST", { role: "AUTRE" }, fichier, "?simuler=peut-etre")).status).toBe(400);
  });

  it("un champ facultatif laisse vide est « non fourni » ; origineFichier ne bloque jamais", async () => {
    const r = await depot("GEST", { role: "AUTRE", origineFichier: "", dateDonnees: "", classePrecision: "" });
    expect(r.status).toBe(201);
    expect((appelsDe("deposerJeu")[0].args[0] as { champs: Record<string, unknown> }).champs.origineFichier).toBeUndefined();
  });

  it("fichier de plus de 25 Mo : 413 FICHIER_TROP_GROS avant toute lecture", async () => {
    const r = await depot("GEST", { role: "AUTRE" }, Buffer.alloc(26 * 1024 * 1024, 32));
    expect(r.status).toBe(413);
    expect(r.body.code).toBe("FICHIER_TROP_GROS");
    expect(appelsDe("deposerJeu")).toEqual([]);
  });

  it.each([
    ["FICHIER_VIDE", 422], ["FORMAT_NON_SUPPORTE", 415], ["CONTENU_NON_RECONNU", 422], ["HORS_GUINEE", 422], ["GEOMETRIE_INVALIDE", 422],
    ["DTD_REFUSEE", 422], ["TROP_D_OBJETS", 422], ["CRS_NON_SUPPORTE", 422], ["FICHIER_TROP_GROS", 413],
  ] as const)("refus de lecture %s : %i avec son code", async (code, statut) => {
    w.echec = new ErreurLecture(code, "motif lisible");
    const r = await depot("GEST", { role: "AUTRE" });
    expect(r.status).toBe(statut);
    expect(r.body).toEqual({ error: "motif lisible", code });
  });

  it("409 JEU_DEJA_CHARGE : le corps porte le jeuId existant ; 503 SERVICE_OCCUPE : Retry-After", async () => {
    w.echec = new ErreurMetier(409, "JEU_DEJA_CHARGE", "Ce fichier est deja charge", { jeuId: "j-existant", statut: "AUTORISE", version: 2 });
    const r = await depot("GEST", { role: "AUTRE" });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "JEU_DEJA_CHARGE", jeuId: "j-existant", statut: "AUTORISE", version: 2 });
    w.echec = new ServiceOccupe("occupe", 7);
    const o = await depot("GEST", { role: "AUTRE" });
    expect(o.status).toBe(503);
    expect(o.headers["retry-after"]).toBe("7");
  });

  it("une erreur interne ne fuit ni message ni trace : 500 generique", async () => {
    w.echec = new Error("connexion refusee sur 10.0.0.5:5432 mot de passe=secret");
    const r = await depot("GEST", { role: "AUTRE" });
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toMatch(/10\.0\.0\.5|secret/);
  });
});
