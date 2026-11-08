import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fuite d'ecouteurs du journal de roulage de la synchronisation (chantier D8c).
 *
 * `offlineSync.journalRoulage()` garde UN journal par compte. Le vrai journal (roulageHote.stockageIndexedDb) pose a sa creation
 * deux ecouteurs : un abonnement au compte (`abonnerCompte`) et la visibilite de la page. Un changement de compte en creait un
 * nouveau SANS retirer ceux de l'ancien : un jeu d'ecouteurs de plus a chaque bascule, pour toujours. Ici le journal est le VRAI
 * (IndexedDB simulee) ; on compte les ecouteurs vivants.
 */

// Les abonnements au compte VIVANTS : +1 a l'abonnement, -1 au desabonnement (une seule fois par abonnement).
const compte = { abonnes: 0 };
vi.mock("./compteCourant", async (importOriginal) => {
  const original = await importOriginal<typeof import("./compteCourant")>();
  return {
    ...original,
    abonnerCompte: (rappel: () => void) => {
      compte.abonnes += 1;
      const retirer = original.abonnerCompte(rappel);
      let actif = true;
      return () => { if (actif) { actif = false; compte.abonnes -= 1; } retirer(); };
    },
  };
});
vi.mock("./api", () => ({ api: { post: vi.fn(async () => ({ data: {} })) } }));
vi.mock("./offlineDb", () => ({
  getAllPending: vi.fn(async () => []), getAllPendingDefauts: vi.fn(async () => []),
  getAllPendingPortions: vi.fn(async () => []), getAllPendingObservations: vi.fn(async () => []),
  updatePendingInspection: vi.fn(), removePendingInspection: vi.fn(), updatePendingDefaut: vi.fn(), removePendingDefaut: vi.fn(),
  updatePendingPortion: vi.fn(), removePendingPortion: vi.fn(), updatePendingObservation: vi.fn(), removePendingObservation: vi.fn(),
}));

import { fermerCompte, ouvrirCompte, type Chiffreur } from "./compteCourant";
import { configurerUtilisateurSync, refreshPendingCount } from "./offlineSync";

// Le journal lit sans rien chiffrer tant qu'il est vide : un chiffreur factice ouvert suffit.
const chiffreur = { estDeverrouille: () => true } as unknown as Chiffreur;
const empreintes = { u1: "0123456789abcdef", u2: "fedcba9876543210", u3: "00112233aabbccdd" } as const;
function basculerVers(id: keyof typeof empreintes) {
  fermerCompte();
  ouvrirCompte({ compteId: id, empreinte: empreintes[id], chiffreur });
  configurerUtilisateurSync(id);
}

/** Ecouteurs `visibilitychange` vivants sur le document : ajouts moins retraits. */
function suivreVisibilite() {
  let vivants = 0;
  const ajout = document.addEventListener.bind(document);
  const retrait = document.removeEventListener.bind(document);
  vi.spyOn(document, "addEventListener").mockImplementation((type: string, ...reste: unknown[]) => {
    if (type === "visibilitychange") vivants += 1;
    return (ajout as (...a: unknown[]) => void)(type, ...reste);
  });
  vi.spyOn(document, "removeEventListener").mockImplementation((type: string, ...reste: unknown[]) => {
    if (type === "visibilitychange") vivants -= 1;
    return (retrait as (...a: unknown[]) => void)(type, ...reste);
  });
  return () => vivants;
}

beforeEach(() => {
  fermerCompte();
  compte.abonnes = 0;
  localStorage.clear();
});

describe("journal de roulage de la synchronisation : pas de fuite d'ecouteurs au changement de compte", () => {
  it("apres plusieurs bascules, un seul jeu d'ecouteurs reste vivant (celui du compte courant)", async () => {
    const visibilite = suivreVisibilite();
    // Etat de depart inconnu (un journal peut deja etre en cache d'un test precedent du meme fichier) : on mesure l'ECART.
    basculerVers("u1");
    await refreshPendingCount();
    const abonnesDepart = compte.abonnes;
    const visibiliteDepart = visibilite();

    for (const id of ["u2", "u3", "u1", "u2", "u3"] as const) {
      basculerVers(id);
      await refreshPendingCount();
      await refreshPendingCount();           // le meme compte : le journal en cache sert, rien ne s'ajoute
    }

    // Sans `fermer()` sur l'ancienne instance, chaque bascule ajoutait un abonnement au compte et un ecouteur de visibilite.
    expect(compte.abonnes).toBe(abonnesDepart);
    expect(visibilite()).toBe(visibiliteDepart);
    expect(visibiliteDepart).toBeGreaterThanOrEqual(1);
    vi.restoreAllMocks();
  });
});
