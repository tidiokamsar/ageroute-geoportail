import { Router, type Request } from "express";
import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { prisma } from "../lib/prisma";
import { logAuditTransactionnelle } from "../utils/audit";
import { enregistrerQualite } from "../lib/qualite";
import { validationPermise, EXPLICATIONS } from "../governance/validation";
import { verdictDelegation } from "../governance/delegation.service";
import { territoireObservation } from "../territoire/territoire.v2";
import { uploadPhoto } from "../middleware/upload-photo.middleware";
import { plafondPhotos } from "../middleware/quota-photos.middleware";
import { photoAbsolutePath } from "../lib/photos";

/**
 * `/api/v2/observations` — consultation et VALIDATION.
 *
 * La validation est la porte que toute la chaine attendait. Le systeme savait
 * produire des observations, les remonter du terrain sans doublon et conserver les
 * conflits ; sans cette route, tout restait au statut PROPOSEE et n'alimentait rien.
 *
 * LA CREATION N'EST PAS ICI
 *
 * Une observation nait d'une mission, hors ligne, et remonte par `/sync/push` avec sa
 * cle d'idempotence. Ouvrir un POST direct offrirait un second chemin de creation
 * sans cette garantie, et c'est par la que reviendraient les doublons que le
 * protocole existe pour empecher.
 */

export const observationsV2Router = Router();

async function perimetreObservations(user: { id: string; role: string }) {
  if (user.role === "ADMIN" || user.role === "GESTIONNAIRE") return {};
  const missions = await prisma.mission.findMany({
    where: { deletedAt: null, OR: [{ assigneId: user.id }, { createurId: user.id }] },
    select: { id: true },
  });
  return {
    OR: [
      { agentId: user.id },
      ...(missions.length > 0 ? [{ missionId: { in: missions.map((mission) => mission.id) } }] : []),
    ],
  };
}

/**
 * @openapi
 * /api/v2/observations:
 *   get:
 *     summary: Liste les observations, filtrables par statut et par mission
 *     tags: [Observations v2]
 */
