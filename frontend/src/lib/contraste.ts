/**
 * Calcul de contraste WCAG 2.1 (1.4.3 texte 4,5:1, 1.4.11 composants 3:1).
 *
 * Formule de la norme : luminance relative de chaque couleur sRGB, puis
 * (L1 + 0,05) / (L2 + 0,05) avec L1 la plus claire. Pas de dependance : c'est une page de calcul,
 * et le meme module sert a l'interface (KpiCard) et aux tests de garde-fou
 * (src/styles/contraste.test.tsx), donc ils ne peuvent pas diverger.
 */

export type RVB = [number, number, number];

/** Vrai pour "#rgb" et "#rrggbb" : seules formes que ce module sait lire. */
export function estHex(c: string): boolean {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c.trim());
}

/** "#rgb" ou "#rrggbb" vers [r, g, b] (0-255). Leve une erreur sur toute autre forme. */
export function hexVersRvb(hex: string): RVB {
  const m = hex.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) throw new Error(`Couleur hexadecimale attendue, recu "${hex}"`);
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function rvbVersHex([r, g, b]: RVB): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Luminance relative WCAG (0 noir, 1 blanc). */
export function luminance([r, g, b]: RVB): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Rapport de contraste entre deux couleurs hexadecimales, de 1 a 21. */
export function ratioContraste(a: string, b: string): number {
  const la = luminance(hexVersRvb(a));
  const lb = luminance(hexVersRvb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Superpose une couleur de transparence `alpha` (0-1) sur un fond opaque. */
export function surFond(fg: string, alpha: number, bg: string): string {
  const f = hexVersRvb(fg);
  const b = hexVersRvb(bg);
  return rvbVersHex([0, 1, 2].map((i) => f[i] * alpha + b[i] * (1 - alpha)) as RVB);
}

/**
 * Assombrit `couleur` (en gardant sa teinte) jusqu'a ce qu'elle atteigne `ratioMin` sur `fond`.
 * Une couleur deja assez contrastee est rendue telle quelle. Sert a poser en TEXTE une couleur
 * d'accent choisie pour un aplat (barre, pastille) : l'accent reste reconnaissable, le chiffre
 * devient lisible.
 */
export function assombrirPour(couleur: string, fond = "#ffffff", ratioMin = 4.5): string {
  if (ratioContraste(couleur, fond) >= ratioMin) return couleur;
  const [r, g, b] = hexVersRvb(couleur);
  // On mele progressivement au noir : monotone, la teinte relative est conservee.
  for (let t = 0.02; t <= 1.0001; t += 0.02) {
    const c = rvbVersHex([r * (1 - t), g * (1 - t), b * (1 - t)]);
    if (ratioContraste(c, fond) >= ratioMin) return c;
  }
  return "#000000";
}
