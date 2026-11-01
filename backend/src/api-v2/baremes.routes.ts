import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { prisma } from "../lib/prisma";
import { logAuditTransactionnelle } from "../utils/audit";

/**
 * `/api/v2/baremes` — les neuf lignes de prix deviennent administrables, sans toucher
 * à un seul coût par défaut.
 *
 * DÉVERROUILLER L'AIDE À LA DÉCISION (D-07). Le moteur de coût refuse d'estimer tant
 * que la ligne n'est ni APPROUVÉE, ni MILLÉSIMÉE, ni LARGEURÉE — et il a raison :
 * « 3,5 milliards GNF/km » sans année ni largeur de chaussée ne se compare à rien et
 * ne s'actualise jamais. Les neuf lignes d'origine portent ces champs à NULL
 * volontairement : personne ne sait pour quelle année ni quelle largeur elles ont été
 * posées. Cette route est l'endroit où AGEROUTE (et l'ONR comme dépositaire des prix
 * unitaires) pose LA réponse — elle ne la devine jamais.
 *
 * TOUTE MODIFICATION DÉSAPPROUVE. Version++ et approuveLe = null : un prix édité
 * n'est plus un prix arrêté, il redemande son approbation. Sans ce reset, on
 * « approuverait » un chiffre que plus personne n'a lu.
 *
 * L'APPROBATION EST ADMIN ET EXIGE LE MINIMUM DE LECTURE. Approuver une ligne sans
 * millésime ni largeur serait signer un prix illisible : la route refuse, avec le
 * motif. C'est le même geste qui rend une estimation publiable.
 *
 * LE COÛT EST UNE CHAÎNE DE CHIFFRES (BigInt au-delà de 2^53, comme partout).
 *
 * CE QUE CETTE ROUTE NE FAIT PAS : ni créer ni supprimer des lignes. Les neuf lignes
 * sont la structure (famille × état de départ, contrainte UNIQUE en base) ; ajouter
 * une famille ou un état est une décision de modélisation qui passera par une
 * migration, pas par une requête.
 */

export const baremesV2Router = Router();
baremesV2Router.use(requireAuth, requireModuleAccess("decision"));

const corpsEdition = z.object({
  coutKmGnf: z.string().regex(/^\d+$/, "coutKmGnf : chiffres attendus, en chaîne (GNF entiers)").optional(),
  anneeReference: z.number().int().min(1990).max(2100).nullable().optional(),
  largeurChausseeM: z.number().positive().max(30).nullable().optional(),
  libelle: z.string().trim().min(1).max(200).optional(),
  commentaire: z.string().trim().max(2000).nullable().optional(),
}).strict();

function ligneApi(l: {
  id: number; familleRevetement: string; etatDepart: string; typeIntervention: string;
  coutKmGnf: bigint; code: string | null; libelle: string | null; source: string; version: number;
  approuveLe: Date | null; approuveParId: string | null; anneeReference: number | null;
  largeurChausseeM: { toString(): string } | null; commentaire: string | null;
  approuvePar?: { email: string } | null;
}) {
  return {
    id: l.id, familleRevetement: l.familleRevetement, etatDepart: l.etatDepart,
    typeIntervention: l.typeIntervention, coutKmGnf: l.coutKmGnf.toString(),
    code: l.code, libelle: l.libelle, source: l.source, version: l.version,
    approuveLe: l.approuveLe, approuvePar: l.approuvePar?.email ?? null,
    anneeReference: l.anneeReference, largeurChausseeM: l.largeurChausseeM?.toString() ?? null,
    commentaire: l.commentaire,
  };
}

baremesV2Router.get("/", async (_req, res, next) => {
  try {
    const lignes = await prisma.baremeIntervention.findMany({
      include: { approuvePar: { select: { email: true } } },
      orderBy: [{ familleRevetement: "asc" }, { etatDepart: "asc" }],
    });
    res.json({ data: lignes.map(ligneApi) });
  } catch (err) { next(err); }
});

