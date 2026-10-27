import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { violationsAccessibilite } from "../test/accessibilite";

/**
 * Barèmes de coût : ce que ces tests défendent (lot 6 inclus).
 *   - l'écran DIT ce qui bloque : les lignes non approuvées se voient, et le bouton Approuver reste inactif tant que millésime
 *     ou largeur manque — on ne signe pas un prix illisible ;
 *   - toute édition part des champs réels de la ligne (vides pour les neuf d'origine : rien n'est deviné), exige un MOTIF, et
 *     n'envoie que ce qui change, avec la version lue ;
 *   - un libellé seul ne retire pas l'approbation : l'écran l'annonce avant l'enregistrement ;
 *   - l'approbation exige motif ET commentaire ; un refus du serveur (403 auto-validation, 409) est AFFICHÉ avec son motif, la
 *     ligne reste non approuvée ;
 *   - un GESTIONNAIRE paramètre mais n'approuve pas : l'approbation est ADMIN ;
 *   - l'historique se consulte ligne par ligne.
 */
const h = vi.hoisted(() => ({
  role: "ADMIN",
  ligne: {
    id: 3, familleRevetement: "bitume", etatDepart: "CRITIQUE", typeIntervention: "reconstruction",
    coutKmGnf: "3500000000", uniteCout: "KM", devise: "GNF", code: null, libelle: null as string | null, source: "standard_initial", version: 1,
    approuveLe: null as string | null, approuvePar: null as string | null, anneeReference: null as number | null, largeurChausseeM: null as string | null,
    validDe: null as string | null, validA: null as string | null, commentaire: null,
  },
  patch: [] as { url: string; corps: unknown }[],
  posts: [] as { url: string; corps: unknown }[],
  refusPost: null as null | { status: number; data: unknown },
  refusPatch: null as null | { status: number; data: unknown },
  historique: [] as unknown[],
  liste: "ok" as "ok" | "vide" | "500",
}));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "u-1", role: h.role } }) }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string) => {
      if (url.endsWith("/historique")) return { data: { data: h.historique } };
      if (h.liste === "500") throw { response: { status: 500, data: {} } };
      return { data: { data: h.liste === "vide" ? [] : [{ ...h.ligne }] } };
    }),
    patch: vi.fn(async (url: string, corps?: unknown) => {
      h.patch.push({ url, corps });
      if (h.refusPatch) throw { response: h.refusPatch };
      return { data: { ...h.ligne } };
    }),
    post: vi.fn(async (url: string, corps?: unknown) => {
      h.posts.push({ url, corps });
      if (h.refusPost) throw { response: h.refusPost };
      return { data: {} };
    }),
  },
}));

import { BaremesPage } from "./BaremesPage";

function rendre() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><BaremesPage /></QueryClientProvider>);
}

beforeEach(() => {
  h.role = "ADMIN";
  h.patch.length = 0; h.posts.length = 0; h.refusPost = null; h.refusPatch = null; h.historique = []; h.liste = "ok";
  Object.assign(h.ligne, { anneeReference: null, largeurChausseeM: null, approuveLe: null, approuvePar: null, version: 1, validDe: null, validA: null, libelle: null });
});

