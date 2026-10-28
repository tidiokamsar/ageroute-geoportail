import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * Données de la page « Lots d'import » : ce que ces tests défendent.
 *
 * - L'adresse porte les filtres et le lot, et ne laisse passer qu'un statut connu.
 * - La route de liste est STRICTE côté serveur : seuls les paramètres qui ont une valeur partent.
 * - Une réponse inattendue est une erreur, jamais une liste vide.
 * - La réception envoie un multipart (champs puis fichier) et rejette l'erreur axios TELLE QUELLE.
 * - Un refus 4xx n'est pas relancé ; le reste suit la règle du client de requêtes.
 */

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), download: vi.fn() }));
vi.mock("../../lib/api", () => ({ api: { get: h.get, post: h.post } }));
vi.mock("../../lib/download", () => ({ downloadViaApi: h.download }));

import {
  chargerApercuLot, ecrireParametres, lireDetail, lireListe, lireMeta, lireParametres, lireReception, lireSources, messageErreurDetail,
  MESSAGE_DETAIL_DROITS, MESSAGE_LOT_INCONNU, parametresListe, recevoirLot, statutHttpDe, telechargerErreursLot, TAILLE_PAGE,
  useDetailLot, useListeLots, useMetaImport, useValeurRetardee,
} from "./useLotsImport";
import { lotDetail, lotListe, reponseApercu } from "../../components/imports/lotsDeTest";

beforeEach(() => { h.get.mockReset(); h.post.mockReset(); h.download.mockReset(); });

const META = {
  formats: [{ code: "csv", libelle: "CSV pivot", aide: "Séparateur ;" }],
  tailleMaxOctets: 52428800, limiteLignes: 100000, statuts: ["RECU", "REJETE"],
};

