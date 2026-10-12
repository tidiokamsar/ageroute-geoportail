import { Router, type Request, type RequestHandler } from "express";
import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { z } from "zod";
import { StatutValidation } from "@prisma/client";
import { requireRole } from "../middleware/rbac.middleware";
import { uploadPhoto } from "../middleware/upload-photo.middleware";
import { plafondPhotos } from "../middleware/quota-photos.middleware";
import { photoAbsolutePath } from "../lib/photos";
import { apparier, type Appariement } from "../geo/appariement";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { prisma } from "../lib/prisma";
import { logAuditTransactionnelle } from "../utils/audit";
import { enregistrerQualite } from "../lib/qualite";
import { setPointGeom, deriveGeomFromTroncon, deriveGeomFromTronconAbscisse } from "../lib/geo";
import {
  metrer, graviteValide, transitionEtatPermise,
  statutQualiteQuantite, EXPLICATIONS as EXPLICATIONS_DEFAUT, NOMS_MESURES,
  type TypeDefaut, type MesuresDefaut,
} from "../field/defauts.regles";
import { validationPermise, EXPLICATIONS as EXPLICATIONS_VALIDATION } from "../governance/validation";

/**
 * `/api/v2/defauts` — la degradation devient un objet qu'on peut mesurer, arbitrer,
 * puis chiffrer.
 *
 * CE QUE CETTE ROUTE TIENT ET QUE LE SCHEMA NE PEUT PAS TENIR
 *
 * Le schema rend facultatives presque toutes les colonnes de localisation, parce que
 * NULL y dit « pas encore soumis au circuit ». Des colonnes permissives ne peuvent pas
 * porter une exigence : c'est ici, a la porte d'entree, que le cahier des charges
 * (section 7.1) devient effectif. Un defaut entre avec GPS, ou avec son troncon et un
 * repere sur ce troncon — jamais avec rien : un defaut qu'on ne sait pas situer ne
 * peut etre ni programmé ni controle, et le laisser entrer produirait exactement le
 * texte libre dont ce modele est la sortie.
 *
 * LE PK PEUT ENTRER, LE PK NE COMMANDE RIEN
 *
 * Un rapport papier donne souvent un troncon et un PK, jamais de GPS. Exiger le GPS
 * ferait recopier ces rapports... hors du systeme. Le PK est donc accepte comme repere
 * d'entree, et la geometrie en est derivee quand le troncon est calibre — mais aucune
 * regle ici ne depend du PK : ni le metrage, ni la gravite, ni la validation.
 *
 * LA SEPARATION DES ROLES SE JOUE SUR UN CHAMP QUE LE CLIENT NE FOURNIT PAS
 *
 * `validationPermise` oppose le validateur a l'auteur. L'auteur vient de la LIGNE
 * (`constateParId`), jamais du corps de la requete : un client qui passerait
 * `auteurId: null` desactiverait la regle sans que rien ne le signale. Tout champ
 * d'identite non declare est ignore par le parseur zod, et l'auteur est relu en base
 * au moment de decider.
 */
export const defautsV2Router = Router();

const FAMILLES_DEFAUT = ["CHAUSSEE", "ACCOTEMENT", "ASSAINISSEMENT", "OUVRAGE", "SIGNALISATION", "SECURITE", "ENVIRONNEMENT"] as const;
const UNITES_DEFAUT = ["UNITE", "METRE", "METRE_CARRE", "METRE_CUBE"] as const;
const MESURES_CATALOGUE = ["NOMBRE", "LONGUEUR", "LARGEUR", "PROFONDEUR", "QUANTITE"] as const;
const catalogueCreation = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  libelle: z.string().trim().min(2).max(160),
  famille: z.enum(FAMILLES_DEFAUT),
  unite: z.enum(UNITES_DEFAUT),
  mesuresRequises: z.array(z.enum(MESURES_CATALOGUE)).max(5),
  graviteMax: z.number().int().min(1).max(10).nullable(),
  description: z.string().trim().max(2000).nullable(),
  source: z.string().trim().min(3).max(200),
  actif: z.boolean(),
}).strict();
const catalogueModification = catalogueCreation.omit({ code: true }).extend({ version: z.number().int().positive() }).strict();

async function supprimerFichierTemporaire(filePath: string | undefined) {
  if (filePath) await unlink(filePath).catch(() => undefined);
}

function empriseLocale(lat: number, lon: number): string {
  // Fenêtre de 2 km environ, suffisante pour chercher une route proche en gardant
  // l'index spatial. Le moteur ne balaie jamais les 261 000 tronçons pour un relevé.
  const deltaLat = 0.018;
  const deltaLon = 0.02;
  const west = lon - deltaLon, east = lon + deltaLon;
  const south = Math.max(-90, lat - deltaLat), north = Math.min(90, lat + deltaLat);
  return `POLYGON((${west} ${south},${east} ${south},${east} ${north},${west} ${north},${west} ${south}))`;
}

const mesuresSchema = z.object({
  nombre: z.number().int().positive().nullish(),
  longueurM: z.number().positive().nullish(),
  largeurM: z.number().positive().nullish(),
  profondeurM: z.number().positive().nullish(),
  quantiteSaisie: z.number().positive().nullish(),
}).strict();

