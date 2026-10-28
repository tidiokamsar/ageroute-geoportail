import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PanneauAnalyse, LIMITES_CONSTANTES, type PropsPanneauAnalyse } from "./PanneauAnalyse";
import { analyse, JEU_AXES, JEU_EAU, JEU_TEL, jeu, projetFiche, requeteChargement, requeteErreur, requeteOk } from "./synthetique.testutil";
import { violationsAccessibilite } from "../../test/accessibilite";
import type { Analyse } from "../../lib/projetsVoirieApi";

const jeux = [JEU_AXES, JEU_TEL, JEU_EAU];

function rendre(over: Partial<PropsPanneauAnalyse> = {}) {
  const props: PropsPanneauAnalyse = {
    projet: projetFiche(), jeux, requete: requeteOk(analyse()), apercu: null, onApercu: vi.fn(), nomJeu: (id) => `Jeu ${id}`,
    peutEcrire: true, estAdmin: false, enLigne: true, enregistrer: vi.fn().mockResolvedValue(undefined), exporter: vi.fn().mockResolvedValue(undefined), ...over,
  };
  const r = render(<MemoryRouter><PanneauAnalyse {...props} /></MemoryRouter>);
  return { ...r, props };
}

describe("mention « theorique »", () => {
  it("tant que les largeurs ne sont pas validees : bandeau, chiffres de conflit, hypotheses et largeurs portent « theorique »", () => {
    rendre();
    expect(screen.getByTestId("mention-theorique")).toHaveTextContent(/Résultat théorique/);
    expect(screen.getByTestId("mention-theorique")).toHaveTextContent(/aide à la décision, jamais un verdict/);
    expect(screen.getByRole("heading", { name: /Conflits avec les travaux \(théoriques\)/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Hypothèses \(théoriques\) et limites/ })).toBeInTheDocument();
    expect(screen.getAllByText("(théorique)").length).toBeGreaterThanOrEqual(5);
    expect(screen.getByText(/théoriques, non validées/)).toBeInTheDocument();
  });
  it("largeurs validees : plus de mention theorique", () => {
    rendre({ projet: projetFiche({ statutParametres: "VALIDE" }), requete: requeteOk(analyse({ parametres: { largeurEmpriseM: 15, largeurChausseeM: 7, statut: "VALIDE", projection: "EPSG:32629" } })) });
    expect(screen.queryByTestId("mention-theorique")).toBeNull();
    expect(screen.queryByText("(théorique)")).toBeNull();
    expect(screen.getByText("(validées)")).toBeInTheDocument();
  });
  it("un apercu non enregistre est toujours theorique, meme si le projet est valide", () => {
    rendre({ projet: projetFiche({ statutParametres: "VALIDE" }), apercu: { largeurEmpriseM: 20, largeurChausseeM: 8 }, requete: requeteOk(analyse({ parametres: { largeurEmpriseM: 20, largeurChausseeM: 8, statut: "VALIDE", projection: null } })) });
    expect(screen.getByTestId("mention-theorique")).toBeInTheDocument();
    expect(screen.getAllByText(/aperçu non enregistré/i).length).toBeGreaterThan(0);
  });
});

describe("reseaux : barre de repartition, tracé fusionné, proprietaires", () => {
  it("barre coloree : un segment par type, largeur proportionnelle, description textuelle complete", () => {
    rendre();
    const barre = screen.getByRole("img", { name: /Répartition de la longueur physique par type de réseau/ });
    expect(barre.getAttribute("aria-label")).toMatch(/Télécom 1,8 km, 75 %/);
    expect(barre.getAttribute("aria-label")).toMatch(/Eau potable 600 m, 25 %/);
    const segments = barre.querySelectorAll<HTMLElement>("[data-type]");
    expect(segments).toHaveLength(2);
    expect(segments[0].style.width).toBe("75%");
    expect(segments[1].style.width).toBe("25%");
  });
  it("tableau par type : motif ecrit en toutes lettres, part, circuits ou objets (jamais « cables »)", () => {
    rendre();
    const t = screen.getByRole("table", { name: /tracé fusionné et nombre de circuits ou objets du fichier par type/i });
    expect(within(t).getByText("trait plein")).toBeInTheDocument();
    expect(within(t).getByText("tirets longs")).toBeInTheDocument();
    expect(within(t).getByRole("columnheader", { name: "Circuits ou objets" })).toBeInTheDocument();
    expect(document.body.textContent?.toLowerCase()).not.toMatch(/câbles?\b/);
  });
  it("proprietaires : longueur du tracé fusionne contre somme des objets, avec les circuits superposes dits", () => {
    rendre();
    const t = screen.getByRole("table", { name: /somme des objets/i });
    expect(within(t).getByText(/dont 800 m de circuits superposés/)).toBeInTheDocument();
    expect(within(t).getByText("Operateur synthetique A")).toBeInTheDocument();
  });
  it("aucun reseau : message clair, pas de barre", () => {
    rendre({ requete: requeteOk(analyse({ reseaux: { parType: [], parConcessionnaire: [] } })) });
    expect(screen.getByText("Aucune longueur de réseau à répartir.")).toBeInTheDocument();
    expect(screen.getByText("Aucun réseau de concessionnaire n'est chargé.")).toBeInTheDocument();
  });
});

