/**
 * Delta de versions (contrat v2, section 3) : compare les empreintes des objets d'une nouvelle version a celles du jeu
 * qu'elle remplacera. INFORMATION SEULEMENT : le delta n'est jamais applique, aucune suppression n'en decoule.
 * Comparaison par multi-ensemble (un meme objet present deux fois compte deux fois). Sans E/S.
 */
export interface Delta {
  ajoutes: number;
  retires: number;
  identiques: number;
}

export function calculerDelta(nouvelles: readonly string[], anciennes: ReadonlyMap<string, number>): Delta {
  const n = new Map<string, number>();
  for (const e of nouvelles) n.set(e, (n.get(e) ?? 0) + 1);
  let identiques = 0, totalAnciens = 0;
  for (const [e, k] of anciennes) {
    totalAnciens += k;
    identiques += Math.min(k, n.get(e) ?? 0);
  }
  return { ajoutes: nouvelles.length - identiques, retires: totalAnciens - identiques, identiques };
}
