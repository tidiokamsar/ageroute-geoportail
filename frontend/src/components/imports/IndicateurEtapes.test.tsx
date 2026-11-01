import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { violationsAccessibilite } from "../../test/accessibilite";
import { IndicateurEtapes } from "./IndicateurEtapes";
import { ETATS_ETAPE, RAISON_MANQUANTE } from "./imports.noyau";
import type { Etape, EtatEtape } from "./types";

/**
 * Ce que ces tests defendent :
 *   - la liste est une `<ol>` de 4 etapes lues dans `Etape[]` ; chaque etat a une apparence distincte (icone + texte + trait) ;
 *   - la RAISON du serveur est du texte visible, jamais seulement une infobulle ;
 *   - `aria-current="step"` n'est pose que sur l'etape EN_COURS ; chaque etape a un nom accessible complet ;
 *   - sans lot : quatre etapes NON_COMMENCEE, la premiere « disponible : formulaire ci-dessous », JAMAIS une etape terminee ;
 *   - aucun bouton, aucun lien, aucun changement au clic : l'indicateur ne produit aucun changement d'etat ;
 *   - mise en page : empile par defaut, en ligne en grand ecran, sans debordement ;
 *   - 0 violation axe-core (WCAG 2.1 A et AA, contraste exclu : mesure ailleurs, voir BadgeStatutLot.test.tsx).
 */

afterEach(() => cleanup());

const TITRES = ["Réception du fichier", "Contrôle du schéma", "Échantillon à valider", "Import autorisé"] as const;
const IDS = ["reception", "controle_schema", "echantillon", "import_autorise"] as const;

const quatre = (etats: [EtatEtape, EtatEtape, EtatEtape, EtatEtape], raisons: [string, string, string, string] = ["", "", "", ""]): Etape[] =>
  IDS.map((id, i) => ({ id, titre: TITRES[i], etat: etats[i], raison: raisons[i] }));

/** Un lot valide : ce que le serveur renvoie aujourd'hui (etapes 3 et 4 sans circuit). */
const lotValide = () =>
  quatre(
    ["TERMINEE", "TERMINEE", "NON_DISPONIBLE", "NON_DISPONIBLE"],
    ["Fichier reçu, empreinte calculée.", "Schéma conforme.", "Aucun circuit d'approbation n'existe pour l'instant.", "L'import dans le référentiel n'existe pas encore."],
  );

const items = () => screen.getAllByRole("listitem");

describe("structure", () => {
  it("une liste ordonnee <ol> de quatre etapes, dans l'ordre du serveur, avec numero et titre", () => {
    const { container } = render(<IndicateurEtapes etapes={lotValide()} />);
    expect(container.querySelector("ol")).not.toBeNull();
    expect(screen.getByRole("list")).toBe(container.querySelector("ol"));
    expect(items()).toHaveLength(4);
    items().forEach((li, i) => {
      expect(li).toHaveAttribute("data-etape", IDS[i]);
      expect(within(li).getByText(TITRES[i])).toBeInTheDocument();
      expect(li.textContent).toContain(String(i + 1));
    });
  });

  it("la liste a un nom accessible qui resume l'avancement", () => {
    render(<IndicateurEtapes etapes={lotValide()} />);
    expect(screen.getByRole("list", { name: "Avancement du lot, 4 étapes : 2 terminées, 2 non disponibles." })).toBeInTheDocument();
  });

  it("n'affiche que ce que le serveur envoie : un autre nombre d'etapes est rendu tel quel, avec le bon « sur N »", () => {
    render(<IndicateurEtapes etapes={lotValide().slice(0, 2)} />);
    expect(items()).toHaveLength(2);
    expect(items()[1]).toHaveAttribute("aria-label", expect.stringMatching(/^Étape 2 sur 2, terminée : /));
  });

  it("ne modifie pas les etapes recues (donnees gelees acceptees)", () => {
    const etapes = Object.freeze(lotValide().map((e) => Object.freeze({ ...e })));
    expect(() => render(<IndicateurEtapes etapes={etapes} />)).not.toThrow();
  });
});

