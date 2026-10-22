import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { prisma } from "../lib/prisma";
import { verdictDelegation } from "../governance/delegation.service";
import { dateEffet } from "../reseau/date-effet";
import { chronologie, lirePortionsALaDate, RefusCurseur, type Emprise } from "../reseau/curseur.service";
import { EXPLICATIONS as EXPLICATIONS_VALIDATION, validationPermise } from "../governance/validation";
import {
  creerPortion,
  decouperPortion,
  fusionnerPortions,
  requalifierPortion,
} from "../reseau/portions.service";
import {
  DecisionConcurrente,
  PortionIntrouvable,
  auteurDeLaPortion,
  depotPrisma,
  regionDuTronconDeLaPortion,
} from "../reseau/portions.depot";

/**
 * `/api/v2/portions` — l'ecriture des portions homogenes.
 *
 * CINQ OPERATIONS, ET LA CINQUIEME N'EST PAS DU MEME ORDRE
 *
 * Creer, decouper, fusionner et requalifier sont des PROPOSITIONS : n'importe quel agent
 * ayant acces au module peut les faire, et tout ce qu'elles produisent sort en
 * `A_VALIDER`. Valider est une DECISION : elle passe par `validationPermise`, qui refuse
 * l'auto-validation et verifie la designation du paragraphe 35.
 *
 * C'est pourquoi la validation est une route separee et non un champ du corps. Un
 * `statutValidation: "VALIDE"` accepte a la creation aurait suffi a contourner toute la
 * separation des roles, sans trace et sans intention malveillante.
 *
 * POURQUOI LES REFUS SONT DES 409 ET NON DES 400
 *
 * `HORS_TRONCON`, `TROP_COURTE`, `NON_ADJACENTES`, `CHEVAUCHE_UNE_VALIDEE` : la requete
 * est bien formee, c'est l'ETAT du reseau qui s'y oppose. Un 400 laisserait croire a une
 * erreur de saisie du client, alors que le client doit afficher le motif a l'agent.
 *
 * Un 403 reste reserve a ce qui ne se corrige pas en reessayant : role insuffisant,
 * auto-validation, hors delegation.
 */
export const portionsV2Router = Router();

const qualification = z.object({
  revetement: z.string().max(64).nullish(),
  etat: z.string().max(64).nullish(),
  praticabilite: z.string().max(64).nullish(),
  largeurM: z.number().positive().max(100).nullish(),
  source: z.string().max(200).nullish(),
  observeeLe: z.coerce.date().nullish(),
  /** Depuis quand c'est vrai sur le terrain (un jour, jamais dans le futur). Voir `date-effet.ts`. */
  valideDu: dateEffet,
  confiance: z.enum(["HIGH", "MEDIUM", "LOW"]).nullish(),
  observationId: z.string().uuid().nullish(),
});

const corpsCreation = qualification.extend({
  tronconId: z.string().uuid(),
  debutM: z.number().min(0).max(10_000_000),
  finM: z.number().min(0).max(10_000_000),
  /** Cle d'idempotence de l'appareil. Rejouer la meme cle rend la portion deja ecrite. */
  clientOperationId: z.string().min(8).max(128).optional(),
});

/** Codes de refus qui relevent d'un conflit d'etat, non d'une requete mal formee. */
const CONFLIT = new Set([
  "BORNES_INVERSEES", "HORS_TRONCON", "TROP_COURTE", "LONGUEUR_TRONCON_INCONNUE",
  "HORS_PORTION", "MORCEAU_TROP_COURT", "PORTION_REMPLACEE",
  "TRONCONS_DIFFERENTS", "NON_ADJACENTES", "ATTRIBUTS_DIFFERENTS",
  "VALIDATIONS_DIFFERENTES", "CHEVAUCHE_UNE_VALIDEE",
  "PERIODES_DIFFERENTES", "DATE_EFFET_NON_POSTERIEURE",
]);

