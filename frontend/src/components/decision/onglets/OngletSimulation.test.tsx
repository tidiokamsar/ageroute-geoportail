import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { violationsAccessibilite } from "../../../test/accessibilite";
import { CANDIDATS, OPTIONS, scenarioSim } from "../simulation/simulation.fixtures";

/**
 * Onglet « Simulation budgetaire ». Ce que ces tests defendent :
 *   - aucune enveloppe n'est proposee ; une enveloppe negative, decimale ou non numerique bloque l'envoi AVANT le reseau ;
 *   - la demande part avec l'enveloppe en CHAINE de chiffres, la periode, la logique ; rien d'autre que ce qui est saisi ;
 *   - le resultat dit deficit, couts perimes, mention « non engageante » ; enregistrer puis exporter ; un export sans mention est refuse ;
 *   - les etats : chargement, vide, erreur avec « Reessayer », permission refusee (403) distincte d'une panne, lecture seule d'un lecteur ;
 *   - 0 violation axe-core.
 */
const h = vi.hoisted(() => ({
  role: "GESTIONNAIRE",
  modules: ["decision", "programmation", "rapports"] as string[],
  simuler: vi.fn(), enregistrer: vi.fn(), exporter: vi.fn(), remettre: vi.fn(), options: vi.fn(), candidats: vi.fn(),
}));
vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: { id: "u-1", role: h.role, nomComplet: "Awa Camara", modulesAutorises: h.modules } }) }));
vi.mock("../../../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../../../lib/api", () => ({
  api: {
    get: vi.fn(async (url: string) => {
      if (url === "/regions") return { data: [{ id: 1, nom: "Basse-Guinée" }, { id: 2, nom: "Moyenne-Guinée" }] };
      if (url.endsWith("/moteur/parametres")) return { data: { data: [{ id: "p-seed", version: "prog-provisoire-1", source: "amorcage_provisoire", valeurs: {}, motif: null, provisoire: true, etiquette: "PROVISOIRE, non approuvé", approuveeLe: null }] } };
      throw new Error(`URL inattendue ${url}`);
    }),
  },
}));
vi.mock("../../../lib/aideDecisionScenariosApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/aideDecisionScenariosApi")>()),
  chargerOptions: (...a: unknown[]) => h.options(...a), chargerCandidats: (...a: unknown[]) => h.candidats(...a),
  simuler: (...a: unknown[]) => h.simuler(...a), enregistrerScenario: (...a: unknown[]) => h.enregistrer(...a),
  telechargerExport: (...a: unknown[]) => h.exporter(...a), remettreFichier: (...a: unknown[]) => h.remettre(...a),
}));

import { ExportSansMention } from "../../../lib/aideDecisionScenariosApi";
import { OngletSimulation } from "./OngletSimulation";

const erreurHttp = (status: number, error: string) => Object.assign(new Error(error), { response: { status, data: { error } } });

function rendre(filtres = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><OngletSimulation filtres={filtres} onFiltres={() => undefined} /></QueryClientProvider>);
}

beforeEach(() => {
  cleanup();
  h.role = "GESTIONNAIRE";
  h.modules = ["decision", "programmation", "rapports"];
  h.options.mockReset().mockResolvedValue(OPTIONS);
  h.candidats.mockReset().mockResolvedValue(CANDIDATS);
  h.simuler.mockReset().mockResolvedValue({ resultat: scenarioSim(), empreinteEntrees: "e".repeat(64), empreinteResultat: "r".repeat(64), enregistre: false });
  h.enregistrer.mockReset().mockResolvedValue({ scenario: { id: "s1", intitule: "PAE 2027 essai", creeParId: "u-1", creeLe: "2026-10-26T09:00:00.000Z", empreinteEntrees: "e".repeat(64), empreinteResultat: "r".repeat(64), budgetGnf: "5000000000" }, resultat: scenarioSim() });
  h.exporter.mockReset().mockResolvedValue({ blob: new Blob(["x"]), nom: "simulation-s1.csv" });
  h.remettre.mockReset();
});

