import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { violationsAccessibilite } from "../../../test/accessibilite";
import { comparaisonSim, detailSim, resumeSim } from "../simulation/simulation.fixtures";

/**
 * Onglet « Scenarios ». Ce que ces tests defendent :
 *   - retrouver un scenario (nom, logique), le filtre est dit, « effacer les filtres » existe ;
 *   - le vide, l'erreur (« Reessayer ») et le refus de droit (403) sont trois etats distincts ;
 *   - comparer exige 2 a 5 scenarios, jamais un herite (case inactive) ; la comparaison s'affiche en tableau accessible ;
 *   - le detail montre les entrees, la version des parametres et des baremes ; le REJEU verifie l'empreinte (identique ou non) ;
 *   - la suppression est confirmee, reservee aux roles ADMIN et GESTIONNAIRE ; 0 violation axe-core.
 */
const h = vi.hoisted(() => ({
  role: "GESTIONNAIRE",
  modules: ["decision", "programmation", "rapports"] as string[],
  lister: vi.fn(), lire: vi.fn(), rejouer: vi.fn(), supprimer: vi.fn(), comparer: vi.fn(), exporter: vi.fn(), remettre: vi.fn(),
}));
vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: { id: "u-1", role: h.role, nomComplet: "Awa Camara", modulesAutorises: h.modules } }) }));
vi.mock("../../../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../../../lib/api", () => ({ api: { get: vi.fn(async (url: string) => { if (url === "/regions") return { data: [{ id: 1, nom: "Basse-Guinée" }, { id: 2, nom: "Moyenne-Guinée" }] }; throw new Error(`URL inattendue ${url}`); }) } }));
vi.mock("../../../lib/aideDecisionScenariosApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/aideDecisionScenariosApi")>()),
  listerScenarios: (...a: unknown[]) => h.lister(...a), lireScenario: (...a: unknown[]) => h.lire(...a), rejouerScenario: (...a: unknown[]) => h.rejouer(...a),
  supprimerScenario: (...a: unknown[]) => h.supprimer(...a), comparerScenarios: (...a: unknown[]) => h.comparer(...a),
  telechargerExport: (...a: unknown[]) => h.exporter(...a), remettreFichier: (...a: unknown[]) => h.remettre(...a),
}));

import { OngletScenarios } from "./OngletScenarios";

const erreurHttp = (status: number, error: string) => Object.assign(new Error(error), { response: { status, data: { error } } });
const liste = (data = [resumeSim("s1"), resumeSim("s2", { intitule: "Scénario urgence", logique: "urgence", deficitGnf: "0", montantEngageGnf: "7900000000", budgetGnf: "8000000000" })]) => ({ data, total: data.length, page: 1, pageSize: 20 });

function rendre() {
  const qc = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><OngletScenarios filtres={{}} onFiltres={() => undefined} /></QueryClientProvider>);
}
const sp = (s: string | null) => (s ?? "").replace(/[\s\u202f\u00a0]/g, " ");

beforeEach(() => {
  cleanup();
  h.role = "GESTIONNAIRE";
  h.modules = ["decision", "programmation", "rapports"];
  h.lister.mockReset().mockResolvedValue(liste());
  h.lire.mockReset().mockImplementation(async (id: string) => detailSim(id));
  h.rejouer.mockReset().mockResolvedValue({ identique: true, entreesIntegres: true, empreinteStockee: "r".repeat(64), empreinteRecalculee: "r".repeat(64), explication: "Le rejeu donne le même texte, octet pour octet." });
  h.supprimer.mockReset().mockResolvedValue({ ok: true, id: "s1" });
  h.comparer.mockReset().mockResolvedValue(comparaisonSim());
  h.exporter.mockReset().mockResolvedValue({ blob: new Blob(["x"]), nom: "simulation.csv" });
  h.remettre.mockReset();
});