/** Ce que chaque refus veut dire pour l'agent, en une phrase actionnable. */
export const EXPLICATIONS_PORTION: Record<string, string> = {
  BORNES_INVERSEES: "La fin doit être après le début.",
  HORS_TRONCON: "Ces bornes sortent du tronçon.",
  TROP_COURTE: "Portion trop courte : en dessous de dix mètres, on décrit la dérive du GPS.",
  LONGUEUR_TRONCON_INCONNUE: "Ce tronçon n'a pas de tracé exploitable : impossible de borner une portion.",
  HORS_PORTION: "Le point de coupe doit être strictement à l'intérieur de la portion.",
  MORCEAU_TROP_COURT: "Cette coupe produirait un morceau de moins de dix mètres.",
  PORTION_REMPLACEE: "Cette portion est de l'historique : elle ne se modifie plus.",
  TRONCONS_DIFFERENTS: "Ces deux portions n'appartiennent pas au même tronçon.",
  NON_ADJACENTES: "Ces deux portions ne se touchent pas : il y a un trou entre elles.",
  ATTRIBUTS_DIFFERENTS: "Ces deux portions ne décrivent pas la même chose : fusionner choisirait pour vous.",
  VALIDATIONS_DIFFERENTES: "L'une est validée et l'autre non : la fusion ferait entrer une proposition dans le référentiel.",
  CHEVAUCHE_UNE_VALIDEE: "Une portion validée couvre déjà ces mètres. Requalifiez-la plutôt que d'en proposer une seconde.",
  PERIODES_DIFFERENTES: "Ces deux portions ne sont pas vraies aux mêmes dates : les fusionner ferait croire que l'état a duré sur les deux périodes.",
  DATE_EFFET_NON_POSTERIEURE: "La date d'effet doit être postérieure à celle de la version qu'elle remplace.",
  PORTION_INTROUVABLE: "Portion introuvable.",
};

function repondreRefus(res: Response, motif: string) {
  const code = motif === "PORTION_INTROUVABLE" ? 404 : CONFLIT.has(motif) ? 409 : 400;
  return res.status(code).json({ motif, message: EXPLICATIONS_PORTION[motif] ?? motif });
}

/**
 * @openapi
 * /api/v2/portions:
 *   get:
 *     summary: Liste les portions, filtrables par statut et par troncon
 *     description: >
 *       Rend les portions COURANTES par defaut : ni remplacees ni supprimees. `historique=true`
 *       inclut les versions remplacees, necessaires pour relire un decoupage ; sans ce
 *       drapeau, une liste melangerait l'etat courant et ses versions anterieures, et un
 *       validateur ne saurait plus laquelle trancher.
 *     tags: [Portions v2]
 *     parameters:
 *       - in: query
 *         name: statut
 *         schema: { type: string, enum: [A_VALIDER, VALIDE, REJETE, A_CORRIGER] }
 *       - in: query
 *         name: tronconId
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: historique
 *         description: Inclut les versions remplacees. Faux par defaut.
 *         schema: { type: boolean }
 */
portionsV2Router.get("/", requireAuth, requireModuleAccess("geoportail"), async (req, res, next) => {
  try {
    const q = z.object({
      statut: z.enum(["A_VALIDER", "VALIDE", "REJETE", "A_CORRIGER"]).optional(),
      tronconId: z.string().uuid().optional(),
      regionId: z.coerce.number().int().positive().optional(),
      /**
       * Inclut les versions remplacees.
       *
       * FAUX PAR DEFAUT, et ce n'est pas un detail : melanger l'etat courant et ses
       * versions anterieures ferait apparaitre plusieurs portions sur les memes metres, et
       * un validateur ne saurait plus laquelle trancher.
       */
      historique: z.coerce.boolean().optional(),
      limite: z.coerce.number().int().min(1).max(200).optional(),
      curseur: z.string().uuid().optional(),
    }).parse(req.query);

    const limite = q.limite ?? 50;
    const portions = await prisma.portion.findMany({
      where: {
        deletedAt: null,
        ...(q.historique === true ? {} : { remplaceeLe: null }),
        ...(q.statut ? { statutValidation: q.statut } : {}),
        ...(q.tronconId ? { tronconId: q.tronconId } : {}),
        ...(q.regionId ? { troncon: { regionId: q.regionId } } : {}),
      },
      // Les plus recentes d'abord : un validateur traite ce qui vient d'arriver.
      orderBy: { createdAt: "desc" },
      take: limite,
      ...(q.curseur ? { cursor: { id: q.curseur }, skip: 1 } : {}),
      include: {
        troncon: { select: { id: true, code: true, nom: true, classe: true, regionId: true } },
        creePar: { select: { id: true, nomComplet: true } },
        revetementRef: { select: { code: true, libelle: true, bitumineux: true } },
        etatRef: { select: { code: true, libelle: true, critique: true } },
        praticabiliteRef: { select: { code: true, libelle: true, franchissable: true } },
      },
    });

    return res.json({
      portions,
      curseurSuivant: portions.length === limite ? portions.at(-1)?.id : null,
    });
  } catch (err) {
    return next(err);
  }
});

const jourIso = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "attendu : AAAA-MM-JJ")
  // `refine` s'execute MEME quand `regex` a echoue : `toISOString()` sur une date invalide leve
  // une RangeError, et dans un gestionnaire asynchrone cela laisserait la requete sans reponse.
  .refine((s) => {
    const t = Date.parse(`${s}T00:00:00Z`);
    return !Number.isNaN(t) && new Date(t).toISOString().startsWith(s);
  }, "date inexistante");

