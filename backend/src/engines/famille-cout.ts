/**
 * Famille de cout d'un revetement de troncon. AUCUN IMPORT.
 *
 * Les baremes connaissent TROIS familles -- `bitume`, `terre_laterite`, `pave` -- plus
 * grossieres que le revetement, et c'est voulu : « `bitume` recouvre BETON_BITUMINEUX et
 * ENDUIT_SUPERFICIEL, `terre_laterite` recouvre TERRE et LATERITE » (schema.prisma,
 * BaremeIntervention). Le script `parametrer-baremes-cout.ts` pose cette correspondance sur le
 * referentiel des revetements des PORTIONS ; ce module la pose sur l'enumeration des TRONCONS,
 * qui est plus ancienne et plus grossiere encore (BITUME, TERRE, LATERITE, PAVE, NON_RENSEIGNE).
 *
 * NON_RENSEIGNE n'a pas de famille, et ce n'est pas un oubli : un troncon dont on ne connait pas
 * le revetement ne se chiffre pas. L'estimation refusera, et dira pourquoi -- c'est la regle du
 * moteur de cout (D-07), pas une exception.
 */

export type RevetementTroncon = "BITUME" | "TERRE" | "LATERITE" | "PAVE" | "NON_RENSEIGNE";

export type FamilleCout = "bitume" | "terre_laterite" | "pave";

const FAMILLE_PAR_REVETEMENT_TRONCON: Readonly<Record<RevetementTroncon, FamilleCout | null>> = {
  BITUME: "bitume",
  TERRE: "terre_laterite",
  LATERITE: "terre_laterite",
  PAVE: "pave",
  NON_RENSEIGNE: null,
};

/** La famille de cout, ou `null` si le revetement ne permet pas de chiffrer. */
export function familleCoutDeTroncon(revetement: string | null | undefined): FamilleCout | null {
  if (!revetement) return null;
  return (FAMILLE_PAR_REVETEMENT_TRONCON as Record<string, FamilleCout | null>)[revetement] ?? null;
}
