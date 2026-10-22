import { Router, type Request } from "express";
import { randomUUID, createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { requireTerritoire } from "../middleware/territoire.middleware";
import { uploadPhoto } from "../middleware/upload-photo.middleware";
import { plafondPhotos } from "../middleware/quota-photos.middleware";
import { photoAbsolutePath } from "../lib/photos";
import { prisma } from "../lib/prisma";
import { logAuditTransactionnelle } from "../utils/audit";
import { regionDuTroncon, regionsFiche } from "../territoire/territoire.service";
import { regionDefaut } from "../territoire/territoire.v2";
import {
  EXPLICATIONS_MANQUE, MESSAGE_FRONTIERE, alertesRapprochement, champsContractuels, enRetard,
  manquesPourCloture, motifAbandonValide, transitionTachePermise, estTerminee,
  type StatutTache,
} from "../field/taches-internes.regles";

/**
 * `/api/v2/taches-internes` -- les taches d'intervention INTERNES, non contractuelles (TI-01, A29).
 *
 * « Une tache cloturee possede des preuves avant/apres » : la base le tient (contrainte
 * `tache_cloturee_avec_preuves`) ; cette route le dit avant elle, avec la liste de ce qui manque.
 *
 * LA FRONTIERE DIGITALROAD EST TENUE DEUX FOIS : la table n'a aucune colonne contractuelle, et cette
 * route refuse, en le disant, toute demande qui en porterait une. Aucun paiement, decompte ou marche
 * n'est cree ni modifie ici (critere A29).
 *
 * LE RAPPROCHEMENT EST EN LECTURE : `GET /rapprochement` ne cree, ne modifie et ne journalise rien. Il
 * compare des faits que la plateforme possede (tache, defaut, responsable, echeance) ; le rapprochement
 * physique / financier de TI-02 exige des donnees DigitalRoad qui n'existent pas encore (blocage B-11).
 */
export const tachesInternesV2Router = Router();

const ROLES_ECRITURE = ["ADMIN", "GESTIONNAIRE", "INSPECTEUR"] as const;
const gestionnaire = (role: string) => role === "ADMIN" || role === "GESTIONNAIRE";
const jourUtc = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

const creation = z.object({
  nature: z.string().min(1).max(64),
  intitule: z.string().trim().min(3).max(200),
  description: z.string().trim().max(5000).optional(),
  tronconId: z.string().min(1).max(64).optional(),
  debutM: z.number().min(0).optional(),
  finM: z.number().min(0).optional(),
  ouvrageId: z.string().min(1).max(64).optional(),
  defautId: z.string().min(1).max(64).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  responsableId: z.string().min(1).max(64).optional(),
  echeanceLe: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  clientOperationId: z.string().uuid().optional(),
}).strict();

const COLONNES = Prisma.sql`
  t."id", t."reference", t."nature", t."intitule", t."description", t."tronconId", t."debutM", t."finM",
  t."ouvrageId", t."defautId", ST_Y(t."geom") AS "lat", ST_X(t."geom") AS "lon", t."responsableId",
  t."echeanceLe", t."statut"::text AS "statut", t."quantiteConstatee"::float8 AS "quantiteConstatee", t."quantiteUnite",
  t."preuveAvantChemin", t."preuveAvantPriseLe", t."preuveApresChemin", t."preuveApresPriseLe",
  t."clotureeLe", t."clotureeParId", t."abandonMotif", t."clientOperationId", t."creeParId", t."createdAt", t."updatedAt"`;

interface LigneTache {
  id: string; reference: string; nature: string; intitule: string; description: string | null;
  tronconId: string | null; debutM: number | null; finM: number | null; ouvrageId: string | null; defautId: string | null;
  lat: number | null; lon: number | null; responsableId: string; echeanceLe: Date | null; statut: StatutTache;
  quantiteConstatee: number | null; quantiteUnite: string | null;
  preuveAvantChemin: string | null; preuveAvantPriseLe: Date | null; preuveApresChemin: string | null; preuveApresPriseLe: Date | null;
  clotureeLe: Date | null; clotureeParId: string | null; abandonMotif: string | null;
  clientOperationId: string | null; creeParId: string; createdAt: Date; updatedAt: Date;
}

/** La tache telle que l'API la rend : les preuves en bloc `preuves`, le retard calcule, jamais de chemin absolu. */
function vue(t: LigneTache) {
  const { preuveAvantChemin, preuveAvantPriseLe, preuveApresChemin, preuveApresPriseLe, ...reste } = t;
  return {
    ...reste,
    preuves: {
      avant: preuveAvantChemin ? { fichier: preuveAvantChemin, priseLe: preuveAvantPriseLe } : null,
      apres: preuveApresChemin ? { fichier: preuveApresChemin, priseLe: preuveApresPriseLe } : null,
    },
    enRetard: enRetard(t.echeanceLe, t.statut, new Date()),
  };
}

async function lire(db: Pick<typeof prisma, "$queryRaw">, id: string): Promise<LigneTache | null> {
  const l = await db.$queryRaw<LigneTache[]>`SELECT ${COLONNES} FROM "taches_internes" t WHERE t."id" = ${id} AND t."deletedAt" IS NULL`;
  return l[0] ?? null;
}

/** Une tache est visible par son responsable, son createur et les gestionnaires ; pour les autres, elle n'existe pas. */
const visible = (t: LigneTache, user: { id: string; role: string }) => gestionnaire(user.role) || t.responsableId === user.id || t.creeParId === user.id;

/** Region d'une tache : celle de son troncon, sinon de son ouvrage, sinon de son defaut ; inconnue pour un simple point GPS. */
async function regionDeLiens(l: { tronconId?: string | null; ouvrageId?: string | null; defautId?: string | null }): Promise<number | null> {
  if (l.tronconId) return regionDuTroncon(l.tronconId);
  if (l.ouvrageId) return (await regionsFiche("ouvrage", l.ouvrageId))[0] ?? null;
  if (l.defautId) return (await regionDefaut(l.defautId)) ?? null;
  return null;
}
const territoireCreation = requireTerritoire(async (req: Request) => [await regionDeLiens(req.body ?? {})]);
const territoireTache = requireTerritoire(async (req: Request) => {
  const t = await lire(prisma, req.params.id);
  return t ? [await regionDeLiens(t)] : [];
});

async function referenceSuivante(tx: Pick<typeof prisma, "tacheInterne" | "$executeRaw">): Promise<string> {
  const base = `TI-${new Date().getFullYear()}-`;
  // Verrou consultatif de TRANSACTION : l'attribution « compter puis inserer » est serialisee, deux
  // creations simultanees ne comptent plus la meme valeur. Il tombe a la fin de la transaction. La
  // contrainte d'unicite reste l'arbitre final (voir la reprise dans la route).
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('taches_internes.reference'))`;
  const n = await tx.tacheInterne.count({ where: { reference: { startsWith: base } } });
  return `${base}${String(n + 1).padStart(5, "0")}`;
}

/**
 * @openapi
 * /api/v2/taches-internes:
 *   post:
 *     summary: Cree une tache d'intervention interne
 *     description: >
 *       Rattachee a un troncon (avec ou sans emprise), un ouvrage, un defaut ou un point GPS. Aucun montant,
 *       marche ni entreprise : ces champs sont refuses. Idempotente par `clientOperationId`.
 *     tags: [Taches internes v2]
 */
tachesInternesV2Router.post("/", requireAuth, requireModuleAccess("inspections"), requireRole(...ROLES_ECRITURE), territoireCreation, async (req, res, next) => {
  try {
    const interdits = champsContractuels(req.body);
    if (interdits.length > 0) {
      return res.status(422).json({ message: MESSAGE_FRONTIERE, motif: "CHAMP_CONTRACTUEL_REFUSE", champs: interdits });
    }
    const c = creation.parse(req.body);
    const user = req.user!;

    // IDEMPOTENCE : la meme operation rejouee rend la meme tache, jamais une seconde.
    if (c.clientOperationId) {
      const existante = await prisma.tacheInterne.findUnique({ where: { clientOperationId: c.clientOperationId }, select: { id: true, creeParId: true } });
      if (existante) {
        // Une cle d'idempotence n'est pas un jeton d'acces : la tache d'un autre auteur ne se revele pas.
        if (existante.creeParId !== user.id) return res.status(409).json({ message: "Cle d'idempotence deja utilisee." });
        return res.status(200).json(vue((await lire(prisma, existante.id))!));
      }
    }

    // RATTACHEMENT : au moins un, et coherent. La base le tient aussi ; on le dit en mots.
    if ((c.lat === undefined) !== (c.lon === undefined)) return res.status(422).json({ message: "Position GPS incomplete : latitude et longitude vont ensemble.", motif: "POSITION_INCOMPLETE" });
    const gps = c.lat !== undefined && c.lon !== undefined;
    if (!c.tronconId && !c.ouvrageId && !c.defautId && !gps) {
      return res.status(422).json({ message: "Une tache se rattache a un troncon, un ouvrage, un defaut ou un point : sans cela elle ne se retrouve pas sur le terrain.", motif: "RATTACHEMENT_REQUIS" });
    }
    if ((c.debutM === undefined) !== (c.finM === undefined)) return res.status(422).json({ message: "Emprise incomplete : debut et fin vont ensemble.", motif: "EMPRISE_INCOMPLETE" });
    if (c.debutM !== undefined && c.finM !== undefined) {
      if (!c.tronconId) return res.status(422).json({ message: "Des abscisses sans troncon n'ont aucun systeme de reference.", motif: "EMPRISE_SANS_TRONCON" });
      if (c.finM <= c.debutM) return res.status(422).json({ message: "La fin de l'emprise doit depasser son debut.", motif: "EMPRISE_INVERSEE" });
    }

    const nature = await prisma.referentielNatureTache.findUnique({ where: { code: c.nature } });
    if (!nature || !nature.actif) return res.status(422).json({ message: `Nature de tache inconnue ou retiree : ${c.nature}.`, motif: "NATURE_INCONNUE" });
    if (c.tronconId && !(await prisma.troncon.findFirst({ where: { id: c.tronconId, deletedAt: null }, select: { id: true } }))) return res.status(422).json({ message: "Troncon introuvable.", motif: "TRONCON_INTROUVABLE" });
    if (c.ouvrageId && !(await prisma.ouvrage.findFirst({ where: { id: c.ouvrageId, deletedAt: null }, select: { id: true } }))) return res.status(422).json({ message: "Ouvrage introuvable.", motif: "OUVRAGE_INTROUVABLE" });
    if (c.defautId && !(await prisma.defaut.findFirst({ where: { id: c.defautId, deletedAt: null }, select: { id: true } }))) return res.status(422).json({ message: "Defaut introuvable.", motif: "DEFAUT_INTROUVABLE" });

    // RESPONSABLE : soi-meme par defaut. Confier une tache a un autre est un acte de gestion.
    const responsableId = c.responsableId ?? user.id;
    if (responsableId !== user.id && !gestionnaire(user.role)) return res.status(403).json({ message: "Seul un gestionnaire confie une tache a un autre agent.", motif: "AFFECTATION_RESERVEE" });
    const responsable = await prisma.user.findUnique({ where: { id: responsableId }, select: { actif: true } });
    if (!responsable?.actif) return res.status(422).json({ message: "Responsable introuvable ou inactif.", motif: "RESPONSABLE_INVALIDE" });

    const id = randomUUID();
    let tache: LigneTache | null = null;
    // La reference est comptee, la contrainte d'unicite arbitre : deux creations simultanees peuvent
    // compter la meme valeur. La perdante recompte (jamais d'erreur serveur pour une course).
    for (let essai = 1; ; essai += 1) {
      try {
        tache = await prisma.$transaction(async (tx) => {
          const reference = await referenceSuivante(tx);
          await tx.$executeRaw`
            INSERT INTO "taches_internes" ("id", "reference", "nature", "intitule", "description", "tronconId", "debutM", "finM", "ouvrageId", "defautId",
                                           "geom", "responsableId", "echeanceLe", "clientOperationId", "creeParId", "updatedAt")
            VALUES (${id}, ${reference}, ${c.nature}, ${c.intitule}, ${c.description ?? null}, ${c.tronconId ?? null}, ${c.debutM ?? null}, ${c.finM ?? null},
                    ${c.ouvrageId ?? null}, ${c.defautId ?? null},
                    CASE WHEN ${gps}::boolean THEN ST_SetSRID(ST_MakePoint(${c.lon ?? 0}::float8, ${c.lat ?? 0}::float8), 4326) END,
                    ${responsableId}, ${c.echeanceLe ?? null}::date, ${c.clientOperationId ?? null}, ${user.id}, (now() AT TIME ZONE 'UTC'))`;
          await logAuditTransactionnelle(tx, {
            userId: user.id, action: "CREATE", entityType: "TacheInterne", entityId: id,
            after: { reference, nature: c.nature, intitule: c.intitule, tronconId: c.tronconId, ouvrageId: c.ouvrageId, defautId: c.defautId, responsableId, echeanceLe: c.echeanceLe },
            ipAddress: req.ip,
          });
          return (await lire(tx, id))!;
          // L'attribution de la reference est serialisee par un verrou : la file d'attente de plusieurs
          // creations simultanees depasse les 5 s par defaut de Prisma, qui annulait la derniere.
        }, { timeout: 30_000, maxWait: 15_000 });
        break;
      } catch (err) {
        const unicite = err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2010" && /23505/.test(String((err.meta as { code?: string } | undefined)?.code ?? ""));
        const p2002 = err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
        if (!(unicite || p2002) || essai >= 5) throw err;
        // Le meme clientOperationId peut avoir gagne la course : on rend sa tache.
        if (c.clientOperationId) {
          const gagnante = await prisma.tacheInterne.findUnique({ where: { clientOperationId: c.clientOperationId }, select: { id: true, creeParId: true } });
          if (gagnante && gagnante.creeParId === user.id) return res.status(200).json(vue((await lire(prisma, gagnante.id))!));
        }
      }
    }
    return res.status(201).json(vue(tache!));
  } catch (err) {
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/taches-internes:
 *   get:
 *     summary: Liste les taches internes visibles par le compte
 *     tags: [Taches internes v2]
 */
tachesInternesV2Router.get("/", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const q = z.object({
      statut: z.enum(["OUVERTE", "EN_COURS", "CLOTUREE", "ABANDONNEE"]).optional(),
      nature: z.string().max(64).optional(),
      tronconId: z.string().max(64).optional(),
      responsableId: z.string().max(64).optional(),
      enRetard: z.enum(["true"]).optional(),
      limite: z.coerce.number().int().min(1).max(200).optional(),
      apres: z.string().max(64).optional(),
    }).parse(req.query);
    const user = req.user!;
    const lignes = await prisma.$queryRaw<LigneTache[]>`
      SELECT ${COLONNES} FROM "taches_internes" t
       WHERE t."deletedAt" IS NULL
         AND (${gestionnaire(user.role)}::boolean OR t."responsableId" = ${user.id} OR t."creeParId" = ${user.id})
         AND (${q.statut ?? null}::text IS NULL OR t."statut"::text = ${q.statut ?? null})
         AND (${q.nature ?? null}::text IS NULL OR t."nature" = ${q.nature ?? null})
         AND (${q.tronconId ?? null}::text IS NULL OR t."tronconId" = ${q.tronconId ?? null})
         AND (${q.responsableId ?? null}::text IS NULL OR t."responsableId" = ${q.responsableId ?? null})
         AND (${q.enRetard === "true"}::boolean = false OR (t."statut" IN ('OUVERTE', 'EN_COURS') AND t."echeanceLe" < CURRENT_DATE))
         AND (${q.apres ?? null}::text IS NULL OR t."reference" > ${q.apres ?? null})
       ORDER BY t."reference" ASC
       LIMIT ${q.limite ?? 50}`;
    return res.json({ taches: lignes.map(vue), curseurSuivant: lignes.length === (q.limite ?? 50) ? lignes.at(-1)!.reference : null });
  } catch (err) {
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/taches-internes/rapprochement:
 *   get:
 *     summary: Alertes de rapprochement, en lecture seule
 *     description: >
 *       Ecarts entre ce que les taches disent et ce que le patrimoine montre (echeance depassee, tache cloturee
 *       sur un defaut encore actif, ...). Ne cree, ne modifie et ne journalise rien. Le rapprochement
 *       physique / financier (TI-02) attend les donnees DigitalRoad (B-11) : la reponse le dit.
 *     tags: [Taches internes v2]
 */
tachesInternesV2Router.get("/rapprochement", requireAuth, requireModuleAccess("inspections"), requireRole("ADMIN", "GESTIONNAIRE"), async (_req, res, next) => {
  try {
    const lignes = await prisma.$queryRaw<{
      id: string; reference: string; statut: StatutTache; echeanceLe: Date | null; responsableActif: boolean;
      defautId: string | null; defautEtat: "ACTIF" | "TRAITE" | "DISPARU" | null; defautSupprimeLe: Date | null;
    }[]>`
      SELECT t."id", t."reference", t."statut"::text AS "statut", t."echeanceLe", u."actif" AS "responsableActif",
             d."id" AS "defautId", d."etat"::text AS "defautEtat", d."deletedAt" AS "defautSupprimeLe"
        FROM "taches_internes" t
        JOIN "users" u ON u."id" = t."responsableId"
        LEFT JOIN "defauts" d ON d."id" = t."defautId"
       WHERE t."deletedAt" IS NULL
       ORDER BY t."reference"`;
    const alertes = alertesRapprochement(
      lignes.map((l) => ({
        id: l.id, reference: l.reference, statut: l.statut, echeanceLe: l.echeanceLe, responsableActif: l.responsableActif,
        defaut: l.defautId && l.defautEtat ? { id: l.defautId, etat: l.defautEtat, deletedAt: l.defautSupprimeLe } : null,
      })),
      jourUtc(new Date()),
    );
    return res.json({
      verifieLe: new Date().toISOString(),
      tachesExaminees: lignes.length,
      alertes,
      physique: "Faits possedes par la plateforme : tache, defaut, responsable, echeance.",
      financier: { disponible: false, motif: "Aucune donnee DigitalRoad n'est accessible (blocage B-11) : le rapprochement physique / financier de TI-02 n'est pas fait.", engagements: 0 },
      lectureSeule: true,
    });
  } catch (err) {
    return next(err);
  }
});

tachesInternesV2Router.get("/:id", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const t = await lire(prisma, req.params.id);
    if (!t || !visible(t, req.user!)) return res.status(404).json({ message: "Tache introuvable." });
    return res.json(vue(t));
  } catch (err) {
    return next(err);
  }
});

/** Charge la tache sur laquelle un geste agit, ou repond 404 (invisible) / 409 (deja terminee). */
async function tacheAgissable(req: Request) {
  const t = await lire(prisma, req.params.id);
  if (!t || !visible(t, req.user!)) return { refus: { http: 404, corps: { message: "Tache introuvable." } } } as const;
  return { t } as const;
}

const refusTransition = (t: LigneTache, vers: StatutTache) => ({
  http: 409,
  corps: { message: `Une tache ${t.statut} ne peut pas passer a ${vers}${estTerminee(t.statut) ? " : elle est terminee, un travail a refaire est une nouvelle tache" : ""}.`, motif: "TRANSITION_REFUSEE", statut: t.statut },
});

tachesInternesV2Router.post("/:id/demarrer", requireAuth, requireModuleAccess("inspections"), requireRole(...ROLES_ECRITURE), territoireTache, async (req, res, next) => {
  try {
    const a = await tacheAgissable(req);
    if (a.refus) return res.status(a.refus.http).json(a.refus.corps);
    const t = a.t!;
    z.object({}).strict().parse(req.body ?? {});
    if (!transitionTachePermise(t.statut, "EN_COURS")) { const r = refusTransition(t, "EN_COURS"); return res.status(r.http).json(r.corps); }
    const user = req.user!;
    const ok = await prisma.$transaction(async (tx) => {
      const n = await tx.$executeRaw`UPDATE "taches_internes" SET "statut" = 'EN_COURS', "updatedAt" = (now() AT TIME ZONE 'UTC') WHERE "id" = ${t.id} AND "statut" = 'OUVERTE' AND "deletedAt" IS NULL`;
      if (n !== 1) return false;
      await logAuditTransactionnelle(tx, { userId: user.id, action: "UPDATE", entityType: "TacheInterne", entityId: t.id, before: { statut: "OUVERTE" }, after: { statut: "EN_COURS" }, ipAddress: req.ip });
      return true;
    });
    if (!ok) return res.status(409).json({ message: "La tache a change pendant l'operation. Rechargez-la.", motif: "TACHE_CHANGEE" });
    return res.json(vue((await lire(prisma, t.id))!));
  } catch (err) {
    return next(err);
  }
});

const compterPreuves = async (req: Request): Promise<number | null> => {
  const t = await lire(prisma, req.params.id);
  if (!t || !visible(t, req.user!)) return null;
  return [t.preuveAvantChemin, t.preuveApresChemin].filter(Boolean).length;
};

/**
 * @openapi
 * /api/v2/taches-internes/{id}/preuves/{moment}:
 *   post:
 *     summary: Joint la photo « avant » ou « apres » d'une tache
 *     description: >
 *       `moment` vaut `avant` ou `apres`. La date de prise de vue (`capturedA`) est exigee : sans elle,
 *       rien ne prouve que « apres » vient apres « avant ». Refusee sur une tache terminee.
 *     tags: [Taches internes v2]
 */
tachesInternesV2Router.post("/:id/preuves/:moment", requireAuth, requireModuleAccess("inspections"), requireRole(...ROLES_ECRITURE), territoireTache,
  plafondPhotos(compterPreuves), uploadPhoto, async (req, res, next) => {
    const fichier = req.file;
    const retirer = async () => { if (fichier) await unlink(fichier.path).catch(() => undefined); };
    try {
      if (!fichier) return res.status(400).json({ message: "Photo manquante.", motif: "PHOTO_MANQUANTE" });
      const moment = req.params.moment;
      if (moment !== "avant" && moment !== "apres") { await retirer(); return res.status(400).json({ message: "Le moment d'une preuve est « avant » ou « apres ».", motif: "MOMENT_INCONNU" }); }
      const meta = z.object({ capturedA: z.string().datetime() }).strict().safeParse(req.body);
      if (!meta.success) { await retirer(); return res.status(400).json({ message: "La date de prise de vue (capturedA, ISO 8601) est exigee, et elle seule.", motif: "DATE_PRISE_REQUISE" }); }
      const priseLe = new Date(meta.data.capturedA);
      if (priseLe.getTime() > Date.now() + 3_600_000) { await retirer(); return res.status(422).json({ message: "La date de prise de vue est dans le futur.", motif: "DATE_DANS_LE_FUTUR" }); }

      const a = await tacheAgissable(req);
      if (a.refus) { await retirer(); return res.status(a.refus.http).json(a.refus.corps); }
      const t = a.t!;
      if (estTerminee(t.statut)) { await retirer(); return res.status(409).json({ message: "Les preuves d'une tache terminee ne changent plus.", motif: "TACHE_TERMINEE", statut: t.statut }); }

      // Ordre des preuves : « apres » ne precede pas « avant ». La base le refuse aussi (23514) ; ici on le dit.
      if (moment === "apres" && t.preuveAvantPriseLe && priseLe < t.preuveAvantPriseLe) { await retirer(); return res.status(422).json({ message: EXPLICATIONS_MANQUE.PREUVE_APRES_ANTERIEURE_A_AVANT, motif: "PREUVE_APRES_ANTERIEURE_A_AVANT" }); }
      if (moment === "avant" && t.preuveApresPriseLe && priseLe > t.preuveApresPriseLe) { await retirer(); return res.status(422).json({ message: EXPLICATIONS_MANQUE.PREUVE_APRES_ANTERIEURE_A_AVANT, motif: "PREUVE_APRES_ANTERIEURE_A_AVANT" }); }

      // Une meme photo ne peut pas etre l'avant ET l'apres : ce serait une preuve de rien.
      const octets = await readFile(fichier.path);
      const empreinte = createHash("sha256").update(octets).digest("hex");
      const autre = moment === "avant" ? t.preuveApresChemin : t.preuveAvantChemin;
      if (autre) {
        const autreOctets = await readFile(photoAbsolutePath(autre)).catch(() => null);
        if (autreOctets && createHash("sha256").update(autreOctets).digest("hex") === empreinte) {
          await retirer();
          return res.status(422).json({ message: "Les photos « avant » et « apres » sont le meme fichier : elles ne prouvent rien.", motif: "PREUVES_IDENTIQUES" });
        }
      }

      const user = req.user!;
      const ok = await prisma.$transaction(async (tx) => {
        const n = moment === "avant"
          ? await tx.$executeRaw`UPDATE "taches_internes" SET "preuveAvantChemin" = ${fichier.filename}, "preuveAvantPriseLe" = (${priseLe.toISOString()}::timestamptz AT TIME ZONE 'UTC'), "updatedAt" = (now() AT TIME ZONE 'UTC')
                                  WHERE "id" = ${t.id} AND "statut" IN ('OUVERTE', 'EN_COURS') AND "deletedAt" IS NULL`
          : await tx.$executeRaw`UPDATE "taches_internes" SET "preuveApresChemin" = ${fichier.filename}, "preuveApresPriseLe" = (${priseLe.toISOString()}::timestamptz AT TIME ZONE 'UTC'), "updatedAt" = (now() AT TIME ZONE 'UTC')
                                  WHERE "id" = ${t.id} AND "statut" IN ('OUVERTE', 'EN_COURS') AND "deletedAt" IS NULL`;
        if (n !== 1) return false;
        await logAuditTransactionnelle(tx, {
          userId: user.id, action: "UPDATE", entityType: "TacheInterne", entityId: t.id,
          before: { [`preuve_${moment}`]: moment === "avant" ? t.preuveAvantChemin : t.preuveApresChemin },
          after: { [`preuve_${moment}`]: fichier.filename, priseLe: priseLe.toISOString(), sha256: empreinte },
          ipAddress: req.ip,
        });
        return true;
      });
      if (!ok) { await retirer(); return res.status(409).json({ message: "La tache a change pendant l'operation. Rechargez-la.", motif: "TACHE_CHANGEE" }); }
      return res.status(201).json(vue((await lire(prisma, t.id))!));
    } catch (err) {
      await retirer();
      return next(err);
    }
  });

tachesInternesV2Router.post("/:id/cloturer", requireAuth, requireModuleAccess("inspections"), requireRole(...ROLES_ECRITURE), territoireTache, async (req, res, next) => {
  try {
    const interdits = champsContractuels(req.body);
    if (interdits.length > 0) return res.status(422).json({ message: MESSAGE_FRONTIERE, motif: "CHAMP_CONTRACTUEL_REFUSE", champs: interdits });
    const c = z.object({
      quantite: z.number().positive().max(1e9).optional(),
      unite: z.string().trim().min(1).max(32).optional(),
    }).strict().parse(req.body ?? {});
    if ((c.quantite === undefined) !== (c.unite === undefined)) {
      return res.status(422).json({ message: "Une quantite va avec son unite, et une unite avec sa quantite : « 40 » seul ne veut rien dire.", motif: "QUANTITE_SANS_UNITE" });
    }
    const a = await tacheAgissable(req);
    if (a.refus) return res.status(a.refus.http).json(a.refus.corps);
    const t = a.t!;
    if (!transitionTachePermise(t.statut, "CLOTUREE")) { const r = refusTransition(t, "CLOTUREE"); return res.status(r.http).json(r.corps); }

    const manques = manquesPourCloture({ avantChemin: t.preuveAvantChemin, avantPriseLe: t.preuveAvantPriseLe, apresChemin: t.preuveApresChemin, apresPriseLe: t.preuveApresPriseLe });
    if (manques.length > 0) {
      return res.status(422).json({ message: manques.map((m) => EXPLICATIONS_MANQUE[m]).join(" "), motif: "PREUVES_INCOMPLETES", manques });
    }
    const user = req.user!;
    const ok = await prisma.$transaction(async (tx) => {
      const n = await tx.$executeRaw`
        UPDATE "taches_internes"
           SET "statut" = 'CLOTUREE', "clotureeLe" = (now() AT TIME ZONE 'UTC'), "clotureeParId" = ${user.id},
               "quantiteConstatee" = ${c.quantite ?? null}::numeric, "quantiteUnite" = ${c.unite ?? null}, "updatedAt" = (now() AT TIME ZONE 'UTC')
         WHERE "id" = ${t.id} AND "statut" IN ('OUVERTE', 'EN_COURS') AND "deletedAt" IS NULL
           AND "preuveAvantChemin" IS NOT DISTINCT FROM ${t.preuveAvantChemin} AND "preuveApresChemin" IS NOT DISTINCT FROM ${t.preuveApresChemin}`;
      if (n !== 1) return false;
      await logAuditTransactionnelle(tx, {
        userId: user.id, action: "UPDATE", entityType: "TacheInterne", entityId: t.id,
        before: { statut: t.statut }, after: { statut: "CLOTUREE", quantite: c.quantite, unite: c.unite },
        ipAddress: req.ip,
      });
      return true;
    });
    if (!ok) return res.status(409).json({ message: "La tache a change pendant la cloture (statut ou preuves). Rechargez-la.", motif: "TACHE_CHANGEE" });
    return res.json(vue((await lire(prisma, t.id))!));
  } catch (err) {
    return next(err);
  }
});

tachesInternesV2Router.post("/:id/abandonner", requireAuth, requireModuleAccess("inspections"), requireRole(...ROLES_ECRITURE), territoireTache, async (req, res, next) => {
  try {
    const c = z.object({ motif: z.string().max(2000) }).strict().parse(req.body ?? {});
    if (!motifAbandonValide(c.motif)) {
      return res.status(422).json({ message: "Un abandon est une decision : il se motive.", motif: "MOTIF_ABANDON_REQUIS" });
    }
    const a = await tacheAgissable(req);
    if (a.refus) return res.status(a.refus.http).json(a.refus.corps);
    const t = a.t!;
    if (!transitionTachePermise(t.statut, "ABANDONNEE")) { const r = refusTransition(t, "ABANDONNEE"); return res.status(r.http).json(r.corps); }
    const user = req.user!;
    const ok = await prisma.$transaction(async (tx) => {
      const n = await tx.$executeRaw`
        UPDATE "taches_internes" SET "statut" = 'ABANDONNEE', "abandonMotif" = ${c.motif.trim()}, "updatedAt" = (now() AT TIME ZONE 'UTC')
         WHERE "id" = ${t.id} AND "statut" IN ('OUVERTE', 'EN_COURS') AND "deletedAt" IS NULL`;
      if (n !== 1) return false;
      await logAuditTransactionnelle(tx, {
        userId: user.id, action: "UPDATE", entityType: "TacheInterne", entityId: t.id,
        before: { statut: t.statut }, after: { statut: "ABANDONNEE", motif: c.motif.trim() }, ipAddress: req.ip,
      });
      return true;
    });
    if (!ok) return res.status(409).json({ message: "La tache a change pendant l'operation. Rechargez-la.", motif: "TACHE_CHANGEE" });
    return res.json(vue((await lire(prisma, t.id))!));
  } catch (err) {
    return next(err);
  }
});
