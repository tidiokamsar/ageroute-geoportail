import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Qualite des donnees : droits d'acces et honnetete de la reponse.
 *
 * Les tests de droits ne sont pas decoratifs. En phase 3, trois failles ont ete
 * trouvees sur des routes de lecture parce que le droit y avait ete reimplemente au
 * lieu d'etre repris. Cette route rejoue donc le meme controle que les routes metier,
 * via MODULE_PAR_ENTITE, et ces tests le verifient.
 */

const compte = { id: "u1", role: "GESTIONNAIRE" as string, modules: [] as string[] };

vi.mock("../../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: compte.id, role: compte.role };
    next();
  },
}));

vi.mock("../../middleware/module-access.middleware", () => ({
  requireModuleAccess: (cle: string) => (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (compte.role === "ADMIN" || compte.modules.length === 0 || compte.modules.includes(cle)) return next();
    return res.status(403).json({ message: "Accès refusé" });
  },
}));

/**
 * Resultats bruts servis a `$queryRaw`, dans l'ordre des appels.
 *
 * L'endpoint « referentiel-administratif » emet deux requetes en parallele
 * (`Promise.all`) : la liste des regions, puis le decompte par niveau. La file les
 * rend dans cet ordre.
 */
const lignesBrutes: unknown[][] = [];

vi.mock("../../lib/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(async () => lignesBrutes.shift() ?? []),
  },
}));

const lignesQualite: Record<string, unknown>[] = [];

vi.mock("../../lib/qualite", async (importOriginal) => {
  const reel = await importOriginal<typeof import("../../lib/qualite")>();
  return {
    ...reel,
    chargerQualite: vi.fn(async (entityType: string, ids: string[]) => {
      const m = new Map<string, unknown>();
      for (const l of lignesQualite) {
        if (l.entityType === entityType && ids.includes(l.entityId as string)) {
          m.set(`${l.entityId}:${l.champ}`, l);
        }
      }
      return m;
    }),
    repartitionQualite: vi.fn(async () => [
      { champ: "revetement", total: 1690, parStatut: { IMPORTED_UNVERIFIED: 1690 }, datees: 0 },
      { champ: "etat", total: 1690, parStatut: { UNKNOWN: 1043, IMPORTED_UNVERIFIED: 647 }, datees: 0 },
    ]),
  };
});

vi.mock("../../lib/access", async (importOriginal) => {
  const reel = await importOriginal<typeof import("../../lib/access")>();
  return {
    ...reel,
    modulesAutorisesDe: vi.fn(async () =>
      compte.role === "ADMIN" || compte.modules.length === 0 ? null : new Set(compte.modules)
    ),
  };
});

import { qualiteRouter } from "./qualite.routes";

function app() {
  const a = express();
  a.use("/api/qualite", qualiteRouter);
  return a;
}

beforeEach(() => {
  compte.role = "GESTIONNAIRE";
  compte.modules = [];
  lignesQualite.length = 0;
});

describe("GET /api/qualite/repartition", () => {
  it("rend la répartition des statuts par champ", async () => {
    const r = await request(app()).get("/api/qualite/repartition");
    expect(r.status).toBe(200);
    expect(r.body.champs).toHaveLength(2);
    expect(r.body.champs[0].parStatut.IMPORTED_UNVERIFIED).toBe(1690);
  });

  it("expose la fraîcheur séparément, sans la noyer dans une moyenne", async () => {
    const r = await request(app()).get("/api/qualite/repartition");
    // C'est la dimension la plus degradee : 0 valeur datee sur 3 380.
    expect(r.body.fraicheur).toEqual({ datees: 0, total: 3380, pct: 0 });
  });

  it("refuse un type d'entité inconnu plutôt que de rendre un tableau vide", async () => {
    // Un tableau vide laisserait croire qu'il n'y a rien a signaler.
    const r = await request(app()).get("/api/qualite/repartition?entityType=Inexistant");
    expect(r.status).toBe(400);
  });

  it("refuse l'accès à qui n'a pas le module tableau de bord", async () => {
    compte.modules = ["troncons"];
    const r = await request(app()).get("/api/qualite/repartition");
    expect(r.status).toBe(403);
  });
});

