import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { requireModuleAccess } from "../../middleware/module-access.middleware";
import {
  chargerQualite,
  repartitionQualite,
  libelleStatut,
  estDouteuse,
  estDatee,
  CHAMPS_DECISION,
} from "../../lib/qualite";
import {
  modulesAutorisesDe,
  moduleAutorise,
  MODULE_PAR_ENTITE,
  type CompteAuthentifie,
} from "../../lib/access";

export const qualiteRouter = Router();

/**
 * Qualite des donnees : ce que l'on sait des valeurs, et ce qu'on ignore.
 *
 * CE QUE CETTE API REMPLACE
 *
 * Un tableau de qualite calcule sur COUNT(non-null) annonce « revetement : 100 %
 * renseigne » alors que le champ vaut BITUME sur les 1 690 troncons sans exception,
 * et « etat : 100 % renseigne » alors que 1 043 valent NON_EVALUE. Ces reponses sont
 * exactes et sans interet.
 *
 * Les endpoints ci-dessous repondent a la question utile : combien de valeurs sont
 * reellement fiables, et depuis quand.
 */

/**
 * Repartition des statuts par champ.
 *
 * Le controle d'acces passe par « dashboard » : c'est une vue d'ensemble, du meme
 * ordre que les indicateurs de la page d'accueil, et elle n'expose aucune valeur
 * metier — seulement des comptages de statuts.
 */
qualiteRouter.get(
  "/repartition",
  requireAuth,
  requireModuleAccess("dashboard"),
  async (req, res, next) => {
    try {
      const entityType = typeof req.query.entityType === "string" ? req.query.entityType : "Troncon";

      // Se fermer sur une entite inconnue plutot que de rendre un tableau vide qui
      // laisserait croire qu'il n'y a rien a signaler.
      if (!(entityType in MODULE_PAR_ENTITE)) {
        return res.status(400).json({ message: "Type d'entité inconnu" });
      }

      const repartition = await repartitionQualite(entityType);
      const total = repartition.reduce((s, r) => s + r.total, 0);
      const datees = repartition.reduce((s, r) => s + r.datees, 0);

      res.json({
        entityType,
        champs: repartition,
        // Rendu explicitement : c'est la dimension la plus degradee de la base, et
        // une moyenne des autres statuts la masquerait.
        fraicheur: {
          datees,
          total,
          pct: total > 0 ? Math.round((datees / total) * 10000) / 100 : 0,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Qualite des champs d'un enregistrement precis.
 *
 * Le droit applique est celui du module de l'entite, repris de MODULE_PAR_ENTITE pour
 * qu'il ne puisse pas diverger de celui des routes metier — c'est la lecon des trois
 * failles de controle d'acces corrigees en phase 3, ou deux implementations du meme
 * droit avaient diverge.
 */
qualiteRouter.get("/:entityType/:entityId", requireAuth, async (req, res, next) => {
  try {
    const { entityType, entityId } = req.params;

    if (!(entityType in MODULE_PAR_ENTITE)) {
      return res.status(400).json({ message: "Type d'entité inconnu" });
    }
    const cle = MODULE_PAR_ENTITE[entityType];

    // null signifie « reserve a ADMIN » (User, AppSetting).
    const user = req.user as CompteAuthentifie | undefined;
    if (!user) return res.status(401).json({ message: "Non authentifié" });

    if (cle === null) {
      if (user.role !== "ADMIN") return res.status(403).json({ message: "Accès refusé" });
    } else {
      const modules = await modulesAutorisesDe(user);
      if (!moduleAutorise(modules, cle)) return res.status(403).json({ message: "Accès refusé" });
    }

    const parCle = await chargerQualite(entityType, [entityId]);

    // Les six champs sont toujours rendus, meme sans ligne de qualite : une absence
    // doit se voir, pas disparaitre du tableau.
    const champs = CHAMPS_DECISION.map((champ) => {
      const q = parCle.get(`${entityId}:${champ}`) ?? null;
      return {
        champ,
        statut: q?.statut ?? null,
        libelle: libelleStatut(q),
        source: q?.source ?? null,
        methode: q?.methode ?? null,
        observedAt: q?.observedAt ?? null,
        confiance: q?.confiance ?? null,
        note: q?.note ?? null,
        douteuse: estDouteuse(q),
        datee: estDatee(q),
      };
    });

    res.json({ entityType, entityId, champs });
  } catch (err) {
    next(err);
  }
});
