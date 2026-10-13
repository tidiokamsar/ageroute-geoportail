import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../lib/prisma";
import {
  domainesSansValidateur, DOMAINES_VALIDATION, type Delegation,
} from "../../governance/delegation";

/**
 * L'etat de la designation des validateurs (paragraphe 35 du cahier).
 *
 * POURQUOI CETTE ROUTE EXISTE, ET POURQUOI ELLE N'EST PAS SUR /api/health
 *
 * La regle de delegation est un RESSERREMENT PAR DOMAINE : tant qu'aucun validateur n'est
 * designe sur un domaine, la regle d'avant s'applique et tout ADMIN ou GESTIONNAIRE y
 * valide. Ce choix evitait d'arreter la validation le jour du deploiement.
 *
 * Mais ce depot a deja paye un defaut de cette forme : `modulesAutorises` vide valait
 * « aucune restriction », et c'etait SILENCIEUX. La seule difference ici est que l'etat de
 * la gouvernance se LIT. Sans cette route, le choix serait le meme defaut sous un autre
 * nom.
 *
 * J'avais d'abord pose ce compteur sur `/api/health`, a cote des echecs d'audit. C'etait
 * une faute : cette sonde est PUBLIQUE et se declare « volontairement muette sur les
 * details ». Publier la liste des domaines non designes y aurait appris a n'importe qui
 * OU le controle de validation est le plus lache — une carte des points faibles.
 *
 * La route est donc reservee a ADMIN, comme tout le routeur d'administration.
 */
export async function gouvernanceValidationHandler(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const delegations = (await prisma.delegationValidation.findMany({
      select: {
        domaine: true, validateurId: true, regionId: true,
        debutLe: true, finLe: true, revoqueeLe: true,
      },
    })) as Delegation[];

    const maintenant = new Date();
    const nonDesignes = domainesSansValidateur(delegations, maintenant);

    res.json({
      domaines: DOMAINES_VALIDATION.length,
      nonDesignes,
      // Un domaine non designe au lendemain du deploiement est normal. Sept pendant deux
      // ans ne l'est pas, et c'est ce rapport qui le dira.
      designes: DOMAINES_VALIDATION.length - nonDesignes.length,
      delegationsEnVigueur: delegations.filter(
        (d) => (d.revoqueeLe === null || d.revoqueeLe > maintenant)
          && d.debutLe <= maintenant
          && (d.finLe === null || d.finLe > maintenant),
      ).length,
    });
  } catch (err) {
    next(err);
  }
}
