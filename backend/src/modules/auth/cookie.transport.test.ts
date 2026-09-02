import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

vi.mock("../../config/env", () => ({
  env: { NODE_ENV: "production", CORS_ORIGIN: "https://carte.ageroute.gov.gn", JWT_REFRESH_EXPIRES_IN: "7d" },
}));

const authService = vi.hoisted(() => ({
  login: vi.fn(),
  refresh: vi.fn(),
  logout: vi.fn(),
  logoutAll: vi.fn(),
  verifyTwoFaLogin: vi.fn(),
}));
vi.mock("./auth.service", () => authService);

import { loginHandler, refreshHandler, logoutHandler, logoutAllHandler, twoFaLoginVerifyHandler } from "./auth.controller";
import { verifyOrigin } from "../../middleware/origin.middleware";

function fakeReq({ body, cookies, headers, user }: Partial<Request> = {}) {
  return { body, cookies, headers, user, ip: "1.2.3.4" } as unknown as Request;
}

function fakeRes() {
  const res = {
    cookiesPresents: [] as { name: string; opts: Record<string, unknown> }[],
    effaces: [] as string[],
    corps: undefined as unknown,
    status: undefined as number | undefined,
  };
  const handle = {
    cookie: vi.fn((name: string, _v: string, opts: Record<string, unknown>) => { res.cookiesPresents.push({ name, opts }); }),
    clearCookie: vi.fn((name: string) => { res.effaces.push(name); }),
    json: vi.fn((corps: unknown) => { res.corps = corps; }),
    status: vi.fn((code: number) => { res.status = code; return handle; }),
    send: vi.fn(),
  };
  return { handle, etat: res } as unknown as { handle: Response & typeof handle; etat: typeof res };
}

const next = vi.fn();

beforeEach(() => vi.clearAllMocks());

