import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";

describe("password utils", () => {
  it("hashes a password and verifies it correctly", async () => {
    const hash = await hashPassword("Test-Passw0rd!2026");
    expect(hash).not.toBe("Test-Passw0rd!2026");
    await expect(verifyPassword(hash, "Test-Passw0rd!2026")).resolves.toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("Test-Passw0rd!2026");
    await expect(verifyPassword(hash, "mauvais-mot-de-passe")).resolves.toBe(false);
  });
});