const requeteCurseur = z.object({
  date: jourIso,
  connu: jourIso.optional(),
  bbox: z.string().max(100).optional(),
  tronconId: z.string().uuid().optional(),
  inclureAValider: z.enum(["true", "false"]).optional(),
});

/**
 * @openapi
 * /api/v2/portions/a-la-date:
 *   get:
 *     summary: Les portions vraies a une date (curseur temporel)
 *     description: >
 *       Rend ce qui etait vrai SUR LE TERRAIN a la date `date`, et, avec `connu`, tel que le
 *       systeme le SAVAIT ce jour-la. Par defaut seules les portions validees sont rendues ;
 *       `inclureAValider=true` ajoute les propositions, qui restent identifiables. Une portion
 *       sans date d'effet n'est placee a aucune date : elle n'apparait pas, et la chronologie
 *       en donne le compte. Un perimetre est exige : `bbox` (ouest,sud,est,nord) OU `tronconId`.
 *       Aucune date future.
 *     tags: [Portions v2]
 */
portionsV2Router.get("/a-la-date", requireAuth, requireModuleAccess("geoportail"), async (req, res, next) => {
  const q = requeteCurseur.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: "parametres invalides : date (AAAA-MM-JJ) est exigee", details: q.error.flatten().fieldErrors });

  const aujourdhui = new Date();
  const dateTerrain = new Date(`${q.data.date}T00:00:00Z`);
  if (dateTerrain.getTime() > aujourdhui.getTime()) {
    return res.status(400).json({ error: "La date ne peut pas etre dans le futur : le curseur montre le passe et le present, pas des previsions.", code: "DATE_FUTURE" });
  }
  // `connu` designe un JOUR ENTIER : ce que le systeme savait a la fin de cette journee.
  const connuLe = q.data.connu ? new Date(`${q.data.connu}T23:59:59.999Z`) : null;
  if (connuLe && connuLe.getTime() - 86_400_000 > aujourdhui.getTime()) {
    return res.status(400).json({ error: "« connu au » ne peut pas etre dans le futur.", code: "DATE_FUTURE" });
  }

  let emprise: Emprise | undefined;
  if (q.data.bbox !== undefined) {
    const v = q.data.bbox.split(",").map(Number);
    if (v.length !== 4 || !v.every(Number.isFinite)) {
      return res.status(400).json({ error: "bbox attendu : ouest,sud,est,nord (quatre nombres)", code: "EMPRISE_INVALIDE" });
    }
    emprise = { ouest: v[0], sud: v[1], est: v[2], nord: v[3] };
  }

  try {
    return res.json(await lirePortionsALaDate(prisma, {
      dateTerrain,
      connuLe,
      inclureAValider: q.data.inclureAValider === "true",
      emprise,
      tronconId: q.data.tronconId,
    }));
  } catch (err) {
    if (err instanceof RefusCurseur) return res.status(err.http).json({ error: err.message, code: err.code });
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/portions/chronologie:
 *   get:
 *     summary: Bornes et volumes du curseur temporel
 *     description: >
 *       Premiere et derniere date d'effet connues, nombre de portions placees dans le temps, et
 *       nombre de portions SANS date d'effet (placees a aucune date). Sert a dire la verite
 *       quand le curseur n'a rien a montrer.
 *     tags: [Portions v2]
 */
portionsV2Router.get("/chronologie", requireAuth, requireModuleAccess("geoportail"), async (_req, res, next) => {
  try {
    return res.json(await chronologie(prisma));
  } catch (err) {
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/portions:
 *   post:
 *     summary: Qualifie une portion de troncon (proposition)
 *     description: >
 *       Sort toujours en `A_VALIDER`. `clientOperationId` rend l'appel idempotent : rejouer
 *       la meme cle rend la portion deja enregistree au lieu d'en creer une seconde.
 *       Refuse de se poser par-dessus une portion deja validee, qu'il faut requalifier.
 *     tags: [Portions v2]
 */
portionsV2Router.post("/", requireAuth, requireModuleAccess("geoportail"), async (req, res, next) => {
  try {
    const c = corpsCreation.parse(req.body);
    const user = (req as unknown as { user: { id: string } }).user;
    const r = await creerPortion({ ...c }, user.id, depotPrisma);
    if (r.refus !== null) return repondreRefus(res, r.refus);
    return res.status(201).json(r.valeur);
  } catch (err) {
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/portions/{id}/decoupe:
 *   post:
 *     summary: Decoupe une portion en deux a une abscisse
 *     description: >
 *       L'originale n'est pas modifiee : elle est marquee remplacee, et les deux morceaux
 *       heritent de ses attributs. Decouper n'est pas qualifier.
 *     tags: [Portions v2]
 */
portionsV2Router.post("/:id/decoupe", requireAuth, requireModuleAccess("geoportail"), async (req, res, next) => {
  try {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { aM } = z.object({ aM: z.number().min(0).max(10_000_000) }).parse(req.body);
    const user = (req as unknown as { user: { id: string } }).user;
    const r = await decouperPortion(id, aM, user.id, depotPrisma);
    if (r.refus !== null) return repondreRefus(res, r.refus);
    return res.status(201).json({ morceaux: r.valeur });
  } catch (err) {
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/portions/fusion:
 *   post:
 *     summary: Fusionne deux portions adjacentes et compatibles
 *     tags: [Portions v2]
 */
portionsV2Router.post("/fusion", requireAuth, requireModuleAccess("geoportail"), async (req, res, next) => {
  try {
    const c = z.object({ idA: z.string().uuid(), idB: z.string().uuid() }).parse(req.body);
    const user = (req as unknown as { user: { id: string } }).user;
    const r = await fusionnerPortions(c.idA, c.idB, user.id, depotPrisma);
    if (r.refus !== null) return repondreRefus(res, r.refus);
    return res.status(201).json(r.valeur);
  } catch (err) {
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/portions/{id}/requalification:
 *   post:
 *     summary: Revoit les attributs d'une portion, a bornes inchangees
 *     description: >
 *       Cree une nouvelle version et marque l'ancienne remplacee. La nouvelle repart en
 *       `A_VALIDER` meme si l'ancienne etait validee : une requalification est une
 *       proposition, pas un changement officiel.
 *     tags: [Portions v2]
 */
portionsV2Router.post("/:id/requalification", requireAuth, requireModuleAccess("geoportail"), async (req, res, next) => {
  try {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const q = qualification.parse(req.body);
    const user = (req as unknown as { user: { id: string } }).user;
    const r = await requalifierPortion(id, q, user.id, depotPrisma);
    if (r.refus !== null) return repondreRefus(res, r.refus);
    return res.status(201).json(r.valeur);
  } catch (err) {
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/portions/{id}/validation:
 *   post:
 *     summary: Tranche une proposition de portion (validateur habilite)
 *     description: >
 *       Refuse l'auto-validation, meme pour un administrateur, et verifie la designation
 *       du paragraphe 35 : si un validateur est designe pour le domaine PORTION sur la
 *       region du troncon, lui seul peut trancher.
 *     tags: [Portions v2]
 */
portionsV2Router.post("/:id/validation", requireAuth, requireModuleAccess("geoportail"), async (req, res, next) => {
  try {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const c = z.object({
      decision: z.enum(["VALIDE", "REJETE", "A_CORRIGER"]),
      commentaire: z.string().max(2_000).nullish(),
    }).parse(req.body);
    const user = (req as unknown as { user: { id: string; role: string } }).user;

    const portion = await depotPrisma.portionParId(id);
    if (portion === null) return repondreRefus(res, "PORTION_INTROUVABLE");

    // L'AUTEUR VIENT DE LA LIGNE, PAS DE LA REQUETE. C'est le point ou la separation des
    // roles se tient ou tombe : un auteur fourni par le client desactiverait le controle
    // sans laisser de trace.
    const auteur = await auteurDeLaPortion(id);
    const regionId = await regionDuTronconDeLaPortion(id);

    // Toutes les delegations du domaine, tous validateurs confondus : la regle a besoin de
    // distinguer « personne n'est designe » — et alors la regle d'avant s'applique — de
    // « quelqu'un l'est, mais pas vous ». Filtrer en base rendrait les deux cas
    // indistinguables.
    const delegation = await verdictDelegation({
      domaine: "PORTION", regionId, validateurId: user.id,
    });

    const verdict = validationPermise({
      entityType: "Portion",
      statutActuel: portion.statutValidation,
      auteurId: auteur,
      validateurId: user.id,
      validateurRole: user.role,
      decision: c.decision,
      commentaire: c.commentaire,
      delegation,
    });
    if (!verdict.permis) {
      const code = verdict.motif === "ROLE_INSUFFISANT"
        || verdict.motif === "AUTO_VALIDATION"
        || verdict.motif === "HORS_DELEGATION" ? 403 : 409;
      return res.status(code).json({
        motif: verdict.motif,
        message: EXPLICATIONS_VALIDATION[verdict.motif],
        statut: portion.statutValidation,
      });
    }

    const apres = await depotPrisma.decider(id, c.decision, user.id, c.commentaire ?? null);
    return res.json({ ...apres, autorite: delegation.motif });
  } catch (err) {
    if (err instanceof PortionIntrouvable) return repondreRefus(res, "PORTION_INTROUVABLE");
    if (err instanceof DecisionConcurrente) {
      return res.status(409).json({
        motif: "DECISION_CONCURRENTE",
        message: "Un autre validateur a tranché entre-temps. Rechargez la portion.",
      });
    }
    return next(err);
  }
});
