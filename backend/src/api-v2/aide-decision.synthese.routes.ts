import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { prisma } from "../lib/prisma";
import { moduleAutorise, modulesAutorisesDe } from "../lib/access";
import { droitMontantsContractuels } from "../modules/chantiers/chantiers.confidentialite";
import { perimetreDe } from "../territoire/territoire.service";
import { composerSynthese, depotPrisma } from "../aide-decision/synthese";
import { reponseDictionnaire } from "../aide-decision/dictionnaire";
import { composerQualite } from "../aide-decision/qualite";
import { lireFiltres, filtresNonAppliques, type FiltresSynthese } from "../aide-decision/synthese.filtres";

/**
 * `/api/v2/aide-decision` (lot 2) : synthese des indicateurs, dictionnaire, qualite des donnees. Remplace la chaine
 * heritee `GET /api/dashboard/decision`. Montage dans `api-v2/index.ts` par l'orchestrateur.
 *
 *   GET /synthese     indicateurs (contrat AD paragraphe 5), repartition de l'etat, budget, qualite, fraicheur
 *   GET /dictionnaire definitions, formules, sources, limites, statut de chaque indicateur
 *   GET /qualite      anomalies du perimetre (detecteurs en lecture seule), couverture et non evalues par region
 *
 * ACCES, COTE SERVEUR : `requireAuth`, module `decision`, puis le perimetre territorial du COMPTE.
 *  - la portee vient du compte, jamais de la requete : un compte regional ne recoit que sa region, jamais un total
 *    national ; le filtre `regionId` ne peut que reduire cette portee ;
 *  - une region hors perimetre ou inexistante repond le MEME 404 (on n'apprend rien de l'existence d'une region) ;
 *  - les montants exigent en plus le module `marches` (contractuel, decaisse, bailleurs) ou `programmation`
 *    (previsionnel) : sans lui, l'etat est `NON_AUTORISE`, jamais un zero ni un montant ;
 *  - les erreurs sont `{ error, code }` ; une entree hostile rend 400, jamais 500.
 *
 * Lecture seule : rien n'est ecrit, donc rien n'est audite. Reponses `Cache-Control: no-store` (donnees
 * territoriales et financieres).
 */
export const aideDecisionSyntheseRouter = Router();

const garde = [requireAuth, requireModuleAccess("decision")];

const NON_TROUVEE = { error: "Région introuvable", code: "INTROUVABLE" } as const;

function refuserFiltres(res: Response, details: { champ: string; message: string }[]): void {
  res.status(400).json({ error: "Filtres invalides", code: "FILTRE_INVALIDE", details });
}

function erreurInterne(res: Response, err: unknown): void {
  console.error("[aide-decision] erreur :", err instanceof Error ? err.message : err);
  if (!res.headersSent) res.status(500).json({ error: "Erreur interne du serveur", code: "ERREUR_INTERNE" });
}

/**
 * Regions en portee : celles du compte, reduites au filtre `regionId`. `undefined` = region hors perimetre ou inexistante
 * (le 404 est rendu par l'appelant). `null` = pays entier.
 */
async function porteeDe(req: Request, regionId: number | undefined): Promise<readonly number[] | null | undefined> {
  const perimetre = await perimetreDe(req.user!);
  if (perimetre.national) {
    if (regionId === undefined) return null;
    const existe = await prisma.region.findUnique({ where: { id: regionId }, select: { id: true } });
    return existe ? [regionId] : undefined;
  }
  const regions = [...perimetre.regions].sort((a, b) => a - b);
  if (regionId === undefined) return regions;
  return regions.includes(regionId) ? [regionId] : undefined;
}

aideDecisionSyntheseRouter.get("/synthese", ...garde, async (req, res) => {
  const lecture = lireFiltres(req.query);
  if (!lecture.ok) return refuserFiltres(res, lecture.details);
  try {
    const filtres: FiltresSynthese = lecture.filtres;
    const regions = await porteeDe(req, filtres.regionId);
    if (regions === undefined) { res.status(404).json(NON_TROUVEE); return; }
    const modules = await modulesAutorisesDe(req.user!);
    const synthese = await composerSynthese(depotPrisma(prisma), {
      regions, maintenant: new Date(), filtres,
      // `marches` = le droit sur les montants contractuels (contractuel, decaisse) : regle unique PROVISOIRE, voir chantiers.confidentialite.ts.
      droits: { marches: droitMontantsContractuels(modules), programmation: moduleAutorise(modules, "programmation") },
    });
    res.set("Cache-Control", "no-store").json(synthese);
  } catch (err) { erreurInterne(res, err); }
});

aideDecisionSyntheseRouter.get("/dictionnaire", ...garde, (_req, res) => {
  // Aucune entree : les parametres de requete eventuels sont ignores. Le contenu est celui du code, identique pour tous.
  res.set("Cache-Control", "no-store").json(reponseDictionnaire(new Date()));
});

aideDecisionSyntheseRouter.get("/qualite", ...garde, async (req, res) => {
  const lecture = lireFiltres(req.query);
  if (!lecture.ok) return refuserFiltres(res, lecture.details);
  try {
    const filtres = lecture.filtres;
    const regions = await porteeDe(req, filtres.regionId);
    if (regions === undefined) { res.status(404).json(NON_TROUVEE); return; }
    const reponse = await composerQualite(depotPrisma(prisma), {
      regions, maintenant: new Date(), regionDemandee: filtres.regionId ?? null,
      filtresNonAppliques: [
        ...(filtres.classe ? [{ nom: "classe", raison: "Non appliqué : les détecteurs et la couverture portent sur tout le réseau classé saisi, sans distinction de classe." }] : []),
        ...filtresNonAppliques({ ...filtres, classe: undefined }),
      ],
    });
    res.set("Cache-Control", "no-store").json(reponse);
  } catch (err) { erreurInterne(res, err); }
});
