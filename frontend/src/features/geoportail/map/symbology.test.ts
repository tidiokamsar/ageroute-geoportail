import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  ORDRE_ETATS, SYMBOLES, SYMBOLES_SOMBRE, SYMBOLE_INCONNU,
  symbole, libelleEtat, largeurTrait, largeurContour,
} from "./symbology";

/**
 * L'echelle d'etat se verifie, elle ne se decrete pas.
 *
 * Un contraste annonce dans un commentaire n'engage personne : il se degrade des que
 * quelqu'un ajuste une teinte « juste un peu ». Ces tests recalculent chaque ratio a
 * partir des valeurs reelles, selon la formule WCAG 2.1, et comparent le fichier CSS
 * au fichier TypeScript. Une divergence entre les deux ne peut plus passer.
 */

// ---- Luminance relative et contraste, WCAG 2.1 §1.4.3 ----

function canal(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);
}

function contraste(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const BLANC = "#ffffff";
/** Le fond applicatif reel, pas un blanc theorique (--background dans index.css). */
const FOND_APP = "#f4f6f8";

describe("La formule de contraste est celle de WCAG, pas une approximation", () => {
  it("donne 21:1 entre noir et blanc", () => {
    expect(contraste("#000000", BLANC)).toBeCloseTo(21, 1);
  });

  it("donne 1:1 pour une couleur avec elle-meme", () => {
    expect(contraste("#1b8a5a", "#1b8a5a")).toBeCloseTo(1, 5);
  });
});

describe("Chaque etat reste lisible", () => {
  it.each(ORDRE_ETATS)("le texte de %s franchit 4,5:1 sur blanc", (etat) => {
    const r = contraste(SYMBOLES[etat].texte, BLANC);
    expect(r, `${etat} : ${SYMBOLES[etat].texte} mesure ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(ORDRE_ETATS)("le trait de %s franchit 3:1 sur le fond applicatif", (etat) => {
    const r = contraste(SYMBOLES[etat].trait, FOND_APP);
    expect(r, `${etat} : ${SYMBOLES[etat].trait} mesure ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
  });

  it.each(ORDRE_ETATS)("le texte de %s franchit 4,5:1 sur son propre fond de badge", (etat) => {
    // Un badge affiche son texte sur sa teinte claire, pas sur le blanc de la page.
    const s = SYMBOLES[etat];
    const r = contraste(s.texte, s.fond);
    expect(r, `${etat} : ${s.texte} sur ${s.fond} mesure ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(ORDRE_ETATS)("le trait sombre de %s franchit 3:1 sur un fond de nuit", (etat) => {
    const r = contraste(SYMBOLES_SOMBRE[etat].trait, "#0f172a");
    expect(r, `${etat} nuit : mesure ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
  });
});

describe("La couleur ne porte jamais l'information seule", () => {
  it("donne une forme distincte a chaque etat voisin", () => {
    // Rouge et vert se confondent pour environ 8 % des hommes. Deux etats adjacents
    // dans l'echelle doivent donc differer autrement que par la teinte.
    for (let i = 1; i < ORDRE_ETATS.length; i++) {
      const a = SYMBOLES[ORDRE_ETATS[i - 1]];
      const b = SYMBOLES[ORDRE_ETATS[i]];
      const differe = a.forme !== b.forme || a.tirets !== b.tirets;
      expect(differe, `${ORDRE_ETATS[i - 1]} et ${ORDRE_ETATS[i]} ne different que par la couleur`).toBe(true);
    }
  });

  it("donne un libelle non vide a chaque etat", () => {
    for (const e of ORDRE_ETATS) expect(SYMBOLES[e].libelle.trim().length).toBeGreaterThan(0);
  });
});

describe("Une valeur inconnue ne fait pas tomber la page", () => {
  // Regression directe du 04/09 : une classe ajoutee en base mais absente du type
  // satisfaisait `Record<...>`, tsc passait, et la page tombait sur `undefined.pill`.
  it("rend un symbole pour une valeur absente du referentiel", () => {
    expect(symbole("ETAT_INVENTE_DEMAIN")).toEqual(SYMBOLE_INCONNU);
  });

  it("rend un symbole pour null et undefined", () => {
    expect(symbole(null)).toEqual(SYMBOLE_INCONNU);
    expect(symbole(undefined)).toEqual(SYMBOLE_INCONNU);
  });

  it("rend un libelle lisible plutot que la valeur brute", () => {
    expect(libelleEtat("NON_EVALUE")).toBe("Non évalué");
    expect(libelleEtat(null)).toBe("État inconnu");
    // Jamais « NON EVALUE » ni « undefined » a l'ecran.
    for (const e of ORDRE_ETATS) expect(libelleEtat(e)).not.toMatch(/_|undefined/);
  });
});

describe("Le fichier CSS et le fichier TypeScript ne peuvent pas diverger", () => {
  /**
   * Les traits sont en dur dans le TS parce que le moteur canvas de Leaflet ne resout
   * pas `var(--...)` : un trait deviendrait noir en silence. `tokens.css` reprend donc
   * les memes valeurs pour le DOM. Ce test lit reellement le fichier CSS.
   */
  const css = fs.readFileSync(path.resolve(__dirname, "../../../styles/tokens.css"), "utf8");
  const racine = css.slice(css.indexOf(":root"), css.indexOf('[data-theme="dark"]'));

  function variable(nom: string): string | undefined {
    return new RegExp(`--${nom}:\\s*(#[0-9a-fA-F]{6})`).exec(racine)?.[1]?.toLowerCase();
  }

  const CLES: Record<string, string> = {
    BON: "bon", MOYEN: "moyen", MAUVAIS: "mauvais",
    CRITIQUE: "critique", NON_EVALUE: "inconnu",
  };

  it.each(ORDRE_ETATS)("le trait de %s est identique des deux cotes", (etat) => {
    expect(variable(`etat-${CLES[etat]}-trait`)).toBe(SYMBOLES[etat].trait.toLowerCase());
  });

  it.each(ORDRE_ETATS)("le texte de %s est identique des deux cotes", (etat) => {
    expect(variable(`etat-${CLES[etat]}-texte`)).toBe(SYMBOLES[etat].texte.toLowerCase());
  });

  it("declare les z-index au-dessus de ceux de Leaflet", () => {
    // Leaflet pose ses controles a 800 en dur. Un panneau en dessous passerait sous
    // les boutons de zoom — un conflit qu'on ne voit qu'une fois le panneau ouvert.
    const z = (nom: string) => Number(new RegExp(`--z-${nom}:\\s*(\\d+)`).exec(racine)?.[1]);
    expect(z("controles-carte")).toBeGreaterThan(800);
    expect(z("panneau")).toBeGreaterThan(z("controles-carte"));
    expect(z("modale")).toBeGreaterThan(z("panneau"));
    expect(z("toast")).toBeGreaterThan(z("modale"));
  });
});

describe("La largeur des traces suit l'echelle", () => {
  it("croit avec le zoom", () => {
    const l = [7, 10, 13, 16].map((z) => largeurTrait(z, "RN"));
    for (let i = 1; i < l.length; i++) expect(l[i]).toBeGreaterThan(l[i - 1]);
  });

  it("hierarchise les classes a zoom egal", () => {
    const rn = largeurTrait(12, "RN");
    const rr = largeurTrait(12, "RR");
    const piste = largeurTrait(12, "PISTE");
    expect(rn).toBeGreaterThan(rr);
    expect(rr).toBeGreaterThan(piste);
  });

  it("borne la largeur aux extremites", () => {
    // Au-dela du zoom 18 la largeur cesse de croitre, sinon le trace noie le fond.
    expect(largeurTrait(22, "RN")).toBe(largeurTrait(18, "RN"));
    expect(largeurTrait(1, "RN")).toBe(largeurTrait(6, "RN"));
  });

  it("reste positive pour une classe inconnue", () => {
    expect(largeurTrait(12, "CLASSE_INEXISTANTE")).toBeGreaterThan(0);
    expect(largeurTrait(12, null)).toBeGreaterThan(0);
  });

  it("pose toujours le contour sous le trait", () => {
    for (const z of [7, 12, 18]) {
      expect(largeurContour(z, "RN")).toBeGreaterThan(largeurTrait(z, "RN"));
    }
  });
});
