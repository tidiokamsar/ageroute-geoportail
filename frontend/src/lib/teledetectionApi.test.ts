import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("./api", () => ({ api: { get: h.get, post: h.post } }));

import {
  affecterAUneInspection, cheminApercuSur, classerErreur, CONSTAT_REF_MAX, estErreurAutorisation, lireApercu, lireQualiteMethodes, lirePropositions, lirePropositionsGeo, lireProposition,
  lireSources, lireSynthese, paramsPropositions, poserTransition, verifierSource,
} from "./teledetectionApi";
import { FILTRES_VIDES, intervalleIncoherent, nombreFiltresActifs, versFiltresPropositions, versFiltresSynthese } from "./teledetectionFiltres";

const err = (status: number | undefined, data?: object) => Object.assign(new Error("x"), status === undefined ? {} : { response: { status, data } });

beforeEach(() => { h.get.mockReset(); h.post.mockReset(); });

describe("classerErreur : une erreur a un genre stable, jamais un vide", () => {
  it.each([
    [401, "session"], [403, "permission"], [404, "introuvable"], [409, "conflit"], [400, "entree"], [429, "limite"], [503, "indisponible"], [500, "serveur"], [502, "serveur"],
  ] as const)("HTTP %i devient %s", (status, genre) => {
    expect(classerErreur(err(status)).genre).toBe(genre);
  });
  it("sans reponse : reseau", () => {
    expect(classerErreur(err(undefined)).genre).toBe("reseau");
    expect(classerErreur(null).genre).toBe("reseau");
  });
  it("le message du serveur prime, le code stable est conserve", () => {
    const e = classerErreur(err(409, { error: "Verdict définitif", code: "VERDICT_DEFINITIF" }));
    expect(e.message).toBe("Verdict définitif");
    expect(e.code).toBe("VERDICT_DEFINITIF");
  });
  it("sans message serveur : un message par defaut non vide", () => {
    expect(classerErreur(err(403)).message.length).toBeGreaterThan(10);
  });
  it("seuls 401 et 403 sont des erreurs d'autorisation (jamais retentees)", () => {
    expect(estErreurAutorisation(err(403))).toBe(true);
    expect(estErreurAutorisation(err(401))).toBe(true);
    expect(estErreurAutorisation(err(500))).toBe(false);
  });
});

describe("parametres", () => {
  it("omet les filtres vides et traduit rattachee en booleen", () => {
    expect(paramsPropositions({ statut: "A_VERIFIER", type: "", rattachee: "oui", q: "  " })).toEqual({ statut: "A_VERIFIER", rattachee: "true", limite: 25 });
    expect(paramsPropositions({ rattachee: "non" }).rattachee).toBe("false");
    expect(paramsPropositions({ rattachee: "" })).not.toHaveProperty("rattachee");
  });
  it("transmet le curseur et la limite", () => {
    expect(paramsPropositions({}, "abc", 50)).toEqual({ curseur: "abc", limite: 50 });
  });
  it("filtres de l'ecran : la synthese ne suit que la region et la periode", () => {
    const f = { ...FILTRES_VIDES, q: "x", type: "INONDATION", regionId: "3", depuis: "2026-10-01" };
    expect(versFiltresSynthese(f)).toEqual({ regionId: "3", depuis: "2026-10-01", jusqua: "" });
    expect(versFiltresPropositions(f, "CONFIRMEE")).toMatchObject({ statut: "CONFIRMEE", type: "INONDATION", regionId: "3", q: "x" });
  });
  it("compte les filtres actifs, recherche comprise, et detecte un intervalle incoherent", () => {
    expect(nombreFiltresActifs(FILTRES_VIDES)).toBe(0);
    expect(nombreFiltresActifs({ ...FILTRES_VIDES, q: "a", priorite: "HAUTE", tronconLibelle: "ignore" })).toBe(2);
    expect(intervalleIncoherent({ depuis: "2026-10-10", jusqua: "2026-10-01" })).toBe(true);
    expect(intervalleIncoherent({ depuis: "2026-10-01", jusqua: "" })).toBe(false);
  });
});

