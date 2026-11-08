import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../lib/api", () => ({ api: { get: h.get } }));

import { useQualiteMethodes } from "../../lib/teledetectionHooks";
import type { LigneQualiteMethode, QualiteMethodes as Qualite } from "../../lib/teledetectionApi";
import { QualiteMethodes } from "./QualiteMethodes";
import { rendreAvecClient } from "./rendre.testutil";
import { echec, routeurGet } from "./synthetique.testutil";
import { violationsAccessibilite } from "../../test/accessibilite";

/**
 * Panneau « Qualite par methode » (contrat §7). Defendu : jamais un pourcentage sans son effectif, « echantillon insuffisant » sous le
 * seuil, « Aucun verdict » (pas 0 %) a zero verdict, et le refus d'un compte REGIONAL (403 HORS_PERIMETRE) rendu comme une absence de
 * permission dediee, ni une erreur ni un vide. Donnees SYNTHETIQUES.
 */

function Harnais() {
  return <QualiteMethodes qualite={useQualiteMethodes()} />;
}

const ligne = (over: Partial<LigneQualiteMethode> = {}): LigneQualiteMethode => ({
  type: "INONDATION", methode: "meth-synth v1", methodeNom: "meth-synth", methodeVersion: "v1", total: 12, aVerifier: 0, enAttente: 0, nonConcluantes: 0,
  confirmees: 8, infirmees: 4, jugees: 12, tauxConfirmation: 0.667, echantillonSuffisant: false, seuilEchantillon: 30, ...over,
});
const qualite = (lignes: LigneQualiteMethode[]): Qualite => ({ seuilEchantillon: 30, definition: "Confirmées ÷ (confirmées + infirmées).", lignes });
const servir = (q: Qualite | Error) => h.get.mockImplementation(routeurGet({ "/v2/teledetection/qualite-methodes": q }));

beforeEach(() => { h.get.mockReset(); });

describe("QualiteMethodes", () => {
  it("chaque taux porte son effectif ; sous le seuil, « echantillon insuffisant » ; au-dessus, aucune reserve", async () => {
    servir(qualite([
      ligne({ type: "INONDATION", methode: "meth-a v1", confirmees: 8, infirmees: 4, jugees: 12, echantillonSuffisant: false }),
      ligne({ type: "VEGETATION", methode: "meth-b v2", confirmees: 37, infirmees: 24, jugees: 61, echantillonSuffisant: true, total: 61 }),
    ]));
    rendreAvecClient(<Harnais />);
    const table = await screen.findByRole("table", { name: /Verdicts du terrain par type de changement et par méthode/ });
    const l1 = within(table).getByText("meth-a v1").closest("tr") as HTMLElement;
    expect(l1).toHaveTextContent("66,7 %");
    expect(l1).toHaveTextContent("(n = 12)");
    expect(within(l1).getByTestId("echantillon-insuffisant")).toHaveTextContent("Échantillon insuffisant (n = 12)");
    const l2 = within(table).getByText("meth-b v2").closest("tr") as HTMLElement;
    expect(l2).toHaveTextContent("60,7 %");
    expect(l2).toHaveTextContent("(n = 61)");
    expect(within(l2).queryByTestId("echantillon-insuffisant")).not.toBeInTheDocument();
    // chaque pourcentage visible est suivi de son effectif : aucun « % » sans « (n = »
    const pourcentages = (table.textContent ?? "").match(/\d+,\d\s%/g) ?? [];
    expect(pourcentages).toHaveLength(2);
    expect((table.textContent ?? "").match(/\d+,\d\s%\s*\(n = \d+\)/g)).toHaveLength(2); // chaque pourcentage est SUIVI de son effectif
  });

  it("le serveur dit « echantillon insuffisant » meme au-dessus du seuil local : on retient le plus prudent", async () => {
    servir(qualite([ligne({ confirmees: 20, infirmees: 15, jugees: 35, echantillonSuffisant: false })]));
    rendreAvecClient(<Harnais />);
    expect(await screen.findByTestId("echantillon-insuffisant")).toHaveTextContent("Échantillon insuffisant (n = 35)");
  });

  it("zero verdict : « Aucun verdict », jamais 0 %", async () => {
    servir(qualite([ligne({ type: "NOUVELLE_ROUTE", methode: "meth-c v1", confirmees: 0, infirmees: 0, jugees: 0, total: 4, aVerifier: 4, tauxConfirmation: null })]));
    rendreAvecClient(<Harnais />);
    const l = (await screen.findByText("meth-c v1")).closest("tr") as HTMLElement;
    expect(l).toHaveTextContent("Aucun verdict");
    expect(l.textContent).not.toMatch(/\d\s%|0,0/);
    expect(within(l).queryByTestId("echantillon-insuffisant")).not.toBeInTheDocument();
  });

  it("dit que ce n'est pas la precision statistique de la methode", async () => {
    servir(qualite([ligne()]));
    rendreAvecClient(<Harnais />);
    await screen.findByRole("table");
    expect(screen.getByText(/n'est pas la précision statistique de la détection/)).toBeInTheDocument();
  });

  it("compte regional (403 HORS_PERIMETRE) : etat « absence de permission » dedie, ni erreur ni vide, et renvoie au taux regional des indicateurs", async () => {
    servir(echec(403, "Agrégat national : refusé à un compte régional.", "HORS_PERIMETRE"));
    rendreAvecClient(<Harnais />);
    const msg = await screen.findByText(/Qualité par méthode : accès refusé/);
    const bloc = msg.closest("[data-etat='permission']") as HTMLElement;
    expect(bloc).toBeInTheDocument();
    expect(bloc).toHaveTextContent(/réservé aux comptes nationaux/);
    expect(bloc).toHaveTextContent(/taux de confirmation de votre région reste affiché dans les indicateurs/);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(); // pas une panne
    expect(document.querySelector("[data-etat='vide']")).toBeNull(); // pas un vide
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(h.get).toHaveBeenCalledTimes(1); // un refus d'autorisation ne se retente pas
  });

  it("panne du serveur (500) : alerte avec « Reessayer : Qualite par methode », jamais un vide", async () => {
    servir(echec(500, "Panne synthetique"));
    rendreAvecClient(<Harnais />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Qualité par méthode : chargement impossible");
    expect(screen.getByRole("button", { name: "Réessayer : Qualité par méthode" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("aucune ligne : etat vide explicite", async () => {
    servir(qualite([]));
    rendreAvecClient(<Harnais />);
    expect(await screen.findByText("Aucune méthode n'a encore produit de proposition")).toBeInTheDocument();
  });

  it("chargement : role status", () => {
    h.get.mockImplementation(() => new Promise(() => {}));
    rendreAvecClient(<Harnais />);
    expect(screen.getByRole("status")).toHaveTextContent("Chargement de la qualité par méthode");
  });

  it("accessible (axe) avec des lignes, et dans l'etat de permission", async () => {
    servir(qualite([ligne(), ligne({ type: "VEGETATION", methode: "meth-b v2" })]));
    const a = rendreAvecClient(<Harnais />);
    await screen.findByRole("table");
    expect(await violationsAccessibilite(a.container)).toEqual([]);
    a.unmount();
    servir(echec(403, "x", "HORS_PERIMETRE"));
    const b = rendreAvecClient(<Harnais />);
    await screen.findByText(/accès refusé/);
    expect(await violationsAccessibilite(b.container)).toEqual([]);
  });
});
