import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { violationsAccessibilite } from "../../test/accessibilite";
import { ZoneDepot, type ZoneDepotProps } from "./ZoneDepot";
import type { MetaImport } from "./types";

/**
 * Zone de dépôt : ce que ces tests défendent.
 *
 * - Un VRAI <input type="file"> relié à un libellé visible, atteignable au clavier ; le bouton
 *   « Parcourir vos fichiers » fait la même chose ; le glisser-déposer est un bonus.
 * - Formats et plafonds viennent de la prop `meta` : un autre `meta` change le texte et `accept`.
 * - Le résumé avant envoi dit nom, taille, format DÉCLARÉ, et que le fichier n'est pas encore contrôlé.
 * - Un fichier trop gros est refusé avant l'envoi, sans prétendre valider les autres.
 * - Zéro violation axe : vide, fichier choisi, erreur.
 */

const META: MetaImport = {
  formats: [
    { code: "csv", libelle: "CSV (pivot, séparateur ;)", aide: "Fichier texte au format pivot." },
    { code: "geojson", libelle: "GeoJSON (4326)", aide: "Collection de points ou de tronçons." },
  ],
  tailleMaxOctets: 50 * 1024 * 1024,
  limiteLignes: 100000,
  statuts: [],
};

function Hote(props: Partial<ZoneDepotProps> & { initial?: File | null; surChoix?: (f: File) => void; surRetrait?: () => void }) {
  const { initial = null, surChoix, surRetrait, ...reste } = props;
  const [fichier, setFichier] = useState<File | null>(initial);
  return (
    <ZoneDepot
      meta={META}
      formatDeclare="csv"
      fichier={fichier}
      onChoisir={(f) => { setFichier(f); surChoix?.(f); }}
      onRetirer={() => { setFichier(null); surRetrait?.(); }}
      {...reste}
    />
  );
}

