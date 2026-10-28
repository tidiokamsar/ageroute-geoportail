import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { requireTerritoire, requireTerritoireMasque } from "../middleware/territoire.middleware";
import { prisma } from "../lib/prisma";
import { logAuditTransactionnelle } from "../utils/audit";
import { filtreRegionDuTroncon, regionsCorpsPrevision, regionsPrevision } from "../territoire/territoire.lecture";

/**
 * `/api/v2/programmation` — la prévision budgétaire devient un objet saisissable.
 *
 * AVANT : le tableau de programmation agrégeait les CHANTIERS existants (des faits) et
 * ne savait pas dire ce qui est PRÉVU. Le gestionnaire ne pouvait poser nulle part
 * « 2027 : réhabilitation de ce tronçon, 2,4 Md GNF, bailleur AFD » avant que cela ne
 * devienne un chantier. C'est la lacune que ce module comble, en saisie manuelle.
 *
 * L'AUTEUR VIENT DE LA SESSION, PAS DE LA REQUÊTE. Comme pour les défauts terrain :
 * `createdById` est pris sur l'utilisateur authentifié, jamais dans le corps.
 *
 * LA SOURCE N'ENTRE PAS PAR LA REQUÊTE. `source` vaut SAISIE sur tout ce que cette
 * route écrit : le jour où le moteur de coûts produira des prévisions (après D-07,
 * millésime et largeur des barèmes), ce sera une autre route qui signera MOTEUR — et
 * un chiffre calculé devra citer sa ligne de barème. Confondre un chiffre posé et un
 * chiffre calculé est précisément ce que le mandat interdit.
 *
 * LE MONTANT EST UNE CHAÎNE DE CHIFFRES. Un montant en GNF dépasse 2^53 : le passer
 * en nombre JSON le fausserait silencieusement. La route exige `^\d+$`, le rend en
 * chaîne, comme tous les BigInt du dépôt.
 *
 * AUCUN CHAMP N'EST PRÉREMPLI. Aucune année par défaut, aucun statut initial autre
 * que PROPOSE (la saisie EST une proposition ; RETENU est un arbitrage qui se trace),
 * aucun bailleur deviné. Les montants ne viennent que de la main qui les pose.
 *
 * SUPPRESSION LOGIQUE SEULE : le patrimoine routier est une donnée d'archive, et une
 * prévision retirée d'un programme reste un fait de programmation. Pas de verbe
 * DELETE : POST /:id/supprimer pose deletedAt, et l'histoire reste lisible.
 */

export const programmationV2Router = Router();
programmationV2Router.use(requireAuth, requireModuleAccess("programmation"));

/**
 * CONTROLE TERRITORIAL (A10). Une prevision n'a pas de region propre : elle herite de celle de son TRONCON
 * (meme derivation que les defauts et les portions). Un compte regional ne voit, ne modifie, ne supprime et
 * ne cree que les previsions dont le troncon est dans son perimetre ; une prevision SANS troncon a une
 * region inconnue, donc hors perimetre (decision D-C1-2 : enveloppes nationales visibles en lecture ?).
 * Hors perimetre, une prevision designee par son identifiant est introuvable (404, voir territoire.lecture.ts).
 */
const horsPerimetre = requireTerritoireMasque(
  (req) => regionsPrevision(req.params.id),
  { corps: { error: "prévision introuvable ou supprimée", code: "INTROUVABLE" } },
);
const creationDansPerimetre = requireTerritoire((req) => regionsCorpsPrevision(req.body, true));
const rattachementDansPerimetre = requireTerritoire((req) => regionsCorpsPrevision(req.body, false));

const STATUTS = ["PROPOSE", "RETENU", "REPORTE", "ANNULE", "REALISE"] as const;

const corpsMontant = z.string().regex(/^\d+$/, "montantPrevuGnf : chiffres attendus, en chaîne (GNF entiers)");

const corpsCreation = z.object({
  annee: z.number().int().min(2000).max(2100),
  intitule: z.string().trim().min(3).max(300),
  montantPrevuGnf: corpsMontant,
  tronconId: z.string().min(1).nullish(),
  bailleur: z.string().trim().max(120).nullish(),
  typeIntervention: z.string().trim().max(120).nullish(),
  priorite: z.number().int().min(1).nullish(),
  commentaire: z.string().trim().max(2000).nullish(),
}).strict();

const corpsEdition = z.object({
  annee: z.number().int().min(2000).max(2100).optional(),
  intitule: z.string().trim().min(3).max(300).optional(),
  montantPrevuGnf: corpsMontant.optional(),
  tronconId: z.string().min(1).nullable().optional(),
  bailleur: z.string().trim().max(120).nullable().optional(),
  typeIntervention: z.string().trim().max(120).nullable().optional(),
  priorite: z.number().int().min(1).nullable().optional(),
  statut: z.enum(STATUTS).optional(),
  commentaire: z.string().trim().max(2000).nullable().optional(),
}).strict();

