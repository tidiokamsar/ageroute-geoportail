/**
 * Erreur metier du module Projets de voirie : porte le statut HTTP, le `code` stable du contrat et des champs
 * supplementaires (`jeuId`, `statut`...) rendus tels quels dans le corps `{ error, code, ... }`.
 */
export class ErreurMetier extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ErreurMetier";
  }
}

export const introuvable = (quoi: string, code: string) => new ErreurMetier(404, code, `${quoi} introuvable`);
