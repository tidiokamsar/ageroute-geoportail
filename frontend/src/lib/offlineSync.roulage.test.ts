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
const journal: {
  entrees: Entree[]; nature: "indexeddb" | "memoire"; lectureEchoue: boolean; ouvertures: number; fermetures: number; fermetureEchoue: boolean;
} = { entrees: [], nature: "indexeddb", lectureEchoue: false, ouvertures: 0, fermetures: 0, fermetureEchoue: false };

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
  ouvrirStockage: () => {
    journal.ouvertures += 1;
    return {
      get nature() { return journal.nature; },
      ajouter: () => undefined,
      vider: async () => undefined,
      echecs: () => 0,
      toutes: async () => {
        if (journal.lectureEchoue) throw new Error("journal illisible");
        return journal.entrees;
      },
      // Fermeture : retire les ecouteurs du journal reel (roulageHote.ts). Comptee ici pour prouver qu'un cache remplace est ferme.
      fermer: () => {
        journal.fermetures += 1;
        if (journal.fermetureEchoue) throw new Error("fermeture impossible");
      },
    };
  },
}));

import { configurerUtilisateurSync, getSyncState, refreshPendingCount } from "./offlineSync";
import { noterEnvoiConfirme } from "./releveVue";
import { fermerCompte, ouvrirCompte, type Chiffreur } from "./compteCourant";

function session(options: { agent?: string | null; sessionId?: string; positions?: number; arretee?: boolean } = {}): Entree[] {
  const { agent = "u1", sessionId = "sess-1", positions = 3, arretee = true } = options;
  const entrees: Entree[] = [
    { seq: 1, type: "DEMARRAGE", tMs: 1, sessionId, parametres: {}, agentRef: agent, versionJournal: 1 },
    ...Array.from({ length: positions }, (_, i) => ({ seq: 2 + i, type: "ECHANTILLON", echantillon: { tMs: 1000 * (i + 1) } })),
  ];
  if (arretee) entrees.push({ seq: 2 + positions, type: "ARRET", tMs: 9000 });
  return entrees;
}

// ADAPTATION AU STOCKAGE PAR COMPTE : la confirmation d'envoi est une cle localStorage posee sous le prefixe du compte courant
// (compteCourant.ts). Le journal reste simule ici (ouvrirStockage est mocke) : un chiffreur factice suffit, il ne chiffre rien.
const chiffreurFactice = { estDeverrouille: () => true } as unknown as Chiffreur;

beforeEach(() => {
  fermerCompte();
  ouvrirCompte({ compteId: "u1", empreinte: "0123456789abcdef", chiffreur: chiffreurFactice });
  journal.entrees = [];
  journal.nature = "indexeddb";
  journal.lectureEchoue = false;
  journal.fermetureEchoue = false;
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

describe("journal de roulage de la synchronisation : l'ancienne instance est fermee quand le cache est remplace", () => {
  const empreintes = { u1: "0123456789abcdef", u2: "fedcba9876543210" } as const;
  const basculerVers = (id: keyof typeof empreintes) => {
    fermerCompte();
    ouvrirCompte({ compteId: id, empreinte: empreintes[id], chiffreur: chiffreurFactice });
    configurerUtilisateurSync(id);
  };

  it("un changement de compte ferme l'ancien journal, une seule fois ; le meme compte ne ferme ni ne rouvre rien", async () => {
    basculerVers("u1");
    await refreshPendingCount();
    const fermeesAvant = journal.fermetures;
    const ouvertesAvant = journal.ouvertures;

    // Meme compte : le journal en cache sert, aucune ouverture, aucune fermeture (une connexion par rafraichissement fuirait).
    await refreshPendingCount();
    await refreshPendingCount();
    expect(journal.ouvertures).toBe(ouvertesAvant);
    expect(journal.fermetures).toBe(fermeesAvant);

    // Autre compte : un journal neuf, et l'ancien est FERME (ses ecouteurs retires), une fois.
    basculerVers("u2");
    await refreshPendingCount();
    expect(journal.ouvertures).toBe(ouvertesAvant + 1);
    expect(journal.fermetures).toBe(fermeesAvant + 1);
    await refreshPendingCount();
    expect(journal.fermetures).toBe(fermeesAvant + 1);

    // Retour au premier : encore un remplacement, encore une fermeture. Un seul journal ouvert a la fois.
    basculerVers("u1");
    await refreshPendingCount();
    expect(journal.ouvertures).toBe(ouvertesAvant + 2);
    expect(journal.fermetures).toBe(fermeesAvant + 2);
  });

  it("une fermeture qui echoue ne casse pas le decompte : le nouveau compte compte ses saisies", async () => {
    basculerVers("u1");
    await refreshPendingCount();
    journal.fermetureEchoue = true;
    journal.entrees = session({ agent: "u2" });

    basculerVers("u2");
    await expect(refreshPendingCount()).resolves.toBeUndefined();

    // u2 n'a pas de defaut en file (celui du mock est a u1) : seule sa session de roulage arretee compte.
    expect(getSyncState().pendingCount).toBe(1);
  });
});
