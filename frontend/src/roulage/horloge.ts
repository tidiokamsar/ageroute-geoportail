/**
 * Horloge injectee. Le noyau ne lit JAMAIS `Date.now()` ni `performance.now()` directement : un test
 * doit pouvoir rejouer une session de deux heures en quelques millisecondes, et un marqueur doit
 * porter l'instant du GESTE, pas celui de son enregistrement.
 */
export interface Horloge {
  /** Temps civil en millisecondes depuis 1970 (meme base que l'horodatage GNSS). */
  maintenantMs(): number;
  /** Compteur monotone haute resolution en millisecondes, pour mesurer des durees. */
  perfMs(): number;
}

/** Horloge reelle : pour la PWA ou la coque Capacitor. Non utilisee par les tests. */
export function horlogeSysteme(): Horloge {
  return {
    maintenantMs: () => Date.now(),
    perfMs: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  };
}

/** Horloge pilotee a la main, pour les tests et les simulations. */
export interface HorlogeSimulee extends Horloge {
  avancer(ms: number): void;
  fixer(ms: number): void;
  /** Fait avancer UNIQUEMENT le compteur de duree (cout logiciel simule), pas le temps civil. */
  consommerCpu(ms: number): void;
}

export function horlogeSimulee(departMs = 1_790_000_000_000): HorlogeSimulee {
  let civil = departMs;
  let perf = 0;
  return {
    maintenantMs: () => civil,
    perfMs: () => perf,
    avancer(ms) { civil += ms; perf += ms; },
    fixer(ms) { perf += ms - civil; civil = ms; },
    consommerCpu(ms) { perf += ms; },
  };
}
