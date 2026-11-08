import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { requireTerritoire, requireTerritoireMasque } from "../middleware/territoire.middleware";
import { prisma } from "../lib/prisma";
import { modulesAutorisesDe } from "../lib/access";
import { droitMontantsContractuels } from "../modules/chantiers/chantiers.confidentialite";
import { regionsCorpsSimulation, regionsScenario, regionsVisibles } from "../territoire/territoire.lecture";
import { MENTION_SIMULATION } from "../programmation/deficit.noyau";
import { jourValide } from "../programmation/comparaison.baremes.noyau";
import { CODES_LOGIQUE, LOGIQUES } from "../programmation/logiques.noyau";
import { MAX_CANDIDATS } from "../programmation/scenario.noyau";
import { BLOC_PRIORITE_AMORCAGE } from "../programmation/priorite.parametres";
import * as dep from "../programmation/comparaison.depot";
import * as service from "../programmation/comparaison.service";
import * as depot from "../programmation/moteur.depot";
import * as moteur from "../programmation/moteur.service";

/**
 * `/api/v2/aide-decision/scenarios` : SIMULATEUR BUDGETAIRE ET SCENARIOS (module d'aide a la decision, lot 4). Le routeur est
 * MONTE PAR L'ORCHESTRATEUR (`api-v2/index.ts`, prefixe `/aide-decision`) ; chaque chemin ci-dessous est relatif a ce prefixe.
 *
 *   GET  /scenarios/options            logiques, baremes applicables a la periode (statut, validite), versions de parametres
 *   GET  /scenarios/candidats          interventions candidates du perimetre (regionId, classe) pour les selectionner
 *   POST /scenarios/simuler            calcule SANS enregistrer (ADMIN, GESTIONNAIRE) ; aucune ecriture
 *   POST /scenarios                    calcule ET enregistre sous un nom (ADMIN, GESTIONNAIRE) ; audite, immuable
 *   GET  /scenarios                    scenarios enregistres (filtres : annee, q, logique) avec periode, logique, deficit
 *   POST /scenarios/comparer           2 a 5 scenarios cote a cote ; refuse des periodes ou devises differentes ; aucune ecriture
 *   GET  /scenarios/:id                le scenario complet, ses options et ses empreintes
 *   POST /scenarios/:id/rejouer        recalcule depuis les seules entrees stockees et compare octet pour octet
 *   POST /scenarios/:id/supprimer      suppression LOGIQUE (ADMIN, GESTIONNAIRE) ; refusee si une fiche figee le cite
 *   GET  /scenarios/:id/export         ?format=csv|json ; module `rapports` ET role ADMIN ou GESTIONNAIRE ; journalise ; sans le droit
 *                                      sur les montants (droitMontantsContractuels) aucun montant ne sort ; Cache-Control: no-store
 *
 * CE ROUTEUR NE MODIFIE AUCUNE DONNEE OFFICIELLE (AD-08) : la seule table ecrite est `scenarios_programmation` (et l'audit).
 * Aucun budget, marche, decompte, chantier ni bareme n'est touche. « SIMULATION NON ENGAGEANTE » est rappele par chaque resultat.
 *
 * ORDRE DES GARDES (le meme partout, il ferme l'oracle d'existence) : authentification -> modules `decision` ET `programmation`
 * -> role -> RESSOURCE DESIGNEE (404 identique si inexistante, supprimee, hors perimetre ou d'identifiant mal forme) ->
 * validation des entrees (400) -> service.
 *
 * TERRITOIRE. Un compte regional ne calcule que sur UNE region de son perimetre (un calcul national lui est refuse : 403), ne
 * liste que les scenarios de son perimetre et ne compare ni n'exporte que ceux-la. L'auteur vient de la SESSION, jamais du corps.
 * Toute entree hostile (corps hors schema, parametre inconnu, montant negatif ou decimal, date impossible) repond 400.
 */
export const scenariosAideDecisionRouter = Router();

scenariosAideDecisionRouter.use("/scenarios", (_req, res, next) => {
  // Donnees privees derriere un jeton : jamais conservees par un cache partage.
  res.setHeader("Cache-Control", "private, no-cache");
  res.setHeader("Vary", "Authorization");
  next();
});
scenariosAideDecisionRouter.use("/scenarios", requireAuth, requireModuleAccess("decision"), requireModuleAccess("programmation"));

