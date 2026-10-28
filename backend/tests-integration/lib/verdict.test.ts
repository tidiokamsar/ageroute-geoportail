import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Un banc qui n'affirme rien ne prouve rien : conclure() doit echouer s'il n'y a eu aucune
 * verification, et echouer des qu'une seule est fausse. Le code de sortie du processus est
 * restaure apres chaque cas pour ne pas faire echouer la suite elle-meme.
 */
const sauve = process.exitCode;
afterEach(() => { process.exitCode = sauve; vi.restoreAllMocks(); vi.resetModules(); });

async function neuf() {
  vi.spyOn(console, "log").mockImplementation(() => {});
  process.exitCode = 0;
  return import("./verdict");
}

describe("verdict", () => {
  it("aucune verification : echec (code 1)", async () => {
    const v = await neuf();
    v.conclure();
    expect(process.exitCode).toBe(1);
  });

  it("toutes vraies : code de sortie inchange", async () => {
    const v = await neuf();
    v.verifier("a", true);
    v.verifier("b", true);
    v.conclure();
    expect(process.exitCode).toBe(0);
  });

  it("une seule fausse : echec (code 1)", async () => {
    const v = await neuf();
    v.verifier("a", true);
    v.verifier("b", false, { vu: 3 });
    v.conclure();
    expect(process.exitCode).toBe(1);
  });

  it("proche : tolerance inclusive, symetrique", async () => {
    const v = await neuf();
    expect(v.proche(10, 10.5, 0.5)).toBe(true);
    expect(v.proche(10.5, 10, 0.5)).toBe(true);
    expect(v.proche(10, 10.6, 0.5)).toBe(false);
  });
});
