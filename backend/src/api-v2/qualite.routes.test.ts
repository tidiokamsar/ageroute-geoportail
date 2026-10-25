import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * `/api/v2/qualite/anomalies` — ce que ces tests defendent.
 *
 * LA PORTEE, QUI EST UNE QUESTION DE COUT ET NON DE CONFIDENTIALITE
 *
 * Mesure du 13/10/2026 : le balayage hors-territoire sur 261 387 troncons prend
 * 20 secondes. Dix appels simultanes occuperaient la base de production trois minutes. La
 * portee nationale exige donc un geste explicite et le role ADMIN, et une requete sans
 * portee est refusee plutot que servie au prix fort.
 *
 * LE RAPPORT GARDE LES FAMILLES A ZERO
 *
 * « Zero geometrie invalide » est une information. La masquer laisserait croire que le
 * controle n'a pas tourne, ce qui est la pire lecture possible d'un rapport de qualite.
 *
 * ET IL DIT CE QU'IL NE COUVRE PAS
 *
 * Un rapport qui taira ses propres trous se lit comme exhaustif.
 */

const compte = { id: "u1", role: "GESTIONNAIRE" };

vi.mock("../middleware/auth.middleware", () => ({
  requireAuth: (req: express.Request, _r: express.Response, n: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: compte.id, role: compte.role };
    n();
  },
}));
vi.mock("../middleware/module-access.middleware", () => ({
  requireModuleAccess: () => (_q: express.Request, _s: express.Response, n: express.NextFunction) => n(),
}));
vi.mock("../middleware/rbac.middleware", () => ({
  requireRole: (...roles: string[]) =>
    (req: express.Request, res: express.Response, n: express.NextFunction) => {
      const u = (req as unknown as { user: { role: string } }).user;
      if (!roles.includes(u.role)) return res.status(403).json({ motif: "ROLE_INSUFFISANT" });
      return n();
    },
}));

const h = vi.hoisted(() => ({
  appels: [] as { nom: string; portee: unknown; extra?: unknown }[],
  familles: {} as Record<string, { nombre: number; surTotal: number | null }>,
  parType: {} as Record<string, { entityType: string; nombre: number }[]>,
}));

function detecteur(nom: string, famille: string) {
  return async (portee: unknown, extra?: unknown) => {
    h.appels.push({ nom, portee, extra });
    const f = h.familles[famille] ?? { nombre: 0, surTotal: null };
    return { famille, nombre: f.nombre, surTotal: f.surTotal, exemples: [], ...(h.parType[famille] ? { parTypeEntite: h.parType[famille] } : {}) };
  };
}

vi.mock("../qualite/anomalies.depot", () => ({
  geometriesInvalides: detecteur("geometries", "GEOMETRIE_INVALIDE"),
  doublonsDeGeometrie: detecteur("doublons", "DOUBLON"),
  horsTerritoire: detecteur("territoire", "HORS_TERRITOIRE"),
  actifsSansValidation: detecteur("actifs", "ACTIF_SANS_VALIDATION"),
  donneesSansProvenance: detecteur("provenance", "DONNEE_SANS_PROVENANCE"),
  inspectionsPerimeesEnBase: detecteur("inspections", "INSPECTION_PERIMEE"),
}));

import { qualiteV2Router } from "./qualite.routes";

function app() {
  const a = express();
  a.use("/api/v2/qualite", qualiteV2Router);
  a.use((err: unknown, _q: express.Request, s: express.Response, _n: express.NextFunction) => {
    const nom = err instanceof Error ? err.name : "";
    s.status(nom === "ZodError" ? 400 : 500).json({ erreur: nom });
  });
  return a;
}

beforeEach(() => {
  compte.role = "GESTIONNAIRE";
  h.appels.length = 0;
  h.familles = {};
  h.parType = {};
});

describe("La portee, qui est une question de cout", () => {
  it("REFUSE une requete sans portee, en disant pourquoi", async () => {
    const r = await request(app()).get("/api/v2/qualite/anomalies");
    expect(r.status).toBe(400);
    expect(r.body.motif).toBe("PORTEE_REQUISE");
    expect(r.body.message).toMatch(/vingtaine/);
    expect(h.appels).toHaveLength(0);
  });

  it("accepte une portee regionale", async () => {
    const r = await request(app()).get("/api/v2/qualite/anomalies?regionId=7");
    expect(r.status).toBe(200);
    expect(r.body.portee).toBe("REGION_7");
    expect(h.appels[0].portee).toEqual({ regionId: 7 });
  });

  it("REFUSE le balayage national a un GESTIONNAIRE, pour son cout", async () => {
    const r = await request(app()).get("/api/v2/qualite/anomalies?national=true");
    expect(r.status).toBe(403);
    expect(r.body.motif).toBe("NATIONAL_RESERVE_ADMIN");
    expect(h.appels).toHaveLength(0);
  });

  it("national=false n'est pas un balayage national (une chaine non vide n'est pas un vrai)", async () => {
    compte.role = "ADMIN";
    const r = await request(app()).get("/api/v2/qualite/anomalies?national=false&regionId=7");
    expect(r.status).toBe(200);
    expect(r.body.portee).toBe("REGION_7");
    expect(h.appels[0].portee).toEqual({ regionId: 7 });
  });

  it("l'accepte d'un ADMIN, et passe une portee NULLE aux detecteurs", async () => {
    compte.role = "ADMIN";
    const r = await request(app()).get("/api/v2/qualite/anomalies?national=true");
    expect(r.status).toBe(200);
    expect(r.body.portee).toBe("NATIONALE");
    expect(h.appels[0].portee).toEqual({ regionId: null });
  });

  it("REFUSE un LECTEUR, meme sur une region", async () => {
    // Un rapport qui nomme des corrections a arbitrer n'aide pas un agent, et lui donnerait
    // l'impression qu'il doit y repondre.
    compte.role = "LECTEUR";
    const r = await request(app()).get("/api/v2/qualite/anomalies?regionId=7");
    expect(r.status).toBe(403);
  });
});

