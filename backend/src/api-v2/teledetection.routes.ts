import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import type { Role } from "@prisma/client";
import { requireAuth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { prisma } from "../lib/prisma";
import { perimetreDe } from "../territoire/territoire.service";
import type { Perimetre } from "../territoire/territoire.noyau";
import {
  calculerSynthese, changerStatut, coherence, enregistrerProduit, precision, qualiteMethodes,
} from "../teledetection/teledetection.service";
import {
  DEFINITION_TAUX_CONFIRMATION, SEUIL_ECHANTILLON_TAUX, verifierPerimetreProposition, type PerimetreEo,
} from "../teledetection/teledetection.noyau";
import {
  REGEX_CODE_SOURCE, estUuid, lireFiltresGeo, lireFiltresProduits, lireFiltresPropositions, lireFiltresSynthese, verifierDemandeSynchro,
} from "../teledetection/api.noyau";
import {
  chargerVisible, detailProposition, geoPropositions, listerProduits, listerPropositions, listerSources, type Portee, type PropositionVisible,
} from "../teledetection/api.lecture";
import { INTROUVABLE, reponseErreur } from "../teledetection/api.erreurs";
import { ajouterPreuvesApi, demanderVerification, deposerLot } from "../teledetection/api.service";
import { adaptateurDeCodeBase, apercuProduit, synchroniserCatalogue, verifierSource } from "../teledetection/sources.service";
import {
  corpsDepotProduit, corpsDepotPropositions, corpsPreuves, corpsSynchro, corpsTransition, corpsVerification, corpsVide, messageZod,
} from "./teledetection.schemas";
import type { z } from "zod";

/**
 * `/api/v2/teledetection` -- l'observation de la Terre (Lot 1 EO ; contrat : docs/observation-terre/CONTRAT-API-UI.md ; reference :
 * docs/observation-terre/API.md).
 *
 * ORDRE DES GARDES (le meme partout, il ferme l'oracle d'existence) :
 *   authentification -> module `teledetection` -> role -> RESSOURCE DESIGNEE (404 identique si inexistante ou hors perimetre) ->
 *   validation du corps (400) -> service (409, ...).
 * Une ressource hors perimetre et une ressource inexistante repondent la MEME chose, y compris avec un corps invalide : la validation
 * du corps ne vient qu'apres le controle d'existence et de perimetre.
 *
 * LECTURE : tout compte authentifie avec le module. Un compte regional ne voit que les propositions de ses regions ; les propositions non
 * rattachees ne sont visibles que d'un compte national. Les donnees synthetiques ne figurent dans aucune liste. Les agregats par methode
 * (`/precision`, `/qualite-methodes`) sont NATIONAUX : refuses a un compte regional (le taux regional vient de `/synthese`). Les preuves de
 * terrain (observations d'autres agents) suivent le meme perimetre, a la citation ET a la lecture du detail.
 * ECRITURE : ADMIN et GESTIONNAIRE (decision, mission, depot, synchronisation) ; ADMIN seul pour tester une source ; INSPECTEUR :
 * preuves de terrain sur une proposition liee a une mission qui lui est affectee. Le depot d'un lot (produits, propositions) et la
 * synchronisation du catalogue sont des operations NATIONALES : refusees a un compte a perimetre regional.
 * Aucune route ne telecharge de scene, ne traite d'image, ni ne modifie le referentiel (`troncons`, `portions`, `ouvrages`).
 * Les lectures ne sont pas auditees ; toutes les ecritures le sont, dans la transaction qui les porte.
 */
export const teledetectionV2Router = Router();

type Garde = (req: Request, res: Response, next: NextFunction) => unknown;

/**
 * Pose le `code` du contrat sur le refus d'une garde existante (authentification, module, role), qui repond `{ error }` seul.
 * La garde reste la VRAIE garde ; seul le corps du refus est complete, puis la reponse est rendue a l'etat normal.
 */
function avecCode(garde: Garde, code: string): RequestHandler {
  const enveloppe: RequestHandler = (req, res, next) => {
    const json = res.json.bind(res);
    res.json = (corps?: unknown) => {
      if (res.statusCode >= 400 && corps && typeof corps === "object" && !("code" in corps)) return json({ ...corps, code });
      return json(corps);
    };
    return garde(req, res, (e?: unknown) => { res.json = json; next(e); }) as void;
  };
  // L'enveloppe doit rester LISIBLE de l'inventaire des gardes (`securite/inventaire-acces.test.ts`), qui reconnait une garde a son
  // nom (`requireAuth`) ou a la marque posee sur la fonction que rend `requireRole` / `requireModuleAccess`. Sans cela, une route
  // gardee par un role passerait pour une ecriture ouverte. En production la garde n'a aucune propriete propre : ceci ne change rien.
  Object.defineProperty(enveloppe, "name", { value: garde.name });
  return Object.assign(enveloppe, garde);
}

const roleAvecCode = (...roles: Role[]) => avecCode(requireRole(...roles), "ROLE_INSUFFISANT");
const decideurs = roleAvecCode("ADMIN", "GESTIONNAIRE");
const administrateur = roleAvecCode("ADMIN");
const contributeurs = roleAvecCode("ADMIN", "GESTIONNAIRE", "INSPECTEUR");

teledetectionV2Router.use((_req, res, next) => {
  // Donnees privees derriere un jeton : jamais conservees par un cache partage.
  res.setHeader("Cache-Control", "private, no-cache");
  res.setHeader("Vary", "Authorization");
  next();
});
teledetectionV2Router.use(avecCode(requireAuth, "NON_AUTHENTIFIE"));
teledetectionV2Router.use(avecCode(requireModuleAccess("teledetection"), "MODULE_NON_AUTORISE"));

// ------------------------------------------------------------ outils de route

const h = (f: (req: Request, res: Response) => Promise<void>): RequestHandler => (req, res, next) => { f(req, res).catch(next); };

const maintenant = (): Date => new Date();

async function perimetreCompte(req: Request, res: Response): Promise<Perimetre> {
  const memo = res.locals.perimetre as Perimetre | undefined;
  if (memo) return memo;
  const p = await perimetreDe(req.user!);
  res.locals.perimetre = p;
  return p;
}

const porteeDe = (p: Perimetre): Portee => ({ regions: p.national ? null : [...p.regions] });

const ctx = (req: Request) => ({ auteurId: req.user!.id, ipAddress: req.ip });

function refuser(res: Response, e: unknown, erreurBaseEstEntree = false): void {
  const r = reponseErreur(e, { erreurBaseEstEntree });
  res.status(r.http).json(r.corps);
}

function introuvable(res: Response): void { res.status(INTROUVABLE.http).json(INTROUVABLE.corps); }

function entreeInvalide(res: Response, message: string, details?: unknown): void {
  res.status(400).json({ error: message, code: "ENTREE_INVALIDE", ...(details ? { details } : {}) });
}

/** Valide un corps avec un schema strict ; rend la valeur, ou repond 400 et rend `null`. */
function lireCorps<S extends z.ZodTypeAny>(schema: S, req: Request, res: Response): z.infer<S> | null {
  const r = schema.safeParse(req.body ?? {});
  if (r.success) return r.data;
  entreeInvalide(res, messageZod(r.error), r.error.flatten().fieldErrors);
  return null;
}

/** Operation reservee aux comptes nationaux (depot de lot, synchronisation) : 403 HORS_PERIMETRE sinon. */
async function exigerNational(req: Request, res: Response, erreur = "Cette operation porte sur l'ensemble du territoire : elle est reservee a un compte sans perimetre regional."): Promise<boolean> {
  const p = await perimetreCompte(req, res);
  if (p.national) return true;
  res.status(403).json({ error: erreur, code: "HORS_PERIMETRE" });
  return false;
}

const AGREGAT_NATIONAL = "Cet indicateur agrege l'ensemble du territoire par methode : il est reserve a un compte sans perimetre regional. Le taux de confirmation de votre region est dans la synthese.";

/**
 * Charge la proposition designee par `:id` si le compte la voit. Inexistante, mal formee ou hors perimetre : le MEME 404 (identifiant
 * mal forme compris), de sorte que ni le code d'etat ni le corps ne disent si elle existe. A poser APRES le controle de role, AVANT
 * toute validation de corps.
 */
const proposition: RequestHandler = (req, res, next) => {
  (async () => {
    const id = req.params.id;
    if (!estUuid(id)) { introuvable(res); return; }
    const p = await chargerVisible(prisma, id, porteeDe(await perimetreCompte(req, res)));
    if (!p) { introuvable(res); return; }
    res.locals.proposition = p;
    next();
  })().catch(next);
};

// ============================================================ lecture

teledetectionV2Router.get("/synthese", h(async (req, res) => {
  const f = lireFiltresSynthese(req.query, maintenant());
  if (!f.ok) return entreeInvalide(res, f.message);
  const perimetre = await perimetreCompte(req, res);
  if (f.valeur.regionId !== undefined) {
    const v = verifierPerimetreProposition(perimetre as PerimetreEo, f.valeur.regionId);
    if (!v.ok) { res.status(403).json({ error: "Cette region est hors de votre perimetre.", code: "HORS_PERIMETRE" }); return; }
  }
  res.json(await calculerSynthese(prisma, { perimetre: perimetre as PerimetreEo, regionId: f.valeur.regionId, depuis: f.valeur.depuis ?? null, jusqua: f.valeur.jusqua ?? null }));
}));

teledetectionV2Router.get("/propositions.geojson", h(async (req, res) => {
  const f = lireFiltresGeo(req.query);
  if (!f.ok) return entreeInvalide(res, f.message);
  res.json(await geoPropositions(prisma, f.valeur, porteeDe(await perimetreCompte(req, res))));
}));

teledetectionV2Router.get("/propositions", h(async (req, res) => {
  const f = lireFiltresPropositions(req.query, maintenant());
  if (!f.ok) return entreeInvalide(res, f.message);
  const perimetre = await perimetreCompte(req, res);
  if (f.valeur.regionId !== undefined && !verifierPerimetreProposition(perimetre as PerimetreEo, f.valeur.regionId).ok) {
    res.status(403).json({ error: "Cette region est hors de votre perimetre.", code: "HORS_PERIMETRE" });
    return;
  }
  res.json(await listerPropositions(prisma, f.valeur, porteeDe(perimetre)));
}));

teledetectionV2Router.get("/propositions/:id", proposition, h(async (req, res) => {
  const d = await detailProposition(prisma, (res.locals.proposition as PropositionVisible).id, porteeDe(await perimetreCompte(req, res)));
  if (!d) { introuvable(res); return; }
  res.json(d);
}));

teledetectionV2Router.get("/produits", h(async (req, res) => {
  const f = lireFiltresProduits(req.query, maintenant());
  if (!f.ok) return entreeInvalide(res, f.message);
  res.json(await listerProduits(prisma, f.valeur));
}));

teledetectionV2Router.get("/produits/:id/apercu", h(async (req, res) => {
  if (!estUuid(req.params.id)) { res.status(404).json({ error: "Apercu indisponible : produit inconnu", code: "APERCU_INDISPONIBLE" }); return; }
  const image = await apercuProduit(prisma, req.params.id);
  res.setHeader("Content-Type", image.type);
  res.setHeader("Content-Length", String(image.octets.length));
  // prudent : prive (derriere un jeton), brievement conserve, jamais interprete autrement que comme une image
  res.setHeader("Cache-Control", "private, max-age=300");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", "inline");
  res.status(200).end(image.octets);
}));

teledetectionV2Router.get("/sources", h(async (_req, res) => {
  res.json(await listerSources(prisma, adaptateurDeCodeBase));
}));

// Agregats NATIONAUX par methode (vues non regionalisables : un compte regional y voyait les comptes d'autres regions, donc leurs verdicts).
// Choix le plus simple et le plus sur : refus d'un compte regional, AVANT toute lecture. Le taux regional vient de /synthese (filtre par region).
teledetectionV2Router.get("/precision", h(async (req, res) => {
  if (!(await exigerNational(req, res, AGREGAT_NATIONAL))) return;
  res.json({ methode: "precision = confirmees / (confirmees + infirmees) ; nulle sans verdict", lignes: await precision(prisma) });
}));

teledetectionV2Router.get("/qualite-methodes", h(async (req, res) => {
  if (!(await exigerNational(req, res, AGREGAT_NATIONAL))) return;
  res.json({ seuilEchantillon: SEUIL_ECHANTILLON_TAUX, definition: DEFINITION_TAUX_CONFIRMATION, lignes: await qualiteMethodes(prisma) });
}));

// Anomalies de coherence entre registre, propositions, missions et verdicts (vue `coherence_teledetection`, ajout du lot 17 reporte sur
// le module EO). La vue n'est pas regionalisable (elle liste des propositions de toutes les regions) : meme regle que `/precision`, refus
// d'un compte regional AVANT toute lecture.
teledetectionV2Router.get("/coherence", h(async (req, res) => {
  if (!(await exigerNational(req, res, AGREGAT_NATIONAL))) return;
  res.json(await coherence(prisma));
}));

// ============================================================ ecriture : decisions sur une proposition

teledetectionV2Router.post("/propositions/:id/transition", decideurs, proposition, h(async (req, res) => {
  const c = lireCorps(corpsTransition, req, res);
  if (!c) return;
  const perimetre = await perimetreCompte(req, res);
  const r = await changerStatut(prisma, {
    propositionId: (res.locals.proposition as PropositionVisible).id, vers: c.vers, auteur: req.user!.id, motif: c.motif,
    commentaire: c.commentaire, motifAttente: c.motifAttente ?? null, observationIds: c.observationIds, constatRef: c.constatRef,
    perimetre: perimetre as PerimetreEo, ipAddress: req.ip,
  });
  res.json({
    id: r.proposition.id, de: r.de, vers: r.vers, statut: r.vers, motifAttente: r.proposition.motifAttente,
    transitionId: r.transitionId, preuvesAjoutees: r.preuvesAjoutees,
    verdict: r.vers === "CONFIRMEE" || r.vers === "INFIRMEE" ? { par: req.user!.id, le: r.proposition.verifieeLe, constatRef: r.proposition.constatRef } : null,
  });
}));

teledetectionV2Router.post("/propositions/:id/verification", decideurs, proposition, h(async (req, res) => {
  const c = lireCorps(corpsVerification, req, res);
  if (!c) return;
  const perimetre = await perimetreCompte(req, res);
  const mission = await demanderVerification(prisma, (res.locals.proposition as PropositionVisible).id, c, { ...ctx(req), perimetre: perimetre as PerimetreEo });
  res.status(201).json(mission);
}));

teledetectionV2Router.post("/propositions/:id/preuves", contributeurs, proposition, h(async (req, res) => {
  const c = lireCorps(corpsPreuves, req, res);
  if (!c) return;
  const perimetre = await perimetreCompte(req, res);
  const r = await ajouterPreuvesApi(prisma, res.locals.proposition as PropositionVisible, c.observationIds, req.user!, { ...ctx(req), perimetre: perimetre as PerimetreEo });
  res.status(201).json(r);
}));

// ============================================================ ecriture : sources et catalogue

function codeSource(req: Request, res: Response): string | null {
  const code = req.params.code;
  if (!REGEX_CODE_SOURCE.test(code)) { introuvable(res); return null; }
  return code;
}

teledetectionV2Router.post("/sources/:code/verifier", administrateur, h(async (req, res) => {
  const code = codeSource(req, res);
  if (!code) return;
  if (!lireCorps(corpsVide, req, res)) return;
  res.json(await verifierSource(prisma, code, ctx(req)));
}));

teledetectionV2Router.post("/sources/:code/synchroniser-catalogue", decideurs, h(async (req, res) => {
  const code = codeSource(req, res);
  if (!code) return;
  if (!(await exigerNational(req, res))) return;
  const c = lireCorps(corpsSynchro, req, res);
  if (!c) return;
  if (c.corridorId !== undefined) return entreeInvalide(res, "corridorId n'est pas pris en charge dans cette version : fournir bbox (ouest, sud, est, nord).");
  const d = verifierDemandeSynchro({ bbox: c.bbox, depuis: c.depuis, jusqua: c.jusqua, nuagesMax: c.nuagesMax }, maintenant());
  if (!d.ok) return entreeInvalide(res, d.message);
  res.json(await synchroniserCatalogue(prisma, code, d.valeur, ctx(req)));
}));

// ============================================================ ecriture : depot par un traitement

teledetectionV2Router.post("/produits", decideurs, h(async (req, res) => {
  if (!(await exigerNational(req, res))) return;
  res.locals.erreurBaseEstEntree = true;
  const c = lireCorps(corpsDepotProduit, req, res);
  if (!c) return;
  const { emprise, ...reste } = c;
  res.status(201).json(await enregistrerProduit(prisma, { ...reste, emprise: emprise as { type: string; coordinates?: unknown } }, ctx(req)));
}));

teledetectionV2Router.post("/propositions", decideurs, h(async (req, res) => {
  if (!(await exigerNational(req, res))) return;
  res.locals.erreurBaseEstEntree = true;
  const c = lireCorps(corpsDepotPropositions, req, res);
  if (!c) return;
  res.status(201).json(await deposerLot(prisma, c, ctx(req)));
}));

// ============================================================ fin du routeur

teledetectionV2Router.use((_req, res) => {
  res.status(404).json({ error: "Route introuvable", code: "ROUTE_INCONNUE" });
});

// Toute erreur du module a la forme { error, code } ; une erreur serveur n'est jamais rendue comme un resultat vide.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
teledetectionV2Router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;
  refuser(res, err, res.locals.erreurBaseEstEntree === true);
});

