import axe from "axe-core";

/**
 * Mesure d'accessibilite a l'execution (paragraphe 7.11, WCAG 2.1 AA) par axe-core, sur le DOM
 * rendu dans les tests.
 *
 * CE QUE CETTE MESURE NE COUVRE PAS, ET QU'IL FAUT DIRE
 *
 * - Le CONTRASTE des couleurs : jsdom ne calcule ni styles en cascade ni rendu, la regle
 *   `color-contrast` y donnerait des resultats faux. Elle est desactivee ici, et le contraste
 *   reste a mesurer dans un navigateur reel.
 * - Tout ce qui demande un humain : ordre de lecture pertinent, clarte des libelles, usage au
 *   lecteur d'ecran. axe trouve une partie des defauts, pas leur absence.
 *
 * Les regles retenues sont celles des niveaux WCAG 2.0 / 2.1 A et AA.
 */
export async function violationsAccessibilite(conteneur: Element): Promise<string[]> {
  const r = await axe.run(conteneur, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  return r.violations.map((v) => `${v.id} (${v.impact}) : ${v.help} -- ${v.nodes.length} element(s) : ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")}`);
}
