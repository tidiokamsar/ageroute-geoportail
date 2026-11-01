import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { violationsAccessibilite } from "../../test/accessibilite";
import { BandeauGouvernance } from "./BandeauGouvernance";
import { PHRASE_GOUVERNANCE, REGLES_RECEPTION, TITRE_GOUVERNANCE } from "./imports.noyau";

/**
 * Ce que ces tests defendent :
 *   - « Recevoir un lot n'est pas importer. » et la phrase des cinq etats sont TOUJOURS visibles, regles repliees ou non ;
 *   - la note est nommee par son titre (`role="note"`), en ambre par jetons (avertissement) ;
 *   - « Voir les règles de réception » est un bouton `aria-expanded` / `aria-controls`, au clavier comme a la souris, d'au moins 44 px ;
 *   - les regles depliees sont les regles reelles du noyau, et disent « non disponible » pour ce qui n'existe pas ;
 *   - le bandeau est purement informatif : un seul bouton, aucun lien d'action, aucune ecriture ;
 *   - 0 violation axe-core (WCAG 2.1 A et AA, contraste exclu : mesure dans BadgeStatutLot.test.tsx).
 */

afterEach(() => cleanup());

const bouton = () => screen.getByRole("button", { name: "Voir les règles de réception" });

describe("contenu permanent", () => {
  it("le titre et la phrase des cinq etats sont visibles, regles repliees", () => {
    render(<BandeauGouvernance />);
    expect(screen.getByText("Recevoir un lot n'est pas importer.")).toBeVisible();
    expect(screen.getByText(PHRASE_GOUVERNANCE)).toBeVisible();
    for (const mot of ["reçu", "validé techniquement", "approuvé par le métier", "autorisé à écrire", "importé"]) {
      expect(screen.getByText(PHRASE_GOUVERNANCE).textContent!.toLowerCase()).toContain(mot);
    }
  });

  it("une note nommee par son titre", () => {
    render(<BandeauGouvernance />);
    const note = screen.getByRole("note", { name: TITRE_GOUVERNANCE });
    expect(note).toBeInTheDocument();
    expect(within(note).getByText(TITRE_GOUVERNANCE)).toBeInTheDocument();
  });

  it("ambre par jetons (avertissement), aucune teinte brute", () => {
    render(<BandeauGouvernance />);
    const note = screen.getByRole("note");
    expect(note).toHaveClass("bg-etat-moyen-fond", "border-etat-moyen-trait", "text-avertissement");
    expect(note.className).not.toMatch(/(amber|yellow|orange|green|red)-\d/);
  });

  it("l'icone d'avertissement est decorative", () => {
    render(<BandeauGouvernance />);
    const icone = screen.getByRole("note").querySelector("svg")!;
    expect(icone).toHaveAttribute("aria-hidden", "true");
  });

  it("accepte une classe de l'appelant", () => {
    render(<BandeauGouvernance className="mb-j4" />);
    expect(screen.getByRole("note")).toHaveClass("mb-j4");
  });
});

