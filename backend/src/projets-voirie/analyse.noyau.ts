/**
 * Noyau PUR de l'analyse des projets de voirie (contrat, section 5) : choix de la projection, textes des hypotheses et des
 * limites, et implementation de REFERENCE de la geometrie metrique en coordonnees planes (metres). Sans base, sans E/S.
 *
 * DEUX USAGES
 *   1. Les textes (`construireHypotheses`, `construireLimites`) et le choix du fuseau (`epsgPourLongitude`) sont ceux de la
 *      reponse reelle de l'API.
 *   2. La geometrie plane (`longueurDansBande`, `croisements`, `longueurPhysique`) est un ORACLE : l'analyse reelle est faite
 *      par PostGIS (`analyse.depot.ts`), et le banc `tests-integration/projets-voirie.integration.mts` confronte les deux
 *      sur le cas synthetique de resultat connu du contrat (section 7). Elle sert aussi a eprouver ce cas sans base.
 *
 * L'ORACLE EST EXACT, SANS TAMPON POLYGONAL : l'ensemble des points d'un segment situes a moins de `d` metres d'un autre
 * segment est un intervalle (la distance a un ensemble convexe est une fonction convexe), obtenu comme enveloppe de ses
 * intersections avec deux disques et un rectangle ; l'union des intervalles de tous les segments de l'axe donne la partie du
 * segment situee dans la bande (axe ± d, bouts arrondis comme `ST_Buffer`). Ce n'est donc PAS une copie de l'algorithme de
 * PostGIS : un accord entre les deux est une preuve.
 */

export type Pt = readonly [number, number];

/** EPSG 32628 (UTM 28N, meridien central -15) si la longitude est inferieure a -12, sinon 32629 (UTM 29N, meridien -9). */
export function epsgPourLongitude(longitude: number): 32628 | 32629 {
  return longitude < -12 ? 32628 : 32629;
}

// ------------------------------------------------------------------------------------------------
// Geometrie plane de reference
// ------------------------------------------------------------------------------------------------

const longueurSegment = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Intervalle de t dans [0,1] pour lequel A + t(B-A) est a moins de d du segment [C,D], ou null. */
function intervalleProche(a: Pt, b: Pt, c: Pt, dd: Pt, d: number): [number, number] | null {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const morceaux: [number, number][] = [];

  const disque = (centre: Pt) => {
    const px = a[0] - centre[0], py = a[1] - centre[1];
    const qa = vx * vx + vy * vy, qb = 2 * (px * vx + py * vy), qc = px * px + py * py - d * d;
    if (qa === 0) { if (qc <= 0) morceaux.push([0, 1]); return; }
    const disc = qb * qb - 4 * qa * qc;
    if (disc < 0) return;
    const r = Math.sqrt(disc);
    morceaux.push([(-qb - r) / (2 * qa), (-qb + r) / (2 * qa)]);
  };
  disque(c);
  disque(dd);

  // Rectangle : 0 <= u <= len et |w| <= d, u et w affines en t.
  const ex = dd[0] - c[0], ey = dd[1] - c[1];
  const len = Math.hypot(ex, ey);
  if (len > 0) {
    const ux = ex / len, uy = ey / len;
    const u0 = (a[0] - c[0]) * ux + (a[1] - c[1]) * uy, du = vx * ux + vy * uy;
    const w0 = -(a[0] - c[0]) * uy + (a[1] - c[1]) * ux, dw = -vx * uy + vy * ux;
    let lo = -Infinity, hi = Infinity, vide = false;
    const demiPlan = (x0: number, dx: number, min: number, max: number) => {
      // min <= x0 + t dx <= max
      if (dx === 0) { if (x0 < min || x0 > max) vide = true; return; }
      const t1 = (min - x0) / dx, t2 = (max - x0) / dx;
      lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2));
    };
    demiPlan(u0, du, 0, len);
    demiPlan(w0, dw, -d, d);
    if (!vide && lo <= hi) morceaux.push([lo, hi]);
  }
  if (morceaux.length === 0) return null;
  const lo = Math.max(0, Math.min(...morceaux.map((m) => m[0])));
  const hi = Math.min(1, Math.max(...morceaux.map((m) => m[1])));
  return lo <= hi ? [lo, hi] : null;
}

