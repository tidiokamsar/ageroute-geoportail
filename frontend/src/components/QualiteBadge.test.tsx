import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { QualiteBadge, qualiteDe, type QualiteChamp } from "./QualiteBadge";

/**
 * Le badge dit quel credit accorder a une valeur. Il ne doit jamais flatter la
 * realite : `revetement` vaut BITUME sur les 1 690 troncons sans exception, et aucun
 * des 647 etats connus ne porte de date de constat.
 */

const q = (p: Partial<QualiteChamp> = {}): QualiteChamp => ({
  champ: "revetement",
  statut: "IMPORTED_UNVERIFIED",
  libelle: "Importé — non vérifié",
  source: "IMPORT_INITIAL",
  methode: "IMPORT",
  observedAt: null,
  confiance: "LOW",
  note: null,
  douteuse: true,
  datee: false,
  ...p,
});

describe("Badge de qualité", () => {
  it("annonce qu'une valeur importée n'est pas vérifiée", () => {
    render(<QualiteBadge qualite={q()} />);
    expect(screen.getByText("Importé — non vérifié")).toBeInTheDocument();
  });

  it("signale un constat non daté, même quand il est marqué observé", () => {
    // Deux « BON » non dates ne sont pas comparables : le signaler compte autant que
    // le statut lui-meme.
    render(<QualiteBadge qualite={q({ champ: "etat", statut: "OBSERVED", libelle: "Constaté — date inconnue", datee: false })} />);
    expect(screen.getByText(/Constat non daté/i)).toBeInTheDocument();
  });

  it("ne signale pas de date manquante quand le constat est daté", () => {
    render(
      <QualiteBadge
        qualite={q({ champ: "etat", statut: "OBSERVED", libelle: "Constaté", datee: true, observedAt: "2026-08-15" })}
      />
    );
    expect(screen.queryByText(/Constat non daté/i)).not.toBeInTheDocument();
  });

  it("porte la source, la méthode et la note dans l'infobulle", () => {
    const { container } = render(
      <QualiteBadge qualite={q({ note: "Valeur unique sur les 1 690 tronçons." })} />
    );
    const titre = container.querySelector("[title]")!.getAttribute("title")!;
    expect(titre).toMatch(/IMPORT_INITIAL/);
    expect(titre).toMatch(/1 690/);
  });

  it("dit explicitement quand aucune date de constat n'existe", () => {
    const { container } = render(<QualiteBadge qualite={q()} />);
    expect(container.querySelector("[title]")!.getAttribute("title")).toMatch(/Aucune date de constat/);
  });

  it("n'affiche rien plutôt que d'inventer un statut", () => {
    // Absence de qualite n'est pas UNKNOWN : personne n'a encore regarde. Afficher
    // « non renseigne » serait une affirmation de plus que ce que l'on sait.
    const { container } = render(<QualiteBadge qualite={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("distingue visuellement le constaté du reste", () => {
    const { container: ok } = render(<QualiteBadge qualite={q({ statut: "OBSERVED", libelle: "Constaté", datee: true })} />);
    const { container: importe } = render(<QualiteBadge qualite={q()} />);
    const { container: contredit } = render(<QualiteBadge qualite={q({ statut: "CONFLICTING", libelle: "Contredit" })} />);

    expect(ok.innerHTML).toMatch(/emerald/);
    expect(importe.innerHTML).toMatch(/amber/);
    expect(contredit.innerHTML).toMatch(/red/);
  });

  it("retrouve la qualité d'un champ, et rend null quand elle manque", () => {
    const champs = [q({ champ: "revetement" }), q({ champ: "etat" })];
    expect(qualiteDe(champs, "etat")?.champ).toBe("etat");
    expect(qualiteDe(champs, "coutRehabEstime")).toBeNull();
    expect(qualiteDe(undefined, "etat")).toBeNull();
  });
});