describe("un etat, une apparence", () => {
  const six = ETATS_ETAPE.map((etat, i): Etape => ({ id: IDS[i % 4], titre: `Étape ${etat}`, etat, raison: etat === "TERMINEE" ? "" : `Raison ${etat}.` }));

  it("six etats : six textes, six apparences distinctes (icone, texte, trait en tirets pour « non disponible »)", () => {
    render(<IndicateurEtapes etapes={six} />);
    const lis = items();
    const textes = lis.map((li) => within(li).getByText(/^(Terminée|Terminée avec réserves|Échec|En cours|Non disponible|Non commencée)$/).textContent);
    expect(textes).toEqual(["Terminée", "Terminée avec réserves", "Échec", "En cours", "Non disponible", "Non commencée"]);
    // Chaque etat porte une icone decorative.
    for (const li of lis) {
      const icone = li.querySelector("svg");
      expect(icone).not.toBeNull();
      expect(icone).toHaveAttribute("aria-hidden", "true");
    }
    // Seul « non disponible » est pointille.
    expect(lis.map((li) => li.classList.contains("border-dashed"))).toEqual([false, false, false, false, true, false]);
    // Les apparences (ton + icone) sont toutes differentes : une etape terminee ne ressemble a aucune autre.
    const empreintes = lis.map((li) => `${li.getAttribute("data-etat")}|${li.className.match(/border-(?:etat-\w+-trait|info)/)?.[0]}|${li.querySelector("svg")?.getAttribute("class")}`);
    expect(new Set(empreintes).size).toBe(6);
  });

  it("« non disponible » : cadenas, texte, trait en tirets et raison visible", () => {
    render(<IndicateurEtapes etapes={lotValide()} />);
    const li = items()[2];
    expect(li).toHaveClass("border-dashed");
    expect(within(li).getByText("Non disponible")).toBeInTheDocument();
    expect(li.querySelector("svg.lucide-lock")).not.toBeNull();
    expect(within(li).getByText("Aucun circuit d'approbation n'existe pour l'instant.")).toBeVisible();
  });

  it("seule une etape TERMINEE porte le ton de reussite : une etape non disponible ou non commencee n'est jamais verte", () => {
    render(<IndicateurEtapes etapes={six} />);
    const verts = items().filter((li) => /etat-bon/.test(li.innerHTML));
    expect(verts.map((li) => li.getAttribute("data-etat"))).toEqual(["TERMINEE"]);
  });

  it("une etape EN_COURS a une icone qui ne tourne que si le mouvement est autorise", () => {
    render(<IndicateurEtapes etapes={six} />);
    const icone = items()[3].querySelector("svg")!;
    expect(icone.getAttribute("class")).toContain("motion-safe:animate-spin");
  });

  it("un etat inattendu du serveur est dit « État inconnu » et n'est jamais presente comme termine", () => {
    render(<IndicateurEtapes etapes={[{ id: "reception", titre: "Réception du fichier", etat: "TERMINE_OK" as EtatEtape, raison: "" }]} />);
    const li = items()[0];
    expect(within(li).getByText("État inconnu")).toBeInTheDocument();
    expect(li.innerHTML).not.toMatch(/etat-bon/);
  });
});

