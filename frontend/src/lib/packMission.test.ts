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
