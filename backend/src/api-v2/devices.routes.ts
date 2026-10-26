import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { prisma } from "../lib/prisma";
import { logAuditTransactionnelle } from "../utils/audit";
import { dureeEnMs, JETON_ACCES_REPLI_MS } from "../lib/duree";
import { verrouillerPourRevocation } from "../modules/auth/session-verrou";

/**
 * `/api/v2/devices` — appareils autorises a remonter du terrain.
 *
 * POURQUOI CE DOMAINE AVANT LES AUTRES
 *
 * `sync/push` exige un `appareilId` et refuse tout appareil inconnu ou revoque. Sans
 * route pour en enregistrer un, le protocole de synchronisation etait inutilisable :
 * la chaine s'arretait avant de commencer.
 *
 * CE QU'UN APPAREIL AJOUTE A UN COMPTE
 *
 * La possibilite de couper UN telephone sans couper son porteur. Un agent qui perd
 * son appareil en mission doit pouvoir le signaler et continuer a travailler depuis
 * un autre ; revoquer son compte le priverait aussi de la console web, et personne ne
 * le signalerait donc avant le retour de mission. La revocation est irreversible par
 * construction : on n'annule pas une revocation, on enregistre un nouvel appareil.
 *
 * CE QUI N'EST PAS ICI
 *
 * Aucun secret d'appareil, aucun jeton propre. L'authentification reste celle du
 * compte, deja solide : JWT a rotation, Argon2id, cookie HttpOnly. Ajouter une
 * seconde voie d'authentification sans necessite, c'est ajouter une seconde voie a
 * compromettre.
 */

export const devicesV2Router = Router();

const enregistrement = z.object({
  /**
   * Identifiant d'un appareil DEJA enregistre par ce compte, pour le declarer de nouveau (reinstallation de
   * l'application, perte du stockage local). Absent : un nouvel appareil est cree. L'identifiant n'est JAMAIS
   * choisi par le client pour un appareil neuf : le serveur le genere.
   */
  appareilId: z.string().uuid().optional(),
  nom: z.string().min(1).max(120).optional(),
  plateforme: z.enum(["android", "ios", "web"]),
  modele: z.string().max(120).optional(),
  versionOs: z.string().max(60).optional(),
  versionApp: z.string().max(60).optional(),
});

/**
 * Un meme porteur ne doit pas accumuler des appareils fantomes.
 *
 * Une application reinstallee enregistre un nouvel appareil ; sans plafond, un
 * telephone capricieux en creerait des dizaines, et la liste des appareils a
 * surveiller deviendrait illisible au moment ou elle sert, c'est-a-dire quand il faut
 * en revoquer un vite.
 */
export const APPAREILS_ACTIFS_MAX = 10;

/** Portee de la coupure des sessions de rafraichissement a la revocation d'un appareil (aucun lien appareil-session). */
export const PORTEE_SESSIONS_REVOQUEES = "TOUTES_LES_SESSIONS_DU_PROPRIETAIRE";

/** Duree de vie d'un jeton d'acces : c'est la duree pendant laquelle un jeton emis AVANT une revocation reste valable. */
export function dureeJetonAccesMs(): number {
  // Lu a l'appel et non importe de `config/env` : ce module est charge par des routes dont les tests n'ont pas d'environnement.
  // `config/env` a deja charge `.env` dans `process.env` au demarrage du serveur, et applique le meme defaut (15m).
  return dureeEnMs(process.env.JWT_ACCESS_EXPIRES_IN, JETON_ACCES_REPLI_MS);
}

/**
 * Refus d'un appareil, avec un code STABLE que le client consulte (le texte, lui, peut changer).
 *
 *  - `APPAREIL_INCONNU` : l'identifiant n'existe pas, ou appartient a un autre compte. Le message historique
 *    est conserve a l'identique pour les clients deja deployes, qui le reconnaissent pour s'enregistrer de nouveau.
 *  - `APPAREIL_REVOQUE` : l'appareil est celui de ce compte et a ete revoque. Le client doit CESSER de
 *    s'enregistrer seul et de pousser : seule une action de l'utilisateur ou d'un administrateur peut y mettre fin.
 */
export function refuserAppareil(res: Response, code: "APPAREIL_INCONNU" | "APPAREIL_REVOQUE") {
  return res.status(403).json({
    code,
    message: code === "APPAREIL_REVOQUE"
      ? "Appareil révoqué : il ne peut plus synchroniser. Contactez un administrateur."
      : "Appareil inconnu, révoqué ou non autorisé",
  });
}

/**
 * @openapi
 * /api/v2/devices:
 *   post:
 *     summary: Enregistre un appareil pour le compte authentifie
 *     tags: [Devices v2]
 */
