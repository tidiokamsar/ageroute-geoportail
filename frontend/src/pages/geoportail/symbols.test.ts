import { describe, expect, it } from "vitest";
import { ouvrageIcon, TYPE_OUVRAGE_LABEL } from "./symbols";

/**
 * La provenance d'un ouvrage se voit sur la carte.
 *
 * CE QUE CE TEST DEFEND
 *
 * 963 ponts sont entres le 05/09/2026 depuis une source cartographique externe, aux
 * cotes des 126 qu'AGEROUTE a visites. Le tableau de bord et la carte publique font la
 * distinction ; l'ecran de travail montrait 1 089 epingles identiques.
 *
 * C'est pourtant la que la distinction compte : c'est l'ecran ou ces ouvrages doivent
 * etre valides. Sans elle, l'import ne sert a rien — personne ne peut voir ce qu'il
 * reste a verifier, et une donnee reprise se confond avec une donnee officielle.
 *
 * La marque est un contour DISCONTINU et non une couleur : la couleur porte deja
 * l'etat patrimonial, et lui faire dire deux choses la rendrait illisible.
 */

/**
 * Le HTML rendu par le DivIcon, seul endroit ou la distinction est observable.
 *
 * `options.html` est type `string | HTMLElement | false` chez Leaflet — le `false`
 * signifie « pas de contenu ». Un type plus etroit compilait sous `tsc --noEmit` avec
 * la configuration de developpement, et cassait le build de production, qui inclut
 * les fichiers de test. D'ou `unknown` : c'est une chaine qu'on veut, et une seule
 * conversion suffit a l'obtenir quel que soit ce que Leaflet a mis dedans.
 */
function html(icon: { options: { html?: unknown } }): string {
  return typeof icon.options.html === "string" ? icon.options.html : "";
}

describe("Un ouvrage repris ne se confond pas avec un ouvrage inventorié", () => {
  it("marque le repris d'un contour discontinu", () => {
    expect(html(ouvrageIcon("PONT", "NON_EVALUE", true))).toContain("dashed");
  });

  it("garde un contour plein pour l'inventaire d'AGEROUTE", () => {
    const inventorie = html(ouvrageIcon("PONT", "BON", false));
    expect(inventorie).toContain("solid");
    expect(inventorie).not.toContain("dashed");
  });

  it("traite l'absence d'information comme un ouvrage inventorié", () => {
    // Le drapeau est optionnel : un appelant qui l'ignore ne doit pas faire passer
    // tout l'inventaire pour du repris.
    expect(html(ouvrageIcon("PONT", "BON"))).toContain("solid");
  });

  it("distingue les deux par autre chose que la couleur", () => {
    // Deux ouvrages de meme etat, de provenance differente : ils doivent differer.
    // Si la seule difference etait la teinte, un daltonien ne verrait rien.
    const a = html(ouvrageIcon("PONT", "NON_EVALUE", false));
    const b = html(ouvrageIcon("PONT", "NON_EVALUE", true));
    expect(a).not.toBe(b);
    expect(b.replace("dashed", "solid")).toBe(a);
  });

  it("conserve le glyphe du type quelle que soit la provenance", () => {
    // La provenance ne doit pas effacer l'information qui etait deja la.
    for (const repris of [true, false]) {
      expect(html(ouvrageIcon("DALOT", "BON", repris))).toContain("▤");
      expect(html(ouvrageIcon("BUSE", "BON", repris))).toContain("◉");
    }
  });

  it("rend un symbole pour un type inconnu du referentiel", () => {
    // Meme garde qu'ailleurs : une valeur venue du serveur ne doit pas produire
    // « undefined » dans le HTML d'un marqueur.
    const inconnu = html(ouvrageIcon("TYPE_AJOUTE_DEMAIN", "BON", false));
    expect(inconnu).toContain("◆");
    expect(inconnu).not.toContain("undefined");
  });

  it("rend un symbole pour un état inconnu du referentiel", () => {
    const inconnu = html(ouvrageIcon("PONT", "ETAT_AJOUTE_DEMAIN", false));
    expect(inconnu).not.toContain("undefined");
  });

  it("libelle chaque type d'ouvrage en français", () => {
    for (const [cle, libelle] of Object.entries(TYPE_OUVRAGE_LABEL)) {
      expect(libelle).not.toBe(cle);
      expect(libelle).not.toMatch(/_/);
    }
  });
});
