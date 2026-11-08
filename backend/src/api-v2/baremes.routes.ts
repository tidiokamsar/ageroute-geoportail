import { Router } from "express";
import type { Response, NextFunction } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.middleware";
import { requireModuleAccess } from "../middleware/module-access.middleware";
import { requireRole } from "../middleware/rbac.middleware";
import { prisma } from "../lib/prisma";
import { logAuditTransactionnelle } from "../utils/audit";
import { approbationPermise } from "../governance/separation-taches";

/**
 * `/api/v2/baremes` — les neuf lignes de prix deviennent administrables, versionnees et historisees, sans toucher
 * a un seul cout par defaut.
 *
 * DEVERROUILLER L'AIDE A LA DECISION (D-07). Le moteur de cout refuse d'estimer tant que la ligne n'est ni APPROUVEE,
 * ni MILLESIMEE, ni LARGEUREE — et il a raison : « 3,5 milliards GNF/km » sans annee ni largeur de chaussee ne se
 * compare a rien et ne s'actualise jamais. Les neuf lignes d'origine portent ces champs a NULL volontairement :
 * personne ne sait pour quelle annee ni quelle largeur elles ont ete posees. Cette route est l'endroit ou AGEROUTE
 * (et l'ONR comme depositaire des prix unitaires) pose LA reponse — elle ne la devine jamais.
 *
 * CE QUI CHANGE LE CALCUL DESAPPROUVE, RIEN D'AUTRE (decision du lot 6, testee). Avant, TOUT PATCH remettait
 * l'approbation a zero, meme pour une faute de frappe dans un libelle : un gestionnaire pouvait neutraliser des prix
 * approuves en retouchant un commentaire. Desormais seuls les champs qui entrent dans le calcul — prix, unite,
 * devise, validite (debut, fin), millesime, largeur, source — reinitialisent l'approbation et incrementent la
 * version. Le libelle et le commentaire sont descriptifs : ils sont historises, ils ne touchent ni la version ni
 * l'approbation. La comparaison porte sur la VALEUR (un champ renvoye a l'identique n'est pas une modification) :
 * l'ecran envoie des corps complets.
 *
 * HISTORIQUE DANS LA MEME TRANSACTION. Chaque modification et chaque approbation ecrit une ligne de
 * `baremes_historique` (valeurs avant et apres, auteur, motif, commentaire) avec l'audit, dans la transaction de la
 * mutation : une panne d'ecriture annule la modification. Le motif est OBLIGATOIRE.
 *
 * SEPARATION DES TACHES. L'approbateur n'est jamais l'auteur de la version qu'il approuve, ADMIN compris
 * (`AUTO_VALIDATION`, 403, governance/separation-taches.ts). L'auteur d'une version est celui de la modification qui
 * a change le calcul DEPUIS la derniere approbation. Les neuf lignes d'origine (`standard_initial`) n'ont pas
 * d'auteur : rien a opposer a l'approbateur, comme un ouvrage importe sans auteur dans `validationPermise`.
 *
 * LES SCENARIOS DEJA CALCULES NE BOUGENT PAS. Un scenario embarque la copie des baremes qu'il a utilises dans ses
 * entrees scellees (empreinte SHA-256 verifiee en base, declencheur d'immutabilite) : modifier ici une ligne
 * n'altere aucun scenario passe. Prouve par test (noyau) et par le banc PostGIS.
 *
 * LE COUT EST UNE CHAINE DE CHIFFRES (BigInt au-dela de 2^53, comme partout). LA DEVISE (GNF) ET L'UNITE (KM) SONT
 * EXPLICITES et fermees : le moteur de cout refuse toute autre unite (`UNITE_NON_GEREE`) ; les accepter ici
 * fabriquerait des lignes que rien ne sait lire.
 *
 * CE QUE CETTE ROUTE NE FAIT PAS : ni creer ni supprimer des lignes (structure famille x etat, contrainte UNIQUE en
 * base ; une famille de plus est une decision de modelisation, par migration).
 */

export const baremesV2Router = Router();
baremesV2Router.use(requireAuth, requireModuleAccess("decision"));

// ------------------------------------------------------------------------------------------------ noyau (pur)

