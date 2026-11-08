import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Lectures des analyses persistees : forme des requetes envoyees a la base (revue RC-3, M2) et filtre des jeux selon le compte (M1).
 * La base est simulee : ce qui est prouve ici, c'est CE QUE LE SERVICE DEMANDE (colonnes lues, projet verifie) et CE QU'IL RENDRA ;
 * le SQL reel est prouve par le banc `tests-integration/conflits-projets-voirie.integration.mts`.
 */
vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://127.0.0.1:1/essai";
  process.env.JWT_ACCESS_SECRET = "essai-access-secret-essai-access-secret-0000";
  process.env.JWT_REFRESH_SECRET = "essai-refresh-secret-essai-refresh-secret-000";
});

const { base } = vi.hoisted(() => ({
  base: {
    projetExiste: true,
    appels: [] as { nom: string; arg: unknown }[],
    analyses: [] as Record<string, unknown>[],
    jeux: [] as { id: string; statut: string }[],
  },
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    projetVoirie: { findFirst: async (arg: unknown) => { base.appels.push({ nom: "projet", arg }); return base.projetExiste ? { id: "p1" } : null; } },
    analyseConflitProjet: {
      findMany: async (arg: unknown) => { base.appels.push({ nom: "analyses", arg }); return base.analyses; },
      findFirst: async (arg: unknown) => { base.appels.push({ nom: "analyse", arg }); return base.analyses[0] ?? null; },
    },
    jeuDonneesProjet: { findMany: async (arg: unknown) => { base.appels.push({ nom: "jeux", arg }); return base.jeux; } },
    conflitProjet: { findMany: async () => [] },
    regleConflit: { findMany: async (arg: unknown) => { base.appels.push({ nom: "regles", arg }); return []; } },
  },
}));

import { detailAnalyse, listerAnalyses, listerRegles } from "./regles-analyses.service";
import { SELECT_ANALYSE, vueAnalyse } from "./analyse-conflits.service";

const analyse = (numero: number, jeux: { jeuId: string }[], resume: unknown) => ({
  id: `a${numero}`, projetId: "p1", numero, statut: "TERMINEE", largeurEmpriseM: 15, largeurChausseeM: 7, regles: [], jeux, versionAlgorithme: "RC3-2D-UTM-1", resume,
  declencheParId: "u1", duree: 12, createdAt: new Date("2026-11-06T10:00:00.000Z"), declenchePar: { id: "u1", nomComplet: "Sekou" },
});
const LECTEUR = { id: "u-l", role: "LECTEUR" };
const CHEF = { id: "u-c", role: "GESTIONNAIRE" };

beforeEach(() => {
  base.projetExiste = true; base.appels = []; base.jeux = [];
  base.analyses = [analyse(2, [{ jeuId: "j-axes" }, { jeuId: "j-r1" }, { jeuId: "j-r2" }], { totaux: { conflitsTrouves: 14 } }), analyse(1, [{ jeuId: "j-axes" }], { totaux: { conflitsTrouves: 3 } })];
  base.jeux = [{ id: "j-axes", statut: "AUTORISE" }, { id: "j-r1", statut: "REMPLACE" }, { id: "j-r2", statut: "RETIRE" }];
});

