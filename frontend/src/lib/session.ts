/**
 * P3-B : logique de session côté client, PURE et testable.
 *
 * Le refresh token ne vit plus ici : le navigateur le porte en cookie HttpOnly
 * posé par l'API. Ces fonctions ne voient jamais le token brut — elles
 * orchestrent quand rafraîchir, combien de fois réessayer, et comment les
 * onglets se coordonnent.
 */

export const LEGACY_REFRESH_KEY = "bdri_refresh_token";

/** Un refresh peut-il être tenté pour cette requête rejetée en 401 ?
 *  Un seul essai par requête : jamais de boucle 401 → refresh → 401 → … */
export function peutRetenter(config: unknown): boolean {
  return !((config as { _retried?: boolean } | undefined)?._retried);
}

export function marquerRetentee(config: unknown): void {
  (config as { _retried?: boolean })._retried = true;
}

/** Ancien token localStorage (migration douce) — null si absent/déjà migré. */
export function lireLegacyRefreshToken(): string | null {
  try {
    return localStorage.getItem(LEGACY_REFRESH_KEY);
  } catch {
    return null; // localStorage indisponible (mode privé strict, etc.)
  }
}

/** Purge définitive de l'ancien stockage — à n'appeler qu'après migration réussie. */
export function purgerLegacyRefreshToken(): void {
  try {
    localStorage.removeItem(LEGACY_REFRESH_KEY);
  } catch {
    /* déjà absent */
  }
}

// Marqueur de session NON sensible (valeur fixe, lisible par le JS) : il dit
// seulement « une session existe probablement », pour ne déclencher un refresh
// au démarrage que lorsqu'il y a une chance qu'il réussisse. Le refresh token,
// lui, reste invisible dans son cookie HttpOnly.
const MARQUEUR_SESSION = "bdri_sess";

export function poserMarqueurSession(): void {
  try {
    document.cookie = `${MARQUEUR_SESSION}=1; path=/; max-age=${7 * 24 * 3600}; samesite=strict`;
  } catch {
    /* cookies désactivés : le refresh au démarrage ne se fera pas, login requis */
  }
}

export function purgerMarqueurSession(): void {
  try {
    document.cookie = `${MARQUEUR_SESSION}=; path=/; max-age=0; samesite=strict`;
  } catch {
    /* rien */
  }
}

export function marqueurSessionPresent(): boolean {
  try {
    return document.cookie.split(";").some((c) => c.trim().startsWith(`${MARQUEUR_SESSION}=`));
  } catch {
    return false;
  }
}

/** Charge utile du POST /auth/refresh : l'ancien token UNE SEULE fois (migration),
 *  ensuite le cookie HttpOnly voyage seul et le body reste vide. */
export function payloadRefresh(legacyToken: string | null): Record<string, string> {
  return legacyToken ? { refreshToken: legacyToken } : {};
}

/**
 * Verrou de refresh, injectable pour les tests.
 *
 * Production : Web Locks API — le verrou est PARTAGÉ ENTRE ONGLETS du même
 * navigateur. Trois onglets dont l'access token expire ensemble : un seul
 * refresh émis, les deux autres attendent puis réutilisent le token frais.
 * C'est devenu un prérequis depuis que le serveur (P3-A) révoque la famille
 * en cas de rotation concurrente perdue.
 *
 * Repli (navigateurs sans Web Locks) : verrou par onglet — le partage de
 * promesse interne évite au moins le doublon dans l'onglet.
 */
export interface Verrou {
  avecVerrou<T>(tache: () => Promise<T>): Promise<T>;
}

export function verrouWebLocks(nom = "bdri-refresh"): Verrou {
  return {
    async avecVerrou<T>(tache: () => Promise<T>): Promise<T> {
      if (typeof navigator !== "undefined" && navigator.locks?.request) {
        return navigator.locks.request(nom, () => tache());
      }
      return tache();
    },
  };
}