describe("liste et filtres", () => {
  it("liste les scenarios : auteur, date, periode, logique, enveloppe, consomme, deficit (signale) ou « aucun »", async () => {
    rendre();
    const t = await screen.findByRole("table", { name: "Scénarios enregistrés" });
    const l1 = within(t).getByRole("row", { name: /Scénario s1/ });
    expect(l1).toHaveTextContent("Awa Camara");
    expect(l1).toHaveTextContent("01/01/2027 au 31/12/2027");
    expect(l1).toHaveTextContent("Ratio coût / impact");
    expect(sp(l1.textContent)).toContain("5 000 000 000 GNF");
    expect(sp(l1.textContent)).toContain("3 700 000 000 GNF");
    expect(within(t).getByRole("row", { name: /Scénario urgence/ })).toHaveTextContent("aucun");
    expect(screen.getByTestId("mention-simulation")).toBeInTheDocument();
  });

  it("le filtre par nom et par logique est envoye au serveur ; « Effacer les filtres » les retire", async () => {
    const u = userEvent.setup();
    rendre();
    await screen.findByRole("table");
    await u.type(screen.getByLabelText("Nom du scénario"), "boké");
    await u.selectOptions(screen.getByLabelText("Logique de priorité"), "Criticité");
    await u.click(screen.getByRole("button", { name: "Filtrer" }));
    await waitFor(() => expect(h.lister).toHaveBeenLastCalledWith({ q: "boké", logique: "criticite", page: 1, pageSize: 20 }));
    await u.click(await screen.findByRole("button", { name: "Effacer les filtres" }));
    await waitFor(() => expect(h.lister).toHaveBeenLastCalledWith({ q: "", logique: "", page: 1, pageSize: 20 }));
  });

  it("un scenario calcule avant le simulateur est signale, sa periode n'est pas inventee, son deficit « non calculé », il ne se coche pas", async () => {
    h.lister.mockResolvedValue(liste([resumeSim("old", { simulateur: false, logique: null, periode: null, deficitGnf: null, deficitMinorant: null }), resumeSim("s1")]));
    rendre();
    const l = await screen.findByRole("row", { name: /Scénario old/ });
    expect(l).toHaveTextContent("calculé avant le simulateur");
    expect(l).toHaveTextContent("période non renseignée");
    expect(l).toHaveTextContent("non calculé");
    expect(within(l).getByRole("checkbox")).toBeDisabled();
  });

  it("deficit minorant : « minimum » est dit dans la liste", async () => {
    h.lister.mockResolvedValue(liste([resumeSim("s1", { deficitMinorant: true }), resumeSim("s2")]));
    rendre();
    expect(await screen.findByRole("row", { name: /Scénario s1/ })).toHaveTextContent("minimum");
  });
});

