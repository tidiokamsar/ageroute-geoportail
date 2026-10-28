import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { queryBoolean } from "../../lib/list-query";
import { ApiError } from "../../middleware/error.middleware";
import { logAuditTransactionnelle, construireAudit } from "../../utils/audit";
import {
  designationPermise, revocationPermise, delegationEnVigueur,
  domainesSansChemindeValidation,
  DOMAINES_VALIDATION, DOMAINES_AVEC_CHEMIN_DE_VALIDATION, EXPLICATIONS_DESIGNATION,
} from "../../governance/delegation";
import { ROLES_VALIDATEURS } from "../../governance/validation";

/**
 * Designer et revoquer des validateurs (paragraphe 35 du cahier).
 *
 * POURQUOI CES ROUTES NE SONT PAS RESERVEES A ADMIN
 *
 * Tout le reste du routeur d'administration l'est. Celles-ci ne peuvent pas l'etre :
 * AGEROUTE a confie la designation a la DIRECTION TECHNIQUE, qui n'est pas administrateur
 * de la plateforme. Reserver la designation a ADMIN reviendrait a refuser la decision
 * qu'on vient de prendre.
 *
 * Le droit est donc porte par `users.peutDeleguerValidation`, et ces routes le verifient
 * elles-memes. Un ADMIN en est dispense : il administre les comptes, donc il peut de toute
 * facon se l'accorder.
 */

const creation = z.object({
  domaine: z.enum(DOMAINES_VALIDATION as unknown as [string, ...string[]]),
  validateurId: z.string().uuid(),
  /** NUL = national. Un entier = cette region seulement. */
  regionId: z.number().int().positive().nullable().optional(),
  debutLe: z.string().datetime().optional(),
  finLe: z.string().datetime().nullable().optional(),
  motif: z.string().max(2000).optional(),
}).strict();

/**
 * Les designations, en vigueur ou non : une delegation expiree a existe.
 *
 * RESERVEE AUX MEMES QUE LA DESIGNATION, ET POUR LA MEME RAISON
 *
 * Cette liste dit qui est designe. Rapprochee des sept domaines connus, elle dit aussi
 * ou PERSONNE ne l'est — c'est-a-dire la meme carte des points faibles du controle de
 * validation que j'ai refuse de publier sur la sonde `/api/health`. La restreindre ici et
 * pas la l'aurait rendue accessible a tout compte authentifie.
 */
export async function listDelegationsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    const lecteur = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { role: true, peutDeleguerValidation: true },
    });
    if (lecteur?.role !== "ADMIN" && !lecteur?.peutDeleguerValidation) {
      throw new ApiError(403, "Consulter les désignations relève de la Direction Technique ou d'un administrateur.");
    }

    const q = z.object({
      domaine: z.enum(DOMAINES_VALIDATION as unknown as [string, ...string[]]).optional(),
      /** Par defaut on rend TOUT, historique compris : c'est ce qu'un audit demande. */
      enVigueurSeulement: queryBoolean,
    }).parse(req.query);

    const lignes = await prisma.delegationValidation.findMany({
      where: q.domaine ? { domaine: q.domaine as never } : {},
      orderBy: [{ domaine: "asc" }, { debutLe: "desc" }],
      include: {
        validateur: { select: { id: true, nomComplet: true, role: true } },
        deleguePar: { select: { id: true, nomComplet: true } },
        region: { select: { id: true, nom: true } },
      },
    });

    const maintenant = new Date();
    const avecEtat = lignes.map((l) => ({
      ...l,
      enVigueur: delegationEnVigueur(
        { domaine: l.domaine, validateurId: l.validateurId, regionId: l.regionId,
          debutLe: l.debutLe, finLe: l.finLe, revoqueeLe: l.revoqueeLe },
        maintenant,
      ),
    }));

    res.json(q.enVigueurSeulement ? avecEtat.filter((l) => l.enVigueur) : avecEtat);
  } catch (err) {
    next(err);
  }
}

export async function creerDelegationHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    const c = creation.parse(req.body);

    const delegant = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, role: true, peutDeleguerValidation: true, actif: true },
    });
    if (!delegant?.actif) throw new ApiError(403, "Compte inactif");

    const validateur = await prisma.user.findFirst({
      where: { id: c.validateurId, actif: true },
      select: { id: true, role: true },
    });
    // 422 et non 404 : l'identifiant vient du corps, pas de l'URL, et un administrateur
    // doit comprendre que c'est sa saisie qui est en cause.
    if (!validateur) throw new ApiError(422, "Compte à désigner introuvable ou inactif");

    if (c.regionId != null) {
      const region = await prisma.region.findUnique({ where: { id: c.regionId }, select: { id: true } });
      if (!region) throw new ApiError(422, "Région introuvable");
    }

    const debutLe = c.debutLe ? new Date(c.debutLe) : new Date();
    const finLe = c.finLe ? new Date(c.finLe) : null;

    const verdict = designationPermise({
      delegantId: delegant.id,
      delegantRole: delegant.role,
      delegantPeutDeleguer: delegant.peutDeleguerValidation,
      validateurId: validateur.id,
      validateurRole: validateur.role,
      debutLe,
      finLe,
    });
    if (!verdict.permis) {
      // 403 pour un defaut d'autorite, 422 pour une saisie qui ne tient pas : les deux ne
      // se corrigent pas de la meme facon.
      const code = verdict.motif === "DROIT_DE_DELEGUER_ABSENT" || verdict.motif === "AUTO_DESIGNATION"
        ? 403 : 422;
      return res.status(code).json({
        message: EXPLICATIONS_DESIGNATION[verdict.motif],
        motif: verdict.motif,
      });
    }

    const creee = await prisma.$transaction(async (tx) => {
      const ligne = await tx.delegationValidation.create({
        data: {
          domaine: c.domaine as never,
          validateurId: validateur.id,
          regionId: c.regionId ?? null,
          delegueParId: delegant.id,
          debutLe,
          finLe,
          motif: c.motif ?? null,
        },
      });
      // Designer un validateur est un acte de gouvernance : il part avec sa trace ou il
      // ne part pas.
      await logAuditTransactionnelle(tx, {
        userId: delegant.id,
        action: "CREATE",
        entityType: "DelegationValidation",
        entityId: ligne.id,
        after: {
          domaine: ligne.domaine, validateurId: ligne.validateurId,
          regionId: ligne.regionId, debutLe: ligne.debutLe, finLe: ligne.finLe,
          motif: ligne.motif,
        },
        ipAddress: req.ip,
      });
      return ligne;
    });

    return res.status(201).json(creee);
  } catch (err) {
    return next(err);
  }
}

