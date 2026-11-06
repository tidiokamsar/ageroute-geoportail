import { describe, expect, it } from "vitest";
import { verifierCadence } from "./cadence.noyau";

const T = new Date("2026-11-06T10:00:00.000Z");
const plus = (s: number) => new Date(T.getTime() + s * 1000);

describe("revue RC-3, m8 : cadence minimale des analyses persistees d'un projet", () => {
  it("aucune analyse terminee avant : passe", () => {
    expect(verifierCadence({ derniereTermineeLe: null, maintenant: T, intervalleS: 60 })).toEqual({ ok: true });
  });

  it("moins de 60 s apres la precedente : refuse avec le delai restant (arrondi au-dessus, au moins 1 s)", () => {
    expect(verifierCadence({ derniereTermineeLe: T, maintenant: plus(10), intervalleS: 60 })).toEqual({ ok: false, retryAfterS: 50 });
    expect(verifierCadence({ derniereTermineeLe: T, maintenant: plus(59.2), intervalleS: 60 })).toEqual({ ok: false, retryAfterS: 1 });
    expect(verifierCadence({ derniereTermineeLe: T, maintenant: plus(0), intervalleS: 60 })).toEqual({ ok: false, retryAfterS: 60 });
  });

  it("exactement 60 s, ou plus : passe", () => {
    expect(verifierCadence({ derniereTermineeLe: T, maintenant: plus(60), intervalleS: 60 })).toEqual({ ok: true });
    expect(verifierCadence({ derniereTermineeLe: T, maintenant: plus(3600), intervalleS: 60 })).toEqual({ ok: true });
  });

  it("intervalle nul (reglage des bancs) : jamais de refus", () => {
    expect(verifierCadence({ derniereTermineeLe: T, maintenant: T, intervalleS: 0 })).toEqual({ ok: true });
  });

  it("une horloge qui recule est traitee comme « a l'instant » : refus, jamais un passage faute de pouvoir mesurer", () => {
    expect(verifierCadence({ derniereTermineeLe: plus(30), maintenant: T, intervalleS: 60 })).toEqual({ ok: false, retryAfterS: 60 });
  });
});
