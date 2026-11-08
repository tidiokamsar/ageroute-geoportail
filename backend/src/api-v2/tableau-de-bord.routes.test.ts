import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `/api/v2/tableau-de-bord` et `/api/v2/fiche-360` : ce que ces tests defendent.
 *
 *   - la portee vient du COMPTE : un compte a perimetre regional ne recoit que ses regions, un
 *     indicateur sans ventilation regionale lui est refuse, et aucun parametre ne l'elargit (A10) ;
 *   - le rapprochement calcul / controle est reserve a ADMIN et GESTIONNAIRE ;
 *   - une fiche de troncon hors perimetre repond 404 masque (comme un troncon inconnu) SANS appeler le service ; un troncon inconnu, 404 ;
 *   - les modules sont respectes (tableau de bord, programmation).
 */

const h = vi.hoisted(() => ({
  compte: { id: "u1", role: "GESTIONNAIRE" } as { id: string; role: string },
  national: true,
  regions: [] as number[],
  regionDuTroncon: 3 as number | null,
  modulesRefuses: [] as string[],
  porteesVues: [] as (number[] | null)[],
  appelsFiche: [] as string[],
  tronconExiste: true,
  appelsControle: [] as { regionIds: number[] | null; limite: number }[],
}));

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { ...h.compte }; n();
  },
}));
vi.mock("../middleware/module-access.middleware", () => ({
  requireModuleAccess: (module: string) => (_q: express.Request, res: express.Response, n: express.NextFunction) => {
    if (h.modulesRefuses.includes(module)) { res.status(403).json({ error: "Accès à ce module non autorisé pour votre compte" }); return; }
    n();
  },
}));
vi.mock("../territoire/territoire.service", () => ({
  perimetreDe: async () => (h.national ? { national: true } : { national: false, regions: new Set(h.regions) }),
  regionsFiche: async (_e: string, id: string) => (id === "inconnu" ? [] : [h.regionDuTroncon]),
}));
vi.mock("../lib/prisma", () => ({
  prisma: { region: { findMany: async ({ where }: { where: { id: { in: number[] } } }) => where.id.in.map((id) => ({ id, nom: `Région ${id}` })) } },
}));

vi.mock("../tableau-de-bord/indicateurs.registre", () => {
  const perimetre = { code: "RESEAU_CLASSE_SAISI", libelle: "Réseau classé saisi", definition: "tronçons classés non supprimés (test)" };
  const mk = (code: string, groupe: string, regionalisable: boolean, valeur: (r: number[] | null) => number) => ({
    code, libelle: code, groupe, unite: "nombre", perimetre, regionalisable,
    calcul: async (_d: unknown, p: { regions: number[] | null }) => { h.porteesVues.push(p.regions); return valeur(p.regions); },
    controle: async (_d: unknown, p: { regions: number[] | null }) => valeur(p.regions),
  });
  return {
    REGISTRE: [
      mk("troncons_classes", "reseau", true, (r) => (r === null ? 5 : 2)),
      mk("documents", "reseau", false, () => 7),
      mk("portions_validees", "portions", true, (r) => (r === null ? 8 : 3)),
      mk("evenements_actifs", "veille", true, (r) => (r === null ? 4 : 1)),
    ],
  };
});
vi.mock("../tableau-de-bord/fiche360.service", () => ({
  voletPortions: async (_d: unknown, id: string) => { h.appelsFiche.push(`portions:${id}`); return h.tronconExiste ? { tronconId: id, courantes: [], historique: [] } : null; },
  voletProgrammation: async (_d: unknown, id: string) => { h.appelsFiche.push(`programmation:${id}`); return h.tronconExiste ? { tronconId: id, previsions: [] } : null; },
}));
vi.mock("../tableau-de-bord/historique.service", () => ({
  voletConstats: async (_d: unknown, id: string) => { h.appelsFiche.push(`constats:${id}`); return h.tronconExiste ? { tronconId: id, historique: { total: 0 }, liste: [] } : null; },
  aControler: async (_d: unknown, o: { regionIds: number[] | null; limite: number }) => { h.appelsControle.push(o); return { lignes: [], totalClasses: 0 }; },
}));
// La Control Tower reste le vrai module : elle ne cite que des codes du registre, et ignore ceux que le registre factice n'a pas.
import { tableauDeBordV2Router, fiche360V2Router } from "./tableau-de-bord.routes";

const app = express();
app.use("/tdb", tableauDeBordV2Router);
app.use("/fiche", fiche360V2Router);

beforeEach(() => {
  h.compte = { id: "u1", role: "GESTIONNAIRE" };
  h.national = true; h.regions = []; h.regionDuTroncon = 3; h.modulesRefuses = [];
  h.porteesVues = []; h.appelsFiche = []; h.tronconExiste = true; h.appelsControle = [];
});

