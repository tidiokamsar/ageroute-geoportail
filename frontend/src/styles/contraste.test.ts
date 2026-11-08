import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import resolveConfig from "tailwindcss/resolveConfig";
import { ratioContraste, estHex, hexVersRvb, luminance, surFond } from "@/lib/contraste";

/**
 * Garde-fou de contraste (WCAG 2.1 AA, paragraphe 7.11), sans navigateur.
 *
 * POURQUOI CE TEST EXISTE
 *
 * axe-core sous jsdom ne calcule pas la regle `color-contrast` (src/test/accessibilite.ts la
 * desactive), donc rien n'attrapait une teinte de palette modifiee « juste un peu ». Le contraste a ete
 * mesure une fois dans un navigateur reel le 23/10/2026 (docs/accessibilite/CONTRASTE.md) ; ce test
 * empeche le retour en arriere : il recalcule, a chaque execution, le rapport de chaque paire de
 * jetons de couleur du theme, et de chaque classe Tailwind de texte employee dans le code.
 *
 *   - Texte courant : 4,5:1 (WCAG 1.4.3).
 *   - Composants d'interface et anneau de focus : 3:1 (WCAG 1.4.11).
 *
 * CE QU'IL NE COUVRE PAS : une couleur ecrite en dur dans un `style={{ color: "#..." }}`, un fond
 * en degrade, un texte pose sur une photo ou sur les tuiles de la carte, le theme sombre. Cela reste
 * a mesurer dans un navigateur (voir le document). Un test statique ne prouve pas l'absence de defaut.
 */

const FRONT = path.resolve(__dirname, "../..");
const SEUIL_TEXTE = 4.5;
const SEUIL_COMPOSANT = 3;

// ---- Lecture des jetons ---------------------------------------------------

/** Variables CSS declarees dans les blocs `:root` (le theme sombre, `[data-theme]`, est exclu). */
function variablesRacine(css: string): Record<string, string> {
  const sansCommentaires = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const vars: Record<string, string> = {};
  for (const bloc of sansCommentaires.matchAll(/:root\s*\{([^}]*)\}/g)) {
    for (const d of bloc[1].matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) vars[d[1]] = d[2].trim();
  }
  return vars;
}

const VARS = {
  ...variablesRacine(fs.readFileSync(path.join(FRONT, "src/styles/tokens.css"), "utf8")),
  ...variablesRacine(fs.readFileSync(path.join(FRONT, "src/index.css"), "utf8")),
};

async function chargerConfig() {
  // Import par chemin variable : tailwind.config.js n'a pas de declaration de types (pas de allowJs).
  const chemin = path.join(FRONT, "tailwind.config.js");
  const mod = await import(/* @vite-ignore */ chemin);
  return resolveConfig(mod.default);
}

type Couleurs = Record<string, string | Record<string, string>>;

/** Nom de jeton, "famille-teinte" Tailwind ou hexadecimal litteral -> hexadecimal. */
function couleur(nom: string, theme: { colors: Couleurs }): string {
  if (nom.startsWith("#")) return nom;
  if (nom in VARS) {
    const v = VARS[nom];
    if (!estHex(v)) throw new Error(`Le jeton --${nom} vaut "${v}", pas un hexadecimal : le test ne sait pas le lire`);
    return v;
  }
  const m = nom.match(/^([a-z]+\d?)-(\d{2,3})$/);
  if (m) {
    const fam = theme.colors[m[1]];
    if (fam && typeof fam === "object" && fam[m[2]]) return fam[m[2]];
  }
  const direct = theme.colors[nom];
  if (typeof direct === "string") return direct;
  throw new Error(`Couleur inconnue : ${nom}`);
}

export type Paire = readonly [fg: string, bg: string, usage: string];

/** Retourne les paires sous le seuil, avec leur ratio. Vide = conforme. */
export function echecs(paires: readonly Paire[], seuil: number, theme: { colors: Couleurs }): string[] {
  const out: string[] = [];
  for (const [fg, bg, usage] of paires) {
    const r = ratioContraste(couleur(fg, theme), couleur(bg, theme));
    if (r < seuil) out.push(`${fg} (${couleur(fg, theme)}) sur ${bg} (${couleur(bg, theme)}) = ${r.toFixed(2)}:1 < ${seuil}:1 -- ${usage}`);
  }
  return out;
}