/** Champs qui entrent dans le calcul d'un cout : les modifier desapprouve et incremente la version. */
export const CHAMPS_CALCUL = ["coutKmGnf", "uniteCout", "devise", "anneeReference", "largeurChausseeM", "validDe", "validA", "source"] as const;
/** Champs purement descriptifs : historises, sans effet sur la version ni sur l'approbation. */
export const CHAMPS_DESCRIPTIFS = ["libelle", "commentaire"] as const;
export type ChampCalcul = (typeof CHAMPS_CALCUL)[number];
export type ChampDescriptif = (typeof CHAMPS_DESCRIPTIFS)[number];
export type ChampBareme = ChampCalcul | ChampDescriptif;

export interface ValeursBareme {
  coutKmGnf: string;
  uniteCout: string;
  devise: string;
  anneeReference: number | null;
  /** Chaine canonique d'un nombre (« 6.5 »), jamais « 6.50 » : la comparaison porte sur la valeur. */
  largeurChausseeM: string | null;
  validDe: string | null;
  validA: string | null;
  source: string;
  libelle: string | null;
  commentaire: string | null;
}

interface LigneBase {
  id: number; familleRevetement: string; etatDepart: string; typeIntervention: string;
  coutKmGnf: bigint; code: string | null; libelle: string | null; source: string; version: number;
  approuveLe: Date | null; approuveParId: string | null; anneeReference: number | null;
  largeurChausseeM: { toString(): string } | null; commentaire: string | null;
  uniteCout: string; devise: string; actif: boolean;
  validDe: Date | null; validA: Date | null;
  approuvePar?: { email: string } | null;
}

const jour = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);
const largeurCanonique = (v: { toString(): string } | string | number | null | undefined): string | null =>
  v === null || v === undefined ? null : String(Number(v.toString()));

export function valeursDe(l: LigneBase): ValeursBareme {
  return {
    coutKmGnf: l.coutKmGnf.toString(), uniteCout: l.uniteCout, devise: l.devise,
    anneeReference: l.anneeReference, largeurChausseeM: largeurCanonique(l.largeurChausseeM),
    validDe: jour(l.validDe), validA: jour(l.validA), source: l.source,
    libelle: l.libelle, commentaire: l.commentaire,
  };
}

export type ModificationDemandee = Partial<{
  coutKmGnf: string; uniteCout: string; devise: string; anneeReference: number | null; largeurChausseeM: number | null;
  validDe: string | null; validA: string | null; source: string; libelle: string; commentaire: string | null;
}>;

/** Valeurs apres application du corps. Un champ absent du corps ne change pas ; `null` efface. */
export function appliquerModification(avant: ValeursBareme, m: ModificationDemandee): ValeursBareme {
  const apres: ValeursBareme = { ...avant };
  if (m.coutKmGnf !== undefined) apres.coutKmGnf = m.coutKmGnf;
  if (m.uniteCout !== undefined) apres.uniteCout = m.uniteCout;
  if (m.devise !== undefined) apres.devise = m.devise;
  if (m.anneeReference !== undefined) apres.anneeReference = m.anneeReference;
  if (m.largeurChausseeM !== undefined) apres.largeurChausseeM = largeurCanonique(m.largeurChausseeM);
  if (m.validDe !== undefined) apres.validDe = m.validDe;
  if (m.validA !== undefined) apres.validA = m.validA;
  if (m.source !== undefined) apres.source = m.source;
  if (m.libelle !== undefined) apres.libelle = m.libelle;
  if (m.commentaire !== undefined) apres.commentaire = m.commentaire;
  return apres;
}

export interface Difference {
  /** Tous les champs dont la valeur change. */
  champs: ChampBareme[];
  calcul: ChampCalcul[];
  descriptifs: ChampDescriptif[];
  /** Vrai si l'approbation et la version sont touchees (un champ de calcul a change). */
  changeLeCalcul: boolean;
}

export function comparer(avant: ValeursBareme, apres: ValeursBareme): Difference {
  const calcul = CHAMPS_CALCUL.filter((c) => avant[c] !== apres[c]);
  const descriptifs = CHAMPS_DESCRIPTIFS.filter((c) => avant[c] !== apres[c]);
  return { champs: [...calcul, ...descriptifs], calcul, descriptifs, changeLeCalcul: calcul.length > 0 };
}

/** Fenetre de validite coherente : debut <= fin quand les deux existent (dates ISO, comparables en texte). */
export function validiteCoherente(v: Pick<ValeursBareme, "validDe" | "validA">): boolean {
  return v.validDe === null || v.validA === null || v.validDe <= v.validA;
}

// ------------------------------------------------------------------------------------------------ formes d'API

