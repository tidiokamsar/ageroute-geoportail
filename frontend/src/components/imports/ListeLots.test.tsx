import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ListeLots, type ListeLotsProps } from "./ListeLots";
import { lotListe } from "./lotsDeTest";
import { violationsAccessibilite } from "../../test/accessibilite";
import type { LotListe } from "./types";

/**
 * Ce que ces tests défendent :
 *
 * - un VRAI tableau (légende, en-têtes de colonne, en-tête de ligne) ;
 * - la sélection au clavier, et `aria-current` sur la seule ligne choisie ;
 * - le nom de fichier d'un tiers est du TEXTE (jamais une balise), même hostile ou démesuré ;
 * - un lot « schéma validé » ou rejeté n'a AUCUNE couleur de réussite, et `lignesImportees` n'est pas
 *   présenté comme une réussite ;
 * - sous 768 px, une liste de cartes avec la même information.
 */

// Doublure du badge : ne dépend pas du composant de l'autre agent, et dit ce qu'elle a reçu.
const renderStatut = vi.fn((lot: LotListe) => <span data-statut={lot.statut}>STATUT {lot.statut}</span>);

function props(over: Partial<ListeLotsProps> = {}): ListeLotsProps {
  return {
    lots: [lotListe()],
    total: 1,
    selectionId: null,
    onSelect: vi.fn(),
    onChargerPlus: vi.fn(),
    peutChargerPlus: false,
    chargementPlus: false,
    renderStatut,
    ...over,
  };
}