describe("Le seuil de fraicheur est un parametre", () => {
  it("vaut 365 jours par defaut, et le dit dans la reponse", async () => {
    const r = await request(app()).get("/api/v2/qualite/anomalies?regionId=7");
    expect(r.body.fraicheurInspectionJours).toBe(365);
  });

  it("se laisse changer, et la valeur arrive au detecteur", async () => {
    // Le cahier ne dit pas a partir de quand une inspection est trop ancienne : le figer
    // en ferait la norme d'AGEROUTE par defaut.
    const r = await request(app()).get("/api/v2/qualite/anomalies?regionId=7&fraicheurInspectionJours=1095");
    expect(r.body.fraicheurInspectionJours).toBe(1095);
    expect(h.appels.find((a) => a.nom === "inspections")?.extra).toBe(1095);
  });

  it("REFUSE un seuil absurde", async () => {
    const r = await request(app()).get("/api/v2/qualite/anomalies?regionId=7&fraicheurInspectionJours=0");
    expect(r.status).toBe(400);
  });
});

describe("Ce que le rapport rend", () => {
  it("GARDE les familles a zero", async () => {
    // « Zero geometrie invalide » est une information. La masquer laisserait croire que le
    // controle n'a pas tourne.
    const r = await request(app()).get("/api/v2/qualite/anomalies?regionId=7");
    expect(r.body.familles).toHaveLength(6);
    expect(r.body.familles.every((f: { nombre: number }) => f.nombre === 0)).toBe(true);
  });

  it("expose la ventilation par type d'entite quand la famille couvre plusieurs tables, et seulement alors", async () => {
    h.familles = { GEOMETRIE_INVALIDE: { nombre: 5, surTotal: null } };
    h.parType = { GEOMETRIE_INVALIDE: [{ entityType: "Troncon", nombre: 2 }, { entityType: "LimiteAdmin", nombre: 3 }] };
    const r = await request(app()).get("/api/v2/qualite/anomalies?regionId=7");
    const geo = r.body.familles.find((f: { famille: string }) => f.famille === "GEOMETRIE_INVALIDE");
    expect(geo.parTypeEntite).toEqual([{ entityType: "Troncon", nombre: 2 }, { entityType: "LimiteAdmin", nombre: 3 }]);
    const autre = r.body.familles.find((f: { famille: string }) => f.famille === "DOUBLON");
    expect(autre).not.toHaveProperty("parTypeEntite");
  });

  it("met les BLOQUANTES en tete, quel que soit leur nombre", async () => {
    // Trois geometries invalides passent avant 200 000 champs sans provenance : les
    // premieres cassent des requetes, les seconds empechent seulement de conclure.
    h.familles = {
      DONNEE_SANS_PROVENANCE: { nombre: 200_000, surTotal: 261_387 },
      GEOMETRIE_INVALIDE: { nombre: 3, surTotal: null },
    };
    const r = await request(app()).get("/api/v2/qualite/anomalies?regionId=7");
    expect(r.body.familles[0].gravite).toBe("BLOQUANTE");
  });

  it("calcule une part quand la population est connue, et NULLE sinon", async () => {
    h.familles = {
      ACTIF_SANS_VALIDATION: { nombre: 1_172, surTotal: 1_172 },
      DOUBLON: { nombre: 42, surTotal: null },
    };
    const r = await request(app()).get("/api/v2/qualite/anomalies?regionId=7");
    const parFamille = Object.fromEntries(
      r.body.familles.map((f: { famille: string; part: number | null }) => [f.famille, f.part]),
    );
    expect(parFamille.ACTIF_SANS_VALIDATION).toBe(1);
    expect(parFamille.DOUBLON).toBeNull();
  });

  it("porte une correction proposee sur chaque famille, et aucune ne dit de supprimer", async () => {
    const r = await request(app()).get("/api/v2/qualite/anomalies?regionId=7");
    for (const f of r.body.familles as { correctionProposee: string }[]) {
      expect(f.correctionProposee).toBeTruthy();
      expect(f.correctionProposee.toLowerCase()).not.toMatch(/^supprimer/);
    }
  });

  it("DIT CE QU'IL NE COUVRE PAS", async () => {
    // Un rapport qui taira ses propres trous se lit comme exhaustif.
    const r = await request(app()).get("/api/v2/qualite/anomalies?regionId=7");
    expect(r.body.nonCouvert).toHaveLength(4);
    expect(r.body.nonCouvert.join(" ")).toMatch(/limites administratives, les emprises de teledetection/);
    expect(r.body.nonCouvert.join(" ")).toMatch(/precision de la couche de limites/);
    expect(r.body.nonCouvert.join(" ")).toMatch(/egalite BINAIRE/);
  });

  it("plafonne a trois exemples par famille", async () => {
    const r = await request(app()).get("/api/v2/qualite/anomalies?regionId=7");
    for (const f of r.body.familles as { exemples: unknown[] }[]) {
      expect(f.exemples.length).toBeLessThanOrEqual(3);
    }
  });
});
