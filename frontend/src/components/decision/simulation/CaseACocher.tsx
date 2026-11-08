import type { InputHTMLAttributes } from "react";

/**
 * Case a cocher dont la CIBLE TACTILE (le libelle enveloppant) mesure au moins 44 px sous 1280 px (WCAG 2.5.5, charte du projet) ;
 * la case elle-meme reste de 20 px. Le nom accessible vient de `aria-label` ou du `<label for>` de l'appelant.
 */
export function CaseACocher(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className">) {
  return (
    <label className="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center xl:min-h-0 xl:min-w-0">
      <input type="checkbox" className="h-5 w-5" {...props} />
    </label>
  );
}
