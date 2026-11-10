import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("./api", () => ({ api: { get: h.get } }));

import { chargerArbreTerritoires, ARBRE_LIMITE_PAGE, ARBRE_PAGES_MAX } from "./projetsVoirieTerritoiresApi";

/** Revue UI-C m5 : l'arbre des territoires se charge par pages de taille par defaut (200), en nombre borne ; au-dela, « tronque ». Donnees synthetiques. */

const terr = (i: number) => ({ id: `t${i}`, code: `SYN-${i}`, nom: `Territoire ${i}`, niveau: "COMMUNE", chemin: `/t${i}/`, profondeur: 0 });

beforeEach(() => h.get.mockReset());

describe("chargement borne de l'arbre des territoires", () => {
  it("pages de 200 (limite par defaut du serveur), curseur suivi, arret a la derniere page", async () => {
    h.get.mockResolvedValueOnce({ data: { territoires: [terr(1)], curseurSuivant: "/t1/" } }).mockResolvedValueOnce({ data: { territoires: [terr(2)], curseurSuivant: null } });
    const r = await chargerArbreTerritoires();
    expect(ARBRE_LIMITE_PAGE).toBe(200);
    expect(h.get.mock.calls.map((c) => c[1].params)).toEqual([{ limite: 200 }, { limite: 200, curseur: "/t1/" }]);
    expect(r).toMatchObject({ tronque: false, ignores: 0 });
    expect(r.territoires.map((t) => t.id)).toEqual(["t1", "t2"]);
  });
  it("nombre de pages borne : au-dela, l'arbre est dit tronque (la recherche passe alors par le serveur)", async () => {
    let n = 0;
    h.get.mockImplementation(async () => { n += 1; return { data: { territoires: [terr(n)], curseurSuivant: `/t${n}/` } }; });
    const r = await chargerArbreTerritoires();
    expect(h.get).toHaveBeenCalledTimes(ARBRE_PAGES_MAX);
    expect(ARBRE_PAGES_MAX * ARBRE_LIMITE_PAGE).toBeLessThanOrEqual(1000);
    expect(r.tronque).toBe(true);
  });
});