const ecriture = requireRole("ADMIN", "GESTIONNAIRE");
const exportAutorise = [requireModuleAccess("rapports"), requireRole("ADMIN", "GESTIONNAIRE")];

const INTROUVABLE = { error: "scénario introuvable ou supprimé", code: "INTROUVABLE" } as const;
const ID_SCENARIO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Identifiant mal forme : meme 404 qu'un identifiant inconnu, sans toucher la base. */
function idBienForme(req: Request, res: Response, next: NextFunction) {
  if (!ID_SCENARIO.test(req.params.id)) { res.status(404).json(INTROUVABLE); return; }
  next();
}
const scenarioVisible = requireTerritoireMasque((req) => regionsScenario(req.params.id), { corps: INTROUVABLE });
const calculDansPerimetre = requireTerritoire((req) => regionsCorpsSimulation(req.body));
const lectureDansPerimetre = requireTerritoire(async (req) => {
  const r = req.query.regionId === undefined ? null : Number(req.query.regionId);
  return [Number.isInteger(r) && (r as number) > 0 ? r : null];
}, { nature: "lecture" });

const montant = z.string().regex(/^\d{1,18}$/, "chiffres attendus, en chaîne (GNF entiers, non négatifs, 18 chiffres au plus)");
const identifiant = z.string().min(1).max(64);
const jour = z.string().refine(jourValide, "date AAAA-MM-JJ valide attendue");

const corpsSimulation = z.object({
  annee: z.number().int().min(2000).max(2100),
  budgetGnf: montant,
  periode: z.object({ debut: jour, fin: jour }).strict().refine((p) => p.debut <= p.fin, "la fin précède le début"),
  regionId: z.number().int().positive().nullish(),
  classe: z.enum(["RN", "RR", "RU", "PISTE", "NON_CLASSEE"]).nullish(),
  selection: z.array(identifiant).min(1).max(MAX_CANDIDATS).optional(),
  plafondsRegionauxGnf: z.record(z.string().regex(/^\d{1,6}$/), montant).optional(),
  parametresId: identifiant.nullish(),
  logique: z.enum(CODES_LOGIQUE),
  ordrePersonnalise: z.array(identifiant).max(MAX_CANDIDATS).optional(),
  equilibre: z.object({ partMinimaleParRegionPct: z.number().int().min(1).max(100) }).strict().nullish(),
  obligatoires: z.array(identifiant).max(500).optional(),
  groupesNonDivisibles: z.array(z.array(identifiant).min(2).max(50)).max(50).optional(),
  baremeIds: z.array(z.number().int().positive()).max(200).optional(),
}).strict();

const corpsEnregistrement = corpsSimulation.extend({ intitule: z.string().trim().min(3).max(300) });
const corpsComparaison = z.object({ ids: z.array(identifiant).min(2).max(5) }).strict();

