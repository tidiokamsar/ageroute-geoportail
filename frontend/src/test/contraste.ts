import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import couleursTailwind from "tailwindcss/colors";

/**
 * Mesure STATIQUE du contraste des textes (WCAG 2.1, critère 1.4.3, niveau AA), faute de navigateur.
 *
 * POURQUOI STATIQUE. axe-core ne calcule pas le contraste sous jsdom (aucun rendu de couleur) : les
 * 8 écrans mesurés le 20/10 l'excluaient. Ici, on lit les classes Tailwind du code source : pour chaque
 * chaîne de classes, la couleur de texte et, si elle y est, la couleur de fond ; les valeurs viennent
 * de la palette RÉELLE (`tailwindcss/colors`, version installée) et des couleurs propres de
 * `tailwind.config.js`.
 *
 * LES RÈGLES, et leurs limites (dites, pas cachées) :
 *   - texte et fond dans la même chaîne : la paire est jugée ;
 *   - texte sans fond : jugé contre les deux fonds de page réels, blanc (cartes) et `--background`
 *     (lu dans `index.css`), et le PIRE des deux compte ; les variables de la charte (`bg-muted`,
 *     `text-muted-foreground`...) sont resolues depuis `index.css` ;
 *   - texte clair sans fond (luminance > 0,4 : blanc, gris 50 à 300...) : il est forcément posé sur
 *     un parent sombre que l'analyse ne voit pas, il est compté « non déterminé », pas jugé ;
 *   - variantes (`hover:`, `focus:`, `disabled:`, `dark:`...) et opacités (`/80`) : non jugées ;
 *   - grand texte (24 px, ou 18,66 px en gras ; ici `text-2xl` et plus, ou `text-xl` gras) : seuil 3:1,
 *     sinon 4,5:1.
 * Ce qui reste hors de portée : le fond hérité d'un parent, les couleurs posées en `style`, les
 * images. Seul un rendu en navigateur les mesurerait.
 */

/** Variables de la charte (`:root` de `index.css`), pour `bg-background`, `text-muted-foreground`... */
function variablesCharte(): Record<string, string> {
  const css = readFileSync(join(__dirname, "..", "index.css"), "utf8");
  const racine = css.slice(css.indexOf(":root"), css.indexOf("}", css.indexOf(":root")));
  const res: Record<string, string> = {};
  for (const m of racine.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) res[m[1]] = m[2];
  return res;
}

/** Les deux fonds de page reels : les cartes (blanc) et le fond de l'application (`--background`). */
function fondsPage(): Record<string, string> {
  return { blanc: "#ffffff", "--background": variablesCharte().background };
}

function couleursPropres(): Record<string, string> {
  const src = readFileSync(join(__dirname, "..", "..", "tailwind.config.js"), "utf8");
  const res: Record<string, string> = {};
  for (const m of src.matchAll(/^\s*'?([a-z][\w-]*)'?\s*:\s*'(#[0-9a-fA-F]{6})'/gm)) res[m[1]] = m[2];
  return res;
}

export function palette(): Record<string, string> {
  const p: Record<string, string> = { white: "#ffffff", black: "#000000" };
  for (const [nom, v] of Object.entries(couleursTailwind as unknown as Record<string, unknown>)) {
    if (v && typeof v === "object") {
      for (const [nuance, hex] of Object.entries(v as Record<string, string>)) if (/^#[0-9a-f]{6}$/i.test(hex)) p[`${nom}-${nuance}`] = hex;
    }
  }
  return { ...p, ...couleursPropres(), ...variablesCharte() };
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function ratio(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

export interface Constat { fichier: string; ligne: number; texte: string; fond: string; ratio: number; seuil: number }

const GRAND = /(^|\s)text-(2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)(\s|$)/;
const XL_GRAS = /(^|\s)text-xl(\s|$)/;
const GRAS = /(^|\s)font-(semibold|bold|extrabold|black)(\s|$)/;

function fichiers(rep: string): string[] {
  return readdirSync(rep).flatMap((n) => {
    const p = join(rep, n);
    if (statSync(p).isDirectory()) return n === "test" ? [] : fichiers(p);
    return /\.tsx$/.test(n) && !/\.test\.tsx$/.test(n) ? [p] : [];
  });
}

export function mesurer(racine = join(__dirname, "..")): { echecs: Constat[]; juges: number; nonDetermines: number } {
  const pal = palette();
  const FONDS_PAGE = fondsPage();
  const echecs: Constat[] = [];
  let juges = 0, nonDetermines = 0;
  for (const f of fichiers(racine)) {
    const lignes = readFileSync(f, "utf8").split("\n");
    lignes.forEach((l, i) => {
      for (const m of l.matchAll(/(["'`])((?:(?!\1).)*\btext-[a-z]+(?:-\d{2,3})?\b(?:(?!\1).)*)\1/g)) {
        const classes = m[2].split(/\s+/);
        const base = (prefixe: string) => classes.filter((c) => c.startsWith(prefixe) && !c.includes(":") && !c.includes("/")).map((c) => c.slice(prefixe.length)).filter((c) => pal[c]);
        const textes = base("text-");
        if (textes.length === 0) continue;
        const fonds = base("bg-");
        const seuil = GRAND.test(m[2]) || (XL_GRAS.test(m[2]) && GRAS.test(m[2])) ? 3 : 4.5;
        for (const t of textes) {
          const candidats = fonds.length > 0 ? fonds.map((b) => [b, pal[b]] as const) : luminance(pal[t]) > 0.4 ? [] : Object.entries(FONDS_PAGE);
          if (candidats.length === 0) { nonDetermines++; continue; }
          juges++;
          const pire = candidats.map(([nom, hex]) => ({ nom, r: ratio(pal[t], hex) })).sort((a, b) => a.r - b.r)[0];
          if (pire.r < seuil) echecs.push({ fichier: relative(racine, f).replace(/\\/g, "/"), ligne: i + 1, texte: t, fond: pire.nom, ratio: Math.round(pire.r * 100) / 100, seuil });
        }
      }
    });
  }
  return { echecs, juges, nonDetermines };
}