// ---- Paires de jetons ------------------------------------------------------

const ETATS = ["bon", "moyen", "mauvais", "critique", "inconnu"] as const;

/** Texte : un jeton de premier plan pose sur un jeton de fond. Seuil 4,5:1. */
const PAIRES_TEXTE: Paire[] = [
  ["foreground", "background", "texte courant sur le fond applicatif"],
  ["foreground", "card", "texte courant dans une carte"],
  ["card-foreground", "card", "texte de carte"],
  ["popover-foreground", "popover", "menus et popovers"],
  ["primary-foreground", "primary", "texte blanc sur bouton navy"],
  ["secondary-foreground", "secondary", "texte sur navy2"],
  ["accent-foreground", "accent", "texte navy sur bouton or (CTA)"],
  ["muted-foreground", "background", "texte discret sur le fond applicatif"],
  ["muted-foreground", "card", "texte discret dans une carte, placeholders"],
  ["muted-foreground", "muted", "texte discret sur surface attenuee"],
  ["primary", "background", "navy employe comme texte"],
  ["primary", "card", "navy employe comme texte dans une carte"],
  ["#ffffff", "destructive", "texte blanc sur bouton destructif"],
  ["destructive", "card", "texte destructif dans une carte"],
  ["sidebar-foreground", "sidebar", "libelles de la barre laterale"],
  ["sidebar-primary", "sidebar", "or sur navy, lien actif de la barre laterale"],
  ["sidebar-accent-foreground", "sidebar-accent", "element survole de la barre laterale"],
  ...ETATS.flatMap((e): Paire[] => [
    [`etat-${e}-texte`, `etat-${e}-fond`, `badge d'etat ${e}`],
    [`etat-${e}-texte`, "card", `texte d'etat ${e} dans une carte`],
    [`etat-${e}-texte`, "background", `texte d'etat ${e} sur le fond applicatif`],
  ]),
  ...(["succes", "avertissement", "danger", "info"] as const).flatMap((s): Paire[] => [
    [s, "card", `message ${s} dans une carte`],
    [s, "background", `message ${s} sur le fond applicatif`],
    [s, "muted", `message ${s} sur surface attenuee`],
  ]),
];

/** Composants : bordure de champ, anneau de focus, trait d'etat. Seuil 3:1 (WCAG 1.4.11). */
const PAIRES_COMPOSANT: Paire[] = [
  ["input", "card", "bordure de champ dans une carte"],
  ["input", "background", "bordure de champ sur le fond applicatif"],
  ["ring", "card", "anneau de focus sur carte"],
  ["ring", "background", "anneau de focus sur le fond applicatif"],
  ["ring", "muted", "anneau de focus sur surface attenuee"],
  ["sidebar-ring", "sidebar", "anneau de focus dans la barre laterale"],
  ...ETATS.flatMap((e): Paire[] => [
    [`etat-${e}-trait`, "card", `trait d'etat ${e} sur carte`],
    [`etat-${e}-trait`, "background", `trait d'etat ${e} sur le fond applicatif`],
  ]),
];

// ---- Classes Tailwind de texte employees dans le code ---------------------

const FAMILLES = "gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const FONDS_CLAIRS = ["#ffffff", "#f9fafb", "#f4f6f8", "#f3f4f6", "#eef1f4"];