function enveloppe(defaut: { retry?: unknown } = { retry: false }) {
  const client = new QueryClient({ defaultOptions: { queries: defaut as never } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("L'adresse : filtres et lot", () => {
  it("lit les filtres et le lot", () => {
    const r = lireParametres(new URLSearchParams("statut=REJETE&source=ONR_BDR&q=rn1&lot=abc"));
    expect(r).toEqual({ filtres: { statut: "REJETE", source: "ONR_BDR", q: "rn1" }, lot: "abc" });
  });

  it("sans paramètre : aucun filtre, aucun lot", () => {
    expect(lireParametres(new URLSearchParams(""))).toEqual({ filtres: { statut: "", source: "", q: "" }, lot: null });
  });

  it("ignore un statut inventé à la main (le serveur répondrait 400) mais garde le reste", () => {
    const r = lireParametres(new URLSearchParams("statut=VALIDE&source=ANASUR"));
    expect(r.filtres).toEqual({ statut: "", source: "ANASUR", q: "" });
  });

  it("un lot vide ou fait d'espaces n'est pas un lot", () => {
    expect(lireParametres(new URLSearchParams("lot=")).lot).toBeNull();
    expect(lireParametres(new URLSearchParams("lot=%20%20")).lot).toBeNull();
  });

  it("écrit les filtres sans toucher aux autres paramètres, et retire les valeurs vides", () => {
    const base = new URLSearchParams("lot=abc&autre=1&statut=REJETE");
    const suivants = ecrireParametres(base, { filtres: { statut: "", source: "ONR_BDR", q: "rn1" } });
    expect(suivants.get("lot")).toBe("abc");
    expect(suivants.get("autre")).toBe("1");
    expect(suivants.has("statut")).toBe(false);
    expect(suivants.get("source")).toBe("ONR_BDR");
    expect(suivants.get("q")).toBe("rn1");
    // La base n'est pas modifiée.
    expect(base.get("statut")).toBe("REJETE");
  });

  it("choisir ou fermer un lot ne touche pas aux filtres", () => {
    const base = new URLSearchParams("statut=REJETE&q=rn1");
    const avecLot = ecrireParametres(base, { lot: "l1" });
    expect(avecLot.toString()).toBe("statut=REJETE&q=rn1&lot=l1");
    expect(ecrireParametres(avecLot, { lot: null }).toString()).toBe("statut=REJETE&q=rn1");
  });

  it("q fait d'espaces est retiré ; q avec du texte garde ses espaces (on ne mange pas une espace en cours de frappe)", () => {
    expect(ecrireParametres(new URLSearchParams(), { filtres: { statut: "", source: "", q: "   " } }).has("q")).toBe(false);
    expect(ecrireParametres(new URLSearchParams(), { filtres: { statut: "", source: "", q: "rn1 " } }).get("q")).toBe("rn1 ");
  });
});

describe("Paramètres de la route de liste (stricte côté serveur)", () => {
  it("n'envoie que ce qui a une valeur", () => {
    expect(parametresListe({ statut: "", source: "", q: "" }, null)).toEqual({ limite: TAILLE_PAGE });
    expect(parametresListe({ statut: "REJETE", source: "ONR_BDR", q: " rn1 " }, "CURSEUR")).toEqual({
      limite: TAILLE_PAGE, statut: "REJETE", source: "ONR_BDR", q: "rn1", curseur: "CURSEUR",
    });
  });

  it("q fait d'espaces n'est pas envoyé (le serveur répondrait 400)", () => {
    expect(parametresListe({ statut: "", source: "", q: "    " }, null)).not.toHaveProperty("q");
  });

  it("q est plafonné à 100 signes (le serveur refuse au-delà : un collage long n'est pas une faute)", () => {
    const p = parametresListe({ statut: "", source: "", q: "x".repeat(250) }, null);
    expect((p.q as string).length).toBe(100);
  });
});

describe("Une réponse inattendue est une erreur, jamais un vide", () => {
  it("meta : formats, taille et lignes sont lus ; un format sans code est refusé", () => {
    expect(lireMeta(META)).toEqual({ ...META });
    expect(() => lireMeta({})).toThrow();
    expect(() => lireMeta({ ...META, formats: [{ libelle: "x" }] })).toThrow();
    expect(() => lireMeta({ ...META, tailleMaxOctets: 0 })).toThrow();
    expect(() => lireMeta({ ...META, limiteLignes: "100" })).toThrow();
  });

  it("meta : une aide absente devient un texte vide, jamais un texte inventé ; les statuts absents, une liste vide", () => {
    const m = lireMeta({ formats: [{ code: "csv", libelle: "CSV" }], tailleMaxOctets: 10, limiteLignes: 5 });
    expect(m.formats[0].aide).toBe("");
    expect(m.statuts).toEqual([]);
  });

  it("sources : les entrées mal formées sont écartées, un corps sans `sources` est refusé", () => {
    expect(lireSources({ sources: [{ valeur: "A", nombreLots: 2 }, { valeur: "", nombreLots: 1 }, { nope: 1 }] })).toEqual([{ valeur: "A", nombreLots: 2 }]);
    expect(() => lireSources({})).toThrow();
  });

  it("sources : triées par ordre alphabétique (le serveur laisse le tri au client)", () => {
    const r = lireSources({ sources: [{ valeur: "ONR_BDR", nombreLots: 1 }, { valeur: "ANASUR", nombreLots: 2 }, { valeur: "onr_bdr", nombreLots: 1 }] });
    expect(r.map((s) => s.valeur)).toEqual(["ANASUR", "onr_bdr", "ONR_BDR"]);
  });

  it("liste : le total est exigé (un chiffre ne s'invente pas), `suivant` absent est null", () => {
    expect(lireListe({ lots: [lotListe()], total: 1 })).toMatchObject({ suivant: null, total: 1 });
    expect(lireListe({ lots: [], total: 0, suivant: "abc" }).suivant).toBe("abc");
    expect(() => lireListe({ lots: [] })).toThrow();
    expect(() => lireListe({ total: 0 })).toThrow();
    expect(() => lireListe({ lots: [{ reference: "x" }], total: 1 })).toThrow();
  });

  it("détail : tout ce que le panneau lit est exigé", () => {
    expect(lireDetail(lotDetail()).reference).toBe("IMP-2026-00001");
    expect(() => lireDetail({})).toThrow();
    expect(() => lireDetail({ ...lotDetail(), etapes: undefined })).toThrow();
    expect(() => lireDetail({ ...lotDetail(), controle: null })).toThrow();
  });

  it("réception : l'identifiant, la référence, le statut et les compteurs sont exigés", () => {
    const ok = { id: "l", reference: "R", statut: "REJETE", dejaRecu: false, motifRejetLot: null, compteurs: { lues: 0, validees: 0, rejetees: 0, ignorees: 0 } };
    expect(lireReception(ok).id).toBe("l");
    expect(() => lireReception({ ...ok, compteurs: undefined })).toThrow();
    expect(() => lireReception(null)).toThrow();
  });
});

describe("Erreurs HTTP", () => {
  it("lit le code d'une erreur axios, ou null sans réponse", () => {
    expect(statutHttpDe({ response: { status: 403 } })).toBe(403);
    expect(statutHttpDe(new Error("Network Error"))).toBeNull();
    expect(statutHttpDe(null)).toBeNull();
    expect(statutHttpDe({ response: {} })).toBeNull();
  });

  it("le message du détail dit un lot inconnu (404) ou un droit manquant (403)", () => {
    expect(messageErreurDetail({ response: { status: 404 } })).toBe(MESSAGE_LOT_INCONNU);
    expect(messageErreurDetail({ response: { status: 403 } })).toBe(MESSAGE_DETAIL_DROITS);
    expect(messageErreurDetail({ response: { status: 500 } })).toBe(true);
    expect(messageErreurDetail(new Error("x"))).toBe(true);
  });
});

describe("useValeurRetardee", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ne suit la valeur qu'après le délai sans changement", () => {
    const { result, rerender } = renderHook(({ v }) => useValeurRetardee(v, 300), { initialProps: { v: "" } });
    rerender({ v: "r" });
    rerender({ v: "rn" });
    rerender({ v: "rn1" });
    expect(result.current).toBe("");
    act(() => { vi.advanceTimersByTime(299); });
    expect(result.current).toBe("");
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe("rn1");
  });

  it("une frappe qui arrive avant le délai repart de zéro", () => {
    const { result, rerender } = renderHook(({ v }) => useValeurRetardee(v, 300), { initialProps: { v: "a" } });
    rerender({ v: "ab" });
    act(() => { vi.advanceTimersByTime(250); });
    rerender({ v: "abc" });
    act(() => { vi.advanceTimersByTime(250); });
    expect(result.current).toBe("a");
    act(() => { vi.advanceTimersByTime(50); });
    expect(result.current).toBe("abc");
  });
});

