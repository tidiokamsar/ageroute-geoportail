import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Routes du WORKFLOW (`/api/v2/projets-voirie/{workflow, :id/workflow}`, lot B3) : cablage des gardes, matrice des droits par profil effectif, isolation du
 * referent concessionnaire, validation des entrees, traduction des erreurs typees. Les VRAIS `requireAuth` (jeton signe, resolveur de compte injecte),
 * `requireModuleAccess`, `gardeReferent`, gardes territoriales, `gardeWorkflow` et validation zod ; seuls la BASE (comptes, modules, perimetres,
 * rattachements) et les SERVICES (qui parlent a PostGIS) sont simules. Le SQL, les declencheurs, la visibilite des lignes et l'audit sont prouves par le
 * banc `tests-integration/workflow-roles.integration.mts` et par les tests des noyaux (`projets-voirie/workflow/*.noyau.test.ts`).
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
    rattachements: {} as Record<string, { id: string; projetId: string; concessionnaireId: string }[]>,
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
      if (nom === "referentConcessionnaire") return { findMany: async ({ where }: { where: { userId: string } }) => w.rattachements[where.userId] ?? [] };
      return new Proxy({}, { get: () => async () => null });
    },
  });
  return { prisma };
});

vi.mock("../projets-voirie/projets.service", async (original) => {
  const m = await original<typeof import("../projets-voirie/projets.service")>();
  return {
    ...m,
    regionsDuProjet: vi.fn(async (id: string) => (id in w.regionsProjets ? [w.regionsProjets[id]] : [])),
    listerProjets: espion("listerProjets", { projets: [], curseurSuivant: null }), ficheProjet: espion("ficheProjet", { id: "p" }),
    listerJeux: espion("listerJeux", { jeux: [] }),
  };
});
vi.mock("../projets-voirie/import.service", () => ({ deposerJeu: espion("deposerJeu", {}) }));
vi.mock("../projets-voirie/carte.service", () => ({ carte: espion("carte", {}) }));
vi.mock("../projets-voirie/analyse.service", () => ({ analyser: espion("analyser", {}), exporterCsv: vi.fn(), celluleCsv: vi.fn() }));
vi.mock("../projets-voirie/conflits/analyse-conflits.service", () => ({ lancerAnalyse: espion("lancerAnalyse", {}) }));
vi.mock("../projets-voirie/conflits/regles-analyses.service", async (original) => {
  const m = await original<typeof import("../projets-voirie/conflits/regles-analyses.service")>();
  return { ...m, listerRegles: espion("listerRegles", {}), listerAnalyses: espion("listerAnalyses", {}) };
});
vi.mock("../projets-voirie/conflits/dossiers.service", async (original) => {
  const m = await original<typeof import("../projets-voirie/conflits/dossiers.service")>();
  return {
    ...m, listerConflits: espion("listerConflits", { conflits: [] }), ficheConflit: espion("ficheConflit", {}), changerStatut: espion("changerStatut", {}),
    ajouterPreuve: espion("ajouterPreuveConflit", {}), trancherDecision: espion("trancherDecision", {}),
  };
});