describe("GET /tdb/indicateurs", () => {
  it("compte national : tous les indicateurs, valeurs nationales, perimetre joint", async () => {
    const r = await request(app).get("/tdb/indicateurs");
    expect(r.status).toBe(200);
    expect(r.body.portee).toEqual({ national: true, regions: [] });
    const reseau = r.body.indicateurs.filter((i: { groupe: string }) => i.groupe === "reseau");
    expect(reseau.map((i: { code: string; valeur: number }) => [i.code, i.valeur])).toEqual([["troncons_classes", 5], ["documents", 7]]);
    expect(r.body.indicateurs.every((i: { perimetre: { code: string } }) => i.perimetre.code === "RESEAU_CLASSE_SAISI")).toBe(true);
  });

  it("groupes par defaut : reseau, portions, qualite (pas la veille)", async () => {
    const r = await request(app).get("/tdb/indicateurs");
    expect(r.body.indicateurs.map((i: { code: string }) => i.code)).toEqual(["troncons_classes", "documents", "portions_validees"]);
  });

  it("compte regional : valeurs de SES regions seulement, l'indicateur non ventile est refuse, la region est nommee", async () => {
    h.national = false; h.regions = [3];
    const r = await request(app).get("/tdb/indicateurs");
    expect(r.body.portee).toEqual({ national: false, regions: [{ id: 3, nom: "Région 3" }] });
    const par = Object.fromEntries(r.body.indicateurs.map((i: { code: string }) => [i.code, i]));
    expect(par.troncons_classes).toMatchObject({ statut: "CALCULE", valeur: 2 });
    expect(par.documents).toMatchObject({ statut: "INDISPONIBLE", valeur: null });
    expect(par.documents.valeur).not.toBe(7);
    expect(h.porteesVues.every((p) => p !== null && p.join() === "3")).toBe(true);
  });

  it("aucun parametre de requete n'elargit la portee d'un compte regional", async () => {
    h.national = false; h.regions = [3];
    await request(app).get("/tdb/indicateurs?regions=1,2&national=true&regionId=9&groupes=reseau");
    expect(h.porteesVues.length).toBeGreaterThan(0);
    expect(h.porteesVues.every((p) => p !== null && p.join() === "3")).toBe(true);
  });

  it("groupe inconnu : 400", async () => {
    expect((await request(app).get("/tdb/indicateurs?groupes=inconnu")).status).toBe(400);
  });

  it("module « tableau de bord » refuse : 403", async () => {
    h.modulesRefuses = ["dashboard"];
    expect((await request(app).get("/tdb/indicateurs")).status).toBe(403);
  });
});

describe("GET /tdb/control-tower", () => {
  it("rend les modules, leur perimetre, et ce qui n'est pas couvert", async () => {
    const r = await request(app).get("/tdb/control-tower");
    expect(r.status).toBe(200);
    expect(r.body.modules.map((m: { code: string }) => m.code)).toEqual(["veille", "patrouilles", "teledetection", "qualite", "programmation"]);
    const veille = r.body.modules.find((m: { code: string }) => m.code === "veille");
    expect(veille.indicateurs).toHaveLength(1);
    expect(veille.indicateurs[0]).toMatchObject({ code: "evenements_actifs", valeur: 4, perimetre: { code: "RESEAU_CLASSE_SAISI" } });
    expect(r.body.nonCouvert.length).toBeGreaterThan(0);
  });

  it("compte regional : la valeur est celle de sa region", async () => {
    h.national = false; h.regions = [3];
    const r = await request(app).get("/tdb/control-tower");
    expect(r.body.portee.national).toBe(false);
    expect(r.body.modules[0].indicateurs[0].valeur).toBe(1);
  });
});

describe("GET /tdb/controle (A12)", () => {
  it("rapproche chaque indicateur de sa requete de controle", async () => {
    const r = await request(app).get("/tdb/controle");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 4, egaux: 4, ecarts: 0, erreurs: 0 });
    expect(r.body.resultats[0]).toMatchObject({ code: "troncons_classes", statut: "EGAL", calcul: 5, controle: 5 });
  });

  it("reserve a ADMIN et GESTIONNAIRE", async () => {
    h.compte = { id: "u2", role: "LECTEUR" };
    expect((await request(app).get("/tdb/controle")).status).toBe(403);
    h.compte = { id: "u3", role: "ADMIN" };
    expect((await request(app).get("/tdb/controle")).status).toBe(200);
  });

  it("compte regional : les indicateurs non ventiles sont INDISPONIBLES, jamais rapproches en national", async () => {
    h.national = false; h.regions = [3];
    const r = await request(app).get("/tdb/controle");
    expect(r.body.indisponibles).toBe(1);
    expect(r.body.resultats.find((x: { code: string }) => x.code === "documents")).toMatchObject({ statut: "INDISPONIBLE", calcul: null });
  });
});

