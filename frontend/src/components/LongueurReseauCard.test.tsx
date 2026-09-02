import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { LongueurReseauCard } from "./LongueurReseauCard";
import type { LongueurReseau } from "../types";

/**
 * Le tableau de bord affichait « 7 933 km — Reseau total ». C'etait la longueur SAISIE,
 * renseignee sur 662 troncons sur 1 690 : le champ est rempli integralement pour les
 * nationales et les urbaines, et pas du tout pour les 1 029 regionales, dont la
 * geometrie represente 13 296 km.
 *
 * Ces tests portent sur la regle qui compte : une valeur calculee ne doit jamais
 * pouvoir etre lue comme une valeur metier saisie.
 */

// Les chiffres reels de production au 01/09/2026.
const PRODUCTION: LongueurReseau = {
  metier: { totalKm: 7932.32, tronconsRenseignes: 662, tronconsTotal: 1690, couverturePct: 39.17 },
  geometrique: { totalKm: 21156.0, methode: "ST_Length(geom::geography)" },
  parClasse: [
    { classe: "RN", troncons: 621, tronconsAvecLongueurMetier: 621, kmMetier: 7840.12, kmGeometrique: 7823.55 },
    { classe: "RR", troncons: 1029, tronconsAvecLongueurMetier: 1, kmMetier: 56, kmGeometrique: 13296.41 },
    { classe: "RU", troncons: 40, tronconsAvecLongueurMetier: 40, kmMetier: 36.2, kmGeometrique: 36.04 },
  ],
};

describe("Longueur du réseau affichée", () => {
  it("montre les deux valeurs, jamais une seule", () => {
    render(<LongueurReseauCard reseau={PRODUCTION} />);

    expect(screen.getByText(/7\s*932|7\s*933/)).toBeInTheDocument();
    expect(screen.getByText(/21\s*156/)).toBeInTheDocument();
  });

  it("n'appelle jamais un chiffre « réseau total »", () => {
    const { container } = render(<LongueurReseauCard reseau={PRODUCTION} />);
    // C'est l'affirmation fausse d'origine : elle ne doit reapparaitre sous aucune forme.
    expect(container.textContent).not.toMatch(/réseau total/i);
    expect(container.textContent).not.toMatch(/linéaire total/i);
  });

  it("dit explicitement qu'une valeur est calculée", () => {
    render(<LongueurReseauCard reseau={PRODUCTION} />);
    expect(screen.getByText(/calculé depuis la géométrie/i)).toBeInTheDocument();
  });

  it("annonce la couverture réelle de la longueur saisie", () => {
    render(<LongueurReseauCard reseau={PRODUCTION} />);
    expect(screen.getByText(/662 tronçons sur 1690|662 tronçons sur 1 690/)).toBeInTheDocument();
    expect(screen.getByText(/39 %/)).toBeInTheDocument();
  });

  it("expose la méthode de calcul dans la ventilation", () => {
    render(<LongueurReseauCard reseau={PRODUCTION} />);
    fireEvent.click(screen.getByRole("button", { name: /ventilation/i }));

    expect(screen.getByText(/ST_Length\(geom::geography\)/)).toBeInTheDocument();
    expect(screen.getByText(/n'est écrite nulle part en base/i)).toBeInTheDocument();
  });

  it("signale la classe dont la longueur n'est presque jamais saisie", () => {
    render(<LongueurReseauCard reseau={PRODUCTION} />);
    fireEvent.click(screen.getByRole("button", { name: /ventilation/i }));

    const ligne = screen.getByText("Régionales").closest("tr")!;
    expect(within(ligne).getByText("1/1029")).toBeInTheDocument();
    // La cellule de longueur saisie doit porter la couleur d'alerte : 1 troncon sur 1 029.
    const cellules = ligne.querySelectorAll("td");
    expect(cellules[2].className).toMatch(/amber/);
  });

  it("ne signale pas les classes correctement renseignées", () => {
    render(<LongueurReseauCard reseau={PRODUCTION} />);
    fireEvent.click(screen.getByRole("button", { name: /ventilation/i }));

    const ligne = screen.getByText("Nationales").closest("tr")!;
    expect(ligne.querySelectorAll("td")[2].className).not.toMatch(/amber/);
  });

  it("masque la ventilation tant qu'on ne la demande pas", () => {
    render(<LongueurReseauCard reseau={PRODUCTION} />);
    expect(screen.queryByText("Régionales")).not.toBeInTheDocument();
  });

  it("n'affiche pas de valeur calculée quand il n'y a pas de géométrie", () => {
    const sansGeom: LongueurReseau = {
      metier: { totalKm: 100, tronconsRenseignes: 2, tronconsTotal: 2, couverturePct: 100 },
      geometrique: { totalKm: 0, methode: "ST_Length(geom::geography)" },
      parClasse: [{ classe: "RN", troncons: 2, tronconsAvecLongueurMetier: 2, kmMetier: 100, kmGeometrique: 0 }],
    };
    render(<LongueurReseauCard reseau={sansGeom} />);

    expect(screen.queryByText(/calculé depuis la géométrie/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /ventilation/i })).not.toBeInTheDocument();
  });

  it("ne casse pas sur un réseau vide", () => {
    const vide: LongueurReseau = {
      metier: { totalKm: 0, tronconsRenseignes: 0, tronconsTotal: 0, couverturePct: 0 },
      geometrique: { totalKm: 0, methode: "ST_Length(geom::geography)" },
      parClasse: [],
    };
    expect(() => render(<LongueurReseauCard reseau={vide} />)).not.toThrow();
  });
});