devicesV2Router.post("/", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const { appareilId, ...c } = enregistrement.parse(req.body);
    const user = req.user!;

    /**
     * RE-DECLARATION D'UN APPAREIL CONNU (D4, defaut 3).
     *
     * Avant, le client se re-enregistrait seul des qu'il recevait un 403 de `sync/push`, et obtenait un nouvel
     * identifiant : un appareil revoque revenait donc sous une autre identite. Un identifiant revoque est maintenant
     * refuse avec un code qui le dit (`APPAREIL_REVOQUE`) ; un identifiant inconnu OU d'un autre compte rend
     * `APPAREIL_INCONNU` (aucune information sur les appareils d'autrui) ; un appareil actif du compte est rendu
     * tel quel, sans doublon. Un appareil revoque ne revient pas sous son identifiant : le seul chemin est un NOUVEL
     * appareil, enregistre SANS identifiant. Attention, ce chemin n'est PAS ferme par la coupure des sessions de
     * rafraichissement : il n'exige qu'un jeton d'acces valide, et celui qu'un telephone vole detenait avant la
     * revocation le reste pendant `JWT_ACCESS_EXPIRES_IN`. C'est la fenetre traitee plus bas (D9, point 6).
     */
    if (appareilId) {
      const connu = await prisma.appareil.findUnique({ where: { id: appareilId } });
      if (!connu || connu.userId !== user.id) return refuserAppareil(res, "APPAREIL_INCONNU");
      if (connu.revoqueA) return refuserAppareil(res, "APPAREIL_REVOQUE");
      return res.status(200).json(await prisma.appareil.update({ where: { id: connu.id }, data: { ...c, dernierVuA: new Date() } }));
    }

    /**
     * FENETRE RESIDUELLE APRES REVOCATION (D9, point 6).
     *
     * Le jeton d'acces ne porte aucun identifiant d'appareil : la revocation coupe les sessions de rafraichissement
     * du proprietaire, mais un jeton d'acces deja emis reste valable `JWT_ACCESS_EXPIRES_IN` (15 minutes par
     * defaut). Pendant ce delai, le porteur d'un telephone vole pouvait enregistrer un appareil NEUF (201) puis
     * pousser (200) : c'est le chemin que le refus d'`appareilId` revoque (D4) laisse ouvert.
     *
     * Sans migration, on ferme ce chemin en refusant la CREATION d'un appareil neuf tant qu'un appareil du compte a
     * ete revoque depuis moins de la duree d'un jeton d'acces. Au-dela, tout jeton emis avant la revocation est
     * expire : ceux qui existent ont ete emis apres, donc par une session ouverte apres la revocation (mot de passe
     * reconnu). La re-declaration d'un appareil DEJA enregistre et actif (ci-dessus) n'est pas concernee.
     *
     * COMPROMIS, dit sans detour : un agent legitime dont un AUTRE appareil vient d'etre retire (ou un agent dont
     * un administrateur vient de retirer l'appareil) attend au plus `JWT_ACCESS_EXPIRES_IN` avant d'enregistrer
     * son nouveau telephone. Un affinement sans migration existe (comparer le `iat` du jeton a la date de
     * revocation) ; il demande de porter `iat` sur `req.user` et n'est pas fait ici.
     */
    const fenetre = dureeJetonAccesMs();
    const resultat = await prisma.$transaction(async (tx) => {
      const recente = await tx.appareil.findFirst({
        where: { userId: user.id, revoqueA: { gt: new Date(Date.now() - fenetre) } },
        orderBy: { revoqueA: "desc" },
        select: { revoqueA: true },
      });
      if (recente?.revoqueA) {
        return { type: "REVOCATION_RECENTE" as const, reessayerDansMs: Math.max(1000, recente.revoqueA.getTime() + fenetre - Date.now()) };
      }

      const actifs = await tx.appareil.count({ where: { userId: user.id, revoqueA: null } });
      if (actifs >= APPAREILS_ACTIFS_MAX) return { type: "PLAFOND" as const };

      const cree = await tx.appareil.create({
        data: { ...c, userId: user.id, dernierVuA: new Date() },
      });
      await logAuditTransactionnelle(tx, {
        userId: user.id, action: "CREATE", entityType: "Appareil", entityId: cree.id,
        after: { plateforme: cree.plateforme, modele: cree.modele },
        ipAddress: req.ip,
      });
      return { type: "CREE" as const, appareil: cree };
    }, { isolationLevel: "Serializable" });

    if (resultat.type === "PLAFOND") {
      return res.status(409).json({
        message: `Limite de ${APPAREILS_ACTIFS_MAX} appareils actifs atteinte. Révoquez-en un avant d'en ajouter.`,
      });
    }
    if (resultat.type === "REVOCATION_RECENTE") {
      return res.status(403).json({
        code: "APPAREIL_REVOCATION_RECENTE",
        message: "Un appareil de ce compte vient d'être révoqué : l'enregistrement d'un nouvel appareil est suspendu quelques minutes.",
        reessayerDansMs: resultat.reessayerDansMs,
      });
    }
    const appareil = resultat.appareil;

    return res.status(201).json(appareil);
  } catch (err) {
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/devices:
 *   get:
 *     summary: Liste les appareils — les siens, ou tous pour un ADMIN
 *     tags: [Devices v2]
 */
devicesV2Router.get("/", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const user = req.user!;
    // Controle de PERIMETRE, pas seulement de role : un agent voit ses appareils, pas
    // la flotte. Sans cela, n'importe quel porteur connaitrait les appareils de tous
    // et pourrait tenter d'en revoquer un.
    const where = user.role === "ADMIN" ? {} : { userId: user.id };
    return res.json(await prisma.appareil.findMany({ where, orderBy: { createdAt: "desc" } }));
  } catch (err) {
    return next(err);
  }
});