/**
 * Revoquer. La ligne RESTE en base, avec sa date de revocation.
 *
 * Des validations ont ete rendues sous son autorite : les supprimer les rendrait
 * inexplicables. Regle 2 d'AGENTS.md appliquee a un objet de gouvernance.
 */
export async function revoquerDelegationHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    const { motif } = z.object({ motif: z.string().max(2000).optional() }).strict().parse(req.body ?? {});

    const delegation = await prisma.delegationValidation.findUnique({
      where: { id: req.params.id },
      select: { id: true, delegueParId: true, revoqueeLe: true, domaine: true },
    });
    if (!delegation) throw new ApiError(404, "Délégation introuvable");
    if (delegation.revoqueeLe !== null) {
      // 409 : l'etat ne permet pas l'action, et reessayer n'y changera rien.
      return res.status(409).json({ message: "Cette délégation est déjà révoquée." });
    }

    if (!revocationPermise({
      revocateurId: req.user.id,
      revocateurRole: req.user.role,
      delegueParId: delegation.delegueParId,
    })) {
      return res.status(403).json({
        message: "Seul l'auteur de la désignation, ou un administrateur, peut la révoquer.",
        motif: "REVOCATION_NON_AUTORISEE",
      });
    }

    const maintenant = new Date();
    await prisma.$transaction([
      prisma.delegationValidation.update({
        where: { id: delegation.id },
        data: { revoqueeLe: maintenant, revoqueeParId: req.user.id, motif: motif ?? undefined },
      }),
      construireAudit({
        userId: req.user.id,
        action: "DELETE",
        entityType: "DelegationValidation",
        entityId: delegation.id,
        before: { domaine: delegation.domaine, revoqueeLe: null },
        after: { revoqueeLe: maintenant, motif: motif ?? null },
        ipAddress: req.ip,
      }),
    ]);

    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
}

/**
 * Les domaines qui valident, et ceux ou designer serait sans effet.
 *
 * POURQUOI CECI N'EST PAS RESERVE A ADMIN, CONTRAIREMENT AU RAPPORT DE GOUVERNANCE
 *
 * `/api/admin/gouvernance/validation` est reserve, parce qu'il dit ou PERSONNE n'est
 * designe : une carte des points faibles du controle de validation.
 *
 * Ceci est autre chose. « Aucune route ne valide un troncon » est une propriete du
 * LOGICIEL, identique pour tout le monde et lisible dans le code. La taire a la Direction
 * Technique serait absurde : c'est elle qui designe, et c'est donc elle qui doit savoir
 * que designer sur cinq des sept domaines ne changerait rien aujourd'hui.
 */
export async function domainesValidationHandler(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json({
      actifs: [...DOMAINES_AVEC_CHEMIN_DE_VALIDATION],
      sansChemindeValidation: domainesSansChemindeValidation(),
      total: DOMAINES_VALIDATION.length,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Les comptes qu'on peut designer validateur.
 *
 * POURQUOI CETTE ROUTE EXISTE PLUTOT QUE D'OUVRIR `/api/users`
 *
 * Le routeur des utilisateurs est reserve a ADMIN, et la Direction Technique n'en est pas.
 * Sans cette route, elle ne pourrait designer personne depuis l'interface — le droit lui
 * aurait ete accorde sans moyen de l'exercer.
 *
 * L'ouvrir a `/api/users` aurait divulgue les adresses, les dates de derniere connexion et
 * l'etat du second facteur de tous les comptes. Ici, trois champs : l'identifiant, le nom
 * et le role. C'est ce qu'il faut pour choisir, et rien de plus.
 *
 * Les LECTEUR et INSPECTEUR sont exclus : `ROLES_VALIDATEURS` ne les admet pas, et les
 * designer creerait une delegation qui ne servirait jamais.
 */
export async function validateursPossiblesHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    const lecteur = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { role: true, peutDeleguerValidation: true },
    });
    if (lecteur?.role !== "ADMIN" && !lecteur?.peutDeleguerValidation) {
      throw new ApiError(403, "Désigner un validateur relève de la Direction Technique ou d'un administrateur.");
    }

    const comptes = await prisma.user.findMany({
      where: { actif: true, role: { in: [...ROLES_VALIDATEURS] as never } },
      select: { id: true, nomComplet: true, role: true },
      orderBy: { nomComplet: "asc" },
    });
    // Soi-meme exclu a la source : l'auto-designation est refusee, et proposer un choix
    // qui sera rejete fait perdre du temps a l'utilisateur.
    res.json(comptes.filter((c) => c.id !== req.user!.id));
  } catch (err) {
    next(err);
  }
}
