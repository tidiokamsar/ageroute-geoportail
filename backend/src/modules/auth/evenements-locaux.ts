import type { NextFunction, Request, Response } from "express";
import rateLimit, { MemoryStore } from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { logAuditTransactionnelle } from "../../utils/audit";
import { ApiError } from "../../middleware/error.middleware";

/**
 * `POST /api/auth/evenements-locaux` : les evenements de session locale, remontes a la reconnexion.
 *
 * POURQUOI CETTE ROUTE (`docs/securite/SESSION-HORS-LIGNE.md` section 5)
 *
 * Hors ligne, l'application ouvre un coffre local protege par un PIN. Ce qui s'y passe (ouverture,
 * deverrouillages, echecs, verrou d'inactivite, fermeture, reinitialisation du PIN, effacement local) ne peut
 * pas etre journalise par le serveur sur le moment. L'appareil le garde dans un lot borne et le depose ici au
 * retour du reseau, pour que l'administrateur puisse relire un incident (un telephone perdu dont le PIN a ete
 * essaye vingt fois) dans `audit_logs`.
 *
 * CE QUE LA ROUTE EST ET N'EST PAS
 *
 *  - Un CANAL D'ECRITURE dans le journal d'audit ouvert a tout compte authentifie. C'est pourquoi tout y est
 *    ferme : liste d'evenements fermee, champs fermes (`strict`), taille du lot et longueur des champs bornees,
 *    debit limite par compte. Un client qui y deposerait un PIN, un payload ou un texte libre est REFUSE EN ENTIER.
 *  - Un journal de DECLARATIONS, pas de preuves. Le serveur n'a pas vu ces evenements : l'horodatage client est
 *    conserve tel quel, marque `horodatageClientFiable: false`, et l'heure qui fait foi est celle de la ligne
 *    d'audit (`createdAt`, horloge du serveur). Un attaquant qui controle l'appareil peut omettre ou inventer des
 *    evenements ; ceux qui sont detruits par un effacement local ne partent pas (limite connue du document).
 *
 * IDEMPOTENCE
 *
 * Le client donne un identifiant (UUID) a chaque evenement. La ligne d'audit le porte dans `entityId` ; un lot
 * rejoue (reponse perdue, reconnexions en boucle) n'ajoute aucune ligne. La cle est (compte, identifiant), jamais
 * l'identifiant seul : un compte ne peut ni masquer ni predire les evenements d'un autre. Le lot s'ecrit sous un
 * verrou de transaction PAR COMPTE, pour que deux rejeux simultanes ne doublent pas les lignes (l'index de la
 * table, `(entityType, entityId)`, n'est pas unique).
 */

/** Evenements acceptes : la liste fermee de la conception. Tout autre est refuse. */
export const EVENEMENTS_LOCAUX = [
  "OUVERTURE_HORS_LIGNE",
  "DEVERROUILLAGE",
  "ECHEC_DEVERROUILLAGE",
  "VERROU_INACTIVITE",
  "SESSION_LOCALE_FERMEE",
  "SESSION_LOCALE_EXPIREE",
  "PIN_REINITIALISE",
  "EFFACEMENT_LOCAL",
] as const;

/** Un lot tient largement une journee d'evenements d'un agent ; au-dela, le client decoupe. */
export const EVENEMENTS_LOCAUX_MAX_PAR_LOT = 50;
/** Plafond de l'agregat `occurrences` (ex. 12 echecs de deverrouillage regroupes en un evenement). */
const OCCURRENCES_MAX = 1000;
/** Une date ISO 8601 complete fait 24 caracteres ; la marge permet un decalage (`+01:00`) et rien de plus. */
const HORODATAGE_LONGUEUR_MAX = 40;

