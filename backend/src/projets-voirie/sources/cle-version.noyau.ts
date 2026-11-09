/**
 * CLE DE VERSION D UN JEU ET IDENTITE D UN RESEAU (noyau pur, lot S1 ; contrat CONTRAT-SOURCES.md, section 3.1 ; correctifs T1+S1, M3 et M4).
 *
 * Le socle versionne un jeu par (projet, role, concessionnaire) : une nouvelle livraison remplace la precedente a son autorisation. Pour les RESEAUX
 * DE CONCESSIONNAIRE seulement, deux composantes s ajoutent :
 *   - le TYPE DE RESEAU (correctifs M3) : le code configurable du referentiel TYPE_RESEAU (lot T1), sinon la famille declaree. Deux types d un meme
 *     concessionnaire, meme de la meme famille (deux codes TELECOM par exemple), sont deux RESEAUX : ni compares, ni versions l un de l autre ;
 *   - la METHODE D ACQUISITION (lot S1) : deux methodes differentes sont deux SOURCES du meme reseau (chacune garde sa lignee de versions).
 * Pour un plan d axes, des limites de route ou un jeu « autre », type et methode sont enregistres mais ne separent pas les lignees : deux plans d axes
 * autorises a la fois doubleraient les axes de l analyse ; un nouveau plan d axes reste une VERSION, comparee a la version autorisee AVANT son
 * autorisation (comparaison « version candidate »).
 *
 * C est la meme regle que les index uniques partiels de la migration 20261103400000 (fonction `pv_identite_type_reseau`) : le service et la base ne
 * peuvent pas diverger sans qu un depot echoue sur l index (P2002). La meme cle sert a retenir les jeux de l analyse 2D et du comptage (M4).
 */

import { FAMILLES_RESEAU } from "../territoires/referentiels.noyau";

export interface JeuCle {
  projetId: string; role: string; concessionnaireId: string | null; methodeAcquisition?: string | null;
  /** Code du referentiel TYPE_RESEAU (lot T1) ; nul : seule la famille est connue. */
  typeReseauCode?: string | null;
  /** Famille technique (enumeration TypeReseauTiers). */
  typeReseau?: string | null;
}

/** Methode et type font-ils partie de la cle pour ce role ? */
export const methodeDansCle = (role: string): boolean => role === "RESEAU_TIERS";

/** Identite du type d un reseau : le code configurable, sinon la famille (meme expression que `pv_identite_type_reseau` en base). */
export const identiteTypeReseau = (j: Pick<JeuCle, "typeReseauCode" | "typeReseau">): string => j.typeReseauCode ?? j.typeReseau ?? "";

/**
 * Filtre Prisma de la cle de version (a combiner avec un statut). Rend un objet litteral pour ne pas importer les types de Prisma dans un noyau pur :
 * `methodeAcquisition: null` designe la lignee sans methode (le comportement du socle). Le type : code egal a l identite, ou code nul et famille egale.
 */
export function filtreCleVersion(j: JeuCle): { projetId: string; role: never; concessionnaireId: string | null; methodeAcquisition?: string | null; AND?: never } {
  if (!methodeDansCle(j.role)) return { projetId: j.projetId, role: j.role as never, concessionnaireId: j.concessionnaireId };
  const ident = identiteTypeReseau(j);
  const type = ident === ""
    ? { typeReseauCode: null, typeReseau: null }
    : { OR: [{ typeReseauCode: ident }, ...((FAMILLES_RESEAU as readonly string[]).includes(ident) ? [{ typeReseauCode: null, typeReseau: ident }] : [])] };
  return {
    projetId: j.projetId, role: j.role as never, concessionnaireId: j.concessionnaireId, methodeAcquisition: j.methodeAcquisition ?? null,
    AND: [type] as never,
  };
}

/** Deux jeux decrivent-ils le meme reseau (meme concessionnaire et meme type, quelle que soit la methode) ? Vrai pour deux jeux d un autre role. */
export function memeReseau(a: JeuCle, b: JeuCle): boolean {
  if ((a.concessionnaireId ?? null) !== (b.concessionnaireId ?? null)) return false;
  return !methodeDansCle(a.role) || identiteTypeReseau(a) === identiteTypeReseau(b);
}

/** Deux jeux sont-ils de la meme lignee de versions (meme cle) ? */
export function memeLignee(a: JeuCle, b: JeuCle): boolean {
  if (a.projetId !== b.projetId || a.role !== b.role || !memeReseau(a, b)) return false;
  return !methodeDansCle(a.role) || (a.methodeAcquisition ?? null) === (b.methodeAcquisition ?? null);
}

/** Cle de lignee sous forme de texte (meme composantes que l index) : sert a retenir un jeu par lignee dans l analyse 2D et le comptage (M4). */
export function cleLignee(j: JeuCle): string {
  return methodeDansCle(j.role)
    ? [j.role, j.concessionnaireId ?? "", identiteTypeReseau(j), j.methodeAcquisition ?? ""].join("|")
    : [j.role, j.concessionnaireId ?? ""].join("|");
}