/** Qui voit les adresses e-mail des auteurs et des approbateurs : ceux qui gerent les barèmes (ADMIN, GESTIONNAIRE). */
export const voitLesIdentites = (role: string | undefined): boolean => role === "ADMIN" || role === "GESTIONNAIRE";

/**
 * Identifiant MINIMAL d'un compte pour un lecteur qui n'a pas a connaitre son adresse : la premiere lettre suivie d'une marque, sans
 * domaine (« g*** »). Le module `decision` ouvre la lecture de l'ecran ; il n'ouvre pas l'annuaire des agents qui ont modifie ou approuve un prix.
 */
export function identiteMinimale(email: string | null | undefined): string | null {
  if (email === null || email === undefined) return null;
  const t = email.trim();
  return t === "" ? "" : `${t[0].toLowerCase()}***`;
}

export function ligneApi(l: LigneBase, identites = false) {
  return {
    id: l.id, familleRevetement: l.familleRevetement, etatDepart: l.etatDepart,
    typeIntervention: l.typeIntervention, coutKmGnf: l.coutKmGnf.toString(),
    uniteCout: l.uniteCout, devise: l.devise,
    code: l.code, libelle: l.libelle, source: l.source, version: l.version, actif: l.actif,
    approuveLe: l.approuveLe, approuvePar: identites ? (l.approuvePar?.email ?? null) : identiteMinimale(l.approuvePar?.email),
    statutApprobation: l.approuveLe ? "APPROUVE" as const : "NON_APPROUVE" as const,
    anneeReference: l.anneeReference, largeurChausseeM: largeurCanonique(l.largeurChausseeM),
    validDe: jour(l.validDe), validA: jour(l.validA),
    commentaire: l.commentaire,
  };
}

interface LigneHistorique {
  id: number; baremeId: number; version: number; evenement: string; champsModifies: string[]; modifieCalcul: boolean;
  approbationReinitialisee: boolean; statutApprobation: string; valeursAvant: unknown; valeursApres: unknown;
  auteurId: string | null; auteurEmail: string; motif: string; commentaire: string | null; creeLe: Date;
}

/** Valeurs d'un evenement d'historique : l'evenement d'approbation y a enregistre l'adresse de l'approbateur (`approuvePar`). */
function valeursSansIdentite(v: unknown): unknown {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
  const o = { ...(v as Record<string, unknown>) };
  if (typeof o.approuvePar === "string") o.approuvePar = identiteMinimale(o.approuvePar);
  return o;
}

export function historiqueApi(h: LigneHistorique, identites = false) {
  return {
    id: h.id, version: h.version, evenement: h.evenement, champsModifies: h.champsModifies,
    modifieCalcul: h.modifieCalcul, approbationReinitialisee: h.approbationReinitialisee,
    statutApprobation: h.statutApprobation,
    valeursAvant: identites ? h.valeursAvant : valeursSansIdentite(h.valeursAvant),
    valeursApres: identites ? h.valeursApres : valeursSansIdentite(h.valeursApres),
    auteur: { id: h.auteurId, email: identites ? h.auteurEmail : identiteMinimale(h.auteurEmail) },
    motif: h.motif, commentaire: h.commentaire, creeLe: h.creeLe,
  };
}

/** Lecture partagee avec le routeur `aide-decision.exports.routes.ts` (GET /baremes). */
export async function listerBaremes(identites: boolean) {
  const lignes = await prisma.baremeIntervention.findMany({
    include: { approuvePar: { select: { email: true } } },
    orderBy: [{ familleRevetement: "asc" }, { etatDepart: "asc" }, { typeIntervention: "asc" }],
  });
  return lignes.map((l) => ligneApi(l as unknown as LigneBase, identites));
}

/** Lecture partagee (GET /baremes/:id/historique) ; `null` si la ligne n'existe pas. */
export async function lireHistorique(id: number, identites: boolean) {
  const ligne = await prisma.baremeIntervention.findUnique({ where: { id }, include: { approuvePar: { select: { email: true } } } });
  if (!ligne) return null;
  const h = await prisma.baremeHistorique.findMany({ where: { baremeId: id }, orderBy: { id: "desc" }, take: 500 });
  return { bareme: ligneApi(ligne as unknown as LigneBase, identites), historique: h.map((x) => historiqueApi(x as unknown as LigneHistorique, identites)) };
}

// ------------------------------------------------------------------------------------------------ corps

