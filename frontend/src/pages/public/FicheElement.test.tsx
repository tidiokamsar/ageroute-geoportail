import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FicheElement } from "./FicheElement";
import type { PublicTroncon } from "./types";

/**
 * Fiche publique d'un troncon.
 *
 * Deux defauts que la promotion de la voirie de Kaloum a reveles, et que ces tests
 * verrouillent :
 *
 * La longueur s'affichait brute. Les 1 690 troncons importes portaient des nombres
 * ronds, le defaut restait invisible ; les longueurs calculees sur la geometrie l'ont
 * montre — « 1.2219212507954644 km ».
 *
 * L'etat s'affichait sans sa provenance. « Bon etat general » declare par un
 * gestionnaire et « bon etat general » constate en inspection donnaient la meme
 * pastille verte. Pour un citoyen, la fiche parlait au nom d'AGEROUTE.
 */

function troncon(p: Partial<PublicTroncon> = {}): PublicTroncon {
  return {
    id: "t1", code: "KALOUM-OSM-w38698087", nom: "5e Avenue", classe: "RU",
    etat: "BON", longueurKm: 1.2219212507954644, region: "Conakry",
    geometry: null, ...p,
  };
}

function afficher(t: PublicTroncon) {
  return render(
    <FicheElement feature={{ kind: "troncon", data: t }} onClose={vi.fn()} />,
  );
}

describe("La longueur est lisible", () => {
  it("arrondit au centieme au-dela du kilometre", () => {
    afficher(troncon());
    expect(screen.getByText("1,22 km")).toBeInTheDocument();
    expect(screen.queryByText(/1\.2219212507954644/)).toBeNull();
  });

  it("passe au metre en dessous du kilometre — une desserte de 145 m n'est pas 0,14 km", () => {
    afficher(troncon({ longueurKm: 0.1452 }));
    expect(screen.getByText("145 m")).toBeInTheDocument();
  });

  it("ne fabrique pas de nombre quand la valeur est absurde", () => {
    afficher(troncon({ longueurKm: Number.NaN }));
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

describe("Un etat declare ne se lit pas comme un etat constate", () => {
  it("marque l'etat et l'explique quand il est declare", () => {
    afficher(troncon({ etatDeclare: true }));
    expect(screen.getByText("déclaré")).toBeInTheDocument();
    expect(screen.getByText(/n'a pas fait l'objet d'un relevé de terrain/i))
      .toBeInTheDocument();
  });

  it("ne dit rien de la provenance quand on ne sait rien", () => {
    // L'absence de ligne de qualite ne vaut pas verification : elle ne dit rien.
    // Les 1 690 troncons anterieurs ne doivent donc porter aucune mention.
    afficher(troncon());
    expect(screen.queryByText("déclaré")).toBeNull();
    expect(screen.queryByText(/relevé de terrain/i)).toBeNull();
  });

  it("affiche toujours l'etat lui-meme", () => {
    afficher(troncon({ etatDeclare: true }));
    expect(screen.getByText(/bon état/i)).toBeInTheDocument();
  });
});
