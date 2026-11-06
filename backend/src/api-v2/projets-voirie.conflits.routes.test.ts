import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Routes des DOSSIERS DE CONFLIT (`/api/v2/projets-voirie/:id/{regles,analyses,conflits}`) : cablage des gardes, validation des entrees, traduction des
 * erreurs typees, ordre des routes. Les VRAIS `requireAuth` (jeton signe, resolveur de compte injecte), `requireModuleAccess`, `requireRole`, gardes
 * territoriales et validation zod ; seuls la BASE (comptes, modules, perimetres) et les SERVICES (qui parlent a PostGIS) sont simules.
 * Le SQL, la machine a etats, le rejeu, les declencheurs et l'audit sont prouves par le banc `tests-integration/conflits-projets-voirie.integration.mts`
 * et par les tests du noyau (`projets-voirie/conflits/*.noyau.test.ts`).
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
vi.mock("../projets-voirie/conflits/analyse-conflits.service", () => ({ lancerAnalyse: espion("lancerAnalyse", { analyse: { id: "a1" }, resume: {} }) }));
vi.mock("../projets-voirie/conflits/regles-analyses.service", async (original) => {
  const m = await original<typeof import("../projets-voirie/conflits/regles-analyses.service")>();
  return {
    ...m,
    listerRegles: espion("listerRegles", { regles: [], effectives: [] }), creerRegle: espion("creerRegle", { regle: { id: "r1" } }),
    approuverRegle: espion("approuverRegle", { regle: { id: "r1" } }), listerAnalyses: espion("listerAnalyses", { analyses: [], curseurSuivant: null }),
    detailAnalyse: espion("detailAnalyse", { analyse: { id: "a1" } }), comparerAnalyses: espion("comparerAnalyses", { apparus: { nb: 0 } }),
  };
});
vi.mock("../projets-voirie/conflits/dossiers.service", async (original) => {
  const m = await original<typeof import("../projets-voirie/conflits/dossiers.service")>();
  return {
    ...m,
    listerConflits: espion("listerConflits", { conflits: [], compteurs: {}, total: 0, curseurSuivant: null }), ficheConflit: espion("ficheConflit", { conflit: { id: "c1" } }),
    modifierConflit: espion("modifierConflit", { conflit: { id: "c1" }, modifie: true }), changerStatut: espion("changerStatut", { conflit: { id: "c1" } }),
    ajouterPreuve: espion("ajouterPreuve", { preuve: { id: "p1" } }), proposerDecision: espion("proposerDecision", { decision: { id: "d1" } }),
    trancherDecision: espion("trancherDecision", { decision: { id: "d1" } }),
    exporterConflitsCsv: espion("exporterConflitsCsv", { csv: "﻿axe;type\r\n", nbLignes: 0, nomFichier: "conflits-x.csv" }),
  };
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
const P_R1 = uuid(1), P_R2 = uuid(2), P_SANS = uuid(3), C1 = uuid(21), A1 = uuid(31), A2 = uuid(32), D1 = uuid(41), RG = uuid(51);

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

type Route = { m: "get" | "post" | "patch"; chemin: string; corps?: object; service: string; lecture: boolean };
const ROUTES: Route[] = [
  { m: "get", chemin: `/${P_R1}/regles`, service: "listerRegles", lecture: true },
  { m: "post", chemin: `/${P_R1}/regles`, corps: { code: "TOL-1", toleranceProximiteM: 2, justification: "Tolerance proposee par la direction" }, service: "creerRegle", lecture: false },
  { m: "post", chemin: `/${P_R1}/regles/${RG}/approuver`, corps: { justification: "Approuvee apres relecture" }, service: "approuverRegle", lecture: false },
  { m: "post", chemin: `/${P_R1}/analyses`, corps: {}, service: "lancerAnalyse", lecture: false },
  { m: "get", chemin: `/${P_R1}/analyses`, service: "listerAnalyses", lecture: true },
  { m: "get", chemin: `/${P_R1}/analyses/${A1}`, service: "detailAnalyse", lecture: true },
  { m: "get", chemin: `/${P_R1}/analyses/${A1}/comparaison?avec=${A2}`, service: "comparerAnalyses", lecture: true },
  { m: "get", chemin: `/${P_R1}/conflits`, service: "listerConflits", lecture: true },
  { m: "get", chemin: `/${P_R1}/conflits/export.csv`, service: "exporterConflitsCsv", lecture: false },
  { m: "get", chemin: `/${P_R1}/conflits/${C1}`, service: "ficheConflit", lecture: true },
  { m: "patch", chemin: `/${P_R1}/conflits/${C1}`, corps: { risque: "ELEVE" }, service: "modifierConflit", lecture: false },
  { m: "post", chemin: `/${P_R1}/conflits/${C1}/statut`, corps: { vers: "POTENTIEL", justification: "Controle effectue avec le chef" }, service: "changerStatut", lecture: false },
  { m: "post", chemin: `/${P_R1}/conflits/${C1}/preuves`, corps: { type: "NOTE", texte: "Courrier recu" }, service: "ajouterPreuve", lecture: false },
  { m: "post", chemin: `/${P_R1}/conflits/${C1}/decisions`, corps: { option: "PROTEGER", justification: "Protection mecanique du cable" }, service: "proposerDecision", lecture: false },
  { m: "post", chemin: `/${P_R1}/conflits/${C1}/decisions/${D1}/approuver`, corps: { motif: "Decision validee par le chef" }, service: "trancherDecision", lecture: false },
  { m: "post", chemin: `/${P_R1}/conflits/${C1}/decisions/${D1}/refuser`, corps: { motif: "Decision refusee par le chef" }, service: "trancherDecision", lecture: false },
];
/** Statut de succes : 201 pour les routes qui creent une ressource. */
const OK = (r: Route) => ((["creerRegle", "lancerAnalyse", "ajouterPreuve", "proposerDecision"].includes(r.service)) ? 201 : 200);
const appeler = (r: Route, compte: string | null, chemin = r.chemin, corps = r.corps) => {
  const req = avec(request(app)[r.m](`${BASE}${chemin}`), compte);
  return corps !== undefined ? req.send(corps) : req;
};

describe("gardes : authentification, module, role", () => {
  it("sans jeton : 401 sur les 16 routes, aucun service appele", async () => {
    expect(ROUTES).toHaveLength(16);
    for (const r of ROUTES) expect((await appeler(r, null)).status, `${r.m} ${r.chemin}`).toBe(401);
    expect(w.appels).toEqual([]);
  });

  it("sans la cle `projets-voirie` : 403 sur les 16 routes, aucun service appele", async () => {
    for (const r of ROUTES) expect((await appeler(r, "SANS")).status, `${r.m} ${r.chemin}`).toBe(403);
    expect(w.appels).toEqual([]);
  });

  it("un LECTEUR et un INSPECTEUR avec la cle lisent (200) et ne peuvent ecrire aucune des 10 routes d'ecriture ni exporter (403)", async () => {
    for (const compte of ["LECT", "INSP"]) {
      for (const r of ROUTES) {
        const s = (await appeler(r, compte)).status;
        expect(s, `${compte} ${r.m} ${r.chemin}`).toBe(r.lecture ? 200 : 403);
      }
    }
    for (const nom of ["lancerAnalyse", "creerRegle", "approuverRegle", "changerStatut", "modifierConflit", "ajouterPreuve", "proposerDecision", "trancherDecision", "exporterConflitsCsv"]) {
      expect(appelsDe(nom), nom).toEqual([]);
    }
  });

  it("GESTIONNAIRE : ecrit tout sauf l'approbation d'une regle, reservee a l'ADMIN (403) ; ADMIN passe sans cle de module", async () => {
    for (const r of ROUTES) {
      const s = (await appeler(r, "GEST")).status;
      expect(s, `GEST ${r.m} ${r.chemin}`).toBe(r.service === "approuverRegle" ? 403 : OK(r));
    }
    for (const r of ROUTES) expect((await appeler(r, "ADMIN")).status, `ADMIN ${r.m} ${r.chemin}`).toBe(OK(r));
    expect(appelsDe("approuverRegle")).toHaveLength(1);
  });

  it("l'acteur transmis au service est le compte du jeton (identifiant et role), jamais un champ du corps", async () => {
    await appeler(ROUTES[11], "GEST", ROUTES[11].chemin, { vers: "POTENTIEL", justification: "Controle effectue avec le chef" });
    const [acteur, projetId, cid, corps] = appelsDe("changerStatut")[0].args as [{ id: string; role: string }, string, string, Record<string, unknown>];
    expect(acteur).toMatchObject({ id: "u-gest", role: "GESTIONNAIRE" });
    expect(projetId).toBe(P_R1);
    expect(cid).toBe(C1);
    expect(corps).toEqual({ vers: "POTENTIEL", justification: "Controle effectue avec le chef" });
  });

  it("les reponses ne sont jamais mises en cache ni reinterpretees par le navigateur", async () => {
    const r = await appeler(ROUTES[7], "GEST");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("controle territorial : 404 masque", () => {
  it("hors perimetre, projet sans region et projet inconnu : la MEME reponse 404, meme avec un corps invalide, avant toute validation", async () => {
    const corps = { error: "Projet introuvable", code: "PROJET_INTROUVABLE" };
    for (const r of ROUTES.filter((x) => x.service !== "approuverRegle")) {
      for (const projet of [P_R2, P_SANS, uuid(99)]) {
        const chemin = r.chemin.replace(P_R1, projet);
        const rep = await appeler(r, "GEST_R1", chemin, r.m === "get" ? undefined : { champInvalide: true });
        expect(rep.status, `${r.m} ${chemin}`).toBe(404);
        expect(rep.body).toEqual(corps);
      }
    }
    expect(w.appels).toEqual([]);
  });

  it("dans son perimetre, un compte regional lit et ecrit", async () => {
    expect((await appeler(ROUTES[7], "GEST_R1")).status).toBe(200);
    expect((await appeler(ROUTES[3], "GEST_R1")).status).toBe(201);
  });

  it("un compte national passe la garde territoriale", async () => {
    expect((await appeler(ROUTES[7], "GEST", ROUTES[7].chemin.replace(P_R1, P_R2))).status).toBe(200);
  });
});

describe("identifiants et caracteres", () => {
  it("identifiant de conflit, d'analyse, de regle, de decision ou « avec » qui n'est pas un UUID : 400 IDENTIFIANT_INVALIDE, aucun service appele (%00 compris)", async () => {
    const chemins: [Route["m"], string, object?][] = [
      ["get", `/${P_R1}/conflits/pas-un-uuid`], ["get", `/${P_R1}/conflits/%00`], ["patch", `/${P_R1}/conflits/zzz`, {}], ["post", `/${P_R1}/conflits/zzz/statut`, {}],
      ["post", `/${P_R1}/conflits/${C1}/decisions/zzz/approuver`, {}], ["get", `/${P_R1}/analyses/zzz`], ["get", `/${P_R1}/analyses/${A1}/comparaison?avec=zzz`],
      ["get", `/${P_R1}/analyses/${A1}/comparaison`], ["post", `/${P_R1}/regles/zzz/approuver`, {}],
    ];
    for (const [m, c, corps] of chemins) {
      const rep = await avec(request(app)[m](`${BASE}${c}`), "ADMIN").send(corps);
      expect(rep.status, `${m} ${c}`).toBe(400);
      expect(rep.body.code, `${m} ${c}`).toBe("IDENTIFIANT_INVALIDE");
    }
    expect(w.appels).toEqual([]);
  });

  it("un octet NUL dans un parametre ou un corps : 400 PARAMETRES_INVALIDES", async () => {
    const q = await avec(request(app).get(`${BASE}/${P_R1}/conflits?q=a%00b`), "GEST");
    const c = await avec(request(app).post(`${BASE}/${P_R1}/conflits/${C1}/statut`).send({ vers: "POTENTIEL", justification: "Controle\u0000effectue" }), "GEST");
    expect(q.status).toBe(400);
    expect(q.body.code).toBe("PARAMETRES_INVALIDES");
    expect(c.status).toBe(400);
    expect(c.body.code).toBe("PARAMETRES_INVALIDES");
    expect(w.appels).toEqual([]);
  });

  it("`export.csv` n'est pas avale par `:cid` (route declaree avant) : elle repond en CSV, pas en IDENTIFIANT_INVALIDE", async () => {
    const r = await avec(request(app).get(`${BASE}/${P_R1}/conflits/export.csv`), "GEST");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/csv/);
    expect(r.headers["content-disposition"]).toMatch(/attachment; filename="conflits-x.csv"/);
    expect(r.headers["x-lignes-exportees"]).toBe("0");
    expect(appelsDe("exporterConflitsCsv")).toHaveLength(1);
    expect(appelsDe("ficheConflit")).toEqual([]);
  });
});

describe("validation des entrees : 400 avec code, jamais 500, le service n'est pas appele", () => {
  const ecrire = (m: Route["m"], chemin: string, corps: object | undefined, compte = "GEST") => avec(request(app)[m](`${BASE}${chemin}`), compte).send(corps);

  it("liste des conflits : filtres inconnus ou invalides", async () => {
    for (const q of ["statut=FOO", "type=ZZZ", "limite=0", "limite=201", "limite=abc", "concessionnaireId=xyz", "responsableId=xyz", "aReexaminer=peut-etre", "echeanceDepassee=1", "inconnu=1", "axe=" + "a".repeat(301), "q=" + "a".repeat(101)]) {
      const r = await avec(request(app).get(`${BASE}/${P_R1}/conflits?${q}`), "GEST");
      expect(r.status, q).toBe(400);
      expect(r.body.code, q).toBe("PARAMETRES_INVALIDES");
    }
    expect(w.appels).toEqual([]);
  });

  it("liste des conflits : curseur invalide 400 CURSEUR_INVALIDE ; filtres valides transmis tels quels (statuts et types en listes)", async () => {
    expect((await avec(request(app).get(`${BASE}/${P_R1}/conflits?curseur=zzz`), "GEST")).body.code).toBe("CURSEUR_INVALIDE");
    const ok = await avec(request(app).get(`${BASE}/${P_R1}/conflits?statut=POTENTIEL,CONFIRME&type=TRAVERSEE&axe=Axe%20A&aReexaminer=true&echeanceDepassee=false&q=fibre&limite=7`), "LECT");
    expect(ok.status).toBe(200);
    const [, projetId, filtres, limite] = appelsDe("listerConflits")[0].args as [unknown, string, Record<string, unknown>, number];
    expect(projetId).toBe(P_R1);
    expect(limite).toBe(7);
    expect(filtres).toMatchObject({ statuts: ["POTENTIEL", "CONFIRME"], types: ["TRAVERSEE"], axe: "Axe A", aReexaminer: true, echeanceDepassee: false, q: "fibre" });
  });

  it("transition : statut inconnu, champ en trop, corps absent, recolementAValider non booleen", async () => {
    const chemin = `/${P_R1}/conflits/${C1}/statut`;
    for (const corps of [{ vers: "ANNULE", justification: "Controle effectue" }, { vers: "INFIRME", justification: "Controle effectue", auteur: "x" }, {}, { vers: "CLOTURE", recolementAValider: "oui" }, { vers: "INFIRME", justification: "x".repeat(2001) }]) {
      const r = await ecrire("post", chemin, corps);
      expect(r.status, JSON.stringify(corps)).toBe(400);
      expect(r.body.code).toBe("CHAMPS_INVALIDES");
    }
    expect(appelsDe("changerStatut")).toEqual([]);
  });

  it("une justification courte n'est PAS un 400 : elle est transmise au noyau, qui rend 422 JUSTIFICATION_REQUISE", async () => {
    w.echec = new ErreurMetier(422, "JUSTIFICATION_REQUISE", "Une justification de 10 caractères au moins est requise.");
    const r = await ecrire("post", `/${P_R1}/conflits/${C1}/statut`, { vers: "INFIRME", justification: "court" });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("JUSTIFICATION_REQUISE");
  });

  it("attribution : champ interdit (statut, verticalEvalue, aReexaminer vrai), responsable non UUID, echeance impossible, risque inconnu, corps vide", async () => {
    const chemin = `/${P_R1}/conflits/${C1}`;
    for (const corps of [{ statut: "CLOTURE" }, { verticalEvalue: true }, { aReexaminer: true }, { responsableId: "xyz" }, { echeance: "2026-02-30" }, { echeance: "31/12/2026" }, { risque: "TRES_ELEVE" }, {}, { justification: "seule" }, { actionProposee: "x".repeat(2001) }]) {
      const r = await ecrire("patch", chemin, corps);
      expect(r.status, JSON.stringify(corps)).toBe(400);
      expect(r.body.code).toBe("CHAMPS_INVALIDES");
    }
    expect(appelsDe("modifierConflit")).toEqual([]);
  });

  it("attribution valide : responsable, echeance, risque, action (vide devient nulle), acquittement avec justification", async () => {
    const chemin = `/${P_R1}/conflits/${C1}`;
    for (const corps of [{ responsableId: uuid(7), echeance: "2026-12-31", risque: "ELEVE", actionProposee: "Verifier" }, { responsableId: null, echeance: null, risque: null, actionProposee: null }, { actionProposee: "" }, { aReexaminer: false, justification: "Mesure revue par le chef" }]) {
      expect((await ecrire("patch", chemin, corps)).status, JSON.stringify(corps)).toBe(200);
    }
    expect(appelsDe("modifierConflit")).toHaveLength(4);
    expect((appelsDe("modifierConflit")[2].args[3] as { actionProposee: unknown }).actionProposee).toBeNull();
  });

  it("preuve : type inconnu, texte vide, reference demesuree, champ en trop", async () => {
    const chemin = `/${P_R1}/conflits/${C1}/preuves`;
    for (const corps of [{ type: "PHOTO", texte: "x" }, { type: "NOTE", texte: "" }, { type: "NOTE", texte: "x", reference: "r".repeat(501) }, { type: "NOTE", texte: "x", fichier: "a.pdf" }, { texte: "x" }]) {
      expect((await ecrire("post", chemin, corps)).status, JSON.stringify(corps)).toBe(400);
    }
    expect(appelsDe("ajouterPreuve")).toEqual([]);
    const ok = await ecrire("post", chemin, { type: "REFERENCE_DOCUMENT", texte: "Courrier", reference: "N 2026/045" });
    expect(ok.status).toBe(201);
  });

  it("decision : option inconnue (aucune option « ordonner » ni « deplacer automatiquement »), cout sans devise, cout negatif ou demesure, devise mal formee, dates impossibles, champ en trop", async () => {
    const chemin = `/${P_R1}/conflits/${C1}/decisions`;
    const base = { option: "PROTEGER", justification: "Protection mecanique du cable" };
    for (const corps of [
      { ...base, option: "ORDONNER" }, { ...base, option: "DEPLACER_AUTOMATIQUEMENT" }, { ...base, coutEstime: 100 }, { ...base, coutReel: 100 }, { ...base, coutEstime: -1, deviseCout: "GNF" },
      { ...base, coutEstime: 1e15, deviseCout: "GNF" }, { ...base, deviseCout: "guinee" }, { ...base, dateDebutPrevue: "2026-13-01" }, { ...base, ordre: "x" }, {},
    ]) {
      expect((await ecrire("post", chemin, corps)).status, JSON.stringify(corps)).toBe(400);
    }
    expect(appelsDe("proposerDecision")).toEqual([]);
    const ok = await ecrire("post", chemin, { ...base, coutEstime: 12500000.5, deviseCout: "GNF", coutReel: null, dateDebutPrevue: "2026-12-01", dateFinPrevue: "2026-12-20", contraintes: "Coupure a coordonner" });
    expect(ok.status).toBe(201);
    expect(appelsDe("proposerDecision")[0].args[3]).toMatchObject({ option: "PROTEGER", coutEstime: 12500000.5, deviseCout: "GNF", coutReel: null });
  });

  it("approbation et refus d'une decision : champ en trop refuse ; derogation transmise telle quelle au service", async () => {
    const chemin = `/${P_R1}/conflits/${C1}/decisions/${D1}/approuver`;
    expect((await ecrire("post", chemin, { motif: "Decision validee", auteur: "x" })).status).toBe(400);
    expect((await ecrire("post", chemin, { motif: "Decision validee par moi", derogation: "Seul disponible aujourd'hui" })).status).toBe(200);
    const args = appelsDe("trancherDecision")[0].args as unknown[];
    expect(args[4]).toBe("APPROUVEE");
    expect(args[5]).toEqual({ motif: "Decision validee par moi", derogation: "Seul disponible aujourd'hui" });
    await ecrire("post", `/${P_R1}/conflits/${C1}/decisions/${D1}/refuser`, { motif: "Refus motive du chef" });
    expect(appelsDe("trancherDecision")[1].args[4]).toBe("REFUSEE");
  });

  it("regles : code, tolerance, marge, famille invalides, statut impose ; une creation valide recoit sa marge par defaut", async () => {
    const chemin = `/${P_R1}/regles`;
    const base = { code: "TOL-1", toleranceProximiteM: 2, justification: "Tolerance proposee par la direction" };
    for (const corps of [{ ...base, code: "x" }, { ...base, code: "a b" }, { ...base, toleranceProximiteM: -1 }, { ...base, toleranceProximiteM: 1001 }, { ...base, margeIncertitude: 101 }, { ...base, famille: "GAZ_PLUS" }, { ...base, statut: "APPROUVEE" }, { ...base, version: 5 }, { toleranceProximiteM: 1 }]) {
      expect((await ecrire("post", chemin, corps)).status, JSON.stringify(corps)).toBe(400);
    }
    expect(appelsDe("creerRegle")).toEqual([]);
    expect((await ecrire("post", chemin, { ...base, famille: "TELECOM" })).status).toBe(201);
    expect(appelsDe("creerRegle")[0].args[2]).toMatchObject({ famille: "TELECOM", code: "TOL-1", toleranceProximiteM: 2, margeIncertitude: 1 });
  });

  it("analyse : un corps avec un champ (aucun parametre de calcul n'est modifiable par la requete) est refuse", async () => {
    expect((await ecrire("post", `/${P_R1}/analyses`, { largeurEmpriseM: 50 })).status).toBe(400);
    expect((await ecrire("post", `/${P_R1}/analyses`, { inclureNonAutorises: true })).status).toBe(400);
    expect(appelsDe("lancerAnalyse")).toEqual([]);
    expect((await avec(request(app).post(`${BASE}/${P_R1}/analyses`), "GEST")).status).toBe(201);
  });

  it("liste des analyses : limite hors bornes, curseur invalide", async () => {
    expect((await avec(request(app).get(`${BASE}/${P_R1}/analyses?limite=0`), "GEST")).status).toBe(400);
    expect((await avec(request(app).get(`${BASE}/${P_R1}/analyses?limite=101`), "GEST")).status).toBe(400);
    expect((await avec(request(app).get(`${BASE}/${P_R1}/analyses?curseur=zzz`), "GEST")).body.code).toBe("CURSEUR_INVALIDE");
    expect((await avec(request(app).get(`${BASE}/${P_R1}/analyses?limite=5`), "GEST")).status).toBe(200);
  });
});

describe("erreurs typees du contrat : rendues telles quelles, au format { error, code, ... }", () => {
  const cas: [ErreurMetier, number][] = [
    [new ErreurMetier(409, "TRANSITION_INTERDITE", "La transition A vers B n'existe pas."), 409],
    [new ErreurMetier(409, "SEPARATION_DES_TACHES", "Separation des taches."), 409],
    [new ErreurMetier(409, "DECISION_REQUISE", "Une decision approuvee est requise."), 409],
    [new ErreurMetier(409, "PREUVE_REQUISE", "Une preuve est requise."), 409],
    [new ErreurMetier(409, "REGLE_IMMUABLE", "Regle approuvee."), 409],
    [new ErreurMetier(422, "JUSTIFICATION_REQUISE", "Justification requise."), 422],
    [new ErreurMetier(404, "CONFLIT_INTROUVABLE", "Conflit introuvable"), 404],
    [new ErreurMetier(503, "PROJET_OCCUPE", "Projet occupe."), 503],
    [new ErreurMetier(504, "ANALYSE_TROP_LONGUE", "Analyse trop longue."), 504],
    [new ErreurMetier(422, "ANALYSE_TROP_VOLUMINEUSE", "Trop volumineux.", { conflitsMax: 100 }), 422],
  ];
  it("chaque erreur du service sort avec son statut, son code et ses champs supplementaires, jamais un 500", async () => {
    for (const [e, statut] of cas) {
      w.echec = e;
      const r = await avec(request(app).post(`${BASE}/${P_R1}/conflits/${C1}/statut`).send({ vers: "POTENTIEL", justification: "Controle effectue avec le chef" }), "GEST");
      expect(r.status, e.code).toBe(statut);
      expect(r.body).toEqual({ error: e.message, code: e.code, ...e.extra });
    }
  });

  it("une analyse refusee pour surcharge du processus : 503 SERVICE_OCCUPE avec Retry-After", async () => {
    w.echec = new ServiceOccupe("Trop d'analyses simultanees.", 7);
    const r = await avec(request(app).post(`${BASE}/${P_R1}/analyses`).send({}), "GEST");
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("SERVICE_OCCUPE");
    expect(r.headers["retry-after"]).toBe("7");
  });

  it("une erreur inattendue du service : 500 generique, sans detail", async () => {
    w.echec = new Error("secret interne : postgres://utilisateur:motdepasse@hote");
    const r = await avec(request(app).get(`${BASE}/${P_R1}/conflits`), "GEST");
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toMatch(/secret interne|motdepasse/);
  });
});

describe("aucune route d'ordre, de deplacement ni de decision automatique", () => {
  it("les routes inventees ne repondent pas : 404 (aucun ordre, deplacement, ordonnancement)", async () => {
    for (const [m, c] of [["post", `/${P_R1}/conflits/${C1}/ordre`], ["post", `/${P_R1}/conflits/${C1}/deplacer`], ["post", `/${P_R1}/conflits/${C1}/ordonner`], ["post", `/${P_R1}/ordres`], ["post", `/${P_R1}/conflits/${C1}/decision-automatique`]] as const) {
      const r = await avec(request(app)[m](`${BASE}${c}`).send({}), "ADMIN");
      expect(r.status, c).toBe(404);
    }
    expect(w.appels).toEqual([]);
  });
});
