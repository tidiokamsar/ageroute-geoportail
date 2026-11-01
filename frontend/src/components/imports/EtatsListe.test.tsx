import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { violationsAccessibilite } from "../../test/accessibilite";
import { EtatChargement, EtatErreur, EtatVide } from "./EtatsListe";
import {
  AIDE_AUCUN_RESULTAT, MESSAGE_AUCUN_LOT, MESSAGE_AUCUN_RESULTAT, MESSAGE_ERREUR_DROITS, MESSAGE_ERREUR_LISTE,
} from "./imports.noyau";

/**
 * Ce que ces tests defendent (cahier AT-13 et AT-14) :
 *   - chargement, vide et erreur sont TROIS etats distincts, par le texte, par le role ARIA et par l'icone : une erreur n'est jamais
 *     lue comme « aucun lot » ;
 *   - le chargement est un squelette `role="status"` + `aria-busy`, dit au lecteur d'ecran, invisible pour lui hors texte ;
 *   - le vide dit le message du cahier ; avec des filtres actifs, il propose « Effacer les filtres » ;
 *   - l'erreur est un `role="alert"`, dit « La liste des lots n'a pas pu être chargée. » (403 : les droits), et « Réessayer » appelle la prop ;
 *   - le detail technique est nettoye (aucun signe de controle ni de sens), abrege, et rendu en texte ;
 *   - cibles tactiles >= 44 px ; 0 violation axe-core (WCAG 2.1 A et AA, contraste exclu : mesure dans BadgeStatutLot.test.tsx).
 */

afterEach(() => cleanup());

describe("EtatChargement", () => {
  it("un squelette role=status, aria-busy, avec un texte pour le lecteur d'ecran", () => {
    render(<EtatChargement />);
    const etat = screen.getByRole("status");
    expect(etat).toHaveAttribute("aria-busy", "true");
    expect(etat).toHaveAttribute("aria-live", "polite");
    expect(within(etat).getByText("Chargement de la liste des lots en cours.")).toBeInTheDocument();
  });

  it("les blocs du squelette sont masques aux technologies d'assistance et n'ont aucun texte", () => {
    const { container } = render(<EtatChargement lignes={3} />);
    const blocs = container.querySelectorAll("[aria-hidden=true]");
    expect(blocs).toHaveLength(3);
    for (const b of blocs) expect(b.textContent).toBe("");
  });

  it("le nombre de lignes est borne (1 a 10), 4 par defaut, et une valeur absurde ne casse rien", () => {
    const n = (lignes?: number) => { const r = render(<EtatChargement lignes={lignes} />); const k = r.container.querySelectorAll("[aria-hidden=true]").length; cleanup(); return k; };
    expect(n()).toBe(4);
    expect(n(0)).toBe(1);
    expect(n(99)).toBe(10);
    expect(n(Number.NaN)).toBe(4);
    expect(n(2.9)).toBe(2);
  });

  it("le libelle est personnalisable ; aucun bouton, aucun message de vide ni d'erreur", () => {
    render(<EtatChargement libelle="Chargement du lot en cours." />);
    expect(screen.getByText("Chargement du lot en cours.")).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(MESSAGE_AUCUN_LOT)).not.toBeInTheDocument();
  });

  it("l'animation du squelette respecte la preference de mouvement reduit", () => {
    const { container } = render(<EtatChargement />);
    for (const b of container.querySelectorAll(".animate-pulse, [class*='animate-pulse']")) expect(b.className).toContain("motion-safe:animate-pulse");
    expect(container.innerHTML).not.toMatch(/(^|\s)animate-pulse/);
  });
});