describe("M2 : l'instantane n'est jamais lu pour la liste ni pour le detail", () => {
  it("SELECT_ANALYSE nomme toutes les colonnes rendues sauf `instantane`", () => {
    expect(Object.keys(SELECT_ANALYSE)).not.toContain("instantane");
    expect(Object.keys(SELECT_ANALYSE)).toEqual(expect.arrayContaining(["id", "projetId", "numero", "statut", "regles", "jeux", "resume", "declenchePar"]));
  });

  it("listerAnalyses lit les analyses avec un `select` sans instantane (et sans `include`, qui lirait toutes les colonnes)", async () => {
    await listerAnalyses(LECTEUR, "p1", 100);
    const q = base.appels.find((a) => a.nom === "analyses")!.arg as { select?: Record<string, unknown>; include?: unknown };
    expect(q.include).toBeUndefined();
    expect(q.select).toBeDefined();
    expect(q.select).not.toHaveProperty("instantane");
  });

  it("detailAnalyse : meme `select`", async () => {
    await detailAnalyse(LECTEUR, "p1", "a2");
    const q = base.appels.find((a) => a.nom === "analyse")!.arg as { select?: Record<string, unknown>; include?: unknown };
    expect(q.include).toBeUndefined();
    expect(q.select).not.toHaveProperty("instantane");
  });

  it("le nombre de conflits vient du resume (zero pour une analyse en echec, sans totaux)", async () => {
    const r = await listerAnalyses(CHEF, "p1", 100);
    expect(r.analyses.map((a) => a.nbConflitsTrouves)).toEqual([14, 3]);
    base.analyses = [{ ...analyse(3, [], { statut: "ECHEC", erreur: { code: "ANALYSE_TROP_LONGUE" } }), statut: "ECHEC" }];
    expect((await listerAnalyses(CHEF, "p1", 100)).analyses[0].nbConflitsTrouves).toBe(0);
  });

  it("vueAnalyse ne depend pas de l'instantane : une ligne qui n'en porte pas est rendue normalement", () => {
    const v = vueAnalyse(analyse(1, [], { totaux: { conflitsTrouves: 7 } }) as never);
    expect(v.nbConflitsTrouves).toBe(7);
    expect(JSON.stringify(v)).not.toContain("instantane");
  });
});

describe("M1 : les jeux d'une analyse sont filtres selon le statut courant et le compte", () => {
  const ids = (r: { jeux: unknown }) => (r.jeux as { jeuId: string }[]).map((j) => j.jeuId);

  it("un LECTEUR ne recoit que les jeux AUTORISES ; un GESTIONNAIRE tous sauf les RETIRES", async () => {
    expect(ids((await listerAnalyses(LECTEUR, "p1", 100)).analyses[0])).toEqual(["j-axes"]);
    expect(ids((await listerAnalyses(CHEF, "p1", 100)).analyses[0])).toEqual(["j-axes", "j-r1"]);
    expect(ids((await detailAnalyse(LECTEUR, "p1", "a2")).analyse)).toEqual(["j-axes"]);
    expect(ids((await detailAnalyse(CHEF, "p1", "a2")).analyse)).toEqual(["j-axes", "j-r1"]);
  });

  it("un jeu inconnu de la base n'est pas rendu ; une seule lecture des statuts pour toute la page", async () => {
    base.jeux = [{ id: "j-axes", statut: "AUTORISE" }];
    expect(ids((await listerAnalyses(CHEF, "p1", 100)).analyses[0])).toEqual(["j-axes"]);
    expect(base.appels.filter((a) => a.nom === "jeux")).toHaveLength(1);
  });
});

describe("m1 : un projet retire ou inconnu repond 404 PROJET_INTROUVABLE, meme a un compte national", () => {
  it("regles, liste et detail des analyses : erreur typee avant toute lecture des donnees", async () => {
    base.projetExiste = false;
    for (const appel of [() => listerRegles("p1"), () => listerAnalyses(CHEF, "p1", 100), () => detailAnalyse(CHEF, "p1", "a2")]) {
      await expect(appel()).rejects.toMatchObject({ status: 404, code: "PROJET_INTROUVABLE" });
    }
    expect(base.appels.map((a) => a.nom).filter((n) => n !== "projet")).toEqual([]);
  });

  it("le projet est cherche avec `deletedAt: null`", async () => {
    await listerAnalyses(CHEF, "p1", 100);
    expect(base.appels.find((a) => a.nom === "projet")!.arg).toMatchObject({ where: { id: "p1", deletedAt: null } });
  });
});