const dateJour = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date attendue au format AAAA-MM-JJ").refine((s) => {
  const [a, m, j] = s.split("-").map(Number);
  const d = new Date(Date.UTC(a, m - 1, j));
  return d.getUTCFullYear() === a && d.getUTCMonth() === m - 1 && d.getUTCDate() === j;
}, "date inexistante");

const motif = z.string().trim().min(5, "motif obligatoire (5 caracteres au moins)").max(500);

const corpsEdition = z.object({
  coutKmGnf: z.string().regex(/^[1-9]\d{0,17}$/, "coutKmGnf : entier strictement positif en chaîne de chiffres (GNF entiers)").optional(),
  uniteCout: z.enum(["KM"]).optional(),
  devise: z.enum(["GNF"]).optional(),
  anneeReference: z.number().int().min(1990).max(2100).nullable().optional(),
  largeurChausseeM: z.number().positive().max(30).nullable().optional(),
  validDe: dateJour.nullable().optional(),
  validA: dateJour.nullable().optional(),
  source: z.string().trim().min(1).max(120).optional(),
  libelle: z.string().trim().min(1).max(200).optional(),
  commentaire: z.string().trim().max(2000).nullable().optional(),
  motif,
  /** Verrou optimiste : la version que l'ecran a lue. Si elle a change depuis, 409. */
  versionAttendue: z.number().int().positive().optional(),
}).strict();

const corpsApprobation = z.object({
  motif,
  commentaire: z.string().trim().min(5, "commentaire obligatoire (5 caracteres au moins)").max(2000),
  /** OBLIGATOIRE : on approuve LA version que l'ecran a lue (verrou optimiste), jamais « celle qui se trouve la ». Si elle a change : 409. */
  versionAttendue: z.number().int().positive(),
}).strict();

/** Refus metier leve DANS la transaction (elle est annulee), traduit en reponse HTTP par la route. */
class RefusMetier extends Error {
  constructor(readonly statut: number, readonly corps: Record<string, unknown>) { super(String(corps.error)); }
}

function repondreRefus(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof RefusMetier) { res.status(err.statut).json(err.corps); return; }
  next(err);
}

const INTROUVABLE = { error: "ligne de barème introuvable", code: "INTROUVABLE" };

const ID_INT4_MAX = 2_147_483_647n;

export type LectureId = { ok: true; id: number } | { ok: false; statut: 400 | 404; corps: Record<string, unknown> };

/**
 * Identifiant d'une ligne de bareme (colonne `Int` de la base). Mal forme (non entier, nul) : 404, comme une ligne inconnue. Au-dela de
 * l'entier 32 bits de la colonne : 400 explicite. Il ne doit ni etre arrondi par `Number` (2^53) ni atteindre le SQL, qui repondrait 500.
 */
export function lireIdBareme(brut: string): LectureId {
  if (!/^\d+$/.test(brut)) return { ok: false, statut: 404, corps: INTROUVABLE };
  const n = BigInt(brut);
  if (n <= 0n) return { ok: false, statut: 404, corps: INTROUVABLE };
  if (n > ID_INT4_MAX) return { ok: false, statut: 400, corps: { error: "identifiant hors plage (entier 32 bits attendu)", code: "ID_HORS_PLAGE" } };
  return { ok: true, id: Number(n) };
}

// ------------------------------------------------------------------------------------------------ routes

baremesV2Router.get("/", async (req, res, next) => {
  try {
    res.json({ data: await listerBaremes(voitLesIdentites(req.user?.role)) });
  } catch (err) { next(err); }
});

baremesV2Router.get("/:id/historique", async (req, res, next) => {
  try {
    const lu = lireIdBareme(req.params.id);
    if (!lu.ok) { res.status(lu.statut).json(lu.corps); return; }
    const r = await lireHistorique(lu.id, voitLesIdentites(req.user?.role));
    if (!r) { res.status(404).json(INTROUVABLE); return; }
    res.json({ data: r.historique, bareme: r.bareme });
  } catch (err) { next(err); }
});

