import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../../lib/api", () => ({ api: { get: h.get, post: h.post } }));
vi.mock("../../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useSources } from "../../lib/teledetectionHooks";
import { TableauSources } from "./TableauSources";
import { rendreAvecClient } from "./rendre.testutil";
import { echec, routeurGet, source } from "./synthetique.testutil";

/**
 * Tableau « Sources d'observation » : l'echelle d'etat du contrat paragraphe 4.
 * Defendu : « Active » seulement pour TRAITEMENT_OPERATIONNEL, bouton « Verifier » reserve a ADMIN
 * (le serveur decide), erreur et permission refusee distinctes d'un vide, tableau accessible.
 */

function Harnais({ admin }: { admin: boolean }) {
  const s = useSources();
  return <TableauSources sources={s} peutVerifier={admin} />;
}

const TOUS_LES_ETATS = [
  source({ code: "S1", nom: "Source un", etat: "TRAITEMENT_OPERATIONNEL" }),
  source({ code: "S2", nom: "Source deux", etat: "PRODUIT_DISPONIBLE", message: "3 produits dans la fenêtre" }),
  source({ code: "S3", nom: "Source trois", etat: "ACCESSIBLE" }),
  source({ code: "S4", nom: "Source quatre", etat: "AUTHENTIFIEE" }),
  source({ code: "S5", nom: "Source cinq", etat: "CONFIGUREE", derniereVerification: null, derniereAcquisition: null }),
  source({ code: "S6", nom: "Source six", etat: "NON_CONFIGUREE", resolutionM: null }),
  source({ code: "S7", nom: "Source sept", etat: "EN_ERREUR", message: "Délai dépassé" }),
  source({ code: "S8", nom: "Source huit", etat: "EN_ATTENTE_CONFIGURATION", requiertIdentifiants: true }),
];

beforeEach(() => { h.get.mockReset(); h.post.mockReset(); });

describe("TableauSources", () => {
  it("n'affiche « Active » que pour TRAITEMENT_OPERATIONNEL, avec un libelle clair pour chaque autre etat", async () => {
    h.get.mockImplementation(routeurGet({ "/v2/teledetection/sources": TOUS_LES_ETATS }));
    rendreAvecClient(<Harnais admin={false} />);
    const table = await screen.findByRole("table", { name: /Sources d'observation de la Terre/ });
    const ligne = (nom: string) => within(table).getByRole("rowheader", { name: new RegExp(nom) }).closest("tr") as HTMLElement;
    expect(within(ligne("Source un")).getByText("Active")).toBeInTheDocument();
    expect(within(ligne("Source deux")).getByText("Produits disponibles")).toBeInTheDocument();
    expect(within(ligne("Source deux")).getByText("3 produits dans la fenêtre")).toBeInTheDocument();
    expect(within(ligne("Source trois")).getByText("Catalogue accessible")).toBeInTheDocument();
    expect(within(ligne("Source quatre")).getByText("Authentifiée")).toBeInTheDocument();
    expect(within(ligne("Source cinq")).getByText("Configurée, non testée")).toBeInTheDocument();
    expect(within(ligne("Source six")).getByText("Non configurée")).toBeInTheDocument();
    expect(within(ligne("Source sept")).getByText("En erreur")).toBeInTheDocument();
    expect(within(ligne("Source sept")).getByText("Délai dépassé")).toBeInTheDocument();
    expect(within(ligne("Source huit")).getByText("Identifiants requis")).toBeInTheDocument();
    // « Active » une seule fois dans le tableau : les 7 autres etats ne l'usurpent pas.
    expect(within(table).getAllByText("Active")).toHaveLength(1);
    expect(screen.getByText("1 active sur 8 enregistrées")).toBeInTheDocument();
  });

  it("un etat inconnu du serveur est dit inconnu, jamais « Active »", async () => {
    h.get.mockImplementation(routeurGet({ "/v2/teledetection/sources": [source({ nom: "Source X", etat: "ACTIVE" })] }));
    rendreAvecClient(<Harnais admin={false} />);
    expect(await screen.findByText("État inconnu")).toBeInTheDocument();
    expect(within(screen.getByRole("table")).queryByText("Active")).not.toBeInTheDocument();
    expect(screen.getByText("0 active sur 1 enregistrée")).toBeInTheDocument();
  });

  it("le tableau est accessible : legende, en-tetes de colonnes avec scope, en-tetes de lignes", async () => {
    h.get.mockImplementation(routeurGet({ "/v2/teledetection/sources": [source()] }));
    rendreAvecClient(<Harnais admin />);
    const table = await screen.findByRole("table", { name: /Sources d'observation/ });
    const entetes = within(table).getAllByRole("columnheader");
    expect(entetes.length).toBeGreaterThanOrEqual(5);
    for (const th of entetes) expect(th).toHaveAttribute("scope", "col");
    expect(within(table).getByRole("rowheader", { name: /Source A/ })).toHaveAttribute("scope", "row");
  });

  it("l'echelle d'etat est expliquee, et dit que les identifiants ne passent pas par l'ecran", async () => {
    h.get.mockImplementation(routeurGet({ "/v2/teledetection/sources": [source()] }));
    rendreAvecClient(<Harnais admin={false} />);
    await screen.findByRole("table");
    expect(screen.getByText("Échelle d'état des sources")).toBeInTheDocument();
    expect(screen.getByText(/cet écran ne les affiche ni ne les saisit/)).toBeInTheDocument();
  });

  it("« Verifier » : visible seulement si le droit est donne, nom accessible distinct, appel POST reel", async () => {
    h.get.mockImplementation(routeurGet({ "/v2/teledetection/sources": [source({ code: "S1", nom: "Source un" }), source({ code: "S2", nom: "Source deux" })] }));
    h.post.mockResolvedValue({ data: {} });
    const u = userEvent.setup();
    const a = rendreAvecClient(<Harnais admin={false} />);
    await screen.findByRole("table");
    expect(screen.queryByRole("button", { name: /Vérifier/ })).not.toBeInTheDocument();
    a.unmount();

    rendreAvecClient(<Harnais admin />);
    await screen.findByRole("table");
    await u.click(screen.getByRole("button", { name: "Vérifier la source Source deux" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith("/v2/teledetection/sources/S2/verifier", {}));
    expect(await screen.findByText(/Vérification de Source deux terminée/)).toBeInTheDocument();
  });

  it("un refus du serveur a la verification est affiche tel quel (role alert), le serveur decide", async () => {
    h.get.mockImplementation(routeurGet({ "/v2/teledetection/sources": [source()] }));
    h.post.mockRejectedValue(echec(403, "Réservé aux administrateurs", "ROLE_INSUFFISANT"));
    const u = userEvent.setup();
    rendreAvecClient(<Harnais admin />);
    await screen.findByRole("table");
    await u.click(screen.getByRole("button", { name: "Vérifier la source Source A" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Réservé aux administrateurs");
  });

  it("double clic (ou trois clics du meme tick) sur « Verifier » : UN SEUL test de connectivite reel", async () => {
    h.get.mockImplementation(routeurGet({ "/v2/teledetection/sources": [source()] }));
    h.post.mockImplementation(() => new Promise((r) => setTimeout(() => r({ data: {} }), 80)));
    const u = userEvent.setup();
    rendreAvecClient(<Harnais admin />);
    await screen.findByRole("table");
    const bouton = screen.getByRole("button", { name: "Vérifier la source Source A" });
    await u.dblClick(bouton);
    expect(h.post).toHaveBeenCalledTimes(1);
    const cle = Object.keys(bouton).find((k) => k.startsWith("__reactProps")) as string;
    const onClick = (bouton as unknown as Record<string, { onClick: () => void }>)[cle].onClick;
    act(() => { onClick(); onClick(); });
    expect(h.post).toHaveBeenCalledTimes(1);
    await screen.findByText(/Vérification de Source A terminée/);
    // le verrou est leve : on peut verifier de nouveau
    await u.click(screen.getByRole("button", { name: "Vérifier la source Source A" }));
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(2));
  });

  it("source indisponible (503) a la verification : message du serveur, pas un succes", async () => {
    h.get.mockImplementation(routeurGet({ "/v2/teledetection/sources": [source()] }));
    h.post.mockRejectedValue(echec(503, "Catalogue injoignable", "SOURCE_INDISPONIBLE"));
    const u = userEvent.setup();
    rendreAvecClient(<Harnais admin />);
    await screen.findByRole("table");
    await u.click(screen.getByRole("button", { name: "Vérifier la source Source A" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Catalogue injoignable");
    expect(screen.queryByText(/terminée/)).not.toBeInTheDocument();
  });

  it("aucune source : etat vide explicite (pas un tableau vide)", async () => {
    h.get.mockImplementation(routeurGet({ "/v2/teledetection/sources": [] }));
    rendreAvecClient(<Harnais admin />);
    expect(await screen.findByText("Aucune source d'observation enregistrée")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("chargement : role status", () => {
    h.get.mockImplementation(() => new Promise(() => {}));
    rendreAvecClient(<Harnais admin />);
    expect(screen.getByRole("status")).toHaveTextContent("Chargement des sources");
  });

  it("erreur serveur : alerte et bouton Reessayer, pas de tableau", async () => {
    h.get.mockImplementation(routeurGet({ "/v2/teledetection/sources": echec(500, "Panne base") }));
    rendreAvecClient(<Harnais admin />);
    const alerte = await screen.findByRole("alert", undefined, { timeout: 5000 });
    expect(alerte).toHaveTextContent("Panne base");
    expect(within(alerte).getByRole("button", { name: /Réessayer/ })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("permission refusee : message dedie, ni vide ni panne", async () => {
    h.get.mockImplementation(routeurGet({ "/v2/teledetection/sources": echec(403, "Module non autorisé") }));
    rendreAvecClient(<Harnais admin={false} />);
    expect(await screen.findByText(/Sources : accès refusé/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Aucune source d'observation enregistrée")).not.toBeInTheDocument();
  });
});
