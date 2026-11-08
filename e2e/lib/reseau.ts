import type { BrowserContext, Page, Request, Route } from "@playwright/test";
import { expect } from "@playwright/test";
import { DELAI_SYNC_MS } from "./env";

/**
 * Fautes reseau ciblees sur la requete de synchronisation (`POST /api/v2/sync/push`), pour reproduire ce que
 * `context.setOffline` ne sait pas faire : un reseau qui coupe PENDANT l'envoi, ou dont la reponse se perd.
 */
export const MOTIF_SYNC_PUSH = "**/api/v2/sync/push";

export interface SondeSync {
  /** Nombre de requetes de synchronisation vues par la sonde (abandonnees ou non). */
  vues(): number;
  /** Corps JSON de la premiere requete vue. */
  premierCorps(): { appareilId: string; operations: Array<{ operationId: string; entityId: string; entityType: string; operation: string; payload: unknown }> } | null;
  /** En-tetes de la premiere requete vue (Authorization incluse), pour la rejouer a la main. */
  premiersEntetes(): Record<string, string> | null;
  retirer(): Promise<void>;
}

type Comportement = "abandonner-avant-serveur" | "perdre-la-reponse" | "laisser-passer";

/**
 * Installe un comportement sur `sync/push`.
 *  - `abandonner-avant-serveur` : la requete n'atteint JAMAIS le serveur (reseau coupe au moment d'envoyer).
 *  - `perdre-la-reponse`        : le serveur la recoit et la traite, mais la reponse ne revient pas au telephone.
 *  - `laisser-passer`           : ne fait que compter.
 * `fois` limite le nombre de requetes touchees ; les suivantes passent normalement.
 */
export async function sonderSync(context: BrowserContext, comportement: Comportement, fois = Number.POSITIVE_INFINITY): Promise<SondeSync> {
  let n = 0;
  let premier: Request | null = null;
  const gestionnaire = async (route: Route) => {
    n += 1;
    premier ??= route.request();
    const touchee = n <= fois;
    if (touchee && comportement === "abandonner-avant-serveur") return route.abort("connectionreset");
    if (touchee && comportement === "perdre-la-reponse") {
      await route.fetch(); // le serveur traite vraiment la requete
      return route.abort("connectionreset"); // ... mais le telephone ne le saura pas
    }
    return route.continue();
  };
  await context.route(MOTIF_SYNC_PUSH, gestionnaire);
  return {
    vues: () => n,
    premierCorps: () => (premier ? JSON.parse(premier.postData() ?? "null") : null),
    premiersEntetes: () => (premier ? premier.headers() : null),
    retirer: () => context.unroute(MOTIF_SYNC_PUSH, gestionnaire),
  };
}

/** Attend que la sonde ait vu au moins `n` requetes. */
export async function attendreSync(sonde: SondeSync, n: number): Promise<void> {
  await expect.poll(() => sonde.vues(), { timeout: DELAI_SYNC_MS }).toBeGreaterThanOrEqual(n);
}

/** Clique « Envoyer maintenant » (ecran Observations terrain), le geste manuel de l'agent. */
export async function envoyerMaintenant(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Envoyer maintenant" }).click();
}

/**
 * « L'API est injoignable, mais l'enveloppe de l'application est la » : toute requete vers `/api/` echoue, les fichiers de
 * l'application (servis par Vite) restent disponibles. C'est ce que verrait un telephone dont le service worker a garde
 * l'enveloppe en cache (le service worker est bloque dans ces tests, et un chargement de page sans reseau echouerait).
 * `navigator.onLine` reste a `true` : c'est le cas d'une mauvaise couverture ou d'un serveur coupe, pas d'un mode avion.
 */
export async function apiInjoignable(context: BrowserContext): Promise<() => Promise<void>> {
  const gestionnaire = (route: Route) => route.abort("internetdisconnected");
  await context.route("**/api/**", gestionnaire);
  return () => context.unroute("**/api/**", gestionnaire);
}