describe("raison fournie par le serveur", () => {
  it("la raison est du texte visible dans l'etape, pas seulement un attribut title", () => {
    const { container } = render(<IndicateurEtapes etapes={lotValide()} />);
    expect(screen.getByText("Schéma conforme.")).toBeVisible();
    expect(container.querySelector("[title]")).toBeNull();
  });

  it("une raison manquante sur un etat qui l'exige est dite, sans etre inventee", () => {
    render(<IndicateurEtapes etapes={quatre(["TERMINEE", "ECHEC", "NON_DISPONIBLE", "NON_DISPONIBLE"])} />);
    expect(screen.getAllByText(RAISON_MANQUANTE)).toHaveLength(3);
  });

  it("une etape terminee sans raison n'affiche pas de paragraphe vide", () => {
    render(<IndicateurEtapes etapes={quatre(["TERMINEE", "TERMINEE", "TERMINEE", "TERMINEE"])} />);
    for (const li of items()) expect(li.querySelectorAll("p")).toHaveLength(2);
  });

  it("le balisage d'une raison est rendu en texte (jamais en HTML)", () => {
    const { container } = render(<IndicateurEtapes etapes={quatre(["TERMINEE", "ECHEC", "NON_DISPONIBLE", "NON_DISPONIBLE"], ["", '<img src=x onerror="alert(1)">', "", ""])} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeInTheDocument();
  });
});

describe("nom accessible et etape courante", () => {
  it("chaque etape a un nom complet « Étape N sur 4, <etat> : <titre>. <raison> »", () => {
    render(<IndicateurEtapes etapes={lotValide()} />);
    expect(items().map((li) => li.getAttribute("aria-label"))).toEqual([
      "Étape 1 sur 4, terminée : Réception du fichier. Fichier reçu, empreinte calculée.",
      "Étape 2 sur 4, terminée : Contrôle du schéma. Schéma conforme.",
      "Étape 3 sur 4, non disponible : Échantillon à valider. Aucun circuit d'approbation n'existe pour l'instant.",
      "Étape 4 sur 4, non disponible : Import autorisé. L'import dans le référentiel n'existe pas encore.",
    ]);
    expect(screen.getByRole("listitem", { name: /^Étape 3 sur 4, non disponible/ })).toBeInTheDocument();
  });

  it("aria-current=\"step\" sur l'etape EN_COURS, et sur elle seule", () => {
    render(<IndicateurEtapes etapes={quatre(["TERMINEE", "EN_COURS", "NON_COMMENCEE", "NON_COMMENCEE"])} />);
    expect(items().map((li) => li.getAttribute("aria-current"))).toEqual([null, "step", null, null]);
    expect(items()[1]).toHaveClass("border-2");
  });

  it("aucune etape EN_COURS : aucun aria-current (on ne devine pas l'etape courante)", () => {
    render(<IndicateurEtapes etapes={lotValide()} />);
    expect(items().every((li) => !li.hasAttribute("aria-current"))).toBe(true);
  });

  it("un lot rejete : le echec est dit, le reste n'est pas presente comme avance", () => {
    render(<IndicateurEtapes etapes={quatre(["TERMINEE", "ECHEC", "NON_DISPONIBLE", "NON_DISPONIBLE"], ["", "Colonne obligatoire absente.", "", ""])} />);
    expect(items()[1]).toHaveAttribute("aria-label", "Étape 2 sur 4, échec : Contrôle du schéma. Colonne obligatoire absente.");
    expect(screen.getByRole("list")).toHaveAccessibleName("Avancement du lot, 4 étapes : 1 terminée, 1 en échec, 2 non disponibles.");
  });
});

describe("aucun lot selectionne", () => {
  it.each([["undefined", undefined], ["null", null], ["liste vide", []]])("%s : quatre etapes non commencees, la premiere disponible", (_nom, etapes) => {
    const { container } = render(<IndicateurEtapes etapes={etapes} />);
    expect(container.querySelector("ol")).toHaveAttribute("data-variante", "aucun-lot");
    expect(items()).toHaveLength(4);
    items().forEach((li, i) => {
      expect(li).toHaveAttribute("data-etape", IDS[i]);
      expect(li).toHaveAttribute("data-etat", "NON_COMMENCEE");
      expect(within(li).getByText("Non commencée")).toBeInTheDocument();
    });
    expect(within(items()[0]).getByText("Disponible : formulaire ci-dessous.")).toBeVisible();
    expect(screen.getByRole("list")).toHaveAccessibleName("Aucun lot sélectionné : les 4 étapes du cycle ne sont pas commencées.");
  });

  it("JAMAIS d'etape terminee ni de ton de reussite, et aucun aria-current", () => {
    const { container } = render(<IndicateurEtapes />);
    expect(screen.queryByText(/^Terminée/)).not.toBeInTheDocument();
    expect(screen.queryByText("En cours")).not.toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(/etat-bon|lucide-circle-check/);
    expect(items().every((li) => !li.hasAttribute("aria-current"))).toBe(true);
  });

  it("le nom accessible de la premiere etape dit qu'elle est disponible, sans la dire commencee", () => {
    render(<IndicateurEtapes />);
    expect(items()[0]).toHaveAttribute("aria-label", "Étape 1 sur 4, non commencée : Réception du fichier. Disponible : formulaire ci-dessous.");
  });

  it("la variante lot reprend le dessus des qu'un lot (donc des etapes) est fourni", () => {
    const { rerender, container } = render(<IndicateurEtapes />);
    expect(container.querySelector("ol")).toHaveAttribute("data-variante", "aucun-lot");
    rerender(<IndicateurEtapes etapes={lotValide()} />);
    expect(container.querySelector("ol")).toHaveAttribute("data-variante", "lot");
    expect(within(items()[0]).getByText("Terminée")).toBeInTheDocument();
  });
});

describe("l'indicateur ne produit aucun changement d'etat", () => {
  it("aucun bouton, aucun lien, aucun element focalisable", () => {
    const { container } = render(<IndicateurEtapes etapes={lotValide()} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(container.querySelectorAll("a, button, input, select, textarea, [tabindex], [onclick]")).toHaveLength(0);
  });

  it("cliquer et appuyer sur des touches ne change rien au rendu", async () => {
    const user = userEvent.setup();
    const { container } = render(<IndicateurEtapes etapes={lotValide()} />);
    const avant = container.innerHTML;
    for (const li of items()) await user.click(li);
    await user.keyboard("{Tab}{Enter} {ArrowRight}");
    expect(container.innerHTML).toBe(avant);
  });

  it("le clavier ne tombe sur aucune etape (rien a activer)", async () => {
    const user = userEvent.setup();
    render(<IndicateurEtapes etapes={lotValide()} />);
    await user.tab();
    expect(document.body).toHaveFocus();
  });
});

describe("mise en page", () => {
  it("empilee par defaut (mobile), en ligne en grand ecran, sans debordement horizontal", () => {
    render(<IndicateurEtapes etapes={lotValide()} />);
    const ol = screen.getByRole("list");
    expect(ol).toHaveClass("flex", "flex-col", "xl:flex-row");
    for (const li of items()) {
      expect(li).toHaveClass("min-w-0", "xl:flex-1");
      expect(li.querySelector(".\\[overflow-wrap\\:anywhere\\]")).not.toBeNull();
    }
  });

  it("le numero est decoratif (le nom accessible porte « Étape N sur 4 »), le titre reste lisible", () => {
    render(<IndicateurEtapes etapes={lotValide()} />);
    const li = items()[0];
    expect(li.querySelector("[aria-hidden=true]:not(svg)")).toHaveTextContent("1");
  });

  it("accepte une classe de l'appelant", () => {
    render(<IndicateurEtapes etapes={lotValide()} className="mt-j4" />);
    expect(screen.getByRole("list")).toHaveClass("mt-j4");
  });
});

describe("accessibilite (axe-core, WCAG 2.1 A et AA, contraste exclu)", () => {
  it("0 violation : lot valide (etapes 3 et 4 non disponibles)", async () => {
    const { container } = render(<IndicateurEtapes etapes={lotValide()} />);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("0 violation : aucun lot", async () => {
    const { container } = render(<IndicateurEtapes />);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("0 violation : les six etats ensemble, lot rejete et etape en cours", async () => {
    const etats: EtatEtape[] = [...ETATS_ETAPE];
    const { container } = render(
      <>
        <IndicateurEtapes etapes={etats.map((etat, i) => ({ id: IDS[i % 4], titre: TITRES[i % 4], etat, raison: `Raison ${i}.` }))} />
        <IndicateurEtapes etapes={quatre(["TERMINEE", "ECHEC", "NON_DISPONIBLE", "NON_DISPONIBLE"], ["", "Colonne absente.", "", ""])} />
        <IndicateurEtapes etapes={quatre(["TERMINEE", "EN_COURS", "NON_COMMENCEE", "NON_COMMENCEE"])} />
      </>,
    );
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});
