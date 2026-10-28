import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PanneauCouches, type PropsPanneauCouches } from "./PanneauCouches";
import { FicheObjet } from "./FicheObjet";
import { JEU_AXES, JEU_EAU, JEU_GAZ_CONTROLE, JEU_TEL, jeu, ligne } from "./synthetique.testutil";
import { lireObjetCarte } from "../../lib/projetsVoirieApi";
import { violationsAccessibilite } from "../../test/accessibilite";

const CONFLITS = { chaussee: true, emprise: true, hors: false, croisements: true };

function rendre(over: Partial<PropsPanneauCouches> = {}) {
  const props: PropsPanneauCouches = {
    jeux: [JEU_AXES, JEU_TEL, JEU_EAU, JEU_GAZ_CONTROLE], visibles: new Set(["jeu-axes", "jeu-tel", "jeu-eau"]), onBasculerJeu: vi.fn(),
    afficherNonAutorises: false, onAfficherNonAutorises: vi.fn(), conflitsVisibles: CONFLITS, onBasculerConflit: vi.fn(), conflitsDisponibles: true,
    tronques: new Set(), objets: [], onChoisirObjet: vi.fn(), peutEcrire: true, enLigne: true,
    retirer: vi.fn().mockResolvedValue(undefined), decider: vi.fn().mockResolvedValue(undefined), ...over,
  };
  const r = render(<PanneauCouches {...props} />);
  return { ...r, props };
}

