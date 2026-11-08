import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { violationsAccessibilite } from "../../../test/accessibilite";
import { MENTION_SIMULATION } from "../../../lib/aideDecisionScenarios";
import { BilanBudgetaireVue } from "./BilanBudgetaireVue";
import { AvertissementsSimulation } from "./AvertissementsSimulation";
import { ContraintesVue } from "./ContraintesVue";
import { DistributionRegionale } from "./DistributionRegionale";
import { ResultatSimulationVue } from "./ResultatSimulationVue";
import { BILAN_DEFICIT, LIGNE_A, LIGNE_B, LIGNE_C, LIGNE_PERIMEE, scenarioSim, simulationBase } from "./simulation.fixtures";

/**
 * Lecture d'un resultat de simulation. Ce que ces tests defendent :
 *   - le DEFICIT n'est jamais masque : alerte, montant, solde signe ; un excedent est dit excedent ; un deficit est dit minimum
 *     quand des couts manquent ;
 *   - un cout PERIME ou manquant est mis en evidence et n'est JAMAIS affiche comme un montant ;
 *   - « simulation non engageante » est visible sur chaque resultat ;
 *   - l'ordre d'arbitrage et la priorite technique sont deux colonnes distinctes ;
 *   - la longueur metier absente se dit ; 0 violation axe-core.
 */
afterEach(() => cleanup());
const sp = (s: string | null) => (s ?? "").replace(/[\s\u202f\u00a0]/g, " ");
const regions = [{ id: 1, nom: "Basse-Guinée" }, { id: 2, nom: "Moyenne-Guinée" }];

describe("BilanBudgetaireVue", () => {
  it("un deficit est une ALERTE avec son montant, le besoin et le solde signe", () => {
    render(<BilanBudgetaireVue bilan={BILAN_DEFICIT} />);
    const lecture = screen.getByTestId("lecture-deficit");
    expect(lecture).toHaveAttribute("role", "alert");
    expect(lecture).toHaveAttribute("data-niveau", "deficit");
    expect(sp(lecture.textContent)).toContain("Déficit de 3 700 000 000 GNF");
    expect(sp(screen.getByTestId("bilan-budgetaire").textContent)).toContain("- 3 700 000 000 GNF");
    expect(sp(screen.getByTestId("bilan-budgetaire").textContent)).toContain("4 300 000 000 GNF");
  });

  it("un deficit d'un seul franc reste visible (pas arrondi a zero)", () => {
    render(<BilanBudgetaireVue bilan={{ ...BILAN_DEFICIT, deficitGnf: "1", soldeGnf: "-1" }} />);
    expect(sp(screen.getByTestId("lecture-deficit").textContent)).toContain("Déficit de 1 GNF");
    expect(screen.getByTestId("lecture-deficit")).toHaveAttribute("role", "alert");
  });

  it("deficit minorant : dit « minimum » avec le nombre de couts non fiables", () => {
    render(<BilanBudgetaireVue bilan={{ ...BILAN_DEFICIT, deficitMinorant: true, nbCoutsNonFiables: 2 }} />);
    expect(screen.getByTestId("lecture-deficit").textContent).toMatch(/Ce déficit est un minimum : 2 candidat\(s\)/);
  });

  it("excedent : dit comme tel, en statut (pas en alerte) ; egalite : dite egalite", () => {
    const { rerender } = render(<BilanBudgetaireVue bilan={{ ...BILAN_DEFICIT, deficitGnf: "0", excedentGnf: "1300000000", soldeGnf: "1300000000" }} />);
    expect(screen.getByTestId("lecture-deficit")).toHaveAttribute("role", "status");
    expect(sp(screen.getByTestId("lecture-deficit").textContent)).toContain("Aucun déficit : excédent de 1 300 000 000 GNF");
    rerender(<BilanBudgetaireVue bilan={{ ...BILAN_DEFICIT, deficitGnf: "0", excedentGnf: "0", soldeGnf: "0" }} />);
    expect(screen.getByTestId("lecture-deficit").textContent).toMatch(/égale le besoin chiffré/);
  });

  it("deficit des seules obligatoires", () => {
    render(<BilanBudgetaireVue bilan={{ ...BILAN_DEFICIT, besoinObligatoiresGnf: "4400000000", deficitObligatoiresGnf: "400000000" }} />);
    expect(sp(screen.getByTestId("bilan-budgetaire").textContent)).toContain("déficit de 400 000 000 GNF sur les seules obligatoires");
  });
});