describe("appels (URL et corps conformes au contrat paragraphe 5)", () => {
  it("synthese, propositions, detail, sources", async () => {
    h.get.mockResolvedValue({ data: { ok: true } });
    await lireSynthese({ regionId: "2" });
    expect(h.get).toHaveBeenLastCalledWith("/v2/teledetection/synthese", { params: { regionId: "2" } });
    await lirePropositions({ statut: "EN_ATTENTE" }, "cur");
    expect(h.get).toHaveBeenLastCalledWith("/v2/teledetection/propositions", { params: { statut: "EN_ATTENTE", curseur: "cur", limite: 25 } });
    await lireProposition("a/b");
    expect(h.get).toHaveBeenLastCalledWith("/v2/teledetection/propositions/a%2Fb");
    await lireSources();
    expect(h.get).toHaveBeenLastCalledWith("/v2/teledetection/sources");
  });
  it("geojson : bbox obligatoire, ouest,sud,est,nord", async () => {
    h.get.mockResolvedValue({ data: { type: "FeatureCollection", features: [] } });
    await lirePropositionsGeo([-14, 9, -13, 10], { statut: "A_VERIFIER", type: "" });
    expect(h.get).toHaveBeenLastCalledWith("/v2/teledetection/propositions.geojson", { params: { bbox: "-14,9,-13,10", statut: "A_VERIFIER" } });
  });
  it("transition, affectation et verification de source", async () => {
    h.post.mockResolvedValue({ data: { code: "VER-1" } });
    await poserTransition("p1", { vers: "EN_ATTENTE", motif: "m", motifAttente: "INFO_DEMANDEE" });
    expect(h.post).toHaveBeenLastCalledWith("/v2/teledetection/propositions/p1/transition", { vers: "EN_ATTENTE", motif: "m", motifAttente: "INFO_DEMANDEE" });
    expect(await affecterAUneInspection("p1")).toEqual({ code: "VER-1" });
    expect(h.post).toHaveBeenLastCalledWith("/v2/teledetection/propositions/p1/verification", {});
    await verifierSource("SRC A");
    expect(h.post).toHaveBeenLastCalledWith("/v2/teledetection/sources/SRC%20A/verifier", {});
  });
  it("apercu : le prefixe /api est retire (l'instance l'ajoute deja) et la reponse est un blob", async () => {
    h.get.mockResolvedValue({ data: new Blob(["x"], { type: "image/png" }) });
    await lireApercu("/api/v2/teledetection/produits/p/apercu");
    expect(h.get).toHaveBeenLastCalledWith("/v2/teledetection/produits/p/apercu", { responseType: "blob" });
    await lireApercu("/v2/teledetection/produits/q/apercu");
    expect(h.get).toHaveBeenLastCalledWith("/v2/teledetection/produits/q/apercu", { responseType: "blob" });
  });
  it("apercu : une URL absolue ne recoit JAMAIS le jeton (refusee avant tout appel reseau), seuls les chemins relatifs du serveur passent", async () => {
    h.get.mockResolvedValue({ data: new Blob(["x"], { type: "image/png" }) });
    for (const url of [
      "https://autre.example/api/v2/teledetection/produits/p/apercu", "http://localhost:4000/api/v2/x", "//autre.example/api/v2/x", "///autre.example/x",
      "\\\\autre.example\\x", "/\\autre.example/x", "javascript:alert(1)", "data:image/png;base64,AAAA", "api/v2/x", "", "   ", "/api/../etc/passwd", "/api/v2/%2e%2e/x",
      "/api//autre.example/x", "/api/v2/x\n/y",
    ]) {
      await expect(lireApercu(url), url).rejects.toThrow(/refus/i);
    }
    await expect(lireApercu(undefined as unknown as string)).rejects.toThrow();
    expect(h.get).not.toHaveBeenCalled();
    // les chemins relatifs du serveur, eux, passent
    await lireApercu("/api/v2/teledetection/produits/ok/apercu?v=2");
    expect(h.get).toHaveBeenCalledTimes(1);
    expect(h.get).toHaveBeenLastCalledWith("/v2/teledetection/produits/ok/apercu?v=2", { responseType: "blob" });
  });
  it("cheminApercuSur : relatif same-origin seulement", () => {
    expect(cheminApercuSur("/api/v2/teledetection/produits/p/apercu")).toBe("/v2/teledetection/produits/p/apercu");
    expect(cheminApercuSur("/v2/teledetection/produits/p/apercu")).toBe("/v2/teledetection/produits/p/apercu");
    expect(cheminApercuSur("https://x.example/api/v2/a")).toBeNull();
    expect(cheminApercuSur("//x.example/a")).toBeNull();
    expect(cheminApercuSur(null)).toBeNull();
  });
  it("qualite par methode : GET /qualite-methodes", async () => {
    h.get.mockResolvedValue({ data: { seuilEchantillon: 30, definition: "d", lignes: [] } });
    expect((await lireQualiteMethodes()).seuilEchantillon).toBe(30);
    expect(h.get).toHaveBeenLastCalledWith("/v2/teledetection/qualite-methodes");
  });
  it("transition : le corps porte constatRef tel quel ; borne identique a celle du serveur (200)", async () => {
    h.post.mockResolvedValue({ data: {} });
    await poserTransition("p1", { vers: "CONFIRMEE", motif: "m", constatRef: "REF-1" });
    expect(h.post).toHaveBeenLastCalledWith("/v2/teledetection/propositions/p1/transition", { vers: "CONFIRMEE", motif: "m", constatRef: "REF-1" });
    expect(CONSTAT_REF_MAX).toBe(200);
  });
  it("une erreur du serveur remonte (aucun faux resultat vide)", async () => {
    h.get.mockRejectedValue(err(500));
    await expect(lireSynthese({})).rejects.toBeTruthy();
  });
});
