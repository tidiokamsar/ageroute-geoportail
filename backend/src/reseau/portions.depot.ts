/**
 * Implementation Prisma du depot des portions.
 *
 * Les regles vivent dans `portions.ts`, l'orchestration dans `portions.service.ts`, tous
 * deux testes sans base. Ici il n'y a que des requetes, et trois garanties.
 *
 * TOUT OU RIEN
 *
 * `appliquer` ecrit les portions, marque les remplacees, inscrit le lignage, derive les
 * geometries et audite DANS UNE SEULE TRANSACTION. Une portion inseree sans que son parent
 * soit marque remplace creerait un chevauchement silencieux ; un parent marque sans que
 * l'enfant existe creerait un trou. Les deux etats intermediaires sont faux.
 *
 * L'AUDIT EST DANS LA TRANSACTION
 *
 * `logAuditTransactionnelle` et non `logAudit` : la regle 3 d'AGENTS.md veut que toute
 * ecriture soit auditee, et un audit pose hors transaction pourrait survivre a un rollback
 * ou disparaitre apres un commit. Les deux rendraient le journal faux.
 *
 * LA GEOMETRIE NE FAIT PAS ECHOUER L'ECRITURE
 *
 * Une portion sans geometrie derivee reste parfaitement valide : ce sont les ABSCISSES qui
 * font autorite, la geometrie n'est qu'un cache pour la carte. Si le troncon n'a pas de
 * trace exploitable, la portion existe quand meme et son `geom` reste nul.
 */
