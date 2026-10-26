import { describe, expect, it, vi } from "vitest";

// L'environnement reel exige des secrets de 32 caracteres : on fournit des valeurs de test locales.
vi.mock("../config/env", () => ({
  env: {
    JWT_ACCESS_SECRET: "test-access-secret-0123456789abcdef-aaaa",
    JWT_ACCESS_EXPIRES_IN: "15m",
    JWT_REFRESH_SECRET: "test-refresh-secret-0123456789abcdef-bbbb",
    JWT_REFRESH_EXPIRES_IN: "7d",
  },
}));

import jwt from "jsonwebtoken";
import { signRefreshToken, verifyRefreshToken, signAccessToken, verifyAccessToken } from "./jwt";

describe("signRefreshToken", () => {
  it("deux signatures successives pour le meme compte different (meme seconde comprise)", () => {
    // Horloge figee : les deux signatures ont le meme `iat` et le meme `exp`, comme deux connexions
    // dans la meme seconde. Sans `jti`, les chaines seraient identiques.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T10:00:00.000Z"));
    try {
      const a = signRefreshToken("user-1");
      const b = signRefreshToken("user-1");
      expect(a).not.toBe(b);
      const pa = jwt.decode(a) as { iat: number; exp: number; jti: string };
      const pb = jwt.decode(b) as { iat: number; exp: number; jti: string };
      expect(pa.iat).toBe(pb.iat);
      expect(pa.exp).toBe(pb.exp);
      expect(pa.jti).toBeTruthy();
      expect(pb.jti).toBeTruthy();
      expect(pa.jti).not.toBe(pb.jti);
    } finally {
      vi.useRealTimers();
    }
  });

  it("la verification du jeton de rafraichissement fonctionne toujours et rend le compte", () => {
    const token = signRefreshToken("user-2");
    expect(verifyRefreshToken(token).sub).toBe("user-2");
  });

  it("deux jetons du meme compte sont tous deux verifiables", () => {
    const a = signRefreshToken("user-3");
    const b = signRefreshToken("user-3");
    expect(verifyRefreshToken(a).sub).toBe("user-3");
    expect(verifyRefreshToken(b).sub).toBe("user-3");
  });

  it("un jeton signe avec un autre secret est refuse", () => {
    const etranger = jwt.sign({ sub: "user-4" }, "un-autre-secret-0123456789abcdef-cccc", { jwtid: "x" });
    expect(() => verifyRefreshToken(etranger)).toThrow();
  });

  it("un jeton d'acces n'est pas accepte comme jeton de rafraichissement (secrets distincts)", () => {
    const acces = signAccessToken({ sub: "user-5", role: "LECTEUR" as never, email: "a@b.invalid" });
    expect(verifyAccessToken(acces).sub).toBe("user-5");
    expect(() => verifyRefreshToken(acces)).toThrow();
  });
});