/** Longueur de `ligne` situee a moins de `d` metres de l'une des `axes` (union des bandes, bouts arrondis). */
export function longueurDansBande(ligne: readonly Pt[], axes: readonly (readonly Pt[])[], d: number): number {
  let total = 0;
  for (let i = 0; i + 1 < ligne.length; i++) {
    const a = ligne[i], b = ligne[i + 1];
    const intervalles: [number, number][] = [];
    for (const axe of axes) {
      for (let j = 0; j + 1 < axe.length; j++) {
        const r = intervalleProche(a, b, axe[j], axe[j + 1], d);
        if (r) intervalles.push(r);
      }
    }
    intervalles.sort((x, y) => x[0] - y[0]);
    let couvert = 0, finCourante = -Infinity, debut = 0;
    for (const [lo, hi] of intervalles) {
      if (lo > finCourante) { if (finCourante > -Infinity) couvert += finCourante - debut; debut = lo; finCourante = hi; }
      else if (hi > finCourante) finCourante = hi;
    }
    if (finCourante > -Infinity) couvert += finCourante - debut;
    total += couvert * longueurSegment(a, b);
  }
  return total;
}

export function longueur(ligne: readonly Pt[]): number {
  let s = 0;
  for (let i = 0; i + 1 < ligne.length; i++) s += longueurSegment(ligne[i], ligne[i + 1]);
  return s;
}

function intersectionSegments(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (den === 0) return null; // paralleles ou colineaires : pas de point de croisement
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den;
  const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
  const eps = 1e-12;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  return [a[0] + t * rx, a[1] + t * ry];
}

/** Points d'intersection des `lignes` avec les `axes`, sans doublon (deux points a moins de `tolerance` m n'en font qu'un). */
export function croisements(lignes: readonly (readonly Pt[])[], axes: readonly (readonly Pt[])[], tolerance = 0.01): Pt[] {
  const points: Pt[] = [];
  for (const l of lignes) {
    for (let i = 0; i + 1 < l.length; i++) {
      for (const axe of axes) {
        for (let j = 0; j + 1 < axe.length; j++) {
          const p = intersectionSegments(l[i], l[i + 1], axe[j], axe[j + 1]);
          if (p && !points.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= tolerance)) points.push(p);
        }
      }
    }
  }
  return points;
}

/**
 * Longueur de l'union des trace : un segment present plusieurs fois (meme trace repete par plusieurs circuits, dans un sens
 * ou dans l'autre) ne compte qu'une fois. REFERENCE LIMITEE aux segments identiques au millimetre ; PostGIS (`ST_UnaryUnion`)
 * traite en plus les recouvrements partiels, ce que le banc eprouve a part.
 */
export function longueurPhysique(lignes: readonly (readonly Pt[])[]): number {
  const vus = new Set<string>();
  let total = 0;
  const q = (v: number) => Math.round(v * 1000);
  for (const l of lignes) {
    for (let i = 0; i + 1 < l.length; i++) {
      const p = [q(l[i][0]), q(l[i][1])], r = [q(l[i + 1][0]), q(l[i + 1][1])];
      const [x, y] = p[0] < r[0] || (p[0] === r[0] && p[1] <= r[1]) ? [p, r] : [r, p];
      const cle = `${x[0]},${x[1]}|${y[0]},${y[1]}`;
      if (vus.has(cle)) continue;
      vus.add(cle);
      total += longueurSegment(l[i], l[i + 1]);
    }
  }
  return total;
}

// ------------------------------------------------------------------------------------------------
// Regle, versions, qualification et textes de la reponse
// ------------------------------------------------------------------------------------------------

