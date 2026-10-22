import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CurseurTemporel } from "./CurseurTemporel";
import type { Chronologie, EtatCurseur, ReponseCurseur } from "../../lib/curseur";
import type { EtatCouchePortions } from "./PortionsDateLayer";

/**
 * Le panneau du curseur temporel : ce que ces tests defendent.
 *
 *   - eteint, il n'engage rien et dit ce qu'il fera ;
 *   - allume, il propose des dates au jour pres, JAMAIS apres aujourd'hui ;
 *   - un ecran vide DIT pourquoi (aucune date d'effet saisie nulle part, ou rien a cette date) ;
 *   - ce que la vue ecarte (propositions, versions remplacees, recouvrements) est enonce ;
 *   - la legende ne cite que les etats REELLEMENT presents, avec leur motif de trait.
 */

const AUJ = "2026-10-22";
const chrono: Chronologie = { total: 10, avecDateEffet: 6, sansDateEffet: 4, premiere: "2026-01-01", derniere: "2026-08-01", parMois: [] };
const eteint: EtatCurseur = { actif: false, date: AUJ, connu: null, inclureAValider: false };
const allume: EtatCurseur = { actif: true, date: "2026-03-15", connu: null, inclureAValider: false };

function reponse(partiel: Partial<ReponseCurseur> = {}): ReponseCurseur {
  return {
    dateTerrain: "2026-03-15", connuLe: null, inclureAValider: false, tronque: false, plafond: 5000,
    comptes: { retenues: 0, aValiderEcartees: 0, sansDateEffet: 0, datesIncoherentes: 0, remplaceesSansFin: 0, ambigues: 0 },
    longueurCouverteM: 0, portions: [], ...partiel,
  };
}
const portion = (etat: string | null, etatLibelle: string | null) => ({
  id: `p-${etat}`, tronconId: "t", tronconCode: "GN N0001", tronconNom: "x", debutM: 0, finM: 500, longueurM: 500,
  revetement: null, etat, etatLibelle, praticabilite: null, largeurM: null, source: null, confiance: null, observeeLe: null,
  valideDu: "2026-01-01", valideAu: null, enregistreLe: "2026-01-10T08:00:00Z", statut: "VALIDE" as const, ambigue: false, geometry: null,
});
const couche = (p: Partial<EtatCouchePortions> = {}): EtatCouchePortions => ({ zoomSuffisant: true, chargement: false, reponse: null, erreur: null, ...p });

function rendre(over: Partial<React.ComponentProps<typeof CurseurTemporel>> = {}) {
  const onChange = vi.fn();
  const r = render(<CurseurTemporel etat={allume} onChange={onChange} chronologie={chrono} couche={couche()} auj={AUJ} {...over} />);
  return { onChange, ...r };
}

describe("eteint", () => {
  it("n'engage rien, et dit ce qu'il fera", () => {
    rendre({ etat: eteint });
    expect(screen.getByLabelText("Voir le réseau à une date")).not.toBeChecked();
    expect(screen.getByText(/Montre l'état des portions tel qu'il était vrai sur le terrain/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Date de terrain/)).not.toBeInTheDocument();
  });
  it("s'allume sur la date du jour", async () => {
    const { onChange } = rendre({ etat: { ...eteint, date: "" } });
    await userEvent.click(screen.getByLabelText("Voir le réseau à une date"));
    expect(onChange).toHaveBeenCalledWith({ actif: true, date: AUJ, connu: null, inclureAValider: false });
  });
  it("s'eteint en conservant la date choisie", async () => {
    const { onChange } = rendre();
    await userEvent.click(screen.getByLabelText("Voir le réseau à une date"));
    expect(onChange).toHaveBeenCalledWith({ ...allume, actif: false });
  });
});

