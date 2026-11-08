import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../../lib/api", () => ({ api: { get: h.get, post: h.post } }));

import { useSynthese } from "../../lib/teledetectionHooks";
import { IndicateursSynthese } from "./IndicateursSynthese";
import { WidgetTauxConfirmation } from "./WidgetTauxConfirmation";
import { rendreAvecClient } from "./rendre.testutil";
import { echec, routeurGet, synthese } from "./synthetique.testutil";

/**
 * Indicateurs de synthese et widget « Taux de confirmation terrain ».
 * Defendu : aucun faux zero (un compteur en erreur n'affiche pas 0), 37/(37+24) = 60,7 % et jamais
 * 86 %, la reserve sous le seuil, « Aucun verdict » a zero, la mention « pas la precision ».
 */

function Harnais() {
  const s = useSynthese({});
  return <><IndicateursSynthese synthese={s} /><WidgetTauxConfirmation synthese={s} /></>;
}

function avecTaux(confirmees: number, infirmees: number, extra: Record<string, unknown> = {}) {
  const jugees = confirmees + infirmees;
  return synthese({
    propositions: { aVerifier: 18, enAttente: 0, nonConcluantes: 0, confirmees, infirmees, prioritaires: 6 },
    tauxConfirmation: { confirmees, infirmees, jugees, valeur: jugees ? confirmees / jugees : null, echantillonSuffisant: jugees >= 30, seuil: 30, definition: "Confirmées ÷ (confirmées + infirmées).", ...extra },
  });
}

beforeEach(() => { h.get.mockReset(); h.post.mockReset(); });

