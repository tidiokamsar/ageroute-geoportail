import { describe, expect, it } from "vitest";
import { avantApres, libelleSection } from "./travaux";

/**
 * Historique avant / après intervention : ce que ces tests défendent.
 *   - la coupure se fait sur les dates RÉELLES ; à défaut, sur les prévues, et le classement le dit ;
 *   - sans date de début, rien n'est classé (on ne devine pas quand des travaux ont eu lieu) ;
 *   - des travaux non terminés n'ont pas d'« après » ; aucune inspection n'est perdue ni dupliquée.
 */
const insp = (id: string, d: string) => ({ id, dateInspection: d });
const toutes = [insp("i3", "2026-09-15"), insp("i1", "2026-01-10"), insp("i2", "2026-05-01"), insp("i4", "2026-10-20")];
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("avantApres", () => {
  it("dates réelles : avant, pendant, après, triés, sans perte", () => {
    const h = avantApres(toutes, { dateDebutReelle: "2026-03-01", dateFinReelle: "2026-09-30" });
    expect([ids(h.avant), ids(h.pendant), ids(h.apres), h.base]).toEqual([["i1"], ["i2", "i3"], ["i4"], "reelles"]);
  });
  it("sans dates réelles : les prévues servent, et la base le dit", () => {
    expect(avantApres(toutes, { dateDebutPrevue: "2026-06-01", dateFinPrevue: "2026-10-01" }).base).toBe("prevues");
  });
  it("travaux en cours (pas de fin) : pas d'après", () => {
    const h = avantApres(toutes, { dateDebutReelle: "2026-06-01" });
    expect([ids(h.avant), ids(h.pendant), ids(h.apres)]).toEqual([["i1", "i2"], ["i3", "i4"], []]);
  });
  it("sans date de début, rien n'est classé", () => {
    expect(avantApres(toutes, {})).toEqual({ avant: [], pendant: [], apres: [], base: "aucune" });
  });
});

describe("libelleSection", () => {
  it.each([
    [{ debutM: null, finM: null }, "tronçon entier"],
    [{ debutM: 200, finM: 800 }, "200 m → 800 m"],
    [{ debutM: 0, finM: 1500, portionId: "p" }, "portion 0 m → 1,5 km"],
  ])("%j -> %s", (s, attendu) => {
    expect(libelleSection(s)).toBe(attendu);
  });
});