baremesV2Router.patch("/:id", requireRole("ADMIN", "GESTIONNAIRE"), async (req, res, next) => {
  try {
    const lu = lireIdBareme(req.params.id);
    if (!lu.ok) { res.status(lu.statut).json(lu.corps); return; }
    const id = lu.id;

    const p = corpsEdition.safeParse(req.body);
    if (!p.success) {
      res.status(400).json({ error: "corps invalide", code: "CORPS_INVALIDE", details: p.error.flatten().fieldErrors }); return;
    }
    const { motif: motifSaisi, versionAttendue, ...demande } = p.data;
    if (Object.keys(demande).length === 0) {
      res.status(400).json({ error: "aucun champ à modifier", code: "AUCUN_CHAMP" }); return;
    }
    const compte = req.user!;

    const modifiee = await prisma.$transaction(async (tx) => {
      // Verrou de ligne : deux editions simultanees se suivent au lieu de s'ecraser, et la lecture qui suit est la
      // derniere valeur committee.
      await tx.$queryRaw`SELECT "id" FROM "baremes_intervention" WHERE "id" = ${id} FOR UPDATE`;
      const existante = await tx.baremeIntervention.findUnique({ where: { id } });
      if (!existante) throw new RefusMetier(404, INTROUVABLE);
      if (versionAttendue !== undefined && versionAttendue !== existante.version) {
        throw new RefusMetier(409, {
          error: `la ligne est passée à la version ${existante.version} depuis votre lecture (v${versionAttendue}) : rechargez avant de modifier`,
          code: "CONFLIT_VERSION", versionActuelle: existante.version,
        });
      }

      const avant = valeursDe(existante as unknown as LigneBase);
      const apres = appliquerModification(avant, demande as ModificationDemandee);
      const diff = comparer(avant, apres);
      if (diff.champs.length === 0) {
        throw new RefusMetier(400, { error: "aucune valeur ne change : rien à enregistrer", code: "AUCUN_CHANGEMENT" });
      }
      if (!validiteCoherente(apres)) {
        throw new RefusMetier(400, { error: "la fin de validité précède le début de validité", code: "VALIDITE_INCOHERENTE" });
      }

      const data: Record<string, unknown> = {};
      if (diff.champs.includes("coutKmGnf")) data["coutKmGnf"] = BigInt(apres.coutKmGnf);
      if (diff.champs.includes("uniteCout")) data["uniteCout"] = apres.uniteCout;
      if (diff.champs.includes("devise")) data["devise"] = apres.devise;
      if (diff.champs.includes("anneeReference")) data["anneeReference"] = apres.anneeReference;
      if (diff.champs.includes("largeurChausseeM")) data["largeurChausseeM"] = apres.largeurChausseeM === null ? null : Number(apres.largeurChausseeM);
      if (diff.champs.includes("validDe")) data["validDe"] = apres.validDe === null ? null : new Date(`${apres.validDe}T00:00:00.000Z`);
      if (diff.champs.includes("validA")) data["validA"] = apres.validA === null ? null : new Date(`${apres.validA}T00:00:00.000Z`);
      if (diff.champs.includes("source")) data["source"] = apres.source;
      if (diff.champs.includes("libelle")) data["libelle"] = apres.libelle;
      if (diff.champs.includes("commentaire")) data["commentaire"] = apres.commentaire;

      // Seul un changement de calcul desapprouve et incremente : un prix edite n'est plus un prix arrete.
      const etaitApprouvee = existante.approuveLe !== null;
      const reinitialise = diff.changeLeCalcul && etaitApprouvee;
      const version = diff.changeLeCalcul ? existante.version + 1 : existante.version;
      if (diff.changeLeCalcul) {
        data["version"] = version;
        data["approuveLe"] = null;
        data["approuveParId"] = null;
      }

      const ligne = await tx.baremeIntervention.update({
        where: { id }, data,
        include: { approuvePar: { select: { email: true } } },
      });
      const statutApres = diff.changeLeCalcul ? "NON_APPROUVE" : (etaitApprouvee ? "APPROUVE" : "NON_APPROUVE");

      await tx.baremeHistorique.create({
        data: {
          baremeId: id, version, evenement: "MODIFICATION", champsModifies: diff.champs, modifieCalcul: diff.changeLeCalcul,
          approbationReinitialisee: reinitialise, statutApprobation: statutApres,
          valeursAvant: avant as never, valeursApres: apres as never,
          auteurId: compte.id, auteurEmail: compte.email ?? "", motif: motifSaisi,
        },
      });
      await logAuditTransactionnelle(tx, {
        userId: compte.id, action: "UPDATE", entityType: "BaremeIntervention", entityId: String(id),
        before: { ...avant, version: existante.version, approuveLe: existante.approuveLe },
        after: {
          ...apres, version, approuveLe: ligne.approuveLe, champsModifies: diff.champs,
          approbationReinitialisee: reinitialise, motif: motifSaisi,
        },
        ipAddress: req.ip,
      });
      return ligne;
    });
    res.json(ligneApi(modifiee as unknown as LigneBase, true)); return; // reservee ADMIN / GESTIONNAIRE : identites completes
  } catch (err) { repondreRefus(err, res, next); }
});

