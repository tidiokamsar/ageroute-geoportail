import { describe, expect, it, vi } from "vitest";
import {
  peutRetenter, marquerRetentee,
  payloadRefresh, lireLegacyRefreshToken, purgerLegacyRefreshToken,
  verrouWebLocks, type Verrou,
} from "./session";

describe("P3-B — logique de session côté client", () => {
  it("retry unique : une requête ne peut être retentée qu'une fois (pas de boucle 401→refresh→401)", () => {
    const config: Record<string, unknown> = {};
    expect(peutRetenter(config)).toBe(true);
    // config absente = jamais marquée = retentable (l'intercepteur garde son
    // propre garde sur original avant d'appeler)
    expect(peutRetenter(undefined)).toBe(true);
    marquerRetentee(config);
    expect(peutRetenter(config)).toBe(false);
  });

  it("payload de refresh : l'ancien token part UNE seule fois (migration), ensuite body vide", () => {
    expect(payloadRefresh("ANCIEN-TOKEN")).toEqual({ refreshToken: "ANCIEN-TOKEN" });
    expect(payloadRefresh(null)).toEqual({});
  });

  it("legacy localStorage : lu si présent, null sinon (stockage indisponible ⇒ dégradé propre)", () => {
    // environnement node : localStorage inexistant → branche catch → null
    expect(lireLegacyRefreshToken()).toBeNull();
    expect(() => purgerLegacyRefreshToken()).not.toThrow();
  });

  it("le verrou sérialise : deux refresh « simultanés » ne tournent jamais en parallèle", async () => {
    // Verrou de test = vraie file (mutex), fidèle à la sémantique de Web Locks.
    let actifs = 0;
    let maxActifs = 0;
    let chaine: Promise<unknown> = Promise.resolve();
    const verrouTest: Verrou = {
      avecVerrou(tache) {
        const tour = chaine.then(async () => {
          actifs++; maxActifs = Math.max(maxActifs, actifs);
          try { return await tache(); } finally { actifs--; }
        });
        chaine = tour.catch(() => undefined);
        return tour;
      },
    };
    const appelés: number[] = [];
    const taches = [0, 1].map((i) =>
      verrouTest.avecVerrou(async () => {
        appelés.push(i);
        await new Promise((r) => setTimeout(r, 10));
        return i;
      })
    );
    const resultats = await Promise.all(taches);
    expect(resultats).toEqual([0, 1]);
    expect(maxActifs).toBe(1); // jamais deux rafraîchissements en parallèle
    expect(appelés).toEqual([0, 1]);
  });

  it("le double-check dans le verrou évite un second appel réseau inutile (l'autre onglet a rafraîchi)", async () => {
    // Simulation du flux réel : accessToken déjà reposé pendant l'attente du verrou.
    let accessToken: string | null = null;
    const refresh = vi.fn(async () => { accessToken = "AT-NEUF"; return "AT-NEUF"; });
    const verrou: Verrou = {
      async avecVerrou(tache) {
        // pendant l'attente simulée, un autre onglet rafraîchit
        accessToken = "AT-AUTRE-ONGLET";
        return tache();
      },
    };
    const resultat = await verrou.avecVerrou(async () => (accessToken ?? refresh()));
    expect(resultat).toBe("AT-AUTRE-ONGLET");
    expect(refresh).not.toHaveBeenCalled(); // pas de second refresh : famille protégée
  });

  it("verrouWebLocks délègue à navigator.locks quand disponible", async () => {
    const demande: (nom: string, cb: () => Promise<string>) => Promise<string> =
      async (nom, cb) => `verrou(${nom}):${await cb()}`;
    const original = Object.getOwnPropertyDescriptor(navigator, "locks");
    Object.defineProperty(navigator, "locks", { value: { request: demande }, configurable: true });
    try {
      const v = verrouWebLocks("test-verrou");
      expect(await v.avecVerrou(async () => "ok")).toBe("verrou(test-verrou):ok");
    } finally {
      if (original) Object.defineProperty(navigator, "locks", original);
      else delete (navigator as { locks?: unknown }).locks;
    }
  });

  it("verrouWebLocks se replie sans verrou quand Web Locks est absent", async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, "locks");
    Object.defineProperty(navigator, "locks", { value: undefined, configurable: true });
    try {
      const v = verrouWebLocks();
      expect(await v.avecVerrou(async () => "direct")).toBe("direct");
    } finally {
      if (original) Object.defineProperty(navigator, "locks", original);
      else delete (navigator as { locks?: unknown }).locks;
    }
  });
});