function fichiersTsx(dossier: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dossier, { withFileTypes: true })) {
    const p = path.join(dossier, e.name);
    if (e.isDirectory()) fichiersTsx(p, out);
    else if (/\.tsx$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * `text-<famille>-<teinte>` : la teinte EFFECTIVE (palette Tailwind + surcharges de textColor dans
 * tailwind.config.js) doit tenir 4,5:1 sur les fonds clairs courants et sur le -50 de sa famille (le -100
 * pour les teintes 700 et plus, ou se posent les badges). Une teinte claire (luminance > 0,5, ex.
 * text-red-100) est supposee posee sur fond sombre : elle n'est pas jugee ici.
 */
export function echecsClasses(source: string, theme: { colors: Couleurs; textColor: Couleurs }): string[] {
  const vus = new Set<string>();
  const out: string[] = [];
  for (const m of source.matchAll(new RegExp(`(?<![:\\w-])text-(${FAMILLES})-(\\d{2,3})(?![\\d/])`, "g"))) {
    const cle = `${m[1]}-${m[2]}`;
    if (vus.has(cle)) continue;
    vus.add(cle);
    const bloc = theme.textColor[m[1]];
    const fg = bloc && typeof bloc === "object" ? bloc[m[2]] : undefined;
    if (!fg || !estHex(fg)) continue;
    if (luminance(hexVersRvb(fg)) > 0.5) continue; // texte clair : surface sombre supposee
    const fam = theme.colors[m[1]];
    const fonds = [...FONDS_CLAIRS];
    if (fam && typeof fam === "object") {
      if (fam["50"]) fonds.push(fam["50"]);
      if (Number(m[2]) >= 700 && fam["100"]) fonds.push(fam["100"]);
    }
    for (const bg of fonds) {
      const r = ratioContraste(fg, bg);
      if (r < SEUIL_TEXTE) out.push(`text-${cle} (${fg}) sur ${bg} = ${r.toFixed(2)}:1 < ${SEUIL_TEXTE}:1`);
    }
  }
  return out;
}

/**
 * Listes de classes ecrites dans le code : chaines "..." et '...', et gabarits `...` dont la part
 * statique est lue a part de leurs `${...}` (dont les chaines internes sont des listes separees).
 * Sans cette separation, `${a ? "bg-red-600 text-white" : "bg-amber-100 text-amber-800"}` se lirait comme
 * UNE liste portant les deux fonds, et signalerait un blanc sur ambre pale qui n'existe pas.
 */
function listesDeClasses(source: string): string[] {
  const listes: string[] = [];
  const classes = /^[A-Za-z0-9\s\-:/[\].%#()_!]+$/;
  const ajouter = (corps: string) => { if (classes.test(corps)) listes.push(corps); };
  const sansGabarits = source.replace(/`[^`\n]*`/g, (g) => {
    ajouter(g.slice(1, -1).replace(/\$\{[^}]*\}/g, " "));
    for (const expr of g.matchAll(/\$\{([^}]*)\}/g)) {
      for (const q of expr[1].matchAll(/(["'])([^"'\n]*)\1/g)) ajouter(q[2]);
    }
    return " ".repeat(g.length);
  });
  for (const q of sansGabarits.matchAll(/(["'])((?:(?!\1)[^\n\\])*)\1/g)) ajouter(q[2]);
  return listes;
}

/** `bg-<famille>-<teinte> ... text-white` dans une meme liste : le blanc doit tenir 4,5:1 sur l'aplat. */
export function echecsBlancSurAplat(source: string, theme: { colors: Couleurs }): string[] {
  const out: string[] = [];
  for (const c of listesDeClasses(source)) {
    if (!/(?<![:\w/-])text-white(?![\w/-])/.test(c)) continue;
    for (const m of c.matchAll(new RegExp(`(?<![:\\w-])bg-(${FAMILLES})-(\\d{2,3})(?![\\d/])`, "g"))) {
      const fam = theme.colors[m[1]];
      const bg = fam && typeof fam === "object" ? fam[m[2]] : undefined;
      if (!bg) continue;
      const r = ratioContraste("#ffffff", bg);
      if (r < SEUIL_TEXTE) out.push(`text-white sur bg-${m[1]}-${m[2]} (${bg}) = ${r.toFixed(2)}:1 < ${SEUIL_TEXTE}:1 -- ${c.slice(0, 80)}`);
    }
  }
  return out;
}

// ---- Les tests ------------------------------------------------------------

describe("contraste des jetons du theme (WCAG 1.4.3 et 1.4.11)", () => {
  it("chaque paire de jetons de texte atteint 4,5:1", async () => {
    const { theme } = await chargerConfig();
    expect(echecs(PAIRES_TEXTE, SEUIL_TEXTE, theme as never)).toEqual([]);
  });

  it("chaque paire de jetons de composant (bordure de champ, focus, trait d'etat) atteint 3:1", async () => {
    const { theme } = await chargerConfig();
    expect(echecs(PAIRES_COMPOSANT, SEUIL_COMPOSANT, theme as never)).toEqual([]);
  });

  it("le texte blanc a 60 % (text-white/60) tient 4,5:1 sur navy, navy2 et le degrade des cartes sombres", async () => {
    const { theme } = await chargerConfig();
    const fonds = [couleur("sidebar", theme as never), couleur("navy2", theme as never), "#1e3a5f"];
    const defauts = fonds
      .map((bg) => [bg, ratioContraste(surFond("#ffffff", 0.6, bg), bg)] as const)
      .filter(([, r]) => r < SEUIL_TEXTE)
      .map(([bg, r]) => `blanc a 60 % sur ${bg} = ${r.toFixed(2)}:1`);
    expect(defauts).toEqual([]);
  });

  it("les couleurs de marque servent bien de texte ou d'aplat avec la bonne paire", async () => {
    const { theme } = await chargerConfig();
    const marque: Paire[] = [
      ["#ffffff", "navy", "texte blanc sur navy"],
      ["#ffffff", "navy2", "texte blanc sur navy2"],
      ["navy", "gold", "texte navy sur or (bouton CTA)"],
      ["gold", "navy", "texte or sur navy"],
      ["navy", "background", "texte navy sur fond applicatif"],
    ];
    expect(echecs(marque, SEUIL_TEXTE, theme as never)).toEqual([]);
  });
});

describe("contraste des classes Tailwind employees dans le code", () => {
  it("aucune classe text-<teinte> du code ne tombe sous 4,5:1 sur les fonds clairs courants", async () => {
    const { theme } = await chargerConfig();
    const defauts: string[] = [];
    for (const f of fichiersTsx(path.join(FRONT, "src"))) {
      for (const e of echecsClasses(fs.readFileSync(f, "utf8"), theme as never)) defauts.push(`${path.relative(FRONT, f)} : ${e}`);
    }
    // Chaque classe n'est signalee qu'une fois PAR FICHIER : la liste dit ou corriger.
    expect(defauts).toEqual([]);
  });

  it("aucun text-white n'est pose sur un aplat bg-<teinte> de moins de 4,5:1", async () => {
    const { theme } = await chargerConfig();
    const defauts: string[] = [];
    for (const f of fichiersTsx(path.join(FRONT, "src"))) {
      for (const e of echecsBlancSurAplat(fs.readFileSync(f, "utf8"), theme as never)) defauts.push(`${path.relative(FRONT, f)} : ${e}`);
    }
    expect(defauts).toEqual([]);
  });
});

describe("contre-epreuve : le garde-fou echoue quand il le doit", () => {
  const theme = { colors: { gray: { "50": "#f9fafb" } } as Couleurs, textColor: {} as Couleurs };

  it("une paire volontairement mauvaise est detectee", () => {
    // #9ca3af sur blanc : l'ancien gris de texte, 2,54:1.
    const r = echecs([["#9ca3af", "#ffffff", "ancien text-gray-400"]], SEUIL_TEXTE, theme);
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("2.54:1");
  });

  it("une paire conforme n'est pas signalee", () => {
    expect(echecs([["#1f2937", "#ffffff", "texte courant"]], SEUIL_TEXTE, theme)).toEqual([]);
  });

  it("la palette Tailwind d'origine (sans les surcharges) est detectee comme defaillante", async () => {
    const { theme: reel } = await chargerConfig();
    const defaut = { colors: reel.colors as Couleurs, textColor: reel.colors as Couleurs };
    // text-gray-400 d'origine = #9ca3af ; text-amber-700 d'origine = #b45309 sur amber-100 : 4,43:1.
    const r = echecsClasses('<p className="text-gray-400">x</p> <b className="text-amber-700">y</b>', defaut);
    expect(r.some((l) => l.includes("text-gray-400"))).toBe(true);
    expect(r.some((l) => l.includes("text-amber-700"))).toBe(true);
  });

  it("un text-white sur bg-orange-400 (2,26:1) est detecte, sur bg-red-600 (4,83:1) non", async () => {
    const { theme: reel } = await chargerConfig();
    expect(echecsBlancSurAplat('<i className="bg-orange-400 text-white" />', reel as never)).toHaveLength(1);
    expect(echecsBlancSurAplat('<i className="bg-red-600 text-white" />', reel as never)).toEqual([]);
  });

  it("une classe de texte clair (fond sombre suppose) n'est pas jugee", async () => {
    const { theme: reel } = await chargerConfig();
    expect(echecsClasses('<i className="text-red-100" />', reel as never)).toEqual([]);
  });
});