/** Version de la regle de calcul 2D (bandes de chaussee et d'emprise centrees sur l'axe). Citee dans chaque resultat. */
export const VERSION_REGLE = "RC-2D-0.1";
/** Version de l'algorithme (projection UTM, bandes tamponnees, tracés fusionnes). */
export const VERSION_ALGORITHME = "2D-UTM-1";
/** Tout resultat de ce lot est a verifier : rien n'est un verdict. */
export const STATUT_RESULTAT = "A_VERIFIER" as const;

export type Qualification = "CONFLIT_POTENTIEL" | "PROXIMITE_A_VERIFIER";
export type ClasseLue = "A" | "B" | "C" | "D" | "E" | null;

/**
 * Qualification d'un resultat selon la classe de precision DECLAREE du jeu : A, B ou C = conflit potentiel ; D, E ou
 * INCONNUE = proximite a verifier, jamais un « conflit ». Le serveur n'interprete pas les seuils des classes (ceux du
 * cahier du DSI) : il stocke la classe et n'invente aucune precision.
 */
export function qualificationDe(classe: ClasseLue): Qualification {
  return classe === "A" || classe === "B" || classe === "C" ? "CONFLIT_POTENTIEL" : "PROXIMITE_A_VERIFIER";
}

/** Ces trois phrases figurent TOUJOURS dans `limites` (contrat, section 5). */
export const LIMITES_OBLIGATOIRES = [
  "Conflit vertical non évalué : profondeur et altitude absentes.",
  "Aucun conflit détecté ne prouve l'absence de réseau.",
  "Résultat indicatif : aucune décision de déplacement n'en découle.",
] as const;

export const LIBELLES = {
  nbObjets: "circuits ou objets du fichier",
  longueurTraceFusionneM: "longueur des tracés fusionnés (union des tracés, pas un nombre de câbles)",
  conflit: "Conflit potentiel : réseau d'un jeu de précision A, B ou C situé dans la chaussée ou l'emprise prévue, à vérifier.",
  proximite: "Proximité à vérifier : réseau d'un jeu de précision D, E ou inconnue situé dans la chaussée ou l'emprise prévue ; ce n'est pas un conflit établi.",
} as const;

export interface ContexteTextes {
  largeurEmpriseM: number;
  largeurChausseeM: number;
  statutParametres: "THEORIQUE" | "VALIDE";
  projection: string;
  nbAxes: number;
  nbJeuxReseau: number;
  /** Jeux de limites de route actifs (non utilises par le calcul). */
  nbJeuxLimites: number;
  /** `dateDonnees` des jeux de reseau et d'axes pris en compte ; null = non renseignee. */
  datesDonnees: (string | null)[];
  /** Precision horizontale declaree (m) de chaque jeu de reseau ; null = non renseignee. */
  precisionsDeclareesM: (number | null)[];
  /** Classe de precision declaree de chaque jeu de reseau ; null = inconnue. */
  classes: ClasseLue[];
  /** Vrai si les jeux en controle (non autorises) sont inclus dans le calcul. */
  inclureNonAutorises: boolean;
  nbJeuxNonAutorises: number;
}

const fr = (n: number) => String(n).replace(".", ",");

function texteClasses(classes: ClasseLue[]): string | null {
  if (classes.length === 0) return null;
  const compte = new Map<string, number>();
  for (const c of classes) compte.set(c ?? "inconnue", (compte.get(c ?? "inconnue") ?? 0) + 1);
  const ordre = ["A", "B", "C", "D", "E", "inconnue"].filter((k) => compte.has(k));
  const liste = ordre.map((k) => `${k === "inconnue" ? "inconnue" : k} (${compte.get(k)} jeu${compte.get(k)! > 1 ? "x" : ""})`).join(", ");
  return `Classes de précision déclarées des jeux de réseau : ${liste}. Pour la classe A, B ou C, un résultat est un conflit potentiel ; pour la classe D, E ou inconnue, c'est une proximité à vérifier, jamais un conflit. Aucune précision n'est inventée : une classe inconnue reste inconnue.`;
}