describe("allume : les dates", () => {
  it("le curseur va de la premiere date d'effet a aujourd'hui, et dit la date en toutes lettres", () => {
    rendre();
    const g = screen.getByLabelText(/Date de terrain/) as HTMLInputElement;
    expect(g.type).toBe("range");
    expect(g.min).toBe("0");
    expect(g.max).toBe("294"); // 1er janvier -> 22 octobre
    expect(g.getAttribute("aria-valuetext")).toBe("15 mars 2026");
    expect(screen.getByLabelText(/Date de terrain/).closest("div")).toHaveTextContent("1er janvier 2026");
  });

  it("le champ de date est borne : jamais au-dela d'aujourd'hui", () => {
    rendre();
    const d = screen.getByLabelText("Aller à une date") as HTMLInputElement;
    expect(d.min).toBe("2026-01-01");
    expect(d.max).toBe(AUJ);
  });

  it("une date saisie est appliquee tout de suite", () => {
    const { onChange } = rendre();
    fireEvent.change(screen.getByLabelText("Aller à une date"), { target: { value: "2026-06-30" } });
    expect(onChange).toHaveBeenCalledWith({ ...allume, date: "2026-06-30" });
  });

  it("refuse une date future saisie a la main", () => {
    const { onChange } = rendre();
    fireEvent.change(screen.getByLabelText("Aller à une date"), { target: { value: "2026-12-31" } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("les boutons decalent d'un mois et restent dans les bornes", async () => {
    const { onChange } = rendre();
    await userEvent.click(screen.getByRole("button", { name: "+ 1 mois" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...allume, date: "2026-04-14" });
    // On decale depuis la date AFFICHEE (14/04), pas depuis celle du parent : retour au 15/03.
    await userEvent.click(screen.getByRole("button", { name: "− 1 mois" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...allume, date: "2026-03-15" });
    await userEvent.click(screen.getByRole("button", { name: "− 1 mois" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...allume, date: "2026-02-13" });
  });

  it("« Aujourd'hui » ramene a la borne haute", async () => {
    const { onChange } = rendre();
    await userEvent.click(screen.getByRole("button", { name: "Aujourd'hui" }));
    expect(onChange).toHaveBeenCalledWith({ ...allume, date: AUJ });
  });

  it("le glissement ne relance pas le chargement a chaque jour traverse : un seul appel, apres un delai", async () => {
    const { onChange } = rendre();
    const g = screen.getByLabelText(/Date de terrain/);
    fireEvent.change(g, { target: { value: "10" } });
    fireEvent.change(g, { target: { value: "20" } });
    fireEvent.change(g, { target: { value: "30" } });
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1), { timeout: 1500 });
    expect(onChange).toHaveBeenCalledWith({ ...allume, date: "2026-01-31" });
  });

  it("sans aucune date d'effet, le curseur existe quand meme (un an) pour pouvoir s'expliquer", () => {
    rendre({ chronologie: { ...chrono, avecDateEffet: 0, sansDateEffet: 3, total: 3, premiere: null } });
    const g = screen.getByLabelText(/Date de terrain/) as HTMLInputElement;
    expect(g.max).toBe("365");
  });
});

describe("allume : les options", () => {
  it("les propositions se demandent explicitement", async () => {
    const { onChange } = rendre();
    const c = screen.getByLabelText(/Inclure les propositions non validées/);
    expect(c).not.toBeChecked();
    await userEvent.click(c);
    expect(onChange).toHaveBeenCalledWith({ ...allume, inclureAValider: true });
  });

  it("« ce que l'on savait » : une date de systeme, bornee, et un retour a aujourd'hui", async () => {
    const { onChange, rerender } = rendre();
    const champ = screen.getByLabelText("Tel que connu le") as HTMLInputElement;
    expect(champ.max).toBe(AUJ);
    fireEvent.change(champ, { target: { value: "2026-04-01" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...allume, connu: "2026-04-01" });

    rerender(<CurseurTemporel etat={{ ...allume, connu: "2026-04-01" }} onChange={onChange} chronologie={chrono} couche={couche()} auj={AUJ} />);
    await userEvent.click(screen.getByRole("button", { name: /Revenir à ce que l'on sait aujourd'hui/ }));
    expect(onChange).toHaveBeenLastCalledWith({ ...allume, connu: null });
  });

  it("le panneau « ce que l'on savait » est ouvert quand l'axe systeme est utilise", () => {
    const { container } = rendre({ etat: { ...allume, connu: "2026-04-01" } });
    expect(container.querySelector("details")).toHaveAttribute("open");
  });
});

describe("allume : ce que l'ecran dit", () => {
  it("aucune date d'effet nulle part : le DIT, et ou la saisir", () => {
    rendre({ chronologie: { ...chrono, avecDateEffet: 0, sansDateEffet: 5, total: 5, premiere: null }, couche: couche({ reponse: reponse() }) });
    expect(screen.getByText(/Aucune portion ne porte de date d'effet/)).toBeInTheDocument();
    expect(screen.getByText(/Portions terrain/)).toBeInTheDocument();
  });

  it("des dates existent mais rien ici : ce n'est ni « bon » ni « vide »", () => {
    rendre({ couche: couche({ reponse: reponse() }) });
    expect(screen.getByText(/Ce n'est pas un état « bon » ni « vide »/)).toBeInTheDocument();
  });

  it("resume ce que la vue montre, et seulement cela", () => {
    rendre({ couche: couche({ reponse: reponse({ portions: [portion("BON", "Bon"), portion("MAUVAIS", "Mauvais")], longueurCouverteM: 1000 }) }) });
    expect(screen.getByText("2 portions vraies le 15 mars 2026, soit 1,0 km qualifiés.")).toBeInTheDocument();
  });

  it("enonce ce qui est ecarte : propositions, recouvrements, versions remplacees, troncature", () => {
    rendre({
      couche: couche({
        reponse: reponse({
          tronque: true, portions: [portion("BON", "Bon")], longueurCouverteM: 500,
          comptes: { retenues: 1, aValiderEcartees: 2, sansDateEffet: 0, datesIncoherentes: 0, remplaceesSansFin: 1, ambigues: 2 },
        }),
      }),
    });
    const liste = screen.getByLabelText("Ce que cette vue ne montre pas");
    expect(within(liste).getByText(/tronqué à 5.000 portions/)).toBeInTheDocument();
    expect(within(liste).getByText(/2 propositions non validées ne sont pas montrées/)).toBeInTheDocument();
    expect(within(liste).getByText(/2 portions se recouvrent/)).toBeInTheDocument();
    expect(within(liste).getByText(/1 version remplacée sans date de fin n'est pas montrée/)).toBeInTheDocument();
    expect(within(liste).getByText(/4 portions du réseau n'ont pas de date d'effet/)).toBeInTheDocument();
  });

  it("dit qu'il faut zoomer quand l'emprise serait trop large", () => {
    rendre({ couche: couche({ zoomSuffisant: false }) });
    expect(screen.getByText(/Zoomez \(niveau 9 ou plus\)/)).toBeInTheDocument();
  });

  it("montre le chargement et l'erreur du serveur avec son message", () => {
    rendre({ couche: couche({ chargement: true, erreur: "L'emprise depasse 5 degres de cote." }) });
    expect(screen.getByText("Chargement…")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("L'emprise depasse 5 degres de cote.");
  });

  it("la legende ne cite que les etats REELLEMENT presents, plus le trace de reference", () => {
    rendre({ couche: couche({ reponse: reponse({ portions: [portion("BON", "Bon"), portion("BON", "Bon"), portion("CRITIQUE", "Critique")], longueurCouverteM: 100 }) }) });
    const legende = screen.getByLabelText("Légende du curseur temporel");
    const items = within(legende).getAllByRole("listitem").map((l) => l.textContent);
    expect(items).toEqual(["Bon", "Critique", "Tracé de référence : aucune portion connue à cette date"]);
  });

  it("rappelle que les couleurs des troncons sont desactivees et qu'il n'y a pas de dates futures", () => {
    rendre();
    expect(screen.getByText(/couleurs des tronçons sont désactivées/)).toBeInTheDocument();
    expect(screen.getByText(/dates futures ne sont pas proposées/)).toBeInTheDocument();
  });
});