describe("Requêtes", () => {
  it("la liste envoie les paramètres par `params` et suit le curseur `suivant`", async () => {
    h.get
      .mockResolvedValueOnce({ data: { lots: [lotListe({ id: "a" })], suivant: "CUR1", total: 2 } })
      .mockResolvedValueOnce({ data: { lots: [lotListe({ id: "b", reference: "IMP-2" })], suivant: null, total: 2 } });
    const { result } = renderHook(() => useListeLots({ statut: "REJETE", source: "ONR_BDR", q: "rn1" }), { wrapper: enveloppe() });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    expect(h.get).toHaveBeenCalledWith("/v2/imports", expect.objectContaining({ params: { limite: TAILLE_PAGE, statut: "REJETE", source: "ONR_BDR", q: "rn1" } }));
    expect(result.current.hasNextPage).toBe(true);
    await act(async () => { await result.current.fetchNextPage(); });
    expect(h.get).toHaveBeenLastCalledWith("/v2/imports", expect.objectContaining({ params: expect.objectContaining({ curseur: "CUR1" }) }));
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(result.current.hasNextPage).toBe(false);
  });

  it("une liste mal formée est une erreur de requête, pas une liste vide", async () => {
    h.get.mockResolvedValue({ data: {} });
    const { result } = renderHook(() => useListeLots({ statut: "", source: "", q: "" }), { wrapper: enveloppe() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it("/meta mal formée est une erreur : aucun format n'est inventé", async () => {
    h.get.mockResolvedValue({ data: { formats: "csv" } });
    const { result } = renderHook(() => useMetaImport(), { wrapper: enveloppe() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it("le détail : pas de requête sans lot ; l'identifiant est encodé dans le chemin", async () => {
    const { result, rerender } = renderHook(({ id }) => useDetailLot(id), { wrapper: enveloppe(), initialProps: { id: null as string | null } });
    expect(result.current.fetchStatus).toBe("idle");
    expect(h.get).not.toHaveBeenCalled();
    h.get.mockResolvedValue({ data: lotDetail({ id: "a/b?c" }) });
    rerender({ id: "a/b?c" });
    await waitFor(() => expect(result.current.data?.reference).toBe("IMP-2026-00001"));
    expect(h.get.mock.calls[0][0]).toBe("/v2/imports/a%2Fb%3Fc");
  });

  it("un refus du serveur (404) n'est pas relancé, même quand le client relance par défaut", async () => {
    h.get.mockRejectedValue({ response: { status: 404 } });
    const { result } = renderHook(() => useDetailLot("inconnu"), { wrapper: enveloppe({ retry: 3 }) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(h.get).toHaveBeenCalledTimes(1);
  });

  it("une panne réseau suit la règle du client : une relance quand il en annonce une", async () => {
    h.get.mockRejectedValueOnce(new Error("Network Error")).mockResolvedValueOnce({ data: lotDetail() });
    const client = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 1 } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useDetailLot("l1"), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(h.get).toHaveBeenCalledTimes(2);
  });
});

describe("Actions", () => {
  const donnees = { systemeSource: "ONR_BDR", format: "csv" as const, methodeSource: "export", versionMapping: "v0", autorisationRef: "AUT-2026-01" };
  const reponse = { id: "l9", reference: "IMP-9", statut: "VALIDE_SCHEMA", dejaRecu: false, motifRejetLot: null, compteurs: { lues: 1, validees: 1, rejetees: 0, ignorees: 0 } };

  it("la réception envoie les cinq champs PUIS le fichier, en multipart", async () => {
    h.post.mockResolvedValue({ data: reponse });
    const fichier = new File(["a;b\n"], "lot.csv", { type: "text/csv" });
    await expect(recevoirLot(donnees, fichier, { onProgression: vi.fn() })).resolves.toMatchObject({ id: "l9" });
    const [url, corps] = h.post.mock.calls[0] as [string, FormData];
    expect(url).toBe("/v2/imports");
    expect([...corps.keys()]).toEqual(["systemeSource", "format", "methodeSource", "versionMapping", "autorisationRef", "fichier"]);
    expect(corps.get("autorisationRef")).toBe("AUT-2026-01");
    expect((corps.get("fichier") as File).name).toBe("lot.csv");
  });

  it("la progression d'envoi est relayée ; un total inconnu reste null", async () => {
    const onProgression = vi.fn();
    h.post.mockImplementation(async (_u: string, _c: FormData, cfg: { onUploadProgress: (e: { loaded: number; total?: number }) => void }) => {
      cfg.onUploadProgress({ loaded: 10, total: 100 });
      cfg.onUploadProgress({ loaded: 20, total: undefined });
      return { data: reponse };
    });
    await recevoirLot(donnees, new File(["x"], "a.csv"), { onProgression });
    expect(onProgression).toHaveBeenNthCalledWith(1, { envoye: 10, total: 100 });
    expect(onProgression).toHaveBeenNthCalledWith(2, { envoye: 20, total: null });
  });

  it("l'erreur axios est rejetée telle quelle (même objet)", async () => {
    const erreur = { response: { status: 400, data: { code: "FICHIER_VIDE" } } };
    h.post.mockRejectedValue(erreur);
    await expect(recevoirLot(donnees, new File(["x"], "a.csv"), { onProgression: vi.fn() })).rejects.toBe(erreur);
  });

  it("une réponse de réception mal formée est rejetée (la réception n'est pas confirmée)", async () => {
    h.post.mockResolvedValue({ data: {} });
    await expect(recevoirLot(donnees, new File(["x"], "a.csv"), { onProgression: vi.fn() })).rejects.toThrow();
  });

  it("le téléchargement des erreurs passe par l'API authentifiée, avec un nom de fichier sûr", async () => {
    h.download.mockResolvedValue(undefined);
    await telechargerErreursLot({ id: "lot-1", reference: "IMP-2026-00001" });
    expect(h.download).toHaveBeenCalledWith("/v2/imports/lot-1/erreurs.csv", "IMP-2026-00001-erreurs.csv");
    await telechargerErreursLot({ id: "a/b", reference: "../x y" });
    expect(h.download).toHaveBeenLastCalledWith("/v2/imports/a%2Fb/erreurs.csv", ".._x_y-erreurs.csv");
  });

  it("l'aperçu est lu par la route du lot, avec les paramètres demandés", async () => {
    h.get.mockResolvedValue({ data: reponseApercu({ suivant: 20, tronque: true }) });
    const r = await chargerApercuLot("lot-1", { limite: 20, statut: "REJETEE", apres: 40 });
    expect(h.get).toHaveBeenCalledWith("/v2/imports/lot-1/apercu", { params: { limite: 20, statut: "REJETEE", apres: 40 } });
    expect(r).toMatchObject({ suivant: 20, tronque: true });
    h.get.mockResolvedValue({ data: {} });
    await expect(chargerApercuLot("lot-1", {})).rejects.toThrow();
  });
});
