import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * L'écran de suivi des lots d'import : ce que ces tests défendent.
 *
 * **Recevoir n'est pas importer.** Un lot « schéma validé » doit dire que rien n'a été créé.
 * **Un fichier déjà reçu n'écrit rien**, et l'écran le dit au lieu d'afficher un succès.
 * **Un lot rejeté affiche son motif**, et ses erreurs se téléchargent par l'API authentifiée.
 * **La réception envoie un multipart** avec le fichier et les cinq champs, dont l'autorisation
 * écrite, sans laquelle le bouton reste inactif.
 */

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  download: vi.fn(),
  lots: [] as Record<string, unknown>[],
}));

vi.mock("../lib/api", () => ({ api: { get: h.get, post: h.post } }));
vi.mock("../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("../lib/download", () => ({ downloadViaApi: h.download }));

import { ImportsPage } from "./ImportsPage";
import { toast } from "../lib/toast";

function lot(over: Record<string, unknown> = {}) {
  return {
    id: "lot-1", reference: "IMP-2026-00001", systemeSource: "ONR_BDR", format: "csv", nomFichier: "rn1.csv",
    statut: "VALIDE_SCHEMA", importeLe: "2026-10-14T20:00:00.000Z",
    lignesLues: 4, lignesValidees: 2, lignesImportees: 0, lignesRejetees: 1, lignesEnConflit: 0, lignesIgnorees: 1,
    autorisationRef: "AUT-2026-01", methodeSource: "export L2R", versionMapping: "v0",
    rapport: { motifRejetLot: null, premiersRejets: [
      { numeroLigne: 3, statut: "REJETEE", motif: "identifiant_source manquant : sans lui, aucun rapprochement n'est possible" },
      { numeroLigne: 4, statut: "IGNOREE", motif: "doublon dans le lot : meme troncon RN1-001 que la ligne 1, conservee" },
    ] },
    ...over,
  };
}

function afficher() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><ImportsPage /></QueryClientProvider>);
}

beforeEach(() => {
  // Les mocks de toast ne vivent pas dans `h` : sans ce clearAllMocks, le `success` d'un test
  // ferait echouer le « jamais appele » du suivant -- un faux echec qui accuserait l'ecran.
  vi.clearAllMocks();
  h.get.mockReset(); h.post.mockReset(); h.download.mockReset();
  h.lots = [lot()];
  h.get.mockImplementation(async (url: string) => {
    if (url === "/v2/imports") return { data: { lots: h.lots } };
    const id = url.split("/")[3];
    return { data: h.lots.find((l) => l.id === id) };
  });
});