/**
 * DEBIT, DEUX PLAFONDS (D9, point 3). Valeurs PROVISOIRES, choisies sans mesure de production : elles se reglent ici,
 * en un seul endroit, quand les premiers usages reels diront ce qu'un agent produit.
 *
 *  - FENETRE COURTE : `EVENEMENTS_LOCAUX_LOTS_PAR_FENETRE` lots par 15 minutes et par compte. Un agent normal depose un
 *    lot par reconnexion ; cinq lots en un quart d'heure couvrent une zone de couverture instable (reconnexions en
 *    boucle) sans permettre a un script de saturer le journal. Avant : 30 lots x 50 evenements = 1 500 lignes par
 *    quart d'heure, soit 144 000 lignes par jour et par compte dans `audit_logs`.
 *  - PLAFOND JOURNALIER : `EVENEMENTS_LOCAUX_MAX_PAR_JOUR` lignes par compte sur les 24 DERNIERES heures (fenetre
 *    glissante, pas un jour calendaire : un jour calendaire laisserait doubler le plafond autour de minuit). Compte
 *    les lignes deja ecrites, dans la transaction du lot, sous le verrou par compte : deux lots simultanes ne le
 *    depassent pas. Un lot qui le ferait depasser est refuse EN ENTIER (429, `PLAFOND_JOURNALIER_ATTEINT`) ; un
 *    lot entierement connu (rejeu) n'ajoute rien et passe toujours. 500 lignes par jour, c'est plus de deux fois ce
 *    qu'un agent produit en usage normal (ouverture, deverrouillages, verrous, fermeture) ; les echecs de PIN se
 *    regroupent en un evenement (`occurrences`).
 *
 * Limite connue : le comptage lit l'index `audit_logs(userId)` puis filtre ; un index `(userId, entityType, createdAt)`
 * le rendrait immediat (migration, hors de ce chantier).
 */
export const EVENEMENTS_LOCAUX_LOTS_PAR_FENETRE = 5;
export const EVENEMENTS_LOCAUX_FENETRE_MS = 15 * 60 * 1000;
export const EVENEMENTS_LOCAUX_MAX_PAR_JOUR = 500;
const JOUR_MS = 24 * 60 * 60 * 1000;

/** Type d'entite des lignes d'audit ecrites par cette route. */
export const ENTITE_EVENEMENT_LOCAL = "EvenementLocal";

const evenement = z.object({
  id: z.string().uuid(),
  evenement: z.enum(EVENEMENTS_LOCAUX),
  // ISO 8601 stricte (avec « Z » ou un decalage). `Date.parse` accepte presque tout (« <img ...> 1 » passait) et la valeur est
  // ecrite telle quelle dans le journal : une forme stricte l'empeche d'y porter du texte libre. Le client emet `toISOString()`.
  horodatageClient: z.string().max(HORODATAGE_LONGUEUR_MAX).datetime({ offset: true, message: "Date ISO 8601 invalide" }),
  occurrences: z.number().int().min(1).max(OCCURRENCES_MAX).optional(),
}).strict();

const lot = z.object({
  appareilId: z.string().uuid().optional(),
  evenements: z.array(evenement).min(1).max(EVENEMENTS_LOCAUX_MAX_PAR_LOT),
}).strict();

/**
 * Debit : `EVENEMENTS_LOCAUX_LOTS_PAR_FENETRE` lots par 15 minutes ET PAR COMPTE (et non par adresse, comme les autres
 * limiteurs : derriere un NAT d'operateur, plusieurs agents partagent une adresse, et un seul agent defaillant ne doit
 * pas couper les autres), plus le plafond journalier ci-dessus. Un agent normal depose un lot par reconnexion. Le
 * magasin est explicite pour pouvoir etre remis a zero en test.
 */