async function remplir(u: ReturnType<typeof userEvent.setup>, enveloppe = "5 000 000 000") {
  await screen.findByRole("radio", { name: /Ratio coût \/ impact/ });
  fireEvent.change(screen.getByLabelText("Début de la période"), { target: { value: "2027-01-01" } });
  fireEvent.change(screen.getByLabelText("Fin de la période"), { target: { value: "2027-12-31" } });
  const champ = screen.getByLabelText(/Enveloppe budgétaire/);
  await u.clear(champ);
  await u.type(champ, enveloppe);
  await u.click(screen.getByRole("radio", { name: /Ratio coût \/ impact/ }));
}

describe("saisie : aucune valeur proposee, validation avant le reseau", () => {
  it("l'enveloppe part vide, la mention est visible, aucun resultat n'est propose d'avance", async () => {
    rendre();
    expect(screen.getByLabelText(/Enveloppe budgétaire/)).toHaveValue("");
    expect(screen.getByTestId("mention-simulation")).toHaveTextContent("SIMULATION NON ENGAGEANTE : ne constitue ni une autorisation de dépense ni un ordre de travaux.");
    expect(screen.getByTestId("aide-simulation")).toHaveTextContent(/Rien n'est calculé ni proposé d'avance/);
    expect(screen.queryByTestId("resultat-simulation")).not.toBeInTheDocument();
    await screen.findByRole("radio", { name: /Ratio coût \/ impact/ });
  });

  it("lancer sans rien saisir : erreurs nommees, aucun appel", async () => {
    const u = userEvent.setup();
    rendre();
    await screen.findByRole("radio", { name: /Urgence/ });
    await u.click(screen.getByRole("button", { name: "Simuler" }));
    const e = screen.getByTestId("erreurs-formulaire");
    expect(e).toHaveAttribute("role", "alert");
    expect(e).toHaveTextContent(/Saisissez l'enveloppe en GNF/);
    expect(e).toHaveTextContent(/Choisissez une logique de priorité/);
    expect(h.simuler).not.toHaveBeenCalled();
  });

  it.each([["-5000", /négative/], ["1,5", /francs entiers/], ["abc", /non numérique/], ["12345678901234567890", /18 chiffres/]])("enveloppe « %s » : refusee avec sa raison, aucun appel", async (saisie, motif) => {
    const u = userEvent.setup();
    rendre();
    await remplir(u, saisie);
    expect(screen.getByLabelText(/Enveloppe budgétaire/)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getAllByRole("alert").some((a) => motif.test(a.textContent ?? ""))).toBe(true);
    await u.click(screen.getByRole("button", { name: "Simuler" }));
    expect(h.simuler).not.toHaveBeenCalled();
  });

  it("une periode inversee est refusee avant l'envoi", async () => {
    const u = userEvent.setup();
    rendre();
    await remplir(u);
    fireEvent.change(screen.getByLabelText("Fin de la période"), { target: { value: "2026-01-01" } });
    expect(screen.getByRole("alert")).toHaveTextContent(/précède le début/);
    await u.click(screen.getByRole("button", { name: "Simuler" }));
    expect(h.simuler).not.toHaveBeenCalled();
  });

  it("l'enveloppe valide est relue en clair (francs et milliards), sans flottant", async () => {
    const u = userEvent.setup();
    rendre();
    await remplir(u, "8 700 000 000");
    expect(screen.getByText(/Soit .*8.*700.*000.*000.*GNF \(8,70.*Md GNF\)/)).toBeInTheDocument();
  });
});

describe("simulation : la demande et le resultat", () => {
  it("la demande part avec l'enveloppe en CHAINE de chiffres, la periode, l'annee du debut, la logique ; rien d'autre", async () => {
    const u = userEvent.setup();
    rendre();
    await remplir(u);
    await u.click(screen.getByRole("button", { name: "Simuler" }));
    await waitFor(() => expect(h.simuler).toHaveBeenCalledTimes(1));
    expect(h.simuler.mock.calls[0][0]).toEqual({ annee: 2027, budgetGnf: "5000000000", periode: { debut: "2027-01-01", fin: "2027-12-31" }, logique: "ratio_cout_impact" });
  });

  it("un resultat en deficit : alerte avec le montant, couts non fiables en evidence, mention, lignes", async () => {
    const u = userEvent.setup();
    h.simuler.mockResolvedValue({ resultat: scenarioSim({ simulation: { coutsNonFiables: [{ code: "COUT_PERIME", nb: 1, troncons: ["RN-P"] }] } }), empreinteEntrees: "", empreinteResultat: "", enregistre: false });
    rendre();
    await remplir(u);
    await u.click(screen.getByRole("button", { name: "Simuler" }));
    const lecture = await screen.findByTestId("lecture-deficit");
    expect(lecture).toHaveAttribute("role", "alert");
    expect(lecture.textContent?.replace(/[\s\u202f\u00a0]/g, " ")).toContain("Déficit de 3 700 000 000 GNF");
    expect(screen.getByTestId("couts-non-fiables")).toHaveTextContent(/Coût périmé pour la période : 1 intervention/);
    expect(screen.getAllByTestId("mention-simulation").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId("lignes-simulation")).toBeInTheDocument();
  });

  it("si la saisie change apres le calcul, l'ecran dit que le resultat ne lui correspond plus", async () => {
    const u = userEvent.setup();
    rendre();
    await remplir(u);
    await u.click(screen.getByRole("button", { name: "Simuler" }));
    await screen.findByTestId("resultat-simulation");
    expect(screen.queryByTestId("resultat-perime")).not.toBeInTheDocument();
    await u.type(screen.getByLabelText(/Enveloppe budgétaire/), "0");
    expect(screen.getByTestId("resultat-perime")).toHaveTextContent(/ne lui correspond plus/);
  });

  it("selection : decocher « toutes » puis une intervention l'exclut ; une obligatoire et un groupe partent dans la demande", async () => {
    const u = userEvent.setup();
    rendre();
    await remplir(u);
    const tous = await screen.findByRole("checkbox", { name: /Examiner toutes les interventions candidates/ });
    await u.click(tous);
    await u.click(screen.getByRole("checkbox", { name: "Examiner RN-B" }));
    await u.click(screen.getByRole("checkbox", { name: "RN-A obligatoire" }));
    await u.selectOptions(screen.getByLabelText("Groupe non divisible de RN-A"), "Nouveau groupe");
    await u.selectOptions(screen.getByLabelText("Groupe non divisible de RN-C"), "Groupe 1");
    await u.click(screen.getByRole("button", { name: "Simuler" }));
    await waitFor(() => expect(h.simuler).toHaveBeenCalled());
    expect(h.simuler.mock.calls[0][0]).toMatchObject({ selection: ["c", "a"], obligatoires: ["a"], groupesNonDivisibles: [["a", "c"]] });
  });

  it("une intervention decochee n'est plus obligatoire", async () => {
    const u = userEvent.setup();
    rendre();
    await remplir(u);
    await u.click(await screen.findByRole("checkbox", { name: /Examiner toutes/ }));
    await u.click(screen.getByRole("checkbox", { name: "RN-A obligatoire" }));
    await u.click(screen.getByRole("checkbox", { name: "Examiner RN-A" }));
    expect(screen.getByRole("checkbox", { name: "RN-A obligatoire" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "RN-A obligatoire" })).toBeDisabled();
  });

  it("la longueur metier absente est dite dans la liste des candidats, la geometrique est a part", async () => {
    rendre();
    const ligneA = (await screen.findByRole("row", { name: /RN-A/ }));
    expect(ligneA).toHaveTextContent("longueur métier absente");
    expect(ligneA).toHaveTextContent(/géométrique, à part/);
  });

  it("equilibre territorial : la part minimale est exigee ; ordre personnalise : monter, descendre, retirer au clavier", async () => {
    const u = userEvent.setup();
    rendre();
    await remplir(u);
    await u.click(screen.getByRole("radio", { name: /Équilibre territorial/ }));
    await u.click(screen.getByRole("button", { name: "Simuler" }));
    expect(screen.getByTestId("erreurs-formulaire")).toHaveTextContent(/Part minimale par région/);
    await u.type(screen.getByLabelText(/Part minimale de l'enveloppe/), "30");
    await u.click(screen.getByRole("button", { name: "Simuler" }));
    await waitFor(() => expect(h.simuler.mock.calls[0]?.[0]).toMatchObject({ logique: "equilibre_territorial", equilibre: { partMinimaleParRegionPct: 30 } }));

    await u.click(screen.getByRole("radio", { name: /Ordre personnalisé/ }));
    const ordre = screen.getByTestId("ordre-personnalise");
    await u.selectOptions(within(ordre).getByLabelText("Ajouter un tronçon à l'ordre"), "RN-A");
    await u.click(within(ordre).getByRole("button", { name: "Ajouter" }));
    await u.selectOptions(within(ordre).getByLabelText("Ajouter un tronçon à l'ordre"), "RN-B");
    await u.click(within(ordre).getByRole("button", { name: "Ajouter" }));
    await u.click(within(ordre).getByRole("button", { name: "Monter RN-B" }));
    expect(within(ordre).getAllByRole("listitem").map((l) => l.textContent?.replace(/\d+\./, "").trim().slice(0, 4))).toEqual(["RN-B", "RN-A"]);
    await u.click(within(ordre).getByRole("button", { name: "Retirer RN-A de l'ordre" }));
    expect(within(ordre).getAllByRole("listitem")).toHaveLength(1);
  });

  it("baremes : statut provisoire/approuve, validite, et alerte quand la fenetre ne couvre pas la periode ; en decocher un envoie les identifiants retenus", async () => {
    const u = userEvent.setup();
    rendre();
    await remplir(u);
    const t = await screen.findByRole("table", { name: /Barèmes de coût applicables/ });
    expect(within(t).getByRole("row", { name: /n° 2/ })).toHaveTextContent("provisoire (non approuvé)");
    expect(within(t).getByRole("row", { name: /BAR-3/ })).toHaveTextContent("approuvé");
    expect(within(t).getByRole("row", { name: /BAR-3/ })).toHaveTextContent("ne couvre pas la période : coûts périmés");
    await u.click(screen.getByRole("checkbox", { name: "Retenir le barème BAR-3" }));
    await u.click(screen.getByRole("button", { name: "Simuler" }));
    await waitFor(() => expect(h.simuler).toHaveBeenCalled());
    expect(h.simuler.mock.calls[0][0].baremeIds).toEqual([2]);
  });
});

describe("enregistrer et exporter", () => {
  async function jusqueAuResultat(u: ReturnType<typeof userEvent.setup>) {
    rendre();
    await remplir(u);
    await u.click(screen.getByRole("button", { name: "Simuler" }));
    await screen.findByTestId("actions-scenario");
  }

  it("enregistrer sous un nom : auteur et date affiches, empreinte, puis export propose ; l'export remet le fichier", async () => {
    const u = userEvent.setup();
    await jusqueAuResultat(u);
    expect(screen.queryByRole("button", { name: /Exporter en CSV/ })).not.toBeInTheDocument();
    const bouton = screen.getByRole("button", { name: "Enregistrer le scénario" });
    expect(bouton).toBeDisabled();
    await u.type(screen.getByLabelText(/Nom du scénario/), "PAE 2027 essai");
    await u.click(bouton);
    const ok = await screen.findByTestId("scenario-enregistre");
    expect(ok).toHaveTextContent(/Scénario enregistré : PAE 2027 essai/);
    expect(ok).toHaveTextContent(/Auteur : Awa Camara/);
    expect(h.enregistrer.mock.calls[0][1]).toBe("PAE 2027 essai");
    expect(h.enregistrer.mock.calls[0][0]).toMatchObject({ budgetGnf: "5000000000" });
    await u.click(screen.getByRole("button", { name: /Exporter en CSV/ }));
    await waitFor(() => expect(h.remettre).toHaveBeenCalledTimes(1));
    expect(h.exporter).toHaveBeenCalledWith("s1", "csv");
    expect(h.remettre.mock.calls[0][1]).toBe("simulation-s1.csv");
  });

  it("MUTATION DE CONTROLE : un export sans la mention « non engageante » est refuse et n'est pas remis", async () => {
    const u = userEvent.setup();
    h.exporter.mockRejectedValue(new ExportSansMention());
    await jusqueAuResultat(u);
    await u.type(screen.getByLabelText(/Nom du scénario/), "PAE 2027 essai");
    await u.click(screen.getByRole("button", { name: "Enregistrer le scénario" }));
    await u.click(await screen.findByRole("button", { name: /Exporter en JSON/ }));
    const a = await screen.findByText(/ne porte pas la mention « simulation non engageante »/);
    expect(a.closest("[role=alert]")).not.toBeNull();
    expect(h.remettre).not.toHaveBeenCalled();
  });

  it("un enregistrement refuse (409) est dit, le scenario n'est pas presente comme enregistre", async () => {
    const u = userEvent.setup();
    h.enregistrer.mockRejectedValue(erreurHttp(409, "conflit d'enregistrement"));
    await jusqueAuResultat(u);
    await u.type(screen.getByLabelText(/Nom du scénario/), "PAE 2027 essai");
    await u.click(screen.getByRole("button", { name: "Enregistrer le scénario" }));
    expect(await screen.findByText(/conflit d'enregistrement/)).toBeInTheDocument();
    expect(screen.queryByTestId("scenario-enregistre")).not.toBeInTheDocument();
  });

  it("un nom trop court laisse le bouton inactif", async () => {
    const u = userEvent.setup();
    await jusqueAuResultat(u);
    await u.type(screen.getByLabelText(/Nom du scénario/), "ab");
    expect(screen.getByRole("button", { name: "Enregistrer le scénario" })).toBeDisabled();
  });
});

describe("etats : droits, erreurs, vide", () => {
  it("un lecteur ne simule pas : bouton inactif et phrase d'explication, aucun appel", async () => {
    h.role = "LECTEUR";
    const u = userEvent.setup();
    rendre();
    await remplir(u);
    expect(screen.getByRole("button", { name: "Simuler" })).toBeDisabled();
    expect(screen.getByText(/réservé aux rôles administrateur et gestionnaire/)).toBeInTheDocument();
    expect(h.simuler).not.toHaveBeenCalled();
  });

  it("403 du serveur : « accès refusé », distinct d'une panne (pas de bouton Réessayer)", async () => {
    const u = userEvent.setup();
    h.simuler.mockRejectedValue(erreurHttp(403, "Accès à ce module non autorisé pour votre compte"));
    rendre();
    await remplir(u);
    await u.click(screen.getByRole("button", { name: "Simuler" }));
    const e = await screen.findByText(/Simulation : accès refusé/);
    expect(e.closest("[data-etat=permission]")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Réessayer : Simulation/ })).not.toBeInTheDocument();
  });

  it("panne 500 : alerte avec « Réessayer » qui relance le calcul", async () => {
    const u = userEvent.setup();
    h.simuler.mockRejectedValueOnce(erreurHttp(500, "erreur interne")).mockResolvedValue({ resultat: scenarioSim(), empreinteEntrees: "", empreinteResultat: "", enregistre: false });
    rendre();
    await remplir(u);
    await u.click(screen.getByRole("button", { name: "Simuler" }));
    const alerte = await screen.findByText(/Simulation : l'opération a échoué/);
    expect(alerte.closest("[role=alert]")).not.toBeNull();
    await u.click(screen.getByRole("button", { name: "Réessayer : Simulation" }));
    await screen.findByTestId("resultat-simulation");
    expect(h.simuler).toHaveBeenCalledTimes(2);
  });

  it("refus metier 422 : la phrase du serveur est dite", async () => {
    const u = userEvent.setup();
    h.simuler.mockRejectedValue(erreurHttp(422, "plus de 3000 tronçons candidats : restreignez le périmètre"));
    rendre();
    await remplir(u);
    await u.click(screen.getByRole("button", { name: "Simuler" }));
    expect(await screen.findByText(/restreignez le périmètre/)).toBeInTheDocument();
  });

  it("chargement des candidats, puis vide explicite (jamais un zero muet)", async () => {
    h.candidats.mockResolvedValue({ total: 0, tronque: false, maxCandidats: 3000, data: [] });
    rendre();
    expect(screen.getByText("Chargement des interventions candidates…")).toHaveAttribute("role", "status");
    expect(await screen.findByText("Aucune intervention candidate dans ce périmètre")).toBeInTheDocument();
  });

  it("candidats en erreur : alerte avec « Réessayer » qui recharge ; candidats refuses (403) : acces refuse", async () => {
    const u = userEvent.setup();
    h.candidats.mockRejectedValueOnce(erreurHttp(500, "base indisponible")).mockRejectedValueOnce(erreurHttp(500, "base indisponible")).mockResolvedValue(CANDIDATS);
    rendre();
    const e = await screen.findByText(/Interventions candidates : l'opération a échoué/);
    expect(e.closest("[role=alert]")).toHaveTextContent("base indisponible");
    await u.click(screen.getByRole("button", { name: "Réessayer : Interventions candidates" }));
    expect(await screen.findByRole("checkbox", { name: "Examiner RN-C" })).toBeInTheDocument();
    cleanup();
    h.candidats.mockReset().mockRejectedValue(erreurHttp(403, ""));
    rendre();
    expect(await screen.findByText(/Interventions candidates : accès refusé/)).toBeInTheDocument();
  });

  it("options en erreur : dit, avec « Réessayer »", async () => {
    h.options.mockRejectedValue(erreurHttp(500, "options indisponibles"));
    rendre();
    expect(await screen.findByText(/Logiques et barèmes : l'opération a échoué/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Réessayer : Logiques et barèmes" })).toBeInTheDocument();
  });

  it("plus de 3000 candidats : le dit, le perimetre n'est pas examine tronque en silence", async () => {
    h.candidats.mockResolvedValue({ ...CANDIDATS, tronque: true });
    rendre();
    expect(await screen.findByText(/Plus de 3000 candidats/)).toBeInTheDocument();
  });
});

describe("accessibilite", () => {
  it("0 violation axe-core sur le formulaire (WCAG 2.1 A et AA, contraste exclu)", async () => {
    const { container } = rendre();
    await screen.findByRole("table", { name: /Barèmes/ });
    await screen.findByRole("checkbox", { name: "Examiner RN-C" });
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("0 violation axe-core avec un resultat, le formulaire d'enregistrement et l'export", async () => {
    const u = userEvent.setup();
    const { container } = rendre();
    await remplir(u);
    await u.click(screen.getByRole("button", { name: "Simuler" }));
    await screen.findByTestId("actions-scenario");
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("les cibles tactiles du formulaire ont une hauteur minimale de 44 px sous 1280 px", async () => {
    rendre();
    await screen.findByRole("radio", { name: /Urgence/ });
    for (const nom of [/Enveloppe budgétaire/, "Début de la période", "Fin de la période"]) expect(screen.getByLabelText(nom).className).toMatch(/min-h-\[44px\]/);
    expect(screen.getByRole("button", { name: "Simuler" }).className).toMatch(/min-h-\[44px\]/);
  });
});

describe("droit d'export : la regle du serveur (module rapports ET role ADMIN ou GESTIONNAIRE)", () => {
  async function enregistrerUnScenario(u: ReturnType<typeof userEvent.setup>) {
    rendre();
    await remplir(u);
    await u.click(screen.getByRole("button", { name: "Simuler" }));
    await screen.findByTestId("actions-scenario");
    await u.type(screen.getByLabelText(/Nom du scénario/), "PAE 2027 essai");
    await u.click(screen.getByRole("button", { name: "Enregistrer le scénario" }));
    await screen.findByTestId("scenario-enregistre");
  }

  it("un gestionnaire SANS le module rapports n'a pas de bouton d'export : la raison est visible", async () => {
    h.modules = ["decision", "programmation"];
    await enregistrerUnScenario(userEvent.setup());
    expect(screen.queryByRole("button", { name: /Exporter en/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("export-indisponible")).toHaveTextContent("Export indisponible : votre compte n'a pas accès au module Rapports.");
  });

  it("une liste de modules VIDE vaut aucun module pour un gestionnaire (et non « tous »)", async () => {
    h.modules = [];
    await enregistrerUnScenario(userEvent.setup());
    expect(screen.queryByRole("button", { name: /Exporter en CSV/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("export-indisponible")).toBeInTheDocument();
  });

  it("l'administrateur exporte meme avec une liste de modules vide", async () => {
    h.role = "ADMIN";
    h.modules = [];
    await enregistrerUnScenario(userEvent.setup());
    expect(screen.getByRole("button", { name: /Exporter en CSV/ })).toBeEnabled();
    expect(screen.queryByTestId("export-indisponible")).not.toBeInTheDocument();
  });

  it("un export refuse par le serveur (403) affiche la phrase du serveur, pas « Request failed »", async () => {
    const u = userEvent.setup();
    h.exporter.mockRejectedValue(Object.assign(new Error("Accès à ce module non autorisé pour votre compte"), { response: { status: 403, data: { error: "Accès à ce module non autorisé pour votre compte" } } }));
    await enregistrerUnScenario(u);
    await u.click(screen.getByRole("button", { name: /Exporter en CSV/ }));
    const e = await screen.findByText(/Export du scénario : accès refusé/);
    expect(e.closest("[data-etat=permission]")).toHaveTextContent("Accès à ce module non autorisé pour votre compte");
    expect(screen.queryByText(/Request failed/)).not.toBeInTheDocument();
  });
});

describe("relance : aucune sur 400, 401, 403, 404", () => {
  it("une erreur 403 sur les candidats n'est pas relancee ; une erreur 500 l'est une fois", async () => {
    h.candidats.mockRejectedValue(erreurHttp(403, ""));
    rendre();
    await screen.findByText(/Interventions candidates : accès refusé/);
    await new Promise((r) => setTimeout(r, 1500));
    expect(h.candidats).toHaveBeenCalledTimes(1);
    cleanup();
    h.candidats.mockReset().mockRejectedValueOnce(erreurHttp(500, "panne")).mockResolvedValue(CANDIDATS);
    rendre();
    expect(await screen.findByRole("checkbox", { name: "Examiner RN-C" }, { timeout: 8000 })).toBeInTheDocument();
    expect(h.candidats).toHaveBeenCalledTimes(2);
  });
});

describe("reponse mal formee", () => {
  it("une reponse refusee par la garde donne un etat d'erreur propre, pas une exception de rendu", async () => {
    const { ReponseInvalide } = await import("../../../lib/aideDecisionScenariosApi");
    h.options.mockRejectedValue(new ReponseInvalide("options du simulateur"));
    rendre();
    const e = await screen.findByText(/Logiques et barèmes : l'opération a échoué/);
    expect(e.closest("[role=alert]")).toHaveTextContent(/options du simulateur\) est mal formée/);
  });
});