const requeteListe = z.object({
  annee: z.coerce.number().int().min(2000).max(2100).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  logique: z.enum(CODES_LOGIQUE).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

const requeteOptions = z.object({ debut: jour.optional(), fin: jour.optional() }).strict();
const requeteCandidats = z.object({ regionId: z.coerce.number().int().positive().optional(), classe: z.enum(["RN", "RR", "RU", "PISTE", "NON_CLASSEE"]).optional() }).strict();
const requeteExport = z.object({ format: z.enum(["csv", "json"]) }).strict();

function contexte(req: Request): moteur.Contexte {
  return { userId: req.user!.id, email: req.user!.email ?? null, ipAddress: req.ip, role: req.user!.role };
}

function refus(err: unknown, res: Response, next: NextFunction) {
  if (err instanceof moteur.RefusMoteur) { res.status(err.http).json({ error: err.message, code: err.code }); return; }
  next(err);
}

function invalide(res: Response, details: unknown) {
  res.status(400).json({ error: "requête invalide", details });
}

function demande(d: z.infer<typeof corpsSimulation>): service.DemandeSimulateur {
  return {
    annee: d.annee, budgetGnf: BigInt(d.budgetGnf), periode: d.periode, regionId: d.regionId ?? null, classe: d.classe ?? null, selection: d.selection ?? null,
    plafondsRegionauxGnf: Object.fromEntries(Object.entries(d.plafondsRegionauxGnf ?? {}).map(([k, v]) => [k, BigInt(v)])),
    parametresId: d.parametresId ?? null, logique: d.logique, ordrePersonnalise: d.ordrePersonnalise ?? [], equilibre: d.equilibre ?? null,
    obligatoires: d.obligatoires ?? [], groupesNonDivisibles: d.groupesNonDivisibles ?? [], baremeIds: d.baremeIds ?? null,
  };
}

// ----- options et candidats -----

scenariosAideDecisionRouter.get("/scenarios/options", async (req, res, next) => {
  const q = requeteOptions.safeParse(req.query);
  if (!q.success) { invalide(res, q.error.flatten().fieldErrors); return; }
  if ((q.data.debut === undefined) !== (q.data.fin === undefined)) { invalide(res, { periode: ["debut et fin vont ensemble"] }); return; }
  if (q.data.debut && q.data.fin && q.data.debut > q.data.fin) { invalide(res, { periode: ["la fin précède le début"] }); return; }
  try {
    const parametres = await moteur.listerParametres(prisma);
    const baremes = q.data.debut && q.data.fin ? await service.baremesPourPeriode(prisma, { debut: q.data.debut, fin: q.data.fin }) : null;
    res.json({
      mention: MENTION_SIMULATION, devise: "GNF", maxCandidats: MAX_CANDIDATS,
      logiques: LOGIQUES,
      parametres: parametres.map((p) => ({ id: p.id, version: p.version, provisoire: p.provisoire, etiquette: p.etiquette, approuveeLe: p.approuveeLe })),
      baremes,
      contraintes: {
        obligatoires: "interventions financées en premier ; une obligatoire qui ne tient pas est rendue en contrainte insatisfaisable, jamais forcée",
        groupesNonDivisibles: "tronçons financés ensemble ou pas du tout (convention provisoire)",
        plafondsRegionaux: "plafond de dépense par région, en GNF",
        reglesFinancement: "non modélisées : aucune règle de financement n'existe dans le modèle de données",
      },
    });
  } catch (err) { next(err); }
});

scenariosAideDecisionRouter.get("/scenarios/candidats", lectureDansPerimetre, async (req, res, next) => {
  const q = requeteCandidats.safeParse(req.query);
  if (!q.success) { invalide(res, q.error.flatten().fieldErrors); return; }
  try {
    // Les points noirs ne sont pas affiches ici : le minimum du registre est celui d'amorcage (aucune version de parametres n'est choisie).
    const l = await depot.chargerCandidats(prisma, {
      regionId: q.data.regionId ?? null, classe: q.data.classe ?? null, limite: MAX_CANDIDATS + 1,
      registrePointsNoirsMinimum: BLOC_PRIORITE_AMORCAGE.registrePointsNoirsMinimum,
    });
    const tronque = l.length > MAX_CANDIDATS;
    const kilometres = (m: number | null) => (m === null ? null : `${Math.floor(m / 1000)}.${String(m % 1000).padStart(3, "0")}`);
    res.json({
      total: Math.min(l.length, MAX_CANDIDATS), tronque, maxCandidats: MAX_CANDIDATS,
      data: l.slice(0, MAX_CANDIDATS).map((c) => ({
        id: c.id, code: c.code, nom: c.nom, regionId: c.regionId, classe: c.classe, revetement: c.revetement, etat: c.etat,
        // La longueur metier et la geometrique restent separees : l'une ne remplace jamais l'autre. Une colonne `longueurKm` DERIVEE de la
        // geometrie (valeurs_qualite DERIVED) n'est pas une longueur metier saisie : comme la liste priorisee, elle est rendue avec son
        // drapeau (`longueurMetierDerivee`) et la route dit « derivee » au lieu de la presenter comme saisie.
        longueurMetierKm: c.longueurOrigine === "LONGUEUR_KM" ? kilometres(c.longueurM) : null,
        longueurMetierDerivee: c.longueurOrigine === "LONGUEUR_KM" ? (c.longueurMetierDerivee ?? null) : null,
        longueurGeometriqueKm: c.longueurOrigine === "GEOMETRIE" ? kilometres(c.longueurM) : null,
        longueurOrigine: c.longueurOrigine ?? null,
      })),
    });
  } catch (err) { next(err); }
});

// ----- simuler et enregistrer -----

scenariosAideDecisionRouter.post("/scenarios/simuler", ecriture, calculDansPerimetre, async (req, res, next) => {
  const p = corpsSimulation.safeParse(req.body);
  if (!p.success) { invalide(res, p.error.flatten().fieldErrors); return; }
  try { res.json(await service.simulerSansEnregistrer(prisma, demande(p.data))); } catch (err) { refus(err, res, next); }
});

scenariosAideDecisionRouter.post("/scenarios", ecriture, calculDansPerimetre, async (req, res, next) => {
  const p = corpsEnregistrement.safeParse(req.body);
  if (!p.success) { invalide(res, p.error.flatten().fieldErrors); return; }
  try {
    const r = await service.enregistrer(prisma, { ...demande(p.data), intitule: p.data.intitule }, contexte(req));
    res.status(201).json({ scenario: moteur.resumeScenarioApi(r.scenario), resultat: r.resultat });
  } catch (err) { refus(err, res, next); }
});

// ----- liste, comparaison -----

scenariosAideDecisionRouter.get("/scenarios", async (req, res, next) => {
  const q = requeteListe.safeParse(req.query);
  if (!q.success) { invalide(res, q.error.flatten().fieldErrors); return; }
  try {
    const page = q.data.page ?? 1;
    const pageSize = q.data.pageSize ?? 20;
    const r = await dep.listerResumes(prisma, {
      annee: q.data.annee ?? null, q: q.data.q ?? null, logique: q.data.logique ?? null, limite: pageSize, decalage: (page - 1) * pageSize,
      regions: await regionsVisibles(req.user!),
    });
    res.json({ data: r.lignes.map(service.resumeSimulateurApi), total: r.total, page, pageSize });
  } catch (err) { next(err); }
});

scenariosAideDecisionRouter.post("/scenarios/comparer", async (req, res, next) => {
  const p = corpsComparaison.safeParse(req.body);
  if (!p.success) { invalide(res, p.error.flatten().fieldErrors); return; }
  try {
    // Un identifiant mal forme, inconnu, supprime ou hors perimetre : la meme reponse (aucun oracle d'existence).
    if (!p.data.ids.every((id) => ID_SCENARIO.test(id))) { res.status(404).json(INTROUVABLE); return; }
    res.json(await service.comparer(prisma, p.data.ids, await regionsVisibles(req.user!)));
  } catch (err) { refus(err, res, next); }
});

// ----- un scenario -----

scenariosAideDecisionRouter.get("/scenarios/:id", idBienForme, scenarioVisible, async (req, res, next) => {
  try { res.json(await service.lireDetail(prisma, req.params.id)); } catch (err) { refus(err, res, next); }
});

scenariosAideDecisionRouter.post("/scenarios/:id/rejouer", idBienForme, scenarioVisible, async (req, res, next) => {
  try { res.json(await moteur.rejouer(prisma, req.params.id)); } catch (err) { refus(err, res, next); }
});

scenariosAideDecisionRouter.post("/scenarios/:id/supprimer", ecriture, idBienForme, scenarioVisible, async (req, res, next) => {
  try { res.json(await moteur.supprimerScenario(prisma, req.params.id, contexte(req))); } catch (err) { refus(err, res, next); }
});

scenariosAideDecisionRouter.get("/scenarios/:id/export", ...exportAutorise, idBienForme, scenarioVisible, async (req, res, next) => {
  const q = requeteExport.safeParse(req.query);
  if (!q.success) { invalide(res, q.error.flatten().fieldErrors); return; }
  try {
    const territoire = await regionsVisibles(req.user!);
    // Meme regle de retrait que POST /exports : sans le droit sur les montants, aucun montant ne sort (lu en base a chaque appel).
    const droitFinancier = droitMontantsContractuels(await modulesAutorisesDe(req.user!));
    const e = await service.exporter(prisma, req.params.id, q.data.format, contexte(req), territoire, new Date(), droitFinancier);
    // Un export est un telechargement individuel : jamais conserve par un cache (remplace le `private, no-cache` du routeur).
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", e.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${e.nom}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(e.corps);
  } catch (err) { refus(err, res, next); }
});
