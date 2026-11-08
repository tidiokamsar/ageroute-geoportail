import { useCallback, useRef } from "react";

/**
 * Restitution du focus apres un dialogue. Le dialogue Radix du projet est monte par son parent (pas de declencheur Radix) : a sa fermeture, rien ne
 * rend le focus. Sans cela, un utilisateur au clavier retombe en tete de page. On memorise l'element actif a l'ouverture et on le retablit ; s'il a
 * disparu ou est devenu inactif (une transition acceptee change la liste des boutons), on replie sur l'element `idRepli` (le titre de la fiche).
 */
export function useRestitutionFocus(idRepli?: string) {
  const origine = useRef<HTMLElement | null>(null);
  const memoriser = useCallback(() => {
    origine.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  }, []);
  const restituer = useCallback(() => {
    const el = origine.current;
    origine.current = null;
    // Apres le demontage du dialogue (Radix rend le focus a <body> dans un setTimeout 0).
    setTimeout(() => {
      if (el && el.isConnected && !(el as HTMLButtonElement).disabled) el.focus();
      else if (idRepli) document.getElementById(idRepli)?.focus();
    }, 10);
  }, [idRepli]);
  return { memoriser, restituer };
}