describe("P3-B — transport cookie HttpOnly (contrôleurs)", () => {
  it("login pose le cookie avec les attributs exacts et garde le body de transition", async () => {
    authService.login.mockResolvedValue({ accessToken: "AT", refreshToken: "RT-BRUT", user: {} });
    const { handle, etat } = fakeRes();
    await loginHandler(fakeReq({ body: { email: "a@ageroute.gov.gn", password: "x" } }), handle, next);

    expect(etat.cookiesPresents).toHaveLength(1);
    const { name, opts } = etat.cookiesPresents[0];
    expect(name).toBe("bdri_rt");
    expect(opts).toMatchObject({ httpOnly: true, secure: true, sameSite: "strict", path: "/api/auth" });
    expect(opts.maxAge).toBe(7 * 24 * 3600 * 1000);
    expect(etat.corps).toMatchObject({ refreshToken: "RT-BRUT" }); // transition : anciens clients
  });

  it("2FA verify pose aussi le cookie", async () => {
    authService.verifyTwoFaLogin.mockResolvedValue({ accessToken: "AT", refreshToken: "RT", user: {} });
    const { handle, etat } = fakeRes();
    await twoFaLoginVerifyHandler(fakeReq({ body: { challengeToken: "c", code: "123456" } }), handle, next);
    expect(etat.cookiesPresents[0].name).toBe("bdri_rt");
  });

  it("refresh depuis COOKIE : nouveau cookie posé, AUCUN refresh dans le body", async () => {
    authService.refresh.mockResolvedValue({ accessToken: "AT2", refreshToken: "RT2" });
    const { handle, etat } = fakeRes();
    await refreshHandler(fakeReq({ body: {}, cookies: { bdri_rt: "RT1-BRUT" } }), handle, next);

    expect(authService.refresh).toHaveBeenCalledWith("RT1-BRUT", "1.2.3.4");
    expect(etat.cookiesPresents[0].name).toBe("bdri_rt");
    expect(JSON.stringify(etat.corps)).not.toContain("RT2");
    expect(etat.corps).toEqual({ accessToken: "AT2" });
  });

  it("refresh depuis BODY (ancien client) : body complet + cookie posé = migration de session", async () => {
    authService.refresh.mockResolvedValue({ accessToken: "AT2", refreshToken: "RT2" });
    const { handle, etat } = fakeRes();
    await refreshHandler(fakeReq({ body: { refreshToken: "RT1-BRUT" }, cookies: {} }), handle, next);

    expect(authService.refresh).toHaveBeenCalledWith("RT1-BRUT", "1.2.3.4");
    expect(etat.corps).toMatchObject({ refreshToken: "RT2" });
    expect(etat.cookiesPresents[0].name).toBe("bdri_rt");
  });

  it("refresh sans cookie ni body : 401 immédiat, cookie résident effacé", async () => {
    const { handle, etat } = fakeRes();
    await refreshHandler(fakeReq({ body: {}, cookies: {} }), handle, next);
    expect(next).toHaveBeenCalled();
    const err = next.mock.calls[0][0];
    expect(err).toMatchObject({ status: 401 });
    expect(etat.effaces).toContain("bdri_rt");
  });

  it("refresh refusé (réutilisation détectée côté service) : cookie effacé, erreur propagée", async () => {
    authService.refresh.mockRejectedValue(Object.assign(new Error("invalide"), { status: 401 }));
    const { handle, etat } = fakeRes();
    await refreshHandler(fakeReq({ body: {}, cookies: { bdri_rt: "RT-VOLÉ" } }), handle, next);
    expect(etat.effaces).toContain("bdri_rt");
    expect(next).toHaveBeenCalled();
  });

  it("logout révoque depuis le cookie et l'efface", async () => {
    const { handle, etat } = fakeRes();
    await logoutHandler(fakeReq({ body: {}, cookies: { bdri_rt: "RT1" } }), handle, next);
    expect(authService.logout).toHaveBeenCalledWith("RT1");
    expect(etat.effaces).toContain("bdri_rt");
    expect(etat.status).toBe(204);
  });

  it("logout sans rien : efface le cookie, ne crée pas d'erreur", async () => {
    const { handle, etat } = fakeRes();
    await logoutHandler(fakeReq({ body: {}, cookies: {} }), handle, next);
    expect(next).not.toHaveBeenCalled();
    expect(etat.effaces).toContain("bdri_rt");
  });

  it("logout-all révoque tout et efface le cookie", async () => {
    const { handle, etat } = fakeRes();
    await logoutAllHandler(fakeReq({ user: { id: "u1", role: "ADMIN" }, cookies: { bdri_rt: "RT" } }), handle, next);
    expect(authService.logoutAll).toHaveBeenCalledWith("u1", "1.2.3.4");
    expect(etat.effaces).toContain("bdri_rt");
  });
});

describe("P3-B — verifyOrigin (CSRF, défense en profondeur)", () => {
  function originReq(origin?: string) {
    return { headers: origin ? { origin } : {} } as unknown as Request;
  }

  it("Origin autorisée → passe", () => {
    const res = fakeRes().handle;
    verifyOrigin(originReq("https://carte.ageroute.gov.gn"), res, next);
    expect(next).toHaveBeenCalled();
  });

  it("Origin d'un autre site → 403, jamais next", () => {
    const { handle, etat } = fakeRes();
    verifyOrigin(originReq("https://attaquant.example"), handle, next);
    expect(next).not.toHaveBeenCalled();
    expect(etat.status).toBe(403);
  });

  it("Origin ABSENTE (client non-navigateur) → passe", () => {
    verifyOrigin(originReq(undefined), fakeRes().handle, next);
    expect(next).toHaveBeenCalled();
  });

  it("liste CORS multi-origines : toutes passent, les autres non", async () => {
    const { env } = await import("../../config/env");
    (env as { CORS_ORIGIN: string }).CORS_ORIGIN = "https://a.gn,https://b.gn";
    const ok = fakeRes();
    verifyOrigin(originReq("https://a.gn"), ok.handle, next);
    verifyOrigin(originReq("https://b.gn"), ok.handle, next);
    const ko = fakeRes();
    verifyOrigin(originReq("https://c.gn"), ko.handle, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(ko.etat.status).toBe(403);
  });
});
