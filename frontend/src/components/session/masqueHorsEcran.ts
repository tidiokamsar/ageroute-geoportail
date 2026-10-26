/**
 * Masque TOUT ce qui est hors d'un element (l'ecran de verrouillage), portails sous `body` compris.
 *
 * POURQUOI. `ProtectedRoute` ne masquait que l'`Outlet`. Un dialogue Radix ouvert AU MOMENT du verrou vit dans un portail sous
 * `body` (hors de l'arbre masque) et, a `z-50`, passait AU-DESSUS de l'ecran de PIN (`z-40`) : contenu lisible, focus pris par le
 * dialogue (le piege a focus de Radix reprend le focus qui sort).
 *
 * CE QUE FAIT LA FONCTION. Depuis l'element jusqu'a `body`, chaque FRERE de l'element ou d'un de ses ancetres recoit `inert`,
 * `aria-hidden="true"` et `visibility: hidden` : retire du clavier, des lecteurs d'ecran, de l'affichage et du pointeur, SANS
 * etre demonte (un releve en cours continue, une saisie commencee n'est pas perdue). Les valeurs anterieures sont restituees au
 * demontage ; un frere deja `inert` (le contenu masque par ProtectedRoute) n'est pas touche, pour ne pas disputer ses
 * attributs a React. Les ANCETRES de l'ecran que `aria-hidden` cachait (effet du `hideOthers` d'un dialogue Radix modal) sont
 * devoiles, puis recaches au demontage.
 *
 * LIMITE (voir SESSION-HORS-LIGNE.md, section 3) : c'est un MASQUAGE. Ni le DOM ni la memoire ne sont purges.
 * Instantane : seuls les freres presents AU MOMENT du verrou sont masques. Un portail cree plus tard par un processus d'arriere-plan
 * (rare) n'est pas masque et, a `z-50`, passerait au-dessus de l'ecran de verrouillage (`z-40`) : limite assumee. Le `z-index` de
 * l'ecran reste VOLONTAIREMENT sous `z-50`, car les dialogues que cet ecran ouvre lui-meme (code oublie, deconnexion) sont des
 * portails a `z-50` crees apres le masquage : ils doivent rester au-dessus et utilisables. La garantie vient donc du masquage
 * (inert, aria-hidden, visibility), pas du z-index.
 * Non prouve en navigateur reel : jsdom n'implemente ni `inert` ni le piege a focus de Radix (a verifier en E2E).
 */
const BALISES_IGNOREES = new Set(["SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT", "TEMPLATE"]);

interface Masque {
  readonly element: HTMLElement;
  readonly ariaHidden: string | null;
  readonly visibilite: string;
}

/** Un ancetre de l'ecran que `aria-hidden` cachait (un dialogue Radix modal masque tout ce qui l'entoure) : l'ecran serait inaccessible. */
interface Devoile {
  readonly element: HTMLElement;
  readonly ariaHidden: string;
}

export function masquerHorsDe(element: HTMLElement): () => void {
  const masques: Masque[] = [];
  const devoiles: Devoile[] = [];
  const doc = element.ownerDocument;
  let noeud: HTMLElement = element;
  while (noeud !== doc.body && noeud.parentElement !== null) {
    const parent: HTMLElement = noeud.parentElement;
    // Un dialogue Radix modal ouvert pose `aria-hidden` sur les ANCETRES de l'ecran (tout ce qui n'est pas lui) : sans cela,
    // l'ecran de verrouillage serait lui-meme cache aux lecteurs d'ecran.
    const cache = parent.getAttribute("aria-hidden");
    if (cache !== null && parent !== doc.body) {
      devoiles.push({ element: parent, ariaHidden: cache });
      parent.removeAttribute("aria-hidden");
    }
    for (const frere of Array.from(parent.children)) {
      if (frere === noeud || !(frere instanceof HTMLElement) || BALISES_IGNOREES.has(frere.tagName) || frere.hasAttribute("inert")) continue;
      masques.push({ element: frere, ariaHidden: frere.getAttribute("aria-hidden"), visibilite: frere.style.visibility });
      frere.setAttribute("inert", "");
      frere.setAttribute("aria-hidden", "true");
      frere.style.visibility = "hidden";
    }
    noeud = parent;
  }
  return () => {
    for (const d of devoiles) d.element.setAttribute("aria-hidden", d.ariaHidden);
    for (const m of masques) {
      m.element.removeAttribute("inert");
      if (m.ariaHidden === null) m.element.removeAttribute("aria-hidden");
      else m.element.setAttribute("aria-hidden", m.ariaHidden);
      m.element.style.visibility = m.visibilite;
    }
  };
}
