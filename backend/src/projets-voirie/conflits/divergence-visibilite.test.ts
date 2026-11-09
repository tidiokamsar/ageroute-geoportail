/**
 * Correctifs T1+S1, B1 : un dossier DIVERGENCE_SOURCES ne revele rien d'un jeu B non lisible pour le compte (lecteur : B non AUTORISE ; tous :
 * B RETIRE). Le statut de B entre dans la visibilite du dossier (`statutsLies`), dans les filtres de liste, de compteurs et d'export, et dans la
 * trace de consultation. Base simulee : seules les lectures utiles a la fiche, a la liste et a l'export repondent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { w } = vi.hoisted(() => ({
  w: {
    conflit: null as Record<string, unknown> | null,
    traces: [] as { entite: string; jeuId: string }[],
    wheres: [] as unknown[],
  },
}));

vi.mock("../../lib/prisma", () => {
  const vide = new Proxy({}, { get: () => async () => [] });
  const tx = {
    auditLog: { create: async (a: { data: { entityType: string; entityId: string } }) => { w.traces.push({ entite: a.data.entityType, jeuId: a.data.entityId }); return {}; } },
    $executeRaw: async () => 0, $queryRaw: async () => [{ n: 0, ok: 1 }], conflitProjet: { findMany: async (a: { where: unknown }) => { w.wheres.push(a.where); return w.conflit ? [{ ...w.conflit, premiereAnalyse: null, derniereAnalyse: null, _count: { preuves: 0, decisions: 0 } }] : []; } },
  };
  const prisma: Record<string, unknown> = {
    projetVoirie: { findFirst: async () => ({ id: "p1", code: "P-1" }) },
    conflitProjet: {
      findFirst: async () => w.conflit,
      findMany: async (a: { where: unknown }) => { w.wheres.push(a.where); return w.conflit ? [w.conflit] : []; },
      groupBy: async () => [], count: async () => (w.conflit ? 1 : 0),
    },
    conflitHistorique: {
      findMany: async () => [{ id: "h1", action: "CREATION", ancienStatut: null, nouveauStatut: "A_INVESTIGUER", justification: "ouverture", acteur: null, analyseId: null, analyse: null, createdAt: new Date(),
        donnees: { type: "DIVERGENCE_SOURCES", mesure: { jeuBId: "jb", objetBId: "77", nomB: "Cable B secret", divergence: { hausdorffM: 6 } } } }],
      findFirst: async () => null,
    },
    conflitPreuve: { findMany: async () => [] },
    decisionConflit: { findMany: async () => [] },
    analyseConflitProjet: { findUnique: async () => null },
    jeuDonneesProjet: { findMany: async () => [] },
    $queryRaw: async () => [{ g: '{"type":"LineString","coordinates":[[0,0],[1,1]]}', w: 0, s: 0, e: 1, n: 1 }],
    $transaction: async (f: (t: typeof tx) => unknown) => f(tx),
  };
  return { prisma: new Proxy(prisma, { get: (t, k: string) => (k in t ? t[k] : vide) }) };
});
vi.mock("../reseaux/cibles.service", () => ({ cibleDesObjets: async () => new Map(), tracePartageeDe: async () => 0 }));

import { exporterConflitsCsv, ficheConflit, filtreConflits, listerConflits, statutsLies, vueConflit } from "./dossiers.service";

const lecteur = { id: "u-l", role: "LECTEUR" };
const chef = { id: "u-g", role: "GESTIONNAIRE" };
const admin = { id: "u-a", role: "ADMIN" };

function dossier(statutA: string, statutB: string) {
  return {
    id: "k1", projetId: "p1", cle: "c", type: "DIVERGENCE_SOURCES", axe: "Divergence de sources", statut: "A_INVESTIGUER", risque: null, aReexaminer: false, motifReexamen: null,
    responsable: null, echeance: null, actionProposee: null, classePrecision: "B", verticalEvalue: false, concessionnaire: { id: "c1", nom: "Operateur synthetique" },
    jeuReseauId: "ja", jeuReseau: { id: "ja", statut: statutA, typeReseau: "TELECOM", confidentialite: "CONFIDENTIEL_CONCESSIONNAIRE", version: 1 }, jeuAxesId: null, jeuAxes: null,
    jeuSourceBId: "jb", jeuSourceB: { id: "jb", statut: statutB, confidentialite: "CONFIDENTIEL_CONCESSIONNAIRE" },
    objetId: 5n, objet: { id: 5n, nom: "Cable A" }, mesure: { distanceMinM: 1, jeuBId: "jb", objetBId: "77", nomB: "Cable B secret", divergence: { hausdorffM: 6, longueurHorsCorridorM: 40 } },
    premiereAnalyseId: null, derniereAnalyseId: null, comparaisonId: "cmp1", tronconsProches: [], createdAt: new Date(), updatedAt: new Date(),
  };
}

beforeEach(() => { w.conflit = null; w.traces = []; w.wheres = []; });

describe("B1 : le statut du jeu B entre dans la lisibilite d'un dossier DIVERGENCE_SOURCES", () => {
  it("statutsLies porte le statut du jeu B", () => {
    expect(statutsLies(dossier("AUTORISE", "CONTROLE") as never)).toEqual(["AUTORISE", "CONTROLE"]);
  });

  it("vue : B en CONTROLE, un decideur lit la mesure ; B RETIRE, personne ne lit nomB, objetBId, jeuBId ni les mesures", () => {
    expect(vueConflit(dossier("AUTORISE", "CONTROLE") as never, "GESTIONNAIRE").mesure).not.toBeNull();
    for (const role of ["ADMIN", "GESTIONNAIRE", "LECTEUR"]) {
      const v = vueConflit(dossier("AUTORISE", "RETIRE") as never, role);
      expect(v.mesure, role).toBeNull();
      expect(JSON.stringify(v), role).not.toMatch(/Cable B secret|"77"|hausdorff/);
    }
  });

  it("liste, compteurs et export d'un lecteur : le filtre exige un jeu B AUTORISE ; les filtres de contenu ignorent un jeu B RETIRE", () => {
    expect(JSON.stringify(filtreConflits("p1", {}, "LECTEUR"))).toContain('"jeuSourceB":{"is":{"statut":"AUTORISE"}}');
    expect(JSON.stringify(filtreConflits("p1", { q: "Cable" }, "ADMIN"))).toContain('"jeuSourceB":{"is":{"statut":{"not":"RETIRE"}}}');
  });

  it("fiche d'un lecteur : B en CONTROLE (version candidate) : 404 identique a l'inexistant", async () => {
    w.conflit = dossier("AUTORISE", "CONTROLE");
    await expect(ficheConflit(lecteur, "p1", "k1")).rejects.toMatchObject({ status: 404, code: "CONFLIT_INTROUVABLE" });
  });

  it("fiche d'un ADMIN : B RETIRE : dossier visible (archive), mais ni geometrie, ni mesure, ni historique calcule, ni trace", async () => {
    w.conflit = dossier("AUTORISE", "RETIRE");
    const f = await ficheConflit(admin, "p1", "k1");
    expect(f.conflit.mesure).toBeNull();
    expect(f.conflit.geometrie).toBeNull();
    expect(f.historique[0].donnees).toEqual({ masquees: true });
    expect(JSON.stringify(f)).not.toMatch(/Cable B secret|"jb"|"77"/);
    expect(w.traces.filter((t) => t.entite === "ConsultationJeuProjet")).toHaveLength(0);
  });

  it("fiche d'un decideur : A et B lisibles : la consultation des DEUX jeux sensibles est tracee", async () => {
    w.conflit = dossier("AUTORISE", "CONTROLE");
    await ficheConflit(chef, "p1", "k1");
    expect(w.traces.filter((t) => t.entite === "ConsultationJeuProjet").map((t) => t.jeuId).sort()).toEqual(["ja", "jb"]);
  });

  it("liste d'un decideur : la trace couvre aussi le jeu B", async () => {
    w.conflit = dossier("AUTORISE", "AUTORISE");
    await listerConflits(chef, "p1", {}, 25);
    expect(w.traces.filter((t) => t.entite === "ConsultationJeuProjet").map((t) => t.jeuId).sort()).toEqual(["ja", "jb"]);
  });

  it("export d'un ADMIN : B RETIRE : aucune mesure ni concessionnaire dans la ligne", async () => {
    w.conflit = dossier("AUTORISE", "RETIRE");
    const { csv } = await exporterConflitsCsv(admin, "p1", {});
    const ligne = csv.split("\r\n")[1];
    expect(ligne).not.toContain("Operateur synthetique");
    expect(ligne.split(";")[12]).toBe("");
  });
});
