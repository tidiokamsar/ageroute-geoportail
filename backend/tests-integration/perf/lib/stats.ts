/**
 * Statistiques de latence. Percentile par rang le plus proche (« nearest rank ») : pour n
 * mesures triees, le percentile p est la valeur de rang ceil(p/100 * n). Aucune interpolation :
 * le p95 rendu est une valeur REELLEMENT observee, pas une moyenne de deux observations.
 */
export interface Resume {
  n: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  moyenneMs: number;
}

export function percentile(triees: readonly number[], p: number): number {
  if (triees.length === 0) return NaN;
  const rang = Math.min(triees.length, Math.max(1, Math.ceil((p / 100) * triees.length)));
  return triees[rang - 1];
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export function resumer(mesuresMs: readonly number[]): Resume {
  const t = [...mesuresMs].sort((a, b) => a - b);
  const somme = t.reduce((s, v) => s + v, 0);
  return {
    n: t.length,
    minMs: r2(t[0] ?? NaN),
    p50Ms: r2(percentile(t, 50)),
    p95Ms: r2(percentile(t, 95)),
    p99Ms: r2(percentile(t, 99)),
    maxMs: r2(t[t.length - 1] ?? NaN),
    moyenneMs: r2(somme / Math.max(1, t.length)),
  };
}

/** Chronometre une fonction asynchrone, en millisecondes (horloge monotone). */
export async function chrono<T>(f: () => Promise<T>): Promise<{ ms: number; valeur: T }> {
  const t0 = process.hrtime.bigint();
  const valeur = await f();
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, valeur };
}

/** Echauffement puis `iterations` mesures ; `f(i)` recoit l'indice de l'iteration. */
export async function mesurer(
  f: (i: number) => Promise<unknown>,
  opts: { echauffement: number; iterations: number },
): Promise<{ mesuresMs: number[]; resume: Resume }> {
  for (let i = 0; i < opts.echauffement; i += 1) await f(-1 - i);
  const mesuresMs: number[] = [];
  for (let i = 0; i < opts.iterations; i += 1) mesuresMs.push((await chrono(() => f(i))).ms);
  return { mesuresMs, resume: resumer(mesuresMs) };
}