const creation = z.object({
  catalogueCode: z.string().min(1).max(64),
  code: z.string().min(1).max(64).optional(),
  clientOperationId: z.string().uuid().optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  precisionM: z.number().positive().max(10_000).optional(),
  tronconId: z.string().optional(),
  abscisseM: z.number().min(0).optional(),
  pk: z.number().min(0).optional(),
  confianceAppariement: z.number().min(0).max(1).optional(),
  missionId: z.string().uuid().optional(),
  observationId: z.string().uuid().optional(),
  constateA: z.string().datetime().optional(),
  gravite: z.number().int().min(1).optional(),
  etendue: z.enum(["PONCTUEL", "LOCALISE", "ETENDU", "GENERALISE"]).optional(),
  mesures: mesuresSchema.optional(),
}).strict();

/** Le catalogue en tant que le moteur de metrage le lit. */
function typeDefaut(c: { code: string; unite: TypeDefaut["unite"]; mesuresRequises: TypeDefaut["mesuresRequises"]; graviteMax: number | null }): TypeDefaut {
  return { code: c.code, unite: c.unite, mesuresRequises: c.mesuresRequises, graviteMax: c.graviteMax };
}

/** Les agents voient leurs relevés et ceux des missions qui leur sont affectées. */
async function perimetreDefauts(user: { id: string; role: string }) {
  if (user.role === "ADMIN" || user.role === "GESTIONNAIRE") return {};
  const missions = await prisma.mission.findMany({
    where: { deletedAt: null, OR: [{ assigneId: user.id }, { createurId: user.id }] },
    select: { id: true },
  });
  return {
    OR: [
      { constateParId: user.id },
      ...(missions.length > 0 ? [{ missionId: { in: missions.map((mission) => mission.id) } }] : []),
    ],
  };
}

/**
 * @openapi
 * /api/v2/defauts:
 *   post:
 *     summary: Enregistre un defaut releve ou transcrit
 *     description: >
 *       Le releve est refuse sur place s'il manque une mesure que le catalogue exige,
 *       si une mesure est aberrante, ou si la longueur depasse celle du troncon porte.
 *     tags: [Defauts v2]
 */