describe("GET /api/qualite/:entityType/:entityId", () => {
  it("rend les six champs de décision, même sans aucune ligne de qualité", async () => {
    // Une absence doit se voir, pas disparaitre du tableau.
    const r = await request(app()).get("/api/qualite/Troncon/t1");
    expect(r.status).toBe(200);
    expect(r.body.champs).toHaveLength(6);
    for (const c of r.body.champs) {
      expect(c.statut).toBeNull();
      expect(c.douteuse).toBe(true);
      expect(c.libelle).toMatch(/non renseignée/i);
    }
  });

  it("dit « importé — non vérifié » sur le revêtement", async () => {
    lignesQualite.push({
      entityType: "Troncon", entityId: "t1", champ: "revetement",
      statut: "IMPORTED_UNVERIFIED", source: "IMPORT_INITIAL", methode: "IMPORT",
      observedAt: null, observedById: null, confiance: "LOW",
      note: "Valeur unique sur les 1 690 troncons.",
    });
    const r = await request(app()).get("/api/qualite/Troncon/t1");
    const rev = r.body.champs.find((c: { champ: string }) => c.champ === "revetement");

    expect(rev.libelle).toBe("Importé — non vérifié");
    expect(rev.douteuse).toBe(true);
    expect(rev.note).toMatch(/1 690/);
  });

  it("signale un constat non daté comme non daté", async () => {
    lignesQualite.push({
      entityType: "Troncon", entityId: "t1", champ: "etat",
      statut: "OBSERVED", source: "INSPECTION_TERRAIN", methode: "RELEVE_TERRAIN",
      observedAt: null, observedById: "u9", confiance: "HIGH", note: null,
    });
    const r = await request(app()).get("/api/qualite/Troncon/t1");
    const etat = r.body.champs.find((c: { champ: string }) => c.champ === "etat");

    expect(etat.datee).toBe(false);
    expect(etat.libelle).toMatch(/date inconnue/);
  });

  it("ne tient pour non douteuse qu'une valeur constatée", async () => {
    lignesQualite.push({
      entityType: "Troncon", entityId: "t1", champ: "etat",
      statut: "OBSERVED", source: "INSPECTION_TERRAIN", methode: "RELEVE_TERRAIN",
      observedAt: new Date("2026-08-15"), observedById: "u9", confiance: "HIGH", note: null,
    });
    const r = await request(app()).get("/api/qualite/Troncon/t1");
    const etat = r.body.champs.find((c: { champ: string }) => c.champ === "etat");

    expect(etat.douteuse).toBe(false);
    expect(etat.datee).toBe(true);
    expect(etat.libelle).toBe("Constaté");
  });

  it("applique le droit du module de l'entité", async () => {
    compte.modules = ["chantiers"];
    expect((await request(app()).get("/api/qualite/Troncon/t1")).status).toBe(403);
    expect((await request(app()).get("/api/qualite/Chantier/c1")).status).toBe(200);
  });

  it("réserve à ADMIN les entités sans module", async () => {
    // User et AppSetting n'ont pas de module : personne d'autre qu'un ADMIN.
    compte.role = "GESTIONNAIRE";
    expect((await request(app()).get("/api/qualite/User/u1")).status).toBe(403);

    compte.role = "ADMIN";
    expect((await request(app()).get("/api/qualite/User/u1")).status).toBe(200);
  });

  it("se ferme sur un type d'entité inconnu", async () => {
    const r = await request(app()).get("/api/qualite/Inexistant/x1");
    expect(r.status).toBe(400);
  });

  it("laisse passer un ADMIN sur toute entité", async () => {
    compte.role = "ADMIN";
    compte.modules = ["chantiers"];
    expect((await request(app()).get("/api/qualite/Troncon/t1")).status).toBe(200);
  });
});

/**
 * Ecart entre le referentiel des regions et les limites chargees.
 *
 * Le decret du 05/09/2026 a rendu ce cas concret : Siguiri et Beyla figurent parmi
 * les regions, aucune limite ne les couvre. Rien a l'ecran ne le signalait, et une
 * dette invisible est une dette oubliee.
 */
describe("GET /api/qualite/referentiel-administratif", () => {
  it("signale les régions dépourvues de limite", async () => {
    lignesBrutes.length = 0;
    lignesBrutes.push(
      [
        { nom: "Kankan", aUneLimite: true, objets: 50n },
        { nom: "Siguiri", aUneLimite: false, objets: 0n },
        { nom: "Beyla", aUneLimite: false, objets: 0n },
      ],
      [{ niveau: 1, entites: 8n }, { niveau: 2, entites: 34n }],
    );

    const res = await request(app()).get("/api/qualite/referentiel-administratif");

    expect(res.status).toBe(200);
    expect(res.body.ecart.regionsSansLimite).toEqual(["Siguiri", "Beyla"]);
    // Aucun objet rattache : l'ecart existe mais n'empeche rien aujourd'hui.
    expect(res.body.ecart.objetsConcernes).toBe(0);
    expect(res.body.ecart.resolution).toMatch(/ne se déduisent pas/);
  });

  it("mesure l'urgence par le nombre d'objets concernés", async () => {
    // Une region sans limite mais vide n'empeche rien ; la meme portant des chantiers
    // les retire de la carte. Le compteur separe les deux situations.
    lignesBrutes.length = 0;
    lignesBrutes.push(
      [{ nom: "Siguiri", aUneLimite: false, objets: 17n }],
      [{ niveau: 1, entites: 8n }],
    );

    const res = await request(app()).get("/api/qualite/referentiel-administratif");
    expect(res.body.ecart.objetsConcernes).toBe(17);
  });

  it("ne signale rien quand chaque région a sa limite", async () => {
    lignesBrutes.length = 0;
    lignesBrutes.push(
      [{ nom: "Kankan", aUneLimite: true, objets: 50n }],
      [{ niveau: 1, entites: 8n }],
    );

    const res = await request(app()).get("/api/qualite/referentiel-administratif");
    expect(res.body.ecart.regionsSansLimite).toEqual([]);
    expect(res.body.ecart.resolution).toBeNull();
  });

  it("convertit les BigInt de PostgreSQL", async () => {
    // count(*) revient en bigint ; JSON.stringify le refuse et la reponse partirait
    // en 500. Le meme piege a deja fait afficher « 0 chantier » pour 166.
    lignesBrutes.length = 0;
    lignesBrutes.push(
      [{ nom: "Siguiri", aUneLimite: false, objets: 3n }],
      [{ niveau: 1, entites: 8n }],
    );

    const res = await request(app()).get("/api/qualite/referentiel-administratif");
    expect(res.status).toBe(200);
    expect(res.body.regions[0].objetsRattaches).toBe(3);
    expect(res.body.limites[0].entites).toBe(8);
  });
});