describe("AvertissementsSimulation : couts manquants et perimes en evidence", () => {
  it("un bloc role=alert nomme les couts manquants et perimes, leurs tronçons, et dit qu'ils ne sont pas valorises", () => {
    const sim = simulationBase({ coutsNonFiables: [{ code: "COUT_PERIME", nb: 2, troncons: ["RN-P", "RN-Q"] }, { code: "COUT_NON_ESTIMABLE", nb: 1, troncons: ["RN-M"] }] });
    render(<AvertissementsSimulation simulation={sim} />);
    const bloc = screen.getByTestId("couts-non-fiables");
    expect(bloc).toHaveAttribute("role", "alert");
    expect(bloc.textContent).toContain("Coût périmé pour la période");
    expect(bloc.textContent).toContain("RN-P, RN-Q");
    expect(bloc.textContent).toContain("Coût manquant ou non estimable");
    expect(bloc.textContent).toMatch(/pas simulées avec un coût fiable/);
    expect(bloc.textContent).toMatch(/des minimums/);
  });

  it("sans cout non fiable, pas de bloc d'alerte de couts ; les alertes passent avant les informations", () => {
    render(<AvertissementsSimulation simulation={simulationBase()} />);
    expect(screen.queryByTestId("couts-non-fiables")).not.toBeInTheDocument();
    const items = within(screen.getByTestId("avertissements")).getAllByRole("listitem");
    expect(items.map((i) => i.getAttribute("data-niveau"))).toEqual(["ALERTE", "ALERTE", "INFO"]);
  });

  it("aucun avertissement : le dit", () => {
    render(<AvertissementsSimulation simulation={simulationBase({ avertissements: [] })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Aucun avertissement");
  });
});

describe("ContraintesVue", () => {
  it("une contrainte insatisfaisable est une alerte, non comblee", () => {
    const c = simulationBase().contraintes;
    render(<ContraintesVue regions={regions} codeDe={(id) => id.toUpperCase()}
      contraintes={{ ...c, obligatoires: { demandees: ["a"], effectives: ["a"], retenues: [], nonRetenues: ["a"] }, insatisfaisables: [{ code: "OBLIGATOIRE_NON_FINANCEE", portee: "TRONCON", reference: "a", detail: "l'intervention obligatoire RN-A n'est pas financée" }] }} />);
    const a = screen.getByTestId("contraintes-insatisfaisables");
    expect(a).toHaveAttribute("role", "alert");
    expect(a.textContent).toContain("Obligatoire non financée");
    expect(a.textContent).toMatch(/l'enveloppe n'est pas dépassée et aucun coût n'est ajusté/);
    expect(screen.getByText(/non financée\(s\) : A/)).toBeInTheDocument();
  });

  it("groupes retenus en entier ou ecartes en entier, plancher regional", () => {
    const c = simulationBase().contraintes;
    render(<ContraintesVue regions={regions} codeDe={(id) => id} contraintes={{
      ...c,
      groupesNonDivisibles: [{ numero: 1, membres: ["a", "c"], retenu: false, coutGnf: "5200000000", motif: { code: "BUDGET_INSUFFISANT", detail: "d" } }],
      equilibre: [{ regionId: 1, plancherGnf: "880000000", depenseGnf: "1100000000", atteint: true }, { regionId: 2, plancherGnf: "880000000", depenseGnf: "0", atteint: false }],
    }} />);
    expect(screen.getByText(/Groupe non divisible n°1/)).toHaveTextContent("écarté en entier");
    const t = screen.getByRole("table");
    expect(within(t).getByRole("row", { name: /Moyenne-Guinée/ })).toHaveTextContent("non");
  });

  it("aucune contrainte : le dit", () => {
    render(<ContraintesVue regions={regions} codeDe={(id) => id} contraintes={simulationBase().contraintes} />);
    expect(screen.getByText(/Aucune contrainte saisie/)).toBeInTheDocument();
  });
});

describe("ResultatSimulationVue", () => {
  it("porte la mention « simulation non engageante », le bandeau provisoire, la logique, la version des parametres et des baremes", () => {
    render(<ResultatSimulationVue resultat={scenarioSim()} regions={regions} />);
    expect(screen.getByTestId("mention-simulation")).toHaveTextContent(MENTION_SIMULATION);
    expect(screen.getByTestId("bandeau-provisoire")).toBeInTheDocument();
    expect(screen.getByText(/Logique de priorité : Ratio coût \/ impact/)).toBeInTheDocument();
    const synth = sp(screen.getByTestId("synthese-simulation").textContent);
    expect(synth).toContain("prog-provisoire-1");
    expect(synth).toContain("9 ligne(s)");
    expect(synth).toContain("2 sur 3 candidat(s)");
    expect(synth).toContain("11,000 km");
    expect(synth).toContain("54,6 %");
  });

  it("la mention reste visible meme si le serveur ne la renvoie pas dans le bloc", () => {
    render(<ResultatSimulationVue resultat={scenarioSim({ simulation: { mention: "" } })} regions={regions} />);
    expect(screen.getByTestId("mention-simulation")).toHaveTextContent("SIMULATION NON ENGAGEANTE");
  });

  it("longueur metier absente : dite, la geometrique est a part", () => {
    const k = { ...simulationBase().kilometres, metierKm: null, metierM: null, lignesAvecLongueurMetier: 0, lignesSansLongueurMetier: 2, geometriqueKm: "4.100", geometriqueM: 4100 };
    render(<ResultatSimulationVue resultat={scenarioSim({ simulation: { kilometres: k } })} regions={regions} />);
    const synth = sp(screen.getByTestId("synthese-simulation").textContent);
    expect(synth).toContain("longueur métier absente");
    expect(synth).toContain("géométrique à part : 4,100 km");
    expect(synth).not.toContain("0,000 km");
  });

  it("ordre d'arbitrage et priorite technique : deux colonnes, des valeurs differentes (A est la 1re techniquement, la 2e a l'arbitrage)", () => {
    render(<ResultatSimulationVue resultat={scenarioSim()} regions={regions} />);
    const t = screen.getByRole("table", { name: /Lignes de la simulation 2027/ });
    expect(within(t).getByRole("columnheader", { name: "Ordre d'arbitrage" })).toBeInTheDocument();
    expect(within(t).getByRole("columnheader", { name: "Priorité technique" })).toBeInTheDocument();
    const ligneA = within(t).getAllByRole("row").find((r) => r.textContent?.includes("RN-A"))!;
    const cellules = within(ligneA).getAllByRole("cell");
    expect([cellules[0].textContent, cellules[1].textContent]).toEqual(["2", "1"]);
  });

  it("un cout PERIME n'est jamais affiche comme un montant : « coût périmé » en rouge, motif libelle", () => {
    render(<ResultatSimulationVue resultat={scenarioSim({ lignes: [LIGNE_C, LIGNE_PERIMEE], simulation: { coutsNonFiables: [{ code: "COUT_PERIME", nb: 1, troncons: ["RN-P"] }] } })} regions={regions} />);
    const t = screen.getByRole("table", { name: /Lignes de la simulation/ });
    const ligneP = within(t).getAllByRole("row").find((r) => r.textContent?.includes("RN-P"))!;
    expect(ligneP).toHaveTextContent("coût périmé");
    expect(ligneP).toHaveTextContent("Coût périmé pour la période");
    expect(ligneP.textContent).not.toMatch(/\d{3}\s?000\s?000/);
    expect(screen.getByTestId("couts-non-fiables")).toBeInTheDocument();
    expect(screen.getByText(/Coût périmé pour la période : 1/)).toHaveTextContent("coût non valorisé");
  });

  it("MUTATION DE CONTROLE : une ligne marquee coutFiable=false avec un montant present n'est pas affichee comme fiable", () => {
    const mutee = { ...LIGNE_B, simulation: { ...LIGNE_B.simulation!, coutFiable: false } };
    render(<ResultatSimulationVue resultat={scenarioSim({ lignes: [mutee] })} regions={regions} />);
    const ligne = screen.getAllByRole("row").find((r) => r.textContent?.includes("RN-B"))!;
    expect(ligne).toHaveTextContent("coût non fiable");
    expect(ligne.textContent).not.toContain("3 500 000 000");
  });

  it("le detail d'une ligne montre la source du cout (bareme, version, validite, statut)", async () => {
    const u = userEvent.setup();
    render(<ResultatSimulationVue resultat={scenarioSim({ lignes: [LIGNE_C] })} regions={regions} />);
    await u.click(screen.getByRole("button", { name: /Justification de RN-C/ }));
    expect(screen.getByTestId("source-cout-RN-C")).toHaveTextContent(/barème n° 4, version 1, unité KM\/GNF, sans fenêtre de validité, provisoire/);
  });

  it("exclusions par motif et distribution territoriale (tableau + libelles de region)", () => {
    render(<ResultatSimulationVue resultat={scenarioSim()} regions={regions} />);
    expect(screen.getByText(/Budget insuffisant : 1/)).toBeInTheDocument();
    const d = screen.getByTestId("distribution-regionale");
    expect(within(d).getByRole("row", { name: /Basse-Guinée/ })).toHaveTextContent("800 000 000");
    expect(within(d).getByRole("row", { name: /Moyenne-Guinée/ })).toHaveTextContent("100");
  });

  it("un scenario sans bloc simulation (herite) est signale, pas affiche comme une simulation", () => {
    render(<ResultatSimulationVue resultat={{ ...scenarioSim(), simulation: undefined }} regions={regions} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/avant le simulateur/);
  });

  it("MUTATION DE CONTROLE : un resultat en deficit ne peut pas se lire comme « Aucun déficit »", () => {
    render(<ResultatSimulationVue resultat={scenarioSim()} regions={regions} />);
    expect(screen.queryByText(/Aucun déficit/)).not.toBeInTheDocument();
    expect(screen.getByTestId("lecture-deficit")).toHaveAttribute("data-niveau", "deficit");
  });

  it("0 violation d'accessibilite (axe-core, WCAG 2.1 A et AA, contraste exclu) sur un resultat complet avec cout perime et contraintes", async () => {
    const sim = simulationBase({
      coutsNonFiables: [{ code: "COUT_PERIME", nb: 1, troncons: ["RN-P"] }],
      contraintes: { ...simulationBase().contraintes, equilibre: [{ regionId: 1, plancherGnf: "1", depenseGnf: "2", atteint: true }], insatisfaisables: [{ code: "EQUILIBRE_NON_ATTEINT", portee: "REGION", reference: "2", detail: "d" }] },
    });
    const { container } = render(<ResultatSimulationVue resultat={scenarioSim({ lignes: [LIGNE_C, LIGNE_A, LIGNE_B, LIGNE_PERIMEE], simulation: sim })} regions={regions} />);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

describe("ratio indefini : « non calculable », jamais 0 %", () => {
  it("enveloppe nulle : la part consommee de l'enveloppe est non calculable (pas « 0 % de l'enveloppe »)", () => {
    const bilan = { ...BILAN_DEFICIT, enveloppeGnf: "0", consommeGnf: "0", resteGnf: "0", deficitGnf: "8700000000", soldeGnf: "-8700000000", couvertureBesoinPct: "0.0" };
    render(<BilanBudgetaireVue bilan={bilan} />);
    const t = sp(screen.getByTestId("bilan-budgetaire").textContent);
    expect(t).toContain("non calculable de l'enveloppe");
    expect(t).not.toMatch(/0 % de l'enveloppe/);
  });

  it("enveloppe non nulle et rien consomme : le vrai 0 % reste un 0 %", () => {
    render(<BilanBudgetaireVue bilan={{ ...BILAN_DEFICIT, consommeGnf: "0" }} />);
    expect(sp(screen.getByTestId("bilan-budgetaire").textContent)).toContain("0 % de l'enveloppe");
  });

  it("distribution : un besoin chiffre nul donne « non calculable » et une barre vide, pas 0 %", () => {
    render(<DistributionRegionale regions={regions} distribution={[
      { regionId: 1, nbRetenues: 0, engageGnf: "0", nbEcartees: 1, besoinGnf: "0" },
      { regionId: 2, nbRetenues: 1, engageGnf: "0", nbEcartees: 0, besoinGnf: "3500000000" },
    ]} />);
    const a = screen.getByRole("row", { name: /Basse-Guinée/ });
    expect(a).toHaveTextContent("non calculable");
    expect(a.textContent).not.toMatch(/\b0\s?%/);
    expect(screen.getByRole("row", { name: /Moyenne-Guinée/ })).toHaveTextContent(/0\s?%/);
  });
});