function pageParams(req: Request) {
  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(String(req.query.pageSize ?? "20"), 10) || 20));
  return { page, pageSize };
}

function ligneApi(l: {
  id: string; annee: number; intitule: string; tronconId: string | null; bailleur: string | null;
  typeIntervention: string | null; montantPrevuGnf: bigint; priorite: number | null; statut: string;
  source: string; commentaire: string | null; createdAt: Date; updatedAt: Date;
  troncon?: { code: string } | null;
}) {
  return {
    id: l.id, annee: l.annee, intitule: l.intitule,
    tronconId: l.tronconId, tronconCode: l.troncon?.code ?? null,
    bailleur: l.bailleur, typeIntervention: l.typeIntervention,
    montantPrevuGnf: l.montantPrevuGnf.toString(),
    priorite: l.priorite, statut: l.statut, source: l.source,
    commentaire: l.commentaire, createdAt: l.createdAt, updatedAt: l.updatedAt,
  };
}

/** Liste paginée des prévisions non supprimées, filtrable comme l'écran. */
programmationV2Router.get("/", async (req, res, next) => {
  try {
    const { page, pageSize } = pageParams(req);
    const where: Record<string, unknown> = { deletedAt: null, ...(await filtreRegionDuTroncon(req.user!)) };
    if (req.query.annee) where["annee"] = Number(req.query.annee);
    if (req.query.statut) where["statut"] = String(req.query.statut);
    if (req.query.bailleur) where["bailleur"] = String(req.query.bailleur);
    if (req.query.tronconId) where["tronconId"] = String(req.query.tronconId);

    const [total, rows] = await Promise.all([
      prisma.programmeBudgetaire.count({ where }),
      prisma.programmeBudgetaire.findMany({
        where,
        include: { troncon: { select: { code: true } } },
        orderBy: [{ annee: "asc" }, { priorite: "asc" }, { createdAt: "asc" }],
        skip: (page - 1) * pageSize, take: pageSize,
      }),
    ]);
    res.json({ data: rows.map(ligneApi), total, page, pageSize });
  } catch (err) { next(err); }
});

/** Agrégats par année et statut — ce que l'écran compare aux chantiers. */
programmationV2Router.get("/totaux", async (req, res, next) => {
  try {
    const lignes = await prisma.programmeBudgetaire.findMany({
      where: { deletedAt: null, ...(await filtreRegionDuTroncon(req.user!)) },
      select: { annee: true, statut: true, montantPrevuGnf: true },
    });
    const parAnnee = new Map<number, { annee: number; nb: number; montantGnf: bigint; parStatut: Record<string, { nb: number; montantGnf: string }> }>();
    for (const l of lignes) {
      const e = parAnnee.get(l.annee) ?? { annee: l.annee, nb: 0, montantGnf: 0n, parStatut: {} };
      e.nb += 1; e.montantGnf += l.montantPrevuGnf;
      const s = e.parStatut[l.statut] ?? { nb: 0, montantGnf: "0" };
      // Le cumul par statut se fait en bigint puis se rend en chaîne : jamais en nombre.
      s.nb += 1;
      s.montantGnf = (BigInt(s.montantGnf) + l.montantPrevuGnf).toString();
      e.parStatut[l.statut] = s;
      parAnnee.set(l.annee, e);
    }
    res.json({
      parAnnee: [...parAnnee.values()].sort((a, b) => a.annee - b.annee)
        .map((e) => ({ ...e, montantGnf: e.montantGnf.toString() })),
    });
  } catch (err) { next(err); }
});

/** Saisir une prévision. GESTIONNAIRE et ADMIN : poser un montant est un acte de
 *  programmation, pas une lecture ni un relevé de terrain. */
