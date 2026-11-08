// Configuration ESLint « plate » (ESLint 9) du frontend -- levee du blocage B-29.
//
// CE QUI EST RETENU, ET POURQUOI
//
// - `@eslint/js` recommande et `typescript-eslint` recommande (sans verification de types :
//   `tsc --noEmit` s'en charge deja, et la doubler ralentirait chaque passe).
// - Les deux regles DE FOND des hooks : `rules-of-hooks` (erreur) et `exhaustive-deps`
//   (avertissement). La configuration recommandee de eslint-plugin-react-hooks 7 ajoute une
//   quinzaine de regles du React Compiler ; le projet n'utilise pas ce compilateur, et ces regles
//   signaleraient des formes valides sans rapport avec un defaut.
// - `jsx-a11y` recommande : le controle statique d'accessibilite (paragraphe 7.11). Il ne
//   remplace pas la mesure a l'execution (axe-core, voir `src/test/accessibilite.ts`).
//
// eslint est fixe a la branche 9 : eslint-plugin-jsx-a11y 6.10.2 n'accepte pas eslint 10.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**", "public/**", "android/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      // `Input` et `Select` (components/ui/Input.tsx) rendent un <input> / <select> natif et
      // relaient toutes leurs proprietes : un libelle qui les imbrique ou les vise par `htmlFor`
      // est associe au sens HTML. La regle ne le sait pas sans qu'on le lui dise.
      "jsx-a11y/label-has-associated-control": ["error", { controlComponents: ["Input", "Select", "TronconPicker"], depth: 3 }],
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // Les variables prefixees par _ sont des omissions volontaires (destructuration).
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
    },
  },
  {
    // Les tests et le service worker vivent dans d'autres environnements.
    files: ["src/**/*.test.{ts,tsx}", "src/test/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
);