export function construireHypotheses(c: ContexteTextes): string[] {
  const th = c.statutParametres === "VALIDE"
    ? "Ces largeurs ont été validées."
    : "Ces largeurs sont THÉORIQUES : elles n'ont pas été validées par AGEROUTE.";
  const h = [
    `La chaussée est supposée large de ${fr(c.largeurChausseeM)} m et l'emprise de ${fr(c.largeurEmpriseM)} m, centrées sur chaque axe de travaux (axe ± ${fr(c.largeurChausseeM / 2)} m pour la chaussée, axe ± ${fr(c.largeurEmpriseM / 2)} m pour l'emprise). ${th}`,
    "Les axes sont les tracés du plan d'axes autorisé ; un axe est une ligne, sans épaisseur propre.",
    c.inclureNonAutorises
      ? `Les jeux en contrôle (non autorisés) sont INCLUS à la demande de l'utilisateur (${c.nbJeuxNonAutorises} jeu${c.nbJeuxNonAutorises > 1 ? "x" : ""}) et marqués « non autorisé » ; pour ce calcul seulement, un jeu en contrôle remplace le jeu autorisé de même rôle et de même concessionnaire. Ces chiffres ne sont pas ceux de l'analyse officielle.`
      : "Seuls les jeux autorisés entrent dans le calcul : un lot reçu en contrôle n'est pas un lot importé.",
    `Les calculs sont plans, en mètres, dans la projection ${c.projection}, choisie selon la longitude du centre du projet. L'altitude est ignorée.`,
    "Un même tracé répété par plusieurs circuits n'est compté qu'une fois dans la longueur des tracés fusionnés d'un jeu ; les conflits sont calculés sur ces tracés fusionnés. Le nombre d'objets d'un fichier est un nombre de « circuits ou objets du fichier », jamais un nombre de câbles physiques.",
    "Un réseau situé dans l'emprise de deux axes voisins (carrefour) apparaît dans la ligne de chacun de ces axes, mais n'est compté qu'une seule fois dans les totaux.",
    "Un croisement est un point où le tracé d'un réseau coupe un axe de travaux, vu en plan.",
  ];
  const cl = texteClasses(c.classes);
  if (cl) h.push(cl);
  return h;
}

export function construireLimites(c: ContexteTextes): string[] {
  const l: string[] = [];
  if (c.nbAxes === 0) l.push("Aucun axe de travaux autorisé n'est chargé : les conflits ne peuvent pas être calculés (totaux à zéro). Chargez puis autorisez un plan d'axes.");
  if (c.nbJeuxReseau === 0) l.push("Aucun réseau de concessionnaire autorisé n'est chargé : aucune longueur de réseau ni aucun conflit à calculer.");
  const precis = c.precisionsDeclareesM.filter((p): p is number => p !== null);
  if (c.nbJeuxReseau > 0) {
    l.push(precis.length === 0
      ? "La précision de position des réseaux est INCONNUE : aucun fournisseur ne l'a déclarée. Les positions sont celles du fichier fourni."
      : `La précision de position des réseaux n'est déclarée que pour ${precis.length} jeu(x) sur ${c.nbJeuxReseau} (${Math.min(...precis) === Math.max(...precis) ? fr(Math.min(...precis)) : `de ${fr(Math.min(...precis))} à ${fr(Math.max(...precis))}`} m) ; elle est inconnue pour les autres.`);
  }
  if (c.nbJeuxLimites > 0) l.push("Les limites de route chargées ne servent pas encore au calcul : l'emprise est théorique (axe ± demi-largeur).");
  if (c.datesDonnees.some((d) => d === null)) l.push("La date de levé ou de fourniture n'est pas renseignée pour tous les jeux : l'actualité des données n'est pas garantie.");
  l.push(...LIMITES_OBLIGATOIRES);
  return l;
}