describe("Fiche 360 : lecture refusee hors perimetre (A10)", () => {
  it("compte national : le volet portions est rendu", async () => {
    const r = await request(app).get("/fiche/troncons/t-1/portions");
    expect(r.status).toBe(200);
    expect(r.body.tronconId).toBe("t-1");
  });

  it("compte regional, troncon d'une AUTRE region : 404 masque (identique a un troncon inconnu) et le service n'est pas appele", async () => {
    // Lot AD-7 : un 403 revelait l'existence du troncon ; la ressource hors perimetre n'existe pas pour ce compte.
    h.national = false; h.regions = [5]; h.regionDuTroncon = 3;
    const r = await request(app).get("/fiche/troncons/t-1/portions");
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("INTROUVABLE");
    expect(h.appelsFiche).toEqual([]);
    expect((await request(app).get("/fiche/troncons/t-1/programmation")).status).toBe(404);
    expect(h.appelsFiche).toEqual([]);
  });

  it("compte regional, troncon de sa region : rendu", async () => {
    h.national = false; h.regions = [3]; h.regionDuTroncon = 3;
    expect((await request(app).get("/fiche/troncons/t-1/portions")).status).toBe(200);
    expect((await request(app).get("/fiche/troncons/t-1/programmation")).status).toBe(200);
  });

  it("compte regional, troncon de region INCONNUE : refuse (on ne deduit pas une localisation d'une absence)", async () => {
    h.national = false; h.regions = [3]; h.regionDuTroncon = null;
    const r = await request(app).get("/fiche/troncons/t-1/portions");
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("INTROUVABLE");
  });

  it("troncon introuvable : 404", async () => {
    h.tronconExiste = false;
    expect((await request(app).get("/fiche/troncons/inconnu/portions")).status).toBe(404);
    expect((await request(app).get("/fiche/troncons/inconnu/programmation")).status).toBe(404);
  });

  it("le volet programmation exige le module « programmation »", async () => {
    h.modulesRefuses = ["programmation"];
    expect((await request(app).get("/fiche/troncons/t-1/programmation")).status).toBe(403);
    expect((await request(app).get("/fiche/troncons/t-1/portions")).status).toBe(200);
  });
});

describe("GET /fiche/troncons/:id/constats et /fiche/a-controler (phase 6)", () => {
  it("le volet constats est rendu pour un troncon du perimetre, et 404 masque hors perimetre sans appeler le service", async () => {
    h.national = false; h.regions = [3]; h.regionDuTroncon = 3;
    expect((await request(app).get("/fiche/troncons/t-1/constats")).status).toBe(200);
    h.appelsFiche = [];
    h.regionDuTroncon = 9;
    expect((await request(app).get("/fiche/troncons/t-1/constats")).status).toBe(404);
    expect(h.appelsFiche).toEqual([]);
  });

  it("troncon introuvable : 404 ; module « inspections » refuse : 403", async () => {
    h.tronconExiste = false;
    expect((await request(app).get("/fiche/troncons/inconnu/constats")).status).toBe(404);
    h.modulesRefuses = ["inspections"];
    expect((await request(app).get("/fiche/troncons/t-1/constats")).status).toBe(403);
    expect((await request(app).get("/fiche/a-controler")).status).toBe(403);
  });

  it("a-controler : compte national, toutes regions par defaut, 50 lignes ; une region demandee la restreint", async () => {
    await request(app).get("/fiche/a-controler");
    await request(app).get("/fiche/a-controler?region=4&limite=10");
    expect(h.appelsControle).toEqual([{ regionIds: null, limite: 50 }, { regionIds: [4], limite: 10 }]);
  });

  it("a-controler : un compte regional est borne a SES regions ; une autre region demandee est refusee (403), jamais elargie", async () => {
    h.national = false; h.regions = [3];
    await request(app).get("/fiche/a-controler");
    expect(h.appelsControle[0]).toEqual({ regionIds: [3], limite: 50 });
    const hors = await request(app).get("/fiche/a-controler?region=9");
    expect(hors.status).toBe(403);
    expect(hors.body.code).toBe("HORS_PERIMETRE");
    expect(h.appelsControle).toHaveLength(1);
    expect((await request(app).get("/fiche/a-controler?region=3")).status).toBe(200);
  });

  it("a-controler : parametres invalides ou inconnus refuses (400)", async () => {
    expect((await request(app).get("/fiche/a-controler?limite=0")).status).toBe(400);
    expect((await request(app).get("/fiche/a-controler?limite=500")).status).toBe(400);
    expect((await request(app).get("/fiche/a-controler?national=true")).status).toBe(400);
    expect(h.appelsControle).toEqual([]);
  });
});
