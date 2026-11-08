import { beforeEach, describe, expect, it, vi } from "vitest";
import { declarerRoulageActif, roulageEstActif, signalerActivite, surActivite } from "./activiteExterne";

describe("activiteExterne", () => {
  beforeEach(() => declarerRoulageActif(false));

  it("relaie chaque activite aux abonnes, jusqu'au desabonnement", () => {
    const e = vi.fn();
    const fin = surActivite(e);
    signalerActivite();
    signalerActivite();
    expect(e).toHaveBeenCalledTimes(2);
    fin();
    signalerActivite();
    expect(e).toHaveBeenCalledTimes(2);
  });

  it("demarrer un releve compte comme une activite ; l'arreter non", () => {
    const e = vi.fn();
    const fin = surActivite(e);
    declarerRoulageActif(true);
    expect(roulageEstActif()).toBe(true);
    expect(e).toHaveBeenCalledTimes(1);
    declarerRoulageActif(false);
    expect(roulageEstActif()).toBe(false);
    expect(e).toHaveBeenCalledTimes(1);
    fin();
  });
});
