import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { violationsAccessibilite } from "../../test/accessibilite";

/**
 * Le bandeau d'arret de la synchronisation : ce que ces tests defendent.
 *   - il ne se montre que si le serveur a arrete l'envoi (appareil retire, compte inactif) ;
 *   - c'est une alerte (`role="alert"`) SANS bouton de fermeture : l'agent ne peut pas la masquer ;
 *   - il dit que les saisies sont conservees et qu'il faut contacter le responsable ;
 *   - « Réessayer » est UN geste, explique, sans relance automatique : un clic = une levee d'arret + un cycle ;
 *   - 0 violation axe-core (WCAG 2.1 A et AA, contraste exclu : jsdom ne le calcule pas).
 * Le bandeau de SUSPENSION de l'enregistrement d'appareil (403 APPAREIL_REVOCATION_RECENTE) est d'une autre nature : un statut
 * (`role="status"`), jamais une alerte, qui ne dit pas que l'appareil est retire, avec un geste manuel et aucun minuteur d'interface.
 * La detection de l'arret et la synchronisation sont simulees : leur comportement reel est dans `lib/offlineSync.droits.test.ts`.
 */

const h = vi.hoisted(() => {
  const ecouteurs = new Set<() => void>();
  return {
    ecouteurs,
    snap: { appareilRevoque: false, compteInactif: false, enregistrementSuspendu: false },
    poser(appareilRevoque: boolean, compteInactif: boolean) {
      h.snap = { ...h.snap, appareilRevoque, compteInactif };
      for (const e of [...ecouteurs]) e();
    },
    /** Pose ou leve la suspension de l'enregistrement d'appareil, comme le fait `offlineSync` (etat + notification). */
    poserSuspension(suspendu: boolean, reessayerLeMs: number | null = null) {
      h.enreg = suspendu
        ? { suspendu: true, reessayerLeMs, message: "Un de vos appareils vient d'être retiré. Patientez quelques minutes avant d'enregistrer ce téléphone, ou contactez votre responsable." }
        : { suspendu: false, reessayerLeMs: null, message: null };
      h.snap = { ...h.snap, enregistrementSuspendu: suspendu };
      for (const e of [...ecouteurs]) e();
    },
    enreg: { suspendu: false, reessayerLeMs: null, message: null } as { suspendu: boolean; reessayerLeMs: number | null; message: string | null },
    lever: vi.fn(),
    sync: vi.fn(),
    /** Ce que `etatSynchronisation()` repond apres le cycle d'essai. */
    messageApresEssai: null as string | null,
  };
});

vi.mock("../../hooks/useOfflineSync", async () => {
  const { useSyncExternalStore } = await import("react");
  const abonner = (cb: () => void) => { h.ecouteurs.add(cb); return () => { h.ecouteurs.delete(cb); }; };
  return { useOfflineSync: () => ({ ...useSyncExternalStore(abonner, () => h.snap), pendingCount: 0, syncing: false }) };
});
vi.mock("../../lib/offlineSync", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  leverArretSynchronisation: (...a: unknown[]) => h.lever(...a),
  syncPendingOfflineData: (...a: unknown[]) => h.sync(...a),
  etatSynchronisation: () => ({ appareilRevoque: false, compteInactif: false, message: h.messageApresEssai }),
  etatEnregistrementAppareil: () => h.enreg,
}));

import { MESSAGE_APPAREIL_REVOQUE, MESSAGE_COMPTE_INACTIF, MESSAGE_REVOCATION_RECENTE } from "../../lib/offlineSync";
import { BandeauSynchronisation } from "./BandeauSynchronisation";

