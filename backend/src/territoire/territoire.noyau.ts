/**
 * Controle d'acces territorial (A10, « 403 hors zone ») : regle pure, sans import.
 *
 * LE PERIMETRE D'UN COMPTE
 *
 * Un compte est rattache a zero, une ou plusieurs regions (`perimetres_comptes`). ADMIN est
 * toujours national. Un compte SANS rattachement est NATIONAL : c'est le comportement d'avant,
 * et rattacher chaque compte a un perimetre est une donnee d'organisation qu'AGEROUTE doit fournir
 * (D-11). Exiger un perimetre aurait arrete toute ecriture le jour du deploiement.
 *
 * Ce n'est pas le defaut silencieux des modules (`modulesAutorises` vide valait « tout ») : ici le
 * nombre de comptes encore nationaux par defaut est expose a l'administration
 * (`GET /api/v2/perimetres`), pour que l'etat se lise au lieu de se deviner. Meme regle de
 * resserrement que les delegations de validation (`governance/delegation.ts`).
 *
 * CE QUI EST CONTROLE
 *
 * Une ecriture touche une ou plusieurs regions : celle de la fiche AVANT, celle d'APRES quand elle
 * change, celle du troncon dont herite un defaut, une observation ou une portion. Un compte
 * regional n'ecrit que si TOUTES sont dans son perimetre. Une region INCONNUE (defaut localise
 * seulement par GPS, mission sans region) est refusee a un compte regional : en deduire une
 * localisation de l'absence de localisation serait la meme faute que celle que les delegations
 * evitent deja.
 */

export type Perimetre = { national: true } | { national: false; regions: ReadonlySet<number> };

export type VerdictTerritoire = { ok: true } | { ok: false; code: "HORS_PERIMETRE" | "REGION_INCONNUE"; motif: string };

export const NATIONAL: Perimetre = { national: true };

export function perimetreDeRegions(role: string, regions: readonly number[]): Perimetre {
  if (role === "ADMIN" || regions.length === 0) return NATIONAL;
  return { national: false, regions: new Set(regions) };
}

/**
 * Nature de l'acces controle : le libelle du refus doit dire ce qui est refuse. `ecriture` (defaut) garde les libelles
 * historiques, que des tests et des clients lisent ; `lecture` est neutre pour une demande qui ne modifie rien (le
 * rapport de qualite d'une region, par exemple : D9, point 7c).
 */
export type NatureAcces = "ecriture" | "lecture";

const MOTIFS: Record<NatureAcces, { inconnue: string; hors: string }> = {
  ecriture: {
    inconnue: "La region de cette fiche est inconnue : un compte regional ne peut pas l'ecrire.",
    hors: "Cette ecriture touche une region hors de votre perimetre.",
  },
  lecture: {
    inconnue: "La region demandee est inconnue ou invalide : un compte regional ne peut pas la consulter.",
    hors: "Cette demande vise une region hors de votre perimetre.",
  },
};

/** `regionsTouchees` : chaque region que l'ecriture touche ; `null` = region inconnue. */
export function verifierTerritoire(
  perimetre: Perimetre,
  regionsTouchees: readonly (number | null | undefined)[],
  nature: NatureAcces = "ecriture",
): VerdictTerritoire {
  if (perimetre.national) return { ok: true };
  for (const r of regionsTouchees) {
    if (r === null || r === undefined) {
      return { ok: false, code: "REGION_INCONNUE", motif: MOTIFS[nature].inconnue };
    }
    if (!perimetre.regions.has(r)) {
      return { ok: false, code: "HORS_PERIMETRE", motif: MOTIFS[nature].hors };
    }
  }
  return { ok: true };
}