observationsV2Router.get("/", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const q = z.object({
      statut: z.enum(["BROUILLON", "PROPOSEE", "VALIDEE", "REJETEE", "CONVERTIE"]).optional(),
      missionId: z.string().uuid().optional(),
      tronconId: z.string().optional(),
      limite: z.coerce.number().int().min(1).max(200).optional(),
      curseur: z.string().uuid().optional(),
    }).parse(req.query);

    const scope = await perimetreObservations(req.user!);
    const observations = await prisma.observation.findMany({
      where: {
        deletedAt: null,
        ...scope,
        ...(q.statut ? { statut: q.statut } : {}),
        ...(q.missionId ? { missionId: q.missionId } : {}),
        ...(q.tronconId ? { tronconId: q.tronconId } : {}),
      },
      // Pagination par CURSEUR et non par offset : une liste qui s'allonge pendant
      // qu'on la parcourt ferait sauter des lignes avec un offset, et c'est
      // precisement ce qui arrive quand une mission remonte sa file.
      orderBy: { createdAt: "desc" },
      take: q.limite ?? 50,
      ...(q.curseur ? { cursor: { id: q.curseur }, skip: 1 } : {}),
      include: { medias: { select: { id: true, type: true, cheminVignette: true } } },
    });

    return res.json({
      observations,
      curseurSuivant: observations.length === (q.limite ?? 50) ? observations.at(-1)?.id : null,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/observations/{id}:
 *   get:
 *     summary: Detail d'une observation
 *     tags: [Observations v2]
 */
observationsV2Router.get("/:id", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const scope = await perimetreObservations(req.user!);
    const o = await prisma.observation.findFirst({
      where: { id: req.params.id, deletedAt: null, ...scope },
      include: { medias: true, mission: { select: { id: true, code: true, intitule: true } } },
    });
    if (!o) return res.status(404).json({ message: "Observation introuvable" });
    const validations = await prisma.validation.findMany({
      where: { entityType: "Observation", entityId: o.id },
      orderBy: { decideA: "asc" },
      include: { decidePar: { select: { id: true, nomComplet: true } } },
    });
    return res.json({ ...o, validations });
  } catch (err) {
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/observations/{id}/validate:
 *   post:
 *     summary: Valide ou rejette une observation de terrain
 *     description: >
 *       Une observation ne peut pas etre validee par la personne qui l'a produite, et
 *       un rejet doit porter son motif. La decision est auditee sous VALIDATE ou
 *       REJECT, et tracee dans valeurs_qualite.
 *     tags: [Observations v2]
 */
observationsV2Router.post("/:id/validate", requireAuth, requireModuleAccess("inspections"), territoireObservation, async (req, res, next) => {
  try {
    const c = z.object({
      decision: z.enum(["VALIDEE", "REJETEE"]),
      motif: z.string().max(2000).optional(),
    }).strict().parse(req.body);

    const user = req.user!;
    const o = await prisma.observation.findFirst({
      where: { id: req.params.id, deletedAt: null },
      // La region vient du troncon apparie, ou a defaut de la mission. Elle sert au
      // perimetre des delegations, et elle peut legitimement manquer : l'appariement rend
      // `null` plutot que de deviner.
      include: {
        troncon: { select: { regionId: true } },
        mission: { select: { regionId: true } },
      },
    });
    if (!o) return res.status(404).json({ message: "Observation introuvable" });

    /**
     * QUI EST DESIGNE POUR TRANCHER CE DOMAINE (paragraphe 35 du cahier).
     *
     * Deuxieme des sept domaines a consulter les delegations, apres les defauts. Les cinq
     * autres — troncon, ouvrage, point noir, poste, chantier — n'ont a ce jour AUCUNE
     * route de validation : y designer un validateur serait sans effet, et le rapport de
     * gouvernance le dit desormais.
     */
    const regionId = o.troncon?.regionId ?? o.mission?.regionId ?? null;
    const delegation = await verdictDelegation({
      domaine: "OBSERVATION", regionId, validateurId: user.id,
    });

    const decision = c.decision === "VALIDEE" ? "VALIDE" : "REJETE";
    const statutActuel = o.statut === "PROPOSEE" ? "A_VALIDER"
      : o.statut === "VALIDEE" ? "VALIDE"
        : o.statut === "REJETEE" ? "REJETE" : o.statut;
    const verdict = validationPermise({
      entityType: "Observation",
      statutActuel,
      auteurId: o.agentId,
      validateurId: user.id,
      validateurRole: user.role,
      decision,
      commentaire: c.motif,
      delegation,
    });

    if (!verdict.permis) {
      // 403 pour un droit, 409 pour un etat : un client doit pouvoir distinguer
      // « vous n'avez pas le droit » de « pas dans cet etat », la premiere ne se
      // corrigeant pas en reessayant.
      // 403 pour un defaut d'autorite — role, auto-validation, delegation — et 409 pour
      // un defaut d'etat : la premiere categorie ne se corrige pas en reessayant.
      const code = verdict.motif === "ROLE_INSUFFISANT"
        || verdict.motif === "AUTO_VALIDATION"
        || verdict.motif === "HORS_DELEGATION" ? 403 : 409;
      return res.status(code).json({ message: EXPLICATIONS[verdict.motif], motif: verdict.motif, statut: o.statut });
    }

    const apres = await prisma.$transaction(async (tx) => {
      const maj = await tx.observation.updateMany({
        where: { id: o.id, deletedAt: null, statut: o.statut, version: o.version },
        data: {
          statut: c.decision,
          valideeA: new Date(),
          validateurId: user.id,
          motifRejet: c.decision === "REJETEE" ? c.motif : null,
          // La version avance : un appareil parti avec l'ancienne verra un conflit
          // plutot que d'ecraser la decision.
          version: { increment: 1 },
        },
      });
      // Le contrôle compare-et-échange empêche deux validateurs qui ont lu la même
      // version de produire deux décisions contradictoires.
      if (maj.count !== 1) return null;
      const observationMiseAJour = await tx.observation.findUnique({ where: { id: o.id } });
      await tx.validation.create({
        data: {
          entityType: "Observation",
          entityId: o.id,
          statutAvant: statutActuel === "A_VALIDER" ? "A_VALIDER" : null,
          statutApres: decision,
          decideParId: user.id,
          auteurId: o.agentId,
          // L'autorite sur laquelle repose cette decision. « Personne n'est designe sur
          // ce domaine » et « vous etes designe » autorisent la meme action pour des
          // raisons opposees : sans cette mention, on ne saura pas dans un an sur
          // laquelle une validation reposait.
          source: `terrain:${delegation.motif}`,
          commentaire: c.motif ?? null,
        },
      });
      if (!observationMiseAJour) throw new Error("Observation absente après validation.");
      await logAuditTransactionnelle(tx, {
        userId: user.id,
        action: c.decision === "VALIDEE" ? "VALIDATE" : "REJECT",
        entityType: "Observation",
        entityId: o.id,
        before: { statut: o.statut, version: o.version },
        after: { statut: observationMiseAJour.statut, version: observationMiseAJour.version, motif: c.motif ?? null },
        ipAddress: req.ip,
      });
      return observationMiseAJour;
    }, { timeout: 60_000 });

    if (!apres) {
      return res.status(409).json({ message: "L'observation a changé pendant la décision. Rechargez la file avant de réessayer." });
    }

    /**
     * La provenance dit QUI a rendu cette donnee officielle.
     *
     * Une observation validee cesse d'etre une proposition : elle alimentera des
     * defauts, des etats, des couts. Sans cette trace, personne ne pourra dire,
     * dans deux ans, sur quelle autorite un chiffre repose.
     */
    await enregistrerQualite({
      entityType: "Observation",
      entityId: o.id,
      champ: "statut",
      statut: c.decision === "VALIDEE" ? "OBSERVED" : "UNKNOWN",
      source: `Validation par ${user.role}`,
      methode: "VALIDATION_HUMAINE",
      observedAt: new Date(),
      confiance: c.decision === "VALIDEE" ? "HIGH" : "LOW",
      note: c.decision === "VALIDEE"
        ? `Observation validée : elle devient une donnée officielle.`
        : `Observation rejetée. Motif : ${c.motif}`,
    });

    return res.json(apres);
  } catch (err) {
    return next(err);
  }
});

/**
 * `POST /api/v2/observations/:id/photos` : une PREUVE PHOTO rattachee a une observation (SMART FIELD, 25/10/2026).
 *
 * POURQUOI ICI ET PAS DANS LA CHARGE DE SYNCHRONISATION. La creation de l'observation reste la seule operation de
 * `/sync/push` (idempotente, schema strict, inchange). Le fichier part APRES elle, par cette route, comme pour les defauts
 * (`POST /v2/defauts/:id/photos`) : un binaire ne passe pas dans un lot JSON, et une coupure pendant l'envoi d'une photo ne
 * doit pas defaire l'observation deja acceptee. Le client garde la photo localement jusqu'a la reponse 200 ou 201.
 *
 * MEMES REGLES QUE LES DEFAUTS, parce qu'elles ont ete eprouvees : plafond de photos par objet et de disque AVANT l'ecriture
 * du fichier, empreinte SHA-256 unique (le meme fichier renvoye apres une reponse perdue rend la ligne existante, 200, sans
 * doublon), un 404 identique pour « n'existe pas » et « n'est pas a vous » (on ne revele pas l'existence), position et cap du
 * cliche facultatifs mais PAR PAIRE, controle territorial, ecriture auditee.
 *
 * Le modele de vision n'est pas branche : `analyseeLe` reste nul (« personne n'a regarde »), jamais « analysee, rien trouve ».
 */
async function supprimerTemporaire(chemin: string | undefined) {
  if (chemin) await unlink(chemin).catch(() => undefined);
}

/** Meme visibilite que la route : un compteur qui ignorerait le filtre revelerait a un tiers que l'observation existe. */
const compterPhotosObservation = async (req: Request): Promise<number | null> => {
  const user = req.user;
  if (!user) return null;
  const gestionnaire = user.role === "ADMIN" || user.role === "GESTIONNAIRE";
  const o = await prisma.observation.findFirst({
    where: { id: req.params.id, deletedAt: null, ...(gestionnaire ? {} : { agentId: user.id }) },
    select: { _count: { select: { medias: true } } },
  });
  return o ? o._count.medias : null;
};

observationsV2Router.post("/:id/photos", requireAuth, requireModuleAccess("inspections"), territoireObservation, plafondPhotos(compterPhotosObservation), uploadPhoto, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Authentification requise." });
    if (!req.file) return res.status(400).json({ message: "Photo manquante." });
    const fichier = req.file;
    const c = z.object({
      lat: z.coerce.number().min(-90).max(90).optional(),
      lon: z.coerce.number().min(-180).max(180).optional(),
      precisionM: z.coerce.number().positive().max(10_000).optional(),
      cap: z.coerce.number().min(0).max(360).optional(),
      capturedA: z.string().datetime().optional(),
    }).strict().safeParse(req.body);
    if (!c.success || (c.data.lat !== undefined) !== (c.data.lon !== undefined)) {
      await supprimerTemporaire(fichier.path);
      return res.status(400).json({ message: "Métadonnées photo invalides : latitude et longitude doivent être renseignées ensemble." });
    }

    const user = req.user;
    const observation = await prisma.observation.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true, agentId: true },
    });
    const gestionnaire = user.role === "ADMIN" || user.role === "GESTIONNAIRE";
    if (!observation || (!gestionnaire && observation.agentId !== user.id)) {
      await supprimerTemporaire(fichier.path);
      return res.status(404).json({ message: "Observation introuvable." });
    }

    const octets = await readFile(fichier.path);
    const sha256 = createHash("sha256").update(octets).digest("hex");
    const existante = await prisma.mediaObservation.findUnique({ where: { sha256 } });
    if (existante) {
      await supprimerTemporaire(fichier.path);
      if (existante.observationId !== observation.id) {
        return res.status(409).json({ message: "Cette photo est déjà rattachée à une autre preuve." });
      }
      return res.status(200).json(existante);
    }

    try {
      const media = await prisma.$transaction(async (tx) => {
        const cree = await tx.mediaObservation.create({
          data: {
            observationId: observation.id,
            type: "PHOTO",
            chemin: fichier.filename,
            sha256,
            mimeType: fichier.mimetype,
            tailleOctets: fichier.size,
            lat: c.data.lat ?? null,
            lon: c.data.lon ?? null,
            precisionM: c.data.precisionM ?? null,
            cap: c.data.cap ?? null,
            capturedA: c.data.capturedA ? new Date(c.data.capturedA) : new Date(),
          },
        });
        await logAuditTransactionnelle(tx, {
          userId: user.id, action: "CREATE", entityType: "MediaObservation", entityId: cree.id,
          after: { observationId: observation.id, sha256, tailleOctets: cree.tailleOctets, lat: cree.lat, lon: cree.lon },
          ipAddress: req.ip,
        });
        return cree;
      });
      return res.status(201).json(media);
    } catch (err) {
      await supprimerTemporaire(photoAbsolutePath(fichier.filename));
      if (typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "P2002") {
        return res.status(409).json({ message: "Cette photo a déjà été enregistrée." });
      }
      throw err;
    }
  } catch (err) {
    if (req.file) await supprimerTemporaire(req.file.path);
    return next(err);
  }
});