describe("une ligne par jeu : case, couleur et motif, concessionnaire, version, date, classe", () => {
  it("jeux autorises groupes par role ; version, date, classe de precision et nature affichees", () => {
    rendre();
    const reseau = screen.getByRole("group", { name: "Réseau de concessionnaire" });
    const tel = within(reseau).getByText("Operateur synthetique A").closest("li")!;
    expect(tel).toHaveTextContent("version 2");
    expect(tel).toHaveTextContent("données du 24/10/2026");
    expect(tel).toHaveTextContent("trait : trait plein");
    expect(within(tel).getByTestId("classe-jeu-tel")).toHaveTextContent(/Classe de précision : Inconnue \(par défaut\)/);
    expect(within(tel).getByTestId("classe-jeu-tel")).toHaveTextContent(/proximité à vérifier/);
    const eau = within(reseau).getByText("Societe des eaux synthetique").closest("li")!;
    expect(within(eau).getByTestId("classe-jeu-eau")).toHaveTextContent("B : plan validé");
    expect(within(eau).getByTestId("classe-jeu-eau")).not.toHaveTextContent(/proximité/);
    expect(within(eau).getByText("Nature : Actif physique (câble, conduite posés) · Confidentiel concessionnaire")).toBeInTheDocument();
    expect(within(eau).getByText("trait : tirets longs", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Axes de travaux" })).toBeInTheDocument();
  });
  it("une case par jeu : cocher et decocher previent le parent", async () => {
    const { props } = rendre();
    await userEvent.click(screen.getByRole("checkbox", { name: /Operateur synthetique A/ }));
    expect(props.onBasculerJeu).toHaveBeenCalledWith("jeu-tel", false);
  });
  it("date absente : une phrase correcte, pas « du Non renseignée »", () => {
    rendre({ jeux: [jeu({ id: "x", dateDonnees: null })], visibles: new Set(["x"]) });
    expect(screen.getByText(/date des données non renseignée/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/du Non renseign/);
  });
  it("l'origine du fichier (texte libre) s'affiche quand elle existe, et son absence ne gene rien", () => {
    rendre({ jeux: [jeu({ id: "o", origineFichier: "reçu de l'opérateur le 24/10/2026" }), jeu({ id: "p", concessionnaire: { id: "c9", nom: "Autre", typeReseau: null }, origineFichier: null })], visibles: new Set() });
    expect(screen.getByText("Origine : reçu de l'opérateur le 24/10/2026")).toBeInTheDocument();
    expect(screen.getAllByText(/^Origine :/)).toHaveLength(1);
  });
  it("jeu tronque par le serveur : dit, avec la conduite a tenir", () => {
    rendre({ tronques: new Set(["jeu-tel"]) });
    expect(screen.getByText(/Affichage tronqué : le serveur plafonne/)).toBeInTheDocument();
  });
});

describe("quarantaine : un fichier recu n'est pas un fichier importe", () => {
  it("le jeu a autoriser est liste a part, avec le message, non affiche par defaut", () => {
    rendre();
    const section = screen.getByRole("heading", { name: /Fichiers reçus, à autoriser/ }).closest("section")!;
    expect(within(section).getByText("Un fichier reçu n'est pas un fichier importé : il n'alimente le projet qu'après autorisation.")).toBeInTheDocument();
    const ligneGaz = within(section).getByText("Hydrocarbures synthetique").closest("li")!;
    expect(within(ligneGaz).getByText("À autoriser")).toBeInTheDocument();
    expect(within(ligneGaz).getByRole("checkbox")).toBeDisabled();
    expect(ligneGaz).toHaveTextContent(/Non affiché/);
    // il n'est pas dans les jeux autorises
    expect(within(screen.getByRole("group", { name: "Réseau de concessionnaire" })).queryByText("Hydrocarbures synthetique")).toBeNull();
  });
  it("l'interrupteur « Afficher aussi les donnees non autorisees » rend la case utilisable", async () => {
    const { props, rerender } = rendre();
    await userEvent.click(screen.getByRole("checkbox", { name: /Afficher aussi les données non autorisées/ }));
    expect(props.onAfficherNonAutorises).toHaveBeenCalledWith(true);
    rerender(<PanneauCouches {...props} afficherNonAutorises visibles={new Set(["jeu-gaz"])} />);
    const ligneGaz = screen.getByText("Hydrocarbures synthetique").closest("li")!;
    expect(within(ligneGaz).getByRole("checkbox")).toBeEnabled();
    expect(within(ligneGaz).getByRole("checkbox")).toBeChecked();
  });
  it("Autoriser : justification obligatoire de 10 caracteres minimum, envoyee avec la decision", async () => {
    const { props } = rendre();
    await userEvent.click(screen.getByRole("button", { name: /Autoriser le jeu Hydrocarbures synthetique/ }));
    const dialogue = await screen.findByRole("dialog", { name: "Autoriser ce jeu de données" });
    const valider = within(dialogue).getByRole("button", { name: "Autoriser le jeu" });
    expect(valider).toBeDisabled();
    await userEvent.type(within(dialogue).getByLabelText(/Justification/), "trop court");
    expect(within(dialogue).getByText("10 / 10 caractères minimum")).toBeInTheDocument();
    // « trop court » = 10 caracteres : limite exacte acceptee
    expect(valider).toBeEnabled();
    await userEvent.clear(within(dialogue).getByLabelText(/Justification/));
    await userEvent.type(within(dialogue).getByLabelText(/Justification/), "   neuf   ");
    expect(within(dialogue).getByText("4 / 10 caractères minimum")).toBeInTheDocument();
    expect(valider).toBeDisabled();
    await userEvent.clear(within(dialogue).getByLabelText(/Justification/));
    await userEvent.type(within(dialogue).getByLabelText(/Justification/), "Conforme au plan reçu de l'opérateur");
    await userEvent.click(valider);
    expect(props.decider).toHaveBeenCalledWith("jeu-gaz", "autoriser", "Conforme au plan reçu de l'opérateur");
  });
  it("Rejeter : meme justification obligatoire, decision « rejeter »", async () => {
    const { props } = rendre();
    await userEvent.click(screen.getByRole("button", { name: /Rejeter le jeu Hydrocarbures synthetique/ }));
    const dialogue = await screen.findByRole("dialog", { name: "Rejeter ce jeu de données" });
    expect(within(dialogue).getByText(/n'alimente jamais la carte ni l'analyse/)).toBeInTheDocument();
    await userEvent.type(within(dialogue).getByLabelText(/Justification/), "Hors perimetre du projet");
    await userEvent.click(within(dialogue).getByRole("button", { name: "Rejeter le jeu" }));
    expect(props.decider).toHaveBeenCalledWith("jeu-gaz", "rejeter", "Hors perimetre du projet");
  });
  it("un refus du serveur est dit dans le dialogue, qui reste ouvert", async () => {
    const decider = vi.fn().mockRejectedValue({ response: { status: 403, data: { error: "non" } } });
    rendre({ decider });
    await userEvent.click(screen.getByRole("button", { name: /Autoriser le jeu Hydrocarbures/ }));
    const dialogue = await screen.findByRole("dialog");
    await userEvent.type(within(dialogue).getByLabelText(/Justification/), "Justification suffisante");
    await userEvent.click(within(dialogue).getByRole("button", { name: "Autoriser le jeu" }));
    expect(await within(dialogue).findByRole("alert")).toHaveTextContent(/clé de module/);
  });
  it("un lecteur ne voit ni Autoriser, ni Rejeter, ni Retirer", () => {
    rendre({ peutEcrire: false });
    expect(screen.queryByRole("button", { name: /Autoriser|Rejeter|Retirer/ })).toBeNull();
  });
  it("hors ligne : les gestes d'ecriture sont desactives", () => {
    rendre({ enLigne: false });
    expect(screen.getByRole("button", { name: /Autoriser le jeu Hydrocarbures/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Retirer le jeu Operateur/ })).toBeDisabled();
  });
  it("jeux rejetes et remplaces : comptes, conserves en base", () => {
    rendre({ jeux: [JEU_TEL, jeu({ id: "r", statut: "REJETE", nonAutorise: true }), jeu({ id: "s", statut: "REMPLACE", nonAutorise: true })] });
    expect(screen.getByText(/1 jeu\(x\) rejeté\(s\) restent conservés en base/)).toBeInTheDocument();
    expect(screen.getByText(/1 version\(s\) remplacée\(s\) restent conservées en base/)).toBeInTheDocument();
  });
});

describe("retrait avec confirmation", () => {
  it("Retirer ouvre une confirmation qui dit que le retrait est logique ; rien n'est retire avant", async () => {
    const { props } = rendre();
    await userEvent.click(screen.getByRole("button", { name: /Retirer le jeu Operateur synthetique A, version 2/ }));
    const dialogue = await screen.findByRole("dialog", { name: "Retirer ce jeu de données ?" });
    expect(dialogue).toHaveTextContent(/le retrait est logique/);
    expect(props.retirer).not.toHaveBeenCalled();
    await userEvent.click(within(dialogue).getByRole("button", { name: "Retirer le jeu" }));
    expect(props.retirer).toHaveBeenCalledWith("jeu-tel");
  });
  it("Annuler : aucun retrait", async () => {
    const { props } = rendre();
    await userEvent.click(screen.getByRole("button", { name: /Retirer le jeu Operateur/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Annuler" }));
    expect(props.retirer).not.toHaveBeenCalled();
  });
});

describe("couches de conflit", () => {
  it("quatre couches, chacune avec son libelle et son motif ecrit ; cocher previent le parent", async () => {
    const { props } = rendre();
    for (const nom of ["Dans la chaussée", "Dans l'emprise, hors chaussée", "Hors emprise", "Croisements avec un axe"]) expect(screen.getByRole("checkbox", { name: new RegExp(nom) })).toBeInTheDocument();
    expect(screen.getByText(/Tracé : trait plein épais/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: /Hors emprise/ }));
    expect(props.onBasculerConflit).toHaveBeenCalledWith("hors", true);
  });
  it("sans analyse calculee : cases desactivees, avec l'explication", () => {
    rendre({ conflitsDisponibles: false });
    expect(screen.getByRole("checkbox", { name: /Dans la chaussée/ })).toBeDisabled();
    expect(screen.getByText(/apparaissent quand l'analyse est calculée/)).toBeInTheDocument();
  });
});

describe("liste des objets : la voie clavier vers la fiche", () => {
  const objets = [lireObjetCarte("jeu-tel", ligne("Fibre FO-01", 0, 0, 1, 1)), lireObjetCarte("jeu-tel", ligne("Fibre FO-02", 0, 0, 1, 1)), lireObjetCarte("jeu-eau", ligne("Conduite", 0, 0, 1, 1))];
  it("un bouton par objet ; choisir ouvre la fiche", async () => {
    const { props } = rendre({ objets });
    await userEvent.click(screen.getByRole("button", { name: /Fibre FO-02/ }));
    expect(props.onChoisirObjet).toHaveBeenCalledWith(objets[1]);
  });
  it("filtre par nom d'objet ou de jeu", async () => {
    rendre({ objets });
    await userEvent.type(screen.getByLabelText(/Filtrer par nom/), "eaux");
    expect(screen.getAllByRole("button", { name: /Conduite/ })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Fibre/ })).toBeNull();
    await userEvent.clear(screen.getByLabelText(/Filtrer par nom/));
    await userEvent.type(screen.getByLabelText(/Filtrer par nom/), "zzz");
    expect(screen.getByText("Aucun objet ne correspond à ce filtre.")).toBeInTheDocument();
  });
  it("plafonne l'affichage a 100 objets et le dit", () => {
    const beaucoup = Array.from({ length: 150 }, (_, i) => lireObjetCarte("jeu-tel", ligne(`Objet ${i}`, 0, 0, 1, 1)));
    rendre({ objets: beaucoup });
    expect(screen.getByText("100 premiers objets sur 150 : affinez le filtre.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Objet \d+/ })).toHaveLength(100);
  });
  it("aucun objet : explique pourquoi", () => {
    rendre();
    expect(screen.getByText(/Aucun objet n'est affiché pour la vue actuelle/)).toBeInTheDocument();
  });
});

describe("fiche d'un objet : attributs d'origine, rendus comme du TEXTE", () => {
  it("un attribut qui contient du HTML ou un script s'affiche litteralement, sans rien injecter", () => {
    const f = ligne("Objet piege", 0, 0, 1, 1, { description: "<img src=x onerror=alert(1)>", note: "<script>window.__pwned = true</script>", gras: "<b>gras</b>" });
    const objet = lireObjetCarte("jeu-tel", f);
    const { container } = render(<FicheObjet objet={objet} jeu={JEU_TEL} onFermer={vi.fn()} />);
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(screen.getByText("<script>window.__pwned = true</script>")).toBeInTheDocument();
    expect(container.querySelector("img, script, b")).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
    expect(container.innerHTML).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
  it("valeurs non textuelles serialisees, tres longues tronquees, attributs nombreux plafonnes", () => {
    const attributs: Record<string, unknown> = { liste: [1, 2], objet: { a: 1 }, long: "x".repeat(900), nul: null };
    for (let i = 0; i < 120; i++) attributs[`k${i}`] = i;
    const f = ligne("Objet", 0, 0, 1, 1, attributs);
    render(<FicheObjet objet={lireObjetCarte("jeu-tel", f)} jeu={JEU_TEL} onFermer={vi.fn()} />);
    expect(screen.getByText("[1,2]")).toBeInTheDocument();
    expect(screen.getByText('{"a":1}')).toBeInTheDocument();
    expect(screen.getByText(/^x{600}…$/)).toBeInTheDocument();
    expect(screen.getByText(/autre\(s\) attribut\(s\) non affiché\(s\)/)).toBeInTheDocument();
  });
  it("jeu non autorise : la fiche le dit", () => {
    const objet = { ...lireObjetCarte("jeu-gaz", ligne("Gaz", 0, 0, 1, 1)), nonAutorise: true };
    render(<FicheObjet objet={objet} jeu={JEU_GAZ_CONTROLE} onFermer={vi.fn()} />);
    expect(screen.getByText(/Non autorisé : donnée en quarantaine/)).toBeInTheDocument();
  });
  it("Fermer previent le parent", async () => {
    const onFermer = vi.fn();
    render(<FicheObjet objet={lireObjetCarte("jeu-tel", ligne("Fibre", 0, 0, 1, 1))} jeu={JEU_TEL} onFermer={onFermer} />);
    await userEvent.click(screen.getByRole("button", { name: "Fermer la fiche de l'objet" }));
    expect(onFermer).toHaveBeenCalled();
  });
});

describe("accessibilite (axe)", () => {
  it("aucune violation : panneau complet, dialogue d'autorisation ouvert, fiche", async () => {
    const objets = [lireObjetCarte("jeu-tel", ligne("Fibre FO-01", 0, 0, 1, 1))];
    const { container } = rendre({ objets, tronques: new Set(["jeu-tel"]) });
    expect(await violationsAccessibilite(container)).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: /Autoriser le jeu Hydrocarbures/ }));
    await screen.findByRole("dialog");
    expect(await violationsAccessibilite(document.body)).toEqual([]);
  }, 30_000);
  it("aucune violation : fiche avec attributs", async () => {
    const { container } = render(<FicheObjet objet={lireObjetCarte("jeu-tel", ligne("Fibre", 0, 0, 1, 1, { a: 1 }))} jeu={JEU_TEL} onFermer={vi.fn()} />);
    expect(await violationsAccessibilite(container)).toEqual([]);
  }, 30_000);
});