describe("conflits : proximite a verifier, statut a verifier, jamais d'action de decision", () => {
  it("chaque ligne est « a verifier » avec la version de la regle ; le pied du tableau donne la version de l'algorithme", () => {
    rendre();
    const t = screen.getByRole("table", { name: /Longueurs de réseau dans la chaussée/ });
    expect(within(t).getAllByText("À vérifier (règle v1.0)").length).toBe(3);
    expect(within(t).getByText(/Version de l'algorithme : 2026.10-test/)).toBeInTheDocument();
  });
  it("classe de precision D, E ou inconnue : « proximite a verifier » ; B : « conflit a verifier »", () => {
    rendre({ jeux: [JEU_AXES, JEU_TEL, { ...JEU_EAU, classePrecision: "B" }] });
    const t = screen.getByRole("table", { name: "Conflits par concessionnaire" });
    const ligneTel = within(t).getByText("Operateur synthetique A").closest("tr")!;
    const ligneEau = within(t).getByText("Societe des eaux synthetique").closest("tr")!;
    expect(ligneTel).toHaveTextContent("Proximité à vérifier");
    expect(ligneEau).toHaveTextContent("Conflit à vérifier");
    expect(screen.getByTestId("note-proximite")).toHaveTextContent(/classe de précision D, E ou inconnue/);
  });
  it("tous les reseaux sont de classe B : pas de note de proximite", () => {
    rendre({ jeux: [JEU_AXES, { ...JEU_TEL, classePrecision: "B" }, { ...JEU_EAU, classePrecision: "A" }] });
    expect(screen.queryByTestId("note-proximite")).toBeNull();
  });
  it("aucune action « deplacer », « ordonner » ou « decider » dans le panneau", () => {
    rendre();
    expect(screen.queryAllByRole("button", { name: /déplacer|ordonner|décider|deplacer|decider/i })).toHaveLength(0);
    expect(screen.queryAllByRole("link", { name: /déplacer|ordonner|décider/i })).toHaveLength(0);
  });
});

describe("hypotheses et limites toujours visibles", () => {
  it("les limites du module sont affichees meme si le serveur n'en envoie aucune", () => {
    rendre({ requete: requeteOk(analyse({ hypotheses: [], limites: [] })) });
    const liste = screen.getByTestId("limites-constantes");
    for (const t of LIMITES_CONSTANTES) expect(within(liste).getByText(t)).toBeVisible();
    expect(liste).toHaveTextContent(/conflit vertical/i);
    expect(liste).toHaveTextContent(/ne prouve l'absence de réseau/);
    expect(liste).toHaveTextContent(/ne vaut pas décision de déplacement/);
    expect(screen.getByText("Le serveur n'a communiqué aucune hypothèse.")).toBeInTheDocument();
  });
  it("les hypotheses et limites du serveur sont affichees telles quelles, sans repli", () => {
    rendre();
    expect(screen.getByText("Largeurs appliquees de part et d'autre de chaque axe.")).toBeVisible();
    expect(screen.getByText("Profondeur inconnue.")).toBeVisible();
    expect(document.querySelector("details")).toBeNull();
  });
});

describe("tableau par axe : tri et detail des objets", () => {
  const ordre = () => within(screen.getByRole("table", { name: /Longueurs de réseau dans la chaussée/ })).getAllByRole("rowheader").map((r) => r.textContent?.replace(/ : .*$/, "").split(/\d+ objet/)[0].trim());
  it("tri par defaut : le plus de reseau en chaussee d'abord ; clic sur « Axe » : alphabetique ; encore un clic : inverse, avec aria-sort", async () => {
    rendre();
    const t = screen.getByRole("table", { name: /Longueurs de réseau dans la chaussée/ });
    const entete = (nom: RegExp) => within(t).getByRole("columnheader", { name: nom });
    expect(entete(/Réseau en chaussée/)).toHaveAttribute("aria-sort", "descending");
    expect(ordre()[0]).toMatch(/^Axe A/);
    await userEvent.click(within(entete(/^Axe/)).getByRole("button"));
    expect(entete(/^Axe/)).toHaveAttribute("aria-sort", "ascending");
    expect(ordre().map((x) => x?.slice(0, 5))).toEqual(["Axe A", "Axe B", "Axe C"]);
    await userEvent.click(within(entete(/^Axe/)).getByRole("button"));
    expect(entete(/^Axe/)).toHaveAttribute("aria-sort", "descending");
    expect(ordre().map((x) => x?.slice(0, 5))).toEqual(["Axe C", "Axe B", "Axe A"]);
    expect(entete(/Réseau en chaussée/)).toHaveAttribute("aria-sort", "none");
  });
  it("detail des objets d'un axe : bouton aria-expanded, objets nommes par jeu", async () => {
    rendre();
    const t = screen.getByRole("table", { name: /Longueurs de réseau dans la chaussée/ });
    const bouton = within(t).getByRole("button", { name: /Axe A/ });
    expect(bouton).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(bouton);
    expect(bouton).toHaveAttribute("aria-expanded", "true");
    const detail = screen.getByRole("table", { name: /Objets de réseau touchant l'axe Axe A/ });
    expect(within(detail).getByText("Fibre FO-01")).toBeInTheDocument();
    expect(within(detail).getAllByText("Jeu jeu-tel").length).toBe(2);
  });
  it("un axe sans objet n'a pas de bouton de detail", () => {
    rendre();
    expect(within(screen.getByRole("table", { name: /Longueurs de réseau dans la chaussée/ })).queryByRole("button", { name: /Axe C/ })).toBeNull();
  });
  it("les noms venus d'un fichier sont du texte : un nom d'axe HTML n'injecte rien", () => {
    const a: Analyse = analyse();
    a.conflits.parAxe[0] = { ...a.conflits.parAxe[0], axe: "<img src=x onerror=alert(1)>" };
    rendre({ requete: requeteOk(a) });
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("export CSV", () => {
  it("appelle l'export ; un echec est dit", async () => {
    const exporter = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue(undefined);
    rendre({ exporter });
    await userEvent.click(screen.getByRole("button", { name: /Exporter en CSV/ }));
    expect(await screen.findByText(/L'export CSV a échoué/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Exporter en CSV/ }));
    expect(exporter).toHaveBeenCalledTimes(2);
  });
  it("hors ligne : l'export est desactive", () => {
    rendre({ enLigne: false });
    expect(screen.getByRole("button", { name: /Exporter en CSV/ })).toBeDisabled();
  });
});

describe("edition des largeurs : previsualiser sans enregistrer, puis enregistrer", () => {
  it("previsualiser appelle onApercu avec les largeurs saisies, n'enregistre rien", async () => {
    const { props } = rendre();
    const form = screen.getByRole("form", { name: "Largeurs d'emprise et de chaussée" });
    await userEvent.clear(within(form).getByLabelText("Emprise (m)"));
    await userEvent.type(within(form).getByLabelText("Emprise (m)"), "20,5");
    await userEvent.click(within(form).getByRole("button", { name: /Prévisualiser/ }));
    expect(props.onApercu).toHaveBeenCalledWith({ largeurEmpriseM: 20.5, largeurChausseeM: 7 });
    expect(props.enregistrer).not.toHaveBeenCalled();
  });
  it("une emprise plus etroite que la chaussee est refusee, sans appel", async () => {
    const { props } = rendre();
    const form = screen.getByRole("form", { name: "Largeurs d'emprise et de chaussée" });
    await userEvent.clear(within(form).getByLabelText("Emprise (m)"));
    await userEvent.type(within(form).getByLabelText("Emprise (m)"), "5");
    expect(within(form).getByRole("alert")).toHaveTextContent(/au moins égale à la chaussée/);
    expect(within(form).getByRole("button", { name: /Prévisualiser/ })).toBeDisabled();
    expect(props.onApercu).not.toHaveBeenCalled();
  });
  it("enregistrer envoie les largeurs ; sans case administrateur, pas de statut VALIDE", async () => {
    const { props } = rendre();
    const form = screen.getByRole("form", { name: "Largeurs d'emprise et de chaussée" });
    expect(within(form).getByRole("button", { name: /Enregistrer/ })).toBeDisabled();
    await userEvent.clear(within(form).getByLabelText("Chaussée (m)"));
    await userEvent.type(within(form).getByLabelText("Chaussée (m)"), "8");
    await userEvent.click(within(form).getByRole("button", { name: /Enregistrer/ }));
    expect(props.enregistrer).toHaveBeenCalledWith({ largeurEmpriseM: 15, largeurChausseeM: 8 });
    expect(within(form).queryByRole("checkbox")).toBeNull();
  });
  it("un administrateur peut marquer les largeurs validees", async () => {
    const { props } = rendre({ estAdmin: true });
    const form = screen.getByRole("form", { name: "Largeurs d'emprise et de chaussée" });
    await userEvent.click(within(form).getByRole("checkbox", { name: /Marquer ces largeurs comme validées/ }));
    await userEvent.click(within(form).getByRole("button", { name: /Enregistrer/ }));
    expect(props.enregistrer).toHaveBeenCalledWith({ largeurEmpriseM: 15, largeurChausseeM: 7, statutParametres: "VALIDE" });
  });
  it("un lecteur peut previsualiser mais pas enregistrer", () => {
    rendre({ peutEcrire: false });
    const form = screen.getByRole("form", { name: "Largeurs d'emprise et de chaussée" });
    expect(within(form).queryByRole("button", { name: /Enregistrer/ })).toBeNull();
    expect(within(form).getByRole("button", { name: /Prévisualiser/ })).toBeInTheDocument();
  });
  it("un refus du serveur a l'enregistrement est dit", async () => {
    const enregistrer = vi.fn().mockRejectedValue({ response: { status: 403, data: { error: "non" } } });
    rendre({ enregistrer });
    const form = screen.getByRole("form", { name: "Largeurs d'emprise et de chaussée" });
    await userEvent.clear(within(form).getByLabelText("Chaussée (m)"));
    await userEvent.type(within(form).getByLabelText("Chaussée (m)"), "8");
    await userEvent.click(within(form).getByRole("button", { name: /Enregistrer/ }));
    expect(await within(form).findByText(/n'a pas la clé de module/)).toBeInTheDocument();
  });
});

describe("etats : chargement, erreur", () => {
  it("chargement", () => {
    rendre({ requete: requeteChargement() });
    expect(screen.getByRole("status")).toHaveTextContent("Calcul de l'analyse…");
  });
  it("erreur reseau : dite comme telle, avec reessai, jamais un tableau vide", () => {
    rendre({ requete: requeteErreur(new Error("Network Error")) });
    const a = screen.getByRole("alert");
    expect(a).toHaveTextContent(/Analyse : réseau indisponible/);
    expect(within(a).getByRole("button", { name: "Réessayer : Analyse" })).toBeInTheDocument();
    expect(screen.queryByText("Réseaux par type")).toBeNull();
  });
});

describe("accessibilite (axe)", () => {
  it("aucune violation avec analyse complete", async () => {
    const { container } = rendre({ estAdmin: true });
    expect(await violationsAccessibilite(container)).toEqual([]);
  }, 30_000);
  it("aucune violation avec un detail d'axe ouvert, sans donnee et en erreur", async () => {
    const { container, unmount } = rendre();
    await userEvent.click(within(container).getByRole("button", { name: /Axe A/ }));
    expect(await violationsAccessibilite(container)).toEqual([]);
    unmount();
    const vide = rendre({ requete: requeteOk(analyse({ axes: { nb: 0, longueurM: 0 }, reseaux: { parType: [], parConcessionnaire: [] }, conflits: { ...analyse().conflits, parAxe: [], parConcessionnaire: [], total: { chausseeM: 0, empriseM: 0, croisements: 0, axesTouches: 0, objetsTouches: 0 } } })), jeux: [jeu()] });
    expect(await violationsAccessibilite(vide.container)).toEqual([]);
    vide.unmount();
    const err = rendre({ requete: requeteErreur({ response: { status: 500, data: {} } }) });
    expect(await violationsAccessibilite(err.container)).toEqual([]);
  }, 30_000);
});