programmationV2Router.post("/", requireRole("ADMIN", "GESTIONNAIRE"), creationDansPerimetre, async (req, res, next) => {
  try {
    const p = corpsCreation.safeParse(req.body);
    if (!p.success) {
      res.status(400).json({
        error: "corps invalide : annee, intitule (3 caractères minimum) et montantPrevuGnf (chaîne de chiffres, GNF) sont exigés",
        details: p.error.flatten().fieldErrors,
      }); return;
    }
    if (p.data.tronconId) {
      const troncon = await prisma.troncon.findUnique({ where: { id: p.data.tronconId }, select: { id: true } });
      if (!troncon) { res.status(400).json({ error: "tronçon inconnu", code: "TRONCON_INCONNU" }); return; }
    }
    const cree = await prisma.$transaction(async (tx) => {
      const ligne = await tx.programmeBudgetaire.create({
        data: {
          annee: p.data.annee,
          intitule: p.data.intitule,
          montantPrevuGnf: BigInt(p.data.montantPrevuGnf),
          tronconId: p.data.tronconId ?? null,
          bailleur: p.data.bailleur ?? null,
          typeIntervention: p.data.typeIntervention ?? null,
          priorite: p.data.priorite ?? null,
          commentaire: p.data.commentaire ?? null,
          statut: "PROPOSE",
          source: "SAISIE",
          createdById: req.user!.id,
        },
        include: { troncon: { select: { code: true } } },
      });
      await logAuditTransactionnelle(tx, {
        userId: req.user!.id, action: "CREATE", entityType: "ProgrammeBudgetaire",
        entityId: ligne.id,
        after: { annee: ligne.annee, intitule: ligne.intitule, montantPrevuGnf: p.data.montantPrevuGnf, statut: "PROPOSE", source: "SAISIE" },
        ipAddress: req.ip,
      });
      return ligne;
    });
    res.status(201).json(ligneApi(cree)); return;
  } catch (err) { next(err); }
});

/** Réviser une prévision : l'exercice budgétaire se corrige en cours d'année, chaque
 *  correction s'écrit. Le statut change par la même porte (arbitrage tracé). */
programmationV2Router.patch("/:id", requireRole("ADMIN", "GESTIONNAIRE"), horsPerimetre, rattachementDansPerimetre, async (req, res, next) => {
  try {
    const existante = await prisma.programmeBudgetaire.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!existante) { res.status(404).json({ error: "prévision introuvable ou supprimée", code: "INTROUVABLE" }); return; }

    const p = corpsEdition.safeParse(req.body);
    if (!p.success) {
      res.status(400).json({ error: "corps invalide", details: p.error.flatten().fieldErrors }); return;
    }
    if (p.data.tronconId) {
      const troncon = await prisma.troncon.findUnique({ where: { id: p.data.tronconId }, select: { id: true } });
      if (!troncon) { res.status(400).json({ error: "tronçon inconnu", code: "TRONCON_INCONNU" }); return; }
    }
    const data: Record<string, unknown> = {};
    if (p.data.annee !== undefined) data["annee"] = p.data.annee;
    if (p.data.intitule !== undefined) data["intitule"] = p.data.intitule;
    if (p.data.montantPrevuGnf !== undefined) data["montantPrevuGnf"] = BigInt(p.data.montantPrevuGnf);
    if (p.data.tronconId !== undefined) data["tronconId"] = p.data.tronconId;
    if (p.data.bailleur !== undefined) data["bailleur"] = p.data.bailleur;
    if (p.data.typeIntervention !== undefined) data["typeIntervention"] = p.data.typeIntervention;
    if (p.data.priorite !== undefined) data["priorite"] = p.data.priorite;
    if (p.data.statut !== undefined) data["statut"] = p.data.statut;
    if (p.data.commentaire !== undefined) data["commentaire"] = p.data.commentaire;

    const modifiee = await prisma.$transaction(async (tx) => {
      const ligne = await tx.programmeBudgetaire.update({
        where: { id: existante.id }, data,
        include: { troncon: { select: { code: true } } },
      });
      await logAuditTransactionnelle(tx, {
        userId: req.user!.id, action: "UPDATE", entityType: "ProgrammeBudgetaire",
        entityId: ligne.id,
        before: { annee: existante.annee, statut: existante.statut, montantPrevuGnf: existante.montantPrevuGnf.toString() },
        after: { annee: ligne.annee, statut: ligne.statut, montantPrevuGnf: ligne.montantPrevuGnf.toString() },
        ipAddress: req.ip,
      });
      return ligne;
    });
    res.json(ligneApi(modifiee)); return;
  } catch (err) { next(err); }
});

/** Retirer une prévision d'un programme : suppression logique, jamais physique. */
programmationV2Router.post("/:id/supprimer", requireRole("ADMIN", "GESTIONNAIRE"), horsPerimetre, async (req, res, next) => {
  try {
    const existante = await prisma.programmeBudgetaire.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!existante) { res.status(404).json({ error: "prévision introuvable ou déjà supprimée", code: "INTROUVABLE" }); return; }

    await prisma.$transaction(async (tx) => {
      await tx.programmeBudgetaire.update({ where: { id: existante.id }, data: { deletedAt: new Date() } });
      await logAuditTransactionnelle(tx, {
        userId: req.user!.id, action: "DELETE", entityType: "ProgrammeBudgetaire",
        entityId: existante.id,
        after: { supprimee: true, annee: existante.annee, intitule: existante.intitule },
        ipAddress: req.ip,
      });
    });
    res.json({ ok: true, id: existante.id }); return;
  } catch (err) { next(err); }
});