/**
 * @openapi
 * /api/v2/devices/{id}/revoke:
 *   post:
 *     summary: Revoque un appareil, sans toucher au compte de son porteur
 *     tags: [Devices v2]
 */
devicesV2Router.post("/:id/revoke", requireAuth, requireModuleAccess("inspections"), async (req, res, next) => {
  try {
    const user = req.user!;
    const appareil = await prisma.appareil.findUnique({ where: { id: req.params.id } });
    // Appareil inconnu ET appareil d'autrui (pour un non-ADMIN) : MEME reponse, 404. Un 403 distinct disait a un
    // porteur quels identifiants existent chez les autres comptes (D9, point 7a). Un ADMIN, lui, voit tout.
    // Son porteur ou un ADMIN : un agent doit pouvoir couper son propre telephone perdu sans attendre que
    // quelqu'un soit joignable.
    if (!appareil || (appareil.userId !== user.id && user.role !== "ADMIN")) {
      return res.status(404).json({ message: "Appareil introuvable" });
    }
    if (appareil.revoqueA) {
      return res.status(409).json({ message: "Appareil déjà révoqué", code: "APPAREIL_DEJA_REVOQUE", revoqueA: appareil.revoqueA });
    }

    const revoque = await prisma.$transaction(async (tx) => {
      // LE VERROU DU PROPRIETAIRE D'ABORD (D9, point 1) : la revocation se serialise avec toute rotation de
      // rafraichissement en vol de ce compte (voir `modules/auth/session-verrou.ts`). Sans lui, une rotation non
      // commitee laissait un jeton VIVANT apres cette coupure (reponse 200 `sessions: 0`). Les instructions qui
      // suivent ont un nouvel instantane : elles voient la rotation une fois commitee.
      await verrouillerPourRevocation(tx, appareil.userId);
      const maintenant = new Date();
      const maj = await tx.appareil.updateMany({
        where: { id: appareil.id, userId: appareil.userId, revoqueA: null },
        data: { revoqueA: maintenant },
      });
      if (maj.count !== 1) return null;

      /**
       * LA REVOCATION COUPE AUSSI LA SESSION DE RAFRAICHISSEMENT DU PORTEUR (D4, defaut 2).
       *
       * `Appareil` n'est lie a aucun `RefreshToken` : le schema ne dit pas depuis quel appareil une famille a ete
       * ouverte. Sans cette coupure, la revocation n'arretait que `sync/push` pour cet appareil ; le telephone
       * perdu gardait son cookie de rafraichissement et obtenait des jetons d'acces neufs pendant sept jours. Faute
       * de lien, on revoque TOUTES les familles du PROPRIETAIRE de l'appareil (pas celles de l'acteur : un ADMIN qui
       * revoque le telephone d'un agent ne se deconnecte pas lui-meme). Le prix est visible et assume : l'agent doit
       * se reconnecter sur ses autres appareils et sur la console web. La reponse le dit (`rafraichissement`).
       * Le lien exact qui permettrait une revocation ciblee est propose dans `SESSION-HORS-LIGNE-SERVEUR.md`.
       */
      const sessions = await tx.refreshToken.updateMany({
        where: { userId: appareil.userId, revokedAt: null },
        data: { revokedAt: maintenant },
      });

      const apres = await tx.appareil.findUnique({ where: { id: appareil.id } });
      if (!apres) throw new Error("Appareil absent après révocation.");
      // Un evenement de securite, pas une modification ordinaire : c'est ce qu'on relit
      // apres un incident. La révocation, la coupure des sessions et leur trace sont atomiques.
      await logAuditTransactionnelle(tx, {
        userId: user.id, action: "SECURITY_EVENT", entityType: "Appareil", entityId: appareil.id,
        before: { revoqueA: null },
        after: {
          evenement: "APPAREIL_REVOQUE", revoqueA: apres.revoqueA, porteur: appareil.userId,
          sessionsRefreshRevoquees: sessions.count, porteeSessions: PORTEE_SESSIONS_REVOQUEES,
        },
        ipAddress: req.ip,
      });
      return { apres, sessions: sessions.count };
    });
    if (!revoque) {
      return res.status(409).json({ message: "Appareil déjà révoqué ou modifié. Rechargez la liste." });
    }

    return res.json({
      ...revoque.apres,
      rafraichissement: { revoque: true, portee: PORTEE_SESSIONS_REVOQUEES, sessions: revoque.sessions },
    });
  } catch (err) {
    return next(err);
  }
});