defautsV2Router.post("/", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const c = creation.parse(req.body);
    const user = req.user!;

    // LOCALISATION : GPS, ou troncon + repere. Jamais rien.
    const gps = c.lat !== undefined && c.lon !== undefined;
    if (c.lat !== undefined && c.lon === undefined) return res.status(422).json({ message: "Latitude sans longitude : une position GPS se donne entière." });
    if (c.lon !== undefined && c.lat === undefined) return res.status(422).json({ message: "Longitude sans latitude : une position GPS se donne entière." });
    if (!gps && !c.tronconId) {
      return res.status(422).json({
        message: "Un défaut entre avec sa position GPS, ou avec son tronçon et un repère sur ce tronçon (abscisse ou PK).",
      });
    }
    // L'appariement est un acte mesuré : sa confiance accompagne son resultat.
    if (c.abscisseM !== undefined && c.confianceAppariement === undefined) {
      return res.status(422).json({ message: "Une abscisse appariée doit porter sa confiance d'appariement." });
    }
    if (c.tronconId && c.abscisseM === undefined && c.pk === undefined) {
      return res.status(422).json({ message: "Tronçon donné sans repère : une abscisse locale ou un PK est nécessaire." });
    }

    // Une observation ne peut pas être dans le futur ; une horloge de terrain dérive,
    // une heure de tolérance l'absorbe sans ouvrir la porte aux dates inventées.
    const constateA = c.constateA ? new Date(c.constateA) : new Date();
    if (constateA.getTime() > Date.now() + 3_600_000) {
      return res.status(422).json({ message: "La date de constat est dans le futur." });
    }

    // Idempotence client : le même envoi rejoué (double-clic, reprise après coupure)
    // doit rendre la même ligne, pas un doublon que personne ne détectera.
    if (c.clientOperationId) {
      const existant = await prisma.defaut.findUnique({
        where: { clientOperationId: c.clientOperationId },
      });
      if (existant) {
        // La clé d'idempotence n'est pas un jeton d'accès : ne jamais révéler la ligne
        // d'un autre auteur si un identifiant client est réutilisé volontairement.
        if (existant.constateParId !== user.id) {
          return res.status(409).json({ message: "Clé d'idempotence déjà utilisée." });
        }
        return res.status(200).json(existant);
      }
    }

    const catalogue = await prisma.catalogueDefaut.findUnique({ where: { code: c.catalogueCode } });
    if (!catalogue || !catalogue.actif) {
      return res.status(422).json({ message: `Type de défaut inconnu ou retiré : ${c.catalogueCode}` });
    }

    const troncon = c.tronconId
      ? await prisma.troncon.findFirst({
          where: { id: c.tronconId, deletedAt: null },
          select: { id: true, longueurKm: true },
        })
      : null;
    if (c.tronconId && !troncon) return res.status(422).json({ message: "Tronçon introuvable." });
    const mission = c.missionId
      ? await prisma.mission.findFirst({
          where: {
            id: c.missionId,
            deletedAt: null,
            OR: [{ createurId: user.id }, { assigneId: user.id }],
          },
          select: { id: true },
        })
      : null;
    if (c.missionId && !mission) return res.status(422).json({ message: "Mission introuvable ou non autorisée." });

    const observation = c.observationId
      ? await prisma.observation.findFirst({
          where: { id: c.observationId, deletedAt: null, agentId: user.id },
          select: { id: true, missionId: true },
        })
      : null;
    if (c.observationId && !observation) {
      return res.status(422).json({ message: "Observation introuvable ou non autorisée." });
    }
    if (c.missionId && observation?.missionId && observation.missionId !== c.missionId) {
      return res.status(422).json({ message: "La mission et l'observation ne correspondent pas." });
    }

    if (c.code && (await prisma.defaut.findUnique({ where: { code: c.code }, select: { id: true } }))) {
      return res.status(409).json({ message: `Un défaut porte déjà le code ${c.code}` });
    }

    // GRAVITE : bornee par le catalogue, pas par une constante du code.
    const verdictGravite = graviteValide(c.gravite ?? null, catalogue.graviteMax);
    if (!verdictGravite.permis) {
      return res.status(422).json({ message: EXPLICATIONS_DEFAUT[verdictGravite.motif], motif: verdictGravite.motif });
    }

    // METRE : calcule ici, refuse ici. C'est la seule fenetre ou corriger coute une
    // minute ; apres le retour du terrain, chaque mesure manquante est un deplacement.
    const mesures: MesuresDefaut = {
      nombre: c.mesures?.nombre ?? null,
      longueurM: c.mesures?.longueurM ?? null,
      largeurM: c.mesures?.largeurM ?? null,
      profondeurM: c.mesures?.profondeurM ?? null,
      quantiteSaisie: c.mesures?.quantiteSaisie ?? null,
    };
    const metre = metrer(mesures, typeDefaut(catalogue), troncon?.longueurKm ? troncon.longueurKm * 1000 : null);
    if (metre.valeur === null && metre.motif !== "MESURES_INSUFFISANTES") {
      // MESURES_INSUFFISANTES reste franchissable : il ne survient que pour un type
      // sans mesures exigees (AUTRE) saisi sans releve. Le defaut existe, sa quantite
      // reste a combler. Les trois autres motifs sont des donnees fausses ou
      // incompletes : elles ne passent pas la porte.
      const detail = metre.motif === "RELEVE_INCOMPLET" && metre.manquantes
        ? ` Mesures à relever : ${metre.manquantes.map((m) => NOMS_MESURES[m]).join(", ")}.`
        : "";
      return res.status(422).json({ message: EXPLICATIONS_DEFAUT[metre.motif] + detail, motif: metre.motif, ...(metre.manquantes ? { manquantes: metre.manquantes } : {}) });
    }

    const defaut = await prisma.$transaction(async (tx) => {
      const cree = await tx.defaut.create({
        data: {
        code: c.code ?? null,
        clientOperationId: c.clientOperationId ?? null,
        catalogueId: catalogue.id,
        observationId: c.observationId ?? null,
        missionId: c.missionId ?? null,
        tronconId: c.tronconId ?? null,
        lat: c.lat ?? null,
        lon: c.lon ?? null,
        precisionM: c.precisionM ?? null,
        abscisseM: c.abscisseM ?? null,
        confianceAppariement: c.confianceAppariement ?? null,
        pk: c.pk ?? null,
        nombre: mesures.nombre ?? null,
        longueurM: mesures.longueurM ?? null,
        largeurM: mesures.largeurM ?? null,
        profondeurM: mesures.profondeurM ?? null,
        quantiteSaisie: mesures.quantiteSaisie ?? null,
        quantite: metre.valeur,
        uniteQuantite: metre.valeur !== null ? catalogue.unite : null,
        methodeQuantite: metre.valeur !== null ? metre.methode : null,
        gravite: c.gravite ?? null,
        etendue: c.etendue ?? null,
        constateA,
        constateParId: user.id,
        },
      });
      await logAuditTransactionnelle(tx, {
        userId: user.id, action: "CREATE", entityType: "Defaut",
        entityId: cree.id, after: { code: cree.code, catalogue: catalogue.code, quantite: cree.quantite },
        ipAddress: req.ip,
      });
      return cree;
    });

    // La geometrie ne passe pas par Prisma (colonne Unsupported) : elle se pose apres
    // la ligne, depuis le GPS brut, ou depuis le trace du troncon quand seule la
    // reference papier existe. Un echec ici ne perd pas le defaut : la ligne existe,
    // la position se rattrapera au rematch.
    try {
      if (gps) await setPointGeom("defauts", defaut.id, c.lat!, c.lon!);
      else if (c.tronconId && c.abscisseM !== undefined) {
        await deriveGeomFromTronconAbscisse("defauts", defaut.id, c.tronconId, c.abscisseM);
      } else if (c.tronconId && c.pk !== undefined) {
        await deriveGeomFromTroncon("defauts", defaut.id, c.tronconId, c.pk);
      }
    } catch { /* la ligne est valide, la position se derive plus tard */ }

    // La quantite porte sa provenance : une surface mesuree au decametre et un produit
    // longueur x largeur ne s'additionnent pas sans que personne ne le voie.
    if (metre.valeur !== null) {
      await enregistrerQualite({
        entityType: "Defaut",
        entityId: defaut.id,
        champ: "quantite",
        statut: statutQualiteQuantite(metre.methode),
        source: "saisie_defaut",
        methode: metre.methode,
        observedAt: constateA,
        confiance: metre.methode === "SAISIE" || metre.methode === "COMPTAGE" ? "HIGH" : "MEDIUM",
        note: `Quantité ${metre.valeur} ${catalogue.unite}, obtenue par ${metre.methode}.`,
      });
    }

    return res.status(201).json(defaut);
  } catch (err) {
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/defauts:
 *   get:
 *     summary: Liste les defauts, filtrables par statut, etat et rattachement
 *     tags: [Defauts v2]
 */
defautsV2Router.get("/", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const q = z.object({
      statut: z.enum(["A_VALIDER", "VALIDE", "REJETE", "A_CORRIGER"]).optional(),
      etat: z.enum(["ACTIF", "TRAITE", "DISPARU"]).optional(),
      tronconId: z.string().optional(),
      missionId: z.string().uuid().optional(),
      observationId: z.string().uuid().optional(),
      catalogueCode: z.string().max(64).optional(),
      limite: z.coerce.number().int().min(1).max(200).optional(),
      curseur: z.string().uuid().optional(),
    }).parse(req.query);

    // Un chef de service distribue le travail par type autant que par statut : le filtre
    // par code de catalogue evite une requete par type.
    let catalogueId: number | undefined;
    if (q.catalogueCode) {
      const catalogue = await prisma.catalogueDefaut.findUnique({ where: { code: q.catalogueCode }, select: { id: true } });
      if (!catalogue) return res.json({ defauts: [], curseurSuivant: null });
      catalogueId = catalogue.id;
    }

    const scope = await perimetreDefauts(req.user!);
    const defauts = await prisma.defaut.findMany({
      where: {
        deletedAt: null,
        ...scope,
        ...(q.statut ? { statutValidation: q.statut } : {}),
        ...(q.etat ? { etat: q.etat } : {}),
        ...(q.tronconId ? { tronconId: q.tronconId } : {}),
        ...(q.missionId ? { missionId: q.missionId } : {}),
        ...(q.observationId ? { observationId: q.observationId } : {}),
        ...(catalogueId ? { catalogueId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: q.limite ?? 50,
      ...(q.curseur ? { cursor: { id: q.curseur }, skip: 1 } : {}),
      include: {
        catalogue: { select: { code: true, libelle: true, unite: true } },
        medias: { select: { id: true, type: true, cheminVignette: true } },
        constatePar: { select: { id: true, nomComplet: true } },
        mission: { select: { id: true, code: true, intitule: true } },
      },
    });

    return res.json({
      defauts,
      curseurSuivant: defauts.length === (q.limite ?? 50) ? defauts.at(-1)?.id : null,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/defauts/catalogue:
 *   get:
 *     summary: Liste les types de défaut actifs pour la saisie terrain
 *     tags: [Defauts v2]
 */
defautsV2Router.get("/catalogue", requireAuth, requireModuleAccess("inspections"), async (_req, res, next) => {
  try {
    const catalogue = await prisma.catalogueDefaut.findMany({
      where: { actif: true },
      orderBy: [{ famille: "asc" }, { libelle: "asc" }],
      select: {
        code: true,
        libelle: true,
        famille: true,
        unite: true,
        mesuresRequises: true,
        graviteMax: true,
        version: true,
      },
    });
    return res.json({ catalogue });
  } catch (err) {
    return next(err);
  }
});

/** Lecture du référentiel complet, y compris les entrées désactivées, pour les gestionnaires. */
defautsV2Router.get("/catalogue/admin", requireAuth, requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("inspections"), async (_req, res, next) => {
  try {
    const catalogue = await prisma.catalogueDefaut.findMany({
      orderBy: [{ famille: "asc" }, { libelle: "asc" }],
    });
    return res.json({ catalogue });
  } catch (err) {
    return next(err);
  }
});

/** Ajout versionné au référentiel. Aucun effacement physique : une entrée se désactive. */
defautsV2Router.post("/catalogue", requireAuth, requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const c = catalogueCreation.parse(req.body);
    const user = req.user!;
    const catalogue = await prisma.$transaction(async (tx) => {
      const cree = await tx.catalogueDefaut.create({ data: c });
      await logAuditTransactionnelle(tx, {
        userId: user.id, action: "CREATE", entityType: "CatalogueDefaut", entityId: cree.code,
        after: { ...c, version: cree.version }, ipAddress: req.ip,
      });
      return cree;
    });
    return res.status(201).json(catalogue);
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "P2002") {
      return res.status(409).json({ message: "Ce code de catalogue existe déjà." });
    }
    return next(err);
  }
});

/** Modification par compare-et-échange : chaque changement avance la version métier. */
defautsV2Router.patch("/catalogue/:code", requireAuth, requireRole("ADMIN", "GESTIONNAIRE"), requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const c = catalogueModification.parse(req.body);
    const user = req.user!;
    const avant = await prisma.catalogueDefaut.findUnique({ where: { code: req.params.code } });
    if (!avant) return res.status(404).json({ message: "Type de défaut introuvable." });
    if (avant.version !== c.version) {
      return res.status(409).json({ message: "Le catalogue a changé. Rechargez le référentiel avant d'enregistrer." });
    }
    const { version, ...data } = c;
    const apres = await prisma.$transaction(async (tx) => {
      const maj = await tx.catalogueDefaut.updateMany({
        where: { code: req.params.code, version },
        data: { ...data, version: { increment: 1 } },
      });
      if (maj.count !== 1) return null;
      const valeur = await tx.catalogueDefaut.findUnique({ where: { code: req.params.code } });
      if (!valeur) throw new Error("Type de défaut introuvable après mise à jour.");
      await logAuditTransactionnelle(tx, {
        userId: user.id, action: "UPDATE", entityType: "CatalogueDefaut", entityId: valeur.code,
        before: { libelle: avant.libelle, famille: avant.famille, unite: avant.unite, mesuresRequises: avant.mesuresRequises, graviteMax: avant.graviteMax, actif: avant.actif, version: avant.version },
        after: { libelle: valeur.libelle, famille: valeur.famille, unite: valeur.unite, mesuresRequises: valeur.mesuresRequises, graviteMax: valeur.graviteMax, actif: valeur.actif, version: valeur.version },
        ipAddress: req.ip,
      });
      return valeur;
    });
    if (!apres) return res.status(409).json({ message: "Le catalogue a changé pendant l'enregistrement. Rechargez le référentiel." });
    return res.json(apres);
  } catch (err) {
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/defauts/{id}:
 *   get:
 *     summary: Detail d'un defaut
 *     tags: [Defauts v2]
 */
defautsV2Router.get("/:id", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const scope = await perimetreDefauts(req.user!);
    const defaut = await prisma.defaut.findFirst({
      where: { id: req.params.id, deletedAt: null, ...scope },
      include: {
        catalogue: true,
        medias: { select: { id: true, type: true, chemin: true, cheminVignette: true, sha256: true, mimeType: true, tailleOctets: true, lat: true, lon: true, precisionM: true, cap: true, capturedA: true } },
      },
    });
    if (!defaut) return res.status(404).json({ message: "Défaut introuvable" });
    const validations = await prisma.validation.findMany({
      where: { entityType: "Defaut", entityId: defaut.id },
      orderBy: { decideA: "asc" },
      include: { decidePar: { select: { id: true, nomComplet: true } } },
    });
    return res.json({ ...defaut, validations });
  } catch (err) {
    return next(err);
  }
});

/** Téléverse une preuve photo avec empreinte et métadonnées GPS si disponibles. */
/**
 * Le comptage reprend la VISIBILITE de la route, et pas seulement l'identifiant.
 *
 * Compter sans ce filtre repondrait « cet element porte deja trente photos » a un
 * inspecteur qui n'est ni l'auteur ni gestionnaire, et lui apprendrait ainsi que le
 * defaut existe — ce que le 404 du gestionnaire de route existe justement pour taire.
 *
 * Rendre `null` laisse la route repondre son propre 404. Les deux regles doivent rester
 * alignees, et un test le verifie.
 */
const compterPhotosDefaut = async (req: Request): Promise<number | null> => {
  const user = req.user;
  if (!user) return null;
  const gestionnaire = user.role === "ADMIN" || user.role === "GESTIONNAIRE";
  const defaut = await prisma.defaut.findFirst({
    where: {
      id: req.params.id,
      deletedAt: null,
      ...(gestionnaire ? {} : { constateParId: user.id }),
    },
    select: { _count: { select: { medias: true } } },
  });
  return defaut ? defaut._count.medias : null;
};

defautsV2Router.post("/:id/photos", requireAuth, requireModuleAccess("inspections"), plafondPhotos(compterPhotosDefaut), uploadPhoto, async (req, res, next) => {
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
      await supprimerFichierTemporaire(fichier.path);
      return res.status(400).json({ message: "Métadonnées photo invalides : latitude et longitude doivent être renseignées ensemble." });
    }

    const user = req.user;
    const defaut = await prisma.defaut.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true, constateParId: true },
    });
    const gestionnaire = user.role === "ADMIN" || user.role === "GESTIONNAIRE";
    if (!defaut || (!gestionnaire && defaut.constateParId !== user.id)) {
      await supprimerFichierTemporaire(fichier.path);
      return res.status(404).json({ message: "Défaut introuvable." });
    }

    const bytes = await readFile(fichier.path);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const existante = await prisma.mediaDefaut.findUnique({ where: { sha256 } });
    if (existante) {
      await supprimerFichierTemporaire(fichier.path);
      if (existante.defautId !== defaut.id) {
        return res.status(409).json({ message: "Cette photo est déjà rattachée à une autre preuve." });
      }
      return res.status(200).json(existante);
    }

    try {
      const media = await prisma.$transaction(async (tx) => {
        const cree = await tx.mediaDefaut.create({
          data: {
          defautId: defaut.id,
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
          userId: user.id, action: "CREATE", entityType: "MediaDefaut", entityId: cree.id,
          after: { defautId: defaut.id, sha256, tailleOctets: cree.tailleOctets, lat: cree.lat, lon: cree.lon },
          ipAddress: req.ip,
        });
        return cree;
      });
      return res.status(201).json(media);
    } catch (err) {
      await supprimerFichierTemporaire(photoAbsolutePath(fichier.filename));
      if (typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "P2002") {
        return res.status(409).json({ message: "Cette photo a déjà été enregistrée." });
      }
      throw err;
    }
  } catch (err) {
    if (req.file) await supprimerFichierTemporaire(req.file.path);
    return next(err);
  }
});