import { AuditAction, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { logAuditTransactionnelle } from "../utils/audit";
import { deriveLigneFromTronconAbscisses } from "../lib/geo";
import type { DepotPortions, Ecriture } from "./portions.service";
import type { Portion } from "./portions";

const CHAMPS = {
  id: true, tronconId: true, debutM: true, finM: true,
  revetement: true, etat: true, praticabilite: true, largeurM: true,
  source: true, observeeLe: true, confiance: true,
  statutValidation: true, origine: true, clientOperationId: true,
  remplaceeLe: true, deletedAt: true,
} as const;

async function longueurTronconM(tronconId: string): Promise<number | null> {
  const r = await prisma.$queryRaw<{ longueurM: number | null }[]>`
    SELECT ST_Length(geom::geography) AS "longueurM"
      FROM troncons
     WHERE id = ${tronconId}::text AND geom IS NOT NULL
  `;
  const v = r[0]?.longueurM ?? null;
  return v !== null && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Portions du troncon, HISTORIQUE COMPRIS.
 *
 * Contrairement a la lecture de contexte, qui ne charge que le courant : les refus
 * d'ecriture doivent voir les portions remplacees, sans quoi `refusFusion` accepterait de
 * fusionner de l'historique.
 */
async function portionsDuTroncon(tronconId: string): Promise<Portion[]> {
  return prisma.portion.findMany({
    where: { tronconId, deletedAt: null },
    orderBy: { debutM: "asc" },
    select: CHAMPS,
  });
}

async function portionParId(id: string): Promise<Portion | null> {
  return prisma.portion.findFirst({ where: { id, deletedAt: null }, select: CHAMPS });
}

async function portionParCleClient(cle: string): Promise<Portion | null> {
  return prisma.portion.findFirst({ where: { clientOperationId: cle }, select: CHAMPS });
}

async function appliquer(e: Ecriture): Promise<Portion[]> {
  return prisma.$transaction(async (tx) => {
    const maintenant = new Date();

    // Les remplacements D'ABORD : si une insertion devait echouer, rien n'a ete marque
    // pour rien, puisque la transaction entiere retombe.
    if (e.remplacer.length > 0) {
      const avant = await tx.portion.findMany({
        where: { id: { in: e.remplacer } },
        select: CHAMPS,
      });
      await tx.portion.updateMany({
        where: { id: { in: e.remplacer }, remplaceeLe: null },
        data: { remplaceeLe: maintenant },
      });
      for (const p of avant) {
        await logAuditTransactionnelle(tx, {
          userId: e.auteurId,
          action: AuditAction.UPDATE,
          entityType: "Portion",
          entityId: p.id,
          before: p,
          after: { ...p, remplaceeLe: maintenant, operation: e.operation },
        });
      }
    }

    const creees: Portion[] = [];
    for (let i = 0; i < e.inserer.length; i++) {
      const creee = await tx.portion.create({
        data: { ...e.inserer[i], creeParId: e.auteurId },
        select: CHAMPS,
      });

      // La geometrie est posee APRES l'insertion : Prisma ne sait pas ecrire une colonne
      // `Unsupported("geometry")`, et le SQL brut a besoin de l'identifiant.
      //
      // Les ABSCISSES sont passees telles quelles : le helper divise par la longueur
      // geodesique du troncon, qui est la meme reference que celle ayant servi a mesurer
      // l'abscisse. La conversion est donc exacte par construction, et la faire ici en
      // double aurait introduit une seconde source de verite.
      await deriveLigneFromTronconAbscisses(
        tx as unknown as { $executeRawUnsafe(sql: string, ...a: unknown[]): Promise<number> },
        "portions",
        creee.id,
        e.tronconId,
        e.inserer[i].debutM,
        e.inserer[i].finM,
      );

      await logAuditTransactionnelle(tx, {
        userId: e.auteurId,
        action: AuditAction.CREATE,
        entityType: "Portion",
        entityId: creee.id,
        after: { ...creee, operation: e.operation },
      });
      creees.push(creee);
    }

    // Le lignage en DERNIER : ses cles etrangeres exigent que parents et enfants
    // existent tous.
    if (e.lignage.length > 0) {
      await tx.portionLignage.createMany({
        data: e.lignage.map((l) => ({
          parentId: l.parentId,
          enfantId: creees[l.enfantIndex].id,
        })),
        skipDuplicates: true,
      });
    }

    return creees;
  });
}

/**
 * Applique une decision de validation, en compare-et-echange.
 *
 * Le `statutValidation` attendu figure dans le `where` : deux validateurs partis du meme
 * etat ne peuvent pas tous deux gagner, et le second apprend que la decision a change au
 * lieu d'ecraser celle du premier. `portions` ne porte pas de colonne `version` comme
 * `defauts` ; le statut lui-meme suffit a departager, puisque c'est lui qui change.
 */
async function decider(
  id: string,
  statut: Portion["statutValidation"],
  decideParId: string,
  commentaire: string | null,
): Promise<Portion> {
  return prisma.$transaction(async (tx) => {
    const avant = await tx.portion.findFirst({ where: { id, deletedAt: null }, select: CHAMPS });
    if (!avant) throw new PortionIntrouvable(id);

    const maj = await tx.portion.updateMany({
      where: { id, deletedAt: null, statutValidation: avant.statutValidation },
      data: { statutValidation: statut },
    });
    if (maj.count !== 1) throw new DecisionConcurrente(id);

    const apres = { ...avant, statutValidation: statut };
    await logAuditTransactionnelle(tx, {
      userId: decideParId,
      action: statut === "VALIDE" ? AuditAction.VALIDATE : AuditAction.REJECT,
      entityType: "Portion",
      entityId: id,
      before: avant,
      after: { ...apres, commentaire },
    });
    return apres;
  });
}

export class PortionIntrouvable extends Error {
  constructor(id: string) { super(`Portion introuvable : ${id}`); this.name = "PortionIntrouvable"; }
}
export class DecisionConcurrente extends Error {
  constructor(id: string) { super(`Decision concurrente sur la portion ${id}`); this.name = "DecisionConcurrente"; }
}

export const depotPrisma: DepotPortions = {
  longueurTronconM,
  portionsDuTroncon,
  portionParId,
  portionParCleClient,
  appliquer,
  decider,
};

/**
 * Auteur de la portion, LU EN BASE et jamais recu du client.
 *
 * C'est le point ou la separation des roles se tient ou tombe : un auteur fourni par
 * l'appelant desactiverait le controle d'auto-validation sans laisser de trace.
 */
export async function auteurDeLaPortion(id: string): Promise<string | null> {
  const r = await prisma.portion.findFirst({ where: { id }, select: { creeParId: true } });
  return r?.creeParId ?? null;
}

/** Utilise par les routes pour charger la region, qui conditionne la delegation. */
export async function regionDuTronconDeLaPortion(portionId: string): Promise<number | null> {
  const r = await prisma.portion.findFirst({
    where: { id: portionId },
    select: { troncon: { select: { regionId: true } } },
  });
  return r?.troncon?.regionId ?? null;
}

export { Prisma };
