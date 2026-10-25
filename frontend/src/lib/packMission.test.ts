import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pack de mission (phase 2 SMART FIELD) : le téléchargement descend TOUT le référentiel
 * (page après page — une page de 200 sur ~1 580 tronçons privait l'agent hors ligne de
 * 87 % du réseau), et `etatPackMission` dit ce qui est déjà sur le téléphone, avec sa
 * fraîcheur — sans rien demander au réseau.
 */
const h = vi.hoisted(() => ({
  pages: [] as Array<Array<{ id: string; code: string; nom: string }>>,
}));
vi.mock("./api", () => ({
  api: {
    get: vi.fn(async (_url: string, { params }: { params: Record<string, unknown> } = { params: {} }) => {
      const page = Number(params.page ?? 1);
      const lot = h.pages[page - 1] ?? [];
      return { data: { data: lot, total: h.pages.reduce((n, l) => n + l.length, 0) } };
    }),
  },
}));

import { chargerReferentielsDefautsTerrain, etatPackMission } from "./defautsTerrain";

function lot(debut: number, n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `t${debut + i}`, code: `GN N${String(debut + i).padStart(4, "0")}`, nom: `Tronçon ${debut + i}` }));
}

beforeEach(() => {
  localStorage.clear();
  h.pages = [lot(1, 200), lot(201, 120)];
});

describe("pack de mission", () => {
  it("descend toutes les pages du référentiel et dater la copie", async () => {
    const r = await chargerReferentielsDefautsTerrain();
    expect(r.troncons.length).toBe(320);
    expect(r.tronconsEnCache).toBe(true);
    const etat = etatPackMission();
    expect(etat.troncons).toBe(320);
    expect(etat.tronconsLe).not.toBeNull();
    expect(etat.catalogue).toBe(0);
  });

  it("etatPackMission ne touche pas au réseau : il lit le cache", async () => {
    expect(etatPackMission().troncons).toBe(0);
    expect(etatPackMission().tronconsLe).toBeNull();
  });
});

describe("pack incomplet : jamais passe sous silence", () => {
  it("un pack complet n'est pas dit incomplet, et garde le total annonce", async () => {
    const r = await chargerReferentielsDefautsTerrain();
    expect(r.tronconsTotal).toBe(320);
    expect(r.tronconsIncomplets).toBe(false);
    expect(etatPackMission()).toMatchObject({ troncons: 320, tronconsTotal: 320, tronconsIncomplets: false });
  });

  it("le navigateur refuse la copie locale (quota) : le pack est dit INCOMPLET, il n'est pas sur l'appareil", async () => {
    const reel = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error("QuotaExceededError"); };
    try {
      const r = await chargerReferentielsDefautsTerrain();
      expect(r.troncons).toHaveLength(320);
      expect(r.tronconsEnCache).toBe(false);
      expect(r.tronconsIncomplets).toBe(true);
    } finally { Storage.prototype.setItem = reel; }
  });

  it("un serveur plus gros que le plafond de pages : le pack s'arrete ET le dit (aucun arret silencieux)", async () => {
    // 101 pages pleines : le plafond (100 pages) est atteint avant la fin.
    h.pages = Array.from({ length: 101 }, (_, i) => lot(i * 200 + 1, 200));
    const r = await chargerReferentielsDefautsTerrain();
    expect(r.troncons).toHaveLength(100 * 200);
    expect(r.tronconsTotal).toBe(101 * 200);
    expect(r.tronconsIncomplets).toBe(true);
    expect(etatPackMission().tronconsIncomplets).toBe(true);
  });
});