baremesV2Router.post("/:id/approuver", requireRole("ADMIN"), async (req, res, next) => {
  try {
    const lu = lireIdBareme(req.params.id);
    if (!lu.ok) { res.status(lu.statut).json(lu.corps); return; }
    const id = lu.id;

    const p = corpsApprobation.safeParse(req.body ?? {});
    if (!p.success) {
      res.status(400).json({ error: "corps invalide : motif et commentaire sont obligatoires", code: "CORPS_INVALIDE", details: p.error.flatten().fieldErrors }); return;
    }
    const compte = req.user!;

    const approuvee = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "baremes_intervention" WHERE "id" = ${id} FOR UPDATE`;
      const existante = await tx.baremeIntervention.findUnique({ where: { id } });
      if (!existante) throw new RefusMetier(404, INTROUVABLE);
      if (p.data.versionAttendue !== undefined && p.data.versionAttendue !== existante.version) {
        throw new RefusMetier(409, {
          error: `la ligne est passée à la version ${existante.version} depuis votre lecture (v${p.data.versionAttendue}) : relisez le prix avant de l'approuver`,
          code: "CONFLIT_VERSION", versionActuelle: existante.version,
        });
      }

      // L'AUTEUR DE LA VERSION vient de l'historique en base, jamais du corps de la requete.
      const auteurs = await tx.baremeHistorique.findMany({
        where: { baremeId: id, version: existante.version, modifieCalcul: true },
        select: { auteurId: true },
      });
      const verdict = approbationPermise({
        entityType: "BaremeIntervention", approbateurId: compte.id, approbateurRole: compte.role,
        intervenants: auteurs.map((a) => ({ id: a.auteurId, etape: `a modifié le prix de ce barème (version ${existante.version})` })),
      });
      if (!verdict.permis) {
        throw new RefusMetier(403, { error: verdict.explication, code: verdict.motif, motif: verdict.motif });
      }
      if (existante.approuveLe !== null) {
        throw new RefusMetier(409, { error: `la version ${existante.version} est déjà approuvée`, code: "DEJA_APPROUVEE" });
      }
      const manquants: string[] = [];
      if (existante.anneeReference == null) manquants.push("millésime (anneeReference)");
      if (existante.largeurChausseeM == null) manquants.push("largeur de chaussée de référence (largeurChausseeM)");
      if (manquants.length > 0) {
        throw new RefusMetier(422, { error: `approuver un prix illisible est refusé : manque ${manquants.join(" et ")}`, code: "PRIX_ILLISIBLE" });
      }

      const avant = valeursDe(existante as unknown as LigneBase);
      const ligne = await tx.baremeIntervention.update({
        where: { id }, data: { approuveLe: new Date(), approuveParId: compte.id },
        include: { approuvePar: { select: { email: true } } },
      });
      await tx.baremeHistorique.create({
        data: {
          baremeId: id, version: existante.version, evenement: "APPROBATION", champsModifies: ["approbation"], modifieCalcul: false,
          approbationReinitialisee: false, statutApprobation: "APPROUVE",
          valeursAvant: { ...avant, statutApprobation: "NON_APPROUVE" } as never,
          valeursApres: { ...avant, statutApprobation: "APPROUVE", approuvePar: compte.email ?? null } as never,
          auteurId: compte.id, auteurEmail: compte.email ?? "", motif: p.data.motif, commentaire: p.data.commentaire,
        },
      });
      await logAuditTransactionnelle(tx, {
        userId: compte.id, action: "VALIDATE", entityType: "BaremeIntervention", entityId: String(id),
        before: { ...avant, version: existante.version, approuveLe: null },
        after: {
          ...avant, version: existante.version, approuveLe: ligne.approuveLe, approuvePar: compte.email ?? null,
          motif: p.data.motif, commentaire: p.data.commentaire,
        },
        ipAddress: req.ip,
      });
      return ligne;
    });
    res.json(ligneApi(approuvee as unknown as LigneBase, true)); return; // reservee ADMIN : identites completes
  } catch (err) { repondreRefus(err, res, next); }
});
