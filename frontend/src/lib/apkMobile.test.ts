import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Telechargement de l'APK : par l'API authentifiee (jeton), jamais par un lien public ; un refus est dit, pas avale.
 */
const h = vi.hoisted(() => ({ telechargements: [] as { url: string; nom: string }[], echec: null as null | { response?: { status: number } }, info: null as unknown, infoEchec: false }));
vi.mock("./download", () => ({
  downloadViaApi: vi.fn(async (url: string, nom: string) => { if (h.echec) throw h.echec; h.telechargements.push({ url, nom }); }),
}));
vi.mock("./api", () => ({
  api: { get: vi.fn(async () => { if (h.infoEchec) throw new Error("reseau"); return { data: h.info }; }) },
}));
vi.mock("./toast", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { lireInfoApk, NOM_FICHIER_APK, telechargerApk } from "./apkMobile";
import { toast } from "./toast";

beforeEach(() => { h.telechargements = []; h.echec = null; h.info = { disponible: true, sha256: "ab".repeat(32) }; h.infoEchec = false; vi.mocked(toast.error).mockClear(); });

describe("application mobile", () => {
  it("telecharge par l'API (chemin /v2/mobile/apk), pas par un fichier public", async () => {
    await telechargerApk();
    expect(h.telechargements).toEqual([{ url: "/v2/mobile/apk", nom: NOM_FICHIER_APK }]);
    expect(h.telechargements[0].url).not.toContain("/mobile/bdri");
  });

  it("fichier non publie (404) : message clair ; autre echec : message de reessai", async () => {
    h.echec = { response: { status: 404 } };
    await telechargerApk();
    expect(vi.mocked(toast.error).mock.calls[0][0]).toMatch(/pas publiée/);
    h.echec = { response: { status: 500 } };
    await telechargerApk();
    expect(vi.mocked(toast.error).mock.calls[1][0]).toMatch(/réessayer/);
  });

  it("l'empreinte est lue ; en cas de panne : « non disponible », jamais une empreinte inventee", async () => {
    expect((await lireInfoApk()).sha256).toBe("ab".repeat(32));
    h.infoEchec = true;
    expect(await lireInfoApk()).toEqual({ disponible: false });
  });
});
