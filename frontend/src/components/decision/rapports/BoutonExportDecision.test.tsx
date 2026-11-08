import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { violationsAccessibilite } from "../../../test/accessibilite";

/**
 * Bouton « Exporter » de la page (lot 6) : inactif AVEC sa raison visible, envoie les memes filtres que la page, recoit le
 * fichier par un appel authentifie (blob), affiche le mot du serveur quand il refuse (403, 413).
 */
const h = vi.hoisted(() => ({
  user: { id: "u1", role: "GESTIONNAIRE", modulesAutorises: ["rapports", "programmation", "marches"] } as { id: string; role: string; modulesAutorises: string[] } | null,
  posts: [] as { url: string; corps: unknown; config: unknown }[],
  echec: null as null | { status: number; corps: unknown },
}));
vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: h.user }) }));
vi.mock("../../../lib/api", () => ({
  api: {
    post: vi.fn(async (url: string, corps: unknown, config: unknown) => {
      h.posts.push({ url, corps, config });
      if (h.echec) throw { response: { status: h.echec.status, data: new Blob([JSON.stringify(h.echec.corps)], { type: "application/json" }) } };
      return {
        data: new Blob(["﻿# titre;x\n"], { type: "text/csv" }),
        headers: { "content-disposition": 'attachment; filename="aide-decision-synthese-20261029-100000.csv"', "x-export-id": "id-9", "x-export-empreinte-sha256": "ab".repeat(32), "x-export-nb-lignes": "12" },
      };
    }),
  },
}));

import { BoutonExportDecision } from "./BoutonExportDecision";

function rendre(ui = <BoutonExportDecision filtres={{}} />) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  h.user = { id: "u1", role: "GESTIONNAIRE", modulesAutorises: ["rapports", "programmation", "marches"] };
  h.posts.length = 0; h.echec = null;
  URL.createObjectURL = vi.fn(() => "blob:test");
  URL.revokeObjectURL = vi.fn();
  HTMLAnchorElement.prototype.click = vi.fn();
});

describe("BoutonExportDecision", () => {
  it("exporte avec les filtres de la page par un appel authentifie (blob), sans cle dans l'URL, et le dit", async () => {
    const u = userEvent.setup({ delay: null });
    rendre(<BoutonExportDecision filtres={{ regionId: 3, classe: ["RN"] }} />);
    await u.click(screen.getByRole("button", { name: /Exporter : Rapport de synthèse \(CSV\)/ }));
    await waitFor(() => expect(h.posts).toHaveLength(1));
    expect(h.posts[0].url).toBe("/v2/aide-decision/exports");
    expect(h.posts[0].url).not.toMatch(/token|key|cle|\?/);
    expect(h.posts[0].corps).toEqual({ type: "synthese", format: "csv", filtres: { regionId: 3, classe: ["RN"] } });
    expect(h.posts[0].config).toEqual({ responseType: "blob" });
    const ok = await screen.findByText(/Fichier remis : aide-decision-synthese-20261029-100000\.csv, 12 lignes, empreinte abababababab/);
    expect(ok).toHaveAttribute("role", "status");
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
  });

  it("MUTATION DE CONTROLE : une page sans filtre exporte SANS champ filtres (tout le perimetre autorise)", async () => {
    const u = userEvent.setup({ delay: null });
    rendre();
    await u.click(screen.getByRole("button", { name: /Exporter/ }));
    await waitFor(() => expect(h.posts).toHaveLength(1));
    expect(h.posts[0].corps).toEqual({ type: "synthese", format: "csv" });
  });

  it("un LECTEUR voit le bouton inactif ET la raison en texte visible ; aucun appel", async () => {
    h.user = { id: "u2", role: "LECTEUR", modulesAutorises: ["rapports"] };
    const u = userEvent.setup({ delay: null });
    rendre();
    const b = screen.getByRole("button", { name: /Exporter/ });
    expect(b).toBeDisabled();
    expect(screen.getByText(/réservé aux rôles Administrateur et Gestionnaire/)).toBeVisible();
    expect(b).toHaveAttribute("aria-describedby");
    await u.click(b);
    expect(h.posts).toHaveLength(0);
  });

  it("sans module rapports : inactif avec sa raison ; sans compte : connexion requise", () => {
    h.user = { id: "u3", role: "GESTIONNAIRE", modulesAutorises: ["decision"] };
    const { unmount } = rendre();
    expect(screen.getByText(/module Rapports n'est pas autorisé/)).toBeVisible();
    unmount();
    h.user = null;
    rendre();
    expect(screen.getByText(/Connexion requise/)).toBeVisible();
  });

  it("un type qui exige un scenario reste inactif tant qu'aucun n'est choisi, et le dit", () => {
    rendre(<BoutonExportDecision filtres={{}} type="scenario" scenarioId={null} />);
    expect(screen.getByRole("button", { name: /Scénario de programmation/ })).toBeDisabled();
    expect(screen.getByText(/Choisissez le scénario à exporter/)).toBeVisible();
  });

  it("un refus 403 du serveur est affiche avec son message (statut dedie, pas une panne)", async () => {
    h.echec = { status: 403, corps: { error: "Accès à ce module non autorisé pour votre compte", code: "MODULE_NON_AUTORISE" } };
    const u = userEvent.setup({ delay: null });
    rendre();
    await u.click(screen.getByRole("button", { name: /Exporter/ }));
    expect(await screen.findByText(/Export refusé\./)).toBeInTheDocument();
    expect(screen.getByText(/Accès à ce module non autorisé/)).toBeInTheDocument();
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });

  it("un 413 est une alerte qui reprend le mot du serveur ; aucun fichier n'est remis", async () => {
    h.echec = { status: 413, corps: { error: "L'export porterait 12000 lignes, au-dela du plafond de 10000. Restreignez le perimetre.", code: "EXPORT_TROP_VOLUMINEUX" } };
    const u = userEvent.setup({ delay: null });
    rendre();
    await u.click(screen.getByRole("button", { name: /Exporter/ }));
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent(/Export impossible/);
    expect(alerte).toHaveTextContent(/Restreignez/);
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });

  it("sans violation d'accessibilite (actif, inactif, erreur)", async () => {
    const u = userEvent.setup({ delay: null });
    const { container } = rendre();
    expect(await violationsAccessibilite(container)).toEqual([]);
    h.echec = { status: 413, corps: { error: "trop gros" } };
    await u.click(screen.getByRole("button", { name: /Exporter/ }));
    await screen.findByRole("alert");
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});
