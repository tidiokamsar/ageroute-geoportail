import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { violationsAccessibilite } from "../test/accessibilite";

/** Panneau des capacités : replié par défaut, lit à la demande, copie le rapport, sans rien envoyer au serveur. */
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/capacitesAppareil", async (importOriginal) => {
  const reel = await importOriginal<typeof import("../lib/capacitesAppareil")>();
  return {
    ...reel,
    lireCapacites: vi.fn(async () => ({
      mesureLe: "2026-10-25T09:00:00.000Z", agentUtilisateur: "Essai",
      gps: { api: true, permission: "accordee" },
      mouvement: { deviceMotion: true, capteurAccelerometre: false, capteurGyroscope: false, autorisationExplicite: false },
      camera: { mediaDevices: true },
      stockage: { indexedDB: true, usageMo: 50, quotaMo: 500 },
      calcul: { coeursLogiques: { etat: "oui", valeur: 8 }, memoireNavigateurGo: { etat: "non_communique" }, webAssembly: true, webgl2: false, webgpu: false },
      energie: { api: false, niveauPourcent: null, enCharge: null },
      reseau: { enLigne: true, typeEffectif: "4g", debitDescendantMbps: 5 },
      ecran: { largeur: 360, hauteur: 740, ratioPixels: 3, wakeLock: true },
    })),
  };
});

import { CapacitesAppareilPanel } from "./CapacitesAppareilPanel";
import { lireCapacites } from "../lib/capacitesAppareil";
import { toast } from "../lib/toast";

afterEach(cleanup);

describe("panneau des capacités de l'appareil", () => {
  it("ne lit rien tant qu'on ne le demande pas", () => {
    render(<CapacitesAppareilPanel />);
    expect(vi.mocked(lireCapacites)).not.toHaveBeenCalled();
    expect(screen.queryByRole("list", { name: /Modules possibles/ })).not.toBeInTheDocument();
  });

  it("à la demande : modules possibles avec leur raison, valeurs lues, « non communiqué » dit comme tel", async () => {
    render(<CapacitesAppareilPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Voir les capacités de cet appareil/ }));
    const modules = await screen.findByRole("list", { name: /Modules possibles/ });
    expect(modules).toHaveTextContent(/Position GPS : possible/);
    expect(modules).toHaveTextContent(/Photos : possible/);
    const valeurs = screen.getByLabelText("Valeurs lues sur l'appareil");
    expect(valeurs).toHaveTextContent(/Cœurs logiques\s*8/);
    expect(valeurs).toHaveTextContent(/Mémoire annoncée par le navigateur\s*non communiquée/);
    expect(valeurs).toHaveTextContent(/Batterie\s*non communiquée/);
    expect(screen.getByText(/Aucune vitesse de calcul ni consommation n'est mesurée ici/)).toBeInTheDocument();
  });

  it("copie le rapport JSON, et dit si la copie est impossible", async () => {
    const ecrire = vi.fn(async (_texte: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: ecrire } });
    render(<CapacitesAppareilPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Voir les capacités/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Copier le rapport/ }));
    await vi.waitFor(() => expect(ecrire).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(ecrire.mock.calls[0][0]))).toMatchObject({ gps: { permission: "accordee" } });
    expect(vi.mocked(toast.success)).toHaveBeenCalled();
    ecrire.mockRejectedValueOnce(new Error("NotAllowedError"));
    fireEvent.click(screen.getByRole("button", { name: /Copier le rapport/ }));
    await vi.waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalled());
  });

  it("zéro violation d'accessibilité, replié et déplié", async () => {
    const { container } = render(<CapacitesAppareilPanel />);
    expect(await violationsAccessibilite(container)).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /Voir les capacités/ }));
    await screen.findByRole("list", { name: /Modules possibles/ });
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});
