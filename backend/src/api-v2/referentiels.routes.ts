import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { prisma } from "../lib/prisma";

/**
 * `/api/v2/referentiels` — le vocabulaire administrable, en lecture.
 *
 * POURQUOI UNE SEULE ROUTE POUR LES TROIS
 *
 * Un ecran de terrain a besoin des trois listes d'un coup pour afficher ses menus, et un
 * telephone en bord de route paie chaque aller-retour. Trois routes separees obligeraient
 * a trois requetes pour remplir un seul formulaire.
 *
 * POURQUOI LES VALEURS INACTIVES SONT RENDUES QUAND MEME
 *
 * `actif: false` retire une valeur des NOUVEAUX choix, sans invalider les portions qui la
 * portent. Un ecran qui ne recevrait que les actives afficherait un code brut, ou rien, la
 * ou une portion ancienne porte une valeur retiree. Le drapeau est donc rendu, et c'est au
 * client de ne pas la proposer tout en sachant l'afficher.
 *
 * LES TROIS LISTES PEUVENT ETRE VIDES, ET LA PRATICABILITE L'EST
 *
 * Le cahier demande son referentiel sans enoncer une seule valeur. Tant qu'AGEROUTE ne l'a
 * pas rempli, cette route rend un tableau vide, et l'ecran doit le dire au lieu d'afficher
 * un menu sans option.
 */
export const referentielsV2Router = Router();

/**
 * @openapi
 * /api/v2/referentiels:
 *   get:
 *     summary: Vocabulaires administrables du revetement, de l'etat et de la praticabilite
 *     description: >
 *       Rend les trois listes en un appel, valeurs inactives comprises avec leur drapeau.
 *       `praticabilites` est vide tant qu'AGEROUTE n'a pas fixe ce vocabulaire, que le
 *       cahier ne definit pas.
 *     tags: [Referentiels v2]
 */
referentielsV2Router.get("/", requireAuth, requireModuleAccess("geoportail"), async (_req, res, next) => {
  try {
    const [revetements, etats, praticabilites] = await Promise.all([
      prisma.referentielRevetement.findMany({
        orderBy: { ordre: "asc" },
        select: { code: true, libelle: true, description: true, ordre: true, actif: true, bitumineux: true },
      }),
      prisma.referentielEtatChaussee.findMany({
        orderBy: { ordre: "asc" },
        select: { code: true, libelle: true, description: true, ordre: true, actif: true, critique: true },
      }),
      prisma.referentielPraticabilite.findMany({
        orderBy: { ordre: "asc" },
        select: {
          code: true, libelle: true, description: true, ordre: true, actif: true,
          franchissable: true, saisonniere: true,
        },
      }),
    ]);

    return res.json({
      revetements,
      etats,
      praticabilites,
      // Dit explicitement pourquoi une liste est vide, pour qu'un ecran n'affiche pas un
      // menu sans option sans expliquer.
      praticabiliteNonDefinie: praticabilites.length === 0,
    });
  } catch (err) {
    return next(err);
  }
});