beforeEach(() => {
  h.snap = { appareilRevoque: false, compteInactif: false, enregistrementSuspendu: false };
  h.enreg = { suspendu: false, reessayerLeMs: null, message: null };
  h.messageApresEssai = null;
  h.lever.mockReset().mockImplementation(() => h.poser(false, false));
  h.sync.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("quand il se montre", () => {
  it("rien n'est arrete : rien n'est rendu", () => {
    const { container } = render(<BandeauSynchronisation />);
    expect(container).toBeEmptyDOMElement();
  });

  it("appareil retire : une alerte avec le message exact, les saisies conservees, le responsable a contacter", () => {
    h.snap = { ...h.snap, appareilRevoque: true, compteInactif: false };
    render(<BandeauSynchronisation />);
    const alerte = screen.getByRole("alert");
    expect(alerte).toHaveTextContent(MESSAGE_APPAREIL_REVOQUE);
    expect(alerte).not.toHaveTextContent(MESSAGE_COMPTE_INACTIF);
    expect(alerte).toHaveTextContent(/rien ne part tant que cette situation dure/);
    expect(alerte).toHaveTextContent(/rien n'est supprimé de ce téléphone/);
    expect(alerte).toHaveTextContent(/Contactez votre responsable/);
  });

  it("compte inactif : une alerte avec le message exact", () => {
    h.snap = { ...h.snap, appareilRevoque: false, compteInactif: true };
    render(<BandeauSynchronisation />);
    expect(screen.getByRole("alert")).toHaveTextContent(MESSAGE_COMPTE_INACTIF);
    expect(screen.getByRole("alert")).not.toHaveTextContent(MESSAGE_APPAREIL_REVOQUE);
  });

  it("les deux causes ensemble : les deux messages", () => {
    h.snap = { ...h.snap, appareilRevoque: true, compteInactif: true };
    render(<BandeauSynchronisation />);
    expect(screen.getByRole("alert")).toHaveTextContent(MESSAGE_APPAREIL_REVOQUE);
    expect(screen.getByRole("alert")).toHaveTextContent(MESSAGE_COMPTE_INACTIF);
  });

  it("n'est PAS masquable : aucun bouton de fermeture, un seul bouton (« Réessayer »)", () => {
    h.snap = { ...h.snap, appareilRevoque: true, compteInactif: false };
    render(<BandeauSynchronisation />);
    const boutons = screen.getAllByRole("button");
    expect(boutons).toHaveLength(1);
    expect(boutons[0]).toHaveTextContent("Réessayer maintenant");
    expect(screen.queryByRole("button", { name: /fermer|masquer|ignorer|ok/i })).not.toBeInTheDocument();
  });

  it("apparait et disparait avec l'etat du magasin (sans rechargement)", async () => {
    render(<BandeauSynchronisation />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    act(() => h.poser(true, false));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    act(() => h.poser(false, false));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("« Réessayer » : un geste, jamais une boucle", () => {
  it("ne fait RIEN tout seul : ni a l'affichage, ni avec le temps", async () => {
    vi.useFakeTimers();
    h.snap = { ...h.snap, appareilRevoque: true, compteInactif: false };
    render(<BandeauSynchronisation />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(h.lever).not.toHaveBeenCalled();
    expect(h.sync).not.toHaveBeenCalled();
  });

  it("explique ce que fait le bouton, et le bouton y est relie (aria-describedby)", () => {
    h.snap = { ...h.snap, appareilRevoque: true, compteInactif: false };
    render(<BandeauSynchronisation />);
    const bouton = screen.getByRole("button", { name: "Réessayer maintenant" });
    const id = bouton.getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    const explication = document.getElementById(id!)!;
    expect(explication).toHaveTextContent(/lève l'arrêt et tente un seul envoi/);
    expect(explication).toHaveTextContent(/Si le serveur refuse encore, l'arrêt revient/);
    expect(explication).toHaveTextContent(/après avoir été prévenu que la situation est réglée/);
  });

  it("un clic : l'arret est leve UNE fois, UN cycle est lance, le bandeau reste lisible et le bouton inactif pendant l'essai", async () => {
    h.snap = { ...h.snap, appareilRevoque: true, compteInactif: false };
    let finir: () => void = () => undefined;
    h.sync.mockImplementation(() => new Promise<void>((r) => { finir = r; }));
    const user = userEvent.setup();
    render(<BandeauSynchronisation />);
    await user.click(screen.getByRole("button", { name: "Réessayer maintenant" }));

    expect(h.lever).toHaveBeenCalledTimes(1);
    expect(h.sync).toHaveBeenCalledTimes(1);
    // « Réessayer » est un geste de l'agent : le cycle est MANUEL (il leve aussi la suspension de l'enregistrement d'appareil).
    expect(h.sync).toHaveBeenCalledWith({ manuel: true });
    // L'arret est leve pendant l'essai, mais le message et le bouton (inactif) restent a l'ecran.
    expect(screen.getByRole("alert")).toHaveTextContent(MESSAGE_APPAREIL_REVOQUE);
    expect(screen.getByRole("button", { name: "Essai en cours…" })).toBeDisabled();

    h.messageApresEssai = MESSAGE_APPAREIL_REVOQUE;
    await act(async () => { h.poser(true, false); finir(); });
    expect(await screen.findByText("Essai fait : le serveur refuse toujours. Vos saisies sont conservées.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Réessayer maintenant" })).toBeEnabled();
    expect(h.lever).toHaveBeenCalledTimes(1);
    expect(h.sync).toHaveBeenCalledTimes(1);
  });

  it("arret levé et rien ne le reconfirme : le dit SANS annoncer une reprise, puis le message s'efface", async () => {
    h.snap = { ...h.snap, appareilRevoque: false, compteInactif: true };
    const user = userEvent.setup();
    render(<BandeauSynchronisation />);
    await user.click(screen.getByRole("button", { name: "Réessayer maintenant" }));
    const statut = await screen.findByRole("status");
    expect(statut).toHaveTextContent("L'arrêt est levé. Il reviendra si le serveur refuse encore le prochain envoi ; sans saisie à envoyer, rien n'a été vérifié.");
    expect(statut).not.toHaveTextContent(/reprise|repris/i);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("le compte rendu d'essai disparait apres quelques secondes", async () => {
    h.snap = { ...h.snap, appareilRevoque: false, compteInactif: true };
    render(<BandeauSynchronisation />);
    vi.useFakeTimers();
    await act(async () => { screen.getByRole("button", { name: "Réessayer maintenant" }).click(); });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("status")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("une erreur inattendue du cycle ne laisse pas le bouton inactif", async () => {
    h.snap = { ...h.snap, appareilRevoque: true, compteInactif: false };
    h.sync.mockRejectedValue(new Error("boom"));
    h.messageApresEssai = MESSAGE_APPAREIL_REVOQUE;
    const user = userEvent.setup();
    render(<BandeauSynchronisation />);
    await user.click(screen.getByRole("button", { name: "Réessayer maintenant" }));
    await act(async () => { h.poser(true, false); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Réessayer maintenant" })).toBeEnabled());
  });
});

describe("enregistrement d'appareil suspendu (403 APPAREIL_REVOCATION_RECENTE)", () => {
  const ECHEANCE = new Date(2026, 9, 25, 14, 35, 0).getTime();

  it("un statut, PAS une alerte : le message du serveur, les saisies conservees, l'echeance en clair", () => {
    h.poserSuspension(true, ECHEANCE);
    render(<BandeauSynchronisation />);
    const statut = screen.getByRole("status");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(statut).toHaveTextContent(MESSAGE_REVOCATION_RECENTE);
    expect(statut).toHaveTextContent(/Vos saisies sont conservées/);
    expect(statut).toHaveTextContent(/Un nouvel essai aura lieu automatiquement vers \d{1,2}:\d{2}/);
    expect(screen.getByRole("button", { name: "Réessayer maintenant" })).toBeEnabled();
  });

  it("ne dit PAS que l'appareil est retire, et se distingue des bandeaux d'arret", () => {
    h.poserSuspension(true, ECHEANCE);
    render(<BandeauSynchronisation />);
    const statut = screen.getByRole("status");
    expect(statut).not.toHaveTextContent(MESSAGE_APPAREIL_REVOQUE);
    expect(statut).not.toHaveTextContent(MESSAGE_COMPTE_INACTIF);
    expect(statut).not.toHaveTextContent(/Cet appareil a été retiré/);
    expect(statut).not.toHaveTextContent(/envoi de vos saisies est arrêté/i);
    expect(screen.getByTestId("bandeau-enregistrement-suspendu")).toBeInTheDocument();
    expect(screen.queryByTestId("bandeau-synchronisation")).not.toBeInTheDocument();
  });

  it("echeance inconnue : aucune heure inventee", () => {
    h.poserSuspension(true, null);
    render(<BandeauSynchronisation />);
    expect(screen.getByRole("status")).not.toHaveTextContent(/vers \d/);
    expect(screen.getByRole("status")).toHaveTextContent(/Vos saisies sont conservées/);
  });

  it("rien tant que l'enregistrement n'est pas suspendu ; apparait et disparait avec l'etat, sans rechargement", () => {
    render(<BandeauSynchronisation />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    act(() => h.poserSuspension(true, ECHEANCE));
    expect(screen.getByRole("status")).toBeInTheDocument();
    act(() => h.poserSuspension(false));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("un appareil retire prime : seul le bandeau d'arret (alerte) se montre", () => {
    h.poserSuspension(true, ECHEANCE);
    h.snap = { ...h.snap, appareilRevoque: true };
    render(<BandeauSynchronisation />);
    expect(screen.getByRole("alert")).toHaveTextContent(MESSAGE_APPAREIL_REVOQUE);
    expect(screen.queryByTestId("bandeau-enregistrement-suspendu")).not.toBeInTheDocument();
  });

  it("aucun minuteur d'interface : ni a l'affichage, ni avec le temps, rien n'est relance", async () => {
    vi.useFakeTimers();
    h.poserSuspension(true, Date.now() + 60_000);
    render(<BandeauSynchronisation />);
    await act(async () => { await vi.advanceTimersByTimeAsync(40 * 60_000); });
    expect(h.sync).not.toHaveBeenCalled();
    expect(h.lever).not.toHaveBeenCalled();
  });

  it("« Réessayer maintenant » : UN cycle MANUEL, sans lever l'arret, bouton inactif pendant l'essai", async () => {
    h.poserSuspension(true, ECHEANCE);
    let finir: () => void = () => undefined;
    h.sync.mockImplementation(() => new Promise<void>((r) => { finir = r; }));
    const user = userEvent.setup();
    render(<BandeauSynchronisation />);
    await user.click(screen.getByRole("button", { name: "Réessayer maintenant" }));
    expect(h.sync).toHaveBeenCalledTimes(1);
    expect(h.sync).toHaveBeenCalledWith({ manuel: true });
    expect(h.lever).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Essai en cours…" })).toBeDisabled();
    await act(async () => { finir(); });
  });

  it("geste reussi : la suspension tombe, le bandeau disparait", async () => {
    h.poserSuspension(true, ECHEANCE);
    h.sync.mockImplementation(async () => { h.poserSuspension(false); });
    const user = userEvent.setup();
    render(<BandeauSynchronisation />);
    await user.click(screen.getByRole("button", { name: "Réessayer maintenant" }));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("geste sans effet : le dit sans annoncer de reprise, puis le compte rendu s'efface", async () => {
    h.poserSuspension(true, ECHEANCE);
    render(<BandeauSynchronisation />);
    vi.useFakeTimers();
    await act(async () => { screen.getByRole("button", { name: "Réessayer maintenant" }).click(); });
    await act(async () => { await Promise.resolve(); });
    const statut = screen.getByRole("status");
    expect(statut).toHaveTextContent("Essai fait : l'enregistrement reste en attente. Vos saisies sont conservées.");
    expect(statut).not.toHaveTextContent(/reprise|repris/i);
    expect(screen.getByRole("button", { name: "Réessayer maintenant" })).toBeEnabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
    expect(screen.getByRole("status")).not.toHaveTextContent(/Essai fait/);
  });

  it("une erreur inattendue du cycle ne laisse pas le bouton inactif", async () => {
    h.poserSuspension(true, ECHEANCE);
    h.sync.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    render(<BandeauSynchronisation />);
    await user.click(screen.getByRole("button", { name: "Réessayer maintenant" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Réessayer maintenant" })).toBeEnabled());
  });

  it("explique le geste, et le bouton y est relie (aria-describedby)", () => {
    h.poserSuspension(true, ECHEANCE);
    render(<BandeauSynchronisation />);
    const bouton = screen.getByRole("button", { name: "Réessayer maintenant" });
    const explication = document.getElementById(bouton.getAttribute("aria-describedby")!)!;
    expect(explication).toHaveTextContent(/Un seul essai, à votre demande/);
    expect(explication).toHaveTextContent(/le délai reprend et vos saisies restent en place/);
  });
});

describe("accessibilite (axe-core, WCAG 2.1 A et AA, contraste exclu)", () => {
  it("0 violation : enregistrement suspendu", async () => {
    h.poserSuspension(true, new Date(2026, 9, 25, 14, 35, 0).getTime());
    const { container } = render(<BandeauSynchronisation />);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("0 violation : enregistrement suspendu, apres un essai sans effet", async () => {
    h.poserSuspension(true, null);
    const user = userEvent.setup();
    const { container } = render(<BandeauSynchronisation />);
    await user.click(screen.getByRole("button", { name: "Réessayer maintenant" }));
    await screen.findByText(/Essai fait : l'enregistrement reste en attente/);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("0 violation : appareil retire", async () => {
    h.snap = { ...h.snap, appareilRevoque: true, compteInactif: false };
    const { container } = render(<BandeauSynchronisation />);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("0 violation : les deux causes, apres un essai refuse", async () => {
    h.snap = { ...h.snap, appareilRevoque: true, compteInactif: true };
    h.sync.mockImplementation(async () => { h.poser(true, true); });
    h.messageApresEssai = MESSAGE_APPAREIL_REVOQUE;
    const user = userEvent.setup();
    const { container } = render(<BandeauSynchronisation />);
    await user.click(screen.getByRole("button", { name: "Réessayer maintenant" }));
    await screen.findByText(/Essai fait : le serveur refuse toujours/);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("0 violation : arret levé, compte rendu seul", async () => {
    h.snap = { ...h.snap, appareilRevoque: true, compteInactif: false };
    const user = userEvent.setup();
    const { container } = render(<BandeauSynchronisation />);
    await user.click(screen.getByRole("button", { name: "Réessayer maintenant" }));
    await screen.findByRole("status");
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});