/** Propose un appariement local sans modifier le défaut. La confirmation est explicite. */
defautsV2Router.post("/:id/appariement/suggestion", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const user = req.user!;
    const scope = await perimetreDefauts(user);
    const defaut = await prisma.defaut.findFirst({
      where: { id: req.params.id, deletedAt: null, ...scope },
      select: { id: true, lat: true, lon: true, precisionM: true },
    });
    if (!defaut) return res.status(404).json({ message: "Défaut introuvable." });
    if (defaut.lat == null || defaut.lon == null) {
      return res.status(422).json({ message: "Ce défaut n'a pas de position GPS à apparier." });
    }
    const suggestion = await apparier(
      { lat: defaut.lat, lon: defaut.lon, precisionM: defaut.precisionM },
      { emprise: empriseLocale(defaut.lat, defaut.lon) },
    );
    return res.json({ suggestion, motif: suggestion ? null : "AUCUN_CANDIDAT_SUR" });
  } catch (err) {
    return next(err);
  }
});

/** Confirme un tronçon proposé, après recalcul serveur depuis le GPS brut conservé. */
defautsV2Router.post("/:id/appariement/confirmation", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const c = z.object({ tronconId: z.string().min(1) }).strict().parse(req.body);
    const user = req.user!;
    const scope = await perimetreDefauts(user);
    const defaut = await prisma.defaut.findFirst({
      where: { id: req.params.id, deletedAt: null, ...scope },
      select: { id: true, lat: true, lon: true, precisionM: true, version: true, tronconId: true },
    });
    if (!defaut) return res.status(404).json({ message: "Défaut introuvable." });
    if (defaut.lat == null || defaut.lon == null) {
      return res.status(422).json({ message: "Ce défaut n'a pas de position GPS à apparier." });
    }
    const suggestion: Appariement | null = await apparier(
      { lat: defaut.lat, lon: defaut.lon, precisionM: defaut.precisionM },
      { emprise: empriseLocale(defaut.lat, defaut.lon) },
    );
    if (!suggestion || suggestion.tronconId !== c.tronconId) {
      return res.status(409).json({ message: "Le tronçon demandé ne correspond plus au candidat calculé. Rechargez la suggestion." });
    }
    const apres = await prisma.$transaction(async (tx) => {
      const maj = await tx.defaut.updateMany({
        where: { id: defaut.id, deletedAt: null, version: defaut.version },
        data: {
          tronconId: suggestion.tronconId,
          abscisseM: suggestion.abscisseM,
          pk: suggestion.pk,
          confianceAppariement: suggestion.confiance,
          version: { increment: 1 },
        },
      });
      if (maj.count !== 1) return null;
      const valeur = await tx.defaut.findUnique({ where: { id: defaut.id } });
      if (!valeur) throw new Error("Défaut absent après confirmation d'appariement.");
      await logAuditTransactionnelle(tx, {
        userId: user.id, action: "UPDATE", entityType: "Defaut", entityId: defaut.id,
        before: { tronconId: defaut.tronconId, version: defaut.version },
        after: { tronconId: suggestion.tronconId, abscisseM: suggestion.abscisseM, pk: suggestion.pk, confianceAppariement: suggestion.confiance, version: valeur.version },
        ipAddress: req.ip,
      });
      return valeur;
    });
    if (!apres) return res.status(409).json({ message: "Le défaut a changé. Rechargez-le avant de confirmer l'appariement." });
    return res.json({ defaut: apres, appariement: suggestion });
  } catch (err) {
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/defauts/{id}/decision:
 *   post:
 *     summary: Valide, rejette ou renvoie en correction un defaut
 *     description: >
 *       Decision de tiers habilite. L'auteur du defaut ne peut pas trancher sa propre
 *       saisie ; un rejet ou un renvoi en correction doit dire ce qui doit etre repris.
 *       Chaque decision ecrit une ligne d'historique dans validations, et l'acte est
 *       audite sous VALIDATE, REJECT ou UPDATE.
 *     tags: [Defauts v2]
 */
const deciderDefaut: RequestHandler = async (req, res, next) => {
  try {
    const c = z.object({
      decision: z.enum(["VALIDE", "REJETE", "A_CORRIGER"]),
      commentaire: z.string().max(2000).optional(),
    }).strict().parse(req.body);

    const user = req.user!;
    const scope = await perimetreDefauts(user);
    const defaut = await prisma.defaut.findFirst({
      where: { id: req.params.id, deletedAt: null, ...scope },
    });
    if (!defaut) return res.status(404).json({ message: "Défaut introuvable" });

    // L'AUTEUR VIENT DE LA LIGNE, PAS DE LA REQUETE. C'est le point ou la separation
    // des roles se tient ou tombe : un auteur fourni par le client desactiverait le
    // controle sans trace. Voir l'en-tete du fichier.
    const verdict = validationPermise({
      entityType: "Defaut",
      statutActuel: defaut.statutValidation,
      auteurId: defaut.constateParId,
      validateurId: user.id,
      validateurRole: user.role,
      decision: c.decision,
      commentaire: c.commentaire,
    });
    if (!verdict.permis) {
      const code = verdict.motif === "ROLE_INSUFFISANT" || verdict.motif === "AUTO_VALIDATION" ? 403 : 409;
      return res.status(code).json({ message: EXPLICATIONS_VALIDATION[verdict.motif], motif: verdict.motif, statut: defaut.statutValidation });
    }

    const origine = defaut.clientOperationId ? "terrain" : "console";

    const apres = await prisma.$transaction(async (tx) => {
      const maj = await tx.defaut.updateMany({
        where: {
          id: defaut.id,
          deletedAt: null,
          statutValidation: defaut.statutValidation,
          version: defaut.version,
        },
        data: {
          statutValidation: c.decision,
          // La version avance : un appareil parti avec l'ancienne verra un conflit
          // plutot que d'ecraser la decision.
          version: { increment: 1 },
        },
      });
      // Compare-et-échange : une seule décision peut gagner à partir de la même
      // version. L'historique et l'état métier sont écrits dans cette transaction.
      if (maj.count !== 1) return null;
      const defautMisAJour = await tx.defaut.findUnique({ where: { id: defaut.id } });
      if (!defautMisAJour) throw new Error("Défaut absent après décision de validation.");
      // L'historique, pas l'etat courant : un objet renvoye en correction puis
      // represente doit garder la chaine complete de ses decisions.
      await tx.validation.create({
        data: {
          entityType: "Defaut",
          entityId: defaut.id,
          statutAvant: defaut.statutValidation,
          statutApres: c.decision,
          decideParId: user.id,
          auteurId: defaut.constateParId,
          source: origine,
          commentaire: c.commentaire ?? null,
        },
      });
      await logAuditTransactionnelle(tx, {
        userId: user.id,
        action: c.decision === "VALIDE" ? "VALIDATE" : c.decision === "REJETE" ? "REJECT" : "UPDATE",
        entityType: "Defaut",
        entityId: defaut.id,
        before: { statutValidation: defaut.statutValidation, version: defaut.version },
        after: { statutValidation: defautMisAJour.statutValidation, version: defautMisAJour.version, commentaire: c.commentaire ?? null },
        ipAddress: req.ip,
      });
      return defautMisAJour;
    });

    if (!apres) {
      return res.status(409).json({ message: "Le défaut a changé pendant la décision. Rechargez la file avant de réessayer." });
    }

    if (c.decision === "VALIDE") {
      await enregistrerQualite({
        entityType: "Defaut",
        entityId: defaut.id,
        champ: "statutValidation",
        statut: "OBSERVED",
        source: `Validation par ${user.role}`,
        methode: "VALIDATION_HUMAINE",
        observedAt: new Date(),
        confiance: "HIGH",
        note: "Défaut validé : il devient une donnée officielle.",
      });
    }

    return res.json(apres);
  } catch (err) {
    return next(err);
  }
};

/**
 * DEUX CHEMINS, UN SEUL GESTIONNAIRE.
 *
 * Le §25 du cahier nomme l'operation `POST /defects/{id}/validate` ; la route posee ici
 * s'appelait `/decision`, ce qui decrit mieux l'acte — on y rejette et on y renvoie en
 * correction autant qu'on y valide — mais ne repond pas au contrat annonce.
 *
 * Les deux sont donc exposes, et c'est la MEME fonction qui les sert. Recopier le corps
 * aurait produit deux comportements qui divergent sans que rien ne le signale : chacun
 * passerait ses propres tests pendant que l'un laisserait valider ce que l'autre refuse.
 * C'est la raison pour laquelle la regle de validation elle-meme ne vit qu'a un endroit
 * (governance/validation.ts), et le meme raisonnement s'applique a son point d'entree.
 *
 * Aucun des deux n'est deprecie pour l'instant : l'interface locale appelle `/decision`,
 * et retirer ce chemin casserait un client livre pour satisfaire un nom. Le choix du
 * chemin public, et donc de celui a deprecier, est a arbitrer.
 */
defautsV2Router.post("/:id/decision", requireAuth, requireModuleAccess("inspections"), deciderDefaut);

/**
 * @openapi
 * /api/v2/defauts/{id}/validate:
 *   post:
 *     summary: Validation tierce d'un defaut (nom du contrat, §25)
 *     description: >
 *       Alias exact de `/decision`, meme gestionnaire et memes controles : separation
 *       des roles, transition autorisee, commentaire obligatoire pour un refus, ligne
 *       d'historique dans validations et audit transactionnel.
 *     tags: [Defauts v2]
 */
defautsV2Router.post("/:id/validate", requireAuth, requireModuleAccess("inspections"), deciderDefaut);

/**
 * @openapi
 * /api/v2/defauts/{id}/resoumettre:
 *   post:
 *     summary: Represente un defaut renvoye en correction
 *     description: >
 *       Reserve a l'auteur du defaut (ou a un administrateur en son nom). Le releve
 *       corrige repasse les memes controles qu'a la creation : un type qui exige une
 *       profondeur ne revient pas sans elle.
 *     tags: [Defauts v2]
 */
defautsV2Router.post("/:id/resoumettre", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const c = z.object({
      mesures: mesuresSchema.optional(),
      gravite: z.number().int().min(1).optional(),
      etendue: z.enum(["PONCTUEL", "LOCALISE", "ETENDU", "GENERALISE"]).optional(),
      commentaire: z.string().max(2000).optional(),
    }).strict().parse(req.body);

    const user = req.user!;
    const defaut = await prisma.defaut.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: { catalogue: true },
    });
    if (!defaut) return res.status(404).json({ message: "Défaut introuvable" });

    if (defaut.statutValidation !== "A_CORRIGER") {
      return res.status(409).json({ message: "Seul un défaut renvoyé en correction peut être resoumis." });
    }
    // Resoumettre, c'est repondre a la demande de correction : c'est l'affaire de
    // l'auteur. Un administrateur peut le faire en son nom ; personne d'autre.
    if (user.id !== defaut.constateParId && user.role !== "ADMIN") {
      return res.status(403).json({ message: "Seul l'auteur du relevé peut le resoumettre." });
    }

    const mesures: MesuresDefaut = {
      nombre: c.mesures?.nombre ?? defaut.nombre,
      longueurM: c.mesures?.longueurM ?? defaut.longueurM,
      largeurM: c.mesures?.largeurM ?? defaut.largeurM,
      profondeurM: c.mesures?.profondeurM ?? defaut.profondeurM,
      quantiteSaisie: c.mesures?.quantiteSaisie ?? defaut.quantiteSaisie,
    };
    const troncon = defaut.tronconId
      ? await prisma.troncon.findUnique({ where: { id: defaut.tronconId }, select: { longueurKm: true } })
      : null;
    const metre = metrer(mesures, typeDefaut(defaut.catalogue), troncon?.longueurKm ? troncon.longueurKm * 1000 : null);
    if (metre.valeur === null && metre.motif !== "MESURES_INSUFFISANTES") {
      const detail = metre.motif === "RELEVE_INCOMPLET" && metre.manquantes
        ? ` Mesures à relever : ${metre.manquantes.map((m) => NOMS_MESURES[m]).join(", ")}.`
        : "";
      return res.status(422).json({ message: EXPLICATIONS_DEFAUT[metre.motif] + detail, motif: metre.motif });
    }

    const gravite = c.gravite !== undefined ? c.gravite : defaut.gravite;
    const verdictGravite = graviteValide(gravite, defaut.catalogue.graviteMax);
    if (!verdictGravite.permis) {
      return res.status(422).json({ message: EXPLICATIONS_DEFAUT[verdictGravite.motif], motif: verdictGravite.motif });
    }

    const apres = await prisma.$transaction(async (tx) => {
      const maj = await tx.defaut.updateMany({
        where: { id: defaut.id, deletedAt: null, statutValidation: "A_CORRIGER", version: defaut.version },
        data: {
          statutValidation: StatutValidation.A_VALIDER,
          version: defaut.version + 1,
          nombre: mesures.nombre ?? null,
          longueurM: mesures.longueurM ?? null,
          largeurM: mesures.largeurM ?? null,
          profondeurM: mesures.profondeurM ?? null,
          quantiteSaisie: mesures.quantiteSaisie ?? null,
          quantite: metre.valeur,
          uniteQuantite: metre.valeur !== null ? defaut.catalogue.unite : null,
          methodeQuantite: metre.valeur !== null ? metre.methode : null,
          gravite: gravite ?? null,
          etendue: c.etendue ?? defaut.etendue,
        },
      });
      if (maj.count !== 1) return null;
      const defautMisAJour = await tx.defaut.findUnique({ where: { id: defaut.id } });
      if (!defautMisAJour) throw new Error("Défaut absent après resoumission.");
      await tx.validation.create({
        data: {
          entityType: "Defaut",
          entityId: defaut.id,
          statutAvant: defaut.statutValidation,
          statutApres: StatutValidation.A_VALIDER,
          decideParId: user.id,
          auteurId: defaut.constateParId,
          source: "resoumission",
          commentaire: c.commentaire ?? null,
        },
      });
      await logAuditTransactionnelle(tx, {
        userId: user.id, action: "UPDATE", entityType: "Defaut", entityId: defaut.id,
        before: { statutValidation: defaut.statutValidation, version: defaut.version },
        after: { statutValidation: defautMisAJour.statutValidation, version: defautMisAJour.version },
        ipAddress: req.ip,
      });
      return defautMisAJour;
    });
    if (!apres) return res.status(409).json({ message: "Le défaut a changé pendant la resoumission. Rechargez-le avant de réessayer." });

    return res.json(apres);
  } catch (err) {
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/defauts/{id}/etat:
 *   post:
 *     summary: Fait avancer le defaut dans son cycle de vie physique
 *     description: >
 *       ACTIF, TRAITE ou DISPARU. Distinct de la validation : un defaut valide peut
 *       etre repare sans que sa validation soit remise en cause, et la date de
 *       traitement est posee par le serveur, pas declaree par l'appelant.
 *     tags: [Defauts v2]
 */
defautsV2Router.post("/:id/etat", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const { etat } = z.object({
      etat: z.enum(["ACTIF", "TRAITE", "DISPARU"]),
    }).strict().parse(req.body);

    const user = req.user!;
    const scope = await perimetreDefauts(user);
    const defaut = await prisma.defaut.findFirst({ where: { id: req.params.id, deletedAt: null, ...scope } });
    if (!defaut) return res.status(404).json({ message: "Défaut introuvable" });

    if (!transitionEtatPermise(defaut.etat, etat)) {
      return res.status(409).json({ message: `Transition ${defaut.etat} vers ${etat} non autorisée` });
    }

    // TRAITE se date au moment du geste ; le retour a ACTIF efface cette date : une
    // reparation qui ne tient pas n'a pas de date de traitement. DISPARU n'en a pas :
    // une crue n'est pas un chantier.
    const apres = await prisma.$transaction(async (tx) => {
      const maj = await tx.defaut.updateMany({
        where: { id: defaut.id, deletedAt: null, version: defaut.version, ...scope },
        data: {
          etat,
          traiteA: etat === "TRAITE" ? new Date() : null,
          version: { increment: 1 },
        },
      });
      if (maj.count !== 1) return null;
      const valeur = await tx.defaut.findUnique({ where: { id: defaut.id } });
      if (!valeur) throw new Error("Défaut absent après compare-et-échange.");
      await logAuditTransactionnelle(tx, {
        userId: user.id, action: "UPDATE", entityType: "Defaut", entityId: defaut.id,
        before: { etat: defaut.etat, traiteA: defaut.traiteA },
        after: { etat: valeur.etat, traiteA: valeur.traiteA },
        ipAddress: req.ip,
      });
      return valeur;
    });
    if (!apres) {
      return res.status(409).json({ message: "Le défaut a changé ou n'est plus dans votre périmètre." });
    }

    return res.json(apres);
  } catch (err) {
    return next(err);
  }
});