describe("BaremesPage : lecture", () => {
  it("affiche la ligne, son coût en clair avec devise et unité, sa version et son statut ; Approuver inactif tant que millésime et largeur manquent, raison visible", async () => {
    rendre();
    expect(await screen.findByText(/Bitume/)).toBeInTheDocument();
    expect(screen.getByText(/3\s500\s000\s000\sGNF\/km/)).toBeInTheDocument();
    expect(screen.getByText(/≈\s3,5\sMd\sGNF\/km/)).toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();
    expect(screen.getByText("non approuvée")).toBeInTheDocument();
    expect(screen.getByText("non bornée")).toBeInTheDocument();
    const approuver = screen.getByRole("button", { name: /Approuver la ligne bitume CRITIQUE/ });
    expect(approuver).toBeDisabled();
    expect(screen.getByText(/Poser d'abord le millésime et la largeur de chaussée/)).toBeVisible();
  });

  it("la mention consultative est visible", async () => {
    rendre();
    await screen.findByText(/Bitume/);
    expect(screen.getByRole("note")).toHaveTextContent(/Consultatif, non engageant/);
  });

  it("états : vide explicite, erreur avec Réessayer", async () => {
    h.liste = "vide";
    const a = rendre();
    expect(await screen.findByText("Aucune ligne de barème")).toBeInTheDocument();
    a.unmount();
    h.liste = "500";
    rendre();
    const alerte = await screen.findByRole("alert", {}, { timeout: 3000 });
    expect(alerte).toHaveTextContent(/barèmes : chargement impossible/i);
    expect(within(alerte).getByRole("button", { name: /Réessayer : barèmes/ })).toBeInTheDocument();
  });

  it("un GESTIONNAIRE ne voit aucun bouton Approuver", async () => {
    h.role = "GESTIONNAIRE";
    rendre();
    await screen.findByText(/Bitume/);
    expect(screen.queryByRole("button", { name: /Approuver/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Modifier la ligne bitume/ })).toBeInTheDocument();
  });
});

describe("BaremesPage : modification avec motif", () => {
  it("l'édition part vide sur les champs inconnus, n'enregistre pas un coût non numérique et exige un motif", async () => {
    const u = userEvent.setup({ delay: null });
    rendre();
    await u.click(await screen.findByRole("button", { name: /Modifier la ligne bitume/ }));
    const cout = await screen.findByLabelText(/Coût par kilomètre en GNF/);
    expect((cout as HTMLInputElement).value).toBe("3500000000");
    expect((screen.getByLabelText(/Millésime/) as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: "Enregistrer" })).toBeDisabled();
    await u.clear(cout);
    await u.type(cout, "12,5");
    expect(screen.getByRole("button", { name: "Enregistrer" })).toBeDisabled();
    expect(screen.getByText(/coût par kilomètre doit être un entier/)).toBeInTheDocument();
  }, 15000);

  it("millésime et largeur sans motif : Enregistrer reste inactif et le dit ; avec motif, seuls les champs modifiés partent avec la version lue", async () => {
    const u = userEvent.setup({ delay: null });
    rendre();
    await u.click(await screen.findByRole("button", { name: /Modifier la ligne bitume/ }));
    await u.type(screen.getByLabelText(/Millésime/), "2026");
    await u.type(screen.getByLabelText(/Largeur de chaussée en mètres/), "6.5");
    expect(screen.getByRole("button", { name: "Enregistrer" })).toBeDisabled();
    expect(screen.getByText(/Le motif est obligatoire/)).toBeInTheDocument();
    await u.type(screen.getByLabelText(/Motif de la modification/), "Arrêté de référence 2026");
    await u.click(screen.getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(h.patch).toHaveLength(1));
    expect(h.patch[0].corps).toEqual({ anneeReference: 2026, largeurChausseeM: 6.5, motif: "Arrêté de référence 2026", versionAttendue: 1 });
  }, 15000);

  it("sur une ligne approuvée : un libellé seul est annoncé sans effet sur l'approbation ; un prix annonce son retrait", async () => {
    Object.assign(h.ligne, { anneeReference: 2026, largeurChausseeM: "6.5", approuveLe: "2026-10-20T08:00:00Z", approuvePar: "adm@x.gn" });
    const u = userEvent.setup({ delay: null });
    rendre();
    expect(await screen.findByText(/approuvée par adm@x.gn/)).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: /Modifier la ligne bitume/ }));
    await u.type(screen.getByLabelText("Libellé"), "Reconstruction bitume (RN)");
    await u.type(screen.getByLabelText(/Motif de la modification/), "Correction de rédaction");
    expect(screen.getByText(/ne sont pas touchées/)).toBeInTheDocument();
    const cout = screen.getByLabelText(/Coût par kilomètre en GNF/);
    await u.clear(cout); await u.type(cout, "3600000000");
    expect(screen.getByText(/l'approbation RETIRÉE/)).toBeInTheDocument();
  }, 15000);

  it("un refus 409 (version périmée) est affiché avec son motif", async () => {
    h.refusPatch = { status: 409, data: { error: "la ligne est passée à la version 2 depuis votre lecture (v1)", code: "CONFLIT_VERSION" } };
    const u = userEvent.setup({ delay: null });
    rendre();
    await u.click(await screen.findByRole("button", { name: /Modifier la ligne bitume/ }));
    await u.type(screen.getByLabelText(/Millésime/), "2026");
    await u.type(screen.getByLabelText(/Motif de la modification/), "Arrêté de référence 2026");
    await u.click(screen.getByRole("button", { name: "Enregistrer" }));
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent(/Modification refusée \(409 CONFLIT_VERSION\)/);
    expect(alerte).toHaveTextContent(/passée à la version 2/);
  }, 15000);
});

