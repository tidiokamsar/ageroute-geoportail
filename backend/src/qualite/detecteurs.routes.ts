import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { perimetreDe } from "../territoire/territoire.service";
import { verifierTerritoire } from "../territoire/territoire.noyau";
import { CATALOGUE_CODES, SEUILS_PROVISOIRES, type FamilleDetecteur, type NomSeuil } from "./detecteurs.noyau";
import { lancerEnLectureSeule, PLAFOND_ENTITES_PAR_CODE, TOUTES_FAMILLES } from "./detecteurs.service";

/**
 * `GET /api/v2/qualite/detecteurs` : detecteurs de qualite par code stable, en LECTURE SEULE.
 *
 * Meme garde que `/api/v2/qualite/anomalies` (ADMIN ou GESTIONNAIRE, module `dashboard`), meme
 * politique de portee : une region est demandee, la portee nationale exige `national=true` ET le role
 * ADMIN, parce qu'un balayage complet est couteux. En plus, un compte a perimetre regional ne peut
 * interroger qu'une region de son perimetre.
 *
 * Elle n'ecrit rien : le service s'execute dans une transaction PostgreSQL READ ONLY. Les seuils sont
 * PROVISOIRES et modifiables par la requete (un parametre par seuil) ; la reponse rend ceux qui ont
 * ete appliques.
 */
export const detecteursQualiteRouter = Router();

const FAMILLES = new Set<FamilleDetecteur>(TOUTES_FAMILLES);

const seuilsSchema = Object.fromEntries(
  (Object.keys(SEUILS_PROVISOIRES) as NomSeuil[]).map((nom) => [nom, z.coerce.number().min(0).finite().optional()]),
) as Record<NomSeuil, z.ZodOptional<z.ZodNumber>>;

const requete = z.object({
  regionId: z.coerce.number().int().positive().optional(),
  national: z.enum(["true", "false"]).optional(),
  /** Liste de familles separees par des virgules. Absent : toutes. */
  familles: z.string().optional(),
  plafond: z.coerce.number().int().min(0).max(5000).default(PLAFOND_ENTITES_PAR_CODE),
  reseau: z.enum(["reference", "voirie", "tout"]).default("tout"),
  ...seuilsSchema,
});

/**
 * @openapi
 * /api/v2/qualite/detecteurs:
 *   get:
 *     summary: Detecteurs de qualite des troncons, par code stable (lecture seule)
 *     description: >
 *       Rend, par code (PK_SENTINELLE_ZERO, LONGUEUR_ECART_GEOMETRIE, GEOM_INVALIDE, REGION_DISCORDANTE,
 *       DOUBLON_GEOMETRIE_STRICT, ETAT_NON_EVALUE, etc.), le nombre exact d'entites en cause, la liste
 *       plafonnee de ces entites avec les valeurs mesurees et le seuil provisoire applique, et des
 *       compteurs par region. N'ecrit rien. `regionId` est attendu ; la portee nationale exige
 *       `national=true` et le role ADMIN.
 *     tags: [Qualite v2]
 */
detecteursQualiteRouter.get(
  "/",
  requireAuth,
  requireModuleAccess("dashboard"),
  requireRole("ADMIN", "GESTIONNAIRE"),
  async (req, res, next) => {
    try {
      const q = requete.parse(req.query);
      const national = q.national === "true";

      if (!national && q.regionId === undefined) {
        return res.status(400).json({
          motif: "PORTEE_REQUISE",
          message: "Precisez regionId, ou national=true. Un balayage national lit tous les troncons actifs : il doit etre voulu.",
        });
      }
      if (national && req.user?.role !== "ADMIN") {
        return res.status(403).json({
          motif: "NATIONAL_RESERVE_ADMIN",
          message: "Le balayage national est reserve aux administrateurs, pour son cout.",
        });
      }
      if (!national && q.regionId !== undefined && req.user) {
        const verdict = verifierTerritoire(await perimetreDe(req.user), [q.regionId], "lecture");
        if (!verdict.ok) return res.status(403).json({ motif: verdict.code, message: verdict.motif });
      }

      let familles: FamilleDetecteur[] | undefined;
      if (q.familles !== undefined) {
        const demandees = q.familles.split(",").map((s) => s.trim()).filter(Boolean);
        const inconnues = demandees.filter((f) => !FAMILLES.has(f as FamilleDetecteur));
        if (inconnues.length > 0 || demandees.length === 0) {
          return res.status(400).json({
            motif: "FAMILLE_INCONNUE",
            message: `Familles connues : ${TOUTES_FAMILLES.join(", ")}. Recu : ${q.familles}.`,
          });
        }
        familles = demandees as FamilleDetecteur[];
      }

      const surcharges: Partial<Record<NomSeuil, number>> = {};
      for (const nom of Object.keys(SEUILS_PROVISOIRES) as NomSeuil[]) {
        const v = q[nom];
        if (v !== undefined) surcharges[nom] = v;
      }

      const rapport = await lancerEnLectureSeule(prisma, {
        portee: { regionId: national ? null : (q.regionId ?? null), reseau: q.reseau },
        familles,
        seuils: surcharges,
        plafondParCode: q.plafond,
      });

      return res.json({
        national,
        // Le catalogue accompagne la reponse : un code sans sa description ni sa correction proposee
        // laisserait le lecteur sans prise.
        catalogue: Object.fromEntries(
          Object.entries(CATALOGUE_CODES).map(([code, d]) => [code, { famille: d.famille, gravite: d.gravite, description: d.description, correctionProposee: d.correctionProposee }]),
        ),
        ...rapport,
      });
    } catch (err) {
      return next(err);
    }
  },
);