const magasin = new MemoryStore();
export function _reinitialiserLimiteEvenementsLocaux(): void {
  void magasin.resetAll();
}
export const limiteurEvenementsLocaux = rateLimit({
  windowMs: EVENEMENTS_LOCAUX_FENETRE_MS,
  max: EVENEMENTS_LOCAUX_LOTS_PAR_FENETRE,
  store: magasin,
  standardHeaders: true,
  legacyHeaders: false,
  // Pose APRES requireAuth : l'identite est celle de la base. Repli sur une cle fixe si elle manquait (jamais
  // atteint : la route est derriere requireAuth).
  keyGenerator: (req: Request) => req.user?.id ?? "anonyme",
  message: { error: "Trop d'evenements locaux envoyes, reessayez plus tard", code: "TROP_DE_REQUETES" },
});

export async function evenementsLocauxHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new ApiError(401, "Authentification requise");
    const user = req.user;
    const corps = lot.parse(req.body);

    // L'appareil n'est ATTRIBUE que s'il appartient au compte (un identifiant n'est pas une autorisation). Un appareil
    // revoque reste acceptable : ce sont des faits d'audit, pas des droits.
    let appareil: { id: string; revoqueA: Date | null } | null = null;
    if (corps.appareilId) {
      appareil = await prisma.appareil.findFirst({
        where: { id: corps.appareilId, userId: user.id },
        select: { id: true, revoqueA: true },
      });
    }

    const resultat = await prisma.$transaction(async (tx) => {
      // Un verrou par compte : deux rejeux simultanes du meme lot se serialisent, le second voit les lignes du premier.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`evenements-locaux:${user.id}`}))`;
      const existants = await tx.auditLog.findMany({
        where: { userId: user.id, entityType: ENTITE_EVENEMENT_LOCAL, entityId: { in: corps.evenements.map((e) => e.id) } },
        select: { entityId: true },
      });
      const vus = new Set(existants.map((l) => l.entityId));
      // Les evenements qui AJOUTENT une ligne : ni deja connus, ni repetes dans le lot.
      const aEcrire = corps.evenements.filter((e) => {
        if (vus.has(e.id)) return false;
        vus.add(e.id);
        return true;
      });
      if (aEcrire.length > 0) {
        const dejaEcrites = await tx.auditLog.count({
          where: { userId: user.id, entityType: ENTITE_EVENEMENT_LOCAL, createdAt: { gte: new Date(Date.now() - JOUR_MS) } },
        });
        if (dejaEcrites + aEcrire.length > EVENEMENTS_LOCAUX_MAX_PAR_JOUR) {
          return { plafond: true as const, restant: Math.max(0, EVENEMENTS_LOCAUX_MAX_PAR_JOUR - dejaEcrites) };
        }
      }
      for (const e of aEcrire) {
        await logAuditTransactionnelle(tx, {
          userId: user.id,
          action: "SECURITY_EVENT",
          entityType: ENTITE_EVENEMENT_LOCAL,
          entityId: e.id,
          // Seuls ces champs sont ecrits. Rien de ce que le client a envoye en dehors d'eux n'atteint la base.
          after: {
            evenement: e.evenement,
            horodatageClient: e.horodatageClient,
            horodatageClientFiable: false,
            appareilId: appareil?.id ?? null,
            appareilReconnu: appareil !== null,
            appareilRevoque: appareil?.revoqueA != null,
            occurrences: e.occurrences ?? 1,
          },
          ipAddress: req.ip,
        });
      }
      return { plafond: false as const, enregistres: aEcrire.length };
    });

    if (resultat.plafond) {
      res.status(429).json({
        error: "Plafond journalier d'evenements locaux atteint : ce lot n'a pas ete enregistre, reessayez plus tard.",
        code: "PLAFOND_JOURNALIER_ATTEINT",
        plafondJournalier: EVENEMENTS_LOCAUX_MAX_PAR_JOUR,
        restantSurLes24Heures: resultat.restant,
      });
      return;
    }
    res.json({ recus: corps.evenements.length, enregistres: resultat.enregistres, dejaConnus: corps.evenements.length - resultat.enregistres });
  } catch (err) {
    next(err);
  }
}