function simulerMobile(correspond: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((q: string) => ({
      matches: correspond, media: q, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  });
}

afterEach(() => {
  renderStatut.mockClear();
  // jsdom n'a pas matchMedia : le retirer remet l'état d'origine (rendu tableau).
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

describe("La liste est un vrai tableau", () => {
  it("a une légende, huit en-têtes de colonne et un en-tête de ligne par lot", () => {
    render(<ListeLots {...props({ lots: [lotListe(), lotListe({ id: "lot-2", reference: "IMP-2026-00002" })], total: 2 })} />);
    const t = screen.getByRole("table", { name: /Lots d'import reçus/ });
    const entetes = within(t).getAllByRole("columnheader").map((h) => h.textContent);
    expect(entetes).toEqual(["Référence", "Source", "Fichier", "Reçue le", "Par", "Statut", "Contrôle du schéma", "Actions"]);
    const lignes = within(t).getAllByRole("row");
    expect(lignes).toHaveLength(3); // en-tête + 2 lots
    expect(within(lignes[1]).getByRole("rowheader")).toHaveTextContent("IMP-2026-00001");
  });

  it("montre pour chaque lot la source, le fichier, la date, l'importateur, le statut fourni et le contrôle", () => {
    render(<ListeLots {...props()} />);
    const ligne = screen.getByRole("row", { name: /IMP-2026-00001/ });
    expect(within(ligne).getByText("ONR_BDR")).toBeInTheDocument();
    expect(within(ligne).getByText("rn1.csv")).toBeInTheDocument();
    expect(within(ligne).getByText("Tidiane Diallo")).toBeInTheDocument();
    expect(within(ligne).getByText("STATUT VALIDE_SCHEMA")).toBeInTheDocument();
    expect(within(ligne).getByText("8 conformes, 2 rejetées")).toBeInTheDocument();
    expect(within(ligne).getByRole("button", { name: /Voir le détail du lot IMP-2026-00001/ })).toBeInTheDocument();
    expect(renderStatut).toHaveBeenCalledWith(expect.objectContaining({ id: "lot-1", statut: "VALIDE_SCHEMA" }));
  });

  it("un importateur inconnu est dit non renseigné, pas laissé vide", () => {
    render(<ListeLots {...props({ lots: [lotListe({ importePar: null })] })} />);
    expect(screen.getByText("Non renseigné")).toBeInTheDocument();
  });

  it("sans lot : la phrase par défaut, ou l'état vide fourni par l'intégrateur", () => {
    const { rerender } = render(<ListeLots {...props({ lots: [], total: 0 })} />);
    expect(screen.getByText("Aucun lot à afficher.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    rerender(<ListeLots {...props({ lots: [], total: 0, renderVide: () => <p>ETAT VIDE RICHE</p> })} />);
    expect(screen.getByText("ETAT VIDE RICHE")).toBeInTheDocument();
  });
});

describe("Sélection au clavier et aria-current", () => {
  it("Entrée puis Espace sur le bouton d'une ligne sélectionnent ce lot", async () => {
    const onSelect = vi.fn();
    const u = userEvent.setup();
    render(<ListeLots {...props({ lots: [lotListe(), lotListe({ id: "lot-2", reference: "IMP-2026-00002" })], total: 2, onSelect })} />);
    await u.tab(); // région défilable du tableau
    await u.tab(); // premier bouton
    expect(screen.getByRole("button", { name: /IMP-2026-00001/ })).toHaveFocus();
    await u.keyboard("{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith("lot-1");
    await u.tab();
    expect(screen.getByRole("button", { name: /IMP-2026-00002/ })).toHaveFocus();
    await u.keyboard(" ");
    expect(onSelect).toHaveBeenLastCalledWith("lot-2");
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("seule la ligne choisie porte aria-current=\"true\", avec un fond et un liseré visibles", () => {
    const lots = [lotListe(), lotListe({ id: "lot-2", reference: "IMP-2026-00002" })];
    const { container } = render(<ListeLots {...props({ lots, total: 2, selectionId: "lot-2" })} />);
    const courants = container.querySelectorAll("[aria-current]");
    expect(courants).toHaveLength(1);
    expect(courants[0]).toHaveAttribute("aria-current", "true");
    expect(courants[0].tagName).toBe("TR");
    expect(courants[0]).toHaveTextContent("IMP-2026-00002");
    expect(courants[0].className).toMatch(/bg-blue-50/);
    expect(courants[0].querySelector("th")!.className).toMatch(/shadow-\[inset_4px/);
    // La couleur ne porte pas l'information seule : le lecteur d'écran l'entend sur le bouton.
    expect(within(courants[0] as HTMLElement).getByRole("button")).toHaveAccessibleName(/affiché/);
  });

  it("sans sélection, aucune ligne n'est « courante »", () => {
    const { container } = render(<ListeLots {...props({ selectionId: null })} />);
    expect(container.querySelectorAll("[aria-current]")).toHaveLength(0);
  });
});

describe("Pagination par « suivant »", () => {
  it("annonce « N lots sur M » et propose « Charger plus de lots »", async () => {
    const onChargerPlus = vi.fn();
    render(<ListeLots {...props({ lots: [lotListe(), lotListe({ id: "lot-2", reference: "IMP-2026-00002" })], total: 40, peutChargerPlus: true, onChargerPlus })} />);
    expect(screen.getByText("2 lots sur 40")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Charger plus de lots" }));
    expect(onChargerPlus).toHaveBeenCalledTimes(1);
  });

  it("dit « 1 lot sur 1 » au singulier et ne propose rien quand tout est chargé", () => {
    render(<ListeLots {...props({ total: 1, peutChargerPlus: false })} />);
    expect(screen.getByText("1 lot sur 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Charger plus/ })).not.toBeInTheDocument();
  });

  it("pendant le chargement, le bouton est inactif, occupé, et le dit", () => {
    render(<ListeLots {...props({ total: 40, peutChargerPlus: true, chargementPlus: true })} />);
    const b = screen.getByRole("button", { name: /Chargement des lots/ });
    expect(b).toBeDisabled();
    expect(b).toHaveAttribute("aria-busy", "true");
  });

  it("après « Charger plus », le focus va au premier lot ajouté", async () => {
    const u = userEvent.setup();
    const un = [lotListe()];
    const deux = [lotListe(), lotListe({ id: "lot-2", reference: "IMP-2026-00002" })];
    const { rerender } = render(<ListeLots {...props({ lots: un, total: 2, peutChargerPlus: true })} />);
    await u.click(screen.getByRole("button", { name: "Charger plus de lots" }));
    rerender(<ListeLots {...props({ lots: deux, total: 2, peutChargerPlus: false })} />);
    expect(screen.getByRole("button", { name: /IMP-2026-00002/ })).toHaveFocus();
  });
});

describe("Un nom de fichier d'un tiers est du texte", () => {
  it("une balise dans le nom n'est ni interprétée ni exécutée", () => {
    const nom = "<img src=x onerror=alert(1)>.csv";
    const { container } = render(<ListeLots {...props({ lots: [lotListe({ nomFichier: nom })] })} />);
    expect(screen.getByText(nom)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    // Dans le contenu, la balise est échappée ; dans l'attribut title, un « < » n'ouvre aucune balise.
    expect(container.innerHTML).toContain("&lt;img src=x onerror=alert(1)&gt;.csv</span>");
  });

  it("un nom démesuré est tronqué à l'écran (classe truncate) mais entier dans le DOM et l'infobulle", () => {
    const nom = `${"x".repeat(300)}.csv`;
    render(<ListeLots {...props({ lots: [lotListe({ nomFichier: nom })] })} />);
    const cellule = screen.getByText(nom);
    expect(cellule.className).toMatch(/truncate/);
    expect(cellule.className).toMatch(/max-w-/);
    expect(cellule.getAttribute("title")).toContain(nom);
  });

  it("les accents sont conservés", () => {
    render(<ListeLots {...props({ lots: [lotListe({ nomFichier: "Relevé_été_côtière.csv" })] })} />);
    expect(screen.getByText("Relevé_été_côtière.csv")).toBeInTheDocument();
  });

  it("un nom qui inverse le sens d'affichage (RLO) est rendu visible, pas obéi", () => {
    render(<ListeLots {...props({ lots: [lotListe({ nomFichier: "rapport‮fdp.exe" })] })} />);
    expect(screen.getByText("rapport⟨U+202E⟩fdp.exe")).toBeInTheDocument();
  });

  it("la taille en chaîne BigInt est lue sans perte dans l'infobulle", () => {
    render(<ListeLots {...props({ lots: [lotListe({ nomFichier: "gros.csv", tailleOctets: "9007199254740993" })] })} />);
    expect(screen.getByText("gros.csv").getAttribute("title")).toMatch(/To\)$/);
  });
});

describe("Aucune couleur de réussite pour un lot non appliqué", () => {
  const lots = [
    lotListe({ id: "lot-v", reference: "IMP-V", statut: "VALIDE_SCHEMA", lignesImportees: 8 }),
    lotListe({ id: "lot-r", reference: "IMP-R", statut: "REJETE", lignesLues: 0, lignesValidees: 0, lignesRejetees: 0, motifRejetLot: "CRS refusé : EPSG:32628" }),
  ];

  it("le statut est demandé à renderStatut pour chaque lot, sans que la liste le colore elle-même", () => {
    const { container } = render(<ListeLots {...props({ lots, total: 2 })} />);
    expect(renderStatut).toHaveBeenCalledTimes(2);
    expect(renderStatut.mock.calls.map(([l]) => l.statut)).toEqual(["VALIDE_SCHEMA", "REJETE"]);
    // La liste ne pose aucune classe verte : un vert se lirait comme « appliqué ».
    expect(container.innerHTML).not.toMatch(/green|emerald|teal|lime/);
  });

  it("lignesImportees n'apparaît nulle part comme résultat", () => {
    render(<ListeLots {...props({ lots, total: 2 })} />);
    expect(screen.queryByText(/importée/i)).not.toBeInTheDocument();
    expect(screen.getByText("8 conformes, 2 rejetées")).toBeInTheDocument();
  });

  it("un lot rejeté renvoie au détail pour son motif, sans le recopier ni inventer de compteur", () => {
    render(<ListeLots {...props({ lots, total: 2 })} />);
    const ligne = screen.getByRole("row", { name: /IMP-R/ });
    expect(within(ligne).getByText("Aucune ligne lue")).toBeInTheDocument();
    expect(within(ligne).getByText("Motif du rejet dans le détail du lot")).toBeInTheDocument();
    expect(screen.queryByText(/32628/)).not.toBeInTheDocument();
  });
});

describe("Sous 768 px : une liste de cartes, sans perte d'information", () => {
  it("rend des cartes (pas de tableau) avec les mêmes informations", async () => {
    simulerMobile(true);
    const onSelect = vi.fn();
    const { container } = render(<ListeLots {...props({ onSelect, selectionId: "lot-1" })} />);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    const liste = screen.getByRole("list", { name: /Lots d'import reçus/ });
    const [carte] = within(liste).getAllByRole("listitem");
    expect(carte).toHaveAttribute("aria-current", "true");
    for (const libelle of ["Source", "Fichier", "Reçue le", "Par", "Contrôle du schéma"]) {
      expect(within(carte).getByText(libelle)).toBeInTheDocument();
    }
    expect(within(carte).getByText("IMP-2026-00001")).toBeInTheDocument();
    expect(within(carte).getByText("rn1.csv")).toBeInTheDocument();
    expect(within(carte).getByText("Tidiane Diallo")).toBeInTheDocument();
    expect(within(carte).getByText("STATUT VALIDE_SCHEMA")).toBeInTheDocument();
    expect(within(carte).getByText("8 conformes, 2 rejetées")).toBeInTheDocument();
    // Aucune largeur minimale de tableau : rien ne force un défilement horizontal à 375 px.
    expect(container.innerHTML).not.toMatch(/min-w-\[52rem\]/);
    // Le nom du fichier et la référence se replient au lieu de déborder.
    expect(within(carte).getByText("rn1.csv").className).toMatch(/break-all/);
    expect(within(carte).getByText("IMP-2026-00001").className).toMatch(/break-all/);
    await userEvent.click(within(carte).getByRole("button", { name: /Voir le détail/ }));
    expect(onSelect).toHaveBeenCalledWith("lot-1");
  });

  it("un nom de fichier hostile reste du texte dans la carte", () => {
    simulerMobile(true);
    const nom = "<img onerror=alert(1)>.csv";
    const { container } = render(<ListeLots {...props({ lots: [lotListe({ nomFichier: nom })] })} />);
    expect(screen.getByText(nom)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("une seule des deux mises en page est dans le DOM : chaque référence n'y figure qu'une fois", () => {
    simulerMobile(false);
    render(<ListeLots {...props()} />);
    expect(screen.getAllByText("IMP-2026-00001")).toHaveLength(1);
  });
});

describe("Cibles tactiles et accessibilité", () => {
  it("chaque bouton a une hauteur minimale de 44 px", () => {
    render(<ListeLots {...props({ total: 40, peutChargerPlus: true })} />);
    for (const b of screen.getAllByRole("button")) expect(b.className).toMatch(/min-h-\[44px\]/);
  });

  it("axe : le tableau (lot validé, lot rejeté, lot sélectionné)", async () => {
    const lots = [lotListe(), lotListe({ id: "lot-r", reference: "IMP-R", statut: "REJETE", motifRejetLot: "CRS refusé" })];
    const { container } = render(<ListeLots {...props({ lots, total: 40, selectionId: "lot-1", peutChargerPlus: true })} />);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("axe : la liste de cartes", async () => {
    simulerMobile(true);
    const { container } = render(<ListeLots {...props({ lots: [lotListe(), lotListe({ id: "lot-2", reference: "IMP-2" })], total: 2, selectionId: "lot-2" })} />);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});
