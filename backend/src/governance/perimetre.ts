/**
 * Perimetre territorial d'ecriture (paragraphe 7.9, scenario A10 « 403 [...] hors zone »).
 * Aucune importation.
 *
 * LES HUIT DOMAINES sont ceux des delegations de validation (`governance/delegation.ts`) :
 * troncons, ouvrages, points noirs, postes, chantiers, defauts, observations, portions. Le
 * perimetre s'applique a toute ECRITURE sur eux ; la lecture n'est pas restreinte (decision D-11 :
 * rien n'a ete decide sur la lecture, et la restreindre ferait disparaitre des donnees des cartes).
 *
 * LA REGLE PROVISOIRE : RESSERREMENT PAR COMPTE, la meme que celle des delegations.
 *   - un compte SANS perimetre en vigueur ecrit partout, comme avant : AGEROUTE n'a fourni ni la
 *     liste des comptes ni leur territoire (D-11, point 2), et exiger un perimetre bloquerait
 *     toute ecriture le jour du deploiement. Le nombre de ces comptes est rendu par l'API
 *     (`comptesSansPerimetre`) pour que l'etat se lise ;
 *   - des qu'un compte a un perimetre, il n'ecrit que dans ses regions ;
 *   - un objet dont la region est INCONNUE lui est refuse : on ne peut pas affirmer qu'il est dans
 *     le perimetre, et l'accepter deduirait une localisation de l'absence de localisation.
 *
 * UNE ECRITURE PEUT TOUCHER PLUSIEURS REGIONS : un troncon deplace d'une region a une autre, une
 * fusion de portions. Chacune doit etre dans le perimetre.
 */

export const DOMAINES_TERRITORIAUX = [
  "TRONCON", "OUVRAGE", "POINT_NOIR", "POSTE", "CHANTIER", "DEFAUT", "OBSERVATION", "PORTION",
] as const;
export type DomaineTerritorial = (typeof DOMAINES_TERRITORIAUX)[number];

export interface Perimetre {
  regionId: number;
  debutLe: Date;
  finLe: Date | null;
  revoqueLe: Date | null;
}

export function perimetreEnVigueur(p: Perimetre, maintenant: Date): boolean {
  if (p.revoqueLe !== null && p.revoqueLe <= maintenant) return false;
  if (p.debutLe > maintenant) return false;
  if (p.finLe !== null && p.finLe <= maintenant) return false;
  return true;
}

export type VerdictTerritorial =
  | { permis: true; national: boolean }
  | { permis: false; motif: "HORS_PERIMETRE" | "REGION_INCONNUE"; regionsAutorisees: number[] };

export function verdictTerritorial(
  perimetresDuCompte: readonly Perimetre[],
  regionsTouchees: readonly (number | null)[],
  maintenant: Date,
): VerdictTerritorial {
  const autorisees = [...new Set(perimetresDuCompte.filter((p) => perimetreEnVigueur(p, maintenant)).map((p) => p.regionId))].sort((a, b) => a - b);
  if (autorisees.length === 0) return { permis: true, national: true };
  // Aucune region touchee connue (creation sans localisation) : c'est une region inconnue.
  if (regionsTouchees.length === 0 || regionsTouchees.some((r) => r === null)) {
    return { permis: false, motif: "REGION_INCONNUE", regionsAutorisees: autorisees };
  }
  if (regionsTouchees.some((r) => !autorisees.includes(r as number))) {
    return { permis: false, motif: "HORS_PERIMETRE", regionsAutorisees: autorisees };
  }
  return { permis: true, national: false };
}

export const EXPLICATIONS_TERRITOIRE: Record<"HORS_PERIMETRE" | "REGION_INCONNUE", string> = {
  HORS_PERIMETRE: "Écriture hors de votre périmètre territorial.",
  REGION_INCONNUE: "La région de cet objet est inconnue : un compte restreint à un périmètre ne peut pas l'écrire. Rattachez-le d'abord à un tronçon ou à une mission de votre région.",
};
