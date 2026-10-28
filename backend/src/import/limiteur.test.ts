import { afterEach, describe, expect, it, vi } from "vitest";
import { Limiteur, ServiceOccupe } from "./limiteur";

/** Au plus N receptions a la fois, les suivantes attendent un delai BORNE puis recoivent ServiceOccupe. */
afterEach(() => { vi.useRealTimers(); });

function tenir() {
  let finir!: () => void;
  const promesse = new Promise<void>((r) => { finir = r; });
  return { promesse, finir };
}

describe("Limiteur", () => {
  it("laisse passer jusqu'a `max` travaux simultanes, pas un de plus", async () => {
    const l = new Limiteur(2, 1000);
    const a = tenir(), b = tenir(), c = tenir();
    let actifs = 0, pic = 0;
    const travail = (t: ReturnType<typeof tenir>) => l.executer(async () => { actifs += 1; pic = Math.max(pic, actifs); await t.promesse; actifs -= 1; });
    const pa = travail(a), pb = travail(b), pc = travail(c);
    await new Promise((r) => setImmediate(r));
    expect(l.etat).toEqual({ actifs: 2, enAttente: 1 });
    expect(pic).toBe(2);
    a.finir(); await pa;
    await new Promise((r) => setImmediate(r));
    expect(l.etat).toEqual({ actifs: 2, enAttente: 0 });
    b.finir(); c.finir(); await Promise.all([pb, pc]);
    expect(l.etat).toEqual({ actifs: 0, enAttente: 0 });
    expect(pic).toBe(2);
  });

  it("apres le delai d'attente, ServiceOccupe : 503 + Retry-After, et la file se vide", async () => {
    vi.useFakeTimers();
    const l = new Limiteur(1, 5000);
    const t = tenir();
    const premier = l.executer(() => t.promesse);
    const attente = l.executer(async () => "jamais");
    const verdict = expect(attente).rejects.toBeInstanceOf(ServiceOccupe);
    await vi.advanceTimersByTimeAsync(5001);
    await verdict;
    expect(l.etat).toEqual({ actifs: 1, enAttente: 0 });
    t.finir(); await premier;
    expect(l.etat.actifs).toBe(0);
  });

  it("ServiceOccupe porte son code et son delai de nouvel essai", () => {
    const e = new ServiceOccupe("x");
    expect(e.code).toBe("SERVICE_OCCUPE");
    expect(e.retryAfterS).toBeGreaterThan(0);
  });

  it("libere la place meme quand le travail echoue, et rend l'erreur", async () => {
    const l = new Limiteur(1, 1000);
    await expect(l.executer(async () => { throw new Error("panne"); })).rejects.toThrow("panne");
    expect(l.etat.actifs).toBe(0);
    await expect(l.executer(async () => 42)).resolves.toBe(42);
  });

  it("sert les attentes dans l'ordre d'arrivee", async () => {
    const l = new Limiteur(1, 1000);
    const t = tenir();
    const ordre: number[] = [];
    const p0 = l.executer(() => t.promesse);
    const ps = [1, 2, 3].map((n) => l.executer(async () => { ordre.push(n); }));
    t.finir(); await Promise.all([p0, ...ps]);
    expect(ordre).toEqual([1, 2, 3]);
  });
});
