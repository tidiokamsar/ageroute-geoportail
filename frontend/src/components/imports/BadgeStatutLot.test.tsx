import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import resolveConfig from "tailwindcss/resolveConfig";
import { ratioContraste } from "@/lib/contraste";
import { violationsAccessibilite } from "../../test/accessibilite";
import { BadgeStatutLot } from "./BadgeStatutLot";
import { descripteurStatut, STATUTS_LOT, TON_BANDEAU, TONS, type NomTon } from "./imports.noyau";

/**
 * Ce que ces tests defendent :
 *   - chaque statut se lit par une ICONE decorative, un TEXTE et un ton (jamais la couleur seule) ;
 *   - « Schéma validé : non appliqué » (en attente) n'est jamais vert ; seul « Importé » l'est ;
 *   - un statut inconnu est neutre et dit inconnu ;
 *   - CONTRASTE : chaque couple texte/fond de chaque ton atteint 4,5:1 (WCAG 1.4.3), chaque trait 3:1 (1.4.11), mesure sur les VRAIS jetons
 *     du CSS (tokens.css, index.css), et chaque classe Tailwind du noyau pointe bien sur le jeton annonce (sinon la mesure ne prouverait rien) ;
 *   - 0 violation axe-core (WCAG 2.1 A et AA, contraste exclu : jsdom ne le calcule pas, d'ou la mesure ci-dessus).
 */

afterEach(() => cleanup());

// ---- Lecture des jetons et de la config Tailwind ---------------------------------------------

const FRONT = path.resolve(__dirname, "../../..");

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

type Couleurs = { [k: string]: string | Couleurs };

/** `{ etat: { bon: { DEFAULT, fond } } }` -> `{ "etat-bon": ..., "etat-bon-fond": ... }`. */
function aplatir(couleurs: Couleurs, prefixe = "", sortie: Record<string, string> = {}): Record<string, string> {
  for (const [cle, valeur] of Object.entries(couleurs)) {
    const nom = cle === "DEFAULT" ? prefixe : prefixe ? `${prefixe}-${cle}` : cle;
    if (typeof valeur === "string") sortie[nom] = valeur;
    else aplatir(valeur, nom, sortie);
  }
  return sortie;
}

async function couleursTailwind(): Promise<Record<string, string>> {
  const mod = await import(/* @vite-ignore */ path.join(FRONT, "tailwind.config.js"));
  return aplatir(resolveConfig(mod.default).theme.colors as unknown as Couleurs);
}

/** Jeton (sans `--`) derriere une classe `text-*`, `bg-*` ou `border-*`, ou null. */
function jetonDeClasse(classe: string, couleurs: Record<string, string>): string | null {
  const nom = classe.replace(/^(text|bg|border)-/, "");
  const m = /^var\(--([a-z0-9-]+)\)$/.exec(couleurs[nom] ?? "");
  return m ? m[1] : null;
}

function hexDuJeton(jeton: string): string {
  const v = VARS[jeton];
  if (!v || !/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`Le jeton --${jeton} vaut "${v}", pas un hexadecimal lisible`);
  return v;
}

const CARTE = "card";

