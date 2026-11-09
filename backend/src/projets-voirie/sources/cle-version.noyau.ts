/**
 * CLE DE VERSION D UN JEU (noyau pur, lot S1 ; contrat CONTRAT-SOURCES.md, section 3.1).
 *
 * Le socle versionne un jeu par (projet, role, concessionnaire) : une nouvelle livraison remplace la precedente a son autorisation. Le lot S1
 * ajoute la METHODE D ACQUISITION a cette cle POUR LES RESEAUX DE CONCESSIONNAIRE SEULEMENT : deux methodes differentes sont deux SOURCES du
 * meme reseau (chacune garde sa lignee de versions, aucune ne remplace l autre). Pour un plan d axes, des limites de route ou un jeu « autre »,
 * la methode est enregistree mais ne separe pas les lignees : deux plans d axes autorises a la fois doubleraient les axes de l analyse ; un
 * nouveau plan d axes reste une VERSION, qui se compare a la version autorisee AVANT son autorisation (comparaison « version candidate »).
 *
 * C est la meme regle que les index uniques partiels de la migration 20261103300000 (`CASE WHEN role = 'RESEAU_TIERS' ...`) : le service et la
 * base ne peuvent pas diverger sans qu un depot echoue sur l index (P2002).
 */

export interface JeuCle { projetId: string; role: string; concessionnaireId: string | null; methodeAcquisition?: string | null }

/** La methode fait-elle partie de la cle pour ce role ? */
export const methodeDansCle = (role: string): boolean => role === "RESEAU_TIERS";

/**
 * Filtre Prisma de la cle de version (a combiner avec un statut). Rend un objet litteral pour ne pas importer les types de Prisma dans un noyau pur :
 * `methodeAcquisition: null` designe la lignee sans methode (le comportement du socle).
 */
export function filtreCleVersion(j: JeuCle): { projetId: string; role: never; concessionnaireId: string | null; methodeAcquisition?: string | null } {
  return {
    projetId: j.projetId, role: j.role as never, concessionnaireId: j.concessionnaireId,
    ...(methodeDansCle(j.role) ? { methodeAcquisition: j.methodeAcquisition ?? null } : {}),
  };
}

/** Deux jeux sont-ils de la meme lignee de versions (meme cle) ? */
export function memeLignee(a: JeuCle, b: JeuCle): boolean {
  if (a.projetId !== b.projetId || a.role !== b.role || (a.concessionnaireId ?? null) !== (b.concessionnaireId ?? null)) return false;
  return !methodeDansCle(a.role) || (a.methodeAcquisition ?? null) === (b.methodeAcquisition ?? null);
}