describe("Ce que l'écran annonce et liste", () => {
  it("dit d'entrée que recevoir n'est pas importer", () => {
    afficher();
    expect(screen.getByText(/Recevoir n'est pas importer/)).toBeInTheDocument();
    expect(screen.getByText(/rien n'a été créé dans le référentiel/i)).toBeInTheDocument();
  });

  it("liste les lots avec leurs compteurs et le statut « non appliqué »", async () => {
    afficher();
    await waitFor(() => expect(screen.getByText("IMP-2026-00001")).toBeInTheDocument());
    expect(screen.getAllByText("Schéma validé — non appliqué").length).toBeGreaterThan(0);
    expect(screen.getByText(/Lots reçus \(1\)/)).toBeInTheDocument();
  });

  it("au clic, montre le détail : compteurs, en attente d'application, premiers rejets", async () => {
    afficher();
    await waitFor(() => screen.getByText("IMP-2026-00001"));
    await userEvent.click(screen.getByText("IMP-2026-00001"));
    await waitFor(() => expect(screen.getByText(/en attente d'application/)).toBeInTheDocument());
    expect(screen.getByText(/2 ligne\(s\) conformes au contrat/)).toBeInTheDocument();
    expect(screen.getByText(/identifiant_source manquant/)).toBeInTheDocument();
    expect(screen.getByText(/doublon dans le lot/)).toBeInTheDocument();
  });

  it("un lot rejeté affiche son motif", async () => {
    h.lots = [lot({ id: "lot-r", reference: "IMP-2026-00002", statut: "REJETE", lignesLues: 0, lignesValidees: 0, lignesRejetees: 0, lignesIgnorees: 0,
      rapport: { motifRejetLot: "GeoJSON : CRS urn:ogc:def:crs:EPSG::32628 refuse, le pivot impose le SRID 4326", premiersRejets: [] } })];
    afficher();
    await waitFor(() => screen.getByText("IMP-2026-00002"));
    await userEvent.click(screen.getByText("IMP-2026-00002"));
    await waitFor(() => expect(screen.getByText(/Lot rejeté :/)).toBeInTheDocument());
    expect(screen.getByText(/32628 refuse/)).toBeInTheDocument();
  });
});

describe("Télécharger les erreurs", () => {
  it("passe par l'API authentifiée, avec le nom du lot", async () => {
    h.download.mockResolvedValue(undefined);
    afficher();
    await waitFor(() => screen.getByText("IMP-2026-00001"));
    await userEvent.click(screen.getByText("IMP-2026-00001"));
    const bouton = await screen.findByRole("button", { name: /Télécharger les erreurs/ });
    await userEvent.click(bouton);
    expect(h.download).toHaveBeenCalledWith("/v2/imports/lot-1/erreurs.csv", "IMP-2026-00001-erreurs.csv");
  });
});

describe("Recevoir un lot", () => {
  it("le bouton reste inactif sans méthode, sans autorisation écrite, ou sans fichier", async () => {
    afficher();
    const form = screen.getByRole("form", { name: "Recevoir un lot" });
    const bouton = within(form).getByRole("button", { name: /Recevoir le lot/ });
    expect(bouton).toBeDisabled();
    await userEvent.type(within(form).getByLabelText(/Méthode de la source/), "x");
    await userEvent.type(within(form).getByLabelText(/autorisation écrite/), "A");
    // Les deux champs remplis, toujours rien sans fichier.
    expect(bouton).toBeDisabled();
    await userEvent.upload(within(form).getByLabelText("Fichier"), new File(["a"], "a.csv"));
    expect(bouton).toBeEnabled();
  });

  it("envoie un multipart avec le fichier et les cinq champs, puis dit ce qui a été reçu et non appliqué", async () => {
    h.post.mockResolvedValue({ data: { id: "lot-2", reference: "IMP-2026-00002", statut: "VALIDE_SCHEMA", dejaRecu: false, motifRejetLot: null,
      compteurs: { lues: 3, validees: 2, rejetees: 1, ignorees: 0 } } });
    afficher();
    const form = screen.getByRole("form", { name: "Recevoir un lot" });
    await userEvent.type(within(form).getByLabelText(/Méthode de la source/), "export L2R");
    await userEvent.type(within(form).getByLabelText(/autorisation écrite/), "AUT-2026-01");
    const fichier = new File(["systeme_source;type_objet;identifiant_source\n"], "lot.csv", { type: "text/csv" });
    await userEvent.upload(within(form).getByLabelText("Fichier"), fichier);
    await userEvent.click(within(form).getByRole("button", { name: /Recevoir le lot/ }));

    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(1));
    const [url, fd] = h.post.mock.calls[0] as [string, FormData];
    expect(url).toBe("/v2/imports");
    expect(fd).toBeInstanceOf(FormData);
    expect((fd.get("fichier") as File).name).toBe("lot.csv");
    expect(fd.get("systemeSource")).toBe("ONR_BDR");
    expect(fd.get("format")).toBe("csv");
    expect(fd.get("methodeSource")).toBe("export L2R");
    expect(fd.get("versionMapping")).toBe("v0");
    expect(fd.get("autorisationRef")).toBe("AUT-2026-01");
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/2 ligne\(s\) validée\(s\).*Rien n'est encore appliqué/));
  });

  it("un fichier déjà reçu est annoncé comme tel : rien n'a été écrit", async () => {
    h.post.mockResolvedValue({ data: { id: "lot-1", reference: "IMP-2026-00001", statut: "VALIDE_SCHEMA", dejaRecu: true, motifRejetLot: null,
      compteurs: { lues: 4, validees: 2, rejetees: 1, ignorees: 1 } } });
    afficher();
    const form = screen.getByRole("form", { name: "Recevoir un lot" });
    await userEvent.type(within(form).getByLabelText(/Méthode de la source/), "x");
    await userEvent.type(within(form).getByLabelText(/autorisation écrite/), "A");
    await userEvent.upload(within(form).getByLabelText("Fichier"), new File(["a"], "a.csv"));
    await userEvent.click(within(form).getByRole("button", { name: /Recevoir le lot/ }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(expect.stringMatching(/déjà reçu.*Rien n'a été écrit/)));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("un lot rejeté à la réception est signalé avec son motif, pas comme un succès", async () => {
    h.post.mockResolvedValue({ data: { id: "lot-3", reference: "IMP-2026-00003", statut: "REJETE", dejaRecu: false,
      motifRejetLot: "CSV : colonne obligatoire absente de l'en-tete : type_objet", compteurs: { lues: 0, validees: 0, rejetees: 0, ignorees: 0 } } });
    afficher();
    const form = screen.getByRole("form", { name: "Recevoir un lot" });
    await userEvent.type(within(form).getByLabelText(/Méthode de la source/), "x");
    await userEvent.type(within(form).getByLabelText(/autorisation écrite/), "A");
    await userEvent.upload(within(form).getByLabelText("Fichier"), new File(["a"], "a.csv"));
    await userEvent.click(within(form).getByRole("button", { name: /Recevoir le lot/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/rejeté : CSV : colonne obligatoire/)));
  });

  it("une demande refusée par le serveur (400) affiche le motif du serveur", async () => {
    h.post.mockRejectedValue({ response: { data: { error: "fichier trop gros, maximum 52428800 octets" } } });
    afficher();
    const form = screen.getByRole("form", { name: "Recevoir un lot" });
    await userEvent.type(within(form).getByLabelText(/Méthode de la source/), "x");
    await userEvent.type(within(form).getByLabelText(/autorisation écrite/), "A");
    await userEvent.upload(within(form).getByLabelText("Fichier"), new File(["a"], "a.csv"));
    await userEvent.click(within(form).getByRole("button", { name: /Recevoir le lot/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("fichier trop gros, maximum 52428800 octets"));
  });
});