describe("section repliable « Voir les règles de réception »", () => {
  it("replie par defaut : aria-expanded=false, regles masquees (pour tous)", () => {
    render(<BandeauGouvernance />);
    expect(bouton()).toHaveAttribute("aria-expanded", "false");
    const panneau = document.getElementById(bouton().getAttribute("aria-controls")!)!;
    expect(panneau).toBeInTheDocument();
    expect(panneau).not.toBeVisible();
    expect(screen.queryByText(REGLES_RECEPTION[0].texte)).not.toBeVisible();
  });

  it("un clic deplie : aria-expanded=true, regles visibles ; un second clic replie", async () => {
    const user = userEvent.setup();
    render(<BandeauGouvernance />);
    await user.click(bouton());
    expect(bouton()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(REGLES_RECEPTION[0].texte)).toBeVisible();
    await user.click(bouton());
    expect(bouton()).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText(REGLES_RECEPTION[0].texte)).not.toBeVisible();
  });

  it("au clavier : Entree et Espace basculent, Tab atteint le bouton", async () => {
    const user = userEvent.setup();
    render(<BandeauGouvernance />);
    await user.tab();
    expect(bouton()).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(bouton()).toHaveAttribute("aria-expanded", "true");
    await user.keyboard(" ");
    expect(bouton()).toHaveAttribute("aria-expanded", "false");
    await user.keyboard(" ");
    expect(bouton()).toHaveAttribute("aria-expanded", "true");
  });

  it("aria-controls designe le panneau des regles, et deux bandeaux n'ont pas les memes identifiants", () => {
    render(<><BandeauGouvernance /><BandeauGouvernance reglesOuvertes /></>);
    const boutons = screen.getAllByRole("button", { name: "Voir les règles de réception" });
    const ids = boutons.map((b) => b.getAttribute("aria-controls")!);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(document.getElementById(id)).toHaveAttribute("id", id);
    expect(boutons.map((b) => b.getAttribute("aria-expanded"))).toEqual(["false", "true"]);
  });

  it("le libelle du bouton reste constant, ouvert ou ferme (l'etat se lit par aria-expanded)", async () => {
    const user = userEvent.setup();
    render(<BandeauGouvernance />);
    await user.click(bouton());
    expect(bouton()).toHaveTextContent("Voir les règles de réception");
  });

  it("cible tactile d'au moins 44 px (min-h-cible = --cible-min)", () => {
    render(<BandeauGouvernance />);
    expect(bouton()).toHaveClass("min-h-cible");
  });

  it("`reglesOuvertes` ouvre a l'affichage", () => {
    render(<BandeauGouvernance reglesOuvertes />);
    expect(bouton()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(REGLES_RECEPTION[0].texte)).toBeVisible();
  });
});

describe("les regles depliees sont les regles reelles", () => {
  it("toutes les regles du noyau sont affichees, dans l'ordre", async () => {
    const user = userEvent.setup();
    render(<BandeauGouvernance />);
    await user.click(bouton());
    const panneau = document.getElementById(bouton().getAttribute("aria-controls")!)!;
    const lignes = within(panneau).getAllByRole("listitem").map((li) => li.textContent);
    expect(lignes).toEqual(REGLES_RECEPTION.map((r) => r.texte));
  });

  it("les cinq regles imposees sont presentes, et ce qui n'existe pas est dit « non disponible »", async () => {
    const user = userEvent.setup();
    render(<BandeauGouvernance />);
    await user.click(bouton());
    const panneau = document.getElementById(bouton().getAttribute("aria-controls")!)!;
    const texte = panneau.textContent!;
    expect(texte).toMatch(/n'écrit rien dans le référentiel/);
    expect(texte).toMatch(/empreinte.*calculée par le serveur/);
    expect(texte).toMatch(/même fichier reçu deux fois.*rien n'est écrit/);
    expect(texte).toMatch(/lot rejeté est un résultat/);
    expect(texte).toMatch(/application au référentiel.*non disponible/i);
  });

  it("aucune promesse : ni format, ni plafond que le contrat n'annonce pas", async () => {
    const user = userEvent.setup();
    const { container } = render(<BandeauGouvernance />);
    await user.click(bouton());
    expect(container.textContent).not.toMatch(/xlsx|gpkg|geopackage|zip|1 ?Go/i);
  });

  it("les textes sont sans emoji ni tiret cadratin", () => {
    const { container } = render(<BandeauGouvernance reglesOuvertes />);
    expect(container.textContent).not.toMatch(/[–—]/);
    expect(container.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("purement informatif", () => {
  it("un seul bouton (deplier), aucun lien, aucune action d'ecriture ou d'import", async () => {
    const user = userEvent.setup();
    const { container } = render(<BandeauGouvernance />);
    await user.click(bouton());
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(container.querySelectorAll("a, form, input, select, textarea")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /importer|appliquer|approuver|autoriser|valider/i })).not.toBeInTheDocument();
  });
});

describe("accessibilite (axe-core, WCAG 2.1 A et AA, contraste exclu)", () => {
  it("0 violation : regles repliees", async () => {
    const { container } = render(<BandeauGouvernance />);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("0 violation : regles depliees", async () => {
    const { container } = render(<BandeauGouvernance reglesOuvertes />);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("0 violation : deux bandeaux dans la meme page (identifiants uniques)", async () => {
    const { container } = render(<><BandeauGouvernance /><BandeauGouvernance reglesOuvertes /></>);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});
