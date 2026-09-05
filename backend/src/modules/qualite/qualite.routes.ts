import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { requireModuleAccess } from "../../middleware/module-access.middleware";
import { prisma } from "../../lib/prisma";
import { REGION_NON_RENSEIGNEE } from "../../lib/localisation";
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
      //
      // `hasOwnProperty` et non `in` : ce dernier traverse la chaine de prototypes,
      // donc « constructor », « toString » et « __proto__ » franchissaient la garde.
      // Le meme defaut existait dans le journal d'audit ; il avait ete corrige la et
      // manque ici — preuve qu'une correction ponctuelle ne suffit pas quand le motif
      // est duplique.
      if (!Object.prototype.hasOwnProperty.call(MODULE_PAR_ENTITE, entityType)) {
        return res.status(400).json({ message: "Type d'entité inconnu" });
      }

      const repartition = await repartitionQualite(entityType);
      const total = repartition.reduce((s, r) => s + r.total, 0);
      const datees = repartition.reduce((s, r) => s + r.datees, 0);

      return res.json({
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
      return next(err);
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

    return res.json({ entityType, entityId, champs });
  } catch (err) {
    return next(err);
  }
});

/**
 * Ecart entre le referentiel des regions et les limites administratives chargees.
 *
 * POURQUOI CET ENDPOINT
 *
 * Le decret du 05/09/2026 cree les regions de Siguiri et de Beyla, et promeut onze
 * sous-prefectures en prefectures. Le referentiel `regions` les porte deja ; les
 * limites, non. Rien a l'ecran ne le disait.
 *
 * Une region sans limite n'est pas un incident : la carte cesse simplement d'y poser
 * des epingles et la liste « sans localisation » recueille ses chantiers — c'est le
 * comportement voulu. Mais c'est une DETTE, et une dette qu'on ne voit pas est une
 * dette qu'on oublie. Elle se solde en chargeant les limites officielles, pas en
 * dessinant des frontieres au jugé.
 *
 * CE QUE CET ENDPOINT NE FAIT PAS
 *
 * Il ne propose aucune geometrie de remplacement. Les sous-prefectures promues ne
 * couvrent pas leur prefecture d'origine — Doko, Kintinian et Siguirini sont 3 des 12
 * sous-prefectures de Siguiri — de sorte qu'aucune limite nouvelle ne se deduit des
 * anciennes. Il faut le decret.
 */
qualiteRouter.get(
  "/referentiel-administratif",
  requireAuth,
  requireModuleAccess("dashboard"),
  async (_req, res, next) => {
    try {
      const [regions, niveaux] = await Promise.all([
        prisma.$queryRaw<{ nom: string; aUneLimite: boolean; objets: bigint }[]>`
          SELECT r.nom,
                 EXISTS (
                   SELECT 1 FROM limites_admin la
                    WHERE la.niveau = 1
                      AND unaccent(lower(la.nom)) = unaccent(lower(r.nom))
                 ) AS "aUneLimite",
                 (SELECT count(*) FROM chantiers c
                   WHERE c."regionId" = r.id AND c."deletedAt" IS NULL)
                 + (SELECT count(*) FROM ouvrages o
                     WHERE o."regionId" = r.id AND o."deletedAt" IS NULL) AS objets
            FROM regions r
           WHERE r.nom <> ${REGION_NON_RENSEIGNEE}
           ORDER BY r.nom
        `,
        prisma.$queryRaw<{ niveau: number; entites: bigint }[]>`
          SELECT niveau, count(*) AS entites FROM limites_admin GROUP BY niveau ORDER BY niveau
        `,
      ]);

      const sansLimite = regions.filter((r) => !r.aUneLimite);

      return res.json({
        regions: regions.map((r) => ({
          nom: r.nom,
          aUneLimite: r.aUneLimite,
          // Le nombre d'objets dit l'URGENCE : une region sans limite mais vide
          // n'empeche rien ; la meme avec des chantiers les retire de la carte.
          objetsRattaches: Number(r.objets),
        })),
        limites: niveaux.map((n) => ({ niveau: n.niveau, entites: Number(n.entites) })),
        ecart: {
          regionsSansLimite: sansLimite.map((r) => r.nom),
          objetsConcernes: sansLimite.reduce((s, r) => s + Number(r.objets), 0),
          // Ce qu'il faut pour solder, en clair, plutot qu'un simple compteur rouge.
          resolution:
            sansLimite.length === 0
              ? null
              : "Charger les limites officielles de ces régions (décret ou mise à jour COD-AB). "
                + "Elles ne se déduisent pas des limites existantes.",
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);