describe("BaremesPage : approbation", () => {
  beforeEach(() => { Object.assign(h.ligne, { anneeReference: 2026, largeurChausseeM: "6.5" }); });

  it("motif ET commentaire obligatoires avant de confirmer ; le corps porte la version lue", async () => {
    const u = userEvent.setup({ delay: null });
    rendre();
    await u.click(await screen.findByRole("button", { name: /Approuver la ligne bitume CRITIQUE/ }));
    const confirmer = screen.getByRole("button", { name: /Confirmer l'approbation/ });
    expect(confirmer).toBeDisabled();
    await u.type(screen.getByLabelText(/Motif de l'approbation/), "Prix relu");
    expect(confirmer).toBeDisabled();
    await u.type(screen.getByLabelText(/Commentaire de l'approbation/), "Conforme au bordereau ONR");
    expect(confirmer).toBeEnabled();
    await u.click(confirmer);
    await waitFor(() => expect(h.posts).toHaveLength(1));
    expect(h.posts[0].url).toBe("/v2/baremes/3/approuver");
    expect(h.posts[0].corps).toEqual({ motif: "Prix relu", commentaire: "Conforme au bordereau ONR", versionAttendue: 1 });
  }, 15000);

  it("MUTATION DE CONTROLE : une auto-approbation refusée (403 AUTO_VALIDATION) est AFFICHÉE avec son motif, jamais avalée ; la ligne reste non approuvée", async () => {
    h.refusPost = { status: 403, data: { error: "Un objet ne peut pas être validé par la personne qui l'a produit. Ce compte a modifié le prix de ce barème (version 1) : un autre compte doit approuver.", code: "AUTO_VALIDATION" } };
    const u = userEvent.setup({ delay: null });
    rendre();
    await u.click(await screen.findByRole("button", { name: /Approuver la ligne bitume CRITIQUE/ }));
    await u.type(screen.getByLabelText(/Motif de l'approbation/), "Prix relu");
    await u.type(screen.getByLabelText(/Commentaire de l'approbation/), "Conforme au bordereau ONR");
    await u.click(screen.getByRole("button", { name: /Confirmer l'approbation/ }));
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent(/Approbation refusée \(403 AUTO_VALIDATION\)/);
    expect(alerte).toHaveTextContent(/un autre compte doit approuver/);
    expect(screen.getByText("non approuvée")).toBeInTheDocument();
  }, 15000);
});

describe("BaremesPage : historique et accessibilité", () => {
  it("l'historique d'une ligne d'origine dit qu'elle n'a jamais été modifiée ; un historique réel montre auteur, motif, avant → après", async () => {
    const u = userEvent.setup({ delay: null });
    rendre();
    await u.click(await screen.findByRole("button", { name: /Historique de la ligne bitume/ }));
    expect(await screen.findByText("Aucun historique")).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: /Historique de la ligne bitume/ }));
    h.historique = [{
      id: 2, version: 2, evenement: "MODIFICATION", champsModifies: ["anneeReference"], modifieCalcul: true, approbationReinitialisee: false, statutApprobation: "NON_APPROUVE",
      valeursAvant: { anneeReference: null }, valeursApres: { anneeReference: 2026 }, auteur: { id: "u", email: "gest@x.gn" }, motif: "Arrêté 2026", commentaire: null, creeLe: "2026-10-20T08:00:00Z",
    }];
    await u.click(screen.getByRole("button", { name: /Historique de la ligne bitume/ }));
    expect(await screen.findByText(/Par gest@x.gn/)).toBeInTheDocument();
    expect(screen.getByText(/Motif : Arrêté 2026/)).toBeInTheDocument();
    expect(screen.getByText("Millésime : non renseigné → 2026")).toBeInTheDocument();
  }, 15000);

  it("sans violation d'accessibilité (liste, édition ouverte)", async () => {
    const u = userEvent.setup({ delay: null });
    const { container } = rendre();
    await u.click(await screen.findByRole("button", { name: /Modifier la ligne bitume/ }));
    await screen.findByLabelText(/Motif de la modification/);
    expect(await violationsAccessibilite(container)).toEqual([]);
  }, 15000);
});
