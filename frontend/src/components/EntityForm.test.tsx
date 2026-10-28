import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { violationsAccessibilite } from "../test/accessibilite";

vi.mock("../lib/api", () => ({ api: { get: vi.fn(async () => ({ data: [] })) } }));

import { EntityForm, clientErrorMessage, type FieldConfig } from "./EntityForm";

/**
 * EntityForm : les erreurs de champ doivent être perceptibles sans la vue.
 *
 *   - le message NOMME le champ (« Le champ « Nom » est requis. ») ;
 *   - le champ en erreur porte aria-invalid et aria-describedby vers le message ;
 *   - le message est une alerte (role="alert"), annoncée à l'apparition ;
 *   - chaque étiquette est reliée à son champ (clic sur l'étiquette = focus du champ).
 */
const CHAMPS: FieldConfig[] = [
  { name: "nom", label: "Nom", type: "text", required: true },
  { name: "role", label: "Rôle", type: "select", required: true, options: [{ value: "A", label: "A" }] },
  { name: "commentaire", label: "Commentaire", type: "text" },
];

function rendre(props: Partial<React.ComponentProps<typeof EntityForm>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <EntityForm fields={CHAMPS} onSubmit={async () => {}} {...props} />
    </QueryClientProvider>,
  );
}

describe("EntityForm : erreurs accessibles", () => {
  it("un champ requis vide : message nommant le champ, aria-invalid, aria-describedby, role=alert", async () => {
    const u = userEvent.setup({ delay: null });
    rendre();
    await u.click(screen.getByRole("button", { name: "Enregistrer" }));

    const alertes = await screen.findAllByRole("alert");
    expect(alertes.map((a) => a.textContent)).toEqual([
      "Le champ « Nom » est requis.",
      "Le champ « Rôle » est requis.",
    ]);

    const nom = screen.getByLabelText("Nom");
    expect(nom).toHaveAttribute("aria-invalid", "true");
    expect(nom.getAttribute("aria-describedby")).toBe(alertes[0].id);
    // Un champ sans erreur n'est pas marqué invalide.
    expect(screen.getByLabelText("Commentaire")).not.toHaveAttribute("aria-invalid");
    expect(screen.getByLabelText("Commentaire")).not.toHaveAttribute("aria-describedby");
  });

  it("une erreur du serveur sur un champ porte les mêmes attributs", () => {
    rendre({ serverFieldErrors: { commentaire: ["Trop long (max 10)."] } });
    const champ = screen.getByLabelText("Commentaire");
    expect(champ).toHaveAttribute("aria-invalid", "true");
    const alerte = screen.getByRole("alert");
    expect(alerte).toHaveTextContent("Trop long (max 10).");
    expect(champ.getAttribute("aria-describedby")).toBe(alerte.id);
  });

  it("l'erreur globale du serveur est annoncée", () => {
    rendre({ serverError: "Conflit : ce code existe déjà." });
    expect(screen.getByRole("alert")).toHaveTextContent("Conflit : ce code existe déjà.");
  });

  it("n'a pas de violation d'accessibilité détectable, formulaire en erreur compris", async () => {
    const u = userEvent.setup({ delay: null });
    const { container } = rendre();
    await u.click(screen.getByRole("button", { name: "Enregistrer" }));
    await screen.findAllByRole("alert");
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});

describe("clientErrorMessage", () => {
  it("nomme le champ pour chaque règle connue et retombe sur « invalide » pour une règle inconnue", () => {
    expect(clientErrorMessage("Code", "minLength")).toBe("Le champ « Code » est trop court.");
    expect(clientErrorMessage("Code", "pattern")).toBe("Le champ « Code » a un format invalide.");
    expect(clientErrorMessage("Code", "validate")).toBe("Le champ « Code » est invalide.");
    expect(clientErrorMessage("Code")).toBe("Le champ « Code » est invalide.");
  });
});