function fichier(nom: string, taille = 1500, type = "text/csv") {
  const f = new File(["x"], nom, { type });
  Object.defineProperty(f, "size", { value: taille });
  return f;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("ZoneDepot : un vrai champ fichier, accessible", () => {
  it("un input type=file relié à un libellé visible, obligatoire", () => {
    render(<Hote />);
    const entree = screen.getByLabelText(/Fichier à recevoir/);
    expect(entree).toHaveAttribute("type", "file");
    expect(entree).toHaveAttribute("aria-required", "true");
    expect(entree).not.toBeInvalid();
    expect(screen.getByText(/Fichier à recevoir/, { selector: "label" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Parcourir vos fichiers" })).toBeInTheDocument();
    expect(screen.getByText("Aucun fichier choisi.")).toBeInTheDocument();
  });

  it("accept est dérivé des formats de /meta", () => {
    const { rerender } = render(<Hote />);
    expect(screen.getByLabelText(/Fichier à recevoir/)).toHaveAttribute("accept", ".csv,.geojson,.json");
    rerender(<ZoneDepot meta={{ ...META, formats: [META.formats[0]] }} formatDeclare="csv" fichier={null} onChoisir={() => {}} onRetirer={() => {}} />);
    expect(screen.getByLabelText(/Fichier à recevoir/)).toHaveAttribute("accept", ".csv");
  });

  it("l'aide lit formats et plafonds dans meta, jamais en dur, et dit que seuls ces formats sont pris en charge", () => {
    const autre: MetaImport = { ...META, formats: [{ code: "csv", libelle: "Tableur maison", aide: "" }], tailleMaxOctets: 5 * 1024 * 1024, limiteLignes: 2000 };
    render(<ZoneDepot meta={autre} formatDeclare="csv" fichier={null} onChoisir={() => {}} onRetirer={() => {}} />);
    const aide = screen.getByText(/Formats pris en charge/);
    expect(aide).toHaveTextContent("Tableur maison");
    expect(aide).toHaveTextContent("Seuls ces formats sont pris en charge");
    expect(aide).toHaveTextContent("5 Mo");
    expect(aide).toHaveTextContent("2 000 lignes");
    expect(aide).not.toHaveTextContent(/GeoJSON|50 Mo|XLSX|GPKG|1 Go/i);
    expect(screen.getByLabelText(/Fichier à recevoir/)).toHaveAccessibleDescription(/Tableur maison/);
  });

  it("le bouton Parcourir ouvre le sélecteur de l'input", async () => {
    const clic = vi.spyOn(HTMLInputElement.prototype, "click");
    render(<Hote />);
    await userEvent.click(screen.getByRole("button", { name: "Parcourir vos fichiers" }));
    expect(clic).toHaveBeenCalledTimes(1);
  });

  it("cibles tactiles d'au moins 44 px (classes h-11)", () => {
    render(<Hote initial={fichier("lot.csv")} />);
    expect(screen.getByRole("button", { name: "Parcourir vos fichiers" })).toHaveClass("h-11");
    expect(screen.getByRole("button", { name: "Retirer le fichier" })).toHaveClass("h-11");
  });
});

describe("ZoneDepot : choisir, résumer, retirer", () => {
  it("après le choix : résumé avec nom, taille, format déclaré et la phrase « pas encore contrôlé »", async () => {
    const surChoix = vi.fn();
    render(<Hote surChoix={surChoix} />);
    await userEvent.upload(screen.getByLabelText(/Fichier à recevoir/), fichier("releves_RN1.csv", 12 * 1024));
    expect(surChoix).toHaveBeenCalledTimes(1);
    const resume = screen.getByRole("region", { name: "Résumé du fichier choisi" });
    expect(within(resume).getByTestId("nom-fichier")).toHaveTextContent("releves_RN1.csv");
    expect(within(resume).getByText("12 Ko")).toBeInTheDocument();
    expect(within(resume).getByText("CSV (pivot, séparateur ;)")).toBeInTheDocument();
    expect(within(resume).getByText("Ce fichier n'est pas encore contrôlé. Le serveur calcule son empreinte à la réception.")).toBeInTheDocument();
    expect(within(resume).getByRole("button", { name: "Retirer le fichier" })).toBeInTheDocument();
    expect(screen.queryByText("Aucun fichier choisi.")).not.toBeInTheDocument();
  });

  it("annonce le fichier choisi dans une région aria-live polie présente dès le départ", async () => {
    render(<Hote />);
    const annonce = screen.getByRole("status");
    expect(annonce).toHaveAttribute("aria-live", "polite");
    expect(annonce).toBeEmptyDOMElement();
    await userEvent.upload(screen.getByLabelText(/Fichier à recevoir/), fichier("lot.csv", 2048));
    expect(annonce).toHaveTextContent("Fichier choisi : lot.csv, 2 Ko.");
  });

  it("tronque un long nom en gardant l'extension, et garde le nom complet disponible", () => {
    const long = "export_releves_RN1_2026_octobre_version_finale_corrigee_v2.geojson";
    render(<Hote initial={fichier(long, 100, "application/geo+json")} />);
    const nom = screen.getByTestId("nom-fichier");
    const abrege = nom.querySelector("[aria-hidden='true']");
    expect(abrege?.textContent).toMatch(/…\.geojson$/);
    expect(abrege?.textContent?.length).toBeLessThan(long.length);
    expect(nom.querySelector("[title]")).toHaveAttribute("title", long);
    expect(nom).toHaveTextContent(long); // version complète pour les lecteurs d'écran
  });

  it("un nom court est affiché tel quel, une seule fois", () => {
    render(<Hote initial={fichier("lot.csv")} />);
    expect(screen.getAllByText("lot.csv")).toHaveLength(1);
  });

  it("Retirer le fichier vide la sélection, l'annonce, et rend le focus à Parcourir", async () => {
    const surRetrait = vi.fn();
    render(<Hote initial={fichier("lot.csv")} surRetrait={surRetrait} />);
    await userEvent.click(screen.getByRole("button", { name: "Retirer le fichier" }));
    expect(surRetrait).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("region", { name: "Résumé du fichier choisi" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Fichier retiré. Aucun fichier choisi.");
    expect(screen.getByRole("button", { name: "Parcourir vos fichiers" })).toHaveFocus();
  });

  it("vide l'input quand le parent retire le fichier : on peut rechoisir le même", async () => {
    const surChoix = vi.fn();
    render(<Hote surChoix={surChoix} />);
    const entree = screen.getByLabelText(/Fichier à recevoir/) as HTMLInputElement;
    const f = fichier("lot.csv");
    await userEvent.upload(entree, f);
    await userEvent.click(screen.getByRole("button", { name: "Retirer le fichier" }));
    expect(entree.files).toHaveLength(0);
    await userEvent.upload(entree, f);
    expect(surChoix).toHaveBeenCalledTimes(2);
  });
});

describe("ZoneDepot : refus avant envoi et indices", () => {
  it("refuse un fichier trop gros avec un message, sans prétendre le valider", () => {
    render(<Hote initial={fichier("gros.csv", META.tailleMaxOctets + 1)} />);
    const entree = screen.getByLabelText(/Fichier à recevoir/);
    expect(entree).toBeInvalid();
    expect(entree).toHaveAccessibleDescription(/le maximum accepté est 50 Mo/);
    expect(screen.getByText(/Ce fichier fait 50 Mo/)).toBeInTheDocument();
    expect(screen.getByText(/Il ne sera pas envoyé/)).toBeInTheDocument();
    expect(screen.queryByText(/pas encore contrôlé/)).not.toBeInTheDocument();
  });

  it("un fichier vide est refusé", () => {
    render(<Hote initial={fichier("vide.csv", 0)} />);
    expect(screen.getByText(/Ce fichier est vide/)).toBeInTheDocument();
  });

  it("extension incohérente avec le format déclaré : avertissement NON bloquant", () => {
    const { container } = render(<Hote initial={fichier("lot.geojson", 100)} />);
    expect(screen.getByText(/Le nom du fichier évoque le format GeoJSON/)).toBeInTheDocument();
    expect(screen.getByText(/le serveur contrôle le contenu réel du fichier et décide/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Fichier à recevoir/)).not.toBeInvalid();
    expect(screen.getByText(/pas encore contrôlé/)).toBeInTheDocument();
    expect(container.querySelector("[role='alert']")).toBeNull();
  });

  it("l'erreur du serveur (fichier vide...) s'affiche et décrit le champ", () => {
    render(<Hote initial={fichier("lot.csv")} erreurServeur="Le serveur a reçu un fichier vide." />);
    const entree = screen.getByLabelText(/Fichier à recevoir/);
    expect(entree).toBeInvalid();
    expect(entree).toHaveAccessibleDescription(/Le serveur a reçu un fichier vide/);
  });

  it("l'absence de fichier n'est signalée qu'après une tentative d'envoi", () => {
    const { rerender } = render(<Hote />);
    expect(screen.queryByText(/Choisissez le fichier à recevoir/)).not.toBeInTheDocument();
    rerender(<ZoneDepot meta={META} formatDeclare="csv" fichier={null} onChoisir={() => {}} onRetirer={() => {}} afficherErreurAbsence />);
    expect(screen.getByText(/Choisissez le fichier à recevoir/)).toBeInTheDocument();
  });

  it("désactivée : l'input et les boutons le sont", () => {
    render(<Hote initial={fichier("lot.csv")} desactive />);
    expect(screen.getByLabelText(/Fichier à recevoir/)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Parcourir vos fichiers" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Retirer le fichier" })).toBeDisabled();
  });
});

describe("ZoneDepot : glisser-déposer facultatif", () => {
  function zone() {
    return screen.getByText(/Déposez le fichier ici/).closest("div")!.parentElement!;
  }

  it("déposer un fichier le choisit", () => {
    const surChoix = vi.fn();
    render(<Hote surChoix={surChoix} />);
    const f = fichier("depose.csv");
    fireEvent.dragOver(zone(), { dataTransfer: { files: [f] } });
    fireEvent.drop(zone(), { dataTransfer: { files: [f] } });
    expect(surChoix).toHaveBeenCalledWith(f);
    expect(screen.getByTestId("nom-fichier")).toHaveTextContent("depose.csv");
  });

  it("plusieurs fichiers déposés : le premier est retenu et on le dit", () => {
    render(<Hote />);
    const a = fichier("a.csv");
    fireEvent.drop(zone(), { dataTransfer: { files: [a, fichier("b.csv")] } });
    expect(screen.getByTestId("nom-fichier")).toHaveTextContent("a.csv");
    expect(screen.getByRole("status")).toHaveTextContent(/Un seul fichier est reçu à la fois/);
  });

  it("désactivée, un dépôt est ignoré", () => {
    const surChoix = vi.fn();
    render(<Hote surChoix={surChoix} desactive />);
    fireEvent.drop(zone(), { dataTransfer: { files: [fichier("a.csv")] } });
    expect(surChoix).not.toHaveBeenCalled();
  });

  it("le dragover est annulé (sinon le navigateur ouvrirait le fichier)", () => {
    render(<Hote />);
    const evenement = new Event("dragover", { bubbles: true, cancelable: true });
    act(() => { zone().dispatchEvent(evenement); });
    expect(evenement.defaultPrevented).toBe(true);
  });
});

describe("ZoneDepot : clavier seul", () => {
  it("Tab atteint l'input puis Parcourir ; Entrée et Espace sur Parcourir ouvrent le sélecteur", async () => {
    const clic = vi.spyOn(HTMLInputElement.prototype, "click");
    const user = userEvent.setup();
    render(<Hote />);
    await user.tab();
    expect(screen.getByLabelText(/Fichier à recevoir/)).toHaveFocus();
    await user.tab();
    const parcourir = screen.getByRole("button", { name: "Parcourir vos fichiers" });
    expect(parcourir).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(clic).toHaveBeenCalledTimes(1);
    await user.keyboard(" ");
    expect(clic).toHaveBeenCalledTimes(2);
  });

  it("Retirer le fichier se commande à Entrée et à Espace", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Hote initial={fichier("a.csv")} />);
    screen.getByRole("button", { name: "Retirer le fichier" }).focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("button", { name: "Retirer le fichier" })).not.toBeInTheDocument();
    rerender(<Hote key="2" initial={fichier("b.csv")} />);
    screen.getByRole("button", { name: "Retirer le fichier" }).focus();
    await user.keyboard(" ");
    expect(screen.queryByRole("button", { name: "Retirer le fichier" })).not.toBeInTheDocument();
  });
});

describe("ZoneDepot : accessibilité (axe)", () => {
  it("à vide", async () => {
    const { container } = render(<Hote />);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("fichier choisi", async () => {
    const { container } = render(<Hote initial={fichier("export_releves_RN1_2026_octobre_version_finale_corrigee.csv")} />);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("fichier choisi avec avertissement d'extension", async () => {
    const { container } = render(<Hote initial={fichier("lot.xlsx")} />);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("erreur (fichier trop gros)", async () => {
    const { container } = render(<Hote initial={fichier("gros.csv", META.tailleMaxOctets + 1)} />);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});