baremesV2Router.patch("/:id", requireRole("ADMIN", "GESTIONNAIRE"), async (req, res, next) => {
  try {
    const existante = await prisma.baremeIntervention.findUnique({ where: { id: Number(req.params.id) } });
    if (!existante) { res.status(404).json({ error: "ligne de barème introuvable", code: "INTROUVABLE" }); return; }

    const p = corpsEdition.safeParse(req.body);
    if (!p.success) {
      res.status(400).json({ error: "corps invalide", details: p.error.flatten().fieldErrors }); return;
    }
    if (Object.keys(p.data).length === 0) {
      res.status(400).json({ error: "aucun champ à modifier" }); return;
    }

    const data: Record<string, unknown> = {};
    if (p.data.coutKmGnf !== undefined) data["coutKmGnf"] = BigInt(p.data.coutKmGnf);
    if (p.data.anneeReference !== undefined) data["anneeReference"] = p.data.anneeReference;
    if (p.data.largeurChausseeM !== undefined) data["largeurChausseeM"] = p.data.largeurChausseeM;
    if (p.data.libelle !== undefined) data["libelle"] = p.data.libelle;
    if (p.data.commentaire !== undefined) data["commentaire"] = p.data.commentaire;
    // Toute modification désapprouve et incrémente : un prix édité n'est plus un prix arrêté.
    data["version"] = existante.version + 1;
    data["approuveLe"] = null;
    data["approuveParId"] = null;

    const modifiee = await prisma.$transaction(async (tx) => {
      const ligne = await tx.baremeIntervention.update({
        where: { id: existante.id }, data,
        include: { approuvePar: { select: { email: true } } },
      });
      await logAuditTransactionnelle(tx, {
        userId: req.user!.id, action: "UPDATE", entityType: "BaremeIntervention",
        entityId: String(ligne.id),
        before: {
          coutKmGnf: existante.coutKmGnf.toString(), anneeReference: existante.anneeReference,
          largeurChausseeM: existante.largeurChausseeM?.toString() ?? null,
          version: existante.version, approuveLe: existante.approuveLe,
        },
        after: {
          coutKmGnf: ligne.coutKmGnf.toString(), anneeReference: ligne.anneeReference,
          largeurChausseeM: ligne.largeurChausseeM?.toString() ?? null,
          version: ligne.version, approuveLe: ligne.approuveLe,
        },
        ipAddress: req.ip,
      });
      return ligne;
    });
    res.json(ligneApi(modifiee)); return;
  } catch (err) { next(err); }
});

baremesV2Router.post("/:id/approuver", requireRole("ADMIN"), async (req, res, next) => {
  try {
    const existante = await prisma.baremeIntervention.findUnique({ where: { id: Number(req.params.id) } });
    if (!existante) { res.status(404).json({ error: "ligne de barème introuvable", code: "INTROUVABLE" }); return; }

    const manquants: string[] = [];
    if (existante.anneeReference == null) manquants.push("millésime (anneeReference)");
    if (existante.largeurChausseeM == null) manquants.push("largeur de chaussée de référence (largeurChausseeM)");
    if (manquants.length > 0) {
      res.status(422).json({
        error: `approuver un prix illisible est refusé : manque ${manquants.join(" et ")}`,
        code: "PRIX_ILLISIBLE",
      }); return;
    }

    const approuvee = await prisma.$transaction(async (tx) => {
      const ligne = await tx.baremeIntervention.update({
        where: { id: existante.id },
        data: { approuveLe: new Date(), approuveParId: req.user!.id },
        include: { approuvePar: { select: { email: true } } },
      });
      await logAuditTransactionnelle(tx, {
        userId: req.user!.id, action: "VALIDATE", entityType: "BaremeIntervention",
        entityId: String(ligne.id),
        after: {
          coutKmGnf: ligne.coutKmGnf.toString(), anneeReference: ligne.anneeReference,
          largeurChausseeM: ligne.largeurChausseeM?.toString() ?? null,
          approuvePar: req.user!.email ?? null, version: ligne.version,
        },
        ipAddress: req.ip,
      });
      return ligne;
    });
    res.json(ligneApi(approuvee)); return;
  } catch (err) { next(err); }
});
