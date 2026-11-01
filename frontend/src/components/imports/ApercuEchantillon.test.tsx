import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApercuEchantillon, MAX_LIGNES_AFFICHEES, type ParamsApercu } from "./ApercuEchantillon";
import { ligne, reponseApercu } from "./lotsDeTest";
import { violationsAccessibilite } from "../../test/accessibilite";
import type { ReponseApercu } from "./types";

/**
 * L'aperçu montre des valeurs qui viennent d'un fichier d'un tiers. Ces tests défendent :
 * - TOUTE valeur est du texte (une balise <script> s'affiche, ne s'exécute pas) et les caractères de
 *   contrôle sont rendus visibles ;
 * - `tronque` est dit ; le défilement horizontal reste dans le conteneur ;
 * - chargement, vide et erreur sont trois états distincts ;
 * - rien n'est proposé qui ressemble à une approbation.
 */

type Charge = (p: ParamsApercu) => Promise<ReponseApercu>;

function rendre(charger: Charge, extra: Partial<React.ComponentProps<typeof ApercuEchantillon>> = {}) {
  return render(<ApercuEchantillon lotId="lot-1" chargerApercu={charger} {...extra} />);
}

describe("Chargement et tableau", () => {
  it("charge 20 lignes d'emblée, d'abord un squelette annoncé, puis un tableau légendé", async () => {
    let fin!: (r: ReponseApercu) => void;
    const charger = vi.fn<Charge>(() => new Promise((ok) => { fin = ok; }));
    rendre(charger);
    expect(screen.getByRole("status")).toHaveTextContent("Chargement de l'aperçu");
    expect(charger).toHaveBeenCalledWith({ limite: 20 });
    fin(reponseApercu({ lignes: [ligne({ numeroLigne: 1 }), ligne({ numeroLigne: 2, identifiantSource: "RN1-002" })] }));
    const t = await screen.findByRole("table", { name: /Aperçu des lignes du lot/ });
    const entetes = within(t).getAllByRole("columnheader").map((h) => h.textContent);
    expect(entetes).toEqual(["Statut", "Ligne", "Identifiant source", "type_objet", "nom"]);
    expect(within(t).getAllByRole("rowheader").map((h) => h.textContent)).toEqual(["1", "2"]);
    expect(within(t).getByText("RN1-002")).toBeInTheDocument();
    expect(within(t).getAllByText("Conforme")).toHaveLength(2);
    expect(screen.getByText("2 lignes affichées.")).toBeInTheDocument();
  });

  it("ne relance pas le chargement quand le parent recrée sa fonction (rendus répétés)", async () => {
    const charger = vi.fn<Charge>(async () => reponseApercu());
    const { rerender } = rendre(charger);
    await screen.findByRole("table");
    rerender(<ApercuEchantillon lotId="lot-1" chargerApercu={async (p) => charger(p)} />);
    rerender(<ApercuEchantillon lotId="lot-1" chargerApercu={async (p) => charger(p)} />);
    expect(charger).toHaveBeenCalledTimes(1);
  });

  it("l'union des colonnes de la charge suit l'ordre d'apparition, une absence est dite", async () => {
    const charger = vi.fn<Charge>(async () => reponseApercu({
      lignes: [ligne({ numeroLigne: 1, charge: { a: "1", b: "2" } }), ligne({ numeroLigne: 2, charge: { b: "3", c: "4" } })],
    }));
    rendre(charger);
    const t = await screen.findByRole("table");
    expect(within(t).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Statut", "Ligne", "Identifiant source", "a", "b", "c"]);
    expect(within(t).getAllByText("(absente)")).toHaveLength(2);
  });

  it("une colonne « Motif » apparaît quand une ligne est rejetée avec son motif", async () => {
    const charger = vi.fn<Charge>(async () => reponseApercu({
      lignes: [ligne({ numeroLigne: 3, statut: "REJETEE", motifRejet: "identifiant_source manquant", identifiantSource: null })],
    }));
    rendre(charger);
    const t = await screen.findByRole("table");
    expect(within(t).getByRole("columnheader", { name: "Motif" })).toBeInTheDocument();
    expect(within(t).getByText("identifiant_source manquant")).toBeInTheDocument();
    expect(within(t).getByText("Rejetée")).toBeInTheDocument();
    expect(within(t).getByText("(absent)")).toBeInTheDocument();
  });

  it("le défilement horizontal est confiné au conteneur du tableau, atteignable au clavier", async () => {
    rendre(vi.fn<Charge>(async () => reponseApercu()));
    const zone = await screen.findByRole("region", { name: "Lignes de l'aperçu" });
    expect(zone).toHaveAttribute("tabindex", "0");
    expect(zone.className).toMatch(/overflow-auto/);
    expect(zone.className).toMatch(/max-w-full/);
    expect(zone.className).toMatch(/max-h-/);
  });
});

describe("Filtre par statut de ligne", () => {
  it("propose conformes, rejetées, ignorées, en conflit, et recharge avec le statut choisi", async () => {
    const charger = vi.fn<Charge>(async () => reponseApercu());
    rendre(charger);
    await screen.findByRole("table");
    const select = screen.getByLabelText("Filtrer par statut de ligne");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(
      ["Toutes les lignes", "Conformes", "Rejetées", "Ignorées", "En conflit"],
    );
    await userEvent.selectOptions(select, "REJETEE");
    await waitFor(() => expect(charger).toHaveBeenLastCalledWith({ limite: 20, statut: "REJETEE" }));
  });

  it("un filtre sans ligne dit « aucune ligne ne correspond », pas que le lot est vide", async () => {
    const charger = vi.fn<Charge>(async (p) => (p.statut ? reponseApercu({ lignes: [] }) : reponseApercu()));
    rendre(charger);
    await screen.findByRole("table");
    await userEvent.selectOptions(screen.getByLabelText("Filtrer par statut de ligne"), "EN_CONFLIT");
    expect(await screen.findByText("Aucune ligne ne correspond à ce statut.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("une réponse tardive d'un ancien filtre est jetée", async () => {
    const attentes: ((r: ReponseApercu) => void)[] = [];
    const charger = vi.fn<Charge>(() => new Promise((ok) => { attentes.push(ok); }));
    rendre(charger);
    await userEvent.selectOptions(screen.getByLabelText("Filtrer par statut de ligne"), "REJETEE");
    await waitFor(() => expect(attentes).toHaveLength(2));
    attentes[1](reponseApercu({ lignes: [ligne({ numeroLigne: 9, identifiantSource: "NOUVEAU" })] }));
    expect(await screen.findByText("NOUVEAU")).toBeInTheDocument();
    attentes[0](reponseApercu({ lignes: [ligne({ numeroLigne: 1, identifiantSource: "ANCIEN" })] }));
    await Promise.resolve();
    expect(screen.queryByText("ANCIEN")).not.toBeInTheDocument();
  });

  it("un autre lot repart de zéro : le filtre est remis à « Toutes les lignes »", async () => {
    const charger = vi.fn<Charge>(async () => reponseApercu());
    const { rerender } = rendre(charger);
    await screen.findByRole("table");
    await userEvent.selectOptions(screen.getByLabelText("Filtrer par statut de ligne"), "REJETEE");
    rerender(<ApercuEchantillon lotId="lot-2" chargerApercu={charger} />);
    await waitFor(() => expect(screen.getByLabelText("Filtrer par statut de ligne")).toHaveValue(""));
    await waitFor(() => expect(charger).toHaveBeenLastCalledWith({ limite: 20 }));
  });
});

describe("Charger plus", () => {
  it("demande la page suivante avec « apres » et ajoute les lignes", async () => {
    const charger = vi.fn<Charge>(async (p) => (p.apres === undefined
      ? reponseApercu({ lignes: [ligne({ numeroLigne: 1 })], suivant: 20 })
      : reponseApercu({ lignes: [ligne({ numeroLigne: 21, identifiantSource: "RN1-021" })], suivant: null })));
    rendre(charger);
    await screen.findByRole("table");
    expect(screen.getByText(/d'autres lignes sont disponibles/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Charger plus" }));
    expect(await screen.findByText("RN1-021")).toBeInTheDocument();
    expect(charger).toHaveBeenLastCalledWith({ limite: 20, apres: 20 });
    expect(screen.getAllByRole("rowheader")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Charger plus/ })).not.toBeInTheDocument();
  });

  it("garde le filtre de statut dans la page suivante", async () => {
    const charger = vi.fn<Charge>(async () => reponseApercu({ suivant: 5 }));
    rendre(charger);
    await screen.findByRole("table");
    await userEvent.selectOptions(screen.getByLabelText("Filtrer par statut de ligne"), "IGNOREE");
    await waitFor(() => expect(charger).toHaveBeenLastCalledWith({ limite: 20, statut: "IGNOREE" }));
    await screen.findByRole("button", { name: "Charger plus" });
    await userEvent.click(screen.getByRole("button", { name: "Charger plus" }));
    await waitFor(() => expect(charger).toHaveBeenLastCalledWith({ limite: 20, statut: "IGNOREE", apres: 5 }));
  });

  it("un échec de la page suivante garde les lignes déjà affichées et propose de réessayer", async () => {
    const charger = vi.fn<Charge>(async (p) => {
      if (p.apres !== undefined) throw new Error("réseau");
      return reponseApercu({ suivant: 20 });
    });
    rendre(charger);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Charger plus" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/lignes suivantes n'ont pas pu être chargées/);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Réessayer de charger plus" })).toBeEnabled();
  });

  it("la mémoire d'affichage est bornée", async () => {
    const lignes = Array.from({ length: MAX_LIGNES_AFFICHEES }, (_, i) => ligne({ numeroLigne: i + 1 }));
    rendre(vi.fn<Charge>(async () => reponseApercu({ lignes, suivant: MAX_LIGNES_AFFICHEES + 1 })));
    await screen.findByRole("table");
    expect(screen.queryByRole("button", { name: /Charger plus/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Limite d'affichage atteinte/)).toBeInTheDocument();
  });
});

describe("Valeurs tronquées", () => {
  it("signale que l'aperçu n'est pas le contenu complet, et seulement quand c'est le cas", async () => {
    const { unmount } = rendre(vi.fn<Charge>(async () => reponseApercu({ tronque: true })));
    expect(await screen.findByRole("note")).toHaveTextContent("Valeurs tronquées : l'aperçu n'est pas le contenu complet");
    unmount();
    rendre(vi.fn<Charge>(async () => reponseApercu({ tronque: false })));
    await screen.findByRole("table");
    expect(screen.queryByText(/Valeurs tronquées/)).not.toBeInTheDocument();
  });

  it("une troncature vue sur une page reste signalée après la page suivante", async () => {
    const charger = vi.fn<Charge>(async (p) => (p.apres === undefined
      ? reponseApercu({ tronque: true, suivant: 20 })
      : reponseApercu({ lignes: [ligne({ numeroLigne: 21 })], tronque: false })));
    rendre(charger);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Charger plus" }));
    await waitFor(() => expect(charger).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getAllByRole("rowheader")).toHaveLength(2));
    expect(screen.getByText(/Valeurs tronquées/)).toBeInTheDocument();
  });
});

describe("Toutes les valeurs sont du TEXTE", () => {
  it("une valeur <script> s'affiche telle quelle et ne crée aucun élément", async () => {
    const script = "<script>window.__pwned = 1</script>";
    const img = "<img src=x onerror=\"window.__pwned = 2\">";
    const { container } = rendre(vi.fn<Charge>(async () => reponseApercu({
      lignes: [ligne({ identifiantSource: img, charge: { nom: script, "<b>col</b>": "x" } })],
    })));
    await screen.findByRole("table");
    expect(screen.getByText(script)).toBeInTheDocument();
    expect(screen.getByText(img)).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "<b>col</b>" })).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("les caractères de contrôle et l'inversion de sens sont rendus visibles", async () => {
    rendre(vi.fn<Charge>(async () => reponseApercu({
      lignes: [ligne({ charge: { nom: "ligne1\nligne2\u0000fin", fichier: "photo‮gpj.exe", tab: "a\tb" } })],
    })));
    await screen.findByRole("table");
    expect(screen.getByText("ligne1␊ligne2␀fin")).toBeInTheDocument();
    expect(screen.getByText("photo⟨U+202E⟩gpj.exe")).toBeInTheDocument();
    expect(screen.getByText("a␉b")).toBeInTheDocument();
  });

  it("une valeur vide est dite « (vide) » et non laissée blanche", async () => {
    rendre(vi.fn<Charge>(async () => reponseApercu({ lignes: [ligne({ charge: { nom: "" } })] })));
    await screen.findByRole("table");
    expect(screen.getByText("(vide)")).toBeInTheDocument();
  });

  it("le texte de sécurité est affiché, et aucun dangerouslySetInnerHTML n'est utilisé", async () => {
    rendre(vi.fn<Charge>(async () => reponseApercu()));
    await screen.findByRole("table");
    expect(screen.getByText(/Toutes les valeurs sont affichées comme du texte brut/)).toBeInTheDocument();
    // Le garde est sur le code source lui-même : un rendu HTML brut ne se détecterait pas autrement.
    for (const f of ["ApercuEchantillon.tsx", "PanneauDetailLot.tsx", "ListeLots.tsx", "RapportControle.tsx", "HistoriqueLot.tsx", "ResumeEmpreinte.tsx", "CompteursLot.tsx", "FiltresLots.tsx"]) {
      const src = fs.readFileSync(path.resolve(__dirname, f), "utf8");
      expect(src, f).not.toMatch(/dangerouslySetInnerHTML\s*=|innerHTML\s*=/);
    }
  });
});

describe("États : chargement, vide, erreur", () => {
  it("un lot sans ligne dit qu'il n'y a rien à afficher", async () => {
    rendre(vi.fn<Charge>(async () => reponseApercu({ lignes: [] })));
    expect(await screen.findByText("Ce lot ne contient aucune ligne à afficher.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("une erreur est un état distinct du vide, avec « Réessayer » qui relance", async () => {
    const charger = vi.fn<Charge>()
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValueOnce(reponseApercu());
    rendre(charger);
    const alerte = await screen.findByRole("alert");
    expect(alerte).toHaveTextContent("L'aperçu n'a pas pu être chargé.");
    expect(screen.queryByText(/aucune ligne/i)).not.toBeInTheDocument();
    await userEvent.click(within(alerte).getByRole("button", { name: "Réessayer" }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(charger).toHaveBeenCalledTimes(2);
  });

  it("une fonction qui lève tout de suite est une erreur, pas un écran blanc", async () => {
    rendre(vi.fn<Charge>(() => { throw new Error("boum"); }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("l'action refusée par le serveur n'appelle rien et montre sa raison", () => {
    const charger = vi.fn<Charge>(async () => reponseApercu());
    rendre(charger, { action: { permise: false, raison: "Aperçu réservé aux lots contrôlés." } });
    expect(charger).not.toHaveBeenCalled();
    expect(screen.getByText(/Aperçu réservé aux lots contrôlés\./)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Filtrer par statut de ligne")).not.toBeInTheDocument();
  });

  it("dit que ce n'est ni une approbation ni une action : aucun bouton d'approbation", async () => {
    rendre(vi.fn<Charge>(async () => reponseApercu()));
    await screen.findByRole("table");
    expect(screen.getByText(/ne vaut pas approbation/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approuver|valider|importer|autoriser/i })).not.toBeInTheDocument();
  });
});

describe("Cibles tactiles et accessibilité", () => {
  it("le filtre et les boutons ont une hauteur minimale de 44 px", async () => {
    rendre(vi.fn<Charge>(async () => reponseApercu({ suivant: 2 })));
    await screen.findByRole("table");
    expect(screen.getByLabelText("Filtrer par statut de ligne").className).toMatch(/min-h-\[44px\]/);
    expect(screen.getByRole("button", { name: "Charger plus" }).className).toMatch(/min-h-\[44px\]/);
  });

  it("axe : aperçu chargé (valeur <script>, caractères de contrôle, tronqué, motif)", async () => {
    const { container } = rendre(vi.fn<Charge>(async () => reponseApercu({
      tronque: true,
      suivant: 20,
      lignes: [
        ligne({ numeroLigne: 1, charge: { nom: "<script>alert(1)</script>", note: "a\nb" } }),
        ligne({ numeroLigne: 2, statut: "REJETEE", motifRejet: "coordonnées hors domaine", identifiantSource: null, charge: { nom: "x" } }),
        ligne({ numeroLigne: 3, statut: "EN_CONFLIT", charge: {} }),
        ligne({ numeroLigne: 4, statut: "IGNOREE", charge: { nom: "" } }),
      ],
    })));
    await screen.findByRole("table");
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("axe : chargement, vide, erreur, action refusée", async () => {
    let fin!: (r: ReponseApercu) => void;
    const { container, unmount } = rendre(vi.fn<Charge>(() => new Promise((ok) => { fin = ok; })));
    expect(await violationsAccessibilite(container)).toEqual([]);
    fin(reponseApercu({ lignes: [] }));
    await screen.findByText("Ce lot ne contient aucune ligne à afficher.");
    expect(await violationsAccessibilite(container)).toEqual([]);
    unmount();

    const erreur = rendre(vi.fn<Charge>(async () => { throw new Error("x"); }));
    await screen.findByRole("alert");
    expect(await violationsAccessibilite(erreur.container)).toEqual([]);
    erreur.unmount();

    const refus = rendre(vi.fn<Charge>(), { action: { permise: false, raison: "Non." } });
    expect(await violationsAccessibilite(refus.container)).toEqual([]);
  });
});