vi.mock("../projets-voirie/workflow/demandes.service", async (original) => {
  const m = await original<typeof import("../projets-voirie/workflow/demandes.service")>();
  return {
    ...m, listerDemandes: espion("listerDemandes", { demandes: [], compteurs: {}, curseurSuivant: null }), creerDemande: espion("creerDemande", { demande: { id: "d" } }),
    ficheDemande: espion("ficheDemande", { demande: { id: "d" } }), modifierDemande: espion("modifierDemande", { demande: { id: "d" } }),
    changerStatutDemande: espion("changerStatutDemande", { demande: { id: "d" } }),
  };
});
vi.mock("../projets-voirie/workflow/taches.service", async (original) => {
  const m = await original<typeof import("../projets-voirie/workflow/taches.service")>();
  return {
    ...m, listerTaches: espion("listerTaches", { taches: [] }), creerTache: espion("creerTache", { tache: { id: "t" } }), ficheTache: espion("ficheTache", { tache: { id: "t" } }),
    modifierTache: espion("modifierTache", { tache: { id: "t" } }), changerStatutTache: espion("changerStatutTache", { tache: { id: "t" } }),
  };
});
vi.mock("../projets-voirie/workflow/recolements.service", async (original) => {
  const m = await original<typeof import("../projets-voirie/workflow/recolements.service")>();
  return {
    ...m, listerRecolements: espion("listerRecolements", { recolements: [] }), creerRecolement: espion("creerRecolement", { recolement: { id: "r" } }),
    ficheRecolement: espion("ficheRecolement", { recolement: { id: "r" } }), modifierRecolement: espion("modifierRecolement", { recolement: { id: "r" } }),
    changerStatutRecolement: espion("changerStatutRecolement", { recolement: { id: "r" } }),
  };
});
vi.mock("../projets-voirie/workflow/preuves.service", async (original) => {
  const m = await original<typeof import("../projets-voirie/workflow/preuves.service")>();
  return { ...m, ajouterPreuve: espion("ajouterPreuve", { preuve: { id: "p" } }) };
});
vi.mock("../projets-voirie/workflow/vues-restreintes.service", async (original) => {
  const m = await original<typeof import("../projets-voirie/workflow/vues-restreintes.service")>();
  return { ...m, listerJeuxVue: espion("listerJeuxVue", { jeux: [] }), listerConflitsVue: espion("listerConflitsVue", { conflits: [], curseurSuivant: null }) };
});
vi.mock("../projets-voirie/workflow/referents.service", async (original) => {
  const m = await original<typeof import("../projets-voirie/workflow/referents.service")>();
  return {
    ...m, listerReferents: espion("listerReferents", { rattachements: [] }), creerRattachement: espion("creerRattachement", { rattachement: { id: "x" } }),
    revoquerRattachement: espion("revoquerRattachement", { rattachement: { id: "x" }, avertissements: [] }), monProfil: espion("monProfil", { provisoire: true }),
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

const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const P1 = uuid(1), P2 = uuid(2), P_SANS = uuid(3), C1 = uuid(11), C2 = uuid(12), D1 = uuid(21), T1 = uuid(31), R1 = uuid(41), RT = uuid(51), U1 = uuid(61);

const COMPTES: Record<string, { id: string; role: string; modules: string[]; regions?: number[]; rattaches?: { id: string; projetId: string; concessionnaireId: string }[] }> = {
  ADMIN: { id: "u-admin", role: "ADMIN", modules: [] },
  GEST: { id: "u-gest", role: "GESTIONNAIRE", modules: ["projets-voirie"] },
  INSP: { id: "u-insp", role: "INSPECTEUR", modules: ["projets-voirie"] },
  LECT: { id: "u-lect", role: "LECTEUR", modules: ["projets-voirie"] },
  SANS: { id: "u-sans", role: "GESTIONNAIRE", modules: ["troncons"] },
  GEST_R1: { id: "u-gest-1", role: "GESTIONNAIRE", modules: ["projets-voirie"], regions: [1] },
  // Referent : LECTEUR rattache au concessionnaire C1 du projet P1 seulement.
  REF: { id: "u-ref", role: "LECTEUR", modules: ["projets-voirie"], rattaches: [{ id: RT, projetId: P1, concessionnaireId: C1 }] },
};
const jeton = (c: string) => signAccessToken({ sub: COMPTES[c].id, role: COMPTES[c].role as never, email: `${c}@essai.invalid` });
const BASE = "/api/v2/projets-voirie";

beforeEach(() => {
  w.appels = []; w.echec = null; w.modules = {}; w.perimetres = {}; w.rattachements = {};
  w.regionsProjets = { [P1]: 1, [P2]: 2, [P_SANS]: null };
  for (const c of Object.values(COMPTES)) {
    w.modules[c.id] = c.modules;
    if (c.regions) w.perimetres[c.id] = c.regions;
    if (c.rattaches) w.rattachements[c.id] = c.rattaches;
  }
  _installerResolveurCompte(async (id) => {
    const c = Object.values(COMPTES).find((x) => x.id === id);
    return c ? { actif: true, lockedUntil: null, role: c.role as never, email: `${id}@essai.invalid` } : null;
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => _installerResolveurCompte(null));

const avec = (r: request.Test, compte: string | null) => (compte ? r.set("Authorization", `Bearer ${jeton(compte)}`) : r);
const appelsDe = (nom: string) => w.appels.filter((a) => a.nom === nom);

type M = "get" | "post" | "patch" | "delete";
interface Route { m: M; chemin: string; corps?: object; service: string; succes: number; profils: string[] }
const W = `/${P1}/workflow`;
const DEC = ["ADMIN", "GEST"], TOUS_LECTURE = ["ADMIN", "GEST", "REF"];
const preuve = { type: "NOTE", texte: "Reponse recue par courrier" };
/** Les 23 routes du projet : le service appele, le statut de succes et les comptes que la matrice par defaut laisse passer. */
const ROUTES: Route[] = [
  { m: "get", chemin: `${W}/referents`, service: "listerReferents", succes: 200, profils: DEC },
  { m: "post", chemin: `${W}/referents`, corps: { userId: U1, concessionnaireId: C1, motif: "Referent designe par la direction" }, service: "creerRattachement", succes: 201, profils: ["ADMIN"] },
  { m: "post", chemin: `${W}/referents/${RT}/revoquer`, corps: { motif: "Le referent a change de poste" }, service: "revoquerRattachement", succes: 200, profils: ["ADMIN"] },
  { m: "get", chemin: `${W}/jeux`, service: "listerJeuxVue", succes: 200, profils: TOUS_LECTURE },
  { m: "get", chemin: `${W}/conflits`, service: "listerConflitsVue", succes: 200, profils: TOUS_LECTURE },
  { m: "get", chemin: `${W}/demandes`, service: "listerDemandes", succes: 200, profils: TOUS_LECTURE },
  { m: "post", chemin: `${W}/demandes`, corps: { concessionnaireId: C1, objet: "Plans des reseaux de la voirie" }, service: "creerDemande", succes: 201, profils: DEC },
  { m: "get", chemin: `${W}/demandes/${D1}`, service: "ficheDemande", succes: 200, profils: TOUS_LECTURE },
  { m: "patch", chemin: `${W}/demandes/${D1}`, corps: { objet: "Nouvel objet" }, service: "modifierDemande", succes: 200, profils: DEC },
  { m: "post", chemin: `${W}/demandes/${D1}/statut`, corps: { vers: "ENVOYEE", canalEnvoi: "courriel", dateEnvoi: "2026-11-05" }, service: "changerStatutDemande", succes: 200, profils: DEC },
  { m: "post", chemin: `${W}/demandes/${D1}/preuves`, corps: preuve, service: "ajouterPreuve", succes: 201, profils: [...DEC, "INSP", "REF"] },
  { m: "get", chemin: `${W}/taches`, service: "listerTaches", succes: 200, profils: [...TOUS_LECTURE, "INSP"] },
  { m: "post", chemin: `${W}/taches`, corps: { titre: "Relancer le concessionnaire", responsableId: U1 }, service: "creerTache", succes: 201, profils: DEC },
  { m: "get", chemin: `${W}/taches/${T1}`, service: "ficheTache", succes: 200, profils: [...TOUS_LECTURE, "INSP"] },
  { m: "patch", chemin: `${W}/taches/${T1}`, corps: { priorite: "HAUTE" }, service: "modifierTache", succes: 200, profils: DEC },
  { m: "post", chemin: `${W}/taches/${T1}/statut`, corps: { vers: "EN_COURS" }, service: "changerStatutTache", succes: 200, profils: [...DEC, "INSP", "REF"] },
  { m: "post", chemin: `${W}/taches/${T1}/preuves`, corps: preuve, service: "ajouterPreuve", succes: 201, profils: [...DEC, "INSP", "REF"] },
  { m: "get", chemin: `${W}/recolements`, service: "listerRecolements", succes: 200, profils: TOUS_LECTURE },
  { m: "post", chemin: `${W}/recolements`, corps: { conflitId: C2, objet: "Recolement du reseau deplace" }, service: "creerRecolement", succes: 201, profils: DEC },
  { m: "get", chemin: `${W}/recolements/${R1}`, service: "ficheRecolement", succes: 200, profils: TOUS_LECTURE },
  { m: "patch", chemin: `${W}/recolements/${R1}`, corps: { constat: "Le reseau est a 4 m", justification: "Constat du releve de terrain" }, service: "modifierRecolement", succes: 200, profils: DEC },
  { m: "post", chemin: `${W}/recolements/${R1}/statut`, corps: { vers: "SOUMIS", justification: "Pret pour validation" }, service: "changerStatutRecolement", succes: 200, profils: DEC },
  { m: "post", chemin: `${W}/recolements/${R1}/preuves`, corps: { type: "PLAN_RECOLEMENT", texte: "Plan transmis", reference: "Courrier 14/2026", sha256: "a".repeat(64) }, service: "ajouterPreuve", succes: 201, profils: [...DEC, "INSP", "REF"] },
];
const appeler = (r: Route, compte: string | null, chemin = r.chemin, corps: object | undefined = r.corps) => {
  const req = avec(request(app)[r.m](`${BASE}${chemin}`), compte);
  return corps !== undefined ? req.send(corps) : req;
};

describe("gardes : authentification, module, matrice des droits par profil effectif", () => {
  it("23 routes de projet, sans jeton : 401 partout, aucun service appele", async () => {
    expect(ROUTES).toHaveLength(23);
    for (const r of ROUTES) expect((await appeler(r, null)).status, `${r.m} ${r.chemin}`).toBe(401);
    expect((await avec(request(app).get(`${BASE}/workflow/mon-profil`), null)).status).toBe(401);
    expect(w.appels).toEqual([]);
  });

  it("sans la cle `projets-voirie` : 403 partout, aucun service appele", async () => {
    for (const r of ROUTES) expect((await appeler(r, "SANS")).status, `${r.m} ${r.chemin}`).toBe(403);
    expect((await avec(request(app).get(`${BASE}/workflow/mon-profil`), "SANS")).status).toBe(403);
    expect(w.appels).toEqual([]);
  });

  it("matrice par defaut : chaque compte passe sur les routes de son profil (statut de succes) et recoit 403 ACTION_NON_AUTORISEE ailleurs, sans appeler le service", async () => {
    for (const compte of ["ADMIN", "GEST", "INSP", "LECT", "REF"]) {
      for (const r of ROUTES) {
        w.appels = [];
        const rep = await appeler(r, compte);
        if (r.profils.includes(compte)) {
          expect(rep.status, `${compte} ${r.m} ${r.chemin}`).toBe(r.succes);
          expect(appelsDe(r.service), `${compte} ${r.service}`).toHaveLength(1);
        } else {
          expect(rep.status, `${compte} ${r.m} ${r.chemin}`).toBe(403);
          expect(rep.body.code, `${compte} ${r.m} ${r.chemin}`).toBe("ACTION_NON_AUTORISEE");
          expect(typeof rep.body.action).toBe("string");
          expect(appelsDe(r.service), `${compte} ${r.service}`).toEqual([]);
        }
      }
    }
  });

  it("un observateur ou un auditeur (LECTEUR) ne peut rien lire ni ecrire du workflow par defaut ; un agent de terrain ne lit que ses taches", async () => {
    for (const r of ROUTES) expect((await appeler(r, "LECT")).status, `LECT ${r.m} ${r.chemin}`).toBe(403);
    expect((await appeler(ROUTES[5], "INSP")).status).toBe(403); // demandes
    expect((await appeler(ROUTES[11], "INSP")).status).toBe(200); // taches
  });

  it("l'acteur transmis au service est le compte du jeton : identifiant, role, profil effectif et rattachements (lus en base), jamais un champ du corps", async () => {
    await appeler(ROUTES[6], "GEST", ROUTES[6].chemin, { ...ROUTES[6].corps, acteur: { id: "intrus" }, creeParId: "intrus" } as object).then((r) => expect(r.status).toBe(400));
    await appeler(ROUTES[6], "GEST");
    const [acteur, projetId, corps] = appelsDe("creerDemande")[0].args as [{ id: string; role: string; profil: string; referent: boolean }, string, Record<string, unknown>];
    expect(acteur).toMatchObject({ id: "u-gest", role: "GESTIONNAIRE", profil: "GESTIONNAIRE", referent: false });
    expect(projetId).toBe(P1);
    expect(corps).toEqual({ concessionnaireId: C1, objet: "Plans des reseaux de la voirie" });
    await appeler(ROUTES[11], "REF");
    const [ref] = appelsDe("listerTaches")[0].args as [{ id: string; profil: string; referent: boolean; rattachements: unknown[] }];
    expect(ref).toMatchObject({ id: "u-ref", profil: "REFERENT", referent: true });
    expect(ref.rattachements).toEqual([{ id: RT, projetId: P1, concessionnaireId: C1 }]);
  });

  it("les reponses ne sont jamais mises en cache ni reinterpretees par le navigateur", async () => {
    const r = await appeler(ROUTES[5], "GEST");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("referent concessionnaire : confine au workflow, au projet et au concessionnaire de son rattachement", () => {
  const SOCLE: [M, string, object?][] = [
    ["get", ""], ["get", "/concessionnaires"], ["get", `/${P1}`], ["get", `/${P1}/jeux`], ["get", `/${P1}/carte`], ["get", `/${P1}/analyse`],
    ["get", `/${P1}/regles`], ["get", `/${P1}/analyses`], ["get", `/${P1}/conflits`], ["get", `/${P1}/conflits/${C2}`], ["post", `/${P1}/conflits/${C2}/statut`, { vers: "POTENTIEL", justification: "x".repeat(12) }],
    ["post", `/${P1}/conflits/${C2}/decisions/${D1}/approuver`, {}], ["patch", `/${P1}`, { nom: "x" }], ["post", "", { code: "X1", nom: "x" }], ["delete", `/${P1}`],
  ];

  it("toute route du socle et des dossiers de conflit : 403 COMPTE_REFERENT_RESTREINT, avant toute lecture (aucun service appele)", async () => {
    for (const [m, c, corps] of SOCLE) {
      const rep = await avec((request(app) as unknown as Record<string, (u: string) => request.Test>)[m](`${BASE}${c}`), "REF").send(corps);
      expect(rep.status, `${m} ${c}`).toBe(403);
      expect(rep.body.code, `${m} ${c}`).toBe("COMPTE_REFERENT_RESTREINT");
    }
    for (const nom of ["listerProjets", "ficheProjet", "listerJeux", "carte", "analyser", "listerRegles", "listerAnalyses", "listerConflits", "ficheConflit", "changerStatut", "trancherDecision"]) {
      expect(appelsDe(nom), nom).toEqual([]);
    }
  });

  it("le meme compte sans rattachement n'est pas touche : un lecteur ordinaire lit le socle (200)", async () => {
    expect((await avec(request(app).get(`${BASE}/${P1}/conflits`), "LECT")).status).toBe(200);
    expect(appelsDe("listerConflits")).toHaveLength(1);
    expect((await avec(request(app).get(`${BASE}`), "INSP")).status).toBe(200);
  });

  it("un rattachement revoque (plus de ligne active) rend le compte a l'etat de lecteur ordinaire : le socle lui est de nouveau ouvert", async () => {
    w.rattachements = {};
    expect((await avec(request(app).get(`${BASE}/${P1}/conflits`), "REF")).status).toBe(200);
  });

  it("un projet ou le referent n'est pas rattache, un projet sans region et un projet inconnu : la MEME 404, meme avec un corps invalide, avant toute validation", async () => {
    const corps = { error: "Projet introuvable", code: "PROJET_INTROUVABLE" };
    for (const r of ROUTES.filter((x) => x.profils.includes("REF"))) {
      for (const projet of [P2, P_SANS, uuid(99)]) {
        const chemin = r.chemin.replace(P1, projet);
        const rep = await appeler(r, "REF", chemin, r.m === "get" ? undefined : { champInvalide: true });
        expect(rep.status, `${r.m} ${chemin}`).toBe(404);
        expect(rep.body).toEqual(corps);
      }
    }
    expect(w.appels).toEqual([]);
  });

  it("dans le projet de son rattachement il lit et complete ; mon-profil lui est ouvert", async () => {
    expect((await appeler(ROUTES[5], "REF")).status).toBe(200);
    expect((await appeler(ROUTES[10], "REF")).status).toBe(201);
    expect((await avec(request(app).get(`${BASE}/workflow/mon-profil`), "REF")).status).toBe(200);
    expect(appelsDe("monProfil")).toHaveLength(1);
  });

  it("le referent ne pose pas de rattachement, ne cree rien, ne valide rien (403 ACTION_NON_AUTORISEE)", async () => {
    for (const i of [0, 1, 2, 6, 8, 9, 12, 14, 18, 20, 21]) expect((await appeler(ROUTES[i], "REF")).status, `${ROUTES[i].m} ${ROUTES[i].chemin}`).toBe(403);
  });

  it("un gestionnaire regional hors perimetre reste soumis au 404 masque du socle", async () => {
    const r = await appeler(ROUTES[5], "GEST_R1", ROUTES[5].chemin.replace(P1, P2));
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("PROJET_INTROUVABLE");
    expect((await appeler(ROUTES[5], "GEST_R1")).status).toBe(200);
  });
});

describe("configuration de la matrice (PROJETS_VOIRIE_WORKFLOW_MATRICE)", () => {
  it("ouvrir la lecture aux observateurs : un LECTEUR lit (200) mais n'ecrit toujours rien", async () => {
    vi.stubEnv("PROJETS_VOIRIE_WORKFLOW_MATRICE", JSON.stringify({ "workflow.lire": ["LECTEUR"] }));
    expect((await appeler(ROUTES[5], "LECT")).status).toBe(200);
    expect((await appeler(ROUTES[6], "LECT")).status).toBe(403);
    expect((await appeler(ROUTES[1], "LECT")).status).toBe(403);
  });

  it("une configuration invalide est ignoree : la matrice par defaut s'applique (aucune ouverture accidentelle)", async () => {
    vi.stubEnv("PROJETS_VOIRIE_WORKFLOW_MATRICE", JSON.stringify({ "referent.gerer": ["GESTIONNAIRE"], "demande.ecrire": ["REFERENT"], "workflow.lire": ["SUPER"] }));
    expect((await appeler(ROUTES[1], "GEST")).status).toBe(403);
    expect((await appeler(ROUTES[6], "REF")).status).toBe(403);
    expect((await appeler(ROUTES[5], "LECT")).status).toBe(403);
  });

  it("retirer un droit a l'agent de terrain : plus d'acces a ses taches", async () => {
    vi.stubEnv("PROJETS_VOIRIE_WORKFLOW_MATRICE", JSON.stringify({ "tache.executer": ["GESTIONNAIRE"], "preuve.ajouter": ["GESTIONNAIRE"] }));
    expect((await appeler(ROUTES[11], "INSP")).status).toBe(403);
    expect((await appeler(ROUTES[15], "INSP")).status).toBe(403);
    expect((await appeler(ROUTES[15], "REF")).status).toBe(403);
    expect((await appeler(ROUTES[15], "GEST")).status).toBe(200);
  });
});

describe("identifiants, curseurs et caracteres", () => {
  it("identifiant de demande, tache, recolement ou rattachement qui n'est pas un UUID : 400 IDENTIFIANT_INVALIDE (%00 compris), aucun service appele", async () => {
    const chemins: [M, string, object?][] = [
      ["get", `${W}/demandes/pas-un-uuid`], ["patch", `${W}/demandes/zzz`, { objet: "x" }], ["post", `${W}/demandes/zzz/statut`, {}], ["post", `${W}/demandes/%00/preuves`, preuve],
      ["get", `${W}/taches/zzz`], ["post", `${W}/taches/zzz/statut`, {}], ["get", `${W}/recolements/zzz`], ["post", `${W}/recolements/zzz/statut`, {}],
      ["post", `${W}/referents/zzz/revoquer`, { motif: "motif de revocation" }],
    ];
    for (const [m, c, corps] of chemins) {
      const rep = await avec(request(app)[m](`${BASE}${c}`), "ADMIN").send(corps);
      expect(rep.status, `${m} ${c}`).toBe(400);
      expect(rep.body.code, `${m} ${c}`).toBe("IDENTIFIANT_INVALIDE");
    }
    expect(w.appels).toEqual([]);
  });

  it("curseur forge sur une liste : 400 CURSEUR_INVALIDE ; curseur valide transmis decode", async () => {
    for (const chemin of ["demandes", "taches", "recolements", "conflits"]) {
      for (const curseur of ["pas-un-curseur", Buffer.from(JSON.stringify({ t: "2999-01-01T00:00:00.000Z", i: "x" })).toString("base64url"), Buffer.from(JSON.stringify({ t: "2026-11-07T10:00:00.000Z", i: "a\u0000b" })).toString("base64url")]) {
        const rep = await avec(request(app).get(`${BASE}${W}/${chemin}?curseur=${curseur}`), "GEST");
        expect(rep.status, `${chemin} ${curseur.slice(0, 12)}`).toBe(400);
        expect(rep.body.code).toBe("CURSEUR_INVALIDE");
      }
    }
    const bon = Buffer.from(JSON.stringify({ t: "2026-11-07T10:00:00.000Z", i: uuid(77) })).toString("base64url");
    expect((await avec(request(app).get(`${BASE}${W}/demandes?curseur=${bon}`), "GEST")).status).toBe(200);
    const [, , , limite, curseur] = appelsDe("listerDemandes")[0].args as [unknown, string, unknown, number, { t: Date; i: string }];
    expect(limite).toBe(25);
    expect(curseur.i).toBe(uuid(77));
  });

  it("un octet NUL dans un parametre ou un corps : 400 PARAMETRES_INVALIDES", async () => {
    const q = await avec(request(app).get(`${BASE}${W}/demandes?statut=a%00b`), "GEST");
    const c = await avec(request(app).post(`${BASE}${W}/demandes`).send({ concessionnaireId: C1, objet: "Plans\u0000reseaux" }), "GEST");
    expect(q.status).toBe(400);
    expect(c.status).toBe(400);
    expect(c.body.code).toBe("PARAMETRES_INVALIDES");
    expect(w.appels).toEqual([]);
  });
});

describe("validation des entrees : 400 avec code, jamais 500, le service n'est pas appele", () => {
  const ecrire = (m: M, chemin: string, corps: object | undefined, compte = "GEST") => avec(request(app)[m](`${BASE}${chemin}`), compte).send(corps);

  it("filtres de liste inconnus ou invalides", async () => {
    for (const q of ["statut=INCONNU", "statut=", "concessionnaireId=zzz", "echeanceDepassee=peut-etre", "limite=0", "limite=101", "limite=abc", "inconnu=1"]) {
      const rep = await avec(request(app).get(`${BASE}${W}/demandes?${q}`), "GEST");
      if (q === "statut=") expect(rep.status, q).toBe(200); // vide : filtre absent
      else expect(rep.status, q).toBe(400);
    }
    for (const q of ["statut=INCONNU", "responsableId=zzz", "conflitId=zzz", "demandeId=zzz", "priorite=HAUTE"]) expect((await avec(request(app).get(`${BASE}${W}/taches?${q}`), "GEST")).status, q).toBe(400);
    for (const q of ["statut=INCONNU", "jeuId=zzz", "conflitId=zzz"]) expect((await avec(request(app).get(`${BASE}${W}/recolements?${q}`), "GEST")).status, q).toBe(400);
    for (const q of ["statut=VALIDE", "type=INCONNU"]) expect((await avec(request(app).get(`${BASE}${W}/conflits?${q}`), "GEST")).status, q).toBe(400);
  });

  it("demande : corps invalides (champ inconnu, date impossible, objet vide ou trop long, concessionnaire non UUID)", async () => {
    const ok = { concessionnaireId: C1, objet: "Plans" };
    for (const corps of [{}, { ...ok, extra: 1 }, { ...ok, echeance: "2026-02-30" }, { ...ok, objet: "  " }, { ...ok, objet: "x".repeat(201) }, { ...ok, concessionnaireId: "zzz" }, { ...ok, description: "x".repeat(4001) }, { ...ok, creeParId: U1 }]) {
      const rep = await ecrire("post", `${W}/demandes`, corps);
      expect(rep.status, JSON.stringify(corps).slice(0, 60)).toBe(400);
      expect(rep.body.code).toBe("CHAMPS_INVALIDES");
    }
    expect(appelsDe("creerDemande")).toEqual([]);
  });

  it("statut d'une demande : forme propre a chaque transition (envoi : canal et date ; reception : date ; cloture : motif), vers inconnu", async () => {
    for (const corps of [{ vers: "BROUILLON" }, { vers: "ENVOYEE" }, { vers: "ENVOYEE", canalEnvoi: "x" }, { vers: "ENVOYEE", canalEnvoi: "x", dateEnvoi: "demain" }, { vers: "ENVOYEE", canalEnvoi: "x".repeat(101), dateEnvoi: "2026-11-05" },
      { vers: "RECUE" }, { vers: "RECUE", dateReception: "2026-11-05", jeuRecuId: "zzz" }, { vers: "CLOTUREE" }, { vers: "ANNULEE", justification: 5 }, { vers: "CLOTUREE", justification: "x", extra: true }, {}]) {
      const rep = await ecrire("post", `${W}/demandes/${D1}/statut`, corps);
      expect(rep.status, JSON.stringify(corps)).toBe(400);
    }
    expect(appelsDe("changerStatutDemande")).toEqual([]);
    expect((await ecrire("post", `${W}/demandes/${D1}/statut`, { vers: "RECUE", dateReception: "2026-11-05", jeuRecuId: C2, note: "recu" })).status).toBe(200);
  });

  it("modification d'une demande : au moins un champ", async () => {
    expect((await ecrire("patch", `${W}/demandes/${D1}`, {})).status).toBe(400);
    expect((await ecrire("patch", `${W}/demandes/${D1}`, { justification: "motif suffisant" })).status).toBe(400);
    expect((await ecrire("patch", `${W}/demandes/${D1}`, { echeance: null, justification: "prolongation accordee" })).status).toBe(200);
  });

  it("tache : titre, responsable, priorite, liens", async () => {
    const ok = { titre: "Relancer", responsableId: U1 };
    for (const corps of [{}, { titre: "Relancer" }, { ...ok, responsableId: "zzz" }, { ...ok, priorite: "TRES_HAUTE" }, { ...ok, conflitId: "zzz" }, { ...ok, validationRequise: "oui" }, { ...ok, extra: 1 }, { ...ok, titre: "" }]) {
      expect((await ecrire("post", `${W}/taches`, corps)).status, JSON.stringify(corps)).toBe(400);
    }
    expect(appelsDe("creerTache")).toEqual([]);
    expect((await ecrire("post", `${W}/taches`, { ...ok, priorite: "URGENTE", validationRequise: true, conflitId: C2, partagee: false })).status).toBe(201);
    expect((await ecrire("patch", `${W}/taches/${T1}`, { justification: "motif" })).status).toBe(400);
    expect((await ecrire("post", `${W}/taches/${T1}/statut`, { vers: "FINIE" })).status).toBe(400);
  });

  it("recolement : corps, statut, modification", async () => {
    for (const corps of [{}, { objet: "x", conflitId: "zzz" }, { objet: "x", dateRecolement: "2026-13-01" }, { conflitId: C2 }, { objet: "x", extra: true }]) {
      expect((await ecrire("post", `${W}/recolements`, corps)).status, JSON.stringify(corps)).toBe(400);
    }
    for (const corps of [{}, { vers: "FINI" }, { vers: "VALIDE", derogation: 5 }]) expect((await ecrire("post", `${W}/recolements/${R1}/statut`, corps)).status, JSON.stringify(corps)).toBe(400);
    expect((await ecrire("patch", `${W}/recolements/${R1}`, { justification: "motif suffisant" })).status).toBe(400);
    expect(appelsDe("creerRecolement")).toEqual([]);
    expect(appelsDe("changerStatutRecolement")).toEqual([]);
  });

  it("preuve : type, texte, empreinte et taille bornes ; aucun champ de fichier n'est accepte", async () => {
    for (const corps of [{}, { texte: "t" }, { type: "NOTE" }, { type: "PHOTO", texte: "t" }, { type: "NOTE", texte: "" }, { type: "NOTE", texte: "t", sha256: "x".repeat(129) }, { type: "NOTE", texte: "t", tailleOctets: -1 },
      { type: "NOTE", texte: "t", tailleOctets: 1.5 }, { type: "NOTE", texte: "t", tailleOctets: 3_000_000_000 }, { type: "NOTE", texte: "t", contenu: "AAAA" }, { type: "NOTE", texte: "t", fichier: "AAAA" }, { type: "NOTE", texte: "t", reference: "x".repeat(501) }]) {
      expect((await ecrire("post", `${W}/demandes/${D1}/preuves`, corps)).status, JSON.stringify(corps).slice(0, 80)).toBe(400);
    }
    expect(appelsDe("ajouterPreuve")).toEqual([]);
    expect((await ecrire("post", `${W}/demandes/${D1}/preuves`, { type: "COURRIER", texte: "Courrier d'envoi", reference: "N 14/2026", nomFichier: "courrier.pdf", sha256: "a".repeat(64), tailleOctets: 120000, partagee: true })).status).toBe(201);
  });

  it("rattachement : compte, concessionnaire et motif", async () => {
    for (const corps of [{}, { userId: "zzz", concessionnaireId: C1, motif: "motif suffisant" }, { userId: U1, concessionnaireId: "zzz", motif: "motif suffisant" }, { userId: U1, concessionnaireId: C1 }, { userId: U1, concessionnaireId: C1, motif: "m", role: "ADMIN" }]) {
      expect((await ecrire("post", `${W}/referents`, corps, "ADMIN")).status, JSON.stringify(corps)).toBe(400);
    }
    expect(appelsDe("creerRattachement")).toEqual([]);
  });
});

describe("erreurs typees des services rendues telles quelles", () => {
  it("statut, code et champs supplementaires de l'erreur metier ; 429 avec Retry-After", async () => {
    w.echec = new ErreurMetier(409, "SEPARATION_DES_TACHES", "La separation des taches s'applique.");
    const r = await appeler(ROUTES[21], "GEST");
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "La separation des taches s'applique.", code: "SEPARATION_DES_TACHES" });
    w.echec = new ErreurMetier(429, "CADENCE_CREATION", "Trop de creations.", { retryAfterS: 12 });
    const c = await appeler(ROUTES[6], "GEST");
    expect(c.status).toBe(429);
    expect(c.headers["retry-after"]).toBe("12");
    expect(c.body).toMatchObject({ code: "CADENCE_CREATION", retryAfterS: 12 });
    w.echec = new ErreurMetier(404, "DEMANDE_INTROUVABLE", "Demande introuvable");
    expect((await appeler(ROUTES[7], "REF")).body.code).toBe("DEMANDE_INTROUVABLE");
  });
});