describe("EtatVide : aucun lot", () => {
  it("dit le message du cahier, mot pour mot, en un seul paragraphe", () => {
    render(<EtatVide />);
    expect(screen.getByText("Aucun lot reçu. Sélectionnez un fichier et renseignez les informations obligatoires pour commencer.")).toBeInTheDocument();
    expect(MESSAGE_AUCUN_LOT).toBe("Aucun lot reçu. Sélectionnez un fichier et renseignez les informations obligatoires pour commencer.");
  });

  it("un role=status, une icone decorative, aucun bouton, et ce n'est pas une alerte", () => {
    const { container } = render(<EtatVide />);
    expect(screen.getByRole("status")).toHaveAttribute("data-etat-liste", "vide");
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("EtatVide : aucun resultat pour ces filtres", () => {
  it("dit « aucun resultat », explique, et propose « Effacer les filtres »", () => {
    render(<EtatVide filtresActifs onEffacerFiltres={() => undefined} />);
    expect(screen.getByText(MESSAGE_AUCUN_RESULTAT)).toBeInTheDocument();
    expect(screen.getByText(AIDE_AUCUN_RESULTAT)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute("data-etat-liste", "aucun-resultat");
    expect(screen.getByRole("button", { name: "Effacer les filtres" })).toBeInTheDocument();
    // Ce n'est pas le message « aucun lot recu » : il y a des lots, les filtres les masquent.
    expect(screen.queryByText(MESSAGE_AUCUN_LOT)).not.toBeInTheDocument();
  });

  it("le bouton appelle la prop une fois par clic, a la souris et au clavier", async () => {
    const onEffacerFiltres = vi.fn();
    const user = userEvent.setup();
    render(<EtatVide filtresActifs onEffacerFiltres={onEffacerFiltres} />);
    await user.click(screen.getByRole("button", { name: "Effacer les filtres" }));
    expect(onEffacerFiltres).toHaveBeenCalledTimes(1);
    // Le clic a deja donne le focus au bouton : on repart de zero pour prouver l'acces au clavier.
    (document.activeElement as HTMLElement).blur();
    await user.tab();
    expect(screen.getByRole("button", { name: "Effacer les filtres" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onEffacerFiltres).toHaveBeenCalledTimes(2);
  });

  it("cible tactile d'au moins 44 px", () => {
    render(<EtatVide filtresActifs onEffacerFiltres={() => undefined} />);
    expect(screen.getByRole("button", { name: "Effacer les filtres" })).toHaveClass("min-h-cible");
  });

  it("sans filtres actifs, aucun bouton « Effacer les filtres » (rien a effacer)", () => {
    render(<EtatVide filtresActifs={false} />);
    expect(screen.queryByRole("button", { name: /effacer/i })).not.toBeInTheDocument();
  });
});

describe("EtatErreur", () => {
  it("role=alert, message distinct d'un vide, et dit que la liste n'est pas vide", () => {
    render(<EtatErreur onReessayer={() => undefined} />);
    const alerte = screen.getByRole("alert");
    expect(within(alerte).getByText("La liste des lots n'a pas pu être chargée.")).toBeInTheDocument();
    expect(alerte).toHaveTextContent(/Ce n'est pas une liste vide/);
    expect(alerte).toHaveAttribute("data-etat-liste", "erreur");
    expect(screen.queryByText(MESSAGE_AUCUN_LOT)).not.toBeInTheDocument();
    expect(screen.queryByText(MESSAGE_AUCUN_RESULTAT)).not.toBeInTheDocument();
    expect(MESSAGE_ERREUR_LISTE).toBe("La liste des lots n'a pas pu être chargée.");
  });

  it("« Réessayer » appelle la prop, une fois par clic, a la souris et au clavier, sans rien d'autre", async () => {
    const onReessayer = vi.fn();
    const user = userEvent.setup();
    render(<EtatErreur onReessayer={onReessayer} />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(onReessayer).toHaveBeenCalledTimes(1);
    (document.activeElement as HTMLElement).blur();
    await user.tab();
    expect(screen.getByRole("button", { name: "Réessayer" })).toHaveFocus();
    await user.keyboard(" ");
    expect(onReessayer).toHaveBeenCalledTimes(2);
  });

  it("cible tactile d'au moins 44 px", () => {
    render(<EtatErreur onReessayer={() => undefined} />);
    expect(screen.getByRole("button", { name: "Réessayer" })).toHaveClass("min-h-cible");
  });

  it.each([[403]])("%i : le profil n'a pas le droit, ce n'est ni un vide ni une panne", (statutHttp) => {
    render(<EtatErreur statutHttp={statutHttp} onReessayer={() => undefined} />);
    const alerte = screen.getByRole("alert");
    expect(within(alerte).getByText("Votre profil ne permet pas de consulter les lots d'import.")).toBeInTheDocument();
    expect(alerte).toHaveAttribute("data-etat-liste", "erreur-droits");
    expect(alerte).toHaveTextContent(/administrateur et gestionnaire/);
    expect(screen.queryByText(MESSAGE_ERREUR_LISTE)).not.toBeInTheDocument();
    expect(MESSAGE_ERREUR_DROITS).toBe("Votre profil ne permet pas de consulter les lots d'import.");
  });

  it.each([[500], [502], [503], [404], [401], [0], [null], [undefined]])("%j : « n'a pas pu être chargée »", (statutHttp) => {
    render(<EtatErreur statutHttp={statutHttp} onReessayer={() => undefined} />);
    expect(screen.getByRole("alert")).toHaveTextContent("La liste des lots n'a pas pu être chargée.");
    expect(screen.getByRole("alert")).not.toHaveTextContent("Votre profil");
  });

  it("le detail technique est affiche, en texte ; absent ou blanc, aucune ligne « Détail technique »", () => {
    const { rerender } = render(<EtatErreur detail="Délai dépassé (30 s)" onReessayer={() => undefined} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Détail technique : Délai dépassé (30 s)");
    for (const detail of [undefined, null, "", "   ", "‮​"]) {
      rerender(<EtatErreur detail={detail} onReessayer={() => undefined} />);
      expect(screen.getByRole("alert")).not.toHaveTextContent("Détail technique");
    }
  });

  it("le detail est nettoye, abrege a 200 signes et rendu en texte (aucun HTML)", () => {
    const { container } = render(<EtatErreur detail={'<img src=x onerror="alert(1)">‮' + "x".repeat(400)} onReessayer={() => undefined} />);
    expect(container.querySelector("img")).toBeNull();
    const detail = container.querySelector("p span")!.textContent!;
    expect(detail).not.toMatch(/‮/);
    expect(Array.from(detail).length).toBeLessThanOrEqual(200);
    expect(detail.endsWith("…")).toBe(true);
    expect(detail).toContain("<img src=x");
  });

  it("une relance en cours : bouton inactif, aria-busy, texte d'attente ; l'alerte reste affichee", () => {
    const onReessayer = vi.fn();
    render(<EtatErreur reessaiEnCours onReessayer={onReessayer} />);
    const b = screen.getByRole("button", { name: "Nouvelle tentative en cours" });
    expect(b).toBeDisabled();
    expect(b).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("l'icone est decorative", () => {
    const { container } = render(<EtatErreur onReessayer={() => undefined} />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});

describe("trois etats, trois lectures : jamais confondus", () => {
  it("roles et messages differents", () => {
    const { container: c1 } = render(<EtatChargement />);
    const { container: c2 } = render(<EtatVide />);
    const { container: c3 } = render(<EtatErreur onReessayer={() => undefined} />);
    const lectures = [c1, c2, c3].map((c) => ({
      role: c.firstElementChild!.getAttribute("role"),
      etat: c.firstElementChild!.getAttribute("data-etat-liste"),
      busy: c.firstElementChild!.getAttribute("aria-busy"),
    }));
    expect(lectures).toEqual([
      { role: "status", etat: "chargement", busy: "true" },
      { role: "status", etat: "vide", busy: null },
      { role: "alert", etat: "erreur", busy: null },
    ]);
    // Une seule des trois porte le mot « erreur » ou « n'a pas pu » ; une seule dit « Aucun lot reçu ».
    expect(c3.textContent).toMatch(/n'a pas pu/);
    expect(c2.textContent).not.toMatch(/n'a pas pu/);
    expect(c1.textContent).not.toMatch(/Aucun lot|n'a pas pu/);
    expect(c2.textContent).toMatch(/Aucun lot reçu/);
    expect(c3.textContent).not.toMatch(/Aucun lot reçu/);
  });

  it("aucun tiret cadratin ni emoji dans les trois etats", () => {
    render(<><EtatChargement /><EtatVide /><EtatVide filtresActifs onEffacerFiltres={() => undefined} /><EtatErreur statutHttp={403} detail="Refusé" onReessayer={() => undefined} /></>);
    const texte = document.body.textContent!;
    expect(texte).not.toMatch(/[–—]/);
    expect(texte).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("accessibilite (axe-core, WCAG 2.1 A et AA, contraste exclu)", () => {
  it("0 violation : chargement", async () => {
    const { container } = render(<EtatChargement />);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("0 violation : vide, sans filtres puis avec filtres", async () => {
    const { container } = render(<><EtatVide /><EtatVide filtresActifs onEffacerFiltres={() => undefined} /></>);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("0 violation : erreur generique, avec detail, 403, relance en cours", async () => {
    const { container } = render(
      <>
        <EtatErreur onReessayer={() => undefined} />
        <EtatErreur detail="Délai dépassé" onReessayer={() => undefined} />
        <EtatErreur statutHttp={403} onReessayer={() => undefined} />
        <EtatErreur reessaiEnCours onReessayer={() => undefined} />
      </>,
    );
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});