describe("contraste des tons (WCAG 1.4.3 texte 4,5:1, 1.4.11 trait 3:1)", () => {
  const tons = Object.values(TONS);

  it.each(tons.map((t) => [t.nom, t] as const))("ton %s : texte sur son fond, texte sur carte, trait sur carte", (_nom, ton) => {
    const texte = hexDuJeton(ton.jetons.texte);
    const fond = hexDuJeton(ton.jetons.fond);
    const trait = hexDuJeton(ton.jetons.trait);
    const carte = hexDuJeton(CARTE);
    expect(ratioContraste(texte, fond), `texte ${ton.jetons.texte} sur ${ton.jetons.fond}`).toBeGreaterThanOrEqual(4.5);
    expect(ratioContraste(texte, carte), `texte ${ton.jetons.texte} sur carte`).toBeGreaterThanOrEqual(4.5);
    expect(ratioContraste(trait, carte), `trait ${ton.jetons.trait} sur carte`).toBeGreaterThanOrEqual(3);
  });

  it("le bandeau de gouvernance : texte d'avertissement sur fond ambre, et sur carte (bouton au survol)", () => {
    const texte = hexDuJeton(TON_BANDEAU.jetons.texte);
    expect(ratioContraste(texte, hexDuJeton(TON_BANDEAU.jetons.fond))).toBeGreaterThanOrEqual(4.5);
    expect(ratioContraste(texte, hexDuJeton(CARTE))).toBeGreaterThanOrEqual(4.5);
    expect(ratioContraste(hexDuJeton(TON_BANDEAU.jetons.trait), hexDuJeton(CARTE))).toBeGreaterThanOrEqual(3);
  });

  it("les textes courants poses sur ces surfaces (corps, raison, panneau de regles, message d'erreur)", () => {
    const paires: [string, string][] = [
      ["foreground", "card"], ["muted-foreground", "card"], ["muted-foreground", "muted"], ["muted-foreground", "background"],
      ["foreground", TONS.echec.jetons.fond], ["foreground", TON_BANDEAU.jetons.fond],
    ];
    for (const [fg, bg] of paires) {
      expect(ratioContraste(hexDuJeton(fg), hexDuJeton(bg)), `${fg} sur ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("chaque classe Tailwind du noyau pointe sur le jeton annonce (la mesure porte sur ce qui est vraiment affiche)", async () => {
    const couleurs = await couleursTailwind();
    const ecarts: string[] = [];
    const verifier = (classes: string, attendu: { texte: string; fond?: string; trait: string }) => {
      for (const c of classes.split(/\s+/)) {
        const prefixe = c.split("-")[0] as "text" | "bg" | "border";
        const voulu = prefixe === "text" ? attendu.texte : prefixe === "bg" ? attendu.fond : attendu.trait;
        const reel = jetonDeClasse(c, couleurs);
        if (reel !== voulu) ecarts.push(`${c} -> ${reel ?? "inconnu"}, attendu ${voulu}`);
      }
    };
    for (const ton of Object.values(TONS)) {
      verifier(ton.classes.puce, ton.jetons);
      verifier(ton.classes.texte, ton.jetons);
      verifier(ton.classes.trait, ton.jetons);
    }
    verifier(TON_BANDEAU.classes.conteneur, TON_BANDEAU.jetons);
    expect(ecarts).toEqual([]);
  });

  it("aucune classe de ton n'est une teinte Tailwind brute : tout passe par un jeton du design system", async () => {
    const couleurs = await couleursTailwind();
    const classes = [...tons.flatMap((t) => Object.values(t.classes)), TON_BANDEAU.classes.conteneur].join(" ").split(/\s+/);
    for (const c of classes) expect(jetonDeClasse(c, couleurs), c).not.toBeNull();
  });

  it("contre-epreuve : une paire mauvaise est bien detectee par cette mesure", () => {
    // L'ancien gris de texte #9ca3af sur blanc : 2,54:1 (cf. styles/contraste.test.ts).
    expect(ratioContraste("#9ca3af", "#ffffff")).toBeLessThan(4.5);
    expect(ratioContraste(hexDuJeton("etat-moyen-texte"), hexDuJeton("etat-moyen-fond"))).toBeGreaterThan(5);
  });
});

describe("BadgeStatutLot", () => {
  const table: [string, string, NomTon][] = [
    ["RECU", "Reçu", "neutre"],
    ["VALIDE_SCHEMA", "Schéma validé : non appliqué", "attention"],
    ["IMPORTE_TEST", "Importé en test", "info"],
    ["IMPORTE", "Importé", "succes"],
    ["REJETE", "Rejeté", "echec"],
  ];

  it.each(table)("%s : texte, icone decorative et ton", (statut, libelle, ton) => {
    const { container } = render(<BadgeStatutLot statut={statut} />);
    const badge = container.firstElementChild as HTMLElement;
    expect(badge).toHaveTextContent(libelle);
    expect(badge).toHaveAttribute("data-statut", statut);
    expect(badge).toHaveAttribute("data-ton", ton);
    const icone = badge.querySelector("svg");
    expect(icone).not.toBeNull();
    expect(icone).toHaveAttribute("aria-hidden", "true");
    expect(icone).toHaveAttribute("focusable", "false");
    // Les classes du ton sont celles du noyau, ecrites en jetons.
    for (const c of TONS[ton].classes.puce.split(" ")) expect(badge).toHaveClass(c);
  });

  it("l'accessibilite se lit au texte : aucun role ni nom supplementaire, l'icone n'est pas annoncee", () => {
    render(<BadgeStatutLot statut="VALIDE_SCHEMA" />);
    expect(screen.getByText("Schéma validé : non appliqué")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("un lot « Schéma validé : non appliqué » n'est PAS vert ; seul « Importé » l'est", () => {
    const tonDe = (s: string) => render(<BadgeStatutLot statut={s} />).container.firstElementChild!.getAttribute("data-ton");
    const verts = STATUTS_LOT.filter((s) => { const r = tonDe(s) === "succes"; cleanup(); return r; });
    expect(verts).toEqual(["IMPORTE"]);
    render(<BadgeStatutLot statut="VALIDE_SCHEMA" />);
    const badge = screen.getByText("Schéma validé : non appliqué").parentElement!;
    expect(badge.className).not.toMatch(/etat-bon|green|emerald/);
    expect(badge).toHaveClass("bg-etat-moyen-fond");
  });

  it("un statut inconnu est neutre et dit « Statut inconnu : X », jamais en reussite", () => {
    render(<BadgeStatutLot statut="TERMINE_OK" />);
    const badge = screen.getByText("Statut inconnu : TERMINE_OK").parentElement!;
    expect(badge).toHaveAttribute("data-ton", "neutre");
    expect(badge.className).not.toMatch(/etat-bon/);
  });

  it("le code inconnu est echappe : du balisage est rendu en texte, pas en HTML", () => {
    const { container } = render(<BadgeStatutLot statut={'<img src=x onerror="alert(1)">'} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container).toHaveTextContent("Statut inconnu");
  });

  it("un long libelle peut passer a la ligne (aucun debordement) et accepte une classe de l'appelant", () => {
    const { container } = render(<BadgeStatutLot statut="VALIDE_SCHEMA" className="ml-j2" />);
    const badge = container.firstElementChild!;
    expect(badge).toHaveClass("max-w-full", "ml-j2");
    expect(within(badge as HTMLElement).getByText(/Schéma validé/)).toHaveClass("min-w-0");
  });

  it("descripteurs et rendu coherent : le texte affiche est le libelle du noyau", () => {
    for (const s of STATUTS_LOT) {
      const { container } = render(<BadgeStatutLot statut={s} />);
      expect(container).toHaveTextContent(descripteurStatut(s).libelle);
      cleanup();
    }
  });
});

describe("accessibilite (axe-core, WCAG 2.1 A et AA, contraste exclu)", () => {
  it("0 violation : les cinq statuts et un statut inconnu", async () => {
    const { container } = render(
      <ul>
        {[...STATUTS_LOT, "INCONNU"].map((s) => (
          <li key={s}><BadgeStatutLot statut={s} /></li>
        ))}
      </ul>,
    );
    expect(await violationsAccessibilite(container)).toEqual([]);
  });

  it("0 violation : badge seul", async () => {
    const { container } = render(<BadgeStatutLot statut="REJETE" />);
    expect(await violationsAccessibilite(container)).toEqual([]);
  });
});
