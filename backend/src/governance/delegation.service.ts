import { prisma } from "../lib/prisma";
import {
  validationDeleguee, type DomaineValidation, type Delegation, type VerdictDelegation,
} from "./delegation";

/**
 * Lit les designations et rend le verdict de delegation.
 *
 * POURQUOI CETTE FONCTION EXISTE
 *
 * Deux routes consultent les delegations — les defauts et les observations — et d'autres
 * suivront. Recopier la lecture dans chacune produirait des copies qui divergent, et la
 * divergence serait invisible : chaque route continuerait de passer ses propres tests
 * pendant que l'une appliquerait une regle que l'autre ignore.
 *
 * Ce depot a precisement trouve une copie de ce genre : l'ancien module de regles des
 * observations (supprime depuis) portait un second `validationPermise` avec son propre `ROLES_VALIDATEURS`, teste
 * isolement et utilise par personne. Elle n'avait pas la verification de delegation.
 *
 * ON NE FILTRE PAS SUR LE VALIDATEUR, ET C'EST ESSENTIEL
 *
 * La requete rend TOUTES les delegations du domaine. La regle en a besoin pour distinguer
 * « personne n'est designe » — et alors la regle d'avant s'applique — de « quelqu'un
 * l'est, mais pas vous ». Filtrer sur `validateurId` rendrait une liste vide dans les deux
 * cas, et le resserrement par domaine deviendrait indistinguable d'une absence de
 * designation.
 */
export async function verdictDelegation(opts: {
  domaine: DomaineValidation;
  /** Region de l'objet a valider. NULLE quand elle n'est pas connue. */
  regionId: number | null;
  validateurId: string;
  maintenant?: Date;
}): Promise<VerdictDelegation> {
  const delegationsDuDomaine = (await prisma.delegationValidation.findMany({
    where: { domaine: opts.domaine },
    select: {
      domaine: true, validateurId: true, regionId: true,
      debutLe: true, finLe: true, revoqueeLe: true,
    },
  })) as Delegation[];

  return validationDeleguee({
    delegationsDuDomaine,
    validateurId: opts.validateurId,
    domaine: opts.domaine,
    regionId: opts.regionId,
    maintenant: opts.maintenant ?? new Date(),
  });
}