describe("indicateurs de synthese", () => {
  it("affiche chaque indicateur depuis la reponse, avec ses precisions", async () => {
    h.get.mockImplementation(routeurGet({ "/v2/teledetection/synthese": avecTaux(37, 24) }));
    rendreAvecClient(<Harnais />);
    const zone = await screen.findByRole("region", { name: "Indicateurs de synthèse" });
    await waitFor(() => expect(within(zone).getByText("18")).toBeInTheDocument());
    expect(within(zone).getByText("dont 6 prioritaires")).toBeInTheDocument();
    expect(within(zone).getByText("37")).toBeInTheDocument();
    expect(within(zone).getAllByText("sur 61 jugées").length).toBe(3); // confirmees, infirmees, taux
    expect(within(zone).getByText("1")).toBeInTheDocument(); // sources actives
    expect(within(zone).getByText("sur 3 enregistrées")).toBeInTheDocument(); // le denominateur est le total enregistre (3 sources dont 1 non configuree)
    expect(within(zone).queryByText(/configurées/)).not.toBeInTheDocument();
    expect(within(zone).getByText("20 oct. 2026")).toBeInTheDocument();
    expect(within(zone).getByText("Source A · 10 m")).toBeInTheDocument();
  });

  it("derniere acquisition absente ou ancienne : dit en toutes lettres", async () => {
    h.get.mockImplementation(routeurGet({ "/v2/teledetection/synthese": synthese({ derniereAcquisition: null }) }));
    const a = rendreAvecClient(<Harnais />);
    expect(await screen.findByText("Aucune acquisition")).toBeInTheDocument();
    a.unmount();
    h.get.mockImplementation(routeurGet({ "/v2/teledetection/synthese": synthese({ fraicheur: { dateCalcul: "2026-10-25T08:00:00Z", ageDerniereAcquisitionJours: 45 } }) }));
    rendreAvecClient(<Harnais />);
    expect(await screen.findByText(/Ancienne : 45 jours/)).toBeInTheDocument();
  });

  it("un seul denominateur : « sur 9 enregistrées » (le total), meme si 8 sources seulement ne sont pas « non configurées »", async () => {
    h.get.mockImplementation(routeurGet({ "/v2/teledetection/synthese": synthese({ sources: { total: 9, parEtat: { TRAITEMENT_OPERATIONNEL: 1, NON_CONFIGUREE: 1, EN_ERREUR: 7 }, actives: 1 } }) }));
    rendreAvecClient(<Harnais />);
    const zone = await screen.findByRole("region", { name: "Indicateurs de synthèse" });
    expect(await within(zone).findByText("sur 9 enregistrées")).toBeInTheDocument();
    expect(within(zone).queryByText(/sur 8/)).not.toBeInTheDocument();
  });

  it("une seule source : « sur 1 enregistrée » (accord au singulier)", async () => {
    h.get.mockImplementation(routeurGet({ "/v2/teledetection/synthese": synthese({ sources: { total: 1, parEtat: { ACCESSIBLE: 1 }, actives: 0 } }) }));
    rendreAvecClient(<Harnais />);
    expect(await screen.findByText("sur 1 enregistrée")).toBeInTheDocument();
  });

  it("aucune source enregistree : « Aucune source enregistrée », pas « sur 0 enregistrée »", async () => {
    h.get.mockImplementation(routeurGet({ "/v2/teledetection/synthese": synthese({ sources: { total: 0, parEtat: {}, actives: 0 } }) }));
    rendreAvecClient(<Harnais />);
    expect(await screen.findByText("Aucune source enregistrée")).toBeInTheDocument();
  });

  it("chargement : role status, et aucun chiffre affiche", async () => {
    h.get.mockImplementation(() => new Promise(() => {}));
    rendreAvecClient(<Harnais />);
    expect((await screen.findAllByRole("status")).length).toBeGreaterThan(0);
    expect(screen.getByText("Chargement des indicateurs…")).toBeInTheDocument();
    const zone = screen.getByRole("region", { name: "Indicateurs de synthèse" });
    expect(within(zone).queryByText("0")).not.toBeInTheDocument();
    expect(zone).toHaveAttribute("aria-busy", "true");
  });

  it("erreur serveur : une alerte, des tirets, JAMAIS un zero", async () => {
    h.get.mockImplementation(routeurGet({ "/v2/teledetection/synthese": echec(500, "Base indisponible") }));
    rendreAvecClient(<Harnais />);
    const alertes = await screen.findAllByRole("alert", undefined, { timeout: 5000 });
    expect(alertes.length).toBeGreaterThan(0);
    expect(alertes[0]).toHaveTextContent("Base indisponible");
    const zone = screen.getByRole("region", { name: "Indicateurs de synthèse" });
    expect(within(zone).queryByText("0")).not.toBeInTheDocument();
    expect(within(zone).getAllByText(/indisponible/).length).toBeGreaterThan(0);
    expect(screen.queryByText("Aucun verdict")).not.toBeInTheDocument();
  });

  it("permission refusee : un message dedie, pas une panne ni un vide", async () => {
    h.get.mockImplementation(routeurGet({ "/v2/teledetection/synthese": echec(403, "Rôle insuffisant", "ROLE_INSUFFISANT") }));
    rendreAvecClient(<Harnais />);
    const msg = (await screen.findAllByText(/accès refusé/)).at(0);
    expect(msg).toBeInTheDocument();
    expect(h.get).toHaveBeenCalledTimes(1); // un refus d'autorisation n'est pas retente
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("donnees perimees : apres un succes, un echec d'actualisation garde les valeurs et previent", async () => {
    let n = 0;
    h.get.mockImplementation(async () => { n += 1; if (n === 1) return { data: avecTaux(37, 24) }; throw echec(500, "panne"); });
    const { qc } = rendreAvecClient(<Harnais />);
    await screen.findByText("dont 6 prioritaires");
    await act(async () => { await qc.invalidateQueries({ queryKey: ["teledetection", "synthese"] }).catch(() => {}); });
    const bandeaux = await screen.findAllByText(/l'actualisation a échoué/, undefined, { timeout: 5000 });
    expect(bandeaux.length).toBeGreaterThan(0);
    expect(screen.getByText("dont 6 prioritaires")).toBeInTheDocument(); // la valeur precedente reste lisible
  });
});

describe("widget Taux de confirmation terrain", () => {
  it("61 verdicts (37 confirmees, 24 infirmees) : 60,7 %, jamais 86 %, pas de reserve", async () => {
    h.get.mockImplementation(routeurGet({ "/v2/teledetection/synthese": avecTaux(37, 24) }));
    rendreAvecClient(<Harnais />);
    const valeur = await screen.findByTestId("valeur-taux");
    expect(valeur).toHaveTextContent("60,7 %");
    expect(document.body.textContent).not.toMatch(/86/);
    expect(screen.queryByTestId("mention-echantillon")).not.toBeInTheDocument();
    const legende = screen.getByText("Total jugées").closest("dl") as HTMLElement;
    expect(within(legende).getByText("37")).toBeInTheDocument();
    expect(within(legende).getByText("24")).toBeInTheDocument();
    expect(within(legende).getByText("61")).toBeInTheDocument();
  });

  it("12 verdicts : la valeur est montree AVEC « échantillon insuffisant (n = 12) »", async () => {
    h.get.mockImplementation(routeurGet({ "/v2/teledetection/synthese": avecTaux(9, 3) }));
    rendreAvecClient(<Harnais />);
    expect(await screen.findByTestId("mention-echantillon")).toHaveTextContent("échantillon insuffisant (n = 12)");
    expect(screen.getByTestId("valeur-taux")).toHaveTextContent("75,0 %");
  });

  it("zero verdict : « Aucun verdict », jamais « 0 % »", async () => {
    h.get.mockImplementation(routeurGet({ "/v2/teledetection/synthese": avecTaux(0, 0) }));
    rendreAvecClient(<Harnais />);
    expect(await screen.findByTestId("valeur-taux")).toHaveTextContent("Aucun verdict");
    expect(screen.getByText(/Aucune proposition n'a encore reçu de verdict/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/0[\s\u00a0]?%/);
  });

  it("un seul verdict : 100 % n'est jamais presente comme une performance", async () => {
    h.get.mockImplementation(routeurGet({ "/v2/teledetection/synthese": avecTaux(1, 0) }));
    rendreAvecClient(<Harnais />);
    expect(await screen.findByTestId("mention-echantillon")).toHaveTextContent("échantillon insuffisant (n = 1)");
  });

  it("dit que ce n'est PAS la precision statistique, et la definition est accessible au clavier", async () => {
    h.get.mockImplementation(routeurGet({ "/v2/teledetection/synthese": avecTaux(37, 24) }));
    const u = userEvent.setup();
    rendreAvecClient(<Harnais />);
    await screen.findByTestId("valeur-taux");
    expect(screen.getAllByText(/Ce n'est pas la précision statistique/).length).toBeGreaterThanOrEqual(2); // dans la carte du haut ET dans le widget
    expect(screen.getByTestId("non-precision-synthese")).toHaveTextContent("Ce n'est pas la précision statistique.");
    const bouton = screen.getByRole("button", { name: "Définition : Taux de confirmation terrain" });
    expect(bouton).toHaveAttribute("aria-expanded", "false");
    // Le texte est lie au bouton par aria-describedby, meme ferme : un lecteur d'ecran le lit.
    const id = bouton.getAttribute("aria-describedby") as string;
    expect(document.getElementById(id)).toHaveTextContent(/Confirmées ÷ \(confirmées \+ infirmées\)/);
    expect(document.getElementById(id)).toHaveTextContent(/pas la précision statistique/);
    bouton.focus();
    await u.keyboard("{Enter}");
    expect(bouton).toHaveAttribute("aria-expanded", "true");
    await u.keyboard("{Escape}");
    expect(bouton).toHaveAttribute("aria-expanded", "false");
  });

  it("erreur : alerte, pas de pourcentage", async () => {
    h.get.mockImplementation(routeurGet({ "/v2/teledetection/synthese": echec(500) }));
    rendreAvecClient(<Harnais />);
    await screen.findAllByRole("alert", undefined, { timeout: 5000 });
    expect(screen.queryByTestId("valeur-taux")).not.toBeInTheDocument();
  });
});
