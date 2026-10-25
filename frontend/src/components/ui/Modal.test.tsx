import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Modal } from "./Modal";
import { violationsAccessibilite } from "../../test/accessibilite";

/**
 * Modal : garde anti-perte de saisie et bouton de fermeture.
 *
 *   - sans saisie en cours (`sale` faux ou absent), fermer ferme tout de suite ;
 *   - avec une saisie, fermer (croix, Echap) ouvre une confirmation INTERNE (plus de
 *     `window.confirm` natif) ; « Continuer la saisie » garde le formulaire, « Fermer sans
 *     enregistrer » ferme ;
 *   - un seul bouton « Fermer » : la croix standard du Dialog (en anglais) doublait celui de
 *     l'en-tête.
 */
function rendre(sale?: () => boolean) {
  const onClose = vi.fn();
  const vue = render(
    <Modal open onClose={onClose} title="Ajouter un élément" sale={sale}>
      <label>Nom<input /></label>
    </Modal>,
  );
  return { onClose, ...vue };
}

describe("Modal", () => {
  it("n'expose qu'un bouton « Fermer », pas de doublon « Close »", () => {
    rendre();
    expect(screen.getAllByRole("button", { name: "Fermer" })).toHaveLength(1);
    expect(screen.queryByText("Close")).not.toBeInTheDocument();
  });

  it("ferme sans demander quand rien n'a été saisi", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const u = userEvent.setup({ delay: null });
    const { onClose } = rendre(() => false);
    await u.click(screen.getByRole("button", { name: "Fermer" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("demande confirmation quand une saisie est en cours, sans fenêtre native", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const u = userEvent.setup({ delay: null });
    const { onClose } = rendre(() => true);
    await u.click(screen.getByRole("button", { name: "Fermer" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(await screen.findByText(/Des modifications n'ont pas été enregistrées/)).toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("« Continuer la saisie » garde le formulaire ouvert", async () => {
    const u = userEvent.setup({ delay: null });
    const { onClose } = rendre(() => true);
    await u.click(screen.getByRole("button", { name: "Fermer" }));
    await u.click(await screen.findByRole("button", { name: "Continuer la saisie" }));
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText(/Des modifications n'ont pas été enregistrées/)).not.toBeInTheDocument());
    expect(screen.getByLabelText("Nom")).toBeInTheDocument();
  });

  it("« Fermer sans enregistrer » ferme", async () => {
    const u = userEvent.setup({ delay: null });
    const { onClose } = rendre(() => true);
    await u.click(screen.getByRole("button", { name: "Fermer" }));
    await u.click(await screen.findByRole("button", { name: "Fermer sans enregistrer" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Echap passe aussi par la confirmation", async () => {
    const u = userEvent.setup({ delay: null });
    const { onClose } = rendre(() => true);
    await u.keyboard("{Escape}");
    expect(await screen.findByText(/Des modifications n'ont pas été enregistrées/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("n'a pas de violation d'accessibilité détectable", async () => {
    rendre();
    expect(await violationsAccessibilite(document.body)).toEqual([]);
  });
});
