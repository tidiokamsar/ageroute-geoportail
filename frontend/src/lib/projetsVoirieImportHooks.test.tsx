import { StrictMode, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useEnvoi } from "./projetsVoirieImportHooks";

/** Envoi unique et annulable : pas de double envoi, annulation par AbortController, erreurs classees, robustesse a StrictMode. */

const bloquee = () => {
  let resoudre!: (v: string) => void;
  let rejeter!: (e: unknown) => void;
  const p = new Promise<string>((ok, ko) => { resoudre = ok; rejeter = ko; });
  return { p, resoudre, rejeter };
};

describe("useEnvoi", () => {
  it("un seul envoi a la fois : le second, parti avant la fin du premier, est ignore", async () => {
    const { result } = renderHook(() => useEnvoi());
    const b = bloquee();
    let premier!: Promise<unknown>;
    let second: unknown;
    await act(async () => {
      premier = result.current.lancer("apercu", () => b.p);
      second = await result.current.lancer("apercu", async () => "deux");
    });
    expect(second).toEqual({ statut: "ignore" });
    expect(result.current.occupe).toBe(true);
    await act(async () => { b.resoudre("un"); await premier; });
    expect(await premier).toEqual({ statut: "ok", valeur: "un" });
    expect(result.current.occupe).toBe(false);
  });

  it("annuler() avorte le signal ; l'issue est « annule », pas une erreur", async () => {
    const { result } = renderHook(() => useEnvoi());
    let signal: AbortSignal | undefined;
    let issue: unknown;
    await act(async () => {
      const p = result.current.lancer("inventaire", (o) => new Promise<string>((_ok, ko) => {
        signal = o.signal;
        o.signal?.addEventListener("abort", () => ko(Object.assign(new Error("canceled"), { code: "ERR_CANCELED", name: "CanceledError" })));
      }));
      result.current.annuler();
      issue = await p;
    });
    expect(signal?.aborted).toBe(true);
    expect(issue).toEqual({ statut: "annule" });
    expect(result.current.occupe).toBe(false);
  });

  it("une erreur HTTP est classee (code, statut, delai d'attente) et rend la main", async () => {
    const { result } = renderHook(() => useEnvoi());
    let issue: { statut: string; erreur?: { code: string | null; status: number | null; retryAfterS?: number | null; genre: string } } | undefined;
    await act(async () => {
      issue = await result.current.lancer("apercu", async () => { throw { response: { status: 429, data: { error: "x" }, headers: { "retry-after": "12" } } }; }) as typeof issue;
    });
    expect(issue?.statut).toBe("erreur");
    expect(issue?.erreur).toMatchObject({ status: 429, retryAfterS: 12, genre: "serveur" });
    expect(result.current.occupe).toBe(false);
    let suite: unknown;
    await act(async () => { suite = await result.current.lancer("apercu", async () => 1); });
    expect(suite).toEqual({ statut: "ok", valeur: 1 });
  });

  it("progression : pourcentage, puis « envoye » a 100 %", async () => {
    const { result } = renderHook(() => useEnvoi());
    const b = bloquee();
    let p!: Promise<unknown>;
    await act(async () => { p = result.current.lancer("depot", async (o) => { o.onProgression?.(25, 100); await b.p; return "ok"; }); });
    expect(result.current.etat).toMatchObject({ nom: "depot", progression: 25, envoye: false });
    await act(async () => { b.resoudre("x"); await p; });
  });

  it("progression a 100 % : le fichier est parti, le serveur travaille", async () => {
    const { result } = renderHook(() => useEnvoi());
    const b = bloquee();
    let p!: Promise<unknown>;
    await act(async () => { p = result.current.lancer("depot", async (o) => { o.onProgression?.(100, 100); await b.p; return "ok"; }); });
    expect(result.current.etat).toMatchObject({ progression: 100, envoye: true });
    await act(async () => { b.resoudre("x"); await p; });
  });

  it("le demontage annule l'envoi en cours", async () => {
    const { result, unmount } = renderHook(() => useEnvoi());
    let signal: AbortSignal | undefined;
    const b = bloquee();
    await act(async () => { void result.current.lancer("apercu", (o) => { signal = o.signal; return b.p; }); });
    unmount();
    expect(signal?.aborted).toBe(true);
    b.resoudre("x");
  });

  it("StrictMode (double montage) : un envoi lance au montage n'est pas bloque par le nettoyage", async () => {
    const enveloppe = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const { result } = renderHook(() => useEnvoi(), { wrapper: enveloppe });
    let issue: unknown;
    await act(async () => { issue = await result.current.lancer("delta", async () => "charge"); });
    expect(issue).toEqual({ statut: "ok", valeur: "charge" });
  });
});