describe("etats", () => {
  it("chargement (status), puis vide sans filtre : invite a simuler", async () => {
    h.lister.mockResolvedValue(liste([]));
    rendre();
    expect(screen.getByText("Chargement des scénarios…")).toHaveAttribute("role", "status");
    expect(await screen.findByText("Aucun scénario enregistré")).toBeInTheDocument();
    expect(screen.getByText(/Lancez une simulation depuis l'onglet Simulation/)).toBeInTheDocument();
  });

  it("vide avec filtre : le dit autrement", async () => {
    const u = userEvent.setup();
    h.lister.mockResolvedValueOnce(liste()).mockResolvedValue(liste([]));
    rendre();
    await screen.findByRole("table");
    await u.type(screen.getByLabelText("Nom du scénario"), "zzz");
    await u.click(screen.getByRole("button", { name: "Filtrer" }));
    expect(await screen.findByText("Aucun scénario ne correspond aux filtres")).toBeInTheDocument();
  });

  it("erreur : alerte avec « Réessayer » qui recharge (jamais lue comme un vide)", async () => {
    const u = userEvent.setup();
    h.lister.mockRejectedValueOnce(erreurHttp(500, "base indisponible")).mockRejectedValueOnce(erreurHttp(500, "base indisponible")).mockResolvedValue(liste()); // la 1re requete et son unique relance echouent
    rendre();
    const e = await screen.findByText(/Liste des scénarios : l'opération a échoué/);
    expect(e.closest("[role=alert]")).toHaveTextContent("base indisponible");
    expect(screen.queryByText("Aucun scénario enregistré")).not.toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Réessayer : Liste des scénarios" }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
  });

  it("403 : accès refusé (module, rôle ou périmètre), sans « Réessayer », distinct d'une panne", async () => {
    h.lister.mockRejectedValue(erreurHttp(403, "Accès à ce module non autorisé pour votre compte"));
    rendre();
    const e = await screen.findByText(/Liste des scénarios : accès refusé/);
    expect(e.closest("[data-etat=permission]")).toHaveTextContent("Accès à ce module non autorisé");
    expect(screen.queryByRole("button", { name: /Réessayer/ })).not.toBeInTheDocument();
  });
});

describe("comparaison de 2 a 5 scenarios", () => {
  it("le bouton exige 2 scenarios ; apres 2 cases, la comparaison s'affiche et part avec les identifiants", async () => {
    const u = userEvent.setup();
    rendre();
    await screen.findByRole("table");
    const bouton = screen.getByRole("button", { name: /Comparer les 0 scénarios cochés/ });
    expect(bouton).toBeDisabled();
    await u.click(screen.getByRole("checkbox", { name: "Comparer Scénario s1" }));
    expect(screen.getByRole("button", { name: /Comparer les 1 scénarios cochés/ })).toBeDisabled();
    await u.click(screen.getByRole("checkbox", { name: "Comparer Scénario urgence" }));
    await u.click(screen.getByRole("button", { name: /Comparer les 2 scénarios cochés/ }));
    expect(await screen.findByTestId("comparaison")).toBeInTheDocument();
    expect(h.comparer).toHaveBeenCalledWith(["s1", "s2"]);
    expect(screen.getByRole("table", { name: /Comparaison côte à côte/ })).toBeInTheDocument();
  });

  it("la 6e case est bloquee (5 au plus)", async () => {
    const six = Array.from({ length: 6 }, (_, i) => resumeSim(`s${i}`, { intitule: `Sc ${i}` }));
    h.lister.mockResolvedValue(liste(six));
    const u = userEvent.setup();
    rendre();
    await screen.findByRole("table");
    for (let i = 0; i < 5; i++) await u.click(screen.getByRole("checkbox", { name: `Comparer Sc ${i}` }));
    expect(screen.getByRole("checkbox", { name: "Comparer Sc 5" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Comparer les 5 scénarios cochés/ })).toBeEnabled();
  });

  it("un refus du serveur (periodes differentes, 422) est dit avec sa phrase, sans tableau", async () => {
    const u = userEvent.setup();
    h.comparer.mockRejectedValue(erreurHttp(422, "périodes différentes (2027-01-01 à 2027-12-31 ; 2027-01-01 à 2028-12-31)"));
    rendre();
    await screen.findByRole("table");
    await u.click(screen.getByRole("checkbox", { name: "Comparer Scénario s1" }));
    await u.click(screen.getByRole("checkbox", { name: "Comparer Scénario urgence" }));
    await u.click(screen.getByRole("button", { name: /Comparer les 2/ }));
    expect(await screen.findByText(/périodes différentes/)).toBeInTheDocument();
    expect(screen.queryByTestId("comparaison")).not.toBeInTheDocument();
  });
});

describe("detail, rejeu, export, suppression", () => {
  async function ouvrir(u: ReturnType<typeof userEvent.setup>) {
    rendre();
    await screen.findByRole("table");
    await u.click(screen.getByRole("button", { name: /Ouvrir Scénario s1/ }));
    return screen.findByTestId("detail-scenario");
  }

  it("le detail montre les entrees : periode, logique, parametres, empreintes, version des baremes ; et le resultat", async () => {
    const d = await ouvrir(userEvent.setup());
    const e = within(d).getByTestId("entrees-scenario");
    expect(e).toHaveTextContent("01/01/2027 au 31/12/2027");
    expect(e).toHaveTextContent("Ratio coût / impact");
    expect(e).toHaveTextContent("prog-provisoire-1");
    expect(e).toHaveTextContent("aaaaaaaa…aaaaaaaa");
    expect(within(d).getByTestId("resultat-simulation")).toBeInTheDocument();
    expect(within(d).getByText(/Auteur : Awa Camara/)).toBeInTheDocument();
  });

  it("rejeu identique : dit « octet pour octet » ; rejeu different : alerte rouge, le resultat stocke reste ce qui a ete decide", async () => {
    const u = userEvent.setup();
    const d = await ouvrir(u);
    await u.click(within(d).getByRole("button", { name: /Rejouer et vérifier l'empreinte/ }));
    const ok = await screen.findByTestId("rapport-rejeu");
    expect(ok).toHaveTextContent("octet pour octet");
    expect(ok.className).toMatch(/green/);
    h.rejouer.mockResolvedValue({ identique: false, entreesIntegres: true, empreinteStockee: "a".repeat(64), empreinteRecalculee: "b".repeat(64), explication: "Le rejeu diffère du résultat stocké." });
    await u.click(within(d).getByRole("button", { name: /Rejouer et vérifier l'empreinte/ }));
    await waitFor(() => expect(screen.getByTestId("rapport-rejeu").className).toMatch(/red/));
    expect(screen.getByTestId("rapport-rejeu")).toHaveTextContent(/diffère/);
  });

  it("entrees alterees : l'ecran le crie (ATTENTION)", async () => {
    const u = userEvent.setup();
    h.rejouer.mockResolvedValue({ identique: true, entreesIntegres: false, empreinteStockee: "a".repeat(64), empreinteRecalculee: "a".repeat(64), explication: "ok" });
    const d = await ouvrir(u);
    await u.click(within(d).getByRole("button", { name: /Rejouer/ }));
    const r = await screen.findByTestId("rapport-rejeu");
    expect(r).toHaveTextContent(/ATTENTION : les entrées stockées ne correspondent plus/);
    expect(r.className).toMatch(/red/);
  });

  it("export CSV : fichier remis ; export sans mention : refuse", async () => {
    const u = userEvent.setup();
    const d = await ouvrir(u);
    await u.click(within(d).getByRole("button", { name: /Exporter en CSV/ }));
    await waitFor(() => expect(h.remettre).toHaveBeenCalledTimes(1));
    expect(h.exporter).toHaveBeenCalledWith("s1", "csv");
    const { ExportSansMention } = await import("../../../lib/aideDecisionScenariosApi");
    h.exporter.mockRejectedValue(new ExportSansMention());
    await u.click(within(d).getByRole("button", { name: /Exporter en JSON/ }));
    expect(await screen.findByText(/ne porte pas la mention/)).toBeInTheDocument();
    expect(h.remettre).toHaveBeenCalledTimes(1);
  });

  it("suppression : confirmation obligatoire, puis appel, detail ferme et scenario retire de la selection", async () => {
    const u = userEvent.setup();
    const d = await ouvrir(u);
    await u.click(within(d).getByRole("button", { name: /Supprimer le scénario/ }));
    expect(h.supprimer).not.toHaveBeenCalled();
    const modale = await screen.findByRole("dialog");
    expect(modale).toHaveTextContent(/suppression logique/);
    await u.click(within(modale).getByRole("button", { name: "Confirmer la suppression" }));
    await waitFor(() => expect(h.supprimer).toHaveBeenCalledWith("s1"));
    await waitFor(() => expect(screen.queryByTestId("detail-scenario")).not.toBeInTheDocument());
  });

  it("suppression refusee (fiche figee, 409) : dite, le detail reste ouvert", async () => {
    const u = userEvent.setup();
    h.supprimer.mockRejectedValue(erreurHttp(409, "1 fiche(s) figée(s) citent ce scénario : il ne se retire pas"));
    const d = await ouvrir(u);
    await u.click(within(d).getByRole("button", { name: /Supprimer le scénario/ }));
    await u.click(await screen.findByRole("button", { name: "Confirmer la suppression" }));
    expect(await screen.findByText(/fiche\(s\) figée\(s\) citent ce scénario/)).toBeInTheDocument();
    expect(screen.getByTestId("detail-scenario")).toBeInTheDocument();
  });

  it("un lecteur n'a ni bouton de suppression ni d'ecriture, mais peut rejouer et comparer", async () => {
    h.role = "LECTEUR";
    const d = await ouvrir(userEvent.setup());
    expect(within(d).queryByRole("button", { name: /Supprimer le scénario/ })).not.toBeInTheDocument();
    expect(within(d).getByRole("button", { name: /Rejouer/ })).toBeInTheDocument();
  });

  it("un scenario herite se lit avec le detail du moteur et dit qu'il n'a ni periode ni deficit ; pas d'export", async () => {
    const u = userEvent.setup();
    h.lister.mockResolvedValue(liste([resumeSim("old", { simulateur: false, logique: null, periode: null, deficitGnf: null, deficitMinorant: null })]));
    h.lire.mockResolvedValue(detailSim("old", { simulateur: false }));
    rendre();
    await u.click(await screen.findByRole("button", { name: /Ouvrir Scénario old/ }));
    const d = await screen.findByTestId("detail-scenario");
    expect(d).toHaveTextContent(/calculé avant le simulateur : il n'a ni période, ni devise, ni déficit/);
    expect(within(d).queryByRole("button", { name: /Exporter/ })).not.toBeInTheDocument();
    expect(within(d).getByRole("button", { name: /Rejouer/ })).toBeInTheDocument();
  });

  it("detail en erreur : « Réessayer » ; detail refuse (403) : acces refuse", async () => {
    const u = userEvent.setup();
    h.lire.mockRejectedValueOnce(erreurHttp(500, "panne")).mockRejectedValueOnce(erreurHttp(500, "panne")).mockResolvedValue(detailSim("s1"));
    rendre();
    await screen.findByRole("table");
    await u.click(screen.getByRole("button", { name: /Ouvrir Scénario s1/ }));
    await screen.findByText(/Détail du scénario : l'opération a échoué/);
    await u.click(screen.getByRole("button", { name: "Réessayer : Détail du scénario" }));
    expect(await screen.findByTestId("detail-scenario")).toBeInTheDocument();
  });
});

describe("accessibilite", () => {
  it("0 violation axe-core : liste, comparaison et detail ouverts (WCAG 2.1 A et AA, contraste exclu)", async () => {
    const u = userEvent.setup();
    const { container } = rendre();
    await screen.findByRole("table");
    await u.click(screen.getByRole("checkbox", { name: "Comparer Scénario s1" }));
    await u.click(screen.getByRole("checkbox", { name: "Comparer Scénario urgence" }));
    await u.click(screen.getByRole("button", { name: /Comparer les 2/ }));
    await screen.findByTestId("comparaison");
    await u.click(screen.getByRole("button", { name: /Ouvrir Scénario s1/ }));
    await screen.findByTestId("detail-scenario");
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

describe("droit d'export dans le detail", () => {
  async function ouvrirDetail(u: ReturnType<typeof userEvent.setup>) {
    rendre();
    await screen.findByRole("table");
    await u.click(screen.getByRole("button", { name: /Ouvrir Scénario s1/ }));
    return screen.findByTestId("detail-scenario");
  }
  it("un gestionnaire sans le module rapports : pas de bouton d'export, raison visible ; le rejeu reste disponible", async () => {
    h.modules = ["decision", "programmation"];
    const d = await ouvrirDetail(userEvent.setup());
    expect(within(d).queryByRole("button", { name: /Exporter/ })).not.toBeInTheDocument();
    expect(within(d).getByTestId("export-indisponible")).toHaveTextContent(/module Rapports/);
    expect(within(d).getByRole("button", { name: /Rejouer/ })).toBeInTheDocument();
  });
  it("un lecteur, meme avec le module rapports : export indisponible (role)", async () => {
    h.role = "LECTEUR";
    const d = await ouvrirDetail(userEvent.setup());
    expect(within(d).queryByRole("button", { name: /Exporter/ })).not.toBeInTheDocument();
    expect(within(d).getByTestId("export-indisponible")).toHaveTextContent(/administrateur et gestionnaire/);
  });
  it("l'administrateur exporte avec une liste de modules vide", async () => {
    h.role = "ADMIN";
    h.modules = [];
    const d = await ouvrirDetail(userEvent.setup());
    expect(within(d).getByRole("button", { name: /Exporter en CSV/ })).toBeEnabled();
  });
  it("erreur d'export 403 : la phrase du serveur, pas « Request failed »", async () => {
    const u = userEvent.setup();
    h.exporter.mockRejectedValue(Object.assign(new Error("Accès à ce module non autorisé pour votre compte"), { response: { status: 403, data: { error: "Accès à ce module non autorisé pour votre compte" } } }));
    const d = await ouvrirDetail(u);
    await u.click(within(d).getByRole("button", { name: /Exporter en CSV/ }));
    expect(await screen.findByText(/Export du scénario : accès refusé/)).toBeInTheDocument();
    expect(screen.queryByText(/Request failed/)).not.toBeInTheDocument();
  });
});

describe("suppression : pagination et comparaison restent vraies", () => {
  const page1 = Array.from({ length: 20 }, (_, i) => resumeSim(`p${i}`, { intitule: `Sc ${i}` }));

  it("supprimer la derniere ligne de la derniere page revient a la page precedente : ni page vide, ni faux « Aucun scénario »", async () => {
    const u = userEvent.setup();
    let supprime = false;
    h.lister.mockImplementation(async ({ page }: { page: number }) => {
      if (supprime) return page === 1 ? { data: page1, total: 20, page: 1, pageSize: 20 } : { data: [], total: 20, page, pageSize: 20 };
      return page === 1 ? { data: page1, total: 21, page: 1, pageSize: 20 } : { data: [resumeSim("dernier", { intitule: "Dernier scénario" })], total: 21, page: 2, pageSize: 20 };
    });
    h.lire.mockImplementation(async (id: string) => detailSim(id));
    h.supprimer.mockImplementation(async () => { supprime = true; return { ok: true, id: "dernier" }; });
    rendre();
    await screen.findByRole("table");
    await u.click(screen.getByRole("button", { name: "Page suivante" }));
    await u.click(await screen.findByRole("button", { name: /Ouvrir Dernier scénario/ }));
    const d = await screen.findByTestId("detail-scenario");
    await u.click(within(d).getByRole("button", { name: /Supprimer le scénario/ }));
    await u.click(await screen.findByRole("button", { name: "Confirmer la suppression" }));
    await waitFor(() => expect(h.supprimer).toHaveBeenCalledWith("dernier"));
    expect(await screen.findByRole("row", { name: /Sc 0/ })).toBeInTheDocument();
    expect(screen.queryByText("Aucun scénario enregistré")).not.toBeInTheDocument();
    expect(screen.queryByText(/Retour à la page précédente/)).not.toBeInTheDocument();
    expect(h.lister).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 }));
  });

  it("les controles de pagination restent visibles tant qu'il reste des scenarios, meme si la page courante est vide", async () => {
    h.lister.mockImplementation(async ({ page }: { page: number }) => (page === 1 ? { data: page1, total: 25, page: 1, pageSize: 20 } : { data: [], total: 25, page, pageSize: 20 }));
    const u = userEvent.setup();
    rendre();
    await screen.findByRole("table");
    await u.click(screen.getByRole("button", { name: "Page suivante" }));
    await waitFor(() => expect(screen.getByText(/Page 1 sur 2/)).toBeInTheDocument());
    expect(screen.queryByText("Aucun scénario enregistré")).not.toBeInTheDocument();
  });

  it("une comparaison qui montre un scenario supprime disparait", async () => {
    const u = userEvent.setup();
    const c = comparaisonSim();
    h.comparer.mockResolvedValue({ ...c, scenarios: c.scenarios.map((x, i) => ({ ...x, id: ["s1", "s2"][i] })) });
    rendre();
    await screen.findByRole("table");
    await u.click(screen.getByRole("checkbox", { name: "Comparer Scénario s1" }));
    await u.click(screen.getByRole("checkbox", { name: "Comparer Scénario urgence" }));
    await u.click(screen.getByRole("button", { name: /Comparer les 2/ }));
    await screen.findByTestId("comparaison");
    await u.click(screen.getByRole("button", { name: /Ouvrir Scénario s1/ }));
    const d = await screen.findByTestId("detail-scenario");
    await u.click(within(d).getByRole("button", { name: /Supprimer le scénario/ }));
    await u.click(await screen.findByRole("button", { name: "Confirmer la suppression" }));
    await waitFor(() => expect(screen.queryByTestId("comparaison")).not.toBeInTheDocument());
  });
});

describe("relance et reponse mal formee", () => {
  it("403 sur la liste : une seule requete (aucune relance) ; 500 : une relance puis la liste s'affiche", async () => {
    h.lister.mockRejectedValue(erreurHttp(403, "Accès refusé"));
    rendre();
    await screen.findByText(/Liste des scénarios : accès refusé/);
    await new Promise((r) => setTimeout(r, 1500));
    expect(h.lister).toHaveBeenCalledTimes(1);
    cleanup();
    h.lister.mockReset().mockRejectedValueOnce(erreurHttp(500, "panne")).mockResolvedValue(liste());
    rendre();
    expect(await screen.findByRole("table", {}, { timeout: 8000 })).toBeInTheDocument();
    expect(h.lister).toHaveBeenCalledTimes(2);
  });

  it("une liste mal formee (garde) : etat d'erreur propre avec « Réessayer », pas de plantage", async () => {
    const { ReponseInvalide } = await import("../../../lib/aideDecisionScenariosApi");
    h.lister.mockRejectedValue(new ReponseInvalide("liste des scénarios"));
    rendre();
    const e = await screen.findByText(/Liste des scénarios : l'opération a échoué/, {}, { timeout: 8000 });
    expect(e.closest("[role=alert]")).toHaveTextContent(/liste des scénarios\) est mal formée/);
    expect(screen.getByRole("button", { name: "Réessayer : Liste des scénarios" })).toBeInTheDocument();
  });
});
