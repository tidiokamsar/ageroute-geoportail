import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Le badge global compte AUSSI une session de roulage arretee et non confirmee.
 *
 * Constate par audit : `refreshPendingCount` ne regardait que les quatre files (inspections, defauts, portions,
 * observations). Une session de roulage n'a pas de file, elle vit dans son journal : page fermee, rien n'indiquait qu'un releve
 * attendait sur le telephone. Ces tests defendent le compte, pas l'envoi (la synchronisation ne pousse pas cette session) :
 *   - arretee, de CE compte, avec au moins deux positions, non confirmee : elle compte (une fois, jamais « conflit » ni « abandonnee ») ;
 *   - confirmee par le serveur, en cours, vide, ou d'un AUTRE compte : elle ne compte pas ;
 *   - un journal illisible ne casse pas le compte des autres files.
 */

type Entree = Record<string, unknown>;
const journal: { entrees: Entree[]; nature: "indexeddb" | "memoire"; lectureEchoue: boolean } = { entrees: [], nature: "indexeddb", lectureEchoue: false };

vi.mock("./api", () => ({ api: { post: vi.fn(async () => ({ data: {} })) } }));
vi.mock("./offlineDb", () => ({
  getAllPending: vi.fn(async () => []),
  getAllPendingDefauts: vi.fn(async () => [{ localId: "d1", ownerUserId: "u1", status: "pending" }]),
  getAllPendingPortions: vi.fn(async () => []),
  getAllPendingObservations: vi.fn(async () => []),
  updatePendingInspection: vi.fn(), removePendingInspection: vi.fn(),
  updatePendingDefaut: vi.fn(), removePendingDefaut: vi.fn(),
  updatePendingPortion: vi.fn(), removePendingPortion: vi.fn(),
  updatePendingObservation: vi.fn(), removePendingObservation: vi.fn(),
}));
vi.mock("./roulageHote", () => ({
  ouvrirStockage: () => ({
    get nature() { return journal.nature; },
    ajouter: () => undefined,
    vider: async () => undefined,
    echecs: () => 0,
    toutes: async () => {
      if (journal.lectureEchoue) throw new Error("journal illisible");
      return journal.entrees;
    },
  }),
}));

import { configurerUtilisateurSync, getSyncState, refreshPendingCount } from "./offlineSync";
import { noterEnvoiConfirme } from "./releveVue";

function session(options: { agent?: string | null; sessionId?: string; positions?: number; arretee?: boolean } = {}): Entree[] {
  const { agent = "u1", sessionId = "sess-1", positions = 3, arretee = true } = options;
  const entrees: Entree[] = [
    { seq: 1, type: "DEMARRAGE", tMs: 1, sessionId, parametres: {}, agentRef: agent, versionJournal: 1 },
    ...Array.from({ length: positions }, (_, i) => ({ seq: 2 + i, type: "ECHANTILLON", echantillon: { tMs: 1000 * (i + 1) } })),
  ];
  if (arretee) entrees.push({ seq: 2 + positions, type: "ARRET", tMs: 9000 });
  return entrees;
}

beforeEach(() => {
  journal.entrees = [];
  journal.nature = "indexeddb";
  journal.lectureEchoue = false;
  localStorage.clear();
  configurerUtilisateurSync("u1");
});

describe("badge global : session de roulage arretee et non confirmee", () => {
  it("elle compte avec les autres saisies, une seule fois, et n'est ni en conflit ni abandonnee", async () => {
    journal.entrees = session();
    await refreshPendingCount();
    // 1 defaut en file + 1 session de roulage.
    expect(getSyncState()).toMatchObject({ pendingCount: 2, conflitCount: 0, abandonCount: 0 });
  });

  it("sans session de roulage, le compte des files est inchange", async () => {
    await refreshPendingCount();
    expect(getSyncState().pendingCount).toBe(1);
  });

  it("une session CONFIRMEE par le serveur ne compte plus", async () => {
    journal.entrees = session({ sessionId: "sess-ok" });
    noterEnvoiConfirme("sess-ok");
    await refreshPendingCount();
    expect(getSyncState().pendingCount).toBe(1);
  });

  it("une session encore EN COURS (pas arretee) ne compte pas : elle n'attend pas d'envoi", async () => {
    journal.entrees = session({ arretee: false });
    await refreshPendingCount();
    expect(getSyncState().pendingCount).toBe(1);
  });

  it("une session arretee sans assez de positions (moins de deux) ne compte pas : il n'y a rien a envoyer", async () => {
    journal.entrees = session({ positions: 1 });
    await refreshPendingCount();
    expect(getSyncState().pendingCount).toBe(1);
  });

  it("la session d'un AUTRE compte ne compte pas pour ce compte, et compte pour le sien", async () => {
    journal.entrees = session({ agent: "u2" });
    await refreshPendingCount();
    expect(getSyncState().pendingCount).toBe(1);

    configurerUtilisateurSync("u2");
    await refreshPendingCount();
    // u2 n'a pas de defaut en file (celui du mock est a u1) : seule sa session de roulage compte.
    expect(getSyncState().pendingCount).toBe(1);
  });

  it("une session sans agent connu (ancienne, agentRef nul) ne s'attribue a personne", async () => {
    journal.entrees = session({ agent: null });
    await refreshPendingCount();
    expect(getSyncState().pendingCount).toBe(1);
  });

  it("sans IndexedDB (journal en memoire de la page), rien n'est compte", async () => {
    journal.nature = "memoire";
    journal.entrees = session();
    await refreshPendingCount();
    expect(getSyncState().pendingCount).toBe(1);
  });

  it("un journal illisible ne fait pas perdre le compte des autres files", async () => {
    journal.lectureEchoue = true;
    await refreshPendingCount();
    expect(getSyncState().pendingCount).toBe(1);
  });

  it("aucun compte connecte : rien n'est compte", async () => {
    journal.entrees = session();
    configurerUtilisateurSync(null);
    await refreshPendingCount();
    expect(getSyncState().pendingCount).toBe(0);
  });
});
